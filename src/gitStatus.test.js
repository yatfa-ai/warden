import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseGitStatusPorcelain } from './gitStatus.js';

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
