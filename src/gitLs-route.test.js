import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import express from 'express';
import { spawnSync } from 'node:child_process';

/**
 * Pins GET /api/git-ls END TO END through the mounted route — the handler glue
 * in src/gitRoutes.js's createGitRouter (resolve → dir guard → gitCwd → runGit →
 * parseGitLsEntries → HTTP mapping) that no suite exercised before this file.
 * Coverage on origin/main f70a51a showed the whole handler body uncovered:
 * src/git-ls.test.js pins the two pure halves (isSafeRelativePath,
 * parseGitLsEntries) and hand-drives runGit('ls-files') against a real repo, and
 * web tests mock fetch (fileBrowserDialog.test.mjs) — but nothing mounts the
 * route and requests /api/git-ls. The sibling /api/git-diff route IS driven over
 * HTTP on this exact harness (gitDiff-delivered-route.test.js), so the gap was
 * the route glue, not the harness.
 *
 * Harness: createGitRouter mounts on a bare express app with an injected
 * resolve() (no server.js boot, and no HOME freeze — gitRoutes.js and its leaf
 * imports are side-effect-free at module load, same as
 * gitDiff-delivered-route.test.js). The listing chats are manual-LOCAL
 * (host '(local)', container null) so runGit takes the runLocalGit branch and
 * runs REAL `git ls-files --cached --others --exclude-standard [-- dir]`
 * against a real temp repo. The companion transport is forced off so no remote
 * leg can detour onto a channel bootstrap.
 *
 * What is pinned (each clause kills a one-token mutant of the handler — see
 * WARDEN-2092's mutation notes; all 10 mutants survive the existing suite
 * because the handler lines never execute there):
 *   1. Root listing: dirs-first then case-insensitive files, gitignored names
 *      hidden (--exclude-standard), untracked WIP shown (--others), error null,
 *      cwd + dir echoed. Kills "drop --others" / "drop --exclude-standard" /
 *      "drop dir from success body".
 *   2. dir=src / dir=src/components scoping: entries relative to dir, nested
 *      dirs collapsed, untracked file inside dir shown. Kills
 *      parseGitLsEntries(stdout, '') instead of dir.
 *   3. Unmatched dir → entries [] with error null (git ls-files exits 0 on a
 *      non-matching pathspec — empty ≠ failure).
 *   4. Traversing / absolute / home-relative / Windows-drive dir → HTTP 400
 *      with the exact containment body { error } (and nothing else — the
 *      validate short-circuit carries no empty-contract keys). Kills "drop dir
 *      guard" and "400→403".
 *   5. Guard order: an unknown chat id with dir=.. → 404 { error: 'unknown
 *      chat' }, NOT the 400 — the resolve happens first.
 *   6. Non-repo cwd AND deleted cwd → 200 { entries: [], cwd, dir, error:
 *      'not a git repository' } — the !r.ok gate never masks as a clean empty.
 *      Kills "remove !r.ok gate".
 *   7. A container chat with no cwd → 200 { entries: [], cwd: '', dir, error:
 *      'no cwd' } (gitCwd returns '' only for container/remote chats; a
 *      manual-LOCAL chat would fall back to process.cwd() instead, which is why
 *      this shape needs a container chat). No docker shim is needed: the no-cwd
 *      guard fires before the transport runs.
 *   8. A chat whose transport routing throws → 200 with the FIXED string
 *      'ls failed' (the catchError contract): the thrown error's own message —
 *      a HostConnectionError embeds the hostname — must never reach the body.
 *      Kills "catchError → e.message" and "error string → null"; also exercises
 *      the defaults(chat) leg carrying the REAL chat.cwd on the catch path
 *      (kills "defaults cwd ''", which only agrees with production on the
 *      no-cwd path).
 */

// Force the companion transport off for the whole file: every chat here is
// manual-LOCAL (runLocalGit) or short-circuits before the transport, so no leg
// may ever detour onto a channel bootstrap. Restored in after().
const originalEnv = { COMPANION: process.env.WARDEN_COMPANION_TRANSPORT };
delete process.env.WARDEN_COMPANION_TRANSPORT;

