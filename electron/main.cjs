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
// Telemetry SOURCE layer (WARDEN-463) — turns main-process failure/freeze
// signals into consent-gated base-tier events routed to `record()`. Off by
// default; see the wiring block in app.whenReady() below. Pure/testable logic
// lives in this CJS module (same pattern as window-state.cjs above). The schema
// constants + validator it exports (SCHEMA_VERSION, validateBaseEvent) are the
// shared cross-module contract the pipeline threads.
const { createTelemetrySource, SCHEMA_VERSION, validateBaseEvent } = require('./telemetry-source.cjs');
// Telemetry PIPELINE assembly (WARDEN-486) + the CJS redact mirror + the pure
// tier resolver (WARDEN-524). main.cjs constructs the pipeline with the REAL
// injected implementations and binds the source's record sink to it — the
// capstone wiring that turns the off-by-default modules into a functioning path:
//   source signal → record() → resolveTier → redact (CJS mirror) → validate → send
const { createTelemetryPipeline } = require('./telemetry-pipeline.cjs');
const { redact: redactTelemetry } = require('./telemetry-redact.cjs');
const { resolveTelemetryTier, readTelemetryPrefs } = require('./telemetry-config.cjs');
const { createTransmissionLog } = require('./telemetry-transmission-log.cjs');

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

// --- Telemetry SOURCE + PIPELINE wiring (WARDEN-463 / WARDEN-486 / WARDEN-524) -
// Optional, OFF-by-default instrumentation (roadmap WARDEN-446 / design
// WARDEN-443). The source subscribes to main-process uncaught errors/rejections,
// to renderer crash/unresponsive signals, and to an event-loop freeze heartbeat —
// turning each into a schema-valid base-tier event routed to `record()`, which is
// bound to the assembled pipeline (redact → validate → transport) below.
//
// TWO LAYERS OF "off = nothing", both driven from the persisted prefs
// (telemetryBaseEnabled / telemetryExtendedEnabled / telemetryEndpoint) — read at
// boot and kept live over the fork's IPC channel on a Settings change:
//   1. CONSENT defaults to off. With consent off the source subscribes to NOTHING
//      and builds/records NOTHING. applyTelemetryConfig() calls
//      `telemetry.setBaseConsent(base)` with the initial value AND on every live
//      change (the source re-evaluates on toggle).
//   2. RECORD is bound to the pipeline's entry point (telemetry.setRecord). The
//      pipeline's own consent resolver (resolveTelemetryTier) is a SECOND off-gate,
//      and the transport is the LAST — consent-off OR no-endpoint sends nothing.
const telemetry = createTelemetrySource({
  // The source's record sink is bound to the pipeline's entry point below — a
  // source signal then flows source → record() → pipeline (resolveTier → redact
  // → validate → transport). record stays inert until baseConsent is read from
  // the persisted config in app.whenReady() (the source only emits with consent
  // on), so binding it captures nothing on its own.
  record: null,
  now: () => Date.now(),
});

// The live telemetry prefs (off / empty-endpoint by default). Driven from the
// persisted config at boot and, on a live Settings change, from the server child
// over the fork's IPC channel (applyTelemetryConfig below). Held in a mutable
// object so the pipeline's consent resolver reads the CURRENT value on every
// record() without being re-wired.
const telemetryPrefs = {
  telemetryBaseEnabled: false,
  telemetryExtendedEnabled: false,
  telemetryEndpoint: '',
  telemetryAuthToken: '',
};

// The local transmission log of ACTUAL send outcomes (WARDEN-583) — verifiability's
// third leg. Session-scoped, in-memory, bounded; records one metadata-only entry
// per real send the pipeline initiates (outcome ok | dropped). It introduces NO
// new data leaving the machine — it is a user-owned local audit of sends the
// client already made. Surfacing it over IPC to the renderer verifiability panel
// is a follow-on slice; THIS slice is the engine + pipeline instrumentation that
// PRODUCES the data in production. The reference is held here so a future IPC
// handler can read `telemetryTransmissionLog.entries()` without re-wiring the
// pipeline.
const telemetryTransmissionLog = createTransmissionLog();

