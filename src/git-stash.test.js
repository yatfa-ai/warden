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
let unbornRepo; // healthy repo, `git init` with no commits yet (WARDEN-1021)
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

  // A HEALTHY repo whose HEAD has no commits yet (WARDEN-1021). This route's
  // primary command exits ZERO here (unlike /api/git-log and /api/git-reflog,
  // which need an explicit unborn-HEAD probe on their non-zero leg), so no
  // production code is involved — this pins that asymmetry so a future change
  // can't start reporting a brand-new repo as a failure.
  unbornRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitstash-unborn-'));
  git(['init', '-q', '-b', 'main'], unbornRepo);
  git(['config', 'user.email', 'test@example.com'], unbornRepo);
  git(['config', 'user.name', 'Tester'], unbornRepo);
  fs.writeFileSync(path.join(unbornRepo, 'wip.txt'), 'uncommitted\n');

  // Catalog with three LOCAL manual chats, resolved by bare session id (no ':'
  // prefix) so no host/tmux discovery runs.
  fs.writeFileSync(
    path.join(wardenDir, 'chats.json'),
    JSON.stringify([
      { host: '(local)', session: 'warden-stashed', cwd: stashRepo, cmd: 'bash', name: 'warden-stashed' },
      { host: '(local)', session: 'warden-clean', cwd: cleanRepo, cmd: 'bash', name: 'warden-clean' },
      { host: '(local)', session: 'warden-nongit', cwd: nonGitDir, cmd: 'bash', name: 'warden-nongit' },
      { host: '(local)', session: 'warden-unborn', cwd: unbornRepo, cmd: 'bash', name: 'warden-unborn' },
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
  for (const d of [stashRepo, cleanRepo, nonGitDir, unbornRepo, tempHome]) {
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
    // WARDEN-1021 no-false-positive guard: `git stash list` on a stash-less repo exits
    // ZERO with empty stdout. That is a legitimate empty, NOT a failure — error stays
    // null, so the non-git case above is genuinely distinguishable from this one.
    const res = await fetch(`${baseUrl}/api/git-stash?id=warden-clean`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    assert.deepStrictEqual(body.stashes, []);
  });

  it('returns [] with a NON-EMPTY error (200, not 500) for a non-git cwd (WARDEN-1021)', async () => {
    // `git stash list` exits non-zero on a non-git cwd. Before WARDEN-1021 the route
    // discarded that exit status and answered `error: null`, so the dialog rendered a
    // confident "no stashes" for a broken repo / deleted cwd / dropped SSH transport.
    // The error must be non-empty: runGit pipes `2>/dev/null` on BOTH remote branches,
    // so an `r.stderr` passthrough would be an empty string here — and
    // readListResponse (web/src/lib/api.ts) treats an empty string as "no error",
    // making the fix a silent no-op on exactly the transports warden deploys over.
    const res = await fetch(`${baseUrl}/api/git-stash?id=warden-nongit`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.stashes, []);
    assert.strictEqual(typeof body.error, 'string');
    assert.ok(body.error.length > 0, 'a failing git command must yield a NON-EMPTY error string');
  });

  it('returns [] with error null for a HEALTHY repo with an unborn HEAD (WARDEN-1021)', async () => {
    // `git stash list` exits ZERO on a fresh `git init` with no commits — unlike
    // `git log`/`git reflog`, which exit non-zero and therefore need an explicit
    // unborn-HEAD probe. So this route reaches the empty-list-with-error-null path
    // on its own. Pinned because a brand-new repo must never read as a failure.
    const res = await fetch(`${baseUrl}/api/git-stash?id=warden-unborn`);
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

describe('/api/git-stash-show detail endpoint (real Express app from server.js)', () => {
  /**
   * The depth layer under /api/git-stash (WARDEN-340): a stash expands to its
   * changed files + per-file diff, mirroring /api/git-show + CommitFile for commits.
   * stashRepo (seeded above) stashed a NEW wip.txt (added, then stashed) at
   * stash@{0}, so the files-list + per-file-diff cases have real content to assert.
   * Mirrors src/git-show.test.js's resolve → validate → guard → never-500 shape.
   */

  it("returns the stash's touched files for a known ref", async () => {
    const res = await fetch(`${baseUrl}/api/git-stash-show?id=warden-stashed&ref=${encodeURIComponent('stash@{0}')}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    assert.ok(Array.isArray(body.files));
    // stashRepo stashed a NEW wip.txt (added then stashed) → status 'A' vs base.
    assert.deepStrictEqual(body.files, [{ status: 'A', path: 'wip.txt' }]);
    assert.strictEqual(body.diff, null); // no path requested → no diff
  });

  it('returns a per-file diff when path= is given', async () => {
    const res = await fetch(`${baseUrl}/api/git-stash-show?id=warden-stashed&ref=${encodeURIComponent('stash@{0}')}&path=${encodeURIComponent('wip.txt')}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    assert.ok(typeof body.diff === 'string' && body.diff.length > 0, 'diff must be a non-empty string');
    assert.ok(body.diff.includes('+uncommitted wip to stash'), 'diff should show the stashed line(s)');
  });

  it('rejects a malformed ref with 200 + invalid ref (injection guard, WARDEN-122)', async () => {
    // The ref clamp: only ^stash@{\d+}$ is accepted. Each of these must be rejected
    // BEFORE it reaches git or the remote shell — 200 + { files: [], error }.
    for (const bad of ['stash@{a}', '--version', '; rm -rf /', 'stash@{0', 'main', 'stash@{0} refs/stash']) {
      const res = await fetch(`${baseUrl}/api/git-stash-show?id=warden-stashed&ref=${encodeURIComponent(bad)}`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.deepStrictEqual(body.files, [], `${JSON.stringify(bad)} should yield empty files`);
      assert.strictEqual(body.diff, null);
      assert.strictEqual(body.error, 'invalid ref');
    }
  });

  it('rejects a path-traversal path= param (200, never 500)', async () => {
    const res = await fetch(`${baseUrl}/api/git-stash-show?id=warden-stashed&ref=${encodeURIComponent('stash@{0}')}&path=${encodeURIComponent('../../etc/passwd')}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.files, []);
    assert.strictEqual(body.diff, null);
    assert.strictEqual(body.error, 'invalid path');
  });

  it('rejects an absolute path= param (200, never 500)', async () => {
    const res = await fetch(`${baseUrl}/api/git-stash-show?id=warden-stashed&ref=${encodeURIComponent('stash@{0}')}&path=${encodeURIComponent('/etc/passwd')}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, 'invalid path');
  });

  it('returns { files: [], diff: null, error: null } (200, not 500) for a non-git cwd', async () => {
    const res = await fetch(`${baseUrl}/api/git-stash-show?id=warden-nongit&ref=${encodeURIComponent('stash@{0}')}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.files, []);
    assert.strictEqual(body.diff, null);
    assert.strictEqual(body.error, null);
  });

  it('returns empty files (200) for a valid-shape but unknown stash ref', async () => {
    // stash@{999} matches ^stash@{\d+}$ but doesn't exist → git exits non-zero →
    // empty stdout → parseGitShowNameStatus([]) → graceful-empty, never a 500.
    const res = await fetch(`${baseUrl}/api/git-stash-show?id=warden-stashed&ref=${encodeURIComponent('stash@{999}')}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.files, []);
    assert.strictEqual(body.error, null);
  });

  // ---- per-file leg: a FAILING git command must say so (WARDEN-1192) ----------
  // The git-show twin of the same rule. The files leg above is a LIST and says "empty"
  // precisely by being empty, so it stays error:null. The per-file leg is a DIFF —
  // `diff: null` cannot mean "empty" — so a failure must be worded as an error string
  // (the /api/git-log carve-out rule). Before this, the leg discarded the exit status
  // and stamped error:null, so a broken repo was byte-identical on the wire to a clean
  // empty diff (WARDEN-89's false-empty disease).
  it('per-file leg surfaces a git failure as an error for a non-git cwd (200, not a false empty diff)', async () => {
    const res = await fetch(`${baseUrl}/api/git-stash-show?id=warden-nongit&ref=${encodeURIComponent('stash@{0}')}&path=${encodeURIComponent('wip.txt')}`);
    assert.strictEqual(res.status, 200); // still never a 500
    const body = await res.json();
    assert.strictEqual(body.diff, null, 'a failed diff must be null, not an empty string');
    assert.strictEqual(body.error, 'git stash diff failed');
    // Fixed literal, never r.stderr: both remote branches pipe 2>/dev/null, so a stderr
    // passthrough would be an EMPTY string here — which the client reader treats as
    // "no error", silently restoring the very bug this test pins.
    assert.ok(typeof body.error === 'string' && body.error.length > 0, 'error must be a non-empty string');
  });

  it('per-file leg surfaces an error for a valid-shape but unknown stash ref (deliberately diverges from the files leg)', async () => {
    // The same ref the files-leg test above asserts answers error:null. The two legs
    // ANSWER DIFFERENTLY on purpose: a list truthfully says "empty"; a diff cannot, so
    // it says "failed" rather than assert a clean empty diff for a stash that does not
    // exist. If this ever goes back to error:null, the false-empty bug is back.
    const res = await fetch(`${baseUrl}/api/git-stash-show?id=warden-stashed&ref=${encodeURIComponent('stash@{999}')}&path=${encodeURIComponent('wip.txt')}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.diff, null);
    assert.strictEqual(body.error, 'git stash diff failed');
  });

  it('preserves the BENIGN empty: a path not present in the stash stays { diff: "", error: null }', async () => {
    // committed.txt is in the repo but was NOT part of the stashed change, so
    // `git diff stash@{0}^ stash@{0} -- committed.txt` exits ZERO with empty stdout.
    // That is a genuinely unchanged file, NOT a failure — the r.ok gate must let it
    // through untouched, or the fix would over-correct and report healthy repos broken.
    const res = await fetch(`${baseUrl}/api/git-stash-show?id=warden-stashed&ref=${encodeURIComponent('stash@{0}')}&path=${encodeURIComponent('committed.txt')}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.diff, '', 'a successful-but-empty diff stays an empty STRING');
    assert.strictEqual(body.error, null, 'a benign empty must not be converted into an error');
  });

  it('returns 404 for an unknown chat id', async () => {
    const res = await fetch(`${baseUrl}/api/git-stash-show?id=does-not-exist&ref=${encodeURIComponent('stash@{0}')}`);
    assert.strictEqual(res.status, 404);
  });
});
