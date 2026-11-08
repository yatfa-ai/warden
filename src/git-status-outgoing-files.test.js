import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * Route-level tests for `outgoingFiles` in /api/git-status (WARDEN-601).
 *
 * The route runs `git diff --name-only @{u}...HEAD` only when
 * `branch && typeof ahead === 'number' && ahead > 0` and serves null otherwise.
 * src/gitStatus.test.js pins the pure parser; nothing else drove the route's
 * probe or its gate. These tests pin the OBSERVABLE contract (list vs null)
 * with real tmp git repos (bare remote + `push -u`) behind the real Express app.
 *
 * The diverged-branch case (unpushed + incoming commits) is pinned too: the
 * three-dot form lists only the local commits' files, never upstream-only ones.
 *
 * Same HOME-freeze-before-single-import harness as src/git-status.test.js:
 * server.js freezes the home dir on first import, so HOME is set first.
 */

let httpServer;
let baseUrl;
let originalHome;
let tempHome;
const dirs = [];

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (status ${r.status}) in ${cwd}`);
  return r;
}

function mk(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function write(repo, rel, content) {
  const full = path.join(repo, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function commit(repo, rel, content, msg) {
  write(repo, rel, content);
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', msg], repo);
}

/** A repo on branch `feature` tracking a bare remote, in sync after setup. */
function trackingRepo(prefix) {
  const repo = mk(prefix);
  const remote = mk(`${prefix}remote-`);
  git(['init', '-q', '--bare'], remote);
  git(['init', '-q'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Tester'], repo);
  git(['config', 'core.quotepath', 'true'], repo);
  git(['checkout', '-q', '-b', 'feature'], repo);
  commit(repo, 'base.txt', 'base\n', 'init');
  git(['remote', 'add', 'origin', remote], repo);
  git(['push', '-q', '-u', 'origin', 'feature'], repo);
  return repo;
}

let aheadRepo;
let dirtyRepo;
let syncedRepo;
let noUpstreamRepo;
let divergedRepo;

before(async () => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-outgoing-'));
  dirs.push(tempHome);
  process.env.HOME = tempHome;

  const wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: [] }));

  // 4 unpushed commits: one path touched twice, a nested path, a spaced path,
  // a non-ASCII path.
  aheadRepo = trackingRepo('warden-outgoing-ahead-');
  commit(aheadRepo, 'src/auth.js', 'v1\n', 'auth 1');
  commit(aheadRepo, 'src/auth.js', 'v2\n', 'auth 2');
  commit(aheadRepo, 'docs/my notes.md', 'notes\n', 'notes');
  commit(aheadRepo, 'café.js', 'x\n', 'cafe');

  // 1 unpushed commit + a dirty working tree.
  dirtyRepo = trackingRepo('warden-outgoing-dirty-');
  commit(dirtyRepo, 'committed.txt', 'c\n', 'committed');
  write(dirtyRepo, 'wip.txt', 'wip\n');

  // In sync with upstream (ahead 0).
  syncedRepo = trackingRepo('warden-outgoing-synced-');

  // Unpushed commit but no upstream configured.
  noUpstreamRepo = mk('warden-outgoing-noup-');
  git(['init', '-q'], noUpstreamRepo);
  git(['config', 'user.email', 'test@example.com'], noUpstreamRepo);
  git(['config', 'user.name', 'Tester'], noUpstreamRepo);
  git(['checkout', '-q', '-b', 'solo'], noUpstreamRepo);
  commit(noUpstreamRepo, 'a.txt', 'a\n', 'init');
  commit(noUpstreamRepo, 'b.txt', 'b\n', 'second');

  // Diverged: one upstream-only commit (pushed, then dropped locally) plus one
  // unpushed local commit → ahead 1, behind 1.
  divergedRepo = trackingRepo('warden-outgoing-diverged-');
  commit(divergedRepo, 'theirs.txt', 't\n', 'theirs');
  git(['push', '-q', 'origin', 'feature'], divergedRepo);
  git(['reset', '-q', '--hard', 'HEAD~1'], divergedRepo);
  commit(divergedRepo, 'ours.txt', 'o\n', 'ours');

  fs.writeFileSync(
    path.join(wardenDir, 'chats.json'),
    JSON.stringify([
      { host: '(local)', session: 'warden-ahead', cwd: aheadRepo, cmd: 'bash', name: 'warden-ahead' },
      { host: '(local)', session: 'warden-dirty', cwd: dirtyRepo, cmd: 'bash', name: 'warden-dirty' },
      { host: '(local)', session: 'warden-synced', cwd: syncedRepo, cmd: 'bash', name: 'warden-synced' },
      { host: '(local)', session: 'warden-noup', cwd: noUpstreamRepo, cmd: 'bash', name: 'warden-noup' },
      { host: '(local)', session: 'warden-diverged', cwd: divergedRepo, cmd: 'bash', name: 'warden-diverged' },
    ]),
  );

  const server = await import('./server.js');
  httpServer = server.app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    httpServer.once('listening', resolve);
    httpServer.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

after(async () => {
  if (httpServer) await new Promise((r) => httpServer.close(r));
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

async function status(id) {
  const res = await fetch(`${baseUrl}/api/git-status?id=${id}`);
  assert.strictEqual(res.status, 200);
  return res.json();
}

describe('/api/git-status outgoingFiles (real Express app)', () => {
  it('lists the de-duplicated, unquoted changed paths of the unpushed commits when ahead > 0', async () => {
    const body = await status('warden-ahead');
    assert.strictEqual(body.ahead, 4);
    assert.deepStrictEqual([...body.outgoingFiles].sort(), ['café.js', 'docs/my notes.md', 'src/auth.js']);
  });

  it('reports only committed-unpushed paths in outgoingFiles; the dirty file stays in files', async () => {
    const body = await status('warden-dirty');
    assert.strictEqual(body.ahead, 1);
    assert.deepStrictEqual(body.outgoingFiles, ['committed.txt']);
    assert.ok(
      Array.isArray(body.files) && body.files.some((f) => f.path === 'wip.txt'),
      `wip.txt should appear in files, got ${JSON.stringify(body.files)}`,
    );
  });

  it('serves outgoingFiles null (not []) for an in-sync tracking branch (ahead 0)', async () => {
    const body = await status('warden-synced');
    assert.strictEqual(body.ahead, 0);
    assert.strictEqual(body.outgoingFiles, null);
  });

  it('serves outgoingFiles null when there are unpushed commits but no upstream (ahead null)', async () => {
    const body = await status('warden-noup');
    assert.strictEqual(body.upstream, null);
    assert.strictEqual(body.ahead, null);
    assert.strictEqual(body.outgoingFiles, null);
  });

  it('on a diverged branch lists only the local commits\' files, not upstream-only ones', async () => {
    const body = await status('warden-diverged');
    assert.strictEqual(body.ahead, 1);
    assert.strictEqual(body.behind, 1);
    assert.deepStrictEqual(body.outgoingFiles, ['ours.txt']);
  });
});