// The pipeline assembly (WARDEN-486). Constructed with the REAL injected
// implementations: the CJS redact mirror (telemetry-redact.cjs), the source's
// schema validator (validateBaseEvent) + version (SCHEMA_VERSION), and a consent
// resolver that reads telemetryPrefs live. The transport (src/telemetry-send.js,
// ESM) cannot be require()'d from CJS, so it is dynamically imported and
// hot-swapped in app.whenReady() via the setSend seam; until then the pipeline's
// default noop transport sends nothing — and nothing reaches it anyway until
// baseConsent is read (also in app.whenReady()). The endpoint is pushed in via
// setEndpoint (applyTelemetryConfig) so the transport's own final gate (consent +
// endpoint) is the last line of defense for "off / unconfigured = nothing".
const telemetryPipeline = createTelemetryPipeline({
  consent: () => resolveTelemetryTier(telemetryPrefs),
  redact: redactTelemetry,
  validate: validateBaseEvent,
  schemaVersion: SCHEMA_VERSION,
  transmissionLog: telemetryTransmissionLog,
  // WARDEN-631 — the runtime drift bridge tap. When the per-endpoint breaker arms
  // (a 415 schema mismatch) or clears (endpoint/schema change or a later success),
  // the pipeline invokes this so main can PUSH the live status to the renderer's
  // Settings telemetry section (see broadcastTelemetryRuntimeStatus below). The
  // pipeline fires ONLY on a real transition, so this never spams the renderer.
  onRuntimeStatus: (status) => broadcastTelemetryRuntimeStatus(status),
});

// Bind the source's record sink to the pipeline entry point — the wiring that was
// deferred (record: null) until the pipeline landed. The source emits only with
// baseConsent on (off by default), so this binding alone captures nothing until
// app.whenReady() reads the persisted consent.
telemetry.setRecord(telemetryPipeline.record);

// Apply the current telemetry prefs to the source + pipeline. Called at boot
// (prefs read from the persisted config) and on every live Settings change
// (forwarded over the fork's IPC channel from the server child, where PUT
// /api/config is serviced + persisted). Drives BOTH layers of the double gate:
//   • the source's baseConsent — arms/disarms the uncaught / rejection / render /
//     unresponsive / heartbeat signal subscriptions (the FIRST "off = nothing").
//   • the pipeline's endpoint — threads to the transport's final gate (consent +
//     endpoint), the LAST "off / unconfigured = nothing". The pipeline's consent
//     resolver reads telemetryPrefs live, so the effective tier (and the
//     extended-requires-base clamp mirrored in resolveTelemetryTier) is current
//     on the next record() with no extra wiring.
// Idempotent + defensive: a malformed/missing field is ignored, and the source's
// setBaseConsent is itself a no-op when the value is unchanged.
function applyTelemetryConfig(prefs) {
  if (!prefs || typeof prefs !== 'object') return;
  if (typeof prefs.telemetryBaseEnabled === 'boolean') {
    telemetryPrefs.telemetryBaseEnabled = prefs.telemetryBaseEnabled;
  }
  if (typeof prefs.telemetryExtendedEnabled === 'boolean') {
    telemetryPrefs.telemetryExtendedEnabled = prefs.telemetryExtendedEnabled;
  }
  if (typeof prefs.telemetryEndpoint === 'string') {
    telemetryPrefs.telemetryEndpoint = prefs.telemetryEndpoint;
  }
  // Auth token (WARDEN-569) — same live-threading as the endpoint: held in
  // telemetryPrefs (cleartext; main-process internal) and pushed to the pipeline
  // so the transport sends `Authorization: Bearer <token>`. An empty/missing
  // token clears the pipeline's token (→ no header → works against an open
  // receiver). Forwarded over the fork's IPC channel alongside endpoint.
  if (typeof prefs.telemetryAuthToken === 'string') {
    telemetryPrefs.telemetryAuthToken = prefs.telemetryAuthToken;
  }
  telemetry.setBaseConsent(telemetryPrefs.telemetryBaseEnabled === true);
  // WARDEN-538 — thread the EXTENDED consent pref to the source so it can attach
  // the focused chat/session name to built events. MUST follow setBaseConsent:
  // the source's setExtendedConsent clamps to `value && baseConsent`, so base has
  // to be current first (mirrors the sink client's extended-requires-base order).
  telemetry.setExtendedConsent(telemetryPrefs.telemetryExtendedEnabled === true);
  telemetryPipeline.setEndpoint(telemetryPrefs.telemetryEndpoint || '');
  telemetryPipeline.setAuthToken(telemetryPrefs.telemetryAuthToken || '');
}

