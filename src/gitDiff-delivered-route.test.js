import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import express from 'express';
import { spawnSync } from 'node:child_process';

/**
 * Pins GET /api/git-diff end to end on a DELIVERED (container) chat — the
 * transport `getDeliveredGitDiff` (src/gitRoutes.js) and the route-level query
 * guards no other suite exercises. The pure pieces ARE pinned elsewhere:
 * src/gitDiff.test.js covers getLocalGitDiff, capDiff, isPathWithinCwd and
 * buildGitDiffScript (run under bash), but nothing drives the glue that runs
 * the script through runInContext and maps its output onto HTTP — until now.
 *
 * What is pinned here (each clause killed by exactly one test — see the
 * mutation notes in WARDEN-2084):
 *   1. stdout sentinel `ERROR path must be within working directory`
 *      → HTTP 403, error 'path must be within working directory'.
 *   2. stdout sentinel `ERROR invalid path` → HTTP 400, error 'invalid path'.
 *   3. any other non-ok run → soft 200 { error: 'diff failed' } (never a 500).
 *   4. empty diff → the SECOND `git ls-files --error-unmatch` probe
 *      distinguishes clean-tracked (diff: '', untracked false) from untracked
 *      (diff: null, untracked true).
 *   5. Route guards: blank/whitespace path → 400 path-bearing contract;
 *      unknown chat → 404 carrying the path-bearing contract; cwd-less chat →
 *      200 { error: 'no cwd' }; `staged` honoured only for the exact string
 *      '1'; `range` allow-listed to the literal 'outgoing' — any other value
 *      falls back to the worktree diff so a stray param can never inject a rev
 *      (the WARDEN-398/601 rev-validation discipline).
 *
 * Setup: `createGitRouter({...})` mounts on a bare express app — no server.js
 * boot, and no HOME freeze: gitRoutes.js (and its leaf imports) are
 * side-effect-free at module load. `resolve` is an injected Map lookup. The
 * chat carries { host: '(local)', container } so the route takes
 * getDeliveredGitDiff → runInContext → runLocalCapture('docker',
 * ['exec', c, 'bash', '-lc', script]); a fake `docker` on PATH (same
 * technique as src/git-container.test.js) execs the script with `cd /` FIRST,
 * so the script's own `cd <cwd>` is what is under test — the WARDEN-1051
 * lesson that the delivered script must self-locate, not inherit the spawn
 * cwd. HOME is untouched; PATH/env are restored in `after`.
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

let tmp, repo, binDir, server, base, originalPath, originalContainer;
const chats = new Map();

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}`);
}
async function getJson(q) {
  const res = await fetch(`${base}/api/git-diff?${new URLSearchParams(q)}`);
  return { status: res.status, body: await res.json() };
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gdd-'));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 't@example.com'], repo);
  git(['config', 'user.name', 'T'], repo);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'line1\n');
  fs.writeFileSync(path.join(repo, 'clean.txt'), 'same\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'line1\nline2\n');   // modified, unstaged
  fs.writeFileSync(path.join(repo, 'fresh.txt'), 'new\n');              // untracked
  binDir = path.join(tmp, 'bin');
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'docker'), FAKE_DOCKER, { mode: 0o755 });
  originalPath = process.env.PATH;
  originalContainer = process.env.WARDEN_FAKE_CONTAINER;
  process.env.PATH = `${binDir}:${process.env.PATH}`;
  process.env.WARDEN_FAKE_CONTAINER = 'yatfa-test';
  chats.set('c1', { id: 'c1', host: LOCAL, container: 'yatfa-test', cwd: repo });
  chats.set('gone', { id: 'gone', host: LOCAL, container: 'yatfa-test', cwd: path.join(tmp, 'nope') });
  chats.set('nocwd', { id: 'nocwd', host: LOCAL, container: 'yatfa-test' });
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

describe('GET /api/git-diff on a delivered (container) chat', () => {
  it('returns the worktree diff of a modified tracked file', async () => {
    const { status, body } = await getJson({ id: 'c1', path: 'tracked.txt' });
    assert.equal(status, 200);
    assert.equal(body.error, null);
    assert.equal(body.untracked, false);
    assert.equal(body.path, 'tracked.txt');
    assert.match(body.diff, /\+line2/);
  });
  it('returns an empty (not untracked) diff for a clean tracked file', async () => {
    const { body } = await getJson({ id: 'c1', path: 'clean.txt' });
    assert.deepEqual(body, { diff: '', untracked: false, path: 'clean.txt', error: null });
  });
  it('flags an untracked file via the second ls-files probe: diff null, untracked true', async () => {
    const { body } = await getJson({ id: 'c1', path: 'fresh.txt' });
    assert.deepEqual(body, { diff: null, untracked: true, path: 'fresh.txt', error: null });
  });
  it('maps the script containment sentinel to HTTP 403', async () => {
    const { status, body } = await getJson({ id: 'c1', path: '../outside.txt' });
    assert.equal(status, 403);
    assert.deepEqual(body, { diff: null, untracked: false, path: '../outside.txt', error: 'path must be within working directory' });
  });
  it('maps the script invalid-path sentinel to HTTP 400', async () => {
    // cwd that does not exist: the script's `cd "$CWD"` fails, so the
    // `ERROR invalid path` sentinel (not the containment one) is what comes back.
    const { status, body } = await getJson({ id: 'gone', path: 'tracked.txt' });
    assert.equal(status, 400);
    assert.equal(body.diff, null);
    assert.equal(body.error, 'invalid path');
  });
  it('answers a non-sentinel failure softly as 200 { error: "diff failed" }', async () => {
    const plain = path.join(tmp, 'plain');   // non-git cwd: containment passes, git diff HEAD exits non-zero
    fs.mkdirSync(plain);
    fs.writeFileSync(path.join(plain, 'a.txt'), 'x\n');
    chats.set('plain', { id: 'plain', host: LOCAL, container: 'yatfa-test', cwd: plain });
    const { status, body } = await getJson({ id: 'plain', path: 'a.txt' });
    assert.equal(status, 200);
    assert.deepEqual(body, { diff: null, untracked: false, path: 'a.txt', error: 'diff failed' });
  });
  it('staged=1 isolates the index diff; any other value keeps the combined diff', async () => {
    git(['add', 'tracked.txt'], repo);
    try {
      const staged = await getJson({ id: 'c1', path: 'tracked.txt', staged: '1' });
      assert.match(staged.body.diff, /\+line2/);
      fs.appendFileSync(path.join(repo, 'tracked.txt'), 'line3\n');
      const only = await getJson({ id: 'c1', path: 'tracked.txt', staged: '1' });
      assert.doesNotMatch(only.body.diff, /\+line3/);
      const sloppy = await getJson({ id: 'c1', path: 'tracked.txt', staged: 'true' });
      assert.match(sloppy.body.diff, /\+line3/);
    } finally {
      git(['reset', '-q'], repo);
      fs.writeFileSync(path.join(repo, 'tracked.txt'), 'line1\nline2\n');
    }
  });
});

describe('GET /api/git-diff route-level guards', () => {
  it('400s a missing / blank path with the path-bearing empty contract', async () => {
    for (const p of [undefined, '', '   ']) {
      const q = { id: 'c1' };
      if (p !== undefined) q.path = p;
      const { status, body } = await getJson(q);
      assert.equal(status, 400);
      assert.deepEqual(body, { diff: null, untracked: false, path: '', error: 'path is required' });
    }
  });
  it('404s an unknown chat id carrying the path-bearing contract', async () => {
    const { status, body } = await getJson({ id: 'nope', path: 'tracked.txt' });
    assert.equal(status, 404);
    assert.deepEqual(body, { diff: null, untracked: false, path: 'tracked.txt', error: 'unknown chat' });
  });
  it('answers a cwd-less chat 200 { error: "no cwd" }', async () => {
    const { status, body } = await getJson({ id: 'nocwd', path: 'tracked.txt' });
    assert.equal(status, 200);
    assert.deepEqual(body, { diff: null, untracked: false, path: 'tracked.txt', error: 'no cwd' });
  });
  it('only the literal range=outgoing selects the range diff; anything else falls back to the worktree diff', async () => {
    // No upstream configured, so a REAL range diff fails; a garbage range must fall back, not be spliced.
    const garbage = await getJson({ id: 'c1', path: 'tracked.txt', range: 'HEAD~5..HEAD; touch /tmp/pwned' });
    assert.match(garbage.body.diff, /\+line2/);
    const outgoing = await getJson({ id: 'c1', path: 'tracked.txt', range: 'outgoing' });
    assert.equal(outgoing.body.error, 'diff failed');
  });
});
