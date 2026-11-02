import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import express from 'express';
import { spawnSync } from 'node:child_process';

/**
 * Pins GET /api/git-blame end to end on a DELIVERED (container) chat — the
 * transport leg `runInContext(chat, buildGitBlameScript(cwd, filePath))` plus
 * the WARDEN-1255 reachability gate (`failed = !rr.ok` → `isCwdReachable`) that
 * no other suite executes. The pure pieces ARE pinned elsewhere:
 * src/git-blame.test.js covers parseGitBlame, buildGitBlameScript (as text) and
 * isCwdReachable (as a unit), but its HTTP half drives the route only through
 * manual-LOCAL chats — its own comment: "the HTTP suite can only fixture the
 * LOCAL one, since the disk catalog hardcodes container:null". The web blame
 * gutter hits this route for every yatfa-container agent chat (the primary
 * deployment shape), so until now the container leg — the `else` branch whose
 * `capDiff(rr.ok ? … : '')` and `failed = !rr.ok` sit on never-executed lines —
 * was untested glue. Same technique as src/gitDiff-delivered-route.test.js
 * (WARDEN-2083/2084).
 *
 * What is pinned here (each clause killed by at least one test — see the
 * mutation notes in WARDEN-2102):
 *   1. A container chat on a real repo blames it in-context: provenance lines
 *      aligned to file lines, with hash/author/summary from the commit.
 *   2. A path with a space arrives as ONE quoted pathspec through the delivered
 *      script's shellQuote (a broken quote would split it into two pathspecs,
 *      exit non-zero, and read as the benign empty below).
 *   3. reachable repo + UNTRACKED file → { lines: [], error: null } — the
 *      benign empty the reachability gate must keep (blame exits non-zero;
 *      `test -d` passes).
 *   4. reachable NON-repo directory → { lines: [], error: null } — same split,
 *      the other benign case ('not a git repository' swallowed by the script's
 *      2>/dev/null).
 *   5. deleted cwd inside the container → { lines: [], error: 'git blame
 *      failed' } — the script's own `cd <cwd>` fails and the `test -d` probe
 *      fails too, so the gate reports the fixed literal.
 *   6. container GONE (fake docker exit 127) while the cwd EXISTS on the host
 *      → 'git blame failed'. This is the clause a host-fs probe cannot serve:
 *      the cwd is statable on the host, so only the in-context `test -d` probe
 *      (the same transport the blame took) can notice the container is gone.
 *
 * Setup: `createGitRouter({...})` mounts on a bare express app — no server.js
 * boot, and no HOME freeze: gitRoutes.js (and its leaf imports) are
 * side-effect-free at module load. `resolve` is an injected Map lookup. The
 * chat carries { host: '(local)', container } so the route takes the `else`
 * leg → runInContext → runLocalCapture('docker', ['exec', c, 'bash', '-lc',
 * script]); a fake `docker` on PATH (same technique as src/git-container.test.js)
 * execs the script with `cd /` FIRST, so the script's own `cd <cwd>` is what is
 * under test — the WARDEN-1051 lesson that the delivered script must
 * self-locate, not inherit the spawn cwd. HOME is untouched; PATH/env are
 * restored in `after`.
 */

const LOCAL = '(local)';
const FAKE_DOCKER = `#!/usr/bin/env bash
[ "$1" = "exec" ] || exit 0
[ "$2" = "$WARDEN_FAKE_CONTAINER" ] || { echo "fake-docker: unknown container '$2'" >&2; exit 127; }
shift 2
[ "$1" = "bash" ] || exit 0
shift; [ "$1" = "-lc" ] && shift
cd /
exec bash -lc "$1"
`;

// Fixed commit date so blame's per-line `date` is deterministic (the route
// asserts provenance identity, not the date value, but a fixed clock costs
// nothing and keeps runs byte-comparable).
const COMMIT_DATE_ENV = {
  GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
};

let tmp, repo, plain, binDir, server, base, originalPath, originalContainer;
const chats = new Map();

