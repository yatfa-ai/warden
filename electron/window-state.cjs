// Pure window-state decision logic for the Electron main process (WARDEN-263).
//
// WHY THIS FILE IS SPLIT OUT OF main.cjs: main.cjs `require('electron')`, so it
// can only run under Electron itself — it cannot be exercised by `node --test`,
// and the worker sandbox cannot launch Electron to drive the window shell
// (browser/visual QA is blocked). Every decision that must be CORRECT for the
// "remember window bounds" feature lives here as a PURE function with no
// electron/Node dependency, so it is unit-tested directly in
// web/window-state.test.mjs. main.cjs wires the live electron APIs
// (screen.getAllDisplays, win.getBounds/isMaximized, fs) to these decisions.
//
// State shape persisted to window-state.json:
//   { remember: boolean, closeToTray: boolean, x?, y?, width: number, height: number, maximized: boolean }
// `remember` defaults ON (only an explicit false disables); `closeToTray` defaults
// OFF (opt-in — closing the window is a consent-surprising behavior change, so
// it must never activate without an explicit toggle, mirroring launch-at-login).
// x/y are omitted until the first normal-state bounds capture (getBounds always
// has them, so once captured they are always present).

// The fixed default the app always used before this feature (electron/main.cjs).
const DEFAULT_WIDTH = 1400;
const DEFAULT_HEIGHT = 900;
// Existing BrowserWindow floors (minWidth/minHeight) — saved sizes are clamped
// to these so a stale sub-minimum value can never under-size the window.
const MIN_WIDTH = 900;
const MIN_HEIGHT = 600;

// The default applied when there is no usable saved state: default size, default
// position (x/y null → let Electron place the window visibly), not maximized.
function defaultBounds() {
  return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, x: null, y: null, maximized: false };
}

