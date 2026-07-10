import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseGitStatusPorcelain, parseAheadBehind, parseStashCount, parseStashList, isConflictStatus, isDetachedHead, normalizeHeadSha, buildDockerGitArgv } from './gitStatus.js';

describe('parseGitStatusPorcelain', () => {
  it('parses the most common case: unstaged modification as the FIRST file', () => {
    // This is the exact WARDEN-107 regression. " M" (leading space) means
    // worktree-modified-but-not-staged. If the output is trimmed as a whole,
    // the first line loses its leading space and the path is truncated.
    const out = ' M README.md\n M src/server.js\n?? test-qa-file.txt\n';
    assert.deepEqual(parseGitStatusPorcelain(out), [
      { path: 'README.md', status: 'M', conflict: false },
      { path: 'src/server.js', status: 'M', conflict: false },
      { path: 'test-qa-file.txt', status: '??', conflict: false },
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
      { path: 'staged.js', status: 'M', conflict: false },
      { path: 'added.js', status: 'A', conflict: false },
    ]);
  });

  it('parses deletion status', () => {
    assert.deepEqual(parseGitStatusPorcelain(' D gone.js\n'), [
      { path: 'gone.js', status: 'D', conflict: false },
    ]);
  });

  it('parses untracked files', () => {
    assert.deepEqual(parseGitStatusPorcelain('?? new.txt\n'), [
      { path: 'new.txt', status: '??', conflict: false },
    ]);
  });

  it('parses mixed staged+worktree status (two-char code)', () => {
    // X='A' (staged add), Y='M' (further worktree mod) → "AM"
    assert.deepEqual(parseGitStatusPorcelain('AM wip.js\n'), [
      { path: 'wip.js', status: 'AM', conflict: false },
    ]);
  });

  it('preserves spaces inside file paths', () => {
    assert.deepEqual(parseGitStatusPorcelain(' M my cool file.txt\n'), [
      { path: 'my cool file.txt', status: 'M', conflict: false },
    ]);
  });

  it('tolerates CRLF line endings (e.g. over SSH)', () => {
    assert.deepEqual(parseGitStatusPorcelain(' M a.txt\r\n M b.txt\r\n?? c.txt\r\n'), [
      { path: 'a.txt', status: 'M', conflict: false },
      { path: 'b.txt', status: 'M', conflict: false },
      { path: 'c.txt', status: '??', conflict: false },
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
      { path: 'buf.js', status: 'M', conflict: false },
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
      { path: 'both.js', status: 'UU', conflict: true },
    ]);
  });

  it('tags a both-added AA conflict with conflict: true', () => {
    assert.deepEqual(parseGitStatusPorcelain('AA added-twice.js\n'), [
      { path: 'added-twice.js', status: 'AA', conflict: true },
    ]);
  });

  it('tags a both-deleted DD conflict with conflict: true', () => {
    assert.deepEqual(parseGitStatusPorcelain('DD gone-both.js\n'), [
      { path: 'gone-both.js', status: 'DD', conflict: true },
    ]);
  });

  it('flags conflicts alongside ordinary changes in one pass', () => {
    // A realistic mid-merge status: one cleanly-modified file + one conflicted
    // file. Only the UU row is conflict:true.
    const out = ' M README.md\nUU conflicted.js\n?? new.txt\n';
    assert.deepEqual(parseGitStatusPorcelain(out), [
      { path: 'README.md', status: 'M', conflict: false },
      { path: 'conflicted.js', status: 'UU', conflict: true },
      { path: 'new.txt', status: '??', conflict: false },
    ]);
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
