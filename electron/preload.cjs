// Yatfa Warden — Electron preload (CommonJS).
//
// The minimal, explicitly-allowlisted bridge between the renderer (web bundle)
// and the Electron main process for OS-level window state that lives OUTSIDE
// the renderer's localStorage (see WARDEN-263). contextBridge keeps
// nodeIntegration off: the renderer only ever sees the two async functions
// exposed on `window.wardenWindow`.
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
});
