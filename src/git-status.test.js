import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * Tests for the in-progress-operation + conflict detection in /api/git-status
 * (WARDEN-186).
 *
 * Mirrors src/git-log.test.js's HOME-freezing isolation: src/server.js evaluates
 * `const cfg = load()` at module load, and load() reads config.js's module-level
 * `dir` (= path.join(os.homedir(), …)). So the FIRST import of server.js freezes
 * the home dir for the whole process — we set process.env.HOME (and write config
 * + catalog + repos) BEFORE that single import. Do NOT re-import server.js with a
 * second HOME.
 *
 * Covers the acceptance criteria for the LOCAL host:
 *   - clean repo          → inProgress.operation === null
 *   - repo mid-`git merge` → inProgress.operation === 'merge' + a conflicted file
 *                            flagged conflict:true; after `git merge --abort` the
 *                            operation clears to null
 *   - non-git / no-cwd    → inProgress.operation === null (200, NOT a 500)
 *   - unknown id          → 404
 *
 * The remote (SSH) path uses the same marker set via a combined `test` command;
 * its logic is covered indirectly by the shared marker list. Driving a real SSH
 * host in CI is out of scope.
 */

let httpServer;
let baseUrl;
let originalHome;
let tempHome;
let cleanRepo;
let mergeRepo;
let nonGitDir;

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (status ${r.status}) in ${cwd}`);
  return r;
}

before(async () => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitstatus-'));
  process.env.HOME = tempHome;

  // config.json with no SSH hosts
  const wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: [] }));

  // ---- cleanRepo: one commit, nothing in progress ----
  cleanRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitstatus-clean-'));
  git(['init', '-q'], cleanRepo);
  git(['config', 'user.email', 'test@example.com'], cleanRepo);
  git(['config', 'user.name', 'Tester'], cleanRepo);
  fs.writeFileSync(path.join(cleanRepo, 'a.txt'), 'a\n');
  git(['add', '.'], cleanRepo);
  git(['commit', '-q', '-m', 'init'], cleanRepo);

  // ---- mergeRepo: left mid-conflict-merge (MERGE_HEAD present, f.txt in UU) ----
  // Pin the base branch name so the checkout-back step is deterministic (git's
  // default initial-branch name varies by config/version).
  mergeRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitstatus-merge-'));
  git(['init', '-q'], mergeRepo);
  git(['config', 'user.email', 'test@example.com'], mergeRepo);
  git(['config', 'user.name', 'Tester'], mergeRepo);
  git(['checkout', '-q', '-b', 'base'], mergeRepo);
  fs.writeFileSync(path.join(mergeRepo, 'f.txt'), 'base\n');
  git(['add', '.'], mergeRepo);
  git(['commit', '-q', '-m', 'base'], mergeRepo);
  // divergent branch: change f.txt
  git(['checkout', '-q', '-b', 'feature'], mergeRepo);
  fs.writeFileSync(path.join(mergeRepo, 'f.txt'), 'feature side\n');
  git(['commit', '-q', '-am', 'feature change'], mergeRepo);
  // back to base, change f.txt the OTHER way → guaranteed content conflict
  git(['checkout', '-q', 'base'], mergeRepo);
  fs.writeFileSync(path.join(mergeRepo, 'f.txt'), 'base side\n');
  git(['commit', '-q', '-am', 'base change'], mergeRepo);
  // merge → conflict. Exits non-zero (status 1) by design; MERGE_HEAD is written
  // and f.txt lands in the UU (both-modified) state. Run raw — our git() helper
  // throws on non-zero, but a conflict IS the success case here.
  const m = spawnSync('git', ['merge', '--no-edit', 'feature'], {
    cwd: mergeRepo, stdio: ['ignore', 'pipe', 'inherit'],
  });
  assert.notStrictEqual(m.status, 0, 'expected the merge to conflict (non-zero exit)');
  assert.ok(fs.existsSync(path.join(mergeRepo, '.git', 'MERGE_HEAD')), 'MERGE_HEAD must exist mid-merge');

  // ---- nonGitDir: a plain directory with no .git ----
  nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitstatus-nongit-'));
  fs.writeFileSync(path.join(nonGitDir, 'readme.txt'), 'not a repo\n');

  // Catalog with three LOCAL manual chats, resolved by bare session id (no ':'
  // prefix) so no host/tmux discovery runs.
  fs.writeFileSync(
    path.join(wardenDir, 'chats.json'),
    JSON.stringify([
      { host: '(local)', session: 'warden-clean', cwd: cleanRepo, cmd: 'bash', name: 'warden-clean' },
      { host: '(local)', session: 'warden-merge', cwd: mergeRepo, cmd: 'bash', name: 'warden-merge' },
      { host: '(local)', session: 'warden-nongit', cwd: nonGitDir, cmd: 'bash', name: 'warden-nongit' },
    ]),
  );

  // Import server.js ONCE — after HOME/config/catalog/repos are in place.
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
  for (const d of [cleanRepo, mergeRepo, nonGitDir, tempHome]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe('/api/git-status in-progress + conflict detection (real Express app)', () => {
  it('returns inProgress.operation null for a clean repo', async () => {
    const res = await fetch(`${baseUrl}/api/git-status?id=warden-clean`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    assert.ok(body.branch, 'clean repo must report a branch');
    assert.strictEqual(body.clean, true);
    assert.ok(body.inProgress, 'response must include inProgress');
    assert.strictEqual(body.inProgress.operation, null);
  });

  it('detects an in-progress merge and flags the conflicted file', async () => {
    const res = await fetch(`${baseUrl}/api/git-status?id=warden-merge`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    // The headline assertion: a blocked agent is visible without opening the chat.
    assert.strictEqual(body.inProgress.operation, 'merge');
    assert.strictEqual(body.clean, false);
    // The conflicted path (UU) must be tagged conflict:true — not the gray fallback.
    const conflicted = (body.files || []).filter((f) => f.conflict);
    assert.ok(conflicted.length >= 1, 'expected at least one conflict:true file');
    assert.ok(conflicted.some((f) => f.path === 'f.txt'), 'f.txt should be the conflicted path');
  });

  it('clears the operation after `git merge --abort`', async () => {
    // Abort the merge (mutates mergeRepo) then re-query — must read clean/null.
    git(['merge', '--abort'], mergeRepo);
    const body = await (await fetch(`${baseUrl}/api/git-status?id=warden-merge`)).json();
    assert.strictEqual(body.inProgress.operation, null);
  });

  it('returns inProgress.operation null (200, not 500) for a non-git cwd', async () => {
    const res = await fetch(`${baseUrl}/api/git-status?id=warden-nongit`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.branch, null);
    assert.strictEqual(body.inProgress.operation, null);
  });

  it('returns 404 for an unknown chat id', async () => {
    const res = await fetch(`${baseUrl}/api/git-status?id=does-not-exist`);
    assert.strictEqual(res.status, 404);
  });
});
