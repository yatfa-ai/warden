import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseGitStatusPorcelain, parseAheadBehind, parseStashCount, parseStashList, parseReflog, parseDiffStat, isConflictStatus, isDetachedHead, normalizeHeadSha, parseUpstream, parseHeadDate, parseGitBranches, buildDockerGitArgv } from './gitStatus.js';

describe('parseGitStatusPorcelain', () => {
  it('parses the most common case: unstaged modification as the FIRST file', () => {
    // This is the exact WARDEN-107 regression. " M" (leading space) means
    // worktree-modified-but-not-staged. If the output is trimmed as a whole,
    // the first line loses its leading space and the path is truncated.
    const out = ' M README.md\n M src/server.js\n?? test-qa-file.txt\n';
    assert.deepEqual(parseGitStatusPorcelain(out), [
      { path: 'README.md', status: 'M', staged: ' ', worktree: 'M', conflict: false },
      { path: 'src/server.js', status: 'M', staged: ' ', worktree: 'M', conflict: false },
      { path: 'test-qa-file.txt', status: '??', staged: '?', worktree: '?', conflict: false },
    ]);
  });

  it('does NOT truncate the first path to "EADME.md"', () => {
    // Direct guard against the .trim()-the-whole-blob bug.
    const files = parseGitStatusPorcelain(' M README.md\n');
    assert.equal(files[0].path, 'README.md');
    assert.notEqual(files[0].path, 'EADME.md');
  });

  it('parses staged-only changes (X set, Y blank)', () => {
    assert.deepEqual(parseGitStatusPorcelain('M  staged.js\nA  added.js\n'), [
      { path: 'staged.js', status: 'M', staged: 'M', worktree: ' ', conflict: false },
      { path: 'added.js', status: 'A', staged: 'A', worktree: ' ', conflict: false },
    ]);
  });

  it('parses deletion status', () => {
    assert.deepEqual(parseGitStatusPorcelain(' D gone.js\n'), [
      { path: 'gone.js', status: 'D', staged: ' ', worktree: 'D', conflict: false },
    ]);
  });

  it('parses untracked files', () => {
    assert.deepEqual(parseGitStatusPorcelain('?? new.txt\n'), [
      { path: 'new.txt', status: '??', staged: '?', worktree: '?', conflict: false },
    ]);
  });

  it('parses mixed staged+worktree status (two-char code)', () => {
    // X='A' (staged add), Y='M' (further worktree mod) → "AM"
    assert.deepEqual(parseGitStatusPorcelain('AM wip.js\n'), [
      { path: 'wip.js', status: 'AM', staged: 'A', worktree: 'M', conflict: false },
    ]);
  });

  it('preserves spaces inside file paths', () => {
    assert.deepEqual(parseGitStatusPorcelain(' M my cool file.txt\n'), [
      { path: 'my cool file.txt', status: 'M', staged: ' ', worktree: 'M', conflict: false },
    ]);
  });

  it('tolerates CRLF line endings (e.g. over SSH)', () => {
    assert.deepEqual(parseGitStatusPorcelain(' M a.txt\r\n M b.txt\r\n?? c.txt\r\n'), [
      { path: 'a.txt', status: 'M', staged: ' ', worktree: 'M', conflict: false },
      { path: 'b.txt', status: 'M', staged: ' ', worktree: 'M', conflict: false },
      { path: 'c.txt', status: '??', staged: '?', worktree: '?', conflict: false },
    ]);
  });

  it('treats empty output as clean (no files)', () => {
    assert.deepEqual(parseGitStatusPorcelain(''), []);
  });

  it('treats whitespace-only output as clean', () => {
    assert.deepEqual(parseGitStatusPorcelain('   \n  \n'), []);
  });

  it('handles undefined / null input without throwing', () => {
    assert.deepEqual(parseGitStatusPorcelain(undefined), []);
    assert.deepEqual(parseGitStatusPorcelain(null), []);
  });

  it('accepts a Buffer input', () => {
    assert.deepEqual(parseGitStatusPorcelain(Buffer.from(' M buf.js\n')), [
      { path: 'buf.js', status: 'M', staged: ' ', worktree: 'M', conflict: false },
    ]);
  });

  it('returns files in the order git emits them', () => {
    const out = '?? z.txt\n M a.txt\nA  m.txt\n';
    assert.deepEqual(
      parseGitStatusPorcelain(out).map((f) => f.path),
      ['z.txt', 'a.txt', 'm.txt'],
    );
  });

  it('tags a conflicted UU file with conflict: true', () => {
    // "UU" = both sides modified (a merge/rebase conflict). Must NOT fall through
    // to the generic-gray row — it is an unmerged path.
    assert.deepEqual(parseGitStatusPorcelain('UU both.js\n'), [
      { path: 'both.js', status: 'UU', staged: 'U', worktree: 'U', conflict: true },
    ]);
  });

  it('tags a both-added AA conflict with conflict: true', () => {
    assert.deepEqual(parseGitStatusPorcelain('AA added-twice.js\n'), [
      { path: 'added-twice.js', status: 'AA', staged: 'A', worktree: 'A', conflict: true },
    ]);
  });

  it('tags a both-deleted DD conflict with conflict: true', () => {
    assert.deepEqual(parseGitStatusPorcelain('DD gone-both.js\n'), [
      { path: 'gone-both.js', status: 'DD', staged: 'D', worktree: 'D', conflict: true },
    ]);
  });

  it('flags conflicts alongside ordinary changes in one pass', () => {
    // A realistic mid-merge status: one cleanly-modified file + one conflicted
    // file. Only the UU row is conflict:true.
    const out = ' M README.md\nUU conflicted.js\n?? new.txt\n';
    assert.deepEqual(parseGitStatusPorcelain(out), [
      { path: 'README.md', status: 'M', staged: ' ', worktree: 'M', conflict: false },
      { path: 'conflicted.js', status: 'UU', staged: 'U', worktree: 'U', conflict: true },
      { path: 'new.txt', status: '??', staged: '?', worktree: '?', conflict: false },
    ]);
  });

  // ---- WARDEN-369: the staged/worktree X/Y columns are what distinguish a
  // staged-for-commit file from an unstaged WIP file. The collapsed `status`
  // alone cannot (both staged "M " and unstaged " M" read status:"M").
  describe('staged/worktree X/Y columns', () => {
    it('staged-only modification: X="M", Y=" "', () => {
      const [f] = parseGitStatusPorcelain('M  staged-only.js\n');
      assert.equal(f.staged, 'M');
      assert.equal(f.worktree, ' ');
      assert.equal(f.status, 'M');
    });

    it('unstaged-only modification: X=" ", Y="M"', () => {
      const [f] = parseGitStatusPorcelain(' M unstaged-only.js\n');
      assert.equal(f.staged, ' ');
      assert.equal(f.worktree, 'M');
      assert.equal(f.status, 'M');
    });

    it('staged-only add: X="A", Y=" "', () => {
      const [f] = parseGitStatusPorcelain('A  staged-add.js\n');
      assert.equal(f.staged, 'A');
      assert.equal(f.worktree, ' ');
    });

    it('unstaged-only delete: X=" ", Y="D"', () => {
      const [f] = parseGitStatusPorcelain(' D unstaged-delete.js\n');
      assert.equal(f.staged, ' ');
      assert.equal(f.worktree, 'D');
    });

    it('partially-staged "MM": staged="M" AND worktree="M" (both slots set)', () => {
      const [f] = parseGitStatusPorcelain('MM partial.js\n');
      assert.equal(f.staged, 'M');
      assert.equal(f.worktree, 'M');
      assert.equal(f.status, 'MM');
    });

    it('partially-staged "AM": staged add + further worktree mod', () => {
      const [f] = parseGitStatusPorcelain('AM staged-add-wip.js\n');
      assert.equal(f.staged, 'A');
      assert.equal(f.worktree, 'M');
    });

    it('untracked "??": both columns carry "?"', () => {
      const [f] = parseGitStatusPorcelain('?? untracked.js\n');
      assert.equal(f.staged, '?');
      assert.equal(f.worktree, '?');
    });

    it('a staged file and an unstaged file with the SAME status code differ in X/Y', () => {
      // The core WARDEN-369 invariant: two files that both collapse to status "M"
      // are distinguishable only via staged/worktree.
      const files = parseGitStatusPorcelain('M  staged.js\n M unstaged.js\n');
      assert.equal(files[0].status, 'M');
      assert.equal(files[1].status, 'M');
      assert.notEqual(files[0].staged, files[1].staged); // 'M' vs ' '
      assert.notEqual(files[0].worktree, files[1].worktree); // ' ' vs 'M'
    });
  });
});

