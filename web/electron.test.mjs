// Tests for the renderer's Electron IPC bridge: web/src/lib/electron.ts
// (WARDEN-672). This module is the renderer's ONLY channel to OS-level window
// state (the preload `window.wardenWindow`) and the telemetry runtime-drift
// breaker (the preload `window.wardenTelemetry`). It landed across
// WARDEN-263/278/330/631 and shipped "done" with ZERO unit coverage — these
// tests pin the two invariants that are easy to silently break and are
// security/UX-sensitive: the CONSENT-DEFAULT divergence and the NEVER-REJECT
// degradation.
//
// Why these invariants are the whole point of the module:
//  - Consent defaults diverge ON PURPOSE and must stay divergent:
//    getRememberWindowBounds() defaults to TRUE (in a browser there is no OS
//    window state to remember anyway), while getLaunchAtLogin() and
//    getCloseToTray() default to FALSE (consent — auto-start modifies the OS
//    login items; close-to-tray changes what the close button does; WARDEN-278,
//    WARDEN-330). Flipping a default is a silent behavior regression (Warden
//    auto-starting at login for a browser/dev user) — pinned below.
//  - Every accessor MUST NEVER reject: a throwing/malfunctioning preload bridge
//    (e.g. a rejecting Linux platform) must degrade to the pref default, never
//    surface an unhandled rejection into Settings.
//  - Telemetry-runtime accessors MUST defensively coerce a malformed bridge
//    payload (non-boolean `drifted`, null, non-object) to {drifted:false} — the
//    "never a false drift alarm" invariant.
//  - Setters return the passed value (optimistic UI) when the bridge is absent,
//    and onTelemetryRuntimeStatus returns a no-op unsubscribe (safe useEffect
//    cleanup) when absent OR when the bridge returns null.
//
// electron.ts has no runtime imports (only the `window` global + type-only
// interfaces), so the SAME OXC-transform-to-temp-`.mjs` + dynamic-import harness
// used by clipboard.test.mjs / telemetry-runtime-status.test.mjs loads the REAL
// module. The bridge helpers read `window.wardenWindow` / `window.wardenTelemetry
// at CALL time (not import time), so we swap globalThis.window between cases
// (mirroring clipboard.test.mjs's globalThis.navigator/document swap).
//
// Run: node electron.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libDir = resolve(__dirname, 'src/lib');

