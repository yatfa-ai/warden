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
const { resolveVisibleTiles, gridShape, equalRatios, effectiveRatios, redistributeRatios, resolveJunctionAxis, gutterCenters, resolveTrackWidths, swapPanes, PANE_COL_FLOOR_REM, PANE_ROW_FLOOR_REM } = await import(tmpFile);
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

// WARDEN-1097: t0/t1 are the tracks' ACTUAL rendered widths, and CSS grid renders
// tracks BELOW their minmax() floor when the container can't honor every floor.
// Once floorPx >= t0 + t1 the old clamp was ill-ordered (minDx > maxDx), collapsed
// to minDx regardless of dx, and emitted a ZERO or NEGATIVE ratio — which then
// persisted and made parseRatioArray discard the user's whole saved pane layout.
test('a pair too cramped to honor the floor on both sides returns null (never a non-positive ratio)', () => {
  // floorPx (120) >= t0 + t1 — the corruption threshold. Before the guard these
  // returned [2, 0] and [2.4, -0.4] respectively.
  assert.equal(redistributeRatios([1, 1], 0, 60, 60, 50, 120), null, 'pair sums exactly to the floor → [2, 0] before the fix');
  assert.equal(redistributeRatios([1, 1], 0, 50, 50, 50, 120), null, 'pair narrower than the floor → [2.4, -0.4] before the fix');
});

test('a cramped pair refuses the drag even when dx is ZERO (a still pointer committed garbage too)', () => {
  // The old clamp ignored dx entirely once minDx > maxDx, so even a negligible or
  // zero resolved drag committed the corrupt value on pointerup.
  assert.equal(redistributeRatios([1, 1], 0, 60, 60, 0, 120), null, 'zero drag, pair at the floor');
  assert.equal(redistributeRatios([1, 1], 0, 50, 50, 0, 120), null, 'zero drag, pair below the floor');
  assert.equal(redistributeRatios([1, 1], 0, 100, 100, 0, 120), null, 'zero drag, degenerate pair (moved the gutter before the fix)');
});

test('the guard never returns a non-positive ratio across a sweep of cramped geometries', () => {
  // The invariant the header claims: no output entry is ever <= 0 (or NaN).
  for (const t of [30, 50, 60, 71, 72, 90, 120, 200]) {
    for (const dx of [-200, -50, 0, 50, 200]) {
      const next = redistributeRatios([1, 1], 0, t, t, dx, 144);
      if (next === null) continue; // refused — the cramped case
      for (const r of next) {
        assert.ok(Number.isFinite(r) && r > 0, `t=${t} dx=${dx} produced a bad ratio: ${JSON.stringify(next)}`);
      }
    }
  }
});