describe('isConflictStatus', () => {
  // The seven porcelain v1 unmerged XY codes (WARDEN-186). Git writes one of
  // these in BOTH columns when a path could not be merged automatically.

  it('returns true for every unmerged code', () => {
    for (const code of ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']) {
      assert.equal(isConflictStatus(code), true, `${code} should be a conflict`);
    }
  });

  it('returns false for ordinary single-column codes', () => {
    for (const code of ['M', 'A', 'D']) {
      assert.equal(isConflictStatus(code), false, `${code} should NOT be a conflict`);
    }
  });

  it('returns false for untracked ??', () => {
    assert.equal(isConflictStatus('??'), false);
  });

  it('returns false for a space / empty status', () => {
    assert.equal(isConflictStatus(' '), false);
    assert.equal(isConflictStatus(''), false);
  });

  it('returns false for mixed non-conflict two-char codes like AM', () => {
    // AM = staged-add then worktree-modified — NOT unmerged.
    assert.equal(isConflictStatus('AM'), false);
    assert.equal(isConflictStatus('MM'), false);
  });

  it('tolerates leading space from the raw XY field (trim-safe)', () => {
    // parseGitStatusPorcelain trims the XY substring before passing it here, but
    // the helper must be defensive: a raw " U" must not be misread.
    assert.equal(isConflictStatus(' UU'), true);
    assert.equal(isConflictStatus(' M'), false);
  });

  it('handles undefined / null input without throwing', () => {
    assert.equal(isConflictStatus(undefined), false);
    assert.equal(isConflictStatus(null), false);
  });

  it('accepts a Buffer input', () => {
    assert.equal(isConflictStatus(Buffer.from('UU')), true);
  });
});

