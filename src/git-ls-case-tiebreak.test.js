import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseGitLsEntries } from './git.js';

const names = (entries) => entries.map((e) => `${e.type}:${e.name}`);

describe('parseGitLsEntries — names differing only in case', () => {
  it('orders file names that differ only in case by code point (uppercase first), whatever the input order', () => {
    const want = ['file:Makefile', 'file:makefile', 'file:README.md', 'file:readme.md'];
    const a = parseGitLsEntries(['makefile', 'Makefile', 'readme.md', 'README.md'].join('\n'), '');
    const b = parseGitLsEntries(['README.md', 'Makefile', 'readme.md', 'makefile'].join('\n'), '');
    assert.deepEqual(names(a), want);
    assert.deepEqual(names(b), want);
  });

  it('orders dir names that differ only in case the same way, and keeps dirs before files', () => {
    const raw = ['src/a.js', 'Src/b.js', 'zeta.js', 'Zeta.js'].join('\n');
    assert.deepEqual(
      names(parseGitLsEntries(raw, '')),
      ['dir:Src', 'dir:src', 'file:Zeta.js', 'file:zeta.js'],
    );
  });

  it('applies the same tiebreak inside a subdirectory listing', () => {
    const raw = ['docs/index.md', 'docs/Index.md', 'docs/INDEX.md'].join('\n');
    assert.deepEqual(
      names(parseGitLsEntries(raw, 'docs')),
      ['file:INDEX.md', 'file:Index.md', 'file:index.md'],
    );
  });

  it('the case-insensitive primary key still wins over the tiebreak', () => {
    // 'b' < 'C' case-insensitively even though 'C' (67) < 'b' (98) by code point.
    assert.deepEqual(
      names(parseGitLsEntries(['C.js', 'b.js', 'a.js', 'A.js'].join('\n'), '')),
      ['file:A.js', 'file:a.js', 'file:b.js', 'file:C.js'],
    );
  });
});
