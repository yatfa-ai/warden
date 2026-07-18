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

// Telemetry runtime-status bridge (WARDEN-631). The drift flag lives in MAIN (the
// pipeline); this is the renderer's read-only window onto it — distinct from
// `wardenWindow` (OS window state) because runtime DELIVERY state is a different
// domain. getRuntimeStatus pulls the current value (called on Settings mount);
// onRuntimeStatus subscribes to live PUSH updates (fired only when drift arms or
// clears) and returns an unsubscribe. Same three-context feature-detection story
// as wardenWindow: absent in `npm run dev` + `node web/smoke.cjs`, present only in
// the Electron app, and the web layer no-ops cleanly when it is missing.
contextBridge.exposeInMainWorld('wardenTelemetry', {
  getRuntimeStatus: () => ipcRenderer.invoke('telemetry:get-runtime-status'),
  // WARDEN-631 — clear the drift breaker when a Test-connection probe confirms the
  // receiver is schema-matched again (the in-session recovery path for a receiver
  // fixed at the same url). No-op when drift is not armed.
  clearRuntimeDrift: () => ipcRenderer.invoke('telemetry:clear-runtime-drift'),
  // WARDEN-538 — push the focused chat/session name to main so extended-tier
  // events can attach the correlation identifier. The renderer calls this on
  // focus / active-pane change. Pure context storage on the main side; names
  // attach only when the user has opted into the extended tier.
  setContext: (ctx) => ipcRenderer.invoke('telemetry:set-context', ctx),
  onRuntimeStatus: (cb) => {
    const listener = (_event, status) => {
      try { cb(status); } catch { /* a renderer callback must never crash main */ }
    };
    ipcRenderer.on('telemetry:runtime-status', listener);
    return () => ipcRenderer.removeListener('telemetry:runtime-status', listener);
  },
});