describe('isDetachedHead', () => {
  // `git symbolic-ref -q HEAD` exits non-zero iff HEAD is detached (it prints
  // refs/heads/<name> + exit 0 when on a branch). But it ALSO exits non-zero
  // outside any git repo, so the inGitRepo guard is what keeps a non-git cwd
  // from being misread as detached (WARDEN-239).

  it('returns true for a non-zero symbolic-ref exit inside a repo (detached)', () => {
    // detached HEAD → symbolic-ref refuses, exit 1.
    assert.equal(isDetachedHead(1, true), true);
  });

  it('returns true for exit 128 inside a repo (detached, older git)', () => {
    assert.equal(isDetachedHead(128, true), true);
  });

  it('returns false for exit 0 inside a repo (on a branch)', () => {
    // symbolic-ref printed refs/heads/main and exited 0.
    assert.equal(isDetachedHead(0, true), false);
  });

  it('returns false outside a git repo even when symbolic-ref exited non-zero', () => {
    // A non-git cwd: symbolic-ref fails too (exit 128) but we are NOT detached —
    // there is no repo. This is the case the inGitRepo guard exists for.
    assert.equal(isDetachedHead(128, false), false);
    assert.equal(isDetachedHead(1, false), false);
  });

  it('treats a null/undefined exit code as non-zero (refused to resolve) inside a repo', () => {
    // spawnSync returns status null on signal/spawn error; treat as "did not
    // succeed" rather than silently reading as attached.
    assert.equal(isDetachedHead(null, true), true);
    assert.equal(isDetachedHead(undefined, true), true);
  });

  it('treats a null/undefined exit code as NOT detached outside a repo', () => {
    assert.equal(isDetachedHead(null, false), false);
    assert.equal(isDetachedHead(undefined, false), false);
  });
});

describe('normalizeHeadSha', () => {
  // `git rev-parse --short HEAD` prints a short SHA on success; the helper trims
  // it and nulls out the failure cases so the badge has nothing to show when the
  // SHA is unavailable (WARDEN-239).

  it('trims a normal short SHA on its own line', () => {
    assert.equal(normalizeHeadSha('554b5e9\n'), '554b5e9');
  });

  it('trims surrounding whitespace', () => {
    assert.equal(normalizeHeadSha('  554b5e9  \n'), '554b5e9');
  });

  it('returns null for a non-zero exit code', () => {
    // Non-git cwd / empty repo → rev-parse errors.
    assert.equal(normalizeHeadSha('', 128), null);
    assert.equal(normalizeHeadSha('554b5e9\n', 1), null);
  });

  it('returns null for empty / whitespace-only output on a successful exit', () => {
    assert.equal(normalizeHeadSha('', 0), null);
    assert.equal(normalizeHeadSha('   \n', 0), null);
  });

  it('trusts the output when no exit code is supplied', () => {
    // The remote run() path already encodes exit-0 in its .ok flag, so the
    // helper is called with just stdout — it must not null a valid SHA.
    assert.equal(normalizeHeadSha('554b5e9\n'), '554b5e9');
    assert.equal(normalizeHeadSha(''), null);
  });

  it('handles undefined / null input without throwing', () => {
    assert.equal(normalizeHeadSha(undefined), null);
    assert.equal(normalizeHeadSha(null), null);
  });

  it('accepts a Buffer input', () => {
    assert.equal(normalizeHeadSha(Buffer.from('554b5e9\n')), '554b5e9');
  });
});

describe('parseAheadBehind', () => {
  // `git rev-list --left-right --count @{u}...HEAD` prints `<behind>\t<ahead>`:
  // left = commits on upstream not in HEAD (behind), right = commits in HEAD not
  // on upstream (ahead / unpushed). See WARDEN-153.

  it('parses a normal "behind\tahead" line', () => {
    // 2 behind (remote has 2 we lack), 5 ahead (5 unpushed) — a diverged branch.
    assert.deepEqual(parseAheadBehind('2\t5\n'), { ahead: 5, behind: 2 });
  });

  it('parses an up-to-date branch as zero/zero', () => {
    assert.deepEqual(parseAheadBehind('0\t0\n'), { ahead: 0, behind: 0 });
  });

  it('parses ahead-only (unpushed commits)', () => {
    // 3 local commits not yet on the remote, nothing to pull.
    assert.deepEqual(parseAheadBehind('0\t3\n'), { ahead: 3, behind: 0 });
  });

  it('parses behind-only (remote has new commits)', () => {
    // Remote moved 4 commits ahead of us, nothing local to push.
    assert.deepEqual(parseAheadBehind('4\t0\n'), { ahead: 0, behind: 4 });
  });

  it('treats empty output (no upstream / non-git cwd) as null', () => {
    // git exits non-zero with empty stdout when there's no @{u}.
    assert.deepEqual(parseAheadBehind(''), { ahead: null, behind: null });
  });

  it('handles undefined / null input without throwing', () => {
    assert.deepEqual(parseAheadBehind(undefined), { ahead: null, behind: null });
    assert.deepEqual(parseAheadBehind(null), { ahead: null, behind: null });
  });

  it('accepts a Buffer input', () => {
    assert.deepEqual(parseAheadBehind(Buffer.from('0\t2\n')), { ahead: 2, behind: 0 });
  });

  it('returns null for malformed single-token output', () => {
    assert.deepEqual(parseAheadBehind('not-a-count'), { ahead: null, behind: null });
  });

  it('returns null for non-numeric counts', () => {
    assert.deepEqual(parseAheadBehind('a\tb'), { ahead: null, behind: null });
  });

  it('returns null when only one side is numeric', () => {
    assert.deepEqual(parseAheadBehind('2\t'), { ahead: null, behind: null });
    assert.deepEqual(parseAheadBehind('\t3'), { ahead: null, behind: null });
  });

  it('returns null for output with too many fields', () => {
    assert.deepEqual(parseAheadBehind('1\t2\t3'), { ahead: null, behind: null });
  });

  it('tolerates CRLF line endings (e.g. over SSH)', () => {
    assert.deepEqual(parseAheadBehind('2\t5\r\n'), { ahead: 5, behind: 2 });
  });

  it('tolerates leading/trailing whitespace', () => {
    assert.deepEqual(parseAheadBehind('  2\t5  '), { ahead: 5, behind: 2 });
  });
});

