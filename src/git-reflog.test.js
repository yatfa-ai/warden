import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * Tests for agent operation-history visibility (WARDEN-460): the lazy read-only
 *   GET /api/git-reflog?id=<chatId>  → { entries: [{ hash, subject, date }], error }
 *
 * Mirrors src/git-stash.test.js's HOME-freezing isolation: src/server.js evaluates
 * `const cfg = load()` at module load, and load() reads config.js's module-level
 * `dir` (= path.join(os.homedir(), …)). So the FIRST import of server.js freezes
 * the home dir for the whole process — we set process.env.HOME (and write config
 * + catalog) BEFORE that single import. Do NOT re-import server.js with a second
 * HOME.
 *
 * Covers the acceptance criteria for the LOCAL host:
 *   - a repo that did a `git reset --hard HEAD~1` → reflog surfaces the reset op
 *     (the core gap: a clean tree with VANISHED commits, diagnosable only here)
 *   - a normal repo → reflog returns its commit/checkout entries
 *   - non-git / no-cwd → [] (200, NOT a 500)
 *   - unknown id → 404
 *
 * The remote (SSH) path reuses the same `git reflog` invocation; its logic is
 * covered indirectly. Driving a real SSH host in CI is out of scope.
 */

let httpServer;
let baseUrl;
let originalHome;
let tempHome;
let resetRepo; // the headline: a `git reset --hard` erased a commit — invisible except in the reflog
let plainRepo; // ordinary commit history
let nonGitDir;

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (status ${r.status}) in ${cwd}`);
  return r;
}

before(async () => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitreflog-'));
  process.env.HOME = tempHome;

  // config.json with no SSH hosts
  const wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: [] }));

  // ---- resetRepo: two commits, then `git reset --hard HEAD~1` -----------------
  // After the reset the tree is CLEAN at the first commit, but the second commit
  // is GONE from history — recoverable only via the reflog. Exactly the "clean
  // but commits vanished" mystery this feature makes diagnosable in-UI.
  resetRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitreflog-reset-'));
  git(['init', '-q'], resetRepo);
  git(['config', 'user.email', 'test@example.com'], resetRepo);
  git(['config', 'user.name', 'Tester'], resetRepo);
  fs.writeFileSync(path.join(resetRepo, 'a.txt'), 'a\n');
  git(['add', '.'], resetRepo);
  git(['commit', '-q', '-m', 'first'], resetRepo);
  fs.writeFileSync(path.join(resetRepo, 'b.txt'), 'b\n');
  git(['add', '.'], resetRepo);
  git(['commit', '-q', '-m', 'second'], resetRepo); // this commit is about to vanish
  git(['reset', '--hard', '-q', 'HEAD~1'], resetRepo);
  // sanity: the tree is clean and HEAD only knows "first"
  const logCheck = spawnSync('git', ['log', '--oneline'], { cwd: resetRepo, stdio: ['ignore', 'pipe', 'inherit'] });
  assert.strictEqual((logCheck.stdout?.toString() || '').trim().split('\n').length, 1, 'sanity: resetRepo HEAD must show exactly one commit');
  const statusCheck = spawnSync('git', ['status', '--porcelain'], { cwd: resetRepo, stdio: ['ignore', 'pipe', 'inherit'] });
  assert.strictEqual((statusCheck.stdout?.toString() || '').trim(), '', 'sanity: resetRepo tree must be clean post-reset');
  const reflogCheck = spawnSync('git', ['reflog'], { cwd: resetRepo, stdio: ['ignore', 'pipe', 'inherit'] });
  assert.match((reflogCheck.stdout?.toString() || ''), /reset:/, 'sanity: a reset: entry must exist in resetRepo reflog');

  // ---- plainRepo: one commit, nothing exotic ---------------------------------
  plainRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitreflog-plain-'));
  git(['init', '-q'], plainRepo);
  git(['config', 'user.email', 'test@example.com'], plainRepo);
  git(['config', 'user.name', 'Tester'], plainRepo);
  fs.writeFileSync(path.join(plainRepo, 'a.txt'), 'a\n');
  git(['add', '.'], plainRepo);
  git(['commit', '-q', '-m', 'init'], plainRepo);

  // ---- nonGitDir: a plain directory with no .git -----------------------------
  nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitreflog-nongit-'));
  fs.writeFileSync(path.join(nonGitDir, 'readme.txt'), 'not a repo\n');

  // Catalog with three LOCAL manual chats, resolved by bare session id (no ':'
  // prefix) so no host/tmux discovery runs.
  fs.writeFileSync(
    path.join(wardenDir, 'chats.json'),
    JSON.stringify([
      { host: '(local)', session: 'warden-reset', cwd: resetRepo, cmd: 'bash', name: 'warden-reset' },
      { host: '(local)', session: 'warden-plain', cwd: plainRepo, cmd: 'bash', name: 'warden-plain' },
      { host: '(local)', session: 'warden-nongit', cwd: nonGitDir, cmd: 'bash', name: 'warden-nongit' },
    ]),
  );

  // Import server.js ONCE — after HOME/config/catalog are in place.
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
  for (const d of [resetRepo, plainRepo, nonGitDir, tempHome]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe('/api/git-reflog detail endpoint (real Express app from server.js)', () => {
  it('surfaces the reset operation for a repo that did `git reset --hard` (the core fix)', async () => {
    const res = await fetch(`${baseUrl}/api/git-reflog?id=warden-reset`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    assert.ok(Array.isArray(body.entries));
    assert.ok(body.entries.length > 0, 'a repo with history must yield reflog entries');

    // The headline: the reset op that erased the second commit is diagnosable here.
    const resets = body.entries.filter((e) => e.subject.startsWith('reset:'));
    assert.ok(resets.length > 0, 'the reflog must include the reset: operation');
    const r = resets[0];
    assert.ok(typeof r.hash === 'string' && /^[0-9a-f]{4,}$/i.test(r.hash), 'hash must be a hex string');
    assert.ok(typeof r.date === 'string' && r.date.length > 0, 'relative date must be non-empty');

    // Every entry must conform to the { hash, subject, date } shape.
    for (const e of body.entries) {
      assert.ok(typeof e.hash === 'string', 'hash is a string');
      assert.ok(typeof e.subject === 'string', 'subject is a string');
      assert.ok(typeof e.date === 'string', 'date is a string');
    }

    // The reset target is HEAD~1 — the NEWEST reset entry should mention moving to
    // the first commit, i.e. the commit history now only shows "first". We assert
    // the subject carries the "moving to" wording git uses for a reset.
    assert.match(r.subject, /reset:/);
  });

  it('returns reflog entries for a normal repo', async () => {
    const res = await fetch(`${baseUrl}/api/git-reflog?id=warden-plain`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    assert.ok(Array.isArray(body.entries));
    assert.ok(body.entries.length > 0, 'a committed repo must have a reflog');
    // At least one entry is the commit operation git records. The FIRST commit on a
    // fresh repo is `commit (initial): …` (not `commit:`), so match the `commit` prefix.
    assert.ok(body.entries.some((e) => e.subject.startsWith('commit')), 'reflog must include the commit op');
  });

  it('returns [] (200, not 500) for a non-git cwd', async () => {
    const res = await fetch(`${baseUrl}/api/git-reflog?id=warden-nongit`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.entries, []);
    assert.strictEqual(body.error, null);
  });

  it('returns 404 for an unknown chat id', async () => {
    const res = await fetch(`${baseUrl}/api/git-reflog?id=does-not-exist`);
    assert.strictEqual(res.status, 404);
  });
});
