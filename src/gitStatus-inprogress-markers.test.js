import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * Tests for detectInProgress's manual-LOCAL fs legs in /api/git-status
 * (WARDEN-2094).
 *
 * Mirrors src/git-status.test.js's HOME-freezing isolation: src/server.js
 * evaluates `const cfg = load()` at module load, and load() reads config.js's
 * module-level `dir` (= path.join(os.homedir(), …)). So the FIRST import of
 * server.js freezes the home dir for the whole process — we set process.env.HOME
 * (and write config + catalog + repos) BEFORE that single import. Do NOT
 * re-import server.js with a second HOME.
 *
 * Gap covered (WARDEN-2094): src/git-status.test.js drives only the mid-merge
 * and mid-`rebase -i` repos through the route. Nothing exercises the
 * CHERRY_PICK_HEAD, REVERT_HEAD, rebase-apply and BISECT_LOG fs.existsSync legs
 * of detectInProgress's manual-LOCAL branch (`!chat.container && chat.host ===
 * LOCAL`), the readMarker calls feeding them, or the cross-marker precedence —
 * each wrong outcome flips a blocked agent's badge to "nothing in progress"
 * (the exact failure WARDEN-186/511 exist to prevent). The script path
 * (buildInProgressScript) and the pure parseInProgressDetail cases have their
 * own coverage there; THIS file drives the host-fs marker path end to end.
 *
 * Fixtures are REAL repos driven through the live route (same discipline as
 * git-status.test.js): `git cherry-pick` / `git revert` / `git rebase --apply`
 * halt with a non-zero exit BY DESIGN — the halt IS the success case, so those
 * invocations run raw with an explicit non-zero assertion (the git() helper
 * throws on non-zero and would misreport a no-conflict fixture as a setup
 * failure). Every fixture sanity-asserts the marker file/dir git must have
 * written in before(), so a git-version change fails loudly at setup instead of
 * vacuously. Expected detail values are read FROM the marker files, not
 * hardcoded — the assertions lock the endpoint's echo of the actual on-disk
 * state.
 */

let httpServer;
let baseUrl;
let originalHome;
let tempHome;
let cherryRepo;
let cherryShort;
let revertRepo;
let revertShort;
let bisectRepo;
let reapplyRepo;
let precedenceRepo;
let precedenceShort;
let cherrySubDir;

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (status ${r.status}) in ${cwd}`);
  return r;
}

// A git invocation whose non-zero exit IS the success case (a conflict/halt):
// assert the halt happened instead of throwing, so a fixture that silently
// completes cleanly fails loudly at setup (the Driver-Precondition rule).
function gitHalts(args, cwd, why) {
  const r = spawnSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
  assert.notStrictEqual(r.status, 0, why);
  return r;
}

function initRepo(dir) {
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Tester'], dir);
}