describe('parseUpstream', () => {
  // `git rev-parse --abbrev-ref @{u}` prints the short upstream name (e.g.
  // origin/feature) + exit 0 when one is configured, and exits non-zero with
  // empty stdout when HEAD has no upstream. We surface the trimmed name on
  // success and null for empty/non-zero — the only signal that distinguishes a
  // never-pushed branch from a synced 0/0 one (both → ahead/behind nulls)
  // (WARDEN-243).

  it('trims a normal short upstream name on its own line', () => {
    assert.equal(parseUpstream('origin/feature\n'), 'origin/feature');
  });

  it('trims a longer multi-segment upstream', () => {
    assert.equal(parseUpstream('origin/release/v1.2\n'), 'origin/release/v1.2');
  });

  it('trims surrounding whitespace', () => {
    assert.equal(parseUpstream('  origin/main  \n'), 'origin/main');
  });

  it('returns null for a non-zero exit code', () => {
    // No upstream / detached HEAD / non-git cwd → rev-parse errors (exit 128).
    assert.equal(parseUpstream('', 128), null);
    assert.equal(parseUpstream('origin/feature\n', 1), null);
  });

  it('returns null for empty / whitespace-only output on a successful exit', () => {
    assert.equal(parseUpstream('', 0), null);
    assert.equal(parseUpstream('   \n', 0), null);
  });

  it('returns null for empty output with no exit code (the route .ok-gated call)', () => {
    // The route calls parseUpstream(upR.ok ? upR.stdout : '') — when there's no
    // upstream, upR.ok is false so '' is passed (no exit code). That must null.
    assert.equal(parseUpstream(''), null);
  });

  it('trusts the output when no exit code is supplied', () => {
    // The remote run() path encodes exit-0 in its .ok flag, so the helper is
    // called with just stdout — it must not null a valid upstream name.
    assert.equal(parseUpstream('origin/main\n'), 'origin/main');
  });

  it('handles undefined / null input without throwing', () => {
    assert.equal(parseUpstream(undefined), null);
    assert.equal(parseUpstream(null), null);
  });

  it('accepts a Buffer input', () => {
    assert.equal(parseUpstream(Buffer.from('origin/feature\n')), 'origin/feature');
  });

  it('tolerates CRLF line endings (e.g. over SSH)', () => {
    assert.equal(parseUpstream('origin/feature\r\n'), 'origin/feature');
  });
});

describe('parseHeadDate', () => {
  // `git log -1 --format=%cI HEAD` prints the strict ISO-8601 committer date of
  // HEAD (e.g. 2026-07-08T14:30:00+02:00). We surface the trimmed ISO string on
  // success and null for empty/non-zero — the last-commit FRESHNESS signal that
  // lets a human pick out a synced-but-stalled agent without expanding its commit
  // list (WARDEN-545). Mirrors normalizeHeadSha/parseUpstream's tolerance.

  it('trims a normal strict ISO-8601 date on its own line', () => {
    assert.equal(parseHeadDate('2026-07-08T14:30:00+02:00\n'), '2026-07-08T14:30:00+02:00');
  });

  it('trims a UTC ISO-8601 date (Z suffix)', () => {
    assert.equal(parseHeadDate('2026-07-08T12:30:00Z\n'), '2026-07-08T12:30:00Z');
  });

  it('trims surrounding whitespace', () => {
    assert.equal(parseHeadDate('  2026-07-08T14:30:00+02:00  \n'), '2026-07-08T14:30:00+02:00');
  });

  it('returns null for a non-zero exit code', () => {
    // Unborn branch (no commits) / non-git cwd → `git log` errors (exit 128).
    assert.equal(parseHeadDate('', 128), null);
    assert.equal(parseHeadDate('2026-07-08T14:30:00+02:00\n', 1), null);
  });

  it('returns null for empty / whitespace-only output on a successful exit', () => {
    assert.equal(parseHeadDate('', 0), null);
    assert.equal(parseHeadDate('   \n', 0), null);
  });

  it('returns null for empty output with no exit code (the route .ok-gated call)', () => {
    // The route calls parseHeadDate(headDateR.ok ? headDateR.stdout : '', headDateR.code)
    // — when git log fails, headDateR.ok is false so '' + a non-zero code are
    // passed. That must null (the exit-code gate catches it first).
    assert.equal(parseHeadDate(''), null);
  });

  it('trusts the output when no exit code is supplied', () => {
    // The remote run() path encodes exit-0 in its .ok flag, so the helper may be
    // called with just stdout — it must not null a valid ISO date.
    assert.equal(parseHeadDate('2026-07-08T12:30:00Z\n'), '2026-07-08T12:30:00Z');
  });

  it('handles undefined / null input without throwing', () => {
    assert.equal(parseHeadDate(undefined), null);
    assert.equal(parseHeadDate(null), null);
  });

  it('accepts a Buffer input', () => {
    assert.equal(parseHeadDate(Buffer.from('2026-07-08T14:30:00+02:00\n')), '2026-07-08T14:30:00+02:00');
  });

  it('tolerates CRLF line endings (e.g. over SSH)', () => {
    assert.equal(parseHeadDate('2026-07-08T14:30:00+02:00\r\n'), '2026-07-08T14:30:00+02:00');
  });
});