// WARDEN-631 — PUSH the runtime telemetry drift status to the renderer. The drift
// flag lives in MAIN (the pipeline constructed above); the status renders in the
// RENDERER's Settings telemetry section. There was previously NO main→renderer
// channel for runtime DELIVERY state (the renderer derived status purely from
// CONFIG prefs). This is that bridge: when the breaker arms/clears, the pipeline's
// onRuntimeStatus tap calls this, which sends 'telemetry:runtime-status' to the
// focused window's webContents. The renderer ALSO pulls the current value on
// Settings mount (telemetry:get-runtime-status below) so a window opened AFTER
// drift armed shows the correct state immediately — the push handles liveness
// (the status appears the moment drift arms, without reopening Settings).
//
// Metadata only: { drifted: boolean }. Never the payload, the endpoint URL, or any
// identifier — consistent with the transmission log's discipline. Defensive: a
// missing/destroyed window or a throwing webContents is swallowed (telemetry
// status must never crash the host); before any window exists this is a no-op.
function broadcastTelemetryRuntimeStatus(status) {
  try {
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send('telemetry:runtime-status', { drifted: status ? status.drifted === true : false });
    }
  } catch {
    /* a status broadcast must never break the host */
  }
}

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

  // Telemetry source (WARDEN-463): attach the RENDERER signal taps —
  // render-process-gone (→ crash) and unresponsive (→ performance-stall) — to
  // this window's webContents. Re-attached per window (createWindow runs again
  // if the window is recreated); with base consent off this subscribes to
  // nothing. See the main-process block in app.whenReady() for the consent seam.
  if (win.webContents) telemetry.attachRenderer(win.webContents);

  // Cache the persisted close-to-tray flag for the close intercept (avoids a
  // sync fs read on every close attempt) and, when ON, create the tray icon so
  // the first window close hides to tray. Only arm the intercept when the tray
  // actually attaches — otherwise the next close would hide the window with no
  // tray to restore it (stranded window). This mirrors the set handler's
  // refuse-on-failure self-heal (the 'window:set-close-to-tray' handler below).
  // A launch-time failure requires the platform to have degraded between a
  // successful toggle and this launch (e.g. an AppIndicator/SNI drop, a removed
  // build/icon.png, or a headless/Xvfb run); when it happens, self-heal the
  // persisted value to false so the next launch doesn't re-attempt and re-strand
  // (keeps cache == file == Settings display == behavior == false). WARDEN-330.
  const persistedCloseToTray = closeToTrayIsActive(saved);
  if (persistedCloseToTray) {
    closeToTray = createTray();
    if (!closeToTray) {
      saveWindowState(withCloseToTray(loadWindowState(), false));
    }
  } else {
    closeToTray = false;
  }
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

// WARDEN-631 — PULL the current runtime telemetry drift status. The renderer queries
// this when the Settings telemetry section mounts so a window opened AFTER drift
// armed shows the correct state immediately (the push channel 'telemetry:runtime-
// status' handles live updates while Settings is open). Read-only; metadata only.
// Defensive: a pipeline failure degrades to { drifted: false } (no false alarm).
ipcMain.handle('telemetry:get-runtime-status', () => {
  try {
    return telemetryPipeline.getRuntimeStatus();
  } catch {
    return { drifted: false };
  }
});

// WARDEN-631 — clear the runtime drift breaker. The renderer invokes this when a
// "Test connection" probe returns 'connected' (the receiver is schema-matched
// again). A receiver fixed at the SAME url cannot otherwise clear the breaker
// in-session (setEndpoint no-ops on an unchanged url), so this is the recovery
// path that unwedges the user without an endpoint change or restart. clearRuntime-
// Drift is a no-op when drift is not armed, and emits the clear over the push
// channel so the renderer's warning dismisses itself. Returns the new status.
ipcMain.handle('telemetry:clear-runtime-drift', () => {
  try {
    telemetryPipeline.clearRuntimeDrift();
    return telemetryPipeline.getRuntimeStatus();
  } catch {
    return { drifted: false };
  }
});

