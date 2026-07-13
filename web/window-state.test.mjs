// Unit tests for the pure window-state decision logic (WARDEN-263).
//
// electron/window-state.cjs holds every decision that must be CORRECT for the
// "remember window bounds" feature, extracted out of main.cjs (which requires
// electron and so can't run under `node --test`, and can't be driven in the
// worker sandbox where browser/Electron QA is blocked). These tests prove the
// core behavior deterministically — the Electron shell only wires live APIs to
// these decisions.
//
// Run: node window-state.test.mjs   (or: npm test, from web/)
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const {
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  MIN_WIDTH,
  MIN_HEIGHT,
  parseWindowState,
  rememberIsActive,
  closeToTrayIsActive,
  boundsIntersectAnyDisplay,
  resolveInitialBounds,
  captureBounds,
  captureMaximized,
  withRemember,
  withCloseToTray,
} = require('../electron/window-state.cjs');

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// A 1920×1080 primary display at the origin, and a 1280×800 second monitor to
// the right (origin x=1920) — the multi-monitor scenario from criterion 1.
const PRIMARY = { bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
const SECONDARY = { bounds: { x: 1920, y: 0, width: 1280, height: 800 } };
const BOTH = [PRIMARY, SECONDARY];

console.log('\nparseWindowState — defensive parse (never throws)');
test('null/undefined input → null', () => {
  assert.equal(parseWindowState(null), null);
  assert.equal(parseWindowState(undefined), null);
});
test('malformed JSON string → null (no throw)', () => {
  assert.equal(parseWindowState('{not valid json'), null);
});
test('non-object JSON → null', () => {
  assert.equal(parseWindowState('42'), null);
  assert.equal(parseWindowState('"hello"'), null);
  assert.equal(parseWindowState('[]'), null);
});
test('missing required width/height → null', () => {
  assert.equal(parseWindowState(JSON.stringify({ remember: true })), null);
  assert.equal(parseWindowState(JSON.stringify({ width: 1000 })), null);
});
test('a valid state round-trips with numeric fields', () => {
  const s = parseWindowState(JSON.stringify({ remember: true, closeToTray: true, x: 100, y: 50, width: 1200, height: 800, maximized: true }));
  assert.deepEqual(s, { remember: true, closeToTray: true, x: 100, y: 50, width: 1200, height: 800, maximized: true });
});
test('remember defaults to true when absent (toggle default ON)', () => {
  const s = parseWindowState(JSON.stringify({ width: 1200, height: 800 }));
  assert.equal(s.remember, true);
});
test('closeToTray defaults to false when absent (opt-in default OFF, WARDEN-330)', () => {
  const s = parseWindowState(JSON.stringify({ width: 1200, height: 800 }));
  assert.equal(s.closeToTray, false);
  // a stale file from before the feature cannot surprise-hide on close
  assert.equal(parseWindowState(JSON.stringify({ width: 1200, height: 800, remember: true })).closeToTray, false);
});
test('only an explicit true enables closeToTray (strict)', () => {
  assert.equal(parseWindowState(JSON.stringify({ width: 1200, height: 800, closeToTray: true })).closeToTray, true);
  assert.equal(parseWindowState(JSON.stringify({ width: 1200, height: 800, closeToTray: 'yes' })).closeToTray, false);
  assert.equal(parseWindowState(JSON.stringify({ width: 1200, height: 800, closeToTray: 1 })).closeToTray, false);
});
test('only an explicit false disables remember', () => {
  assert.equal(parseWindowState(JSON.stringify({ width: 1200, height: 800, remember: false })).remember, false);
  // truthy non-boolean still counts as "not false" → remember stays true
  assert.equal(parseWindowState(JSON.stringify({ width: 1200, height: 800, remember: 'no' })).remember, true);
});
test('non-numeric x/y are dropped (undefined), width/height required numeric', () => {
  const s = parseWindowState(JSON.stringify({ width: 1200, height: 800, x: 'oops', y: 10 }));
  assert.equal(s.x, undefined);
  assert.equal(s.y, 10);
});
test('accepts a pre-parsed object too', () => {
  const s = parseWindowState({ width: 1200, height: 800 });
  assert.equal(s.width, 1200);
});

console.log('\nrememberIsActive — toggle default ON, explicit false off');
test('no saved state → active (default ON)', () => {
  assert.equal(rememberIsActive(null), true);
  assert.equal(rememberIsActive(undefined), true);
});
test('remember true → active', () => {
  assert.equal(rememberIsActive({ remember: true, width: 1, height: 1 }), true);
});
test('remember false → inactive', () => {
  assert.equal(rememberIsActive({ remember: false, width: 1, height: 1 }), false);
});
test('absent remember → active (default ON)', () => {
  assert.equal(rememberIsActive({ width: 1, height: 1 }), true);
});

console.log('\ncloseToTrayIsActive — opt-in default OFF (WARDEN-330)');
test('no saved state → inactive (default OFF)', () => {
  assert.equal(closeToTrayIsActive(null), false);
  assert.equal(closeToTrayIsActive(undefined), false);
});
test('closeToTray true → active', () => {
  assert.equal(closeToTrayIsActive({ remember: true, closeToTray: true, width: 1, height: 1 }), true);
});
test('closeToTray false/absent → inactive', () => {
  assert.equal(closeToTrayIsActive({ remember: true, closeToTray: false, width: 1, height: 1 }), false);
  assert.equal(closeToTrayIsActive({ remember: true, width: 1, height: 1 }), false);
});

console.log('\nboundsIntersectAnyDisplay — off-screen detection');
test('bounds inside the primary display → true', () => {
  assert.equal(boundsIntersectAnyDisplay({ x: 100, y: 100, width: 800, height: 600 }, BOTH), true);
});
test('bounds on the secondary monitor → true', () => {
  assert.equal(boundsIntersectAnyDisplay({ x: 2000, y: 100, width: 800, height: 600 }, BOTH), true);
});
test('bounds fully off-screen (unplugged monitor) → false', () => {
  // A monitor that used to sit at x=5000 is now gone.
  assert.equal(boundsIntersectAnyDisplay({ x: 5000, y: 5000, width: 800, height: 600 }, BOTH), false);
});
test('bounds partially overlapping a display → true (edge touching counts)', () => {
  // Right edge just crosses into the secondary monitor at x=1920.
  assert.equal(boundsIntersectAnyDisplay({ x: 1900, y: 0, width: 100, height: 600 }, BOTH), true);
});
test('bounds adjacent but not overlapping → false', () => {
  // Ends exactly at the primary's right edge (x+width = 1920), starts at 1920 on
  // the secondary — touching edges with zero area overlap do NOT intersect.
  assert.equal(boundsIntersectAnyDisplay({ x: 1920, y: 0, width: 10, height: 10 }, [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }]), false);
});
test('empty display list → false (conservative)', () => {
  assert.equal(boundsIntersectAnyDisplay({ x: 100, y: 100, width: 800, height: 600 }, []), false);
});
test('malformed display entries are skipped, not thrown on', () => {
  assert.equal(boundsIntersectAnyDisplay({ x: 100, y: 100, width: 800, height: 600 }, [null, {}, { bounds: null }]), false);
});