describe('parseStashCount', () => {
  // `git stash list` prints one reflog line per shelved WIP entry. An empty repo
  // (or a non-git cwd whose `git stash list` errors to stderr) yields empty
  // stdout → null, so the badge renders no indicator. The eager count surfaces
  // parked work that `git status --porcelain` hides (WARDEN-211).

  it('counts N non-empty stash lines as N', () => {
    const out = 'stash@{0}: WIP on main: abc1234 third\nstash@{1}: WIP on main: def5678 second\n';
    assert.equal(parseStashCount(out), 2);
  });

  it('counts a single stash as 1', () => {
    assert.equal(parseStashCount('stash@{0}: WIP on main: abc1234 msg\n'), 1);
  });

  it('returns null for empty output (no stashes / non-git)', () => {
    assert.equal(parseStashCount(''), null);
  });

  it('tolerates a trailing newline without inflating the count', () => {
    assert.equal(parseStashCount('stash@{0}: WIP on main: msg\n\n'), 1);
  });

  it('treats whitespace-only output as null', () => {
    assert.equal(parseStashCount('   \n  \n'), null);
  });

  it('handles undefined / null input without throwing', () => {
    assert.equal(parseStashCount(undefined), null);
    assert.equal(parseStashCount(null), null);
  });

  it('accepts a Buffer input', () => {
    assert.equal(parseStashCount(Buffer.from('stash@{0}: WIP on main: msg\n')), 1);
  });

  it('tolerates CRLF line endings (e.g. over SSH)', () => {
    const out = 'stash@{0}: WIP on main: a\r\nstash@{1}: WIP on main: b\r\n';
    assert.equal(parseStashCount(out), 2);
  });
});

describe('parseStashList', () => {
  // `git stash list --pretty=format:%gd|%s|%cr` emits `<ref>|<subject>|<date>`.
  // The subject sits in the MIDDLE and may contain '|', so we peel the ref off
  // the front and the date off the back — same approach as parseGitLogLine
  // (WARDEN-211).

  it('parses a normal ref|subject|date line', () => {
    assert.deepEqual(parseStashList('stash@{0}|WIP on main: abc1234 fix|2 hours ago\n'), [
      { ref: 'stash@{0}', subject: 'WIP on main: abc1234 fix', date: '2 hours ago' },
    ]);
  });

  it('parses multiple stashes (newest first, matching git order)', () => {
    const out = 'stash@{0}|WIP on main: aaa newest|5 minutes ago\nstash@{1}|WIP on main: bbb older|1 day ago\n';
    assert.deepEqual(parseStashList(out), [
      { ref: 'stash@{0}', subject: 'WIP on main: aaa newest', date: '5 minutes ago' },
      { ref: 'stash@{1}', subject: 'WIP on main: bbb older', date: '1 day ago' },
    ]);
  });

  it('keeps a literal "|" inside the subject', () => {
    const out = 'stash@{0}|merge a | b | c|3 hours ago\n';
    assert.deepEqual(parseStashList(out), [
      { ref: 'stash@{0}', subject: 'merge a | b | c', date: '3 hours ago' },
    ]);
  });

  it('handles a subject with no "|" (whole tail is subject, empty date)', () => {
    assert.deepEqual(parseStashList('stash@{0}|just a subject, no date pipe\n'), [
      { ref: 'stash@{0}', subject: 'just a subject, no date pipe', date: '' },
    ]);
  });

  it('handles a line with no separators at all', () => {
    assert.deepEqual(parseStashList('lonelyref\n'), [
      { ref: 'lonelyref', subject: '', date: '' },
    ]);
  });

  it('returns [] for empty / whitespace-only output', () => {
    assert.deepEqual(parseStashList(''), []);
    assert.deepEqual(parseStashList('   \n  \n'), []);
  });

  it('handles undefined / null input without throwing', () => {
    assert.deepEqual(parseStashList(undefined), []);
    assert.deepEqual(parseStashList(null), []);
  });

  it('accepts a Buffer input', () => {
    assert.deepEqual(parseStashList(Buffer.from('stash@{0}|WIP on main: msg|1 hour ago\n')), [
      { ref: 'stash@{0}', subject: 'WIP on main: msg', date: '1 hour ago' },
    ]);
  });

  it('tolerates CRLF line endings (e.g. over SSH)', () => {
    assert.deepEqual(parseStashList('stash@{0}|WIP on main: msg|1 hour ago\r\n'), [
      { ref: 'stash@{0}', subject: 'WIP on main: msg', date: '1 hour ago' },
    ]);
  });
});

