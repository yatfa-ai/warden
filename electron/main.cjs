// Yatfa Warden — Electron main process (CommonJS).
// Spawns the backend server (ESM) as a child process, then opens a window.
const { app, BrowserWindow, dialog, screen, ipcMain, Tray, Menu } = require('electron');
const { fork, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
// Pure window-bounds decision logic (no electron dependency) — see file header.
// main.cjs wires the live electron APIs (screen, win.getBounds/isMaximized, fs)
// to these decisions so the core logic is unit-testable in web/window-state.test.mjs.
const {
  resolveInitialBounds,
  captureBounds,
  captureMaximized,
  rememberIsActive,
  closeToTrayIsActive,
  withRemember,
  withCloseToTray,
  parseWindowState,
  MIN_WIDTH,
  MIN_HEIGHT,
} = require('./window-state.cjs');

const PORT = parseInt(process.env.WARDEN_PORT || '7421', 10);
const HOST = '127.0.0.1';

let serverProcess = null;
let win = null;
// Close-to-tray (WARDEN-330): when ON, closing the window hides it to a tray
// icon instead of quitting, so the backend (and renderer-side desktop alerts)
// keep running. `isQuitting` distinguishes a REAL quit (tray Quit / Cmd+Q /
// OS shutdown) from the X-button hide so the close intercept lets real quits
// proceed and tears the backend down. `closeToTray` is the live cached flag
// (mirror of the persisted window-state.json value); `tray` is the Tray icon.
let isQuitting = false;
let closeToTray = false;
let tray = null;

// Kill anything occupying the port (stale server from a previous run)
function killStalePort() {
  try {
    const out = execSync(`netstat -ano | findstr ":${PORT} " | findstr LISTENING`, { encoding: 'utf8' });
    const pids = [...new Set(out.trim().split('\n').map(l => l.trim().split(/\s+/).pop()))];
    for (const pid of pids) {
      if (pid && pid !== '0') {
        try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }); } catch {}
      }
    }
  } catch { /* port is free */ }
}

function waitForServer(cb) {
  let attempts = 0;
  const tryConnect = () => {
    if (attempts++ > 50) {
      console.error('Server did not start in time. Exiting.');
      dialog.showErrorBox(
        'Yatfa Warden',
        `The backend server did not start in time (port ${PORT}). Check that the port is free and retry.`,
      );
      cleanup();
      app.quit();
      return;
    }
    const req = http.get(`http://${HOST}:${PORT}/`, (res) => {
      if (res.statusCode === 200) cb();
      else setTimeout(tryConnect, 200);
      res.destroy();
    });
    req.on('error', () => setTimeout(tryConnect, 200));
    req.setTimeout(1000, () => { req.destroy(); setTimeout(tryConnect, 200); });
  };
  tryConnect();
}

// --- OS window bounds persistence (WARDEN-263) --------------------------------
// The window's size/position/maximize state is remembered across launches in a
// small JSON file under userData. This is OWNED BY THE MAIN PROCESS (not the
// renderer's localStorage): createWindow() builds the BrowserWindow BEFORE the
// renderer loads, so the renderer's localStorage cannot be read in time to size
// the window. The Settings toggle writes the `remember` flag through to here via
// IPC (preload.cjs). All decision logic is in window-state.cjs (pure/testable);
// these helpers only do the I/O + live-API wiring.

const CAPTURE_DEBOUNCE_MS = 500;
let captureTimer = null;

function windowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

// Read + defensively parse the saved state. Missing/unreadable/malformed file →
// null (fall back to defaults), never throws (WARDEN-89 spirit).
function loadWindowState() {
  try {
    return parseWindowState(fs.readFileSync(windowStatePath(), 'utf8'));
  } catch {
    return null;
  }
}

