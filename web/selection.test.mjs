// Tests for the pure group-selection helpers in src/lib/selection.ts (WARDEN-371).
//
// These power the tri-state "select all in this section" checkbox in Fleet
// Health: isSelectedAll/isSomeSelected decide the checkbox's checked/indeterminate
// state, and toggleGroupSelection decides the next selection set on click. Pure
// string-Set logic with no runtime imports, so Vite's OXC transform emits clean
// ESM JS and the same transpile-to-temp-`.mjs` + dynamic `import()` harness used
// by kill.test.mjs loads the REAL module.
//
// The "selects exactly the section's rendered agents" + "intersects correctly
// with grouping/host-collapsed state" coverage lives here at the pure-seam level:
// the component computes `ids` (the agents rendered in a section, respecting the
// Closed-section bounding and host-collapse); these helpers are then tested
// against arbitrary id lists to prove the selection math is correct for any
// section shape the view produces.
//
// Run: node selection.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libDir = resolve(__dirname, 'src/lib');

// --- Load the REAL selection.ts (TS -> ESM via OXC) -------------------------
// selection.ts has no runtime imports, so no specifier rewriting is needed.
const selectionSrc = readFileSync(join(libDir, 'selection.ts'), 'utf8');
const { code: selectionCode } = await transformWithOxc(selectionSrc, join(libDir, 'selection.ts'), {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-selection-test-'));
const selectionFile = join(tmpDir, 'selection.mjs');
writeFileSync(selectionFile, selectionCode);

const { isSelectedAll, toggleGroupSelection } = await import(selectionFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

const set = (...ids) => new Set(ids);

// ---------------------------------------------------------------------------
console.log('\nisSelectedAll — checked state');
// ---------------------------------------------------------------------------
test('empty ids → false (a section with no agents is never "all selected")', () => {
  assert.equal(isSelectedAll(set('a', 'b'), []), false);
});
test('every id present → true', () => {
  assert.equal(isSelectedAll(set('a', 'b', 'c'), ['a', 'b']), true);
});
test('one id missing → false', () => {
  assert.equal(isSelectedAll(set('a', 'c'), ['a', 'b']), false);
});
test('empty selection but non-empty ids → false', () => {
  assert.equal(isSelectedAll(new Set(), ['a']), false);
});
test('extra selected ids outside the group do not affect the result', () => {
  // Selecting agents in other sections/groups must not flip this group's state.
  assert.equal(isSelectedAll(set('a', 'b', 'z'), ['a', 'b']), true);
});

// ---------------------------------------------------------------------------
console.log('\ntoggleGroupSelection — the next selection set on click');
// ---------------------------------------------------------------------------
test('empty selection → selects exactly the section ids (nothing more)', () => {
  const next = toggleGroupSelection(new Set(), ['a', 'b']);
  assert.deepEqual([...next].sort(), ['a', 'b']);
});
test('partial selection → fills to exactly the section ids', () => {
  const next = toggleGroupSelection(set('a', 'z'), ['a', 'b']);
  // 'z' (another section) is preserved; 'b' is added; result is a,b,z.
  assert.deepEqual([...next].sort(), ['a', 'b', 'z']);
});
test('full selection → deselects ONLY the section ids (other sections untouched)', () => {
  const next = toggleGroupSelection(set('a', 'b', 'z'), ['a', 'b']);
  assert.deepEqual([...next], ['z']);
});
test('toggle is idempotent across sections: toggling section A leaves section B intact', () => {
  // Start with B fully selected; toggling A on then off returns B unchanged.
  let sel = set('b1', 'b2'); // section B = [b1,b2] all selected
  sel = toggleGroupSelection(sel, ['a1', 'a2']); // select A
  assert.deepEqual([...sel].sort(), ['a1', 'a2', 'b1', 'b2']);
  sel = toggleGroupSelection(sel, ['a1', 'a2']); // deselect A
  assert.deepEqual([...sel].sort(), ['b1', 'b2']);
});
test('empty ids → no change to the selection (nothing to toggle)', () => {
  const before = set('a', 'b');
  const next = toggleGroupSelection(before, []);
  assert.deepEqual([...next].sort(), ['a', 'b']);
});
test('does not mutate the input set (returns a new Set)', () => {
  const before = set('a');
  const next = toggleGroupSelection(before, ['a', 'b']);
  assert.notEqual(next, before);
  assert.deepEqual([...before], ['a']); // input untouched
  assert.deepEqual([...next].sort(), ['a', 'b']);
});
test('a single-agent group toggles correctly', () => {
  let sel = toggleGroupSelection(new Set(), ['only']);
  assert.deepEqual([...sel], ['only']);
  sel = toggleGroupSelection(sel, ['only']);
  assert.deepEqual([...sel], []);
});

console.log(`\n✓ SELECTION TESTS PASS (${passed})`);
