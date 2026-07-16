import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * Tests for the recent-commit-history (git log) feature (WARDEN-122).
 *
 * Two layers, sharing ONE file-level before():
 *
 *  1. parseGitLogLine — pure unit tests for the `%h|%s|%an|%ar` line parser. The
 *     separator is '|' which is also legal inside a commit subject ("merge a | b"),
 *     so this is the trickiest logic and where bugs hide. Covers: normal line,
 *     pipe-in-subject, multiple pipes in subject, empty subject, missing author/date.
 *
 *  2. /api/git-log — HTTP integration tests against the REAL Express app from
 *     src/server.js. We seed a throwaway HOME + a chats.json catalog entry whose
 *     `cwd` is a temp git repo (with one subject containing a '|'), and resolve it
 *     by bare session id so no host/tmux discovery runs. Covers the success criteria:
 *       - local git repo → parsed commits [{hash, subject, author, date}]
 *       - non-git cwd → { commits: [], error: null } (200, NOT a 500)
 *       - limit clamped to [1, 50] (limit=999 and limit=abc both behave)
 *       - unknown id → 404
 *
 * NOTE on the single before(): src/server.js evaluates `const cfg = load()` at module
 * load, and load() reads config.js's module-level `dir` (= path.join(os.homedir(), …)).
 * So the FIRST import of server.js freezes the home dir for the whole process. We must
 * set process.env.HOME (and write config + catalog + repo) BEFORE that first import —
 * doing it once at the file level guarantees both describe blocks see the temp HOME.
 */

// The three commits in gitRepo (newest first when listed). The middle one has a
// literal '|' in its subject to exercise the parser end-to-end over the wire.
const SUBJECTS = ['third commit', 'fix: handle the | pipe in subject', 'first commit'];

// Commits used to build the "behind" fixture (WARDEN-225): all four are committed,
// ALL pushed to a bare origin (so @{u} sits at the tip), then HEAD is reset back
// two. The two dropped commits are exactly what `git log HEAD..@{u}` must surface.
// Oldest-first here; the expected endpoint order is newest-first (bottom→top).
const BEHIND_SUBJECTS = ['base one', 'base two', 'incoming: add feature X', 'incoming: fix bug Y'];

// Commits used to build the "ahead" fixture (WARDEN-252): a base commit is pushed to
// a bare origin (so @{u} sits at the base), then two MORE local commits are added but
// NOT pushed. Those two unpushed commits are exactly what `git log @{u}..HEAD` must
// surface. Oldest-first here; the expected endpoint order is newest-first (bottom→top).
const AHEAD_BASE_SUBJECT = 'base: shared with upstream';
const AHEAD_SUBJECTS = ['outgoing: add feature Z', 'outgoing: fix bug W'];

// Commits used to build the grep fixture (WARDEN-498): each carries an optional BODY
// so commit-MESSAGE search can be exercised on subject AND body — the only way to
// prove `git log --grep` matches the full message (the headline behavior). Oldest-first
// here; the expected endpoint order is newest-first (bottom→top). 'login' appears in a
// subject (feat) AND only in a body (fix) — that split is what distinguishes a real
// full-message match from a subject-only match.
const GREP_SUBJECTS = [
  { subject: 'feat: add login', body: 'implements the auth flow\nneeds review' },
  { subject: 'docs: readme', body: '' },
  { subject: 'fix: flaky test', body: 'the timer race in login was the cause' },
  { subject: 'chore: bump deps', body: '' },
];

// Commits used to build the pickaxe fixture (WARDEN-559): `git log -S`/`-G` finds the
// commit that ADDED or REMOVED a code string. The whole point is distinguishing `-S`
// (occurrence-COUNT change) from `-G` (diff-TEXT regex match), so this fixture is built
// around the ONE commit that tells them apart: the middle "change value" commit rewrites
// `billingTotal = 1` → `billingTotal = 2` — the term STAYS at one occurrence (so `-S`
// skips it) but the diff text still contains `billingTotal` (so `-G` lists it). All
// three touch the SAME file (billing.js) so add → modify-in-place → remove semantics are
// real, and so a path+pickaxe composition can be exercised on it. Oldest-first here;
// the expected endpoint order is newest-first (bottom→top).
const PICKAXE_TERM = 'billingTotal';
const PICKAXE_FILE = 'billing.js';
const PICKAXE_STEPS = [
  { subject: 'feat: add billingTotal', content: 'billingTotal = 1;\n' },     // count 0→1  (-S ✓, -G ✓)
  { subject: 'fix: change billingTotal value', content: 'billingTotal = 2;\n' }, // count 1→1 (-S ✗, -G ✓)
  { subject: 'refactor: remove billingTotal', content: 'total = 2;\n' },     // count 1→0  (-S ✓, -G ✓)
];

// Commits used to build the pickaxe AHEAD fixture (WARDEN-559): proves pickaxe composes
// with range=outgoing (@{u}..HEAD). A base is pushed to a bare origin (→ @{u} at base),
// then two MORE local commits add distinct terms — only the one matching the pickaxe AND
// sitting in the outgoing set must surface. Oldest-first here.
const PICKAXE_AHEAD_BASE = 'base: shared with upstream';
const PICKAXE_AHEAD_STEPS = [
  { subject: 'outgoing: add billingTotal', file: 'out.js', content: 'billingTotal = 7;\n' },
  { subject: 'outgoing: add helperTotal', file: 'out2.js', content: 'helperTotal = 6;\n' },
];