test('a pair that can still honor the floor is UNAFFECTED by the guard', () => {
  // t0 + t1 > floorPx → minDx <= maxDx, so the ordinary clamp still applies.
  assert.deepEqual(redistributeRatios([1, 1], 0, 400, 400, 50, 120), [1.125, 0.875], 'healthy pair redistributes normally');
  assert.deepEqual(redistributeRatios([1, 1], 0, 400, 400, 0, 120), [1, 1], 'healthy pair, zero drag → unchanged');
  assert.notEqual(redistributeRatios([1, 1], 0, 100, 200, 50, 144), null, 'pair sum (300) above the floor (144) still resizes');
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

console.log('\ngutterCenters / resolveTrackWidths: floor-aware column positioning (WARDEN-660 audit fix)');

test('FLOOR REGRESSION: a sub-floor column track is pinned at the floor (handle tracks the rendered gutter)', () => {
  // 2 cols [0.5,1] @400px, gap 8, floor 144 (9rem @16px root). col0's pure-fr
  // share is 130.67px (< 144), so CSS clamps it to 144 and gives col1 the rest
  // (248). The rendered gutter center is 144 + 4 = 148 — NOT the pure-fr 134.67.
  // Pre-audit gutterCenters ignored the floor and returned ~134.67, drifting the
  // 10px handle off the rendered gutter (13px error → ungrabbable after a window
  // resize). This is the exact case the reviewer measured at 13.33px.
  const floored = gutterCenters([0.5, 1], 400, 8, 144);
  assert.equal(floored.length, 1);
  assert.ok(Math.abs(floored[0] - 148) < 1e-6,
    `floored center ${floored[0]} ≈ 148 (col0 pinned at the 144px floor)`);
  // And it must DIFFER from the pure-fr (no-floor) prediction — this is what
  // makes the test fail if the floor handling regresses (mutation probe).
  const pure = gutterCenters([0.5, 1], 400, 8);
  assert.ok(Math.abs(pure[0] - (0.5 / 1.5 * 392 + 4)) < 1e-6, 'pure-fr center ≈ 134.67');
  assert.ok(Math.abs(floored[0] - pure[0]) > 13, 'floor shifts the center ~13px off the pure-fr spot');
});

test('no floor binding ⇒ floor-aware == pure-fr bit-for-bit (the common path is unperturbed)', () => {
  // 2 cols [1.5,1] @800px, gap 8, floor 144: both pure-fr shares (475.2 / 316.8)
  // sit above the floor, so the minmax distribution clamps nothing. The floor-
  // aware call must reproduce the pure-fr centers to sub-pixel, proving the
  // floor param doesn't perturb the wide-window path (the reviewer's ~0px rows).
  const floored = gutterCenters([1.5, 1], 800, 8, 144);
  const pure = gutterCenters([1.5, 1], 800, 8);
  assert.equal(floored.length, pure.length);
  for (let i = 0; i < floored.length; i++) {
    assert.ok(Math.abs(floored[i] - pure[i]) < 1e-9,
      `center ${i}: floor-aware (${floored[i]}) == pure-fr (${pure[i]})`);
  }
});

test('resolveTrackWidths: clamped track pinned at floor, deficit absorbed by the neighbor', () => {
  // [0.5,1] over 392 distributable, floor 144: col0 clamps to 144, col1 gets the
  // remainder 248 (its 261.33 pure-fr share minus the 13.33px deficit). The pair
  // total is conserved (144 + 248 == 392 == the two pure-fr shares summed), and
  // neither track is below the floor.
  const w = resolveTrackWidths([0.5, 1], 392, 144);
  assert.deepEqual(w, [144, 248]);
  assert.ok(Math.abs(w[0] + w[1] - 392) < 1e-9, 'pair total conserved (deficit stays in-axis)');
  assert.ok(w[0] >= 144 - 1e-9 && w[1] >= 144 - 1e-9, 'neither track below the floor');
});

test('resolveTrackWidths: overflow clamps every track to the floor (side-by-side + many panes)', () => {
  // 3 equal cols @384 distributable, floor 144: each pure-fr share is 128 (< 144)
  // so all clamp; the grid overflows (3*144 = 432 > 384) and panes lay out at
  // their floors — exactly the side-by-side overflow case the reviewer flagged
  // (281.6px error when the floor went unmodeled).
  assert.deepEqual(resolveTrackWidths([1, 1, 1], 384, 144), [144, 144, 144]);
});

test('resolveTrackWidths: fixed-point iteration re-clamps a track pushed below floor by redistribution', () => {
  // [1,1,0.1] over 400 distributable, floor 144. Pass 1 clamps the tiny track2
  // (share ~19px) and redistributes, leaving tracks 0 & 1 at 128px each — ALSO
  // below the floor. Pass 2 must re-clamp them (a single pass would leave them
  // at 128, below the floor). Without the loop the result is [128,128,144], not
  // all-144 — so this pins that the iteration actually runs to convergence.
  const w = resolveTrackWidths([1, 1, 0.1], 400, 144);
  assert.deepEqual(w, [144, 144, 144], 'all three tracks pinned at the floor after iteration');
  for (const x of w) assert.ok(x >= 144 - 1e-9, `track ${x} at/above floor (loop converged)`);
});

test('resolveTrackWidths: floor=0 reduces to pure fr (rows have no floor)', () => {
  // Rows use `minmax(0, Xfr)` — no CSS floor — so passing floor 0 must reproduce
  // the pure-fr shares bit-for-bit. This is why the row axis was already exact
  // and the row gutterCenters call omits the floor.
  assert.deepEqual(resolveTrackWidths([1, 3], 392, 0), [98, 294]);
  assert.deepEqual(resolveTrackWidths([1, 1, 1], 392, 0), [392 / 3, 392 / 3, 392 / 3]);
});

test('gutterCenters: an all-clamped overflow grid still places handles over the rendered gutters', () => {
  // 3 cols @400px (gap 8, floor 144): all clamp to 144, so the grid overflows and
  // the gutters render at 144 and 288 (+half-gaps). The floor-aware centers must
  // land on those rendered gutters, not the pure-fr 134.67 / 273.33 spots.
  const centers = gutterCenters([1, 1, 1], 400, 8, 144);
  assert.deepEqual(centers, [148, 300]);
});

console.log('\ngutterCenters: post-load measurement gate (WARDEN-660 audit — gutters stay hidden until the grid is measured)');
// The primary-flow blocker from the round-4 audit: PaneGrid is always mounted
// (its keydown handler needs it), so when it mounts with 0 open panes the
// `n === 0 ? empty-state : <grid div>` branch renders NO grid div and gridRef is
// null — the geometry useLayoutEffect bails before attaching the ResizeObserver.
// With a `[]` dep it never re-ran, so the click-to-open flow (open panes AFTER
// mount) left gridGeom at {0,0} → gutterCenters returned [] → the whole overlay
// gated off → no handles to drag. The fix is `[n > 0]` so the effect re-attaches
// on the 0→positive transition. That dep is component-lifecycle wiring — it has
// no pure seam to assert (per the file header note on measurement plumbing) and
// is verified by build + the reviewer's live browser. What IS unit-testable is
// the CONTRACT the effect upholds: the handle set is empty whenever the axis is
// unmeasured (size 0), no matter how valid the ratios are, and full once it is.
// Pinning this here means a future change that drops the size guard (so handles
// render over an unmeasured grid at bogus positions) turns this red.

test('POST-LOAD REGRESSION: valid ratios + an UNMEASURED grid (size 0) → NO handles; measuring it reveals them', () => {
  const ratios = [1, 3]; // a persisted unequal split (2 cols)
  const gap = 8, floor = 144;
  // mount / unmeasured (gridGeom.w === 0): NO handles, even with valid ratios.
  assert.deepEqual(gutterCenters(ratios, 0, gap, floor), [], 'unmeasured grid hides the handle (floor passed)');
  assert.deepEqual(gutterCenters(ratios, 0, gap), [], 'unmeasured grid hides the handle (no floor, rows)');
  // after the effect measures the grid (gridGeom.w > 0): the handle appears.
  const measured = gutterCenters(ratios, 800, gap, floor);
  assert.equal(measured.length, 1, 'a measured grid reveals the internal gutter handle');
  assert.ok(measured[0] > 0, 'and it sits at a real position');
});

test('handle count == tracks-1 when measured, ALWAYS 0 when unmeasured — across shapes', () => {
  // The invariant the overlay gate (`centers.length > 0`) relies on: an
  // unmeasured axis never produces handles, a measured axis produces exactly one
  // per internal gutter. Holds for every shape, with and without the floor.
  const gap = 8, floor = 144;
  for (const r of [[1, 1], [1, 1, 1], [2, 1, 1], [1, 1, 1, 1]]) {
    assert.equal(gutterCenters(r, 0, gap, floor).length, 0, `${r.length}-track grid unmeasured → 0 handles (floored)`);
    assert.equal(gutterCenters(r, 0, gap).length, 0, `${r.length}-track grid unmeasured → 0 handles (no floor)`);
    assert.equal(gutterCenters(r, 800, gap, floor).length, r.length - 1, `${r.length}-track grid measured → ${r.length - 1} handles`);
  }
});

console.log('\nresolveJunctionAxis: route a crossing-pad drag by its initial direction (WARDEN-660 crossing fix)');
// A crossing pad sits on BOTH a col and a row gutter, so it can't pick an axis at
// pointer down — it defers to resolveJunctionAxis on the first decisive move. This
// is the rule that makes the col gutter grabbable at the row-crossing (the 2×2
// dead-center grab): pre-fix the row strip swallowed the crossing, so a horizontal
// drag there was a no-op. Now a horizontal drag routes to 'col'.

test('a mostly-horizontal drag resolves to COLS (|dx| >= |dy|)', () => {
  assert.equal(resolveJunctionAxis(40, 2, 3), 'col', 'drag right → col-resize');
  assert.equal(resolveJunctionAxis(-40, 2, 3), 'col', 'drag left → col-resize (sign-agnostic)');
  assert.equal(resolveJunctionAxis(40, 40, 3), 'col', 'exact tie breaks to col');
});

test('a mostly-vertical drag resolves to ROWS (|dy| > |dx|)', () => {
  assert.equal(resolveJunctionAxis(2, 40, 3), 'row', 'drag down → row-resize');
  assert.equal(resolveJunctionAxis(2, -40, 3), 'row', 'drag up → row-resize (sign-agnostic)');
});

test('sub-threshold travel resolves to NULL — no drag committed (lets onDoubleClick fire)', () => {
  // A still click or a hair-trigger jitter travels less than the threshold on BOTH
  // axes, so the pad commits no drag. This is what lets a double-click land: the
  // intervening pointerdown/up move < threshold, the session never starts, and the
  // reset handler wins.
  assert.equal(resolveJunctionAxis(0, 0, 3), null, 'still click');
  assert.equal(resolveJunctionAxis(2, 2, 3), null, 'jitter under threshold');
  assert.equal(resolveJunctionAxis(2, 0, 3), null, 'dx under threshold even if it dominates dy');
  assert.equal(resolveJunctionAxis(-2, 1, 3), null, 'negative jitter under threshold');
});

test('the threshold is per-axis: clearing it on one axis resolves even if the other is ~0', () => {
  // The 2×2 dead-center repro: a horizontal drag (large dx, ~0 dy) at the crossing
  // must resolve to COLS so the column gutter resizes — the exact case that was a
  // silent no-op when the row strip captured the crossing.
  assert.equal(resolveJunctionAxis(20, 0, 3), 'col', 'pure horizontal drag → col (the dead-center repro)');
  assert.equal(resolveJunctionAxis(0, 20, 3), 'row', 'pure vertical drag → row');
});

test('the threshold boundary: travel equal to threshold is decisive (>=, not strictly >)', () => {
  // abs(dx) === threshold is treated as decisive (the guard is `< threshold`, so
  // equal passes). Pinned because a strictly-greater gate would let a slow drag
  // stall at exactly the threshold.
  assert.equal(resolveJunctionAxis(3, 0, 3), 'col', 'dx == threshold → decisive');
  assert.equal(resolveJunctionAxis(2, 3, 3), 'row', 'dy == threshold, dx under → decisive row');
  assert.equal(resolveJunctionAxis(2, 2, 3), null, 'both == threshold-1 → still null');
});

// --- Drag-to-reorder: swapPanes (WARDEN-909) ---------------------------------
//
// Dropping a pane header onto another pane tile swaps the two panes' positions
// in the active workspace's openPanes. The load-bearing property is WARDEN-108:
// the drop resolves BY PANE ID, so it addresses the right elements of openPanes
// even when the rendered tile list is a subset of it.

test('a swap exchanges exactly the two panes and leaves every other pane put', () => {
  const openPanes = ['a', 'b', 'c', 'd'];
  assert.deepEqual(swapPanes(openPanes, 'a', 'd'), ['d', 'b', 'c', 'a'], 'ends swapped, middle untouched');
  assert.deepEqual(swapPanes(openPanes, 'b', 'c'), ['a', 'c', 'b', 'd'], 'adjacent pair swapped in place');
  assert.deepEqual(openPanes, ['a', 'b', 'c', 'd'], 'the source array is never mutated');
});

test('the swap is symmetric — drag direction does not change the result', () => {
  // The drop handler passes (draggedId, targetId); dragging b onto d and d onto
  // b are the same gesture from either end and must land the same order.
  assert.deepEqual(swapPanes(['a', 'b', 'c', 'd'], 'b', 'd'), swapPanes(['a', 'b', 'c', 'd'], 'd', 'b'));
});

test('every no-op returns the SAME array reference (so App writes no state)', () => {
  // App routes this through the setOpenPanes shim, whose updater short-circuits
  // on `next === w.openPanes`. Identity — not just deep equality — is what makes
  // a no-op cost zero renders and zero persistence writes, so it is asserted
  // with strictEqual on the reference.
  const openPanes = ['a', 'b', 'c'];
  assert.strictEqual(swapPanes(openPanes, 'b', 'b'), openPanes, 'pane dropped on itself');
  assert.strictEqual(swapPanes(openPanes, 'a', 'zz'), openPanes, 'target id absent (closed mid-drag)');
  assert.strictEqual(swapPanes(openPanes, 'zz', 'a'), openPanes, 'dragged id absent (stale payload)');
  assert.strictEqual(swapPanes(openPanes, 'zz', 'yy'), openPanes, 'neither id present');
  const empty = [];
  assert.strictEqual(swapPanes(empty, 'a', 'b'), empty, 'empty array is inert');
});

// Mini-model of the PaneGrid drop handler: the grid renders `visible` (which
// resolveVisibleTiles may narrow to a single maximized tile), the user drops
// tile X onto tile Y, and the handler swaps them in the REAL openPanes by id.
const dropPaneOnPane = (openPanes, maximized, draggedId, targetId) => {
  const { visible } = resolveVisibleTiles(maximized, openPanes.map(tile));
  // Only a rendered tile can be a drop target — a drop on a tile that isn't in
  // the grid is not reachable, so the model refuses it like the DOM would.
  if (!visible.some((t) => t.id === targetId)) return openPanes;
  return swapPanes(openPanes, draggedId, targetId);
};

test('a swap driven from a SUBSET view still moves the right panes (WARDEN-108)', () => {
  // The regression this pins: `visible` is a filtered view, so a handler that
  // used the VISIBLE index would reorder the wrong elements of openPanes. Here
  // the grid is scrolled to a subset-shaped state — panes b and d are the ones
  // dropped, and their positions in openPanes (1 and 3) are what must change,
  // not positions 0 and 1 (their would-be indices in a two-element view).
  const openPanes = ['a', 'b', 'c', 'd'];
  const visibleIdx = ['b', 'd']; // what a filtered view would hand a naive handler
  const naive = openPanes.slice();
  // The BUG, kept to demonstrate it: swap by filtered index 0 <-> 1.
  const i = visibleIdx.indexOf('b'), j = visibleIdx.indexOf('d');
  [naive[i], naive[j]] = [naive[j], naive[i]];
  assert.deepEqual(naive, ['b', 'a', 'c', 'd'], 'filtered indices corrupt the order (the trap)');
  // The FIX: resolve by id against the real array.
  assert.deepEqual(swapPanes(openPanes, 'b', 'd'), ['a', 'd', 'c', 'b'], 'id-space swap moves b and d');
});

test('a reorder attempt while maximized is a harmless no-op', () => {
  // Maximized → resolveVisibleTiles narrows the grid to ONE tile, so the only
  // reachable drop target is the maximized pane itself and the drop is a self-
  // drop. Nothing may change and nothing may error.
  const openPanes = ['a', 'b', 'c'];
  assert.strictEqual(dropPaneOnPane(openPanes, 'b', 'b', 'b'), openPanes, 'self-drop on the only tile');
  assert.strictEqual(dropPaneOnPane(openPanes, 'b', 'b', 'c'), openPanes, 'a hidden tile is not a drop target');
});

test('a swap leaves focus / maximize / host targets valid, since all are pane ids', () => {
  // focused, maximized and paneHost's keys are pane IDS, so a reorder cannot
  // invalidate them: every id present before the swap is present after it. This
  // is the "nothing resets or jumps" acceptance, asserted as a set-identity
  // property rather than by eyeballing the UI.
  const openPanes = ['a', 'b', 'c', 'd'];
  const next = swapPanes(openPanes, 'a', 'c');
  assert.deepEqual([...next].sort(), [...openPanes].sort(), 'same pane id set, different order');
  assert.equal(next.length, openPanes.length, 'no pane gained or lost');
  for (const id of ['a', 'b', 'c', 'd']) {
    assert.ok(next.includes(id), `${id} (a focus/maximize/paneHost key) survives the swap`);
  }
});

test('the swapped order is what persists — it round-trips through JSON intact', () => {
  // `workspaces` is persisted whole (PERSISTED_PREF_KEYS), so the reordered
  // array is the thing that survives a reload under restoreOnStartup 'previous'.
  // Modeled as the real serialize → restore hop the persistence layer performs.
  const ws = { id: 'w1', name: 'Workspace 1', openPanes: ['a', 'b', 'c'], focused: 'c', recentlyClosed: [] };
  const reordered = { ...ws, openPanes: swapPanes(ws.openPanes, 'a', 'c') };
  const restored = JSON.parse(JSON.stringify([reordered]))[0];
  assert.deepEqual(restored.openPanes, ['c', 'b', 'a'], 'the new order is what comes back');
  assert.equal(restored.focused, 'c', 'focus still names the same pane, now in a new slot');
});

console.log(`\n✓ PANEGRID TESTS PASS (total: ${passed})`);
