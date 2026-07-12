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
// while launch-at-login defaults OFF (consent — see WARDEN-278). Each accessor
// resolves to its own pref's default when the bridge is absent.

interface WardenWindowBridge {
  getRememberWindowBounds: () => Promise<boolean>;
  setRememberWindowBounds: (remember: boolean) => Promise<boolean>;
  getLaunchAtLogin: () => Promise<boolean>;
  setLaunchAtLogin: (openAtLogin: boolean) => Promise<boolean>;
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