let parseGitLogLine;
let httpServer;
let baseUrl;
let originalHome;
let tempHome;
let gitRepo;
let nonGitDir;
let behindRepo;
let bareOrigin;
let aheadRepo;
let bareOriginAhead;
let renameRepo;
let grepRepo;
let pickaxeRepo;
let pickaxeAheadRepo;
let bareOriginPickaxe;

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (status ${r.status}) in ${cwd}`);
  return r;
}

before(async () => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitlog-'));
  process.env.HOME = tempHome;

  // config.json with no SSH hosts
  const wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: [] }));

  // Build a real git repo with 3 commits (oldest first so SUBJECTS order == newest-first)
  gitRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitlog-repo-'));
  git(['init', '-q'], gitRepo);
  git(['config', 'user.email', 'test@example.com'], gitRepo);
  git(['config', 'user.name', 'Tester'], gitRepo);
  SUBJECTS.slice().reverse().forEach((subject, i) => {
    fs.writeFileSync(path.join(gitRepo, `f${i}.txt`), `${i}\n`);
    git(['add', '.'], gitRepo);
    git(['commit', '-q', '-m', subject], gitRepo);
  });

  // A plain non-git directory
  nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitlog-nongit-'));
  fs.writeFileSync(path.join(nonGitDir, 'readme.txt'), 'not a repo\n');

  // A repo whose upstream (@{u}) is AHEAD of HEAD — the "behind" case (WARDEN-225).
  // Commit all four subjects, push them ALL to a bare origin (→ @{u} at the tip),
  // then reset HEAD back two commits. HEAD is now behind @{u} by exactly the last
  // two commits — those are what `git log HEAD..@{u}` must list.
  behindRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitlog-behind-'));
  git(['init', '-q'], behindRepo);
  git(['config', 'user.email', 'test@example.com'], behindRepo);
  git(['config', 'user.name', 'Tester'], behindRepo);
  BEHIND_SUBJECTS.forEach((subject, i) => {
    fs.writeFileSync(path.join(behindRepo, `b${i}.txt`), `${i}\n`);
    git(['add', '.'], behindRepo);
    git(['commit', '-q', '-m', subject], behindRepo);
  });
  bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitlog-bare-'));
  git(['init', '--bare', '-q'], bareOrigin);
  git(['remote', 'add', 'origin', bareOrigin], behindRepo);
  // -u sets upstream tracking so @{u} resolves; pushing HEAD is branch-name
  // agnostic (robust to a master/main default).
  git(['push', '-u', 'origin', 'HEAD'], behindRepo);
  // Drop the last two commits locally → HEAD is behind @{u} by exactly those two.
  git(['reset', '--hard', 'HEAD~2'], behindRepo);

  // A repo whose HEAD is AHEAD of @{u} — the "ahead/unpushed" case (WARDEN-252).
  // Commit a base, push it to a bare origin (→ @{u} at the base tip), then add two
  // MORE local commits NOT pushed. HEAD is now ahead of @{u} by exactly those two —
  // they are what `git log @{u}..HEAD` must list.
  aheadRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitlog-ahead-'));
  git(['init', '-q'], aheadRepo);
  git(['config', 'user.email', 'test@example.com'], aheadRepo);
  git(['config', 'user.name', 'Tester'], aheadRepo);
  // Base commit, pushed — @{u} will sit here.
  fs.writeFileSync(path.join(aheadRepo, 'base.txt'), '0\n');
  git(['add', '.'], aheadRepo);
  git(['commit', '-q', '-m', AHEAD_BASE_SUBJECT], aheadRepo);
  bareOriginAhead = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitlog-bare-ahead-'));
  git(['init', '--bare', '-q'], bareOriginAhead);
  git(['remote', 'add', 'origin', bareOriginAhead], aheadRepo);
  // -u sets upstream tracking so @{u} resolves; pushing HEAD is branch-name
  // agnostic (robust to a master/main default).
  git(['push', '-u', 'origin', 'HEAD'], aheadRepo);
  // Two more local commits, NOT pushed → HEAD is ahead of @{u} by exactly these two.
  AHEAD_SUBJECTS.forEach((subject, i) => {
    fs.writeFileSync(path.join(aheadRepo, `a${i}.txt`), `${i + 1}\n`);
    git(['add', '.'], aheadRepo);
    git(['commit', '-q', '-m', subject], aheadRepo);
  });

  // A repo with a file renamed across commits (WARDEN-319 --follow fixture): a.txt is
  // created in one commit, then `git mv`'d to b.txt in the next. `git log --follow --
  // b.txt` must surface BOTH commits (the rename AND the original creation under the
  // old name) — that cross-rename reach is the whole point of --follow, and what this
  // fixture proves is live (without --follow, b.txt's log would show only the rename).
  renameRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitlog-rename-'));
  git(['init', '-q'], renameRepo);
  git(['config', 'user.email', 'test@example.com'], renameRepo);
  git(['config', 'user.name', 'Tester'], renameRepo);
  fs.writeFileSync(path.join(renameRepo, 'a.txt'), '1\n');
  git(['add', '.'], renameRepo);
  git(['commit', '-q', '-m', 'create a.txt'], renameRepo);
  git(['mv', 'a.txt', 'b.txt'], renameRepo);
  git(['commit', '-q', '-m', 'rename a.txt to b.txt'], renameRepo);

  // A repo whose commits carry BODIES (WARDEN-498): commit-message search must match
  // the full message (subject + body), so this fixture is what lets a test PROVE a body-
  // only match. Newest-first when listed (bottom→top) == the GREP_SUBJECTS array reversed.
  grepRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitlog-grep-'));
  git(['init', '-q'], grepRepo);
  git(['config', 'user.email', 'test@example.com'], grepRepo);
  git(['config', 'user.name', 'Tester'], grepRepo);
  GREP_SUBJECTS.forEach((c, i) => {
    fs.writeFileSync(path.join(grepRepo, `g${i}.txt`), `${i}\n`);
    git(['add', '.'], grepRepo);
    // -m subject -m body → git composes a multi-paragraph message (subject + blank +
    // body); the body paragraph is what --grep must reach into.
    const args = ['commit', '-q', '-m', c.subject];
    if (c.body) args.push('-m', c.body);
    git(args, grepRepo);
  });

  // A repo built around ONE file rewritten across three commits (WARDEN-559): add the
  // term, modify-in-place (count unchanged — the -S/-G wedge), then remove it. This is
  // the fixture that lets a test PROVE `-S` (count change) and `-G` (diff-text match)
  // behave differently on the very same history.
  pickaxeRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitlog-pickaxe-'));
  git(['init', '-q'], pickaxeRepo);
  git(['config', 'user.email', 'test@example.com'], pickaxeRepo);
  git(['config', 'user.name', 'Tester'], pickaxeRepo);
  PICKAXE_STEPS.forEach((c) => {
    fs.writeFileSync(path.join(pickaxeRepo, PICKAXE_FILE), c.content);
    git(['add', PICKAXE_FILE], pickaxeRepo);
    git(['commit', '-q', '-m', c.subject], pickaxeRepo);
  });

  // A repo whose HEAD is AHEAD of @{u} with two DISTINCT terms added in the outgoing
  // commits (WARDEN-559): proves pickaxe composes with range=outgoing — only the
  // outgoing commit that ALSO matches the pickaxe term must surface. Mirrors aheadRepo's
  // base-then-push-then-commit-locally construction.
  pickaxeAheadRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitlog-pickaxe-ahead-'));
  git(['init', '-q'], pickaxeAheadRepo);
  git(['config', 'user.email', 'test@example.com'], pickaxeAheadRepo);
  git(['config', 'user.name', 'Tester'], pickaxeAheadRepo);
  fs.writeFileSync(path.join(pickaxeAheadRepo, 'pkg.js'), 'const base = 0;\n');
  git(['add', '.'], pickaxeAheadRepo);
  git(['commit', '-q', '-m', PICKAXE_AHEAD_BASE], pickaxeAheadRepo);
  bareOriginPickaxe = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitlog-bare-pickaxe-'));
  git(['init', '--bare', '-q'], bareOriginPickaxe);
  git(['remote', 'add', 'origin', bareOriginPickaxe], pickaxeAheadRepo);
  git(['push', '-u', 'origin', 'HEAD'], pickaxeAheadRepo);
  // Two more local commits, NOT pushed → HEAD is ahead of @{u} by exactly these two.
  PICKAXE_AHEAD_STEPS.forEach((c) => {
    fs.writeFileSync(path.join(pickaxeAheadRepo, c.file), c.content);
    git(['add', c.file], pickaxeAheadRepo);
    git(['commit', '-q', '-m', c.subject], pickaxeAheadRepo);
  });

  // Catalog with LOCAL manual chats: the git repo, the non-git dir, the behind repo,
  // and the ahead repo. Resolved by bare session id (no ':' prefix) → no host/tmux
  // discovery runs.
  fs.writeFileSync(
    path.join(wardenDir, 'chats.json'),
    JSON.stringify([
      { host: '(local)', session: 'warden-gitlog', cwd: gitRepo, cmd: 'bash', name: 'warden-gitlog' },
      { host: '(local)', session: 'warden-nongit', cwd: nonGitDir, cmd: 'bash', name: 'warden-nongit' },
      { host: '(local)', session: 'warden-behind', cwd: behindRepo, cmd: 'bash', name: 'warden-behind' },
      { host: '(local)', session: 'warden-ahead', cwd: aheadRepo, cmd: 'bash', name: 'warden-ahead' },
      { host: '(local)', session: 'warden-rename', cwd: renameRepo, cmd: 'bash', name: 'warden-rename' },
      { host: '(local)', session: 'warden-grep', cwd: grepRepo, cmd: 'bash', name: 'warden-grep' },
      { host: '(local)', session: 'warden-pickaxe', cwd: pickaxeRepo, cmd: 'bash', name: 'warden-pickaxe' },
      { host: '(local)', session: 'warden-pickaxe-ahead', cwd: pickaxeAheadRepo, cmd: 'bash', name: 'warden-pickaxe-ahead' },
    ]),
  );

  // Import server.js ONCE — after HOME/config/catalog are in place.
  const server = await import('./server.js');
  parseGitLogLine = server.parseGitLogLine;
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
  for (const d of [gitRepo, nonGitDir, behindRepo, bareOrigin, aheadRepo, bareOriginAhead, renameRepo, grepRepo, pickaxeRepo, pickaxeAheadRepo, bareOriginPickaxe, tempHome]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe('parseGitLogLine', () => {
  it('parses a normal %h|%s|%an|%ar|%ct line (epoch is the trailing UNIX seconds)', () => {
    assert.deepStrictEqual(parseGitLogLine('abc1234|fix: thing|John Doe|2 days ago|1700000000'), {
      hash: 'abc1234', subject: 'fix: thing', author: 'John Doe', date: '2 days ago', epoch: 1700000000,
    });
  });

  it('keeps a literal "|" inside the subject', () => {
    const out = parseGitLogLine('def5678|fix: handle a | b in subject|Jane|3 hours ago|1700000001');
    assert.strictEqual(out.hash, 'def5678');
    assert.strictEqual(out.subject, 'fix: handle a | b in subject');
    assert.strictEqual(out.author, 'Jane');
    assert.strictEqual(out.date, '3 hours ago');
    assert.strictEqual(out.epoch, 1700000001);
  });

  it('handles multiple "|" inside the subject', () => {
    const out = parseGitLogLine('bbb2222|merge feat | fix | docs|Sam|5 minutes ago|1700000002');
    assert.strictEqual(out.subject, 'merge feat | fix | docs');
    assert.strictEqual(out.author, 'Sam');
    assert.strictEqual(out.date, '5 minutes ago');
    assert.strictEqual(out.epoch, 1700000002);
  });

  it('handles an empty subject (%s is empty)', () => {
    assert.deepStrictEqual(parseGitLogLine('aaa1111||Bob|1 day ago|1700000003'), {
      hash: 'aaa1111', subject: '', author: 'Bob', date: '1 day ago', epoch: 1700000003,
    });
  });

  it('handles a malformed line with no author/date/epoch separators', () => {
    assert.deepStrictEqual(parseGitLogLine('xyz9999|just a subject no author/date'), {
      hash: 'xyz9999', subject: 'just a subject no author/date', author: '', date: '', epoch: null,
    });
  });

  it('handles a line with no separators at all', () => {
    assert.deepStrictEqual(parseGitLogLine('lonelyhash'), {
      hash: 'lonelyhash', subject: '', author: '', date: '', epoch: null,
    });
  });

  it('returns epoch null when the trailing field is non-numeric (degraded)', () => {
    // A partial/legacy line that somehow lacks a real %ct — epoch must be null,
    // never NaN, so the frontend's numeric since-filter degrades safely.
    const out = parseGitLogLine('ccc3333|fix: thing|Jane|2 days ago|not-a-number');
    assert.strictEqual(out.subject, 'fix: thing');
    assert.strictEqual(out.author, 'Jane');
    assert.strictEqual(out.date, '2 days ago');
    assert.strictEqual(out.epoch, null);
  });
});

describe('/api/git-log HTTP endpoint (real Express app from server.js)', () => {
  it('returns parsed commits for a local git repo (newest first)', async () => {
    const res = await fetch(`${baseUrl}/api/git-log?id=warden-gitlog`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    assert.ok(Array.isArray(body.commits));
    assert.strictEqual(body.commits.length, 3);
    assert.strictEqual(body.commits[0].subject, 'third commit');
    assert.strictEqual(body.commits[2].subject, 'first commit');
    for (const c of body.commits) {
      assert.match(c.hash, /^[0-9a-f]{4,}$/);
      assert.ok(typeof c.date === 'string' && c.date.length > 0, 'relative date must be non-empty');
      assert.strictEqual(c.author, 'Tester');
      // WARDEN-356: every real commit carries an exact %ct epoch (UNIX seconds) — a
      // positive integer, NOT a string, so the frontend's since-filter compares numerically.
      assert.ok(typeof c.epoch === 'number' && c.epoch > 0, 'epoch (%ct) must be a positive number');
    }
  });

  it('preserves a literal "|" inside a commit subject over the wire', async () => {
    const body = await (await fetch(`${baseUrl}/api/git-log?id=warden-gitlog`)).json();
    const pipeCommit = body.commits.find((c) => c.subject.includes('|'));
    assert.ok(pipeCommit, 'expected a commit whose subject contains "|"');
    assert.strictEqual(pipeCommit.subject, 'fix: handle the | pipe in subject');
    assert.strictEqual(pipeCommit.author, 'Tester');
  });

  it('honors limit (returns only the N newest)', async () => {
    const body = await (await fetch(`${baseUrl}/api/git-log?id=warden-gitlog&limit=1`)).json();
    assert.strictEqual(body.commits.length, 1);
    assert.strictEqual(body.commits[0].subject, 'third commit');
  });

  it('clamps an oversized limit to 50 and returns all available commits', async () => {
    const body = await (await fetch(`${baseUrl}/api/git-log?id=warden-gitlog&limit=999`)).json();
    assert.strictEqual(body.commits.length, 3); // repo only has 3, no error
  });

  it('falls back to the default limit on a non-numeric limit', async () => {
    const body = await (await fetch(`${baseUrl}/api/git-log?id=warden-gitlog&limit=abc`)).json();
    assert.strictEqual(body.commits.length, 3);
  });

  it('returns { commits: [], error: null } (200, not 500) for a non-git cwd', async () => {
    const res = await fetch(`${baseUrl}/api/git-log?id=warden-nongit`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.commits, []);
    assert.strictEqual(body.error, null);
  });

  it('returns 404 for an unknown chat id', async () => {
    const res = await fetch(`${baseUrl}/api/git-log?id=does-not-exist`);
    assert.strictEqual(res.status, 404);
  });
});

describe('/api/git-log range=incoming (behind commits — WARDEN-225)', () => {
  it('sanity: the behind fixture is actually 2 behind, 0 ahead', () => {
    // Confirms the fixture is in the state the cases below assume: @{u} ahead of
    // HEAD by exactly two. `rev-list --left-right --count @{u}...HEAD` → "behind\tahead".
    const ab = git(['rev-list', '--left-right', '--count', '@{u}...HEAD'], behindRepo)
      .stdout.toString().trim();
    assert.strictEqual(ab, '2\t0', `expected "2\\t0" (behind=2, ahead=0), got "${ab}"`);
  });

  it('returns exactly the incoming commits (newest first) with range=incoming', async () => {
    const res = await fetch(`${baseUrl}/api/git-log?id=warden-behind&range=incoming`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    assert.ok(Array.isArray(body.commits));
    assert.strictEqual(body.commits.length, 2);
    // Newest first: the two commits @{u} has that HEAD doesn't.
    assert.strictEqual(body.commits[0].subject, 'incoming: fix bug Y');
    assert.strictEqual(body.commits[1].subject, 'incoming: add feature X');
    for (const c of body.commits) {
      assert.match(c.hash, /^[0-9a-f]{4,}$/);
      assert.strictEqual(c.author, 'Tester');
      assert.ok(typeof c.date === 'string' && c.date.length > 0, 'relative date must be non-empty');
      assert.ok(typeof c.epoch === 'number' && c.epoch > 0, 'epoch (%ct) must be a positive number');
    }
  });

  it('without range=incoming, the same repo returns HEAD-reachable commits (unchanged)', async () => {
    // Absent range keeps today's behavior: HEAD is at 'base two', so the two
    // HEAD-reachable commits are base two + base one — NOT the incoming ones.
    const body = await (await fetch(`${baseUrl}/api/git-log?id=warden-behind`)).json();
    assert.strictEqual(body.commits.length, 2);
    assert.strictEqual(body.commits[0].subject, 'base two');
    assert.strictEqual(body.commits[1].subject, 'base one');
  });

  it('honors limit on the incoming range (returns only the N newest incoming)', async () => {
    const body = await (await fetch(`${baseUrl}/api/git-log?id=warden-behind&range=incoming&limit=1`)).json();
    assert.strictEqual(body.commits.length, 1);
    assert.strictEqual(body.commits[0].subject, 'incoming: fix bug Y');
  });

  it('clamps an oversized limit to 50 on the incoming range (no error)', async () => {
    const body = await (await fetch(`${baseUrl}/api/git-log?id=warden-behind&range=incoming&limit=999`)).json();
    assert.strictEqual(body.commits.length, 2); // only 2 incoming exist
    assert.strictEqual(body.error, null);
  });

  it('returns { commits: [], error: null } (200, not 500) when there is no upstream', async () => {
    // gitRepo has commits but NO upstream configured → @{u} is unset → git exits
    // non-zero with empty stdout → empty list. Mirrors parseAheadBehind's null
    // tolerance; the badge must never see a 500 here.
    const res = await fetch(`${baseUrl}/api/git-log?id=warden-gitlog&range=incoming`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.commits, []);
    assert.strictEqual(body.error, null);
  });
});

describe('/api/git-log range=outgoing (ahead commits — WARDEN-252)', () => {
  it('sanity: the ahead fixture is actually 2 ahead, 0 behind', () => {
    // Confirms the fixture is in the state the cases below assume: @{u} behind HEAD
    // by exactly two. `rev-list --left-right --count @{u}...HEAD` → "behind\tahead".
    const ab = git(['rev-list', '--left-right', '--count', '@{u}...HEAD'], aheadRepo)
      .stdout.toString().trim();
    assert.strictEqual(ab, '0\t2', `expected "0\\t2" (behind=0, ahead=2), got "${ab}"`);
  });

  it('returns exactly the outgoing commits (newest first) with range=outgoing', async () => {
    const res = await fetch(`${baseUrl}/api/git-log?id=warden-ahead&range=outgoing`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    assert.ok(Array.isArray(body.commits));
    assert.strictEqual(body.commits.length, 2);
    // Newest first: the two commits HEAD has that @{u} doesn't (the unpushed ones).
    assert.strictEqual(body.commits[0].subject, 'outgoing: fix bug W');
    assert.strictEqual(body.commits[1].subject, 'outgoing: add feature Z');
    for (const c of body.commits) {
      assert.match(c.hash, /^[0-9a-f]{4,}$/);
      assert.strictEqual(c.author, 'Tester');
      assert.ok(typeof c.date === 'string' && c.date.length > 0, 'relative date must be non-empty');
      assert.ok(typeof c.epoch === 'number' && c.epoch > 0, 'epoch (%ct) must be a positive number');
    }
  });

  it('without range=outgoing, the same repo returns HEAD-reachable commits (unchanged)', async () => {
    // Absent range keeps today's behavior: HEAD-reachable = base + the two outgoing.
    const body = await (await fetch(`${baseUrl}/api/git-log?id=warden-ahead`)).json();
    assert.strictEqual(body.commits.length, 3);
    assert.strictEqual(body.commits[0].subject, 'outgoing: fix bug W');
    assert.strictEqual(body.commits[1].subject, 'outgoing: add feature Z');
    assert.strictEqual(body.commits[2].subject, 'base: shared with upstream');
  });

  it('honors limit on the outgoing range (returns only the N newest outgoing)', async () => {
    const body = await (await fetch(`${baseUrl}/api/git-log?id=warden-ahead&range=outgoing&limit=1`)).json();
    assert.strictEqual(body.commits.length, 1);
    assert.strictEqual(body.commits[0].subject, 'outgoing: fix bug W');
  });

  it('clamps an oversized limit to 50 on the outgoing range (no error)', async () => {
    const body = await (await fetch(`${baseUrl}/api/git-log?id=warden-ahead&range=outgoing&limit=999`)).json();
    assert.strictEqual(body.commits.length, 2); // only 2 outgoing exist
    assert.strictEqual(body.error, null);
  });

  it('returns { commits: [], error: null } (200, not 500) when there is no upstream', async () => {
    // gitRepo has commits but NO upstream configured → @{u} is unset → git exits
    // non-zero with empty stdout → empty list. Mirrors the incoming no-upstream case;
    // the badge must never see a 500 here.
    const res = await fetch(`${baseUrl}/api/git-log?id=warden-gitlog&range=outgoing`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.commits, []);
    assert.strictEqual(body.error, null);
  });
});

describe('/api/git-log path filter (file history — WARDEN-319)', () => {
  it('returns exactly the commits that touched the given file (f0.txt → first commit)', async () => {
    const res = await fetch(`${baseUrl}/api/git-log?id=warden-gitlog&path=f0.txt`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    assert.ok(Array.isArray(body.commits));
    assert.strictEqual(body.commits.length, 1);
    assert.strictEqual(body.commits[0].subject, 'first commit');
    assert.match(body.commits[0].hash, /^[0-9a-f]{4,}$/);
    assert.strictEqual(body.commits[0].author, 'Tester');
    assert.ok(typeof body.commits[0].date === 'string' && body.commits[0].date.length > 0);
  });

  it('returns exactly the commits that touched f2.txt (→ third commit)', async () => {
    const body = await (await fetch(`${baseUrl}/api/git-log?id=warden-gitlog&path=f2.txt`)).json();
    assert.strictEqual(body.error, null);
    assert.strictEqual(body.commits.length, 1);
    assert.strictEqual(body.commits[0].subject, 'third commit');
  });

  it('rejects a traversal path with { commits: [], error: "invalid path" } (no 500)', async () => {
    const res = await fetch(`${baseUrl}/api/git-log?id=warden-gitlog&path=${encodeURIComponent('../etc/passwd')}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.commits, []);
    assert.strictEqual(body.error, 'invalid path');
  });

  it('returns { commits: [], error: null } (200, not 500) for a non-git cwd', async () => {
    const res = await fetch(`${baseUrl}/api/git-log?id=warden-nongit&path=readme.txt`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.commits, []);
    assert.strictEqual(body.error, null);
  });

  it('ignores range when a path is present (file history is full, not incoming/outgoing)', async () => {
    // gitRepo has NO upstream → range=incoming alone yields empty (the no-upstream
    // case above). With a path present, rangeRev is intentionally NOT spliced, so the
    // file's history still resolves — this is the assertion that distinguishes the
    // correct file-history branch from a buggy one that splices rangeRev anyway.
    const body = await (await fetch(`${baseUrl}/api/git-log?id=warden-gitlog&path=f0.txt&range=incoming`)).json();
    assert.strictEqual(body.error, null);
    assert.strictEqual(body.commits.length, 1);
    assert.strictEqual(body.commits[0].subject, 'first commit');
  });

  it('--follow surfaces history across a rename (b.txt reaches create + rename)', async () => {
    // b.txt was renamed FROM a.txt; --follow must walk back through the rename so BOTH
    // commits surface (newest first: rename, then the original create). Without
    // --follow, b.txt's log would list only the rename commit — so length === 2 is the
    // proof the flag is actually live on the wire.
    const body = await (await fetch(`${baseUrl}/api/git-log?id=warden-rename&path=b.txt`)).json();
    assert.strictEqual(body.error, null);
    assert.strictEqual(body.commits.length, 2);
    assert.strictEqual(body.commits[0].subject, 'rename a.txt to b.txt');
    assert.strictEqual(body.commits[1].subject, 'create a.txt');
  });

  it('absent path stays byte-for-byte today\'s behavior (HEAD-reachable log, unchanged)', async () => {
    // No path → the existing HEAD-reachable behavior, identical to the original suite.
    const body = await (await fetch(`${baseUrl}/api/git-log?id=warden-gitlog`)).json();
    assert.strictEqual(body.commits.length, 3);
    assert.strictEqual(body.commits[0].subject, 'third commit');
  });
});

describe('/api/git-log grep filter (commit-message search — WARDEN-498)', () => {
  // grepRepo (newest-first): chore: bump deps · fix: flaky test · docs: readme · feat: add login.
  // 'login' appears in feat's SUBJECT and ONLY in fix's BODY — that split is the crux.

  it('returns only commits whose message contains the term (case-insensitive, subject)', async () => {
    const res = await fetch(`${baseUrl}/api/git-log?id=warden-grep&grep=deps`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    assert.ok(Array.isArray(body.commits));
    assert.strictEqual(body.commits.length, 1);
    assert.strictEqual(body.commits[0].subject, 'chore: bump deps');
  });

  it('matches the BODY too, not just the subject (the headline WARDEN-498 behavior)', async () => {
    // 'login' is in feat's subject AND in fix's body ('the timer race in login …').
    // fix's SUBJECT ('fix: flaky test') contains no 'login', so fix surfacing here is
    // ONLY possible if --grep reached the body — a subject-only match would miss it.
    // Newest-first: fix (newer) then feat (older).
    const body = await (await fetch(`${baseUrl}/api/git-log?id=warden-grep&grep=login`)).json();
    assert.strictEqual(body.error, null);
    assert.strictEqual(body.commits.length, 2);
    assert.strictEqual(body.commits[0].subject, 'fix: flaky test');
    assert.strictEqual(body.commits[1].subject, 'feat: add login');
  });

  it('is case-insensitive (LOGIN matches the same two commits as login)', async () => {
    const body = await (await fetch(`${baseUrl}/api/git-log?id=warden-grep&grep=LOGIN`)).json();
    assert.strictEqual(body.error, null);
    assert.strictEqual(body.commits.length, 2);
    assert.strictEqual(body.commits[0].subject, 'fix: flaky test');
    assert.strictEqual(body.commits[1].subject, 'feat: add login');
  });

  it('returns an empty list (200, not 500) when no message matches', async () => {
    const res = await fetch(`${baseUrl}/api/git-log?id=warden-grep&grep=this-match-nothing`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.commits, []);
    assert.strictEqual(body.error, null);
  });

  it('uses the grep ceiling, not the browse cap (limit=1 is ignored while searching)', async () => {
    // The design point of WARDEN-498: search widens beyond the 50-commit browse cap so
    // an old commit is findable. Symptom here: limit=1 must NOT clip the 2 'login'
    // matches — when grep is present, searchLimit = GIT_LOG_GREP_MAX, not the browse
    // limit. (A buggy impl that reused `limit` would return 1 commit here.)
    const body = await (await fetch(`${baseUrl}/api/git-log?id=warden-grep&grep=login&limit=1`)).json();
    assert.strictEqual(body.error, null);
    assert.strictEqual(body.commits.length, 2);
  });

  it('combines grep with range=outgoing (search the unpushed set)', async () => {
    // aheadRepo's two outgoing commits both start with 'outgoing:', but only one
    // contains 'feature'. grep+range must intersect BOTH filters.
    const body = await (await fetch(`${baseUrl}/api/git-log?id=warden-ahead&range=outgoing&grep=feature`)).json();
    assert.strictEqual(body.error, null);
    assert.strictEqual(body.commits.length, 1);
    assert.strictEqual(body.commits[0].subject, 'outgoing: add feature Z');
  });

  it('returns { commits: [], error: null } (200, not 500) for a non-git cwd', async () => {
    const res = await fetch(`${baseUrl}/api/git-log?id=warden-nongit&grep=anything`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.commits, []);
    assert.strictEqual(body.error, null);
  });

  it('absent grep stays byte-for-byte today\'s behavior (all commits, unchanged)', async () => {
    // No grep → the existing HEAD-reachable behavior (the whole 4-commit history),
    // proving the browse path was not perturbed by the new param.
    const body = await (await fetch(`${baseUrl}/api/git-log?id=warden-grep`)).json();
    assert.strictEqual(body.error, null);
    assert.strictEqual(body.commits.length, 4);
    assert.strictEqual(body.commits[0].subject, 'chore: bump deps');
    assert.strictEqual(body.commits[3].subject, 'feat: add login');
  });
});

describe('/api/git-log pickaxe filter (content-history search — WARDEN-559)', () => {
  // pickaxeRepo (newest-first): refactor: remove billingTotal · fix: change billingTotal
  // value · feat: add billingTotal. The MIDDLE commit rewrites `billingTotal = 1` →
  // `billingTotal = 2`: the term stays at one occurrence (so `-S` SKIPS it) but its diff
  // text still contains the term (so `-G` LISTS it) — the one commit that distinguishes
  // the two modes. Newest-first expected orders below.

  it('pickaxe default uses -S: returns commits that added OR removed the term', async () => {
    // `-S billingTotal` lists commits where the occurrence COUNT changed: feat (0→1)
    // and refactor (1→0). The middle "change value" commit (1→1) is correctly SKIPPED —
    // that is exactly the -S vs -G wedge. Newest-first: refactor, then feat.
    const res = await fetch(`${baseUrl}/api/git-log?id=warden-pickaxe&pickaxe=${PICKAXE_TERM}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    assert.ok(Array.isArray(body.commits));
    assert.strictEqual(body.commits.length, 2);
    assert.strictEqual(body.commits[0].subject, 'refactor: remove billingTotal');
    assert.strictEqual(body.commits[1].subject, 'feat: add billingTotal');
    for (const c of body.commits) {
      assert.match(c.hash, /^[0-9a-f]{4,}$/);
      assert.strictEqual(c.author, 'Tester');
      assert.ok(typeof c.epoch === 'number' && c.epoch > 0, 'epoch (%ct) must be a positive number');
    }
  });

  it('pickaxeRegex=1 uses -G: also lists the modify-in-place commit (diff-text match)', async () => {
    // `-G billingTotal` lists every commit whose diff ADDED/REMOVED a matching line —
    // all three, INCLUDING the middle "change value" commit that `-S` skipped (its diff
    // text contains `billingTotal` even though the count was unchanged). Newest-first.
    const body = await (await fetch(`${baseUrl}/api/git-log?id=warden-pickaxe&pickaxe=${PICKAXE_TERM}&pickaxeRegex=1`)).json();
    assert.strictEqual(body.error, null);
    assert.strictEqual(body.commits.length, 3);
    assert.strictEqual(body.commits[0].subject, 'refactor: remove billingTotal');
    assert.strictEqual(body.commits[1].subject, 'fix: change billingTotal value'); // the -S/-G wedge
    assert.strictEqual(body.commits[2].subject, 'feat: add billingTotal');
  });

  it('-S is the default (omit pickaxeRegex → the count-change set, not the diff-text set)', async () => {
    // No pickaxeRegex ⇒ -S ⇒ the middle commit is absent (count unchanged). This is the
    // negative-control half of the -S/-G distinction: if a bug made pickaxeRegex absent
    // accidentally select -G, this commit would appear and length would be 3.
    const body = await (await fetch(`${baseUrl}/api/git-log?id=warden-pickaxe&pickaxe=${PICKAXE_TERM}`)).json();
    assert.strictEqual(body.commits.length, 2);
    assert.ok(!body.commits.some((c) => c.subject === 'fix: change billingTotal value'));
  });

  it('returns an empty list (200, not 500) when no diff ever contained the term', async () => {
    const res = await fetch(`${baseUrl}/api/git-log?id=warden-pickaxe&pickaxe=this-string-never-existed`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.commits, []);
    assert.strictEqual(body.error, null);
  });

  it('uses the pickaxe ceiling, not the browse cap (limit=1 is ignored while searching)', async () => {
    // Mirrors the WARDEN-498 grep assertion: search widens beyond the 50-commit browse
    // cap so an old add/remove is findable. limit=1 must NOT clip the 2 `-S` matches —
    // when pickaxe is present, searchLimit = GIT_LOG_GREP_MAX. (A buggy impl that reused
    // `limit` would return 1 commit here.)
    const body = await (await fetch(`${baseUrl}/api/git-log?id=warden-pickaxe&pickaxe=${PICKAXE_TERM}&limit=1`)).json();
    assert.strictEqual(body.error, null);
    assert.strictEqual(body.commits.length, 2);
  });

  it('caps an over-long pickaxe term at 128 chars and stays safe (200, not 500)', async () => {
    // The argv-bounding safety net (mirrors grep's .slice(0,128)): a 200-char term is
    // truncated before reaching git, so the handler stays 200 with a well-formed body —
    // never a 500 and never an unbounded argv. pickaxeRepo has no 128-char run, so the
    // truncated term matches nothing.
    const longTerm = 'X'.repeat(200);
    const res = await fetch(`${baseUrl}/api/git-log?id=warden-pickaxe&pickaxe=${encodeURIComponent(longTerm)}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.commits));
    assert.strictEqual(body.commits.length, 0);
    assert.strictEqual(body.error, null);
  });

  it('combines pickaxe with range=outgoing (intersect the unpushed set)', async () => {
    // pickaxeAheadRepo's two outgoing commits add DISTINCT terms; only the one that
    // matches the pickaxe AND sits in the outgoing (@{u}..HEAD) set must surface.
    // Proves the -S flag and the rangeRev splice together without error.
    const body = await (await fetch(`${baseUrl}/api/git-log?id=warden-pickaxe-ahead&range=outgoing&pickaxe=${PICKAXE_TERM}`)).json();
    assert.strictEqual(body.error, null);
    assert.strictEqual(body.commits.length, 1);
    assert.strictEqual(body.commits[0].subject, 'outgoing: add billingTotal');
  });

  it('combines pickaxe with path (git log -S --follow -- <file>)', async () => {
    // The term only ever lives in billing.js, so pickaxe+path=billing.js yields the same
    // `-S` set as pickaxe alone (the refactor + feat). Proves the -S flag splices before
    // the --follow/-- pathspec branch and git accepts the combination.
    const body = await (await fetch(`${baseUrl}/api/git-log?id=warden-pickaxe&pickaxe=${PICKAXE_TERM}&path=${PICKAXE_FILE}`)).json();
    assert.strictEqual(body.error, null);
    assert.strictEqual(body.commits.length, 2);
    assert.strictEqual(body.commits[0].subject, 'refactor: remove billingTotal');
    assert.strictEqual(body.commits[1].subject, 'feat: add billingTotal');
  });

  it('returns { commits: [], error: null } (200, not 500) for a non-git cwd', async () => {
    const res = await fetch(`${baseUrl}/api/git-log?id=warden-nongit&pickaxe=${PICKAXE_TERM}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.commits, []);
    assert.strictEqual(body.error, null);
  });

  it('absent pickaxe stays byte-for-byte today\'s behavior (all commits, unchanged)', async () => {
    // No pickaxe → the existing HEAD-reachable behavior (the whole 3-commit history),
    // proving the browse path was not perturbed by the new param. Identical to the
    // headline "returns parsed commits" case minus the param.
    const body = await (await fetch(`${baseUrl}/api/git-log?id=warden-pickaxe`)).json();
    assert.strictEqual(body.error, null);
    assert.strictEqual(body.commits.length, 3);
    assert.strictEqual(body.commits[0].subject, 'refactor: remove billingTotal');
    assert.strictEqual(body.commits[2].subject, 'feat: add billingTotal');
  });

  it('pickaxe and grep compose (both filters splice as first log options)', async () => {
    // A user may pass both: `-S billingTotal --grep=add -i`. Only 'feat: add billingTotal'
    // both added the term (pickaxe) AND has 'add' in its message (grep) — refactor
    // removed the term but its message lacks 'add'. Proves the two splice independently.
    const body = await (await fetch(`${baseUrl}/api/git-log?id=warden-pickaxe&pickaxe=${PICKAXE_TERM}&grep=add`)).json();
    assert.strictEqual(body.error, null);
    assert.strictEqual(body.commits.length, 1);
    assert.strictEqual(body.commits[0].subject, 'feat: add billingTotal');
  });
});