console.log('\nresolveInitialBounds — the createWindow seed decision (criteria 1-4)');
test('criterion 4: fresh install (no saved state) → default bounds', () => {
  const r = resolveInitialBounds(null, BOTH);
  assert.deepEqual(r, { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, x: null, y: null, maximized: false });
});
test('criterion 3: remember off → default bounds', () => {
  const saved = { remember: false, x: 100, y: 100, width: 1200, height: 800, maximized: true };
  const r = resolveInitialBounds(saved, BOTH);
  assert.deepEqual(r, { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, x: null, y: null, maximized: false });
});
test('criterion 1: valid on-screen saved state → restored bounds + maximize flag', () => {
  const saved = { remember: true, x: 200, y: 150, width: 1200, height: 800, maximized: true };
  const r = resolveInitialBounds(saved, BOTH);
  assert.deepEqual(r, { width: 1200, height: 800, x: 200, y: 150, maximized: true });
});
test('criterion 1: saved on the secondary monitor (still plugged) → restored there', () => {
  const saved = { remember: true, x: 2000, y: 50, width: 1000, height: 700, maximized: false };
  const r = resolveInitialBounds(saved, BOTH);
  assert.deepEqual(r, { width: 1000, height: 700, x: 2000, y: 50, maximized: false });
});
test('criterion 2: saved on an unplugged monitor → visible default (never off-screen)', () => {
  // Saved position is at x=5000 — no current display is there.
  const saved = { remember: true, x: 5000, y: 5000, width: 1200, height: 800, maximized: true };
  const r = resolveInitialBounds(saved, BOTH);
  assert.deepEqual(r, { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, x: null, y: null, maximized: false });
});
test('saved size but no position → size applied, Electron places the window', () => {
  const saved = { remember: true, width: 1500, height: 950, maximized: false };
  const r = resolveInitialBounds(saved, BOTH);
  assert.deepEqual(r, { width: 1500, height: 950, x: null, y: null, maximized: false });
});
test('saved width below the min floor is clamped up to MIN_WIDTH', () => {
  const saved = { remember: true, x: 100, y: 100, width: 400, height: 300, maximized: false };
  const r = resolveInitialBounds(saved, BOTH);
  assert.equal(r.width, MIN_WIDTH);
  assert.equal(r.height, MIN_HEIGHT);
  assert.equal(r.x, 100, 'position still applied after size clamp');
});
test('invalid saved size (non-numeric) → default', () => {
  const r = resolveInitialBounds({ remember: true, width: 'big', height: 800 }, BOTH);
  assert.deepEqual(r, { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, x: null, y: null, maximized: false });
});

