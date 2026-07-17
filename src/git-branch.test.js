import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * Tests for local-branch-topology visibility (WARDEN-577): the lazy read-only
 *   GET /api/git-branch?id=<chatId>
 *     → { branches: [{ name, current, headSha, headDate, upstream, ahead, behind, gone, merged }], error }
 *
 * Mirrors src/git-stash.test.js / src/git-reflog.test.js's HOME-freezing isolation:
 * src/server.js evaluates `const cfg = load()` at module load, and load() reads
 * config.js's module-level `dir` (= path.join(os.homedir(), …)). So the FIRST import
 * of server.js freezes the home dir for the whole process — we set process.env.HOME
 * (and write config + catalog) BEFORE that single import. Do NOT re-import server.js
 * with a second HOME.
 *
 * Covers the acceptance criteria for the LOCAL host:
 *   - a repo with several branches → current flagged, merged/not-merged distinguishable
 *     (the core value: spot a stranded branch carrying commits that never landed),
 *     upstream/ahead parsed from %(upstream:track)
 *   - a branch tracking a remote → upstream populated + ahead parsed end-to-end
 *   - non-git / no-cwd → [] (200, NOT a 500)
 *   - unknown id → 404
 *
 * The ahead/behind/gone track parsing is unit-tested exhaustively in
 * gitStatus.test.js (parseGitBranches); this file drives the full route — transport,
 * graceful-[]/never-500 shape, and the current/merged stamping that lives in the
 * route (needs HEAD + the --merged set the parser doesn't see). The remote (SSH)
 * path reuses the same `git for-each-ref` invocation; its logic is covered
 * indirectly. Driving a real SSH host in CI is out of scope.
 */

let httpServer;
let baseUrl;
let originalHome;
let tempHome;
let multiRepo; // several branches: current(main) + merged-topic + not-merged(stranded)
let aheadRepo; // tracks a bare origin and is 1 commit ahead — exercises upstream + track parsing
let nonGitDir;

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (status ${r.status}) in ${cwd}`);
  return r;
}

before(async () => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitbranch-'));
  process.env.HOME = tempHome;

  // config.json with no SSH hosts
  const wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: [] }));

  // ---- multiRepo: three branches with distinct merged-into-HEAD states -------
  // current=main (merged, trivially), merged-topic (merged into main), stranded
  // (NOT merged — its "stray work" commit never landed on main). This is the
  // headline: a human can tell a stranded branch from a merged one without a
  // terminal.
  multiRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitbranch-multi-'));
  git(['init', '-q'], multiRepo);
  git(['config', 'user.email', 'test@example.com'], multiRepo);
  git(['config', 'user.name', 'Tester'], multiRepo);
  fs.writeFileSync(path.join(multiRepo, 'a.txt'), 'a\n');
  git(['add', '.'], multiRepo);
  git(['commit', '-q', '-m', 'init'], multiRepo);
  git(['branch', '-M', 'main'], multiRepo); // normalize the default branch name
  git(['checkout', '-q', '-b', 'merged-topic'], multiRepo);
  fs.writeFileSync(path.join(multiRepo, 't.txt'), 't\n');
  git(['add', '.'], multiRepo);
  git(['commit', '-q', '-m', 'topic fix'], multiRepo);
  git(['checkout', '-q', 'main'], multiRepo);
  git(['merge', '-q', '--no-ff', 'merged-topic', '-m', 'merge topic'], multiRepo);
  git(['checkout', '-q', '-b', 'stranded'], multiRepo);
  fs.writeFileSync(path.join(multiRepo, 's.txt'), 's\n');
  git(['add', '.'], multiRepo);
  git(['commit', '-q', '-m', 'stray work'], multiRepo);
  git(['checkout', '-q', 'main'], multiRepo); // land on main so current === main
  // sanity: stranded is NOT in the --merged set (its commit never landed on main)
  const mergedCheck = spawnSync('git', ['for-each-ref', '--merged', 'HEAD', '--format=%(refname:short)', 'refs/heads/'], { cwd: multiRepo, stdio: ['ignore', 'pipe', 'inherit'] });
  const mergedNames = (mergedCheck.stdout?.toString() || '').split('\n').filter(Boolean);
  assert.ok(mergedNames.includes('main') && mergedNames.includes('merged-topic'), 'sanity: main + merged-topic must be merged into HEAD');
  assert.ok(!mergedNames.includes('stranded'), 'sanity: stranded must NOT be merged into HEAD');

  // ---- aheadRepo: tracks a bare origin and is 1 commit ahead -----------------
  // Exercises the upstream field + %(upstream:track) → ahead parsing through the
  // full route (a branch with NO remote, like multiRepo's, has upstream:'' and
  // track:'' — this one proves a tracked branch carries origin/main + [ahead 1]).
  const originDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitbranch-origin-'));
  git(['init', '-q', '--bare'], originDir);
  aheadRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitbranch-ahead-'));
  git(['init', '-q'], aheadRepo);
  git(['config', 'user.email', 'test@example.com'], aheadRepo);
  git(['config', 'user.name', 'Tester'], aheadRepo);
  fs.writeFileSync(path.join(aheadRepo, 'a.txt'), 'a\n');
  git(['add', '.'], aheadRepo);
  git(['commit', '-q', '-m', 'init'], aheadRepo);
  git(['branch', '-M', 'main'], aheadRepo);
  git(['remote', 'add', 'origin', originDir], aheadRepo);
  git(['push', '-q', '-u', 'origin', 'main'], aheadRepo);
  // a local commit the remote doesn't have → ahead 1
  fs.writeFileSync(path.join(aheadRepo, 'b.txt'), 'b\n');
  git(['add', '.'], aheadRepo);
  git(['commit', '-q', '-m', 'ahead commit'], aheadRepo);
  const trackCheck = spawnSync('git', ['for-each-ref', '--format=%(upstream:short)|%(upstream:track)', 'refs/heads/main'], { cwd: aheadRepo, stdio: ['ignore', 'pipe', 'inherit'] });
  assert.match((trackCheck.stdout?.toString() || ''), /\[ahead 1\]/, 'sanity: aheadRepo main must track [ahead 1]');

  // ---- nonGitDir: a plain directory with no .git -----------------------------
  nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitbranch-nongit-'));
  fs.writeFileSync(path.join(nonGitDir, 'readme.txt'), 'not a repo\n');

  // Catalog with three LOCAL manual chats, resolved by bare session id (no ':'
  // prefix) so no host/tmux discovery runs.
  fs.writeFileSync(
    path.join(wardenDir, 'chats.json'),
    JSON.stringify([
      { host: '(local)', session: 'warden-multi', cwd: multiRepo, cmd: 'bash', name: 'warden-multi' },
      { host: '(local)', session: 'warden-ahead', cwd: aheadRepo, cmd: 'bash', name: 'warden-ahead' },
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
  for (const d of [multiRepo, aheadRepo, nonGitDir, tempHome]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe('/api/git-branch endpoint (real Express app from server.js)', () => {
  it('lists every local branch with the current one flagged', async () => {
    const res = await fetch(`${baseUrl}/api/git-branch?id=warden-multi`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    assert.ok(Array.isArray(body.branches));
    assert.strictEqual(body.branches.length, 3, 'multiRepo has main + merged-topic + stranded');

    const byName = Object.fromEntries(body.branches.map((b) => [b.name, b]));

    // main is current and (trivially) merged; no remote → upstream ''.
    const main = byName['main'];
    assert.ok(main, 'main branch present');
    assert.strictEqual(main.current, true, 'main is the current branch');
    assert.strictEqual(main.merged, true, 'main is merged into HEAD');
    assert.strictEqual(main.upstream, '', 'multiRepo has no remote → empty upstream');
    assert.strictEqual(main.ahead, 0);
    assert.strictEqual(main.behind, 0);
    assert.strictEqual(main.gone, false);
    assert.ok(typeof main.headSha === 'string' && /^[0-9a-f]{4,}$/i.test(main.headSha), 'headSha is a short hex string');
    assert.ok(typeof main.headDate === 'string' && main.headDate.includes('T'), 'headDate is a strict ISO string (has the T separator)');

    // merged-topic is merged but NOT current.
    const topic = byName['merged-topic'];
    assert.ok(topic, 'merged-topic present');
    assert.strictEqual(topic.current, false);
    assert.strictEqual(topic.merged, true, 'merged-topic is merged into HEAD');

    // stranded is the headline: NOT merged (commits never landed on main).
    const stranded = byName['stranded'];
    assert.ok(stranded, 'stranded present');
    assert.strictEqual(stranded.current, false);
    assert.strictEqual(stranded.merged, false, 'stranded is NOT merged — the stranded-work signal');

    // Exactly one branch is flagged current.
    assert.strictEqual(body.branches.filter((b) => b.current).length, 1, 'exactly one current branch');
  });

  it('parses upstream + ahead from %(upstream:track) for a branch tracking a remote', async () => {
    const res = await fetch(`${baseUrl}/api/git-branch?id=warden-ahead`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    const main = body.branches.find((b) => b.name === 'main');
    assert.ok(main, 'aheadRepo has main');
    assert.strictEqual(main.current, true);
    assert.strictEqual(main.upstream, 'origin/main', 'upstream resolved from upstream:short');
    assert.strictEqual(main.ahead, 1, 'ahead parsed from [ahead 1] track token');
    assert.strictEqual(main.behind, 0);
    assert.strictEqual(main.gone, false);
  });

  it('returns [] (200, not 500) for a non-git cwd', async () => {
    const res = await fetch(`${baseUrl}/api/git-branch?id=warden-nongit`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.branches, []);
    assert.strictEqual(body.error, null);
  });

  it('returns 404 for an unknown chat id', async () => {
    const res = await fetch(`${baseUrl}/api/git-branch?id=does-not-exist`);
    assert.strictEqual(res.status, 404);
  });
});