describe('parseReflog', () => {
  // `git reflog -n N --pretty=format:%h|%gs|%cr` emits `<hash>|<subject>|<date>`
  // where <subject> is git's %gs — the OPERATION ("reset: moving to HEAD~1",
  // "checkout: moving from main to feat", "commit: …"). The subject sits in the
  // MIDDLE and may contain '|', so we peel the hash off the front and the date off
  // the back — same approach as parseStashList (WARDEN-460).

  it('parses a normal hash|subject|date line', () => {
    assert.deepEqual(parseReflog('abc1234|reset: moving to HEAD~1|5 minutes ago\n'), [
      { hash: 'abc1234', subject: 'reset: moving to HEAD~1', date: '5 minutes ago' },
    ]);
  });

  it('parses multiple entries (newest first, matching git order)', () => {
    const out = 'aaa1111|checkout: moving from main to feat|2 minutes ago\nbbb2222|commit: fix the bug|1 hour ago\n';
    assert.deepEqual(parseReflog(out), [
      { hash: 'aaa1111', subject: 'checkout: moving from main to feat', date: '2 minutes ago' },
      { hash: 'bbb2222', subject: 'commit: fix the bug', date: '1 hour ago' },
    ]);
  });

  it('keeps a literal "|" inside the subject', () => {
    const out = 'abc1234|commit: fix a | b | c|3 hours ago\n';
    assert.deepEqual(parseReflog(out), [
      { hash: 'abc1234', subject: 'commit: fix a | b | c', date: '3 hours ago' },
    ]);
  });

  it('handles a subject with no "|" (whole tail is subject, empty date)', () => {
    assert.deepEqual(parseReflog('abc1234|commit: no date pipe here\n'), [
      { hash: 'abc1234', subject: 'commit: no date pipe here', date: '' },
    ]);
  });

  it('handles a line with no separators at all', () => {
    assert.deepEqual(parseReflog('abc1234\n'), [
      { hash: 'abc1234', subject: '', date: '' },
    ]);
  });

  it('returns [] for empty / whitespace-only output', () => {
    assert.deepEqual(parseReflog(''), []);
    assert.deepEqual(parseReflog('   \n  \n'), []);
  });

  it('handles undefined / null input without throwing', () => {
    assert.deepEqual(parseReflog(undefined), []);
    assert.deepEqual(parseReflog(null), []);
  });

  it('accepts a Buffer input', () => {
    assert.deepEqual(parseReflog(Buffer.from('abc1234|commit: msg|1 hour ago\n')), [
      { hash: 'abc1234', subject: 'commit: msg', date: '1 hour ago' },
    ]);
  });

  it('tolerates CRLF line endings (e.g. over SSH)', () => {
    assert.deepEqual(parseReflog('abc1234|reset: moving to HEAD~1|1 hour ago\r\n'), [
      { hash: 'abc1234', subject: 'reset: moving to HEAD~1', date: '1 hour ago' },
    ]);
  });
});