console.log('\ncaptureBounds — debounced resize/move capture (skip while maximized)');
test('remember off → null (nothing persisted)', () => {
  const prev = { remember: false, x: 10, y: 10, width: 1000, height: 700, maximized: false };
  assert.equal(captureBounds(prev, { x: 20, y: 20, width: 1100, height: 750 }, false), null);
});
test('no prior state + remember default ON → captures (fresh install starts remembering)', () => {
  const r = captureBounds(null, { x: 20, y: 20, width: 1100, height: 750 }, false);
  assert.deepEqual(r, { remember: true, closeToTray: false, x: 20, y: 20, width: 1100, height: 750, maximized: false });
});
test('maximized → null (so un-maximize restores the LAST normal bounds, not full-screen)', () => {
  const prev = { remember: true, x: 10, y: 10, width: 1000, height: 700, maximized: true };
  assert.equal(captureBounds(prev, { x: 0, y: 0, width: 1920, height: 1080 }, true), null);
});
test('normal state → captures current bounds, force maximized:false (reopen non-maximized)', () => {
  const prev = { remember: true, x: 10, y: 10, width: 1000, height: 700, maximized: true };
  const r = captureBounds(prev, { x: 30, y: 30, width: 1200, height: 800 }, false);
  assert.deepEqual(r, { remember: true, closeToTray: false, x: 30, y: 30, width: 1200, height: 800, maximized: false });
});
test('preserves an active closeToTray flag through a bounds capture (WARDEN-330)', () => {
  // A resize must NOT wipe closeToTray — both live in the same window-state.json.
  const prev = { remember: true, closeToTray: true, x: 10, y: 10, width: 1000, height: 700, maximized: false };
  const r = captureBounds(prev, { x: 30, y: 30, width: 1200, height: 800 }, false);
  assert.equal(r.closeToTray, true);
});
test('null liveBounds → null (defensive)', () => {
  assert.equal(captureBounds(null, null, false), null);
});

console.log('\ncaptureMaximized — maximize/unmaximize flag capture');
test('remember off → null', () => {
  const prev = { remember: false, x: 10, y: 10, width: 1000, height: 700, maximized: false };
  assert.equal(captureMaximized(prev, true), null);
});
test('maximize flips the flag AND preserves the last normal bounds', () => {
  const prev = { remember: true, x: 200, y: 150, width: 1200, height: 800, maximized: false };
  const r = captureMaximized(prev, true);
  assert.deepEqual(r, { remember: true, closeToTray: false, x: 200, y: 150, width: 1200, height: 800, maximized: true });
});
test('preserves an active closeToTray flag through a maximize capture (WARDEN-330)', () => {
  const prev = { remember: true, closeToTray: true, x: 200, y: 150, width: 1200, height: 800, maximized: false };
  assert.equal(captureMaximized(prev, true).closeToTray, true);
});
test('unmaximize clears the flag, bounds preserved', () => {
  const prev = { remember: true, x: 200, y: 150, width: 1200, height: 800, maximized: true };
  const r = captureMaximized(prev, false);
  assert.equal(r.maximized, false);
  assert.equal(r.width, 1200, 'bounds preserved through the maximize toggle');
});
test('no prior bounds yet → maximize still records the flag with default size', () => {
  const r = captureMaximized(null, true);
  assert.equal(r.maximized, true);
  assert.equal(r.width, DEFAULT_WIDTH, 'defaults fill in for missing bounds');
  assert.equal(r.x, undefined, 'position absent until a normal-state capture');
});