const LOCAL = '(local)';
// A hostname embedded in a transport error's message; the 'ls failed' catch
// contract must keep it out of the response body.
const LEAKY_HOSTNAME = 'secret-host.example.com';

let tmp, repo, plainDir, deletedDir, server, base;
const chats = new Map();

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}`);
}
async function getJson(q) {
  const res = await fetch(`${base}/api/git-ls?${new URLSearchParams(q)}`);
  return { status: res.status, body: await res.json() };
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gls-'));

  // The listing repo: tracked files committed, then an untracked WIP file at
  // root and under src/, then a .gitignore hiding ignored.log + build/.
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, 'src', 'components'), { recursive: true });
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 't@example.com'], repo);
  git(['config', 'user.name', 'T'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# project\n');
  fs.writeFileSync(path.join(repo, 'src', 'server.js'), 'console.log()\n');
  fs.writeFileSync(path.join(repo, 'src', 'components', 'Pane.tsx'), '<div/>\n');
  git(['add', 'README.md', 'src/server.js', 'src/components/Pane.tsx'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  fs.writeFileSync(path.join(repo, 'fresh.txt'), 'wip\n');        // untracked root
  fs.writeFileSync(path.join(repo, 'src', 'new.js'), 'wip\n');    // untracked under src/
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.log\nbuild/\n');
  fs.writeFileSync(path.join(repo, 'ignored.log'), 'secret\n');   // gitignored
  fs.mkdirSync(path.join(repo, 'build'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'build', 'out.js'), 'bundled\n'); // gitignored

  // A plain non-git directory (same shape as git-blame.test.js's non-git chat).
  plainDir = path.join(tmp, 'plain');
  fs.mkdirSync(plainDir);
  fs.writeFileSync(path.join(plainDir, 'note.txt'), 'not a repo\n');

  // A chat whose cwd exists NOW and is deleted AFTER registration — the
  // catalog-keeps-the-path, fs-no-longer-does shape of "repository gone".
  deletedDir = path.join(tmp, 'deleted');
  fs.mkdirSync(deletedDir);

  chats.set('c1', { id: 'c1', host: LOCAL, container: null, cwd: repo });
  chats.set('nongit', { id: 'nongit', host: LOCAL, container: null, cwd: plainDir });
  chats.set('deleted', { id: 'deleted', host: LOCAL, container: null, cwd: deletedDir });
  // Container chat with NO cwd: gitCwd(chat) returns '' (a container path must
  // never fall back to the host's process.cwd()) → the 'no cwd' contract.
  chats.set('ctr-nocwd', { id: 'ctr-nocwd', host: LOCAL, container: 'yatfa-test' });
  // A chat whose transport routing explodes: `host` throws on first read (the
  // message a HostConnectionError carries embeds the hostname). cwd is present
  // so gitCwd resolves from it before the transport layer is touched — the
  // throw fires inside runGit and lands in withGitRepo's catch.
  const broken = { id: 'broken', cwd: repo, container: null };
  Object.defineProperty(broken, 'host', {
    get() { throw new Error(`Cannot connect to ${LEAKY_HOSTNAME}: connection refused`); },
    enumerable: true,
  });
  chats.set('broken', broken);

  fs.rmSync(deletedDir, { recursive: true, force: true });

  const { createGitRouter } = await import('./gitRoutes.js');
  const app = express();
  app.use(createGitRouter({
    resolve: async (id) => (chats.has(id) ? { chat: chats.get(id) } : { error: 'unknown chat' }),
    readWorkingTreeFile: async () => { throw new Error('unused'); },
    isBinaryFile: () => false,
    isBinaryBlob: () => false,
  }));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  if (originalEnv.COMPANION !== undefined) process.env.WARDEN_COMPANION_TRANSPORT = originalEnv.COMPANION;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('GET /api/git-ls (mounted route)', () => {
  it('lists root immediate children: dirs first, gitignored hidden, untracked shown, cwd/dir echoed, error null', async () => {
    const { status, body } = await getJson({ id: 'c1' });
    assert.equal(status, 200);
    // src (dir, from tracked + untracked children) first, then the files:
    // .gitignore is untracked-but-not-ignored (it hides the others),
    // fresh.txt is the --others WIP file, ignored.log and build/ are
    // --exclude-standard'd away, README.md is tracked.
    assert.deepEqual(body.entries, [
      { name: 'src', type: 'dir' },
      { name: '.gitignore', type: 'file' },
      { name: 'fresh.txt', type: 'file' },
      { name: 'README.md', type: 'file' },
    ]);
    assert.equal(body.error, null);
    assert.equal(body.dir, '');
    assert.equal(body.cwd, repo);
  });

  it('scopes dir=src: entries relative to src, nested dir collapsed, untracked file shown', async () => {
    const { status, body } = await getJson({ id: 'c1', dir: 'src' });
    assert.equal(status, 200);
    assert.deepEqual(body.entries, [
      { name: 'components', type: 'dir' },
      { name: 'new.js', type: 'file' },
      { name: 'server.js', type: 'file' },
    ]);
    assert.equal(body.error, null);
    assert.equal(body.dir, 'src');
    assert.equal(body.cwd, repo);
  });

  it('scopes dir=src/components to the single nested file', async () => {
    const { status, body } = await getJson({ id: 'c1', dir: 'src/components' });
    assert.equal(status, 200);
    assert.deepEqual(body.entries, [{ name: 'Pane.tsx', type: 'file' }]);
    assert.equal(body.error, null);
    assert.equal(body.dir, 'src/components');
  });

  it('answers an unmatched dir with an empty list and error null', async () => {
    // `git ls-files -- no-such-dir` exits 0 with no output: empty is a real
    // empty (a dir that does not exist reads as no entries), not a failure.
    const { status, body } = await getJson({ id: 'c1', dir: 'no-such-dir' });
    assert.equal(status, 200);
    assert.deepEqual(body, { entries: [], cwd: repo, dir: 'no-such-dir', error: null });
  });

  it('400s every traversing or absolute dir with the exact containment body', async () => {
    for (const dir of ['..', '../x', 'src/../..', '/etc', '~/x', 'C:\\Windows']) {
      const { status, body } = await getJson({ id: 'c1', dir });
      assert.equal(status, 400, `dir=${dir}`);
      // The validate short-circuit carries ONLY the error string — no
      // entries/cwd/dir empty-contract keys (unlike git-diff's 400).
      assert.deepEqual(body, { error: 'dir must be within working directory' }, `dir=${dir}`);
    }
  });

  it('resolves the chat before the dir guard: unknown id with dir=.. is 404, not 400', async () => {
    const { status, body } = await getJson({ id: 'nope', dir: '..' });
    assert.equal(status, 404);
    assert.deepEqual(body, { error: 'unknown chat' });
  });

  it('answers a non-repo cwd 200 { entries: [], cwd, dir, error: "not a git repository" }', async () => {
    const { status, body } = await getJson({ id: 'nongit', dir: 'sub' });
    assert.equal(status, 200);
    assert.deepEqual(body, { entries: [], cwd: plainDir, dir: 'sub', error: 'not a git repository' });
  });

  it('answers a deleted cwd the same not-a-repository contract', async () => {
    const { status, body } = await getJson({ id: 'deleted' });
    assert.equal(status, 200);
    assert.deepEqual(body, { entries: [], cwd: deletedDir, dir: '', error: 'not a git repository' });
  });

  it('answers a cwd-less container chat 200 { entries: [], cwd: "", dir, error: "no cwd" }', async () => {
    const { status, body } = await getJson({ id: 'ctr-nocwd', dir: 'src' });
    assert.equal(status, 200);
    assert.deepEqual(body, { entries: [], cwd: '', dir: 'src', error: 'no cwd' });
  });

  it('answers a throwing transport with the fixed "ls failed" string and no hostname leak', async () => {
    const { status, body } = await getJson({ id: 'broken', dir: 'src' });
    assert.equal(status, 200);
    // The catch contract: the empty contract with chat's REAL cwd (defaults is
    // a function of chat here), and the FIXED error string — never the thrown
    // message, which embeds the unreachable hostname.
    assert.deepEqual(body, { entries: [], cwd: repo, dir: 'src', error: 'ls failed' });
    assert.ok(!JSON.stringify(body).includes(LEAKY_HOSTNAME), 'hostname must never leak into the body');
  });
});