// --- Load the REAL electron.ts (TS -> ESM via OXC) --------------------------
// electron.ts has no runtime imports (only the `window` global + type-only
// interfaces erased by the transform), so no specifier rewriting is needed.
const src = readFileSync(join(libDir, 'electron.ts'), 'utf8');
const { code } = await transformWithOxc(src, join(libDir, 'electron.ts'), {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-electron-test-'));
const file = join(tmpDir, 'electron.mjs');
writeFileSync(file, code);
const {
  hasWindowBridge,
  getRememberWindowBounds,
  setRememberWindowBounds,
  getLaunchAtLogin,
  setLaunchAtLogin,
  getCloseToTray,
  setCloseToTray,
  getTelemetryRuntimeStatus,
  onTelemetryRuntimeStatus,
  clearTelemetryRuntimeDrift,
} = await import(file);

// --- Load the REAL mainOwnedPref.ts (the CONSUMER of the setters above) -----
// Same transform harness: mainOwnedPref.ts is deliberately dependency-free (no
// React, no `sonner` — the caller injects the state setter and the refusal
// notifier), so it loads with no specifier rewriting either. Testing it HERE,
// beside the seam it consumes, is the point: electron.ts proves the setters can
// return a value differing from the request; this proves the renderer now
// honors that instead of discarding it (WARDEN-973).
const reconcileSrc = readFileSync(join(libDir, 'mainOwnedPref.ts'), 'utf8');
const reconcileOut = await transformWithOxc(reconcileSrc, join(libDir, 'mainOwnedPref.ts'), {});
const reconcileFile = join(tmpDir, 'mainOwnedPref.mjs');
writeFileSync(reconcileFile, reconcileOut.code);
const { reconcileMainOwnedPref } = await import(reconcileFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;

// Save the originals (Node 24 has no `window` global; console.warn is real) and
// restore after EVERY case so a mocked window / silenced warn never leaks across
// tests. The bridge helpers read `window` at call time, so swapping it here
// drives the whole module without branching at the host.
const realWindow = globalThis.window;
const realWarn = console.warn;
const restore = () => {
  globalThis.window = realWindow;
  console.warn = realWarn;
};
// Silence console.warn for the failure-path cases (the code logs a degradation
// warning on every caught rejection — expected, but noisy). restore() re-enables it.
const silenceWarn = () => { console.warn = () => {}; };

// `window` present but neither preload bridge exposed — the browser / `npm run
// dev` / `node web/smoke.cjs` context (the two of three hosts with no bridge).
const noBridge = () => { globalThis.window = {}; };
// The Electron desktop context: the preload exposed window.wardenWindow.
const windowBridge = (bridge) => { globalThis.window = { wardenWindow: bridge }; };
// The Electron desktop context: the preload exposed window.wardenTelemetry.
const telemetryBridge = (bridge) => { globalThis.window = { wardenTelemetry: bridge }; };

const test = (name, fn) => {
  try { fn(); } finally { restore(); }
  passed += 1;
  console.log('  ok -', name);
};
const testAsync = (name, fn) => fn().then(() => { restore(); passed += 1; console.log('  ok -', name); });

// ---------------------------------------------------------------------------
console.log('\nhasWindowBridge — feature-detects the window-state bridge');
// ---------------------------------------------------------------------------
test('returns false when window.wardenWindow is absent (browser/dev/smoke host)', () => {
  noBridge();
  assert.equal(hasWindowBridge(), false);
});
test('returns false for an explicit undefined wardenWindow (the typeof check, not a truthy check)', () => {
  globalThis.window = { wardenWindow: undefined };
  assert.equal(hasWindowBridge(), false);
});
test('returns true when window.wardenWindow is present (Electron desktop host)', () => {
  windowBridge({});
  assert.equal(hasWindowBridge(), true);
});
test('returns false when window has ONLY the telemetry bridge (detects the WINDOW bridge specifically)', () => {
  telemetryBridge({});
  assert.equal(hasWindowBridge(), false);
});

// ---------------------------------------------------------------------------
console.log('\nconsent defaults when the bridge is absent (the divergence pin)');
// WARDEN-278/330: launch-at-login and close-to-tray are consent-gated and default
// OFF; remember-bounds defaults ON. Flipping a default is a silent behavior
// regression (Warden auto-starting at login for a browser user), so pin all three.
// ---------------------------------------------------------------------------
await testAsync('getRememberWindowBounds defaults to TRUE when the bridge is absent (pref defaults ON)', async () => {
  noBridge();
  assert.equal(await getRememberWindowBounds(), true);
});
await testAsync('getLaunchAtLogin defaults to FALSE when the bridge is absent (consent — OFF)', async () => {
  noBridge();
  assert.equal(await getLaunchAtLogin(), false);
});
await testAsync('getCloseToTray defaults to FALSE when the bridge is absent (consent — OFF)', async () => {
  noBridge();
  assert.equal(await getCloseToTray(), false);
});
await testAsync('the three window-state defaults DIVERGE ON PURPOSE: remember=ON, launch=OFF, close-to-tray=OFF', async () => {
  // The headline invariant: the consent-gated prefs MUST default OFF while
  // remember-bounds defaults ON. If a future refactor unifies these defaults,
  // this assertion fails loudly instead of silently changing OS-level behavior.
  noBridge();
  const remember = await getRememberWindowBounds();
  const launch = await getLaunchAtLogin();
  const tray = await getCloseToTray();
  assert.equal(remember, true, 'remember-bounds defaults ON');
  assert.equal(launch, false, 'launch-at-login defaults OFF (consent)');
  assert.equal(tray, false, 'close-to-tray defaults OFF (consent)');
  assert.notEqual(remember, launch, 'remember and launch defaults must NOT match');
  assert.equal(launch, tray, 'launch and close-to-tray share the consent-OFF default');
});

// ---------------------------------------------------------------------------
console.log('\nwindow-state getters return the bridge-reported value when present');
// ---------------------------------------------------------------------------
await testAsync('getRememberWindowBounds returns the bridge value (true)', async () => {
  windowBridge({ getRememberWindowBounds: async () => true });
  assert.equal(await getRememberWindowBounds(), true);
});
await testAsync('getRememberWindowBounds returns the bridge value (false)', async () => {
  windowBridge({ getRememberWindowBounds: async () => false });
  assert.equal(await getRememberWindowBounds(), false);
});
await testAsync('getLaunchAtLogin returns the bridge value (true)', async () => {
  windowBridge({ getLaunchAtLogin: async () => true });
  assert.equal(await getLaunchAtLogin(), true);
});
await testAsync('getLaunchAtLogin returns the bridge value (false)', async () => {
  windowBridge({ getLaunchAtLogin: async () => false });
  assert.equal(await getLaunchAtLogin(), false);
});
await testAsync('getCloseToTray returns the bridge value (true)', async () => {
  windowBridge({ getCloseToTray: async () => true });
  assert.equal(await getCloseToTray(), true);
});
await testAsync('getCloseToTray returns the bridge value (false)', async () => {
  windowBridge({ getCloseToTray: async () => false });
  assert.equal(await getCloseToTray(), false);
});

// ---------------------------------------------------------------------------
console.log('\nevery getter NEVER rejects — a throwing bridge degrades to the pref default');
// A rejecting platform (e.g. Linux) must surface as the pref default in Settings,
// never as an unhandled rejection. Each getter degrades to its OWN default.
// ---------------------------------------------------------------------------
await testAsync('getRememberWindowBounds degrades to TRUE (its default) when the bridge rejects', async () => {
  silenceWarn();
  windowBridge({ getRememberWindowBounds: async () => { throw new Error('Linux rejects'); } });
  assert.equal(await getRememberWindowBounds(), true);
});
await testAsync('getLaunchAtLogin degrades to FALSE (its default) when the bridge rejects', async () => {
  silenceWarn();
  windowBridge({ getLaunchAtLogin: async () => { throw new Error('platform rejects'); } });
  assert.equal(await getLaunchAtLogin(), false);
});
await testAsync('getCloseToTray degrades to FALSE (its default) when the bridge rejects', async () => {
  silenceWarn();
  windowBridge({ getCloseToTray: async () => { throw new Error('platform rejects'); } });
  assert.equal(await getCloseToTray(), false);
});

// ---------------------------------------------------------------------------
console.log('\nsetters return the passed value when the bridge is absent (optimistic UI)');
// A clean no-op: the caller's optimistic UI still feels responsive in a browser.
// ---------------------------------------------------------------------------
await testAsync('setRememberWindowBounds(true) returns true when the bridge is absent', async () => {
  noBridge();
  assert.equal(await setRememberWindowBounds(true), true);
});
await testAsync('setRememberWindowBounds(false) returns false when the bridge is absent', async () => {
  noBridge();
  assert.equal(await setRememberWindowBounds(false), false);
});
await testAsync('setLaunchAtLogin(true) returns true when the bridge is absent', async () => {
  noBridge();
  assert.equal(await setLaunchAtLogin(true), true);
});
await testAsync('setLaunchAtLogin(false) returns false when the bridge is absent', async () => {
  noBridge();
  assert.equal(await setLaunchAtLogin(false), false);
});
await testAsync('setCloseToTray(true) returns true when the bridge is absent', async () => {
  noBridge();
  assert.equal(await setCloseToTray(true), true);
});
await testAsync('setCloseToTray(false) returns false when the bridge is absent', async () => {
  noBridge();
  assert.equal(await setCloseToTray(false), false);
});

// ---------------------------------------------------------------------------
console.log('\nsetters forward to the bridge and return its reported value (may differ from the passed value)');
// When present the setter resolves to what the OS / main reports, NOT necessarily
// the value passed in — distinct from the absent case which echoes the input.
// ---------------------------------------------------------------------------
await testAsync('setRememberWindowBounds forwards the value and echoes the bridge return', async () => {
  let received;
  windowBridge({ setRememberWindowBounds: async (v) => { received = v; return v; } });
  assert.equal(await setRememberWindowBounds(true), true);
  assert.equal(received, true, 'the value was forwarded to the bridge');
});
await testAsync('setLaunchAtLogin resolves to the OS-reported value (may differ from the passed value)', async () => {
  let received;
  windowBridge({ setLaunchAtLogin: async (v) => { received = v; return true; } });
  assert.equal(await setLaunchAtLogin(false), true, 'resolves to the OS-reported value, not the passed value');
  assert.equal(received, false, 'the passed value was still forwarded to the OS');
});
await testAsync('setCloseToTray forwards the value and resolves to the persisted value', async () => {
  let received;
  windowBridge({ setCloseToTray: async (v) => { received = v; return v; } });
  assert.equal(await setCloseToTray(true), true);
  assert.equal(received, true, 'the value was forwarded to the bridge');
});

// ---------------------------------------------------------------------------
console.log('\nsetters NEVER reject — a throwing bridge degrades to the passed value (optimistic UI holds)');
// ---------------------------------------------------------------------------
await testAsync('setRememberWindowBounds degrades to the passed value when the bridge rejects', async () => {
  silenceWarn();
  windowBridge({ setRememberWindowBounds: async () => { throw new Error('write failed'); } });
  assert.equal(await setRememberWindowBounds(true), true);
});
await testAsync('setLaunchAtLogin degrades to the passed value when the bridge rejects', async () => {
  silenceWarn();
  windowBridge({ setLaunchAtLogin: async () => { throw new Error('login-item write failed'); } });
  assert.equal(await setLaunchAtLogin(false), false);
});
await testAsync('setCloseToTray degrades to the passed value when the bridge rejects', async () => {
  silenceWarn();
  windowBridge({ setCloseToTray: async () => { throw new Error('tray write failed'); } });
  assert.equal(await setCloseToTray(true), true);
});

// ---------------------------------------------------------------------------
console.log('\ngetTelemetryRuntimeStatus — the read-only drift window (WARDEN-631)');
// ---------------------------------------------------------------------------
await testAsync('returns {drifted:false} when the bridge is absent (no main-process drift to report)', async () => {
  noBridge();
  assert.deepEqual(await getTelemetryRuntimeStatus(), { drifted: false, deliveryFailing: false });
});
await testAsync('returns {drifted:true} when the bridge reports drift', async () => {
  telemetryBridge({ getRuntimeStatus: async () => ({ drifted: true }) });
  assert.deepEqual(await getTelemetryRuntimeStatus(), { drifted: true, deliveryFailing: false });
});
await testAsync('returns {drifted:false} when the bridge reports no drift', async () => {
  telemetryBridge({ getRuntimeStatus: async () => ({ drifted: false }) });
  assert.deepEqual(await getTelemetryRuntimeStatus(), { drifted: false, deliveryFailing: false });
});
await testAsync('coerces a non-boolean `drifted` to {drifted:false} (never a false drift alarm)', async () => {
  // Only an UNAMBIGUOUS boolean drifted:true surfaces the warning. A truthy but
  // non-boolean value (the string 'true', the number 1, explicit null) must NOT.
  telemetryBridge({ getRuntimeStatus: async () => ({ drifted: 'true' }) });
  assert.deepEqual(await getTelemetryRuntimeStatus(), { drifted: false, deliveryFailing: false });
  telemetryBridge({ getRuntimeStatus: async () => ({ drifted: 1 }) });
  assert.deepEqual(await getTelemetryRuntimeStatus(), { drifted: false, deliveryFailing: false });
  telemetryBridge({ getRuntimeStatus: async () => ({ drifted: null }) });
  assert.deepEqual(await getTelemetryRuntimeStatus(), { drifted: false, deliveryFailing: false });
});
await testAsync('coerces a malformed payload (null / missing field / non-object) to {drifted:false}', async () => {
  telemetryBridge({ getRuntimeStatus: async () => null });
  assert.deepEqual(await getTelemetryRuntimeStatus(), { drifted: false, deliveryFailing: false });
  telemetryBridge({ getRuntimeStatus: async () => ({}) });
  assert.deepEqual(await getTelemetryRuntimeStatus(), { drifted: false, deliveryFailing: false });
  telemetryBridge({ getRuntimeStatus: async () => 'drifted?' });
  assert.deepEqual(await getTelemetryRuntimeStatus(), { drifted: false, deliveryFailing: false });
  telemetryBridge({ getRuntimeStatus: async () => 42 });
  assert.deepEqual(await getTelemetryRuntimeStatus(), { drifted: false, deliveryFailing: false });
});
await testAsync('returns {drifted:false} when the bridge rejects (never rejects)', async () => {
  silenceWarn();
  telemetryBridge({ getRuntimeStatus: async () => { throw new Error('IPC dead'); } });
  assert.deepEqual(await getTelemetryRuntimeStatus(), { drifted: false, deliveryFailing: false });
});

await testAsync('passes a sustained delivery-failure signal through (WARDEN-808)', async () => {
  // deliveryFailing is the non-415 twin of drifted. An unambiguous deliveryFailing:true
  // from main must reach the renderer so the Telemetry section can surface it.
  telemetryBridge({ getRuntimeStatus: async () => ({ drifted: false, deliveryFailing: true }) });
  assert.deepEqual(
    await getTelemetryRuntimeStatus(),
    { drifted: false, deliveryFailing: true },
    'a sustained-drop signal flows through unchanged',
  );
  // Both flags can hold at once (a 415 is also a run of drops); both must pass through.
  telemetryBridge({ getRuntimeStatus: async () => ({ drifted: true, deliveryFailing: true }) });
  assert.deepEqual(
    await getTelemetryRuntimeStatus(),
    { drifted: true, deliveryFailing: true },
    'both flags pass through — the renderer decides precedence',
  );
});

await testAsync('coerces a non-boolean deliveryFailing to false (never a false alarm)', async () => {
  // Only an UNAMBIGUOUS deliveryFailing:true surfaces the banner — parity with drifted.
  for (const malformed of ['true', 1, null]) {
    telemetryBridge({ getRuntimeStatus: async () => ({ drifted: false, deliveryFailing: malformed }) });
    // eslint-disable-next-line no-await-in-loop
    assert.deepEqual(
      await getTelemetryRuntimeStatus(),
      { drifted: false, deliveryFailing: false },
      `${JSON.stringify(malformed)} deliveryFailing ⇒ false`,
    );
  }
});

// ---------------------------------------------------------------------------
console.log('\nclearTelemetryRuntimeDrift — the user-driven drift recovery path (WARDEN-631)');
// ---------------------------------------------------------------------------
await testAsync('returns {drifted:false} when the bridge is absent (clean no-op)', async () => {
  noBridge();
  assert.deepEqual(await clearTelemetryRuntimeDrift(), { drifted: false, deliveryFailing: false });
});
await testAsync('returns the post-clear status when main confirms drift cleared', async () => {
  telemetryBridge({ clearRuntimeDrift: async () => ({ drifted: false }) });
  assert.deepEqual(await clearTelemetryRuntimeDrift(), { drifted: false, deliveryFailing: false });
});
await testAsync('still reports drift when main could not clear it (resolves to the real post-clear status)', async () => {
  telemetryBridge({ clearRuntimeDrift: async () => ({ drifted: true }) });
  assert.deepEqual(await clearTelemetryRuntimeDrift(), { drifted: true, deliveryFailing: false });
});
await testAsync('coerces a malformed post-clear payload to {drifted:false} (never a false drift alarm)', async () => {
  telemetryBridge({ clearRuntimeDrift: async () => ({ drifted: 'nope' }) });
  assert.deepEqual(await clearTelemetryRuntimeDrift(), { drifted: false, deliveryFailing: false });
  telemetryBridge({ clearRuntimeDrift: async () => null });
  assert.deepEqual(await clearTelemetryRuntimeDrift(), { drifted: false, deliveryFailing: false });
});
await testAsync('returns {drifted:false} when the bridge rejects (never rejects)', async () => {
  silenceWarn();
  telemetryBridge({ clearRuntimeDrift: async () => { throw new Error('clear failed'); } });
  assert.deepEqual(await clearTelemetryRuntimeDrift(), { drifted: false, deliveryFailing: false });
});

// ---------------------------------------------------------------------------
console.log('\nonTelemetryRuntimeStatus — the live-drift subscription');
// Returns an unsubscribe for a useEffect cleanup. A clean no-op when the bridge
// is absent OR returns null, so the cleanup is safe in every host.
// ---------------------------------------------------------------------------
test('returns a no-op unsubscribe when the bridge is absent (safe useEffect cleanup in a browser)', () => {
  noBridge();
  const unsub = onTelemetryRuntimeStatus(() => {});
  assert.equal(typeof unsub, 'function');
  assert.doesNotThrow(() => unsub(), 'the no-op unsubscribe must not throw');
});
test('forwards the callback to the bridge and returns its unsubscribe', () => {
  let registered;
  const bridgeUnsub = () => {};
  telemetryBridge({ onRuntimeStatus: (cb) => { registered = cb; return bridgeUnsub; } });
  const cb = () => {};
  const unsub = onTelemetryRuntimeStatus(cb);
  assert.equal(registered, cb, 'the callback was forwarded to the bridge');
  assert.equal(unsub, bridgeUnsub, 'the bridge unsubscribe was returned');
});
test('coerces a bridge that returns null to a no-op unsubscribe (defensive ?? coalesce)', () => {
  telemetryBridge({ onRuntimeStatus: () => null });
  const unsub = onTelemetryRuntimeStatus(() => {});
  assert.equal(typeof unsub, 'function');
  assert.doesNotThrow(() => unsub());
});
test('coerces a bridge that returns undefined to a no-op unsubscribe', () => {
  telemetryBridge({ onRuntimeStatus: () => undefined });
  const unsub = onTelemetryRuntimeStatus(() => {});
  assert.equal(typeof unsub, 'function');
  assert.doesNotThrow(() => unsub());
});
test('returns a no-op unsubscribe (never throws into the caller) when onRuntimeStatus throws', () => {
  silenceWarn();
  telemetryBridge({ onRuntimeStatus: () => { throw new Error('subscribe broken'); } });
  let unsub;
  assert.doesNotThrow(() => { unsub = onTelemetryRuntimeStatus(() => {}); }, 'must not throw into the caller');
  assert.equal(typeof unsub, 'function');
  assert.doesNotThrow(() => unsub());
});

// ---------------------------------------------------------------------------
console.log('\nreconcileMainOwnedPref — the renderer HONORS a refusal instead of discarding it (WARDEN-973)');
// The three main-owned switches used to run `void persist…(v)`: optimistic
// setState, authoritative answer thrown away. When main REFUSED (no working
// tray; an OS that won't honor launch-at-login) the switch kept reading ON
// while the feature was OFF, then silently flipped back on next launch. These
// cases drive the REAL reconciler against the REAL setters above, so they pin
// the whole consumer chain, not a re-implementation of it.
// ---------------------------------------------------------------------------

// A fake React state setter: records every value it is handed, in order, so a
// case can assert BOTH the final display value and that the optimistic write
// happened first (the Switch must stay responsive).
const mirror = () => {
  const seen = [];
  const set = (v) => seen.push(v);
  set.seen = seen;
  set.last = () => seen[seen.length - 1];
  return set;
};

await testAsync('close-to-tray: requesting ON against a refusing bridge leaves the display OFF', async () => {
  // The headline case — a Linux desktop with no working tray. main persists OFF
  // and returns false for a requested true (electron/main.cjs createTray()).
  windowBridge({ setCloseToTray: async () => false });
  const display = mirror();
  let refusedWith;
  const resolved = await reconcileMainOwnedPref(true, setCloseToTray, display, (actual) => { refusedWith = actual; });
  assert.equal(resolved, false, 'resolves to what main actually did, not what was asked');
  assert.equal(display.last(), false, 'the Switch reverts to the truth (was: stuck reading ON)');
  assert.deepEqual(display.seen, [true, false], 'optimistic ON first (responsive), then reverted to OFF');
  assert.equal(refusedWith, false, 'the refusal notifier fired with the authoritative value');
});

await testAsync('close-to-tray: an ACCEPTED toggle causes no revert, no refusal and no extra render', async () => {
  // The normal case must stay byte-identical to the pre-fix behavior.
  windowBridge({ setCloseToTray: async (v) => v });
  const display = mirror();
  let refused = false;
  const resolved = await reconcileMainOwnedPref(true, setCloseToTray, display, () => { refused = true; });
  assert.equal(resolved, true);
  assert.equal(refused, false, 'no toast when main honored the request');
  assert.deepEqual(display.seen, [true], 'exactly ONE setState — no extra render churn');
});

await testAsync('launch-at-login: the OS reporting a different value wins over the request', async () => {
  // main re-reads app.getLoginItemSettings() after writing, so a requested true
  // resolves false on a platform that doesn't honor it ("limited on Linux").
  let received;
  windowBridge({ setLaunchAtLogin: async (v) => { received = v; return false; } });
  const display = mirror();
  let refused = false;
  const resolved = await reconcileMainOwnedPref(true, setLaunchAtLogin, display, () => { refused = true; });
  assert.equal(received, true, 'the request was still forwarded to the OS');
  assert.equal(resolved, false, 'the OS-reported value wins');
  assert.equal(display.last(), false, 'the Switch shows what the OS actually did');
  assert.equal(refused, true, 'the user is told why, instead of failing silently');
});

await testAsync('launch-at-login: turning OFF against a bridge still reporting ON reverts to ON', async () => {
  // The refusal is direction-agnostic — a stuck-ON login item must read ON.
  windowBridge({ setLaunchAtLogin: async () => true });
  const display = mirror();
  let refused = false;
  const resolved = await reconcileMainOwnedPref(false, setLaunchAtLogin, display, () => { refused = true; });
  assert.equal(resolved, true);
  assert.deepEqual(display.seen, [false, true], 'optimistic OFF, then reconciled back to the OS truth');
  assert.equal(refused, true);
});

await testAsync('remember-bounds: the authoritative return is honored here too', async () => {
  windowBridge({ setRememberWindowBounds: async () => true });
  const display = mirror();
  let refused = false;
  await reconcileMainOwnedPref(false, setRememberWindowBounds, display, () => { refused = true; });
  assert.equal(display.last(), true);
  assert.equal(refused, true);
});

await testAsync('NO false positives in a browser: the bridge-absent echo never trips a refusal', async () => {
  // lib/electron.ts echoes the passed value when the bridge is absent, so
  // `actual !== requested` is unreachable outside Electron — no spurious toast,
  // no spurious revert. (The Switches are `disabled={!hasWindowBridge()}`
  // besides, but this pins the seam directly rather than relying on that.)
  noBridge();
  for (const [persist, requested] of [
    [setCloseToTray, true], [setCloseToTray, false],
    [setLaunchAtLogin, true], [setLaunchAtLogin, false],
    [setRememberWindowBounds, true], [setRememberWindowBounds, false],
  ]) {
    const display = mirror();
    let refused = false;
    const resolved = await reconcileMainOwnedPref(requested, persist, display, () => { refused = true; });
    assert.equal(resolved, requested, 'the browser echo resolves to the requested value');
    assert.deepEqual(display.seen, [requested], 'no revert');
    assert.equal(refused, false, 'no spurious refusal toast in a browser');
  }
});

await testAsync('a REJECTING bridge keeps the optimistic value and invents no refusal', async () => {
  // The accessors document "never rejects" and degrade to the passed value, so
  // this is belt-and-braces: an unknown outcome must not be reported as a
  // refusal the user never suffered.
  const display = mirror();
  let refused = false;
  const resolved = await reconcileMainOwnedPref(true, async () => { throw new Error('bridge exploded'); }, display, () => { refused = true; });
  assert.equal(resolved, true);
  assert.deepEqual(display.seen, [true], 'the optimistic value is left untouched');
  assert.equal(refused, false, 'no refusal claimed for an outcome we never observed');
});

await testAsync('the optimistic write lands BEFORE the persist call settles (the Switch stays responsive)', async () => {
  let release;
  const pending = new Promise((r) => { release = r; });
  const display = mirror();
  const done = reconcileMainOwnedPref(true, () => pending, display, () => {});
  assert.deepEqual(display.seen, [true], 'display updated synchronously, without waiting on main');
  release(false);
  await done;
  assert.deepEqual(display.seen, [true, false], 'and reconciled once main answered');
});

console.log(`\n✓ ELECTRON BRIDGE TESTS PASS (${passed})`);
