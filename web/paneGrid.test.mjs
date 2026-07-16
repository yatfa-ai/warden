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
const { resolveVisibleTiles } = await import(tmpFile);
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

console.log(`\n✓ PANEGRID TESTS PASS (${passed})`);
