// Feature-detected bridge to the Electron main process for OS-level window
// state that lives OUTSIDE the renderer's localStorage (WARDEN-263).
//
// Window bounds (size/position/maximize) must be readable at Electron
// createWindow() time — BEFORE the renderer loads — so they cannot live in
// localStorage (UiState). They live in main's window-state.json instead, and
// the only renderer↔main channel is this IPC bridge, exposed by preload.cjs as
// `window.wardenWindow`.
//
// The same web bundle runs in three contexts; in two of them there is no bridge:
//   1. Electron desktop app  → window.wardenWindow present.
//   2. `npm run dev` browser → undefined (no preload).
//   3. `node web/smoke.cjs`   → undefined (no preload).
// Every call below gracefully no-ops when the bridge is missing, so SettingsPage
// never needs to branch on its host. Defaults differ per pref: remember-bounds
// defaults ON (in a browser there is no OS window state to remember anyway),
// while launch-at-login and close-to-tray default OFF (consent — auto-start
// modifies the OS login items; close-to-tray changes what the close button
// does; see WARDEN-278, WARDEN-330). Each accessor
// resolves to its own pref's default when the bridge is absent.

interface WardenWindowBridge {
  getRememberWindowBounds: () => Promise<boolean>;
  setRememberWindowBounds: (remember: boolean) => Promise<boolean>;
  getLaunchAtLogin: () => Promise<boolean>;
  setLaunchAtLogin: (openAtLogin: boolean) => Promise<boolean>;
  getCloseToTray: () => Promise<boolean>;
  setCloseToTray: (on: boolean) => Promise<boolean>;
}

interface WindowWithWarden extends Window {
  wardenWindow?: WardenWindowBridge;
}

function bridge(): WardenWindowBridge | undefined {
  return (window as WindowWithWarden).wardenWindow;
}

// True only inside the Electron desktop app (the preload bridge is present).
// Callers use this to decide whether a window-state control is interactive.
export function hasWindowBridge(): boolean {
  return typeof bridge() !== 'undefined';
}

// Read the persisted "remember window position and size" flag from main. Resolves
// to `true` when the bridge is absent: the pref defaults to ON, and in a browser
// there is no OS window state to remember anyway. Never rejects.
export async function getRememberWindowBounds(): Promise<boolean> {
  const b = bridge();
  if (!b) return true;
  try {
    return await b.getRememberWindowBounds();
  } catch (e) {
    console.warn('[warden:electron] getRememberWindowBounds failed', e);
    return true;
  }
}

// Write the flag through to main (which persists it to window-state.json). A
// clean no-op when the bridge is absent: resolves to the value passed in so the
// caller's optimistic UI still feels responsive in a browser. Never rejects.
export async function setRememberWindowBounds(remember: boolean): Promise<boolean> {
  const b = bridge();
  if (!b) return remember;
  try {
    return await b.setRememberWindowBounds(remember);
  } catch (e) {
    console.warn('[warden:electron] setRememberWindowBounds failed', e);
    return remember;
  }
}

// "Launch Warden at login" — main reads/writes the OS login items via
// app.getLoginItemSettings()/setLoginItemSettings() (no window-state.json field;
// the OS is the source of truth, unlike remember-bounds). See WARDEN-278.
//
// CRITICAL DIFFERENCE from remember-bounds: this pref defaults OFF (consent —
// auto-start modifies the OS login items), so the accessors resolve to `false`
// (NOT `true`) when the bridge is absent. In a browser there is no OS to
// register with regardless. Never rejects; a rejecting platform (Linux) degrades
// to false (off) on the main side too.
export async function getLaunchAtLogin(): Promise<boolean> {
  const b = bridge();
  if (!b) return false;
  try {
    return await b.getLaunchAtLogin();
  } catch (e) {
    console.warn('[warden:electron] getLaunchAtLogin failed', e);
    return false;
  }
}

// Write the launch-at-login flag through to main (which writes the OS login
// items). Resolves to the OS-reported value when the bridge is present and to
// the value passed in (so the caller's optimistic UI stays responsive) when the
// bridge is absent. Never rejects.
export async function setLaunchAtLogin(openAtLogin: boolean): Promise<boolean> {
  const b = bridge();
  if (!b) return openAtLogin;
  try {
    return await b.setLaunchAtLogin(openAtLogin);
  } catch (e) {
    console.warn('[warden:electron] setLaunchAtLogin failed', e);
    return openAtLogin;
  }
}

// "Close to tray" — main persists this to window-state.json and attaches/
// detaches a Tray icon (no OS API for "hide on close"; the file is the source of
// truth, unlike launch-at-login). See WARDEN-330.
//
// Like launch-at-login this pref defaults OFF (consent — changing what the close
// button does is surprising, and in a browser there is no window to hide
// anyway), so the accessors resolve to `false` when the bridge is absent. The
// setter creates/destroys the tray on the main side; it resolves to the
// persisted value (the value passed in when the bridge is absent). Never rejects.
export async function getCloseToTray(): Promise<boolean> {
  const b = bridge();
  if (!b) return false;
  try {
    return await b.getCloseToTray();
  } catch (e) {
    console.warn('[warden:electron] getCloseToTray failed', e);
    return false;
  }
}