// Defensive parse of the raw file contents (a JSON string) or a pre-parsed
// object. Malformed/missing/non-object input → null, NEVER throws (WARDEN-89
// spirit). `remember` defaults to true when absent (the Settings toggle defaults
// to ON; only an explicit `false` disables), so a bounds file written before the
// toggle existed still applies. `closeToTray` defaults to false when absent (the
// opt-in close-to-tray pref — WARDEN-330 — must never activate without an
// explicit toggle, so a stale file from before the feature cannot hide-to-tray
// on close). width/height are required — without a usable size there is nothing
// to restore.
function parseWindowState(raw) {
  let v;
  try {
    v = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  if (typeof v.width !== 'number' || typeof v.height !== 'number') return null;
  return {
    remember: v.remember !== false,
    closeToTray: v.closeToTray === true,
    x: typeof v.x === 'number' ? v.x : undefined,
    y: typeof v.y === 'number' ? v.y : undefined,
    width: v.width,
    height: v.height,
    maximized: v.maximized === true,
  };
}

// True when the "remember window bounds" pref is active. No saved state counts
// as active: the toggle defaults to ON, and until the user explicitly turns it
// off (which writes remember:false) the app should capture bounds.
function rememberIsActive(prev) {
  if (!prev) return true;
  return prev.remember !== false;
}

// True when the opt-in "close to tray" pref is active (WARDEN-330). Defaults OFF
// — no saved state (and any non-true value) is inactive, mirroring the launch-
// at-login consent default. Only an explicit closeToTray:true activates, so a
// stale file from before the feature cannot surprise-hide the window on close.
function closeToTrayIsActive(prev) {
  if (!prev) return false;
  return prev.closeToTray === true;
}

// Pure geometry: does `bounds` {x,y,width,height} overlap ANY current display's
// bounds? Used to detect a window saved on a now-unplugged monitor. An empty
// display list is treated as "no display matches" (conservative → fall back).
function boundsIntersectAnyDisplay(bounds, displays) {
  if (!bounds || !Array.isArray(displays)) return false;
  for (const d of displays) {
    const b = d && d.bounds;
    if (!b || typeof b.x !== 'number') continue;
    const overlap =
      bounds.x < b.x + b.width &&
      bounds.x + bounds.width > b.x &&
      bounds.y < b.y + b.height &&
      bounds.y + bounds.height > b.y;
    if (overlap) return true;
  }
  return false;
}

// The createWindow seed decision. Returns { width, height, x, y, maximized }
// where x/y are null when Electron should place the window itself. Falls back to
// the default when: there is no saved state, the toggle is off, the saved size
// is unusable, OR the saved position is fully off-screen (unplugged monitor).
// Width/height are clamped to the min floors. Pure: takes the saved state and
// the current display list as data.
function resolveInitialBounds(saved, displays) {
  const fallback = defaultBounds();
  if (!saved || saved.remember === false) return fallback;
  if (typeof saved.width !== 'number' || typeof saved.height !== 'number') return fallback;
  const width = Math.max(MIN_WIDTH, saved.width);
  const height = Math.max(MIN_HEIGHT, saved.height);
  const hasPos = typeof saved.x === 'number' && typeof saved.y === 'number';
  const maximized = saved.maximized === true;
  if (!hasPos) {
    // Size remembered but no position: apply the size, let Electron place it.
    return { width, height, x: null, y: null, maximized };
  }
  const onScreen = boundsIntersectAnyDisplay(
    { x: saved.x, y: saved.y, width, height },
    displays,
  );
  if (!onScreen) return fallback; // saved display unplugged → never open off-screen
  return { width, height, x: saved.x, y: saved.y, maximized };
}

// The next state to persist after a debounced resize/move capture, or null to
// SKIP the write. Skips when the pref is off OR the window is currently
// maximized — capturing the full-screen bounds would make un-maximize restore
// the maximized geometry instead of the last normal size. captureBounds only
// ever runs in normal state, so the persisted maximize flag is false here
// (reopen at these bounds, non-maximized).
function captureBounds(prev, liveBounds, isMaximized) {
  if (!rememberIsActive(prev)) return null;
  if (isMaximized) return null;
  if (!liveBounds) return null;
  // getBounds() always returns integer x/y/width/height for a live window, and
  // the OS already enforces minWidth/minHeight, so no clamp is needed here — the
  // min-floor clamp lives in resolveInitialBounds (restore time) for saved state.
  return {
    remember: true,
    closeToTray: closeToTrayIsActive(prev),
    x: liveBounds.x,
    y: liveBounds.y,
    width: liveBounds.width,
    height: liveBounds.height,
    maximized: false,
  };
}

// The next state to persist after a maximize/unmaximize transition, or null to
// skip. Only flips the `maximized` flag, preserving the last normal bounds so
// un-maximizing later restores them.
function captureMaximized(prev, isMaximized) {
  if (!rememberIsActive(prev)) return null;
  return {
    remember: true,
    closeToTray: closeToTrayIsActive(prev),
    x: prev && typeof prev.x === 'number' ? prev.x : undefined,
    y: prev && typeof prev.y === 'number' ? prev.y : undefined,
    width: prev && typeof prev.width === 'number' ? prev.width : DEFAULT_WIDTH,
    height: prev && typeof prev.height === 'number' ? prev.height : DEFAULT_HEIGHT,
    maximized: isMaximized === true,
  };
}

// Return the state to persist when the user toggles the preference, flipping
// `remember` while preserving any previously-captured bounds (so re-enabling
// after disabling reapplies the last arrangement, subject to the on-screen
// clamp at createWindow time). Preserves the independent `closeToTray` flag so
// toggling remember-bounds cannot wipe close-to-tray (and vice versa).
function withRemember(prev, remember) {
  const base = prev || {};
  return {
    remember: remember === true,
    closeToTray: closeToTrayIsActive(base),
    x: typeof base.x === 'number' ? base.x : undefined,
    y: typeof base.y === 'number' ? base.y : undefined,
    width: typeof base.width === 'number' ? base.width : DEFAULT_WIDTH,
    height: typeof base.height === 'number' ? base.height : DEFAULT_HEIGHT,
    maximized: base.maximized === true,
  };
}

// Return the state to persist when the user toggles close-to-tray (WARDEN-330),
// flipping the flag while preserving the `remember` flag and any captured
// bounds (so disabling close-to-tray never drops the remembered arrangement).
// Mirrors withRemember's shape contract.
function withCloseToTray(prev, closeToTray) {
  const base = prev || {};
  return {
    remember: base.remember !== false,
    closeToTray: closeToTray === true,
    x: typeof base.x === 'number' ? base.x : undefined,
    y: typeof base.y === 'number' ? base.y : undefined,
    width: typeof base.width === 'number' ? base.width : DEFAULT_WIDTH,
    height: typeof base.height === 'number' ? base.height : DEFAULT_HEIGHT,
    maximized: base.maximized === true,
  };
}

module.exports = {
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  MIN_WIDTH,
  MIN_HEIGHT,
  defaultBounds,
  parseWindowState,
  rememberIsActive,
  closeToTrayIsActive,
  boundsIntersectAnyDisplay,
  resolveInitialBounds,
  captureBounds,
  captureMaximized,
  withRemember,
  withCloseToTray,
};
