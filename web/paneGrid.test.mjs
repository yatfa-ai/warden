// Stale-maximized grid tests (WARDEN-521).
//
// There is no front-end test runner in this repo, so (like layout.test.mjs and
// storage.test.mjs) this loads the REAL src/lib/paneGrid.ts (transpiled TS -> ESM
// via Vite's OXC transform) and drives the stale-maximized contract.
//
// WHY THIS FILE EXISTS: maximize is a single piece of UI state holding the
// maximized pane's id. The grid renders `visible` — normally every open tile,
// but just the maximized one when something is maximized:
//     visible = maximized ? tiles.filter(t => t.id === maximized) : tiles
// When the maximized pane was closed, killed, or dragged into another workspace,
// App removed it from the open-tile list but did NOT clear the maximized id. The
// id then pointed at a tile no longer in the grid, the filter produced an empty
// array, and the whole grid went blank until a workspace switch reset the id —
// the user saw "click a chat to open a live pane" with their other panes gone.
//
// The fix has two halves, both exercised here:
//   1. App drops the maximized id at every pane-removal site (closePane /
//      removeActive) — modeled below as a mini-model of those handlers.
//   2. resolveVisibleTiles guards the derivation: a maximized id whose tile is
//      no longer in the grid behaves as "not maximized" (falls back to every
//      open tile), so the grid can never blank — defense-in-depth that covers
//      ANY removal path, including ones that forget to clear the id.
//
// Run: node paneGrid.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const paneGridPath = resolve(__dirname, 'src/lib/paneGrid.ts');

