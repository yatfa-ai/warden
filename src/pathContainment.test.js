import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { isWithinResolvedCwd, CWD_CONTAINMENT_CASE } from './pathContainment.js';

// Direct pins for the single-sourced working-directory containment rule
// (WARDEN-1234). Until pathContainment.js existed the rule was copied at six
// call sites (three shell fragments + three JS clauses) and the sibling-prefix
// case was pinned at only some of them; each artifact now has ONE copy and ONE
// canonical pin here — including the sibling-prefix case for BOTH artifacts.
// The bash fragment is additionally executed end-to-end (spliced into full
// scripts, against real files) by src/read-file.test.js, src/file-exists.test.js,
// and src/gitDiff.test.js.

describe('isWithinResolvedCwd (the JS clause)', () => {
  const cwd = '/x/proj';

  it('accepts the cwd itself (exact match is in bounds)', () => {
    assert.equal(isWithinResolvedCwd('/x/proj', cwd), true);
  });

  it('accepts a file directly under cwd', () => {
    assert.equal(isWithinResolvedCwd('/x/proj/a.txt', cwd), true);
  });

  it('accepts a deeply nested path under cwd', () => {
    assert.equal(isWithinResolvedCwd('/x/proj/sub/deep/a.txt', cwd), true);
  });

  it('rejects a prefix-sibling whose name merely extends the cwd', () => {
    // THE regression this file exists for: '/x/proj-secret.txt' STARTS WITH
    // '/x/proj' as a plain string; only the separator (cwd + path.sep)
    // distinguishes sibling from child. A future edit that drops the separator
    // from the clause fails here (WARDEN-96 Vector 2 — the hole shipped once
    // as WARDEN-39's bare "$CWD"* bash glob).
    assert.equal(isWithinResolvedCwd('/x/proj-secret.txt', cwd), false);
    assert.equal(isWithinResolvedCwd('/x/projector', cwd), false);
  });

  it('rejects a sibling that diverges after the shared prefix (no separator)', () => {
    // '/x/projx/a.txt' shares the '/x/proj' string prefix but not the
    // '/x/proj/' directory prefix — same disease, one character later.
    assert.equal(isWithinResolvedCwd('/x/projx/a.txt', cwd), false);
  });

  it('rejects an unrelated path', () => {
    assert.equal(isWithinResolvedCwd('/etc/passwd', cwd), false);
    assert.equal(isWithinResolvedCwd('/x', cwd), false, 'a PARENT of the cwd is not the cwd');
  });
});

describe('CWD_CONTAINMENT_CASE (the bash fragment)', () => {
  it('keeps the separator in the prefix arm and admits the exact match', () => {
    // String-level pin of the shape the behavioral tests execute: the `/*` arm
    // requires the separator, and the bare "$RESOLVED_CWD" arm admits the cwd
    // itself. A regression that drops either arm — or the `/*` — breaks this
    // assertion before any bash-running test even gets there.
    assert.ok(
      CWD_CONTAINMENT_CASE.includes('case "$RESOLVED" in "$RESOLVED_CWD"/*|"$RESOLVED_CWD")'),
      'prefix arm must require the separator; exact match must be admitted',
    );
  });

  it('exits 1 with the canonical error on the reject arm', () => {
    assert.match(CWD_CONTAINMENT_CASE, /\*\) echo "ERROR path must be within working directory"; exit 1 ;; esac/);
  });

  it('runs under real bash: admits the cwd and a child, rejects a prefix-sibling', () => {
    // Behavioral pin of the fragment in isolation. The read-file/file-exists/
    // gitDiff suites pin it spliced into full scripts against real files; this
    // pins the fragment alone (it is pure string logic, so /x/proj need not
    // exist on disk). RESOLVED values contain no shell metacharacters.
    const fragment = (resolved) =>
      spawnSync('bash', ['-c', `RESOLVED='${resolved}'; RESOLVED_CWD='/x/proj'; ${CWD_CONTAINMENT_CASE}; echo INBOUNDS`], { encoding: 'utf8' });
    const inbounds = (resolved) => {
      const r = fragment(resolved);
      return r.status === 0 && r.stdout.trim() === 'INBOUNDS';
    };
    assert.equal(inbounds('/x/proj'), true, 'the cwd itself is in bounds');
    assert.equal(inbounds('/x/proj/a.txt'), true, 'a child behind the separator is in bounds');
    assert.equal(inbounds('/x/proj-secret.txt'), false, 'a sibling extending the cwd name is rejected');
    assert.equal(inbounds('/x/projector'), false, 'a sibling diverging one char later is rejected');
    assert.equal(inbounds('/etc/passwd'), false, 'an unrelated path is rejected');
  });
});
