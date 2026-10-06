// Layout-clamp policy tests (WARDEN-183).
//
// There is no front-end test runner in this repo, so (like storage.test.mjs and
// diff.test.mjs) this loads the REAL src/lib/layout.ts (transpiled TS -> ESM via
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
// Round 3 found the SAME class of wiring gap on the sidebar/observer EXPAND path:
// a panel dragged wide while the other is collapsed stores a width that only fits
// alone (the drag clamp treats a collapsed neighbor as width 0). Expanding the
// collapsed panel re-introduces that width with no re-clamp, crushing the middle.
// Modeled in the "expand re-clamp" section below.
//
// Since WARDEN-1516 (roadmap WARDEN-1204 slice 22) the widths and the re-clamp
// live on the uiStore (`reclampPanelWidths`, reading the store's own collapse
// flags), so the scenarios below drive a real `createUiStore()` — there is no
// hand-mirrored model of App's wiring left to drift from production. A "BUG
// repro" test simulates the regression by simply NOT calling reclampPanelWidths
// after changing the space; the FIX tests call it exactly as App's resize
// listener / space-shape effect do. (That App's effect actually CALLS the action
// is wiring only review/tsc can see — see the PR note.)
//
// Run: node layout.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));

// uiStore.ts reads localStorage at creation (loadUi) — polyfill BEFORE loading it.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  clear: () => { mem.clear(); },
};

// --- Load the REAL layout.ts + uiStore.ts (TS -> ESM via the OXC transform) --
// The temp dir lives INSIDE web/ so uiStore's bare `zustand` import resolves
// (same harness shape as uiStore.test.mjs).
const tmpDir = mkdtempSync(join(__dirname, '.layout-test-'));
const emit = async (relPath, outName, rewrite = (c) => c) => {
  const abs = resolve(__dirname, relPath);
  const { code } = await transformWithOxc(readFileSync(abs, 'utf8'), abs, {});
  writeFileSync(join(tmpDir, outName), rewrite(code));
};
await emit('src/lib/layout.ts', 'layout.mjs');
await emit('src/lib/paneAttach.ts', 'paneAttach.mjs');
await emit('src/lib/themes.ts', 'themes.mjs');
await emit('src/lib/storage.ts', 'storage.mjs', (c) => c.replaceAll('@/lib/themes', './themes.mjs'));
await emit('src/lib/uiStore.ts', 'uiStore.mjs', (c) =>
  c.replaceAll('@/lib/storage', './storage.mjs').replaceAll('@/lib/layout', './layout.mjs').replaceAll('@/lib/paneAttach', './paneAttach.mjs'));
const {
  clampLayoutWidths,
  clampSidebarWidth,
  clampObserverWidth,
  SIDEBAR_MIN,
  SIDEBAR_MAX,
  OBSERVER_MIN,
  OBSERVER_MAX,
  PANE_MIN,
  HEALTH_WIDTH,
} = await import(join(tmpDir, 'layout.mjs'));
const { createUiStore } = await import(join(tmpDir, 'uiStore.mjs'));
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

// A real uiStore wrapped in the tiny vocabulary the scenarios read: the widths
// and collapse flags are the store's own, and `.reclamp(ctx)` fires the
// production `reclampPanelWidths(windowWidth)` action — the exact call App's
// resize listener and space-shape effect make. `ctx.healthCollapsed` is applied
// to the store first (it is store state; the scenarios express it per call).
function makeLayout(sidebar, observer, { sidebarCollapsed = false, observerCollapsed = false } = {}) {
  const store = createUiStore({ sidebarWidth: sidebar, observerWidth: observer, sidebarCollapsed, observerCollapsed });
  const api = {
    store,
    get sidebar() { return store.getState().sidebarWidth; },
    set sidebar(v) { store.getState().setSidebarWidth(v); },
    get observer() { return store.getState().observerWidth; },
    set observer(v) { store.getState().setObserverWidth(v); },
    get sidebarCollapsed() { return store.getState().sidebarCollapsed; },
    set sidebarCollapsed(v) { store.getState().setSidebarCollapsed(v); },
    get observerCollapsed() { return store.getState().observerCollapsed; },
    set observerCollapsed(v) { store.getState().setObserverCollapsed(v); },
    reclamp(ctx) {
      store.getState().setHealthCollapsed(ctx.healthCollapsed);
      store.getState().reclampPanelWidths(ctx.windowWidth);
      return api;
    },
  };
  return api;
}

