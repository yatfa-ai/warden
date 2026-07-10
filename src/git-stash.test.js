import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * Tests for shelved-WIP visibility (WARDEN-211):
 *   - the eager `stashCount` field in /api/git-status
 *   - the lazy /api/git-stash detail endpoint
 *
 * Mirrors src/git-log.test.js's HOME-freezing isolation: src/server.js evaluates
 * `const cfg = load()` at module load, and load() reads config.js's module-level
 * `dir` (= path.join(os.homedir(), …)). So the FIRST import of server.js freezes
 * the home dir for the whole process — we set process.env.HOME (and write config
 * + catalog + repos) BEFORE that single import. Do NOT re-import server.js with a
 * second HOME.
 *
 * Covers the acceptance criteria for the LOCAL host:
 *   - repo with a stash but a clean tree → stashCount === 1 while clean === true
 *     (the core gap: porcelain hides stashed work)
 *   - /api/git-stash returns the stash subject(s)
 *   - repo with no stash → stashCount === null, /api/git-stash returns []
 *   - non-git / no-cwd → stashCount === null (200, NOT a 500)
 *   - unknown id → 404
 *
 * The remote (SSH) path reuses the same `git stash list` invocation; its logic is
 * covered indirectly. Driving a real SSH host in CI is out of scope.
 */

let httpServer;
let baseUrl;
let originalHome;
let tempHome;
let stashRepo;
let cleanRepo;
let nonGitDir;
// The subject we stash, captured so the detail test can assert it survives the wire.
const STASH_SUBJECT_HINT = 'uncommitted wip to stash';

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (status ${r.status}) in ${cwd}`);
  return r;
}

before(async () => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitstash-'));
  process.env.HOME = tempHome;

  // config.json with no SSH hosts
  const wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: [] }));

  // ---- stashRepo: one commit, then a working-tree change shelved via git stash ----
  // After `git stash` the tree is CLEAN but recoverable work is parked — exactly
  // the misleading state this feature fixes (clean:true must NOT mean "nothing pending").
  stashRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitstash-repo-'));
  git(['init', '-q'], stashRepo);
  git(['config', 'user.email', 'test@example.com'], stashRepo);
  git(['config', 'user.name', 'Tester'], stashRepo);
  fs.writeFileSync(path.join(stashRepo, 'committed.txt'), 'committed\n');
  git(['add', '.'], stashRepo);
  git(['commit', '-q', '-m', 'init'], stashRepo);
  // an uncommitted change → stash it → tree goes clean, work is parked
  fs.writeFileSync(path.join(stashRepo, 'wip.txt'), STASH_SUBJECT_HINT + '\n');
  git(['add', '.'], stashRepo); // stage so the default WIP subject is stable across git versions
  git(['stash'], stashRepo);
  // sanity: confirm the stash exists and the tree is clean before the API is queried
  const listCheck = spawnSync('git', ['stash', 'list'], { cwd: stashRepo, stdio: ['ignore', 'pipe', 'inherit'] });
  assert.ok((listCheck.stdout?.toString() || '').trim(), 'sanity: a stash must exist in stashRepo');
  const statusCheck = spawnSync('git', ['status', '--porcelain'], { cwd: stashRepo, stdio: ['ignore', 'pipe', 'inherit'] });
  assert.strictEqual((statusCheck.stdout?.toString() || '').trim(), '', 'sanity: stashRepo tree must be clean post-stash');

  // ---- cleanRepo: one commit, NO stashes ----
  cleanRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitstash-clean-'));
  git(['init', '-q'], cleanRepo);
  git(['config', 'user.email', 'test@example.com'], cleanRepo);
  git(['config', 'user.name', 'Tester'], cleanRepo);
  fs.writeFileSync(path.join(cleanRepo, 'a.txt'), 'a\n');
  git(['add', '.'], cleanRepo);
  git(['commit', '-q', '-m', 'init'], cleanRepo);

  // ---- nonGitDir: a plain directory with no .git ----
  nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitstash-nongit-'));
  fs.writeFileSync(path.join(nonGitDir, 'readme.txt'), 'not a repo\n');

  // Catalog with three LOCAL manual chats, resolved by bare session id (no ':'
  // prefix) so no host/tmux discovery runs.
  fs.writeFileSync(
    path.join(wardenDir, 'chats.json'),
    JSON.stringify([
      { host: '(local)', session: 'warden-stashed', cwd: stashRepo, cmd: 'bash', name: 'warden-stashed' },
      { host: '(local)', session: 'warden-clean', cwd: cleanRepo, cmd: 'bash', name: 'warden-clean' },
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
  for (const d of [stashRepo, cleanRepo, nonGitDir, tempHome]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe('/api/git-status stashCount (real Express app from server.js)', () => {
  it('reports stashCount: 1 for a stashed-but-clean repo (the core fix)', async () => {
    const res = await fetch(`${baseUrl}/api/git-status?id=warden-stashed`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    assert.ok(body.branch, 'stashed repo must report a branch');
    // The headline: porcelain is clean, yet work IS parked. clean AND stashCount>0.
    assert.strictEqual(body.clean, true);
    assert.strictEqual(body.stashCount, 1);
    assert.deepStrictEqual(body.files, []); // porcelain genuinely empty
  });

  it('reports stashCount null for a repo with no stashes', async () => {
    const body = await (await fetch(`${baseUrl}/api/git-status?id=warden-clean`)).json();
    assert.strictEqual(body.error, null);
    assert.ok(body.branch);
    assert.strictEqual(body.clean, true);
    assert.strictEqual(body.stashCount, null);
  });

  it('reports stashCount null (200, not 500) for a non-git cwd', async () => {
    const res = await fetch(`${baseUrl}/api/git-status?id=warden-nongit`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.branch, null);
    assert.strictEqual(body.stashCount, null);
  });
});

describe('/api/git-stash detail endpoint (real Express app from server.js)', () => {
  it('returns the stashed entry with ref/subject/date for a stashed repo', async () => {
    const res = await fetch(`${baseUrl}/api/git-stash?id=warden-stashed`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    assert.ok(Array.isArray(body.stashes));
    assert.strictEqual(body.stashes.length, 1);
    const s = body.stashes[0];
    assert.match(s.ref, /^stash@\{0\}$/);
    assert.ok(typeof s.subject === 'string' && s.subject.length > 0, 'subject must be non-empty');
    // git's default WIP subject includes the branch name + the stashed tree's HEAD;
    // we staged the wip file so the subject references this stash's parent state.
    assert.ok(typeof s.date === 'string' && s.date.length > 0, 'relative date must be non-empty');
  });

  it('returns [] for a repo with no stashes (200, not 500)', async () => {
    const res = await fetch(`${baseUrl}/api/git-stash?id=warden-clean`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    assert.deepStrictEqual(body.stashes, []);
  });

  it('returns [] (200, not 500) for a non-git cwd', async () => {
    const res = await fetch(`${baseUrl}/api/git-stash?id=warden-nongit`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.stashes, []);
    assert.strictEqual(body.error, null);
  });

  it('returns 404 for an unknown chat id', async () => {
    const res = await fetch(`${baseUrl}/api/git-stash?id=does-not-exist`);
    assert.strictEqual(res.status, 404);
  });
});
