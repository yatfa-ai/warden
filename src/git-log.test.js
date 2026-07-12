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
  for (const d of [gitRepo, nonGitDir, behindRepo, bareOrigin, aheadRepo, bareOriginAhead, tempHome]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe('parseGitLogLine', () => {
  it('parses a normal %h|%s|%an|%ar line', () => {
    assert.deepStrictEqual(parseGitLogLine('abc1234|fix: thing|John Doe|2 days ago'), {
      hash: 'abc1234', subject: 'fix: thing', author: 'John Doe', date: '2 days ago',
    });
  });

  it('keeps a literal "|" inside the subject', () => {
    const out = parseGitLogLine('def5678|fix: handle a | b in subject|Jane|3 hours ago');
    assert.strictEqual(out.hash, 'def5678');
    assert.strictEqual(out.subject, 'fix: handle a | b in subject');
    assert.strictEqual(out.author, 'Jane');
    assert.strictEqual(out.date, '3 hours ago');
  });

  it('handles multiple "|" inside the subject', () => {
    const out = parseGitLogLine('bbb2222|merge feat | fix | docs|Sam|5 minutes ago');
    assert.strictEqual(out.subject, 'merge feat | fix | docs');
    assert.strictEqual(out.author, 'Sam');
    assert.strictEqual(out.date, '5 minutes ago');
  });

  it('handles an empty subject (%s is empty)', () => {
    assert.deepStrictEqual(parseGitLogLine('aaa1111||Bob|1 day ago'), {
      hash: 'aaa1111', subject: '', author: 'Bob', date: '1 day ago',
    });
  });

  it('handles a malformed line with no author/date separators', () => {
    assert.deepStrictEqual(parseGitLogLine('xyz9999|just a subject no author/date'), {
      hash: 'xyz9999', subject: 'just a subject no author/date', author: '', date: '',
    });
  });

  it('handles a line with no separators at all', () => {
    assert.deepStrictEqual(parseGitLogLine('lonelyhash'), {
      hash: 'lonelyhash', subject: '', author: '', date: '',
    });
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