describe('parseDiffStat', () => {
  // `git diff HEAD --shortstat` prints a one-line summary of the combined
  // (staged + unstaged) edits vs HEAD. The insertions/deletions halves are
  // optional and the singular form drops the trailing "s". When the tree matches
  // HEAD git prints nothing → null, so a clean tree (and an all-untracked WIP —
  // `git diff HEAD` counts tracked edits only) renders no stat (WARDEN-411).

  it('parses a full "files changed, insertions, deletions" line', () => {
    // A big WIP — exactly the case the file count alone can't distinguish from
    // four one-line tweaks.
    assert.deepEqual(parseDiffStat(' 3 files changed, 847 insertions(+), 203 deletions(-)\n'), {
      files: 3, insertions: 847, deletions: 203,
    });
  });

  it('parses an insertions-only line (deletions absent → 0)', () => {
    assert.deepEqual(parseDiffStat(' 1 file changed, 5 insertions(+)\n'), {
      files: 1, insertions: 5, deletions: 0,
    });
  });

  it('parses a deletions-only line (insertions absent → 0)', () => {
    assert.deepEqual(parseDiffStat(' 2 files changed, 9 deletions(-)\n'), {
      files: 2, insertions: 0, deletions: 9,
    });
  });

  it('parses the singular "1 file changed" form', () => {
    assert.deepEqual(parseDiffStat(' 1 file changed, 1 insertion(+), 1 deletion(-)\n'), {
      files: 1, insertions: 1, deletions: 1,
    });
  });

  it('parses a large multi-file rewrite', () => {
    assert.deepEqual(parseDiffStat(' 42 files changed, 12034 insertions(+), 891 deletions(-)\n'), {
      files: 42, insertions: 12034, deletions: 891,
    });
  });

  it('returns null for empty output (clean tree / all-untracked WIP)', () => {
    // git prints nothing when the tree matches HEAD, and also nothing for a tree
    // with ONLY untracked files (tracked edits only) — both must null, never +0−0.
    assert.equal(parseDiffStat(''), null);
  });

  it('treats whitespace-only output as null', () => {
    assert.equal(parseDiffStat('   \n  \n'), null);
  });

  it('handles undefined / null input without throwing', () => {
    assert.equal(parseDiffStat(undefined), null);
    assert.equal(parseDiffStat(null), null);
  });

  it('returns null for garbage / unrelated output', () => {
    // No recognizable clause → null, not a {0,0,0} lie (mirrors parseAheadBehind).
    assert.equal(parseDiffStat('not a shortstat line'), null);
    assert.equal(parseDiffStat('fatal: not a git repository'), null);
    assert.equal(parseDiffStat('something changed somewhere'), null);
  });

  it('tolerates leading/trailing whitespace and no trailing newline', () => {
    assert.deepEqual(parseDiffStat('  3 files changed, 847 insertions(+), 203 deletions(-)  '), {
      files: 3, insertions: 847, deletions: 203,
    });
  });

  it('tolerates CRLF line endings (e.g. over SSH)', () => {
    assert.deepEqual(parseDiffStat(' 3 files changed, 847 insertions(+), 203 deletions(-)\r\n'), {
      files: 3, insertions: 847, deletions: 203,
    });
  });

  it('tolerates collapsed/internal whitespace variations', () => {
    // Defensive: git's format is stable, but be tolerant of odd spacing.
    assert.deepEqual(parseDiffStat('3 files changed,847 insertions(+),203 deletions(-)'), {
      files: 3, insertions: 847, deletions: 203,
    });
  });

  it('accepts a Buffer input', () => {
    assert.deepEqual(parseDiffStat(Buffer.from(' 3 files changed, 847 insertions(+), 203 deletions(-)\n')), {
      files: 3, insertions: 847, deletions: 203,
    });
  });
});

describe('parseGitBranches', () => {
  // `git for-each-ref --format='%(refname:short)|%(objectname:short)|
  // %(committerdate:iso-strict)|%(upstream:short)|%(upstream:track)' refs/heads/`
  // emits `<name>|<sha>|<date>|<upstream>|<track>` per branch. The track field is
  // the native ahead/behind/gone source. See WARDEN-577.

  it('parses a branch with an upstream that is in sync (track empty)', () => {
    const out = 'main|a4e8679|2026-07-17T01:24:17Z|origin/main|\n';
    assert.deepEqual(parseGitBranches(out), [
      { name: 'main', headSha: 'a4e8679', headDate: '2026-07-17T01:24:17Z', upstream: 'origin/main', ahead: 0, behind: 0, gone: false },
    ]);
  });

  it('parses a branch with no upstream at all (upstream + track empty)', () => {
    // A never-pushed branch: upstream:short and upstream:track both blank → the
    // line ends with `||`. ahead/behind read 0; the empty upstream is what tells
    // the caller this is local-only (distinct from an in-sync 0/0 branch).
    const out = 'experiment|57e4d8b|2026-07-17T01:23:59Z||\n';
    assert.deepEqual(parseGitBranches(out), [
      { name: 'experiment', headSha: '57e4d8b', headDate: '2026-07-17T01:23:59Z', upstream: '', ahead: 0, behind: 0, gone: false },
    ]);
  });

  it('parses [ahead N] / [behind N] / [ahead N, behind M] track tokens', () => {
    const out = [
      'ahead-only|aaa1111|2026-07-17T01:00:00Z|origin/ahead-only|[ahead 3]',
      'behind-only|bbb2222|2026-07-17T01:00:00Z|origin/behind-only|[behind 2]',
      'diverged|ccc3333|2026-07-17T01:00:00Z|origin/diverged|[ahead 5, behind 1]',
    ].join('\n') + '\n';
    assert.deepEqual(parseGitBranches(out), [
      { name: 'ahead-only', headSha: 'aaa1111', headDate: '2026-07-17T01:00:00Z', upstream: 'origin/ahead-only', ahead: 3, behind: 0, gone: false },
      { name: 'behind-only', headSha: 'bbb2222', headDate: '2026-07-17T01:00:00Z', upstream: 'origin/behind-only', ahead: 0, behind: 2, gone: false },
      { name: 'diverged', headSha: 'ccc3333', headDate: '2026-07-17T01:00:00Z', upstream: 'origin/diverged', ahead: 5, behind: 1, gone: false },
    ]);
  });

  it('flags [gone] (upstream deleted) with gone:true and 0/0 ahead/behind', () => {
    // The upstream name is retained (it WAS tracking origin/old) but the track is
    // [gone] — the remote branch no longer exists, so ahead/behind don't apply.
    const out = 'old-feature|a7a09c4|2026-06-01T01:00:00Z|origin/old-feature|[gone]\n';
    assert.deepEqual(parseGitBranches(out), [
      { name: 'old-feature', headSha: 'a7a09c4', headDate: '2026-06-01T01:00:00Z', upstream: 'origin/old-feature', ahead: 0, behind: 0, gone: true },
    ]);
  });

  it('parses multiple branches (git emits them in sorted order)', () => {
    const out = [
      'feature/x|1111111|2026-07-17T01:00:00Z|origin/feature/x|[ahead 1]',
      'main|2222222|2026-07-17T01:00:00Z|origin/main|',
      'wip|3333333|2026-07-17T01:00:00Z||',
    ].join('\n') + '\n';
    assert.deepEqual(parseGitBranches(out), [
      { name: 'feature/x', headSha: '1111111', headDate: '2026-07-17T01:00:00Z', upstream: 'origin/feature/x', ahead: 1, behind: 0, gone: false },
      { name: 'main', headSha: '2222222', headDate: '2026-07-17T01:00:00Z', upstream: 'origin/main', ahead: 0, behind: 0, gone: false },
      { name: 'wip', headSha: '3333333', headDate: '2026-07-17T01:00:00Z', upstream: '', ahead: 0, behind: 0, gone: false },
    ]);
  });

  it('reassembles a branch name that contains a literal "|" (git allows pipes)', () => {
    // git check-ref-format accepts `|` in a branch name, so a naive 5-way split
    // would truncate `feat|ure` to `feat`. Peeling the 4 trailing fields off the
    // back and rejoining the rest preserves the full name.
    const out = 'feat|ure|abc1234|2026-07-17T01:00:00Z|origin/feat|ure|[ahead 2]\n';
    assert.deepEqual(parseGitBranches(out), [
      { name: 'feat|ure', headSha: 'abc1234', headDate: '2026-07-17T01:00:00Z', upstream: 'origin/feat|ure', ahead: 2, behind: 0, gone: false },
    ]);
  });

  it('returns [] for empty / whitespace-only output', () => {
    assert.deepEqual(parseGitBranches(''), []);
    assert.deepEqual(parseGitBranches('   \n  \n'), []);
  });

  it('handles undefined / null input without throwing', () => {
    assert.deepEqual(parseGitBranches(undefined), []);
    assert.deepEqual(parseGitBranches(null), []);
  });

  it('accepts a Buffer input', () => {
    assert.deepEqual(parseGitBranches(Buffer.from('main|abc1234|2026-07-17T01:00:00Z|origin/main|\n')), [
      { name: 'main', headSha: 'abc1234', headDate: '2026-07-17T01:00:00Z', upstream: 'origin/main', ahead: 0, behind: 0, gone: false },
    ]);
  });

  it('tolerates CRLF line endings (e.g. over SSH)', () => {
    assert.deepEqual(parseGitBranches('main|abc1234|2026-07-17T01:00:00Z|origin/main|\r\n'), [
      { name: 'main', headSha: 'abc1234', headDate: '2026-07-17T01:00:00Z', upstream: 'origin/main', ahead: 0, behind: 0, gone: false },
    ]);
  });

  it('degrades a short/garbage line to a name-only record (never throws)', () => {
    // Fewer than 5 pipe-fields → the whole line becomes the name, fields blank.
    assert.deepEqual(parseGitBranches('not-a-valid-line\n'), [
      { name: 'not-a-valid-line', headSha: '', headDate: '', upstream: '', ahead: 0, behind: 0, gone: false },
    ]);
  });
});

