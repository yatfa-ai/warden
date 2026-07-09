import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseGitStatusPorcelain, parseAheadBehind } from './gitStatus.js';

describe('parseGitStatusPorcelain', () => {
  it('parses the most common case: unstaged modification as the FIRST file', () => {
    // This is the exact WARDEN-107 regression. " M" (leading space) means
    // worktree-modified-but-not-staged. If the output is trimmed as a whole,
    // the first line loses its leading space and the path is truncated.
    const out = ' M README.md\n M src/server.js\n?? test-qa-file.txt\n';
    assert.deepEqual(parseGitStatusPorcelain(out), [
      { path: 'README.md', status: 'M' },
      { path: 'src/server.js', status: 'M' },
      { path: 'test-qa-file.txt', status: '??' },
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
      { path: 'staged.js', status: 'M' },
      { path: 'added.js', status: 'A' },
    ]);
  });

  it('parses deletion status', () => {
    assert.deepEqual(parseGitStatusPorcelain(' D gone.js\n'), [
      { path: 'gone.js', status: 'D' },
    ]);
  });

  it('parses untracked files', () => {
    assert.deepEqual(parseGitStatusPorcelain('?? new.txt\n'), [
      { path: 'new.txt', status: '??' },
    ]);
  });

  it('parses mixed staged+worktree status (two-char code)', () => {
    // X='A' (staged add), Y='M' (further worktree mod) → "AM"
    assert.deepEqual(parseGitStatusPorcelain('AM wip.js\n'), [
      { path: 'wip.js', status: 'AM' },
    ]);
  });

  it('preserves spaces inside file paths', () => {
    assert.deepEqual(parseGitStatusPorcelain(' M my cool file.txt\n'), [
      { path: 'my cool file.txt', status: 'M' },
    ]);
  });

  it('tolerates CRLF line endings (e.g. over SSH)', () => {
    assert.deepEqual(parseGitStatusPorcelain(' M a.txt\r\n M b.txt\r\n?? c.txt\r\n'), [
      { path: 'a.txt', status: 'M' },
      { path: 'b.txt', status: 'M' },
      { path: 'c.txt', status: '??' },
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
      { path: 'buf.js', status: 'M' },
    ]);
  });

  it('returns files in the order git emits them', () => {
    const out = '?? z.txt\n M a.txt\nA  m.txt\n';
    assert.deepEqual(
      parseGitStatusPorcelain(out).map((f) => f.path),
      ['z.txt', 'a.txt', 'm.txt'],
    );
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