// WARDEN-538 — RECEIVE the focused chat/session name context from the renderer.
// The renderer pushes { chatName?, sessionName? } on focus / active-pane change;
// main forwards it to the source's context holder so an extended-tier event can
// attach the correlation identifier. Pure context storage: the source attaches
// names ONLY when extended consent is on (which requires base), so this stores
// nothing-identifying-useful until the user has opted into the extended tier —
// and even then the sink's live-tier redactor is the final retain/drop gate.
// Always forwarded (not skipped when base is off): storing two strings is cheap,
// and keeping the context current means a name attaches the instant extended is
// later enabled rather than waiting for the next focus change. Defensive: a bad
// payload is normalized to "no context" by setContext itself.
ipcMain.handle('telemetry:set-context', (_event, ctx) => {
  try {
    telemetry.setContext(ctx);
  } catch {
    /* a context update must never crash the host */
  }
});

app.whenReady().then(async () => {
  // Kill any stale server from a previous run
  killStalePort();

  // Start the backend (ESM — can't require() it, so fork it). The explicit 4th
  // 'ipc' stdio slot documents + guarantees the fork's built-in IPC channel,
  // which the server child uses to forward telemetry pref changes here (where
  // the source + pipeline live) so a Settings flip takes effect on the next
  // signal without a restart. stdout/stderr remain piped (fds 0–2 unchanged).
  // WARDEN-524.
  serverProcess = fork(path.join(__dirname, '..', 'src', 'server.js'), [], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  serverProcess.stdout.on('data', (d) => console.log(`[server] ${d.toString().trim()}`));
  serverProcess.stderr.on('data', (d) => console.error(`[server] ${d.toString().trim()}`));
  serverProcess.on('exit', (code) => {
    console.error(`[server] exited with code ${code}`);
  });

  // Live telemetry-config channel (WARDEN-524). PUT /api/config is serviced
  // inside the server child (which also persists + clamps the prefs); this
  // listener forwards its telemetry-config messages to the main-process
  // source/pipeline so a consent/endpoint toggle starts/stops capture
  // immediately — the success criterion that a runtime change needs no restart.
  serverProcess.on('message', (msg) => {
    if (msg && msg.type === 'telemetry-config') {
      applyTelemetryConfig({
        telemetryBaseEnabled: msg.base,
        telemetryExtendedEnabled: msg.extended,
        telemetryEndpoint: msg.endpoint,
        telemetryAuthToken: msg.authToken,
      });
    }
  });

  // Clean up server when Electron is killed externally
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  // Wire the real transport (src/telemetry-send.js — ESM, so dynamic import) and
  // hot-swap it into the pipeline via the setSend seam. Dynamic import() of an
  // ESM src/ file is supported inside the packaged asar since Electron 28
  // (warden ships Electron 43) and electron/ is unbundled, so this is not
  // transpiled. The pipeline was constructed with the default noop transport, so
  // a load failure leaves telemetry inert (sends nothing) rather than half-wired
  // — and nothing reaches the transport until baseConsent is applied below, so
  // the ordering is safe. WARDEN-524.
  try {
    const transport = await import(path.join(__dirname, '..', 'src', 'telemetry-send.js'));
    telemetryPipeline.setSend(transport.send);
  } catch (e) {
    console.warn('[warden:telemetry] transport module failed to load; telemetry stays inert', e);
  }

  // Telemetry source (WARDEN-463): attach the MAIN-process signal taps. With
  // base consent off (the default) this subscribes to nothing; it only begins
  // capturing once applyTelemetryConfig turns consent on from the persisted
  // pref. The renderer taps are attached per-window inside createWindow()
  // (win.webContents).
  telemetry.attachMain(process);
  // CONSENT + ENDPOINT, read from the persisted config at boot (the live-change
  // channel is the fork's IPC, not re-reads). Replaces the old hardcoded
  // `setBaseConsent(false)`: a user who opted in (base on + endpoint set) now
  // captures for real, while off-by-default / consent-off / no-endpoint are all
  // preserved (the transport is the last gate). WARDEN-524.
  applyTelemetryConfig(readTelemetryPrefs());

  waitForServer(createWindow);
});

function cleanup() {
  // Tear down the telemetry taps so no listener outlives quit (defensive; the
  // process is exiting anyway).
  try { telemetry.dispose(); } catch {}
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
