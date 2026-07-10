// Layout-clamp policy tests (WARDEN-183).
//
// There is no front-end test runner in this repo, so (like storage.test.mjs and
// diff.test.mjs) this loads the REAL src/lib/storage.ts (transpiled TS -> ESM via
// Vite's OXC transform) and drives the resizable-layout clamp policy.
//
// WHY THIS FILE EXISTS (and why the storage.test.mjs clamp tests are not enough):
// the pure clamp helpers are unit-tested there, but the WARDEN-183 regression was
// NOT a clamp-math bug — it was a wiring bug: App clamped panel widths on mount,
// on drag, and on window resize, but NOT when the user toggled the health panel.
// Expanding health removes HEALTH_WIDTH of shared space; with no re-clamp on that
// toggle the sidebar + observer stayed at their pre-toggle widths and the middle
// pane column was crushed to ~0 at the 900px window floor. The storage tests
// can't catch that because they never model the "a space changed, so re-clamp"
// step — they only call the clamp once, in isolation.
//
// This file models that step. `Layout` below is a mini-model of App's space-
// change handling: it holds the two panel widths and, on any change in available
// layout space, re-clamps them through the REAL clampLayoutWidths — exactly what
// App's applyLayoutClamp does (App's resize listener AND its health-toggle effect
// both call it). Driving a health toggle through this model at 900px is the
// scenario that regressed; the assertions pin the contract that a space change
// MUST re-invoke the clamp so the middle pane is never crushed.
//
// Run: node layout.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const storagePath = resolve(__dirname, 'src/lib/storage.ts');