console.log('\nhealth-toggle re-clamp: opening health never crushes the middle pane (WARDEN-183)');

test('mount clamp at the 900px floor (health collapsed) keeps the middle at PANE_MIN', () => {
  // Fresh launch, default widths, at the Electron minWidth. This is the starting
  // point of the reviewer's repro.
  const ctx = { windowWidth: 900, healthCollapsed: true };
  const l = makeLayout(220, 380).reclamp(ctx);
  assert.equal(l.sidebar, 200, 'sidebar trimmed from 220 -> 200');
  assert.equal(l.observer, 380, 'observer unchanged');
  assert.equal(middle(ctx, l.sidebar, l.observer), PANE_MIN, 'middle exactly at the floor');
});

test('BUG repro: opening health at 900px WITHOUT a re-clamp crushes the middle to 0', () => {
  // Same mount as above, then the user toggles health. If App did NOT re-clamp
  // on the toggle (the WARDEN-183 regression), the panel widths stay put and the
  // 320px health panel eats the entire middle pane column.
  const l = makeLayout(220, 380).reclamp({ windowWidth: 900, healthCollapsed: true });
  // NO reclamp on the toggle — the bug:
  assert.equal(
    middle({ windowWidth: 900, healthCollapsed: false }, l.sidebar, l.observer),
    0,
    'middle collapses to 0 when the health toggle is not re-clamped',
  );
});

test('FIX: opening health at 900px re-clamps so the middle is never crushed to 0', () => {
  // Same mount, then the health-toggle re-clamp fires (App's applyLayoutClamp).
  const l = makeLayout(220, 380).reclamp({ windowWidth: 900, healthCollapsed: true });
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
  const l = makeLayout(220, 380).reclamp({ windowWidth: 1200, healthCollapsed: true });
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
  const l = makeLayout(220, 380).reclamp({ windowWidth: 1200, healthCollapsed: true });
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
  const l = makeLayout(220, 380)
    .reclamp({ windowWidth: 1400, healthCollapsed: false })
    .reclamp({ windowWidth: 1000, healthCollapsed: false }); // window shrinks
  assert.ok(
    middle({ windowWidth: 1000, healthCollapsed: false }, l.sidebar, l.observer) >= PANE_MIN ||
      (l.sidebar === SIDEBAR_MIN && l.observer === OBSERVER_MIN),
    'middle keeps its floor, or both panels are at their floors if the window is too small',
  );
});

console.log('\nexpand re-clamp: widening one rail while the other is collapsed, then expanding, never crushes the middle (WARDEN-183 round 3)');

test('collapse-aware math: a lone visible panel is never trimmed to reserve room for a hidden one', () => {
  // Sidebar collapsed (hidden → width 0 in the flex row), observer dragged to the
  // full shared width. The re-clamp must treat the hidden sidebar as 0 so the
  // lone visible observer keeps its width. The pre-round-3 math subtracted the
  // sidebar's STORED width too and would wrongly shrink the observer to 400.
  const ctx = { windowWidth: 900, healthCollapsed: true };
  const l = makeLayout(200, 580, { sidebarCollapsed: true }).reclamp(ctx);
  assert.equal(l.observer, 580, 'lone visible observer keeps its wide value');
  assert.equal(l.sidebar, 200, 'hidden sidebar stored width is left untouched');
  // The visible layout (sidebar hidden) has plenty of middle.
  assert.ok(middle(ctx, 0, l.observer) >= PANE_MIN, 'middle >= PANE_MIN with only the observer visible');
});

