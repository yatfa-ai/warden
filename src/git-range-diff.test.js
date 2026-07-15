import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * Tests for the aggregated range diff (WARDEN-398) — the net unified diff of an
 * agent's whole unpushed (↑N) or incoming (↓N) set, served by /api/git-range-diff.
 *
 * Mirrors src/git-log.test.js's HOME-freezing isolation: src/server.js evaluates
 * `const cfg = load()` at module load, and load() reads config.js's module-level
 * `dir` (= path.join(os.homedir(), …)). So the FIRST import of server.js freezes
 * the home dir for the whole process — we set process.env.HOME (and write config +
 * catalog + repos) BEFORE that single import. Do NOT re-import server.js with a
 * second HOME.
 *
 * Covers the acceptance criteria for the LOCAL host:
 *   - repo ahead of @{u} → range=outgoing returns the aggregated diff text
 *   - repo behind @{u}   → range=incoming returns the aggregated diff
 *   - dirty worktree     → range=worktree returns the combined `git diff HEAD` (WARDEN-449)
 *   - clean worktree     → range=worktree returns an empty diff (→ "Working tree clean.")
 *   - unborn HEAD        → range=worktree returns 'no commits yet ...' (NOT 'no upstream configured')
 *   - no upstream / detached HEAD → { diff: null, error: 'no upstream configured' }, 200 not 500
 *   - output capped at 1MB via capDiff (the shared guard, asserted via the route)
 *   - invalid range value → clean error, not 500
 *   - unknown id → 404; non-git cwd → { diff: null, error: ... }, not 500
 *
 * The remote (SSH) path reuses the same `git diff <range>` invocation; its logic is
 * covered indirectly. Driving a real SSH host in CI is out of scope.
 */

// Fixture commit subjects. The outgoing/incoming fixtures each carry DISTINCT file
// content so the aggregated diff text is assertable end-to-end over the wire.
const OUTGOING_BASE = 'base: shared with upstream';
const OUTGOING_SUBJECTS = ['outgoing: add file one', 'outgoing: add file two'];
const INCOMING_SUBJECTS = ['base one', 'base two', 'incoming: add feature X', 'incoming: fix bug Y'];