before(async () => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitstatus-markers-'));
  process.env.HOME = tempHome;

  // config.json with no SSH hosts
  const wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: [] }));

  // ---- cherryRepo: left mid-`git cherry-pick` (CHERRY_PICK_HEAD present) ----
  cherryRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitstatus-cherry-'));
  initRepo(cherryRepo);
  fs.writeFileSync(path.join(cherryRepo, 'f.txt'), 'root\n');
  git(['add', '.'], cherryRepo);
  git(['commit', '-q', '-m', 'root'], cherryRepo);
  // feature rewrites f.txt one way; main rewrites it the OTHER way → the
  // cherry-pick of the feature commit onto main is a guaranteed content conflict.
  git(['checkout', '-q', '-b', 'feature'], cherryRepo);
  fs.writeFileSync(path.join(cherryRepo, 'f.txt'), 'feature side\n');
  git(['commit', '-q', '-am', 'feature change'], cherryRepo);
  const featureSha = git(['rev-parse', 'HEAD'], cherryRepo).stdout.toString().trim();
  git(['checkout', '-q', 'main'], cherryRepo);
  fs.writeFileSync(path.join(cherryRepo, 'f.txt'), 'main side\n');
  git(['commit', '-q', '-am', 'main change'], cherryRepo);
  gitHalts(['cherry-pick', featureSha], cherryRepo, 'expected the cherry-pick to conflict (non-zero exit)');
  assert.ok(fs.existsSync(path.join(cherryRepo, '.git', 'CHERRY_PICK_HEAD')), 'CHERRY_PICK_HEAD must exist mid-cherry-pick');
  cherryShort = fs.readFileSync(path.join(cherryRepo, '.git', 'CHERRY_PICK_HEAD'), 'utf8').trim().slice(0, 7);
  assert.strictEqual(cherryShort, featureSha.slice(0, 7), 'CHERRY_PICK_HEAD must name the picked commit');
  // A subdirectory of the same repo, used by the cwd-resolution test: git
  // resolves `rev-parse --git-dir` to an ABSOLUTE path from a subdir, which
  // path.resolve(cwd, gitDir) must pass through unchanged.
  cherrySubDir = path.join(cherryRepo, 'sub');
  fs.mkdirSync(cherrySubDir, { recursive: true });

  // ---- revertRepo: left mid-`git revert` (REVERT_HEAD present) ----
  // Three commits rewriting f.txt; reverting the middle one onto a tree where
  // f.txt reads 'three' is a guaranteed conflict (the inverse patch's removed
  // line no longer exists).
  revertRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitstatus-revert-'));
  initRepo(revertRepo);
  fs.writeFileSync(path.join(revertRepo, 'f.txt'), 'one\n');
  git(['add', '.'], revertRepo);
  git(['commit', '-q', '-m', 'one'], revertRepo);
  fs.writeFileSync(path.join(revertRepo, 'f.txt'), 'two\n');
  git(['commit', '-q', '-am', 'two'], revertRepo);
  const middleSha = git(['rev-parse', 'HEAD'], revertRepo).stdout.toString().trim();
  fs.writeFileSync(path.join(revertRepo, 'f.txt'), 'three\n');
  git(['commit', '-q', '-am', 'three'], revertRepo);
  gitHalts(['revert', '--no-edit', middleSha], revertRepo, 'expected the revert to conflict (non-zero exit)');
  assert.ok(fs.existsSync(path.join(revertRepo, '.git', 'REVERT_HEAD')), 'REVERT_HEAD must exist mid-revert');
  revertShort = fs.readFileSync(path.join(revertRepo, '.git', 'REVERT_HEAD'), 'utf8').trim().slice(0, 7);
  assert.strictEqual(revertShort, middleSha.slice(0, 7), 'REVERT_HEAD must name the reverted commit');

  // ---- bisectRepo: left mid-`git bisect` (BISECT_LOG present) ----
  bisectRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitstatus-bisect-'));
  initRepo(bisectRepo);
  fs.writeFileSync(path.join(bisectRepo, 'f.txt'), 'one\n');
  git(['add', '.'], bisectRepo);
  git(['commit', '-q', '-m', 'one'], bisectRepo);
  fs.writeFileSync(path.join(bisectRepo, 'f.txt'), 'two\n');
  git(['commit', '-q', '-am', 'two'], bisectRepo);
  git(['bisect', 'start'], bisectRepo);
  assert.ok(fs.existsSync(path.join(bisectRepo, '.git', 'BISECT_LOG')), 'BISECT_LOG must exist mid-bisect');

  // ---- reapplyRepo: left mid-`git rebase --apply` (rebase-apply present,
  // rebase-merge ABSENT) ----
  // topic rewrites f.txt one way; main rewrites it the other way → replaying the
  // topic commit onto main is a guaranteed conflict, and --apply pins the older
  // apply backend (git's default since 2.26 is the merge backend, which the
  // sibling suite already covers via `rebase -i`).
  reapplyRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitstatus-reapply-'));
  initRepo(reapplyRepo);
  fs.writeFileSync(path.join(reapplyRepo, 'f.txt'), 'root\n');
  git(['add', '.'], reapplyRepo);
  git(['commit', '-q', '-m', 'root'], reapplyRepo);
  git(['checkout', '-q', '-b', 'topic'], reapplyRepo);
  fs.writeFileSync(path.join(reapplyRepo, 'f.txt'), 'topic side\n');
  git(['commit', '-q', '-am', 'topic change'], reapplyRepo);
  git(['checkout', '-q', 'main'], reapplyRepo);
  fs.writeFileSync(path.join(reapplyRepo, 'f.txt'), 'main side\n');
  git(['commit', '-q', '-am', 'main change'], reapplyRepo);
  git(['checkout', '-q', 'topic'], reapplyRepo);
  gitHalts(['rebase', '--apply', 'main'], reapplyRepo, 'expected the rebase to conflict (non-zero exit)');
  assert.ok(fs.existsSync(path.join(reapplyRepo, '.git', 'rebase-apply')), 'rebase-apply dir must exist mid-apply-rebase');
  assert.ok(!fs.existsSync(path.join(reapplyRepo, '.git', 'rebase-merge')), 'rebase-merge must NOT exist (apply backend selected)');

  // ---- precedenceRepo: BOTH BISECT_LOG and CHERRY_PICK_HEAD present ----
  // Bisect starts FIRST (writing BISECT_LOG), then the conflicting cherry-pick
  // adds CHERRY_PICK_HEAD on top. detectInProgress must still report the
  // cherry-pick — the marker order pins CHERRY_PICK_HEAD ahead of BISECT_LOG.
  precedenceRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitstatus-precedence-'));
  initRepo(precedenceRepo);
  fs.writeFileSync(path.join(precedenceRepo, 'f.txt'), 'root\n');
  git(['add', '.'], precedenceRepo);
  git(['commit', '-q', '-m', 'root'], precedenceRepo);
  git(['checkout', '-q', '-b', 'feature'], precedenceRepo);
  fs.writeFileSync(path.join(precedenceRepo, 'f.txt'), 'feature side\n');
  git(['commit', '-q', '-am', 'feature change'], precedenceRepo);
  const precedenceFeatureSha = git(['rev-parse', 'HEAD'], precedenceRepo).stdout.toString().trim();
  git(['checkout', '-q', 'main'], precedenceRepo);
  fs.writeFileSync(path.join(precedenceRepo, 'f.txt'), 'main side\n');
  git(['commit', '-q', '-am', 'main change'], precedenceRepo);
  git(['bisect', 'start'], precedenceRepo);
  assert.ok(fs.existsSync(path.join(precedenceRepo, '.git', 'BISECT_LOG')), 'BISECT_LOG must exist after bisect start');
  gitHalts(['cherry-pick', precedenceFeatureSha], precedenceRepo, 'expected the cherry-pick to conflict (non-zero exit)');
  assert.ok(fs.existsSync(path.join(precedenceRepo, '.git', 'CHERRY_PICK_HEAD')), 'CHERRY_PICK_HEAD must exist mid-cherry-pick');
  precedenceShort = fs.readFileSync(path.join(precedenceRepo, '.git', 'CHERRY_PICK_HEAD'), 'utf8').trim().slice(0, 7);

  // Catalog with LOCAL manual chats, resolved by bare session id (no ':'
  // prefix) so no host/tmux discovery runs. warden-cherry-sub points at a
  // SUBDIRECTORY of cherryRepo to pin the git-dir resolution against cwd.
  fs.writeFileSync(
    path.join(wardenDir, 'chats.json'),
    JSON.stringify([
      { host: '(local)', session: 'warden-cherry', cwd: cherryRepo, cmd: 'bash', name: 'warden-cherry' },
      { host: '(local)', session: 'warden-revert', cwd: revertRepo, cmd: 'bash', name: 'warden-revert' },
      { host: '(local)', session: 'warden-bisect', cwd: bisectRepo, cmd: 'bash', name: 'warden-bisect' },
      { host: '(local)', session: 'warden-reapply', cwd: reapplyRepo, cmd: 'bash', name: 'warden-reapply' },
      { host: '(local)', session: 'warden-precedence', cwd: precedenceRepo, cmd: 'bash', name: 'warden-precedence' },
      { host: '(local)', session: 'warden-cherry-sub', cwd: cherrySubDir, cmd: 'bash', name: 'warden-cherry-sub' },
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
  for (const d of [cherryRepo, revertRepo, bisectRepo, reapplyRepo, precedenceRepo, tempHome]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe('/api/git-status manual-LOCAL in-progress marker legs (real Express app)', () => {
  it('detects an in-progress cherry-pick and surfaces the picked sha', async () => {
    const res = await fetch(`${baseUrl}/api/git-status?id=warden-cherry`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    assert.ok(body.branch, 'the fixture repo must report a branch (inProgress is branch-gated)');
    // The headline assertion: a cherry-pick-blocked agent is visible without
    // opening the chat, and the detail names WHICH commit is being applied.
    assert.strictEqual(body.inProgress.operation, 'cherry-pick');
    assert.strictEqual(body.inProgress.detail, cherryShort);
  });

  it('detects an in-progress revert and surfaces the reverted sha', async () => {
    const res = await fetch(`${baseUrl}/api/git-status?id=warden-revert`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    assert.ok(body.branch, 'the fixture repo must report a branch (inProgress is branch-gated)');
    assert.strictEqual(body.inProgress.operation, 'revert');
    assert.strictEqual(body.inProgress.detail, revertShort);
  });

  it('detects an in-progress bisect with a null detail', async () => {
    const res = await fetch(`${baseUrl}/api/git-status?id=warden-bisect`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    assert.ok(body.branch, 'the fixture repo must report a branch (inProgress is branch-gated)');
    assert.strictEqual(body.inProgress.operation, 'bisect');
    // Bisect carries no *_HEAD sha — a null detail must not be misread as a
    // failed detection (operation non-null is the signal).
    assert.strictEqual(body.inProgress.detail, null);
  });

  it('detects the apply-backend rebase (rebase-apply) with a null detail — never a fabricated step', async () => {
    const res = await fetch(`${baseUrl}/api/git-status?id=warden-reapply`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    assert.ok(body.branch, 'the fixture repo must report a branch (inProgress is branch-gated)');
    assert.strictEqual(body.inProgress.operation, 'rebase');
    // rebase-apply has NO step files — the surface must read null detail, not a
    // misleading "0/0" step assembled from absent files.
    assert.strictEqual(body.inProgress.detail, null);
  });

  it('prefers CHERRY_PICK_HEAD over BISECT_LOG when both markers exist', async () => {
    const res = await fetch(`${baseUrl}/api/git-status?id=warden-precedence`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    // Both markers genuinely co-exist in this repo (asserted in before()); the
    // route must report the cherry-pick, not the bisect, and carry its detail.
    assert.strictEqual(body.inProgress.operation, 'cherry-pick');
    assert.strictEqual(body.inProgress.detail, precedenceShort);
    assert.notStrictEqual(body.inProgress.detail, null);
  });

  it('still detects the cherry-pick when the chat cwd is a subdirectory of the repo', async () => {
    const res = await fetch(`${baseUrl}/api/git-status?id=warden-cherry-sub`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    assert.ok(body.branch, 'the fixture repo must report a branch (inProgress is branch-gated)');
    // From a subdir `rev-parse --git-dir` returns an ABSOLUTE path; the manual-
    // LOCAL leg must still land on the marker files (the operation must not
    // degrade to null because the resolved git dir went missing).
    assert.strictEqual(body.inProgress.operation, 'cherry-pick');
    assert.strictEqual(body.inProgress.detail, cherryShort);
  });
});