console.log('\nwithRemember — the IPC set toggle (preserve bounds across disable/re-enable)');
test('disabling sets remember:false but keeps the captured bounds', () => {
  const prev = { remember: true, x: 200, y: 150, width: 1200, height: 800, maximized: false };
  const r = withRemember(prev, false);
  assert.equal(r.remember, false);
  assert.equal(r.x, 200, 'bounds preserved so re-enabling reapplies them');
  assert.equal(r.width, 1200);
});
test('re-enabling flips the flag back', () => {
  const prev = { remember: false, x: 200, y: 150, width: 1200, height: 800, maximized: false };
  assert.equal(withRemember(prev, true).remember, true);
});
test('no prior state → default bounds, remember set to requested value', () => {
  const r = withRemember(null, true);
  assert.deepEqual(r, { remember: true, closeToTray: false, x: undefined, y: undefined, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, maximized: false });
});
test('preserves an active closeToTray flag when toggling remember (WARDEN-330)', () => {
  // Toggling remember-bounds must not wipe the independent close-to-tray flag.
  const prev = { remember: true, closeToTray: true, x: 200, y: 150, width: 1200, height: 800, maximized: false };
  assert.equal(withRemember(prev, false).closeToTray, true);
});
test('strict boolean contract: only `true` enables, everything else is false', () => {
  // The renderer's Switch always sends a real boolean, and main.cjs coerces
  // (remember === true) before calling withRemember — so the write path uses
  // strict equality (matching captureMaximized's isMaximized === true), NOT the
  // lenient "anything but explicit false" rule parseWindowState applies to file
  // data. A stray non-boolean therefore disables, which is the safe direction.
  assert.equal(withRemember(null, true).remember, true);
  assert.equal(withRemember(null, false).remember, false);
  assert.equal(withRemember(null, 'yes').remember, false);
  assert.equal(withRemember(null, 0).remember, false);
});

console.log('\nwithCloseToTray — the IPC set toggle (WARDEN-330, preserve bounds/remember)');
test('enabling sets closeToTray:true and keeps the captured bounds + remember', () => {
  const prev = { remember: true, closeToTray: false, x: 200, y: 150, width: 1200, height: 800, maximized: false };
  const r = withCloseToTray(prev, true);
  assert.equal(r.closeToTray, true);
  assert.equal(r.remember, true, 'remember preserved');
  assert.equal(r.x, 200, 'bounds preserved');
  assert.equal(r.width, 1200);
});
test('disabling flips the flag back while keeping bounds', () => {
  const prev = { remember: true, closeToTray: true, x: 200, y: 150, width: 1200, height: 800, maximized: true };
  const r = withCloseToTray(prev, false);
  assert.equal(r.closeToTray, false);
  assert.equal(r.x, 200, 'bounds preserved through the toggle');
  assert.equal(r.maximized, true);
});
test('toggling closeToTray preserves an explicitly-disabled remember flag', () => {
  // closeToTray and remember are independent — turning one on must not revive the other.
  const prev = { remember: false, closeToTray: false, x: 200, y: 150, width: 1200, height: 800, maximized: false };
  assert.equal(withCloseToTray(prev, true).remember, false);
});
test('no prior state → default bounds, closeToTray set to requested value', () => {
  const r = withCloseToTray(null, true);
  assert.deepEqual(r, { remember: true, closeToTray: true, x: undefined, y: undefined, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, maximized: false });
});
test('strict boolean contract: only `true` enables, everything else is false', () => {
  assert.equal(withCloseToTray(null, true).closeToTray, true);
  assert.equal(withCloseToTray(null, false).closeToTray, false);
  assert.equal(withCloseToTray(null, 'yes').closeToTray, false);
  assert.equal(withCloseToTray(null, 1).closeToTray, false);
});

console.log('\nfull lifecycle: resize → move → maximize → close → relaunch (criterion 1)');
test('captured arrangement round-trips through resolveInitialBounds on relaunch', () => {
  // 1) Resize on the primary display.
  let state = captureBounds(null, { x: 100, y: 100, width: 1300, height: 850 }, false);
  // 2) Move to the secondary monitor.
  state = captureBounds(state, { x: 2000, y: 50, width: 1300, height: 850 }, false);
  // 3) Maximize (flag flips, bounds preserved).
  state = captureMaximized(state, true);
  // 4) Close while maximized → bounds capture skipped (null), state unchanged.
  assert.equal(captureBounds(state, { x: 0, y: 0, width: 3200, height: 1080 }, true), null);
  // 5) Relaunch: secondary monitor still plugged → restore position + maximize.
  const init = resolveInitialBounds(state, BOTH);
  assert.deepEqual(init, { width: 1300, height: 850, x: 2000, y: 50, maximized: true });
});
test('lifecycle on a since-unplugged monitor → relaunch falls back to default (criterion 2)', () => {
  let state = captureBounds(null, { x: 2000, y: 50, width: 1300, height: 850 }, false);
  state = captureMaximized(state, true);
  // Relaunch with ONLY the primary display plugged in now.
  const init = resolveInitialBounds(state, [PRIMARY]);
  assert.deepEqual(init, { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, x: null, y: null, maximized: false });
});

console.log(`\n✓ WINDOW-STATE TESTS PASS (${passed})`);