let httpServer;
let baseUrl;
let originalHome;
let tempHome;
let aheadRepo;
let bareOriginAhead;
let behindRepo;
let bareOriginBehind;
let bigAheadRepo;
let bareOriginBig;
let noUpstreamRepo;
let detachedRepo;
let bareOriginDetached;
let nonGitDir;
let dirtyRepo;
let unbornRepo;

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (status ${r.status}) in ${cwd}`);
  return r;
}

before(async () => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-rangediff-'));
  process.env.HOME = tempHome;

  // config.json with no SSH hosts
  const wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: [] }));

  // ---- aheadRepo: HEAD is AHEAD of @{u} by two commits (the outgoing case) ----
  // A base is pushed to a bare origin (→ @{u} at the base tip); two more local
  // commits are added but NOT pushed. `git diff @{u}..HEAD` is the net change of
  // those two unpushed commits — exactly what "what is this agent about to push?"
  // asks for. Distinct per-file content so the aggregated diff is assertable.
  aheadRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-rangediff-ahead-'));
  git(['init', '-q'], aheadRepo);
  git(['config', 'user.email', 'test@example.com'], aheadRepo);
  git(['config', 'user.name', 'Tester'], aheadRepo);
  fs.writeFileSync(path.join(aheadRepo, 'base.txt'), 'base\n');
  git(['add', '.'], aheadRepo);
  git(['commit', '-q', '-m', OUTGOING_BASE], aheadRepo);
  bareOriginAhead = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-rangediff-bare-ahead-'));
  git(['init', '--bare', '-q'], bareOriginAhead);
  git(['remote', 'add', 'origin', bareOriginAhead], aheadRepo);
  // -u sets upstream tracking so @{u} resolves; pushing HEAD is branch-name agnostic.
  git(['push', '-u', 'origin', 'HEAD'], aheadRepo);
  // Two more local commits, NOT pushed → HEAD is ahead of @{u} by exactly these.
  fs.writeFileSync(path.join(aheadRepo, 'one.txt'), 'one line\n');
  git(['add', '.'], aheadRepo);
  git(['commit', '-q', '-m', OUTGOING_SUBJECTS[0]], aheadRepo);
  fs.writeFileSync(path.join(aheadRepo, 'two.txt'), 'two line\n');
  git(['add', '.'], aheadRepo);
  git(['commit', '-q', '-m', OUTGOING_SUBJECTS[1]], aheadRepo);

  // ---- behindRepo: @{u} is AHEAD of HEAD by two commits (the incoming case) ----
  // All four commits pushed to a bare origin (→ @{u} at the tip), then HEAD reset
  // back two. `git diff HEAD..@{u}` is the net change of those two incoming commits
  // — exactly what "what will land if I bring this agent up to upstream?" asks for.
  behindRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-rangediff-behind-'));
  git(['init', '-q'], behindRepo);
  git(['config', 'user.email', 'test@example.com'], behindRepo);
  git(['config', 'user.name', 'Tester'], behindRepo);
  INCOMING_SUBJECTS.forEach((subject, i) => {
    fs.writeFileSync(path.join(behindRepo, `b${i}.txt`), `behind ${i}\n`);
    git(['add', '.'], behindRepo);
    git(['commit', '-q', '-m', subject], behindRepo);
  });
  bareOriginBehind = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-rangediff-bare-behind-'));
  git(['init', '--bare', '-q'], bareOriginBehind);
  git(['remote', 'add', 'origin', bareOriginBehind], behindRepo);
  git(['push', '-u', 'origin', 'HEAD'], behindRepo);
  // Drop the last two commits locally → HEAD is behind @{u} by exactly those two.
  git(['reset', '--hard', 'HEAD~2'], behindRepo);

  // ---- bigAheadRepo: one unpushed commit whose diff exceeds 1MB (the cap case) ----
  // capDiff (the shared 1MB guard, GIT_DIFF_MAX_BYTES) must bound the response even
  // for a huge unpushed change. base pushed; a >1MB file added in an unpushed commit.
  bigAheadRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-rangediff-big-'));
  git(['init', '-q'], bigAheadRepo);
  git(['config', 'user.email', 'test@example.com'], bigAheadRepo);
  git(['config', 'user.name', 'Tester'], bigAheadRepo);
  fs.writeFileSync(path.join(bigAheadRepo, 'base.txt'), 'base\n');
  git(['add', '.'], bigAheadRepo);
  git(['commit', '-q', '-m', 'base'], bigAheadRepo);
  bareOriginBig = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-rangediff-bare-big-'));
  git(['init', '--bare', '-q'], bareOriginBig);
  git(['remote', 'add', 'origin', bareOriginBig], bigAheadRepo);
  git(['push', '-u', 'origin', 'HEAD'], bigAheadRepo);
  // A >1MB addition (unpushed) → its diff is >1MB and must be capped at exactly 1MB.
  fs.writeFileSync(path.join(bigAheadRepo, 'big.txt'), 'x'.repeat(1024 * 1024 + 100000));
  git(['add', '.'], bigAheadRepo);
  git(['commit', '-q', '-m', 'outgoing: add a big file'], bigAheadRepo);

  // ---- noUpstreamRepo: commits but NO upstream configured (the 🔒 case) ----
  // `git diff @{u}..HEAD` exits non-zero → { diff: null, error: 'no upstream configured' }.
  noUpstreamRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-rangediff-noupstream-'));
  git(['init', '-q'], noUpstreamRepo);
  git(['config', 'user.email', 'test@example.com'], noUpstreamRepo);
  git(['config', 'user.name', 'Tester'], noUpstreamRepo);
  fs.writeFileSync(path.join(noUpstreamRepo, 'a.txt'), 'a\n');
  git(['add', '.'], noUpstreamRepo);
  git(['commit', '-q', '-m', 'init'], noUpstreamRepo);

  // ---- detachedRepo: a detached HEAD (the other no-@{u} case) ----
  // @{u} is unset on a detached HEAD (HEAD is not on a tracking branch) → the same
  // 'no upstream configured' result. Built with an upstream first so the ONLY thing
  // that defeats @{u} is the detach (isolating that cause from the no-remote case).
  detachedRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-rangediff-detached-'));
  git(['init', '-q'], detachedRepo);
  git(['config', 'user.email', 'test@example.com'], detachedRepo);
  git(['config', 'user.name', 'Tester'], detachedRepo);
  fs.writeFileSync(path.join(detachedRepo, 'base.txt'), 'base\n');
  git(['add', '.'], detachedRepo);
  git(['commit', '-q', '-m', 'base'], detachedRepo);
  bareOriginDetached = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-rangediff-bare-detached-'));
  git(['init', '--bare', '-q'], bareOriginDetached);
  git(['remote', 'add', 'origin', bareOriginDetached], detachedRepo);
  git(['push', '-u', 'origin', 'HEAD'], detachedRepo);
  // Detach at HEAD → HEAD no longer sits on the tracking branch → @{u} is unset.
  git(['checkout', '--detach', 'HEAD'], detachedRepo);

  // ---- nonGitDir: a plain directory with no .git ----
  nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-rangediff-nongit-'));
  fs.writeFileSync(path.join(nonGitDir, 'readme.txt'), 'not a repo\n');

  // ---- dirtyRepo: a committed base + uncommitted staged AND unstaged tracked edits (± axis, WARDEN-449) ----
  // `git diff HEAD` is the COMBINED diff (staged + unstaged vs HEAD) — the SAME set
  // WARDEN-411's `git diff HEAD --shortstat` counts. Distinct content per file so the
  // aggregated diff is assertable: dirty.txt is worktree-modified (unstaged), staged.txt
  // is index-modified (staged). Both must surface in the ONE `git diff HEAD` — proving
  // the worktree axis is the combined set, not just one slot.
  dirtyRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-rangediff-dirty-'));
  git(['init', '-q'], dirtyRepo);
  git(['config', 'user.email', 'test@example.com'], dirtyRepo);
  git(['config', 'user.name', 'Tester'], dirtyRepo);
  fs.writeFileSync(path.join(dirtyRepo, 'dirty.txt'), 'base\n');
  fs.writeFileSync(path.join(dirtyRepo, 'staged.txt'), 'base\n');
  git(['add', '.'], dirtyRepo);
  git(['commit', '-q', '-m', 'base'], dirtyRepo);
  // Unstaged worktree edit on dirty.txt (HEAD has 'base', worktree has the change).
  fs.writeFileSync(path.join(dirtyRepo, 'dirty.txt'), 'worktree-change\n');
  // Staged edit on staged.txt (HEAD has 'base', index has the change, worktree clean here).
  fs.writeFileSync(path.join(dirtyRepo, 'staged.txt'), 'staged-change\n');
  git(['add', 'staged.txt'], dirtyRepo);

  // ---- unbornRepo: a fresh repo with NO commits (unborn HEAD — the ± error case) ----
  // `git diff HEAD` has no HEAD to compare against → exits non-zero → the range-aware
  // worktree error 'no commits yet (nothing to compare against HEAD)' (NOT the misleading
  // 'no upstream configured' the outgoing/incoming axes use). Has staged work so it's a
  // realistic "agent's brand-new repo with WIP but no first commit yet."
  unbornRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-rangediff-unborn-'));
  git(['init', '-q'], unbornRepo);
  git(['config', 'user.email', 'test@example.com'], unbornRepo);
  git(['config', 'user.name', 'Tester'], unbornRepo);
  fs.writeFileSync(path.join(unbornRepo, 'wip.txt'), 'work in progress\n');
  git(['add', '.'], unbornRepo);

  // Catalog with LOCAL manual chats, resolved by bare session id (no ':'
  // prefix) so no host/tmux discovery runs.
  fs.writeFileSync(
    path.join(wardenDir, 'chats.json'),
    JSON.stringify([
      { host: '(local)', session: 'warden-ahead', cwd: aheadRepo, cmd: 'bash', name: 'warden-ahead' },
      { host: '(local)', session: 'warden-behind', cwd: behindRepo, cmd: 'bash', name: 'warden-behind' },
      { host: '(local)', session: 'warden-big', cwd: bigAheadRepo, cmd: 'bash', name: 'warden-big' },
      { host: '(local)', session: 'warden-noupstream', cwd: noUpstreamRepo, cmd: 'bash', name: 'warden-noupstream' },
      { host: '(local)', session: 'warden-detached', cwd: detachedRepo, cmd: 'bash', name: 'warden-detached' },
      { host: '(local)', session: 'warden-nongit', cwd: nonGitDir, cmd: 'bash', name: 'warden-nongit' },
      { host: '(local)', session: 'warden-dirty', cwd: dirtyRepo, cmd: 'bash', name: 'warden-dirty' },
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
  for (const d of [aheadRepo, bareOriginAhead, behindRepo, bareOriginBehind, bigAheadRepo, bareOriginBig, noUpstreamRepo, detachedRepo, bareOriginDetached, nonGitDir, dirtyRepo, unbornRepo, tempHome]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe('/api/git-range-diff range=outgoing (ahead — WARDEN-398)', () => {
  it('sanity: the ahead fixture is actually 2 ahead, 0 behind', () => {
    // Confirms the fixture is in the state the case below assumes: @{u} behind HEAD
    // by exactly two. `rev-list --left-right --count @{u}...HEAD` → "behind\tahead".
    const ab = git(['rev-list', '--left-right', '--count', '@{u}...HEAD'], aheadRepo)
      .stdout.toString().trim();
    assert.strictEqual(ab, '0\t2', `expected "0\\t2" (behind=0, ahead=2), got "${ab}"`);
  });

  it('returns the aggregated unpushed diff text for range=outgoing', async () => {
    const res = await fetch(`${baseUrl}/api/git-range-diff?id=warden-ahead&range=outgoing`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    assert.ok(typeof body.diff === 'string' && body.diff.length > 0, 'diff must be non-empty text');
    // The net diff of the two unpushed commits: both new files surface (a unified
    // diff of @{u}..HEAD, NOT a single commit). Each file's added line is present.
    assert.ok(body.diff.includes('+++ b/one.txt'), 'diff must include one.txt');
    assert.ok(body.diff.includes('+++ b/two.txt'), 'diff must include two.txt');
    assert.ok(body.diff.includes('+one line'), 'diff must include one.txt content');
    assert.ok(body.diff.includes('+two line'), 'diff must include two.txt content');
    // And the base file (present at @{u}) is NOT re-added — this is a diff of the
    // two tips, so already-pushed content does not appear as an addition.
    assert.ok(!body.diff.includes('+++ b/base.txt'), 'base.txt is at @{u}; must not appear as added');
  });
});

describe('/api/git-range-diff range=incoming (behind — WARDEN-398)', () => {
  it('sanity: the behind fixture is actually 2 behind, 0 ahead', () => {
    const ab = git(['rev-list', '--left-right', '--count', '@{u}...HEAD'], behindRepo)
      .stdout.toString().trim();
    assert.strictEqual(ab, '2\t0', `expected "2\\t0" (behind=2, ahead=0), got "${ab}"`);
  });

  it('returns the aggregated incoming diff text for range=incoming', async () => {
    const res = await fetch(`${baseUrl}/api/git-range-diff?id=warden-behind&range=incoming`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    assert.ok(typeof body.diff === 'string' && body.diff.length > 0, 'diff must be non-empty text');
    // The net diff of the two incoming commits (b2.txt, b3.txt) — what would land
    // on a pull. Each incoming file's added line is present.
    assert.ok(body.diff.includes('+++ b/b2.txt'), 'diff must include b2.txt');
    assert.ok(body.diff.includes('+++ b/b3.txt'), 'diff must include b3.txt');
    assert.ok(body.diff.includes('+behind 2'), 'diff must include b2.txt content');
    assert.ok(body.diff.includes('+behind 3'), 'diff must include b3.txt content');
  });
});

describe('/api/git-range-diff range=worktree (uncommitted ± axis — WARDEN-449)', () => {
  it('sanity: the dirty fixture actually has uncommitted tracked changes', () => {
    // Confirms the fixture is dirty (HEAD differs from the worktree+index) so the case
    // below is meaningful. `git diff HEAD --shortstat` is exactly the set the route runs.
    const stat = git(['diff', 'HEAD', '--shortstat'], dirtyRepo).stdout.toString().trim();
    assert.match(stat, /files? changed/, `expected a non-empty shortstat, got "${stat}"`);
  });

  it('returns the combined staged+unstaged diff vs HEAD for a dirty tree', async () => {
    const res = await fetch(`${baseUrl}/api/git-range-diff?id=warden-dirty&range=worktree`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    assert.ok(typeof body.diff === 'string' && body.diff.length > 0, 'diff must be non-empty text');
    // `git diff HEAD` is the COMBINED set: BOTH the unstaged worktree edit (dirty.txt)
    // AND the staged edit (staged.txt) surface in one unified diff — not just one slot.
    // This is what makes the ± axis a true "full diff" vs the per-file /api/git-diff.
    assert.ok(body.diff.includes('+++ b/dirty.txt'), 'combined diff must include the unstaged file');
    assert.ok(body.diff.includes('+worktree-change'), 'combined diff must include the unstaged edit');
    assert.ok(body.diff.includes('+++ b/staged.txt'), 'combined diff must include the staged file');
    assert.ok(body.diff.includes('+staged-change'), 'combined diff must include the staged edit');
  });

  it('returns an empty diff (200, no error) for a clean tree', async () => {
    // warden-noupstream is a clean repo (one commit, nothing dirty) → `git diff HEAD`
    // is empty. The frontend renders an empty diff as the "Working tree clean." state,
    // NOT an error (the success criterion: a clean tree shows the clean empty state).
    const res = await fetch(`${baseUrl}/api/git-range-diff?id=warden-noupstream&range=worktree`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    assert.strictEqual(body.diff, '');
  });

  it('returns "no commits yet ..." (NOT "no upstream configured") for an unborn HEAD', async () => {
    // A fresh repo with no commits: `git diff HEAD` exits non-zero (no HEAD to compare
    // against). The worktree error is RANGE-AWARE — it must NOT recycle the
    // outgoing/incoming 'no upstream configured' string (a worktree diff has nothing to
    // do with upstream). 200, never a 500 (the success criterion).
    const res = await fetch(`${baseUrl}/api/git-range-diff?id=warden-unborn&range=worktree`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.diff, null);
    assert.strictEqual(body.error, 'no commits yet (nothing to compare against HEAD)');
    assert.notStrictEqual(body.error, 'no upstream configured');
  });

  it('does not regress: outgoing/incoming still say "no upstream configured" on an unborn HEAD', async () => {
    // The range-aware error must leave the OTHER axes untouched — an unborn HEAD queried
    // with outgoing/incoming still surfaces the original 'no upstream configured'.
    for (const range of ['outgoing', 'incoming']) {
      const res = await fetch(`${baseUrl}/api/git-range-diff?id=warden-unborn&range=${range}`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.diff, null);
      assert.strictEqual(body.error, 'no upstream configured');
    }
  });
});

describe('/api/git-range-diff no upstream / detached HEAD (never a 500)', () => {
  it('returns { diff: null, error: "no upstream configured" } (200) when no upstream is set — outgoing', async () => {
    const res = await fetch(`${baseUrl}/api/git-range-diff?id=warden-noupstream&range=outgoing`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.diff, null);
    assert.strictEqual(body.error, 'no upstream configured');
  });

  it('returns { diff: null, error: "no upstream configured" } (200) when no upstream is set — incoming', async () => {
    const res = await fetch(`${baseUrl}/api/git-range-diff?id=warden-noupstream&range=incoming`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.diff, null);
    assert.strictEqual(body.error, 'no upstream configured');
  });

  it('returns { diff: null, error: "no upstream configured" } (200) for a detached HEAD', async () => {
    // A detached HEAD has no @{u} even though the repo HAS a remote — isolating the
    // detach as the cause. git diff @{u}..HEAD exits non-zero → clean error, not 500.
    const res = await fetch(`${baseUrl}/api/git-range-diff?id=warden-detached&range=outgoing`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.diff, null);
    assert.strictEqual(body.error, 'no upstream configured');
  });
});

describe('/api/git-range-diff size cap (capDiff — WARDEN-398)', () => {
  it('caps an >1MB unpushed diff down to ≤1MB (200, no error)', async () => {
    const res = await fetch(`${baseUrl}/api/git-range-diff?id=warden-big&range=outgoing`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    assert.ok(typeof body.diff === 'string' && body.diff.length > 0, 'capped diff must be non-empty');
    // capDiff bounds the response to GIT_DIFF_MAX_BYTES (1MB), byte-accurate, so a
    // huge unpushed change can never blow up the server or the modal.
    assert.ok(Buffer.byteLength(body.diff) <= 1024 * 1024, 'capped diff must be ≤1MB');
  });
});

describe('/api/git-range-diff invalid range / unknown id / non-git (never a 500)', () => {
  it('rejects an invalid range value with a clean error (200, not 500)', async () => {
    const res = await fetch(`${baseUrl}/api/git-range-diff?id=warden-ahead&range=sideways`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.diff, null);
    assert.strictEqual(body.error, 'invalid range');
  });

  it('rejects an absent range with a clean error (200, not 500)', async () => {
    const res = await fetch(`${baseUrl}/api/git-range-diff?id=warden-ahead`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.diff, null);
    assert.strictEqual(body.error, 'invalid range');
  });

  it('returns 404 for an unknown chat id', async () => {
    const res = await fetch(`${baseUrl}/api/git-range-diff?id=does-not-exist&range=outgoing`);
    assert.strictEqual(res.status, 404);
  });

  it('returns { diff: null, error: <string> } (200, not 500) for a non-git cwd', async () => {
    const res = await fetch(`${baseUrl}/api/git-range-diff?id=warden-nongit&range=outgoing`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.diff, null);
    assert.ok(typeof body.error === 'string' && body.error.length > 0, 'must surface a non-empty error');
  });
});