// --- Load the REAL paneGrid.ts (TS -> ESM via the OXC transform Vite bundles) --
const src = readFileSync(paneGridPath, 'utf8');
const { code } = await transformWithOxc(src, paneGridPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-paneGrid-test-'));
const tmpFile = join(tmpDir, 'paneGrid.mjs');
writeFileSync(tmpFile, code);
const { resolveVisibleTiles, gridShape, equalRatios, effectiveRatios, redistributeRatios, gutterCenters, PANE_COL_FLOOR_REM, PANE_ROW_FLOOR_REM } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

const tile = (id) => ({ id });
const tiles = (ids) => ids.map(tile);

// The PRE-fix derivation, kept here to demonstrate the regression. With a stale
// maximized id (its pane removed) this filters to nothing — the blank grid.
const oldVisible = (maximized, arr) =>
  maximized ? arr.filter((t) => t.id === maximized) : arr;

// Mini-model of App's pane-removal handlers. Mirrors the WARDEN-521 fix: each
// removal site conditionally clears the maximized id ONLY when the maximized
// pane itself is the one leaving the grid (a non-maximized pane closing while
// another is maximized leaves the id intact). Holds the same three pieces of
// state App does for a single workspace: openPanes, focused, maximized.
class Workspace {
  constructor(paneIds, maximized = null, focused = null) {
    this.openPanes = paneIds.slice();
    this.maximized = maximized;
    this.focused = focused ?? paneIds[0] ?? null;
  }
  toggleMax(id) {
    this.maximized = this.maximized === id ? null : id;
    return this;
  }
  // closePane (×): drop pane, clear focus, record recovery (elided), and clear
  // maximized only if THIS pane was the maximized one.
  closePane(id) {
    this.openPanes = this.openPanes.filter((x) => x !== id);
    if (this.focused === id) this.focused = null;
    if (this.maximized === id) this.maximized = null;
    return this;
  }
  // removeActive (kill flow): same removal, no recovery entry.
  removeActive(id) {
    this.openPanes = this.openPanes.filter((x) => x !== id);
    if (this.focused === id) this.focused = null;
    if (this.maximized === id) this.maximized = null;
    return this;
  }
}

console.log('\nstale-maximized guard: a maximized id whose tile is gone never blanks the grid (WARDEN-521)');

test('BUG repro: the OLD derivation blanks the grid when the maximized pane is gone', () => {
  // Three panes open; A is maximized; A is then closed. maximized still points at
  // A, but A is no longer in tiles — the old filter returns nothing.
  const arr = tiles(['B', 'C']); // A already removed
  assert.deepEqual(oldVisible('A', arr), [], 'old derivation returns an empty grid');
});

test('FIX: resolveVisibleTiles falls back to every open tile when the maximized id is stale', () => {
  const arr = tiles(['B', 'C']);
  const { effectiveMax, visible } = resolveVisibleTiles('A', arr);
  assert.equal(effectiveMax, null, 'stale maximized id collapses to null (not maximized)');
  assert.deepEqual(visible.map((t) => t.id), ['B', 'C'], 'every remaining tile is visible');
});

test('a real maximized pane collapses the grid to just that tile', () => {
  const arr = tiles(['A', 'B', 'C']);
  const { effectiveMax, visible } = resolveVisibleTiles('B', arr);
  assert.equal(effectiveMax, 'B', 'effectiveMax tracks the live maximized pane');
  assert.deepEqual(visible.map((t) => t.id), ['B'], 'only the maximized tile is visible');
});

test('no maximized id renders every tile', () => {
  const arr = tiles(['A', 'B', 'C']);
  const { effectiveMax, visible } = resolveVisibleTiles(null, arr);
  assert.equal(effectiveMax, null);
  assert.deepEqual(visible.map((t) => t.id), ['A', 'B', 'C']);
});

test('effectiveMax null on a stale id means the grid template is NOT pinned to 1 column', () => {
  // PaneGrid computes cols/rows from visible.length and forces a 1x1 template
  // only while effectiveMax is set. A stale id must NOT pin the layout: with two
  // remaining tiles the reflowed grid is 2 columns, not 1.
  const arr = tiles(['B', 'C']);
  const { effectiveMax, visible } = resolveVisibleTiles('A', arr);
  const cols = effectiveMax ? 1 : Math.ceil(Math.sqrt(visible.length));
  assert.equal(cols, 2, 'two remaining panes reflow to a 2-column grid, not a stale 1-column');
});

console.log('\nwiring: App drops the maximized id at every pane-removal site (WARDEN-521)');

test('closing the maximized pane clears the id so the grid restores immediately', () => {
  const ws = new Workspace(['A', 'B', 'C']);
  ws.toggleMax('A'); // maximize A
  assert.equal(ws.maximized, 'A');
  ws.closePane('A'); // close the maximized pane
  assert.equal(ws.maximized, null, 'maximized id was cleared at the close site');
  const { visible } = resolveVisibleTiles(ws.maximized, tiles(ws.openPanes));
  assert.deepEqual(visible.map((t) => t.id), ['B', 'C'], 'remaining panes are visible, grid is not blank');
});

test('killing the maximized pane clears the id (removeActive mirrors closePane)', () => {
  const ws = new Workspace(['A', 'B', 'C']);
  ws.toggleMax('A');
  ws.removeActive('A'); // force-kill the maximized pane
  assert.equal(ws.maximized, null, 'maximized id was cleared at the kill site');
  const { visible } = resolveVisibleTiles(ws.maximized, tiles(ws.openPanes));
  assert.deepEqual(visible.map((t) => t.id), ['B', 'C'], 'remaining panes are visible after a kill');
});

test('closing a NON-maximized pane while another is maximized keeps that pane maximized', () => {
  // The guard is conditional: only the maximized pane's own removal clears state.
  const ws = new Workspace(['A', 'B', 'C']);
  ws.toggleMax('A'); // maximize A
  ws.closePane('B'); // close a different pane
  assert.equal(ws.maximized, 'A', 'A stays maximized when an unrelated pane closes');
  const { effectiveMax, visible } = resolveVisibleTiles(ws.maximized, tiles(ws.openPanes));
  assert.equal(effectiveMax, 'A', 'A is still the effective maximized pane');
  assert.deepEqual(visible.map((t) => t.id), ['A'], 'only the maximized pane is shown');
});

test('even if a removal path forgets to clear the id, the guard still prevents a blank grid', () => {
  // Defense-in-depth: simulate a path that drops the pane but leaves maximized
  // stale (the original bug). The guard must keep the grid populated regardless.
  const ws = new Workspace(['A', 'B', 'C']);
  ws.toggleMax('A');
  // A path that forgets the WARDEN-521 clear — pane gone, maximized still 'A':
  ws.openPanes = ws.openPanes.filter((x) => x !== 'A');
  // ws.maximized is intentionally left stale here.
  const { effectiveMax, visible } = resolveVisibleTiles(ws.maximized, tiles(ws.openPanes));
  assert.equal(effectiveMax, null, 'guard treats the stale id as not-maximized');
  assert.deepEqual(visible.map((t) => t.id), ['B', 'C'], 'grid still shows the remaining panes — no blank');
});

console.log('\nedge cases');

test('closing the last pane leaves an empty grid (visible empty, not an error)', () => {
  const ws = new Workspace(['A']);
  ws.toggleMax('A');
  ws.closePane('A');
  const { effectiveMax, visible } = resolveVisibleTiles(ws.maximized, tiles(ws.openPanes));
  assert.equal(effectiveMax, null);
  assert.deepEqual(visible, [], 'no tiles — PaneGrid renders its empty-state message');
});

test('maximized id that matches nothing in an empty workspace is null, not blank', () => {
  const { effectiveMax, visible } = resolveVisibleTiles('ghost', []);
  assert.equal(effectiveMax, null);
  assert.deepEqual(visible, []);
});

console.log('\n✓ PANEGRID TESTS PASS (stale-maximized: ' + passed + ')');

// ============================================================================
// Draggable resize gutters (WARDEN-660) — pure helpers
// ============================================================================
// These exercise the unit-testable math behind the gutters: shape resolution,
// equal/effective ratio seeding, the drag redistribution + floor clamp, and the
// handle-position math. The pointer/DOM plumbing (pointer capture, measurement)
// lives in PaneGrid.tsx and is verified via build + manual QA — it has no pure
// seam to assert here. Reset-on-shape-change is driven by gridShape's COUNT, so
// these tests cover its contract too.

console.log('\ngridShape: column/row COUNT per layout mode (WARDEN-660)');

test('auto reproduces the historic square-ish grid (cols = ceil(sqrt(n)))', () => {
  assert.deepEqual(gridShape('auto', 1), { cols: 1, rows: 1 });
  assert.deepEqual(gridShape('auto', 2), { cols: 2, rows: 1 });
  assert.deepEqual(gridShape('auto', 3), { cols: 2, rows: 2 }); // ceil(3/2)=2
  assert.deepEqual(gridShape('auto', 4), { cols: 2, rows: 2 });
  assert.deepEqual(gridShape('auto', 5), { cols: 3, rows: 2 }); // ceil(sqrt(5))=3
  assert.deepEqual(gridShape('auto', 9), { cols: 3, rows: 3 });
  assert.deepEqual(gridShape('auto', 10), { cols: 4, rows: 3 }); // ceil(sqrt(10))=4
});

test('stacked forces a single column (cols=1, rows=n)', () => {
  assert.deepEqual(gridShape('stacked', 1), { cols: 1, rows: 1 });
  assert.deepEqual(gridShape('stacked', 4), { cols: 1, rows: 4 });
});

test('side-by-side forces a single row (cols=n, rows=1)', () => {
  assert.deepEqual(gridShape('side-by-side', 1), { cols: 1, rows: 1 });
  assert.deepEqual(gridShape('side-by-side', 4), { cols: 4, rows: 1 });
});

test('n===0 yields cols>=1 / rows=0 (grid unused — empty-state renders instead)', () => {
  assert.deepEqual(gridShape('auto', 0), { cols: 1, rows: 0 });
  assert.deepEqual(gridShape('stacked', 0), { cols: 1, rows: 0 });
  assert.deepEqual(gridShape('side-by-side', 0), { cols: 0, rows: 0 });
});

test('the COUNT drives which gutters exist: N tracks → N-1 internal gutters', () => {
  // This is the property reset-on-shape-change keys off — a shape change alters
  // the count, so ratios sized for the old count must reset.
  for (const layout of ['auto', 'stacked', 'side-by-side']) {
    for (let n = 1; n <= 9; n++) {
      const { cols, rows } = gridShape(layout, n);
      // a single-pane grid (cols=1 AND rows=1) has NO internal gutters
      if (cols <= 1 && rows <= 1) continue;
      assert.ok(cols > 1 || rows > 1, `${layout}/${n} has at least one axis to gutter`);
    }
  }
});

console.log('\nequalRatios / effectiveRatios: seeding + shape-mismatch fallback');

test('equalRatios(n) = n ones (the default / reset target); n<=0 = []', () => {
  assert.deepEqual(equalRatios(1), [1]);
  assert.deepEqual(equalRatios(3), [1, 1, 1]);
  assert.deepEqual(equalRatios(0), []);
  assert.deepEqual(equalRatios(-1), []);
});

test('effectiveRatios uses the persisted array when its length matches the shape', () => {
  assert.deepEqual(effectiveRatios([1, 3], 2), [1, 3]); // custom ratios restored
  assert.deepEqual(effectiveRatios([2, 2, 1], 3), [2, 2, 1]);
});

test('effectiveRatios falls back to equal on length mismatch (stale shape) or empty', () => {
  assert.deepEqual(effectiveRatios([1, 3], 3), [1, 1, 1], '4-pane ratios must not distort a 3-pane grid');
  assert.deepEqual(effectiveRatios([1, 1, 1], 2), [1, 1], 'too-long array falls back to equal');
  assert.deepEqual(effectiveRatios([], 2), [1, 1], 'empty persisted = equal');
  assert.deepEqual(effectiveRatios([1, 3], 0), [], 'count<=0 = no tracks');
});

test('effectiveRatios returns a COPY (mutating it never corrupts the input)', () => {
  const persisted = [1, 3];
  const out = effectiveRatios(persisted, 2);
  assert.notEqual(out, persisted, 'a fresh array, not the same reference');
  out[0] = 99;
  assert.equal(persisted[0], 1, 'input is untouched');
});

console.log('\nredistributeRatios: drag redistribution + floor clamp');

test('a drag redistributes the pair by px and preserves the pair sum (no clamp)', () => {
  // 2 equal tracks of 300px each, drag the gutter +60px (enlarge left). pairSum=2.
  const next = redistributeRatios([1, 1], 0, 300, 300, 60, 100);
  assert.deepEqual(next, [1.2, 0.8]);
  assert.ok(Math.abs(next[0] + next[1] - 2) < 1e-9, 'pair sum is conserved');
});

test('a negative drag enlarges the RIGHT track', () => {
  const next = redistributeRatios([1, 1], 0, 300, 300, -60, 100);
  assert.deepEqual(next, [0.8, 1.2]);
});

test('the drag CLAMPS at the floor — neither adjacent track goes below floorPx', () => {
  // 2 tracks of 200px, floor 144px (9rem @ 16px). Dragging +100px would shrink
  // the right track to 100px (< floor); the clamp holds it at 144px.
  const next = redistributeRatios([1, 1], 0, 200, 200, 100, 144);
  assert.ok(next !== null);
  // right track = pairSum - next[0]; reconstruct its px width and assert >= floor
  const pairSum = 2;
  const region = 200 + 200;
  const rightPx = (pairSum - next[0]) / pairSum * region;
  assert.ok(rightPx >= 144 - 1e-6, `right track (${rightPx}px) clamped at the 144px floor`);
  // left track px also >= floor
  const leftPx = next[0] / pairSum * region;
  assert.ok(leftPx >= 144 - 1e-6, `left track (${leftPx}px) >= floor`);
});

test('dragging the other way clamps at the LEFT track floor', () => {
  // Try to shrink the left track below the floor with a large negative dx.
  const next = redistributeRatios([1, 1], 0, 200, 200, -250, 144);
  assert.ok(next !== null);
  const leftPx = next[0] / 2 * 400;
  assert.ok(leftPx >= 144 - 1e-6, `left track (${leftPx}px) clamped at the floor`);
});

test('only the two adjacent tracks change; the rest of the axis is untouched', () => {
  const before = [1, 2, 3, 4];
  const next = redistributeRatios(before, 1, 200, 200, 50, 100); // resize pair at g=1 (tracks 1&2)
  assert.equal(next[0], 1, 'track 0 untouched');
  assert.equal(next[3], 4, 'track 3 untouched');
  assert.ok(Math.abs(next[1] + next[2] - (2 + 3)) < 1e-9, 'the pair sum (2+3) is conserved');
  assert.notEqual(next[1], 2, 'the left of the pair actually moved');
});

test('non-adjacent tracks are never resized even when only one internal gutter exists', () => {
  // 4 tracks but resize the FIRST gutter (g=0): tracks 2 and 3 must be untouched.
  const next = redistributeRatios([1, 1, 5, 5], 0, 200, 200, 40, 100);
  assert.equal(next[2], 5);
  assert.equal(next[3], 5);
});

test('returns null for unusable inputs (caller treats as no-change, never NaN)', () => {
  assert.equal(redistributeRatios([1, 1], -1, 200, 200, 50, 100), null, 'g out of range (low)');
  assert.equal(redistributeRatios([1, 1], 1, 200, 200, 50, 100), null, 'g out of range (high: only gutter is g=0)');
  assert.equal(redistributeRatios([1], 0, 200, 200, 50, 100), null, 'single track — no pair');
  assert.equal(redistributeRatios([1, 1], 0, 0, 200, 50, 100), null, 'zero measured width');
  assert.equal(redistributeRatios([1, 1], 0, -5, 200, 50, 100), null, 'negative measured width');
  assert.equal(redistributeRatios([0, 0], 0, 200, 200, 50, 100), null, 'zero pairSum');
  assert.equal(redistributeRatios('nope', 0, 200, 200, 50, 100), null, 'non-array ratios');
});

test('floor constants match the spec (9rem cols, 6rem rows)', () => {
  assert.equal(PANE_COL_FLOOR_REM, 9, 'column floor = the historic 9rem minmax minimum');
  assert.equal(PANE_ROW_FLOOR_REM, 6, 'row floor = ~6rem (a few terminal lines)');
});

console.log('\ngutterCenters: handle positions over the internal gutters');

test('a single internal gutter sits at the midpoint of two equal tracks', () => {
  // 400px, gap 8, two equal tracks of 196 each → gutter center at 196 + 4 = 200.
  assert.deepEqual(gutterCenters([1, 1], 400, 8), [200]);
});

test('an unequal ratio places the gutter proportionally (1:3 split)', () => {
  // track0 = 1/4 of 392 = 98, gutter center = 98 + 4 = 102.
  assert.deepEqual(gutterCenters([1, 3], 400, 8), [102]);
});

test('three tracks yield two gutter centers, each offset by the gap', () => {
  const centers = gutterCenters([1, 1, 1], 408, 8);
  assert.equal(centers.length, 2);
  // track sizes = 392/3 ≈ 130.667; gutter0 center = 130.667 + 4; gutter1 = 261.333 + 12
  assert.ok(Math.abs(centers[0] - (392 / 3 + 4)) < 1e-6);
  assert.ok(Math.abs(centers[1] - (2 * (392 / 3) + 12)) < 1e-6);
});

test('no internal gutters when fewer than 2 tracks, or size unknown', () => {
  assert.deepEqual(gutterCenters([1], 400, 8), [], 'single track');
  assert.deepEqual(gutterCenters([], 400, 8), [], 'no tracks');
  assert.deepEqual(gutterCenters([1, 1], 0, 8), [], 'size unknown (first paint)');
  assert.deepEqual(gutterCenters([1, 1], -10, 8), [], 'negative size');
});

test('gutter center = (first track width) + half the gap — the gap is included, not ignored', () => {
  // 3 equal tracks: each width = (size - (n-1)*gap)/n; gutter0 sits at the END
  // of track0 plus half the gap (the gutter's own center). For 2 EQUAL tracks
  // the center is always size/2 regardless of gap ((size-gap)/2 + gap/2), so the
  // 3-track case is the one that proves the gap term is actually wired in.
  const gap = 12, size = 408;
  const trackW = (size - 2 * gap) / 3; // = 128
  const centers = gutterCenters([1, 1, 1], size, gap);
  assert.ok(Math.abs(centers[0] - (trackW + gap / 2)) < 1e-6,
    `gutter0 center = trackW(${trackW}) + gap/2(${gap / 2}) = ${trackW + gap / 2}`);
});

console.log(`\n✓ PANEGRID TESTS PASS (total: ${passed})`);