function saveWindowState(state) {
  try {
    fs.writeFileSync(windowStatePath(), JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn('[warden:window-state] failed to persist', e);
  }
}

// Persist the current normal-state bounds. No-op when the pref is off or the
// window is maximized (so un-maximize restores the last normal bounds).
function flushBoundsCapture(window) {
  if (!window || window.isDestroyed()) return;
  const b = window.getBounds();
  const next = captureBounds(loadWindowState(), b, window.isMaximized());
  if (next) saveWindowState(next);
}

// Persist a maximize/unmaximize transition (immediate, not debounced) so the
// flag is current even if the app closes during a debounce window.
function flushMaximizedCapture(window, isMaximized) {
  if (!window || window.isDestroyed()) return;
  const next = captureMaximized(loadWindowState(), isMaximized);
  if (next) saveWindowState(next);
}

function scheduleBoundsCapture(window) {
  if (captureTimer) clearTimeout(captureTimer);
  captureTimer = setTimeout(() => {
    captureTimer = null;
    flushBoundsCapture(window);
  }, CAPTURE_DEBOUNCE_MS);
}

// Wire the live window's lifecycle events to the capture helpers.
function attachWindowStateCapture(window) {
  window.on('resize', () => scheduleBoundsCapture(window));
  window.on('move', () => scheduleBoundsCapture(window));
  window.on('maximize', () => flushMaximizedCapture(window, true));
  window.on('unmaximize', () => flushMaximizedCapture(window, false));
  // Flush any pending debounced capture on close so the last arrangement is
  // durable even if the app is closed mid-debounce. When close-to-tray is ON
  // and this is not a real quit (isQuitting), intercept the close: hide the
  // window to the tray instead of destroying it. Hiding (not closing) keeps
  // both the renderer (desktop alerts) and the backend alive — and since the
  // window still exists, window-all-closed never fires, so the default quit
  // path is naturally bypassed. WARDEN-330.
  window.on('close', (e) => {
    if (closeToTray && !isQuitting) { e.preventDefault(); window.hide(); return; }
    if (captureTimer) { clearTimeout(captureTimer); captureTimer = null; }
    flushBoundsCapture(window);
  });
}

function createWindow() {
  // Resolve the seed bounds from saved state vs the current displays. A saved
  // window on a now-unplugged monitor falls back to the visible default.
  const saved = loadWindowState();
  const displays = screen.getAllDisplays().map((d) => ({ bounds: d.bounds }));
  const init = resolveInitialBounds(saved, displays);

  const opts = {
    width: init.width,
    height: init.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: 'Yatfa Warden',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  };
  if (init.x != null && init.y != null) {
    opts.x = init.x;
    opts.y = init.y;
  }

  win = new BrowserWindow(opts);
  // We persist maximize but never fullscreen, so always start un-fullscreened
  // and then re-apply the saved maximize flag.
  win.setFullScreen(false);
  if (init.maximized) win.maximize();

  // Fresh frontend after an update is already guaranteed WITHOUT clearing the
  // session, so we load directly: the `?_t=` cache-buster forces a fresh
  // index.html, the server serves HTML with `Cache-Control: no-cache, no-store,
  // must-revalidate`, and Vite's content-hashed asset names mean a new build
  // references brand-new files that are never served stale. session.clearCache()
  // was removed (WARDEN-181): it is redundant for freshness (HTTP-cache-only)
  // and was the original suspect for wiping client state on launch — clearing
  // it every launch is unnecessary surface area. localStorage/IndexedDB live in
  // the userData dir and are not touched by loadURL here.
  win.loadURL(`http://${HOST}:${PORT}/?_t=${Date.now()}`);
  attachWindowStateCapture(win);
  win.on('closed', () => { win = null; });

  // Cache the persisted close-to-tray flag for the close intercept (avoids a
  // sync fs read on every close attempt) and, when ON, create the tray icon so
  // the first window close hides to tray. WARDEN-330.
  closeToTray = closeToTrayIsActive(saved);
  if (closeToTray) createTray();
}

// --- Close-to-tray tray icon + menu (WARDEN-330) -------------------------------
// A persistent system-tray icon shown only while the pref is ON. Click (or the
// "Show" menu item) restores a hidden window; "Quit" sets isQuitting before
// app.quit() so the close intercept lets the quit through and before-quit tears
// the backend down. The tray lives for the app session; it is created/destroyed
// by createTray/destroyTray as the pref is toggled.
function showMainWindow() {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
  }
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Show', click: () => showMainWindow() },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        // Set isQuitting BEFORE app.quit() so (a) the window close intercept
        // (fired as app.quit() closes windows) lets the close proceed instead
        // of hiding to tray, and (b) before-quit's cleanup() tears the backend
        // down on a real quit. Mirrors the isQuitting flag set in before-quit.
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function createTray() {
  if (tray) return true; // idempotent — never stack two icons
  // Mirror launch-at-login's graceful degradation (WARDEN-278): wrap the
  // platform call so an unsupported desktop, misconfigured AppIndicator/SNI,
  // bad image decode, or headless env can't throw out of the IPC handler or
  // createWindow — a throw at launch would boot-loop (the pref is persisted ON).
  // Returns whether the tray attached; the set handler refuses + keeps the flag
  // OFF on failure so the window is never hidden with no tray to restore it.
  // WARDEN-330.
  try {
    tray = new Tray(path.join(__dirname, '..', 'build', 'icon.png'));
    tray.setToolTip('Yatfa Warden');
    tray.setContextMenu(buildTrayMenu());
    tray.on('click', () => showMainWindow());
    return true;
  } catch (e) {
    console.warn('[warden:close-to-tray] Tray creation failed', e);
    tray = null;
    return false;
  }
}

function destroyTray() {
  if (!tray) return;
  tray.destroy();
  tray = null;
}

// IPC bridge (preload.cjs exposes these to the renderer as window.wardenWindow).
// The Settings toggle reads/writes the `remember` flag through these channels;
// main's window-state.json remains the single source of truth.
ipcMain.handle('window:get-remember-bounds', () => {
  return rememberIsActive(loadWindowState());
});
ipcMain.handle('window:set-remember-bounds', (_event, remember) => {
  const next = withRemember(loadWindowState(), remember === true);
  saveWindowState(next);
  return next.remember;
});

// Launch-at-login: the OS (not Warden's own file) is the source of truth, so
// unlike remember-bounds this reads/writes app.getLoginItemSettings() directly
// and needs no window-state.json field. Fully supported on macOS/Windows;
// limited on Linux — both handlers are wrapped in try/catch so a rejecting
// platform degrades to `false` (off) and never crashes. See WARDEN-278.
ipcMain.handle('window:get-launch-at-login', () => {
  try {
    return app.getLoginItemSettings().openAtLogin === true;
  } catch (e) {
    console.warn('[warden:launch-at-login] getLoginItemSettings failed', e);
    return false;
  }
});
ipcMain.handle('window:set-launch-at-login', (_event, openAtLogin) => {
  try {
    app.setLoginItemSettings({ openAtLogin: openAtLogin === true });
  } catch (e) {
    console.warn('[warden:launch-at-login] setLoginItemSettings failed', e);
  }
  try {
    return app.getLoginItemSettings().openAtLogin === true;
  } catch (e) {
    console.warn('[warden:launch-at-login] getLoginItemSettings failed', e);
    return false;
  }
});

// Close-to-tray (WARDEN-330): persisted in window-state.json (the simpler fit —
// there is no OS API for "hide on close"). Unlike launch-at-login the source of
// truth is Warden's own file, so the get handler returns the cached live flag
// (the same value the close intercept uses — initialized from the persisted file
// at createWindow and updated atomically with the file on set), guaranteeing the
// Settings toggle reflects the behavior the close button will actually have.
ipcMain.handle('window:get-close-to-tray', () => {
  return closeToTray === true;
});
ipcMain.handle('window:set-close-to-tray', (_event, on) => {
  if (on === true) {
    // Attach the tray BEFORE flipping the flag / persisting. If the platform
    // rejects the tray (createTray returns false), refuse the toggle: keep the
    // flag + persisted state OFF and return false. This mirrors launch-at-login
    // (WARDEN-278) and prevents stranding the window (hidden on next close with
    // no tray to restore it) and poisoning the next launch with a persisted-ON
    // but no-tray state. WARDEN-330.
    if (!createTray()) {
      closeToTray = false;
      saveWindowState(withCloseToTray(loadWindowState(), false));
      return false;
    }
  } else {
    destroyTray();
  }
  closeToTray = on === true;
  saveWindowState(withCloseToTray(loadWindowState(), closeToTray));
  return closeToTray;
});

app.whenReady().then(() => {
  // Kill any stale server from a previous run
  killStalePort();

  // Start the backend (ESM — can't require() it, so fork it)
  serverProcess = fork(path.join(__dirname, '..', 'src', 'server.js'), [], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'pipe',
  });
  serverProcess.stdout.on('data', (d) => console.log(`[server] ${d.toString().trim()}`));
  serverProcess.stderr.on('data', (d) => console.error(`[server] ${d.toString().trim()}`));
  serverProcess.on('exit', (code) => {
    console.error(`[server] exited with code ${code}`);
  });

  // Clean up server when Electron is killed externally
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  waitForServer(createWindow);
});

function cleanup() {
  if (serverProcess) {
    try { serverProcess.kill('SIGTERM'); } catch {}
    // Force kill after 2s if still alive
    setTimeout(() => { try { serverProcess.kill('SIGKILL'); } catch {} }, 2000);
  }
}

app.on('window-all-closed', () => { cleanup(); app.quit(); });
app.on('before-quit', () => {
  // Mark a real quit BEFORE the window close events fire (app.quit() runs
  // before-quit, then closes each window) so the close-to-tray intercept does
  // not hide the window and block the quit. Covers every real-quit path — tray
  // Quit, Cmd+Q / Alt+F4→quit, OS logout/shutdown — not just the tray menu.
  // WARDEN-330.
  isQuitting = true;
  // Flush any pending bounds capture as a safety net (the window 'close' handler
  // already flushes; this covers an app.quit() that bypasses per-window close).
  if (win && !win.isDestroyed()) {
    if (captureTimer) { clearTimeout(captureTimer); captureTimer = null; }
    flushBoundsCapture(win);
  }
  cleanup();
});
