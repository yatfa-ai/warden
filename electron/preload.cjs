// Yatfa Warden — Electron preload (CommonJS).
//
// The minimal, explicitly-allowlisted bridge between the renderer (web bundle)
// and the Electron main process for OS-level state that lives OUTSIDE the
// renderer's localStorage (see WARDEN-263, WARDEN-278). contextBridge keeps
// nodeIntegration off: the renderer only ever sees the async functions exposed
// on `window.wardenWindow` (remember-bounds + launch-at-login).
//
// The same web bundle runs in three contexts:
//   1. Electron desktop app  → window.wardenWindow is present (this file).
//   2. `npm run dev` browser → no preload; window.wardenWindow is undefined.
//   3. `node web/smoke.cjs`   → no preload; window.wardenWindow is undefined.
// The web layer feature-detects the bridge (web/src/lib/electron.ts) and
// no-ops cleanly when it is absent, so this file only ever ships in context 1.
// electron-builder's `electron/**/*` glob includes preload.cjs automatically.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wardenWindow', {
  // Resolve to the current persisted `remember` flag (boolean). Main is the
  // source of truth; the renderer treats this as a display mirror only.
  getRememberWindowBounds: () => ipcRenderer.invoke('window:get-remember-bounds'),
  // Write the flag through to main (which persists it to window-state.json).
  // Returns the persisted value.
  setRememberWindowBounds: (remember) => ipcRenderer.invoke('window:set-remember-bounds', remember),
  // "Launch Warden at login" — main reads/writes the OS login items via
  // app.getLoginItemSettings()/setLoginItemSettings() (no window-state.json
  // field; the OS is the source of truth). Off by default. See WARDEN-278.
  getLaunchAtLogin: () => ipcRenderer.invoke('window:get-launch-at-login'),
  setLaunchAtLogin: (openAtLogin) => ipcRenderer.invoke('window:set-launch-at-login', openAtLogin),
  // "Close to tray" — main persists this to window-state.json and attaches/
  // detaches the Tray icon. When ON, closing the window hides it to the tray
  // (backend + desktop alerts stay alive) instead of quitting. Off by default
  // (opt-in). See WARDEN-330.
  getCloseToTray: () => ipcRenderer.invoke('window:get-close-to-tray'),
  setCloseToTray: (on) => ipcRenderer.invoke('window:set-close-to-tray', on),
});