export async function setCloseToTray(on: boolean): Promise<boolean> {
  const b = bridge();
  if (!b) return on;
  try {
    return await b.setCloseToTray(on);
  } catch (e) {
    console.warn('[warden:electron] setCloseToTray failed', e);
    return on;
  }
}

// ---------------------------------------------------------------------------
// Telemetry runtime-status bridge (WARDEN-631). The schema-drift flag lives in
// MAIN (the pipeline); this is the renderer's read-only window onto it. Same
// three-context feature-detection story as the window bridge above: present only
// inside the Electron desktop app (preload exposes `window.wardenTelemetry`),
// absent in `npm run dev` and `node web/smoke.cjs`. When absent the accessors
// degrade to "not drifted" and the subscription is a no-op unsubscribe, so the
// Settings telemetry section renders cleanly in every host without branching.

/** The runtime drift status pushed/pulled over the bridge. Metadata only. */
export interface TelemetryRuntimeStatus {
  drifted: boolean;
}

interface WardenTelemetryBridge {
  getRuntimeStatus: () => Promise<TelemetryRuntimeStatus>;
  clearRuntimeDrift: () => Promise<TelemetryRuntimeStatus>;
  // WARDEN-538 — push the focused chat/session name to main so extended-tier
  // events can attach it. Fire-and-forget context; resolves once main has stored it.
  setContext: (ctx: TelemetryContext) => Promise<void>;
  onRuntimeStatus: (cb: (status: TelemetryRuntimeStatus) => void) => () => void;
}

interface WindowWithWardenTelemetry extends Window {
  wardenTelemetry?: WardenTelemetryBridge;
}

function telemetryBridge(): WardenTelemetryBridge | undefined {
  return (window as WindowWithWardenTelemetry).wardenTelemetry;
}

// Pull the current runtime drift status from main. Called when the Settings
// telemetry section mounts so a window opened AFTER drift armed shows the correct
// state (the push below handles live updates while Settings is open). Resolves to
// `{ drifted: false }` when the bridge is absent (browser/dev/smoke) — a
// non-Electron host has no main-process drift to report. Never rejects.
export async function getTelemetryRuntimeStatus(): Promise<TelemetryRuntimeStatus> {
  const b = telemetryBridge();
  if (!b) return { drifted: false };
  try {
    const status = await b.getRuntimeStatus();
    if (status && typeof status === 'object' && typeof status.drifted === 'boolean') {
      return { drifted: status.drifted };
    }
    return { drifted: false };
  } catch (e) {
    console.warn('[warden:electron] getTelemetryRuntimeStatus failed', e);
    return { drifted: false };
  }
}

// Subscribe to LIVE runtime drift transitions (main pushes only when drift arms
// or clears). Returns an unsubscribe. A clean no-op when the bridge is absent:
// returns an unsubscribe that does nothing, so the caller's useEffect cleanup is
// safe in a browser/dev/smoke host. Never throws into the caller.
export function onTelemetryRuntimeStatus(
  cb: (status: TelemetryRuntimeStatus) => void,
): () => void {
  const b = telemetryBridge();
  if (!b) return () => {};
  try {
    return b.onRuntimeStatus(cb) ?? (() => {});
  } catch (e) {
    console.warn('[warden:electron] onTelemetryRuntimeStatus failed', e);
    return () => {};
  }
}

// Tell main to clear the runtime drift breaker — called when a "Test connection"
// probe confirms the receiver is schema-matched again (WARDEN-631). A receiver
// fixed at the SAME url cannot otherwise clear the breaker in-session, so this is
// the user-driven recovery path. Resolves to the post-clear status; a clean
// no-op ({ drifted: false }) when the bridge is absent. Never rejects.
export async function clearTelemetryRuntimeDrift(): Promise<TelemetryRuntimeStatus> {
  const b = telemetryBridge();
  if (!b) return { drifted: false };
  try {
    const status = await b.clearRuntimeDrift();
    if (status && typeof status === 'object' && typeof status.drifted === 'boolean') {
      return { drifted: status.drifted };
    }
    return { drifted: false };
  } catch (e) {
    console.warn('[warden:electron] clearTelemetryRuntimeDrift failed', e);
    return { drifted: false };
  }
}

// ---------------------------------------------------------------------------
// WARDEN-538 — push the FOCUSED chat/session name to main so the telemetry
// source can attach it to extended-tier events. App.tsx calls this on focus /
// active-pane change with `{ chatName: focusedChat?.name }` (sessionName is left
// unset for now — the focused Chat carries no distinct Claude session name; see
// the WARDEN-538 planner decision). Main stores it in the source's context
// holder; names attach ONLY when the user has opted into the extended tier, so
// this payload is inert until then. A clean no-op when the bridge is absent
// (browser/dev/smoke have no main-process telemetry source). Never rejects.
// ---------------------------------------------------------------------------

/** The focused-name context pushed to main for extended-tier event attachment. */
export interface TelemetryContext {
  chatName?: string;
  sessionName?: string;
}

export async function setTelemetryContext(ctx: TelemetryContext): Promise<void> {
  const b = telemetryBridge();
  if (!b) return;
  try {
    await b.setContext(ctx ?? {});
  } catch (e) {
    console.warn('[warden:electron] setTelemetryContext failed', e);
  }
}