test('BUG repro: expanding a rail WITHOUT a re-clamp crushes the middle below PANE_MIN', () => {
  // The reviewer's realistic 3-action sequence at the 900px floor: collapse the
  // sidebar, drag the observer wide (the drag clamp sees the collapsed neighbor
  // as width 0 and allows 580), then EXPAND the sidebar. If App did NOT re-clamp
  // on the expand (the round-3 regression), both panels keep their full stored
  // widths and the middle pane column is crushed.
  const ctx = { windowWidth: 900, healthCollapsed: true };
  const l = makeLayout(220, 380).reclamp(ctx); // mount -> sidebar=200, observer=380
  l.sidebarCollapsed = true; // collapse sidebar
  l.observer = clampObserverWidth(580, 0, ctx); // drag observer wide (neighbor=0)
  l.sidebarCollapsed = false; // expand sidebar — NO reclamp (the bug)
  assert.ok(
    middle(ctx, l.sidebar, l.observer) < PANE_MIN,
    'middle is crushed below PANE_MIN when the expand is not re-clamped',
  );
});

test('FIX: expanding a rail re-clamps so the middle keeps its floor (realistic 3-action)', () => {
  // Same setup, but the expand fires applyLayoutClamp (App's space-shape effect).
  // The pair is trimmed (sidebar yields to its floor first) so the middle keeps
  // PANE_MIN instead of being crushed.
  const ctx = { windowWidth: 900, healthCollapsed: true };
  const l = makeLayout(220, 380).reclamp(ctx); // sidebar=200, observer=380
  l.sidebarCollapsed = true;
  l.observer = clampObserverWidth(580, 0, ctx); // drag observer to 580
  l.sidebarCollapsed = false; // expand sidebar
  l.reclamp(ctx); // <- the fix: re-clamp on expand
  assert.equal(l.sidebar, SIDEBAR_MIN, 'sidebar gives way to its floor first');
  assert.equal(l.observer, 400, 'observer trimmed to fit the now-shared space');
  assert.ok(l.observer >= OBSERVER_MIN, 'observer never below its usable floor');
  assert.equal(middle(ctx, l.sidebar, l.observer), PANE_MIN, 'middle exactly at the floor');
});

test('FIX: the decisive collapse-dance no longer crushes the middle to 0', () => {
  // The worst-case sequence the reviewer drove through the real functions:
  // collapse sidebar -> widen observer -> collapse observer -> expand sidebar ->
  // widen sidebar (neighbor=0) -> expand observer. Pre-fix this left the middle
  // at -80 -> crushed to 0. With expand re-clamp + collapse-aware math the final
  // expand trims the pair and the middle keeps its floor.
  const ctx = { windowWidth: 900, healthCollapsed: true };
  const l = makeLayout(220, 380).reclamp(ctx);
  l.sidebarCollapsed = true; // collapse sidebar
  l.observer = clampObserverWidth(580, 0, ctx); // widen observer
  l.observerCollapsed = true; // collapse observer
  l.sidebarCollapsed = false; // expand sidebar
  l.reclamp(ctx); // re-clamp (sidebar visible, observer hidden)
  l.sidebar = clampSidebarWidth(400, 0, ctx); // widen sidebar (neighbor=0)
  l.observerCollapsed = false; // expand observer
  l.reclamp(ctx); // <- the fix: re-clamp on expand
  assert.ok(l.sidebar >= SIDEBAR_MIN && l.observer >= OBSERVER_MIN, 'both panels within usable bands');
  assert.ok(middle(ctx, l.sidebar, l.observer) > 0, 'middle is not crushed to 0');
  assert.equal(middle(ctx, l.sidebar, l.observer), PANE_MIN, 'middle exactly at the floor');
});

console.log('\nlayout width clamps: no panel crushes below a usable floor (WARDEN-183)');
test('constants define usable floors + caps + the middle-pane reserve', () => {
  assert.equal(SIDEBAR_MIN, 180);
  assert.equal(SIDEBAR_MAX, 400);
  assert.equal(OBSERVER_MIN, 300);
  assert.equal(OBSERVER_MAX, 600);
  assert.equal(PANE_MIN, 320);
  assert.equal(HEALTH_WIDTH, 320);
});

test('clampSidebarWidth applies the [min,max] band on a wide window', () => {
  const ctx = { windowWidth: 1400, healthCollapsed: true };
  assert.equal(clampSidebarWidth(10, 380, ctx), SIDEBAR_MIN, 'floors to SIDEBAR_MIN');
  assert.equal(clampSidebarWidth(9999, 380, ctx), SIDEBAR_MAX, 'caps at SIDEBAR_MAX');
  assert.equal(clampSidebarWidth(250, 380, ctx), 250, 'passes through in-range values');
});

