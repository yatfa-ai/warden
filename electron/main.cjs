// Yatfa Warden — Electron main process (CommonJS).
// Spawns the backend server (ESM) as a child process, then opens a window.
const { app, BrowserWindow, dialog, screen, ipcMain } = require('electron');
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
  withRemember,
  parseWindowState,
  MIN_WIDTH,
  MIN_HEIGHT,
} = require('./window-state.cjs');

const PORT = parseInt(process.env.WARDEN_PORT || '7421', 10);
const HOST = '127.0.0.1';

let serverProcess = null;
let win = null;

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
  // durable even if the app is closed mid-debounce.
  window.on('close', () => {
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
  // Flush any pending bounds capture as a safety net (the window 'close' handler
  // already flushes; this covers an app.quit() that bypasses per-window close).
  if (win && !win.isDestroyed()) {
    if (captureTimer) { clearTimeout(captureTimer); captureTimer = null; }
    flushBoundsCapture(win);
  }
  cleanup();
});
