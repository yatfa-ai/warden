// Pure tests for the Source Control panel's file grouping (WARDEN-431).
//
// The grouping core lives in src/lib/sourceControl.ts so it is unit-testable
// without a React runner (mirroring whatsNew.test.mjs / gitStateSummary.test.mjs):
// groupGitFiles turns a focused repo's working-tree files (the porcelain-slot
// GitFile shape /api/git-status already returns) into VS Code-style Merge /
// Staged / Changes buckets.
//
// Like those suites, there is no FE test runner in this repo, so this loads the
// REAL src/lib/sourceControl.ts (transpiled TS -> ESM via Vite's OXC transform)
// and exercises the pure helper with plain objects. The module is import-free,
// so the transpiled file needs no path-alias resolution.
//
// Run: node --test sourceControl.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libPath = resolve(__dirname, 'src/lib/sourceControl.ts');

// --- Load the REAL sourceControl.ts (TS -> ESM via the OXC transform Vite bundles) -
const src = readFileSync(libPath, 'utf8');
const { code } = await transformWithOxc(src, libPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-sourcecontrol-test-'));
const tmpFile = join(tmpDir, 'sourceControl.mjs');
writeFileSync(tmpFile, code);
const { groupGitFiles } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// Shorthand constructors for the porcelain-slot file shape. `x`/`y` are the X
// (staged) / Y (worktree) columns; a leading space means "no change in that slot".
const file = (path, x, y, opts = {}) => ({
  path,
  status: (x && x !== ' ' ? x : y && y !== ' ' ? y : '?'),
  staged: x,
  worktree: y,
  ...opts,
});
const conflict = (path, status = 'UU') => ({ path, status, conflict: true });
const legacy = (path, status = 'M') => ({ path, status }); // committed file: no X/Y

const paths = (arr) => arr.map((f) => f.path);

console.log('\ngroupGitFiles buckets a focused repo files list like VS Code — WARDEN-431');

test('null / undefined / empty input yields three empty buckets', () => {
  assert.deepEqual(groupGitFiles(null), { merge: [], staged: [], changes: [] });
  assert.deepEqual(groupGitFiles(undefined), { merge: [], staged: [], changes: [] });
  assert.deepEqual(groupGitFiles([]), { merge: [], staged: [], changes: [] });
});

test('a conflict file lands only in Merge', () => {
  const g = groupGitFiles([conflict('main.ts', 'UU'), file('a.ts', 'M', ' ')]);
  assert.deepEqual(paths(g.merge), ['main.ts']);
  assert.deepEqual(paths(g.staged), ['a.ts']);
  assert.deepEqual(paths(g.changes), []);
  // The conflict row is the same object (no cloning).
  assert.equal(g.merge[0].conflict, true);
});

test('a staged-only file (X non-blank, Y blank) lands only in Staged, unchanged', () => {
  const f = file('staged.ts', 'M', ' ');
  const g = groupGitFiles([f]);
  assert.deepEqual(paths(g.staged), ['staged.ts']);
  assert.deepEqual(paths(g.merge), []);
  assert.deepEqual(paths(g.changes), []);
  assert.equal(g.staged[0], f, 'staged entry is the original object (opens staged diff)');
  assert.equal(g.staged[0].staged, 'M');
});

test('an unstaged-only file (X blank, Y non-blank) lands only in Changes, unchanged', () => {
  const f = file('wip.ts', ' ', 'M');
  const g = groupGitFiles([f]);
  assert.deepEqual(paths(g.changes), ['wip.ts']);
  assert.deepEqual(paths(g.staged), []);
  assert.equal(g.changes[0], f, 'changes entry is the original object');
  assert.equal(g.changes[0].staged, ' ', 'staged slot intact (blank) → opens combined diff');
});

test('an untracked file (??) lands only in Changes', () => {
  const g = groupGitFiles([file('new.ts', '?', '?')]);
  assert.deepEqual(paths(g.changes), ['new.ts']);
  assert.deepEqual(paths(g.staged), []);
  assert.deepEqual(paths(g.merge), []);
});

test('a partially-staged file (MM) lands in BOTH Staged and Changes', () => {
  const f = file('both.ts', 'M', 'M');
  const g = groupGitFiles([f]);
  // Staged half: the original object, staged slot intact → opens staged diff.
  assert.deepEqual(paths(g.staged), ['both.ts']);
  assert.equal(g.staged[0], f);
  assert.equal(g.staged[0].staged, 'M');
  // Changes half: a shallow copy with the staged slot blanked → opens combined diff.
  assert.deepEqual(paths(g.changes), ['both.ts']);
  assert.notEqual(g.changes[0], f, 'changes entry is a copy, not the original');
  assert.equal(g.changes[0].staged, ' ', 'staged slot blanked so GitChangedFile opens the combined diff');
  assert.equal(g.changes[0].worktree, 'M', 'worktree slot preserved');
  assert.equal(g.changes[0].path, 'both.ts');
});

test('a legacy committed file (no X/Y slots) falls through to Changes so it is never dropped', () => {
  const g = groupGitFiles([legacy('committed.ts', 'A')]);
  assert.deepEqual(paths(g.changes), ['committed.ts']);
  assert.deepEqual(paths(g.staged), []);
  assert.deepEqual(paths(g.merge), []);
});

test('a mixed set is bucketed and each bucket is sorted by path', () => {
  const g = groupGitFiles([
    file('z-wip.ts', ' ', 'M'),       // changes
    conflict('c-conflict.ts', 'AA'),  // merge
    file('a-staged.ts', 'A', ' '),    // staged
    file('m-both.ts', 'M', 'M'),      // staged + changes
    file('b-untracked.ts', '?', '?'), // changes
  ]);
  assert.deepEqual(paths(g.merge), ['c-conflict.ts']);
  assert.deepEqual(paths(g.staged), ['a-staged.ts', 'm-both.ts']);
  // m-both appears in changes too (staged slot blanked), alongside the pure changes.
  assert.deepEqual(paths(g.changes), ['b-untracked.ts', 'm-both.ts', 'z-wip.ts']);
});

test('unsorted input is sorted by path within every bucket (stable, flicker-free order)', () => {
  const g = groupGitFiles([
    file('c.ts', 'M', ' '),
    file('a.ts', 'M', ' '),
    file('b.ts', 'M', ' '),
  ]);
  assert.deepEqual(paths(g.staged), ['a.ts', 'b.ts', 'c.ts']);
});

test('only-blank-slot degenerate entries (X=" ", Y=" ") fall through to Changes', () => {
  // A real porcelain line never has both slots blank, but the helper must not
  // silently drop such an entry — it lands in Changes.
  const g = groupGitFiles([file('degenerate.ts', ' ', ' ')]);
  assert.deepEqual(paths(g.changes), ['degenerate.ts']);
});

console.log(`\n✓ SOURCE CONTROL TESTS PASS (${passed})`);