// buildDockerGitArgv builds the local argv that runs `git -C <cwd> <args>` inside
// a yatfa container via `docker exec` (WARDEN-235). It is the unit-testable seam
// for the docker-exec transport — CI can't run real containers, so we lock the
// argv shape here. runGit (server.js) spawns it verbatim, so the order/quoting
// of this array is exactly what reaches `docker exec`.
describe('buildDockerGitArgv', () => {
  it('wraps git -C <cwd> <args> in docker exec <container>', () => {
    // A typical git-status porcelain call: argv, no shell, args spliced verbatim.
    assert.deepEqual(buildDockerGitArgv('yatfa-worker', '/workspace', ['status', '--porcelain']), [
      'docker', 'exec', 'yatfa-worker', 'git', '-C', '/workspace', 'status', '--porcelain',
    ]);
  });

  it('passes the in-container cwd via -C so the host never needs the path', () => {
    const argv = buildDockerGitArgv('c', '/app', ['rev-parse', '--abbrev-ref', 'HEAD']);
    assert.strictEqual(argv.indexOf('-C'), 4);          // -C right after `git`
    assert.strictEqual(argv[argv.indexOf('-C') + 1], '/app'); // its value is cwd
  });

  it('splices gitArgs verbatim — a pathspec/--flag is one argv element, not shell-split', () => {
    // `git diff HEAD -- src/server.js` → each token stays one element. No shell
    // means a path named like a flag can't inject options (the `--` is preserved).
    const argv = buildDockerGitArgv('c', '/w', ['diff', 'HEAD', '--', 'src/server.js']);
    assert.deepEqual(argv, ['docker', 'exec', 'c', 'git', '-C', '/w', 'diff', 'HEAD', '--', 'src/server.js']);
  });

  it('handles an empty args list (bare `git -C <cwd>`)', () => {
    assert.deepEqual(buildDockerGitArgv('c', '/w', []), ['docker', 'exec', 'c', 'git', '-C', '/w']);
  });

  it('does not mutate the input args array', () => {
    const args = ['log', '-5'];
    buildDockerGitArgv('c', '/w', args);
    assert.deepEqual(args, ['log', '-5']); // caller's array unchanged
  });
});