function git(args, cwd) {
  const r = spawnSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, ...COMMIT_DATE_ENV },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}`);
}
async function getJson(q) {
  const res = await fetch(`${base}/api/git-blame?${new URLSearchParams(q)}`);
  return { status: res.status, body: await res.json() };
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gbd-'));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 'alice@example.com'], repo);
  git(['config', 'user.name', 'Alice'], repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(repo, 'sp ace.txt'), 'spaced\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'initial commit'], repo);
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'new\n'); // untracked: blame exits non-zero
  plain = path.join(tmp, 'plain');                              // reachable, but not a repo
  fs.mkdirSync(plain);
  fs.writeFileSync(path.join(plain, 'readme.txt'), 'plain\n');
  binDir = path.join(tmp, 'bin');
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'docker'), FAKE_DOCKER, { mode: 0o755 });
  originalPath = process.env.PATH;
  originalContainer = process.env.WARDEN_FAKE_CONTAINER;
  process.env.PATH = `${binDir}:${process.env.PATH}`;
  process.env.WARDEN_FAKE_CONTAINER = 'yatfa-test';
  chats.set('c1', { id: 'c1', host: LOCAL, container: 'yatfa-test', cwd: repo });
  chats.set('plain', { id: 'plain', host: LOCAL, container: 'yatfa-test', cwd: plain });
  chats.set('gone', { id: 'gone', host: LOCAL, container: 'yatfa-test', cwd: path.join(tmp, 'nope') });
  // 'nocontainer': the fake docker has never heard of this container (exit 127
  // on both the blame and the probe) — the container-gone shape. The cwd EXISTS
  // on the host (it is `repo`), which is exactly why a host-fs probe would call
  // this chat healthy and only the in-context probe can catch it.
  chats.set('nocontainer', { id: 'nocontainer', host: LOCAL, container: 'yatfa-missing', cwd: repo });
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
  process.env.PATH = originalPath;
  if (originalContainer === undefined) delete process.env.WARDEN_FAKE_CONTAINER;
  else process.env.WARDEN_FAKE_CONTAINER = originalContainer;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('GET /api/git-blame on a delivered (container) chat', () => {
  it('blames a tracked file in-context: provenance aligned to file lines', async () => {
    const expectedHash = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo })
      .stdout.toString().trim();
    const { status, body } = await getJson({ id: 'c1', path: 'a.txt' });
    assert.equal(status, 200);
    assert.equal(body.error, null);
    assert.equal(body.lines.length, 2);
    for (const [i, rec] of body.lines.entries()) {
      assert.equal(rec.line, i + 1);
      assert.equal(rec.hash, expectedHash);
      assert.equal(rec.author, 'Alice');
      assert.equal(rec.summary, 'initial commit');
    }
  });
  it('passes a path containing a space as one quoted pathspec', async () => {
    const { status, body } = await getJson({ id: 'c1', path: 'sp ace.txt' });
    assert.equal(status, 200);
    assert.equal(body.error, null);
    assert.equal(body.lines.length, 1);
    assert.equal(body.lines[0].line, 1);
    assert.equal(body.lines[0].summary, 'initial commit');
  });
  it('answers an untracked file in a reachable repo with the benign empty', async () => {
    const { status, body } = await getJson({ id: 'c1', path: 'untracked.txt' });
    assert.equal(status, 200);
    assert.deepEqual(body, { lines: [], error: null });
  });
  it('answers a reachable non-repo directory with the benign empty', async () => {
    const { status, body } = await getJson({ id: 'plain', path: 'readme.txt' });
    assert.equal(status, 200);
    assert.deepEqual(body, { lines: [], error: null });
  });
  it('reports git blame failed for a deleted cwd inside the container', async () => {
    const { status, body } = await getJson({ id: 'gone', path: 'a.txt' });
    assert.equal(status, 200);
    assert.deepEqual(body, { lines: [], error: 'git blame failed' });
  });
  it('reports git blame failed for a gone container even though the cwd exists on the host', async () => {
    // The cwd is `repo`, statable on the host — a host-fs reachability probe
    // would pass it and the gate would answer error:null. Only the in-context
    // `test -d` probe (the same transport the blame took) can notice the
    // container is gone, which is the WARDEN-1255 clause this pins.
    const { status, body } = await getJson({ id: 'nocontainer', path: 'a.txt' });
    assert.equal(status, 200);
    assert.deepEqual(body, { lines: [], error: 'git blame failed' });
  });
});