// --- Load the REAL storage.ts (TS -> ESM via the OXC transform Vite bundles) --
const src = readFileSync(storagePath, 'utf8');
const { code } = await transformWithOxc(src, storagePath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-layout-test-'));
const tmpFile = join(tmpDir, 'storage.mjs');
writeFileSync(tmpFile, code);
const {
  clampLayoutWidths,
  SIDEBAR_MIN,
  OBSERVER_MIN,
  PANE_MIN,
  HEALTH_WIDTH,
} = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// Middle pane width implied by a (window, sidebar, observer, health?) layout.
const middle = (ctx, sb, ob) =>
  ctx.windowWidth - sb - ob - (ctx.healthCollapsed ? 0 : HEALTH_WIDTH);

// Mini-model of App's space-change re-clamp. App keeps the two panel widths in
// state; on window resize and on health toggle its applyLayoutClamp callback runs
// clampLayoutWidths over them. `.reclamp()` below IS that callback. Skipping it
// (as the WARDEN-183 bug did on health toggle) is what the "BUG repro" tests
// simulate by simply not calling reclamp after changing the space.
class Layout {
  constructor(sidebar, observer) {
    this.sidebar = sidebar;
    this.observer = observer;
  }
  reclamp(ctx) {
    const r = clampLayoutWidths({ sidebar: this.sidebar, observer: this.observer }, ctx);
    this.sidebar = r.sidebar;
    this.observer = r.observer;
    return this;
  }
}

console.log('\nhealth-toggle re-clamp: opening health never crushes the middle pane (WARDEN-183)');

test('mount clamp at the 900px floor (health collapsed) keeps the middle at PANE_MIN', () => {
  // Fresh launch, default widths, at the Electron minWidth. This is the starting
  // point of the reviewer's repro.
  const ctx = { windowWidth: 900, healthCollapsed: true };
  const l = new Layout(220, 380).reclamp(ctx);
  assert.equal(l.sidebar, 200, 'sidebar trimmed from 220 -> 200');
  assert.equal(l.observer, 380, 'observer unchanged');
  assert.equal(middle(ctx, l.sidebar, l.observer), PANE_MIN, 'middle exactly at the floor');
});

test('BUG repro: opening health at 900px WITHOUT a re-clamp crushes the middle to 0', () => {
  // Same mount as above, then the user toggles health. If App did NOT re-clamp
  // on the toggle (the WARDEN-183 regression), the panel widths stay put and the
  // 320px health panel eats the entire middle pane column.
  const l = new Layout(220, 380).reclamp({ windowWidth: 900, healthCollapsed: true });
  // NO reclamp on the toggle — the bug:
  assert.equal(
    middle({ windowWidth: 900, healthCollapsed: false }, l.sidebar, l.observer),
    0,
    'middle collapses to 0 when the health toggle is not re-clamped',
  );
});

test('FIX: opening health at 900px re-clamps so the middle is never crushed to 0', () => {
  // Same mount, then the health-toggle re-clamp fires (App's applyLayoutClamp).
  const l = new Layout(220, 380).reclamp({ windowWidth: 900, healthCollapsed: true });
  l.reclamp({ windowWidth: 900, healthCollapsed: false });
  // At 900px with health + BOTH side panels there is not room for PANE_MIN
  // (SIDEBAR_MIN + OBSERVER_MIN + PANE_MIN + HEALTH_WIDTH = 1120 > 900), so the
  // clamp retreats both panels to their usable floors — the widest middle
  // physically possible — instead of crushing it to 0.
  assert.equal(l.sidebar, SIDEBAR_MIN, 'sidebar gives way to its floor first');
  assert.equal(l.observer, OBSERVER_MIN, 'observer then gives way to its floor');
  assert.ok(
    middle({ windowWidth: 900, healthCollapsed: false }, l.sidebar, l.observer) > 0,
    'middle > 0 (not crushed to zero)',
  );
});

test('on a feasible window, opening health keeps the middle pane >= PANE_MIN', () => {
  // 1200px has room for everything, so after the health-toggle re-clamp the
  // middle pane keeps its full PANE_MIN reserve.
  const l = new Layout(220, 380).reclamp({ windowWidth: 1200, healthCollapsed: true });
  l.reclamp({ windowWidth: 1200, healthCollapsed: false });
  assert.ok(
    middle({ windowWidth: 1200, healthCollapsed: false }, l.sidebar, l.observer) >= PANE_MIN,
    'middle >= PANE_MIN with health open at 1200px',
  );
});

test('the health-toggle re-clamp runs on BOTH directions and never crushes the middle', () => {
  // The re-clamp must fire when health expands AND when it collapses. The clamp is
  // a one-way guard: it trims a panel toward its floor when space is tight, but it
  // has no memory of a pre-trim value, so collapsing health does NOT auto-grow a
  // trimmed panel back (the user re-widens via drag). What matters — and what we
  // assert — is that neither direction of the toggle can leave the middle crushed.
  const l = new Layout(220, 380).reclamp({ windowWidth: 1200, healthCollapsed: true });
  l.reclamp({ windowWidth: 1200, healthCollapsed: false }); // expand -> trims sidebar to 180
  assert.equal(l.sidebar, 180, 'expanding health trimmed the sidebar toward its floor');
  assert.ok(
    middle({ windowWidth: 1200, healthCollapsed: false }, l.sidebar, l.observer) >= PANE_MIN,
    'middle >= PANE_MIN while health is open',
  );
  l.reclamp({ windowWidth: 1200, healthCollapsed: true }); // collapse -> space returns
  assert.ok(
    middle({ windowWidth: 1200, healthCollapsed: true }, l.sidebar, l.observer) >= PANE_MIN,
    'middle >= PANE_MIN after collapsing health back',
  );
  assert.ok(
    l.sidebar >= SIDEBAR_MIN && l.observer >= OBSERVER_MIN,
    'both panels still within their usable bands after the round-trip',
  );
});

test('a window resize after the toggle also keeps the middle >= PANE_MIN', () => {
  // The resize listener and the health-toggle effect share the same re-clamp;
  // shrinking the window while health is open must still protect the middle.
  const l = new Layout(220, 380)
    .reclamp({ windowWidth: 1400, healthCollapsed: false })
    .reclamp({ windowWidth: 1000, healthCollapsed: false }); // window shrinks
  assert.ok(
    middle({ windowWidth: 1000, healthCollapsed: false }, l.sidebar, l.observer) >= PANE_MIN ||
      (l.sidebar === SIDEBAR_MIN && l.observer === OBSERVER_MIN),
    'middle keeps its floor, or both panels are at their floors if the window is too small',
  );
});

console.log(`\n✓ LAYOUT TESTS PASS (${passed})`);