test('clampSidebarWidth caps a wide drag so the middle pane keeps its floor', () => {
  // 900px window (the Electron floor), observer already valid at 380. Dragging
  // the sidebar all the way to its 400 cap would crush the middle; the clamp
  // must stop it at the point the middle pane reserve (PANE_MIN) is preserved.
  const ctx = { windowWidth: 900, healthCollapsed: true };
  const sb = clampSidebarWidth(400, 380, ctx);
  assert.equal(sb, 200, 'sidebar capped at 200, not 400');
  assert.ok(middle(ctx, sb, 380) >= PANE_MIN, 'middle pane >= PANE_MIN after sidebar drag');
});

test('clampObserverWidth is symmetric — caps a wide drag to protect the middle', () => {
  const ctx = { windowWidth: 900, healthCollapsed: true };
  const ob = clampObserverWidth(600, 220, ctx);
  assert.equal(ob, 360, 'observer capped at 360, not 600');
  assert.ok(middle(ctx, 220, ob) >= PANE_MIN, 'middle pane >= PANE_MIN after observer drag');
});

test('clampLayoutWidths is a no-op when the window has room for everything', () => {
  const ctx = { windowWidth: 1400, healthCollapsed: true };
  const r = clampLayoutWidths({ sidebar: 220, observer: 380 }, ctx);
  assert.deepEqual(r, { sidebar: 220, observer: 380 });
  assert.ok(middle(ctx, r.sidebar, r.observer) >= PANE_MIN);
});

test('clampLayoutWidths trims a stale both-max pair on load so the middle never collapses', () => {
  // Persisted 400/600 (saved on a big window) loaded at the 900px floor: the
  // pair must be trimmed so the middle pane keeps PANE_MIN.
  const ctx = { windowWidth: 900, healthCollapsed: true };
  const r = clampLayoutWidths({ sidebar: 400, observer: 600 }, ctx);
  assert.ok(r.sidebar >= SIDEBAR_MIN && r.sidebar <= SIDEBAR_MAX, 'sidebar stays in band');
  assert.ok(r.observer >= OBSERVER_MIN && r.observer <= OBSERVER_MAX, 'observer stays in band');
  assert.equal(middle(ctx, r.sidebar, r.observer), PANE_MIN, 'middle pane exactly at the floor');
  assert.equal(r.sidebar + r.observer, 580, 'pair sums to the shared space (900 - 320)');
});

test('clampLayoutWidths accounts for the expanded health panel', () => {
  // Health expanded reserves HEALTH_WIDTH too, so the shared space shrinks and
  // the pair is trimmed harder — but the middle pane still keeps its floor.
  const ctx = { windowWidth: 1200, healthCollapsed: false };
  const r = clampLayoutWidths({ sidebar: 220, observer: 380 }, ctx);
  assert.ok(middle(ctx, r.sidebar, r.observer) >= PANE_MIN, 'middle >= PANE_MIN with health open');
  assert.ok(r.sidebar + r.observer <= 1200 - PANE_MIN - HEALTH_WIDTH, 'pair fits the health-aware shared space');
});

test('clampLayoutWidths preserves the floors at the 900px window with health collapsed', () => {
  // The degenerate-but-reachable minimum: both panels at their defaults on the
  // 900px floor. Neither should fall below its usable floor; the middle keeps
  // its reserve. (180 + 300 + 320 = 800 fits in 900.)
  const ctx = { windowWidth: 900, healthCollapsed: true };
  const r = clampLayoutWidths({ sidebar: 220, observer: 380 }, ctx);
  assert.ok(r.sidebar >= SIDEBAR_MIN, 'sidebar >= SIDEBAR_MIN');
  assert.ok(r.observer >= OBSERVER_MIN, 'observer >= OBSERVER_MIN');
  assert.ok(middle(ctx, r.sidebar, r.observer) >= PANE_MIN, 'middle pane >= PANE_MIN');
});

console.log(`\n✓ LAYOUT TESTS PASS (${passed})`);
