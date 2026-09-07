// Yatfa Warden — Electron main process (CommonJS).
// Spawns the backend server (ESM) as a child process, then opens a window.
const { app, BrowserWindow, dialog, screen, ipcMain, Tray, Menu, shell } = require('electron');
const { fork, execSync } = require('child_process');
const path = require('path');
const { pathToFileURL } = require('url');
const fs = require('fs');
const os = require('os');
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
// Crash sentinel (WARDEN-687) — pure decision logic that detects a main-process
// HARD kill (segfault / OOM-kill / SIGKILL / abrupt exit) on the NEXT launch via
// per-PID marker files. Same pattern as window-state.cjs above: main.cjs wires
// the live fs + process APIs to these pure decisions; the behavior is unit-tested
// in web/crash-sentinel.test.mjs. Wired into app.whenReady() + before-quit below.
const {
  parseMarker,
  markerFileName,
  isCrashSentinelFile,
  detectCrashes,
} = require('./crash-sentinel.cjs');
// Telemetry PIPELINE assembly (WARDEN-486) + the CJS redact mirror + the pure
// tier resolver (WARDEN-524). main.cjs constructs the pipeline with the REAL
// injected implementations and binds the source's record sink to it — the
// capstone wiring that turns the off-by-default modules into a functioning path:
//   source signal → record() → resolveTier → redact (CJS mirror) → validate → send
const { createTelemetryPipeline } = require('./telemetry-pipeline.cjs');
// WARDEN-1258 — the server-child metrics-window → schema-event builder.
const { buildOperationalMetricsEvent } = require('./telemetry-metrics-event.cjs');
const { buildServerStallEvent } = require('./telemetry-stall-event.cjs');
const { redact: redactTelemetry } = require('./telemetry-redact.cjs');
const { resolveTelemetryConsent, readTelemetryPrefs } = require('./telemetry-config.cjs');
const { TELEMETRY_CATEGORIES } = require('../src/telemetry-consent.cjs');
const { createTransmissionLog, readSnapshot, parseTransmissionLog } = require('./telemetry-transmission-log.cjs');
// Application menu (WARDEN-1280). Warden shipped Electron's STOCK template — which
// advertises "About Electron", Help links to electronjs.org, and a File > New
// Window that boots a second instance whose killStalePort() kills the FIRST
// instance's backend. The template below replaces it with items that each lead
// somewhere real; it is electron-free (same split as window-state.cjs) so the
// menu's shape is unit-tested in web/menu-template.test.mjs, and main injects the
// live actions. The stall-journal reduction the Diagnostics item shows is pure
// too (web/stall-summary.test.mjs).
const { buildMenuTemplate } = require('./menu-template.cjs');
const { summarizeStalls, formatStallSummary } = require('./stall-summary.cjs');

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
// WARDEN-1116 — consent is a set of INDEPENDENT per-category switches
// (telemetryIncidentsEnabled / telemetryNamesEnabled), each off by default, none
// implying another. TWO LAYERS OF "off = nothing", both driven from the persisted
// prefs — read at boot and kept live over the fork's IPC channel on a Settings
// change:
//   1. CONSENT defaults to everything off. With nothing collecting the source
//      subscribes to NOTHING and builds/records NOTHING. applyTelemetryConfig()
//      calls `telemetry.setConsent(consent)` with the initial value AND on every
//      live change (the source re-evaluates on toggle — no restart).
//   2. RECORD is bound to the pipeline's entry point (telemetry.setRecord). The
//      pipeline's own consent resolver (resolveTelemetryConsent) is a SECOND
//      off-gate, and the transport is the LAST — nothing collecting OR
//      no-endpoint sends nothing.
const telemetry = createTelemetrySource({
  // The source's record sink is bound to the pipeline's entry point below — a
  // source signal then flows source → record() → pipeline (resolveTier → redact
  // → validate → transport). record stays inert until baseConsent is read from
  // the persisted config in app.whenReady() (the source only emits with consent
  // on), so binding it captures nothing on its own.
  record: null,
  now: () => Date.now(),
  // Non-identifying app release label (WARDEN-665): stamped on every emitted event
  // so a maintainer can attribute volume to a release. Read live from package.json
  // via Electron's app.getVersion() (0.1.19 today); injected here so the source
  // module stays testable without Electron (tests pass appVersion explicitly).
  appVersion: app.getVersion(),
  // Non-identifying OS label (WARDEN-684): stamped on every emitted event so a
  // maintainer can attribute volume to an OS (darwin/win32/linux). Coarser than
  // appVersion (identical for millions of users, no version/host/user/device
  // detail) → same BASE-tier trust posture, no redaction change. Read directly
  // from the Electron main process's process.platform; injected here so the
  // source module stays testable without Electron (tests pass platform explicitly).
  platform: process.platform,
});

// The live telemetry prefs (off / empty-endpoint by default). Driven from the
// persisted config at boot and, on a live Settings change, from the server child
// over the fork's IPC channel (applyTelemetryConfig below). Held in a mutable
// object so the pipeline's consent resolver reads the CURRENT value on every
// record() without being re-wired.
const telemetryPrefs = {
  telemetryEndpoint: '',
  telemetryAuthToken: '',
};
// Every consent category starts OFF. Derived from the category registry so a new
// category needs no edit here.
for (const cat of TELEMETRY_CATEGORIES) telemetryPrefs[cat.configKey] = false;

// The local transmission log of ACTUAL send outcomes (WARDEN-583) — verifiability's
// third leg. Bounded, metadata-only; records one entry per real send the pipeline
// initiates (outcome ok | dropped). It introduces NO new data leaving the machine —
// it is a user-owned local audit of sends the client already made. WARDEN-782 makes
// it DURABLE: the ring is seeded from the persisted file on startup (so a restart
// no longer blanks the verifiability panel) and debounced-saved on each record(),
// flushed on quit. The reference is held here so the IPC handler reads
// `telemetryTransmissionLog.entries()` without re-wiring the pipeline.
//
// --- Persistence helpers (WARDEN-782) -----------------------------------------
// Same userData dir + atomic-rewrite + debounce + skip-malformed discipline as
// window-state.json (the in-repo template at lines ~262-339; saveWindowState below
// uses the same temp-file + rename shape as saveTransmissionLog). The file is NDJSON
// (one metadata-only entry per line); the ring is already capped in memory, so the
// file is bounded over the app's lifetime (never append-only growth). METADATA ONLY
// by construction — the ring never holds payload content / redacted fields / chat-or-
// session identifiers, so the file cannot either.
const TRANSMISSION_LOG_DEBOUNCE_MS = 500; // mirror CAPTURE_DEBOUNCE_MS

function transmissionLogPath() {
  return path.join(app.getPath('userData'), 'telemetry-transmission-log.json');
}

// Read + skip-malformed parse. Missing/unreadable file → [] (a fresh install or a
// first run has no audit yet), never throws.
function loadTransmissionLog() {
  try {
    return parseTransmissionLog(fs.readFileSync(transmissionLogPath(), 'utf8'));
  } catch {
    return [];
  }
}

// Atomic rewrite (temp file + rename) so a partial write is never observable — the
// reader sees either the previous complete file or the new one, never a torn write.
// catch + warn (never throws): a persist failure must not break the send path.
function saveTransmissionLog(filePath, entries) {
  try {
    const text = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (e) {
    console.warn('[warden:telemetry-transmission-log] failed to persist', e);
  }
}

const telemetryTransmissionLog = createTransmissionLog({
  // Lazy path resolution (constraint A): the arrow runs only when save fires —
  // always POST-ready, since record() fires only after baseConsent is read in
  // app.whenReady(). So app.getPath('userData') is never touched at require() time
  // (a top-level getPath would throw before whenReady → boot-loop).
  save: (entries) => saveTransmissionLog(transmissionLogPath(), entries),
  debounceMs: TRANSMISSION_LOG_DEBOUNCE_MS,
});

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
  consent: () => resolveTelemetryConsent(telemetryPrefs),
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

// WARDEN-1258 — turn a server-child metrics window (the 'telemetry-metrics' IPC
// message) into an `operational-metrics` schema event and record it through the
// standard pipeline. The per-category consent gate lives HERE at the producer
// (mirroring how the incidents source gates at build time): the server child
// already refuses to record while the category is off and drops the window at
// flush time, and this receipt-side re-check closes the mid-flip gap for a
// window that was in flight when the user revoked. The snapshot is AGGREGATES
// ONLY by construction of its producer, and the pipeline's own redact →
// validate stages remain the wire's last line of defense — a malformed or
// hostile snapshot is dropped pre-send, never trusted because it came from our
// child.
function recordOperationalMetricsWindow(snapshot) {
  if (resolveTelemetryConsent(telemetryPrefs)['operational-metrics'] !== true) return;
  const event = buildOperationalMetricsEvent({
    snapshot,
    schemaVersion: SCHEMA_VERSION,
    // The same non-identifying labels the incident builders attach (read from
    // the same seams: the Electron app's release label, process.platform).
    appVersion: app.getVersion(),
    platform: process.platform,
    now: Date.now,
  });
  if (event) telemetryPipeline.record(event);
}

// WARDEN-1278 — turn a server-child STALL window (the 'telemetry-stalls' IPC
// message) into a `server-stall` schema event and record it through the standard
// pipeline. Same double gate as the metrics receipt above: the server child
// already refuses to record while `incidents` is off and drops the window at
// flush time, and this receipt-side re-check closes the mid-flip gap for a
// window that was in flight when the user revoked.
//
// It rides `incidents` because a multi-second freeze IS an incident — the same
// category the main process's own `performance-stall` already travels under. No
// new category was added for it, and none should be.
function recordServerStallWindow(snapshot) {
  if (resolveTelemetryConsent(telemetryPrefs).incidents !== true) return;
  const event = buildServerStallEvent({
    snapshot,
    schemaVersion: SCHEMA_VERSION,
    appVersion: app.getVersion(),
    platform: process.platform,
    now: Date.now,
  });
  if (event) telemetryPipeline.record(event);
}

// Apply the current telemetry prefs to the source + pipeline. Called at boot
// (prefs read from the persisted config) and on every live Settings change
// (forwarded over the fork's IPC channel from the server child, where PUT
// /api/config is serviced + persisted). Drives BOTH layers of the double gate:
//   • the source's consent — arms/disarms the uncaught / rejection / render /
//     unresponsive / heartbeat signal subscriptions (the FIRST "off = nothing")
//     and the name-attachment gate, per category and independently.
//   • the pipeline's endpoint — threads to the transport's final gate (consent +
//     endpoint), the LAST "off / unconfigured = nothing". The pipeline's consent
//     resolver reads telemetryPrefs live, so the effective per-category consent is
//     current on the next record() with no extra wiring and no restart.
// Idempotent + defensive: a malformed/missing field is ignored, and the source's
// setConsent is itself a no-op for the arm/disarm side when nothing changed.
function applyTelemetryConfig(prefs) {
  if (!prefs || typeof prefs !== 'object') return;
  // Per-category consent, applied independently and driven by the registry: a
  // malformed/missing value leaves that category untouched (and it started off).
  for (const cat of TELEMETRY_CATEGORIES) {
    if (typeof prefs[cat.configKey] === 'boolean') {
      telemetryPrefs[cat.configKey] = prefs[cat.configKey];
    }
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
  // WARDEN-1116 — one call applies every category. No ordering dependency exists
  // any more: the categories are independent, so there is no clamp that requires
  // one to be applied before another.
  telemetry.setConsent(resolveTelemetryConsent(telemetryPrefs));
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
// Metadata only: { drifted: boolean, deliveryFailing: boolean }. Never the
// payload, the endpoint URL, or any identifier — consistent with the transmission
// log's discipline. `deliveryFailing` (WARDEN-808) is the sustained non-415
// delivery-failure signal the pipeline derives from the transmission-log ring;
// it is pure observability (sending is NOT paused — unlike `drifted`).
// Defensive: a missing/destroyed window or a throwing webContents is swallowed
// (telemetry status must never crash the host); before any window exists this is
// a no-op.
function broadcastTelemetryRuntimeStatus(status) {
  try {
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send('telemetry:runtime-status', {
        drifted: status ? status.drifted === true : false,
        deliveryFailing: status ? status.deliveryFailing === true : false,
      });
    }
  } catch {
    /* a status broadcast must never break the host */
  }
}

// --- Application menu (WARDEN-1280) -------------------------------------------
// Replaces Electron's stock template. The template SHAPE lives in the
// electron-free menu-template.cjs (unit-tested); everything below is the wiring
// main alone can do — the live Electron APIs behind each item.
//
// The data dir is computed HERE rather than imported: package.json is
// `"type": "module"` so everything under src/ is ESM, and this file is CJS and
// cannot require() it. src/config.js:8 and src/activity.js:13 each already
// compute this same path independently, so a third independent computation is
// the established in-tree shape rather than a new one. (The stall JOURNAL read
// below does NOT duplicate anything: it dynamically imports the REAL readStalls,
// which CJS→ESM dynamic import supports inside the packaged asar since Electron
// 28 — the same move main already makes for the telemetry transport.)
function wardenDataDir() {
  return path.join(os.homedir(), '.yatfa-warden');
}

// Resolve an ESM module under src/ to a specifier `import()` accepts on EVERY
// platform. A bare `path.join(...)` result is NOT such a specifier: on win32 it
// is a drive-letter path (`C:\...\src\stall-log.js`) whose leading `C:` Node's
// ESM loader parses as a URL SCHEME and rejects before touching the filesystem
// (`ERR_UNSUPPORTED_ESM_URL_SCHEME: ... Received protocol 'c:'`). Electron's main
// process uses Node's own ESM loader, so this is Node's documented behavior, not
// an Electron quirk. POSIX absolute paths happen to URL-resolve, which is exactly
// why the bug is invisible on macOS/Linux — and warden ships a Windows NSIS
// installer. `pathToFileURL().href` is the standard fix.
function srcModuleUrl(...segments) {
  return pathToFileURL(path.join(__dirname, '..', 'src', ...segments)).href;
}

// Push a main→renderer message defensively. Copied from
// broadcastTelemetryRuntimeStatus's discipline: a missing/destroyed window or a
// throwing webContents is swallowed, because a menu click must never crash the
// host. Before any window exists this is a no-op (the menu is installed before
// the window loads, and a click can also race a close).
function sendToRenderer(channel, payload) {
  try {
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload);
      return true;
    }
  } catch {
    /* a menu action must never break the host */
  }
  return false;
}

// About (Windows/Linux). `role: 'about'` renders the native About panel only on
// macOS, so the other platforms take this dialog — carrying the SAME facts and no
// others: the product name, the real app.getVersion(), and the package
// description. Deliberately NO website/credits/authors: package.json carries no
// repository/homepage/bugs/author fields, and an About box that invents a
// destination is exactly what this ticket removes.
//
// The description is READ from package.json rather than transcribed, so an edit
// to the manifest cannot silently drift out of the About box (app.getVersion()
// already reads that same manifest for the version). package.json is JSON, so
// require() crosses no ESM boundary, and it ships inside the asar (build.files).
// A read failure falls back to the product name alone rather than throwing.
function appDescription() {
  try {
    const desc = require('../package.json').description;
    if (typeof desc === 'string' && desc.trim()) return desc.trim();
  } catch (e) {
    console.warn('[warden:menu] package description unreadable', e);
  }
  return 'Yatfa Warden';
}

function showAboutDialog() {
  try {
    dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
      type: 'info',
      title: 'About Yatfa Warden',
      message: 'Yatfa Warden',
      detail: `Version ${app.getVersion()}\n${appDescription()}`,
      buttons: ['OK'],
      noLink: true,
    });
  } catch (e) {
    console.warn('[warden:menu] About dialog failed', e);
  }
}

// Open ~/.yatfa-warden/ in the OS file manager. The directory is created on
// demand by its writers (stall-log / activity / config), so on a brand-new
// install it may not exist yet — create it rather than showing the owner an
// openPath error for a folder that is merely empty.
async function openDataFolder() {
  const dir = wardenDataDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.warn('[warden:menu] could not create data dir', e);
  }
  try {
    const err = await shell.openPath(dir);
    if (err) console.warn(`[warden:menu] openPath failed: ${err}`);
  } catch (e) {
    console.warn('[warden:menu] openPath threw', e);
  }
}

// Stall diagnostics. The server writes ~/.yatfa-warden/stalls.jsonl (WARDEN-977)
// and serves it at GET /api/diagnostics/stalls — a surface with zero UI consumers,
// reachable only by knowing the path by heart. This item is the person-facing
// read: the SAME journal, through the SAME reader (readStalls, dynamically
// imported across the ESM boundary), bounded by the same 500-record ceiling the
// endpoint applies, reduced to count / last / top culprit by the pure summarizer.
// Every failure mode degrades to a readable dialog: an unloadable module or an
// unreadable journal reports that rather than throwing out of the click handler.
async function showStallDiagnostics() {
  const journal = path.join(wardenDataDir(), 'stalls.jsonl');
  let summaryText;
  try {
    const stallLog = await import(srcModuleUrl('stall-log.js'));
    const stalls = await stallLog.readStalls({ limit: 500 });
    summaryText = formatStallSummary(summarizeStalls(stalls), { logFile: journal });
  } catch (e) {
    console.warn('[warden:menu] stall diagnostics read failed', e);
    summaryText = `Could not read the stall journal.\n\nJournal: ${journal}`;
  }
  try {
    const res = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
      type: 'info',
      title: 'Stall Diagnostics',
      message: 'Server event-loop stalls',
      detail: summaryText,
      buttons: ['Open Data Folder', 'Close'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (res && res.response === 0) await openDataFolder();
  } catch (e) {
    console.warn('[warden:menu] stall diagnostics dialog failed', e);
  }
}

// Install the application menu. Called once from app.whenReady(), replacing the
// stock template for every window in the app.
function installApplicationMenu() {
  try {
    // The macOS About panel's contents (what the `role: 'about'` item renders).
    // Name + version only — the same no-invented-destinations rule as the
    // Windows/Linux dialog above.
    if (process.platform === 'darwin') {
      app.setAboutPanelOptions({
        applicationName: 'Yatfa Warden',
        applicationVersion: app.getVersion(),
      });
    }
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        buildMenuTemplate({
          platform: process.platform,
          appName: 'Yatfa Warden',
          handlers: {
            // The menu's Settings… item opens the SAME Settings page the gear
            // button opens: main pushes this, the renderer's one effect calls
            // setSettingsOpen(true). No preload (browser / smoke) → no
            // subscription → those contexts are byte-unaffected.
            openSettings: () => sendToRenderer('menu:open-settings'),
            showAbout: () => showAboutDialog(),
            showStallDiagnostics: () => { void showStallDiagnostics(); },
            openDataFolder: () => { void openDataFolder(); },
          },
        }),
      ),
    );
  } catch (e) {
    // A menu failure must never stop the app from booting — the window and the
    // backend matter more than the menu bar.
    console.warn('[warden:menu] application menu install failed', e);
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

// Atomic rewrite (temp file + rename), mirroring saveTransmissionLog above so a
// partial write is never observable — an interrupted write (OS logout/shutdown
// mid-write) leaves either the previous complete state or the new one, never a
// truncated file the loader would read as absent (defaults). Sync on purpose:
// main.cjs is CommonJS and the shared atomic-write helper is an async ES module,
// not importable here. catch + warn (never throws): a persist failure must not
// break the save path.
function saveWindowState(state) {
  try {
    const filePath = windowStatePath();
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
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

// --- Crash sentinel (WARDEN-687) ------------------------------------------------
// Detect a main-process HARD kill (native segfault / OOM-kill / SIGKILL / power
// loss / abrupt process.exit) on the NEXT launch. Such a kill bypasses
// uncaughtExceptionMonitor (which intercepts JS exceptions only), so the prior
// instance died emitting NOTHING; a per-PID marker file turns that undetectable
// death into one normal base-tier crash event. Pure decision logic lives in
// crash-sentinel.cjs (same pattern as window-state.cjs); these helpers only do
// the fs I/O + live-liveness wiring. Wired in app.whenReady() + before-quit.

// A per-startup nonce written into THIS instance's marker. Guards against PID
// reuse (a stale marker whose pid the OS recycled) and gives each instance a
// distinct, traceable marker. crypto.randomUUID() is available in the Electron
// main process (Node ≥ 19) and is unique per startup; the fallback keeps the
// nonce non-empty on any older runtime.
const thisInstanceNonce =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${process.pid}-${Math.random().toString(36).slice(2)}`;

function crashSentinelDir() {
  return app.getPath('userData');
}

// True iff `pid` identifies a LIVE process. signal-0 (`process.kill(pid, 0)`)
// throws ESRCH for a dead pid and EPERM for an alive pid the user may not signal
// (same-user warden processes are signalable, so EPERM is rare — but it still
// means the process EXISTS → alive). Never throws.
function isPidAlive(pid) {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!(e && e.code === 'EPERM');
  }
}

// Read every crash-sentinel-<pid>.json in userData into parsed markers. Returns
// [] when userData is unreadable/empty (a fresh install — nothing to detect).
function readCrashSentinelMarkers() {
  let files = [];
  try {
    files = fs.readdirSync(crashSentinelDir());
  } catch {
    return [];
  }
  const markers = [];
  for (const name of files) {
    if (!isCrashSentinelFile(name)) continue;
    let raw;
    try {
      raw = fs.readFileSync(path.join(crashSentinelDir(), name), 'utf8');
    } catch {
      continue; // a marker file vanished mid-scan → skip it
    }
    const marker = parseMarker(raw);
    if (marker) markers.push(marker);
  }
  return markers;
}

// The startup detection pass. For each marker whose PID is dead (a prior instance
// died hard) emit exactly ONE consent-gated main-crash event, then delete the
// marker file. The DELETE is consent-INdependent (so a second relaunch never
// re-emits — DONE criterion #4); the EMIT is consent-gated inside recordMainCrash
// (off → nothing built or recorded — DONE criterion #3). Markers whose PID is
// still alive belong to a concurrent instance and are LEFT untouched (DONE
// criterion #6). At most one emit per crashed instance.
function runCrashSentinelDetection() {
  const markers = readCrashSentinelMarkers();
  const { crashed } = detectCrashes(markers, isPidAlive);
  for (const marker of crashed) {
    try {
      telemetry.recordMainCrash();
    } catch {
      /* a telemetry emit must never crash the host */
    }
    try {
      fs.unlinkSync(path.join(crashSentinelDir(), markerFileName(marker.pid)));
    } catch {
      /* a marker we failed to clear may re-emit next launch — safe direction */
    }
  }
}

// Write THIS instance's marker AFTER the detection pass (so the pass never
// detects the current instance): crash-sentinel-<pid>.json holding the pid +
// per-startup nonce. A hard kill skips before-quit, leaving this file for the
// next launch to detect. Overwrites any stale same-pid file (warden PID reuse).
function writeThisInstanceMarker() {
  try {
    fs.writeFileSync(
      path.join(crashSentinelDir(), markerFileName(process.pid)),
      JSON.stringify({ pid: process.pid, nonce: thisInstanceNonce }),
    );
  } catch (e) {
    console.warn('[warden:crash-sentinel] failed to write marker', e);
  }
}

// before-quit: clear ONLY this instance's marker (per-PID keying — a concurrent
// instance's marker is untouched). A real quit covers every clean-exit path; a
// hard kill never reaches here, so the marker stays for the next launch (as
// intended). DONE criterion #2 (a clean quit → relaunch lands zero events).
function clearThisInstanceMarker() {
  try {
    fs.unlinkSync(path.join(crashSentinelDir(), markerFileName(process.pid)));
  } catch {
    /* already gone (fresh launch that never wrote one) — nothing to clear */
  }
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

// WARDEN-1256 — open an http(s) URL in the user's SYSTEM browser. The renderer's
// terminal URL links (Ctrl/Cmd+click in an agent pane) invoke this over the
// wardenWindow bridge; main is the only place with shell access, so the hardened
// webPreferences (contextIsolation: true, nodeIntegration: false) stay exactly as
// they are. shell.openExternal delegates to the OS default browser (not an
// Electron window, and it never navigates the app window). The scheme allow-list
// is enforced HERE, not in the renderer: a compromised renderer must not be able
// to aim openExternal at file:// or other OS handlers — only http/https are in
// scope for this feature (and for this handler). Returns true when the URL was
// handed to the OS, false when it was refused or the OS open failed.
ipcMain.handle('window:open-external', (_event, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    console.warn('[warden:open-external] refused non-http(s) url:',
      typeof url === 'string' ? url.slice(0, 100) : typeof url);
    return false;
  }
  return shell.openExternal(url)
    .then(() => true)
    .catch((e) => {
      // openExternal rejects (no OS handler / OS refusal) rather than throwing
      // synchronously; degrade to false so the renderer never sees a rejection.
      console.warn('[warden:open-external] shell.openExternal failed', e);
      return false;
    });
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
    return { drifted: false, deliveryFailing: false };
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
    return { drifted: false, deliveryFailing: false };
  }
});

// WARDEN-668 — PULL the local transmission log of ACTUAL send outcomes —
// verifiability's THIRD leg (the promise + preview legs ship in the renderer's
// TelemetryTransparency panel; this is what really landed on the wire). The ring
// is the same in-memory, session-scoped, bounded (cap 200) log the pipeline feeds
// on every real send (WARDEN-583). Read-only: readSnapshot returns entries() — a
// SNAPSHOT copy — so the renderer can never mutate pipeline state through it.
// Defensive: any failure degrades to [] (readSnapshot also guards a non-log),
// so the verifiability panel shows an honest "no sends" rather than crashing.
// Metadata only (entry shape: timestamp, endpointHost, schemaVersion, eventCount,
// outcome, attempts, status — host-only, never the full URL or payload). No new
// consent flag, no new data leaving the machine — this only makes already-
// recorded, user-owned data visible to the user who owns it.
ipcMain.handle('telemetry:transmission-log', () => readSnapshot(telemetryTransmissionLog));

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

// WARDEN-637 — forward a renderer-process JS error to the consent-gated source.
// The renderer (React UI) forwards errors the main-process source cannot see on
// its own: a React render throw caught by ErrorBoundary (via the `wardenTelemetry`
// bridge's reportError), and global window `error` / `unhandledrejection` events
// (installed by installRendererErrorCapture in the web bundle — NOT preload; see
// the WARDEN-637 note in preload.cjs for the contextIsolation rationale).
// Both arrive on this one channel as a serializable
// { name, message, stack } (Error instances do not survive the contextBridge
// clone). recordRendererError builds a renderer-runtime error event from those
// fields (buildErrorEvent reads the serialized shape directly — refinement B) and
// routes it through the SAME consent-gated record() pipeline as main-process
// errors. It is a no-op while base consent is off (refinement D): the renderer
// forwards unconditionally, main drops it here — nothing is built, recorded, or
// sent until the user opts in. Paired with `ipcRenderer.send` (fire-and-forget,
// no return value) — NOT `invoke`/`handle`, so the forward is safe to fire from
// inside a global `unhandledrejection` listener with no floating promise to loop.
ipcMain.on('telemetry:renderer-error', (_event, serialized) => {
  try {
    telemetry.recordRendererError(serialized);
  } catch {
    /* a telemetry forward must never crash the host */
  }
});

app.whenReady().then(async () => {
  // Replace Electron's STOCK application menu (WARDEN-1280). Installed FIRST —
  // before the backend fork and the window — so the app never briefly shows the
  // stock template's "About Electron" / electronjs.org / New Window items, and so
  // a menu failure surfaces before anything depends on it. installApplicationMenu
  // swallows its own errors, so this can never block boot.
  installApplicationMenu();

  // Kill any stale server from a previous run
  killStalePort();

  // Restore the transmission-log ring from the persisted audit file BEFORE any send
  // can fire (constraint A: the file is read post-ready; the ring is seeded before
  // the transport is swapped + consent applied below, so no record() can race the
  // seed). A routine Warden restart no longer blanks Settings → telemetry →
  // "Recent send outcomes" — the pre-restart audit is restored. WARDEN-782.
  telemetryTransmissionLog.seed(loadTransmissionLog());

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
    // WARDEN-1258 — the server child's file-exists probe metrics window. The
    // server aggregates (counts / ok-fail / latency histograms, aggregates
    // only — never a path or hostname) and forwards the closed window here,
    // because the consent-gated pipeline + transport live in MAIN. Building
    // the schema event and recording it routes through the SAME gates every
    // other event passes: consent → redact → validate → send. A malformed
    // snapshot is dropped pre-send by the pipeline's validator (never sent).
    if (msg && msg.type === 'telemetry-metrics') {
      recordOperationalMetricsWindow(msg.snapshot);
    }
    // WARDEN-1278 — the server child's event-loop STALL window. Same shape of
    // channel as the metrics window above and the same gates; the difference is
    // the event it builds carries `runtime: 'server'`, which the v6 schema
    // introduced precisely so a freeze in the backend child can be reported as
    // having happened THERE. The owner's local stall channels (stalls.jsonl,
    // the stderr line, /api/diagnostics/stalls) are untouched by this path.
    if (msg && msg.type === 'telemetry-stalls') {
      recordServerStallWindow(msg.snapshot);
    }
    if (msg && msg.type === 'telemetry-config') {
      // The server forwards the already-sanitized per-category consent under
      // `categories` ({ incidents: bool, names: bool }); map it back onto the
      // registry's config keys. Anything absent stays as it was (and defaults off).
      const categories = msg.categories && typeof msg.categories === 'object' ? msg.categories : {};
      const forwarded = {};
      for (const cat of TELEMETRY_CATEGORIES) {
        if (typeof categories[cat.id] === 'boolean') forwarded[cat.configKey] = categories[cat.id];
      }
      applyTelemetryConfig({
        ...forwarded,
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
    const transport = await import(srcModuleUrl('telemetry-send.js'));
    telemetryPipeline.setSend(transport.send);
  } catch (e) {
    console.warn('[warden:telemetry] transport module failed to load; telemetry stays inert', e);
  }

  // Telemetry source (WARDEN-463): attach the MAIN-process signal taps. With
  // base consent off (the default) this subscribes to nothing; it only begins
  // capturing once applyTelemetryConfig turns a collecting category on from the persisted
  // pref. The renderer taps are attached per-window inside createWindow()
  // (win.webContents).
  telemetry.attachMain(process);
  // CONSENT + ENDPOINT, read from the persisted config at boot (the live-change
  // channel is the fork's IPC, not re-reads). Replaces the old hardcoded
  // hardcoded all-off consent: a user who opted in (a collecting category on +
  // endpoint set) now captures for real, while off-by-default / consent-off /
  // no-endpoint are all preserved (the transport is the last gate). WARDEN-524.
  applyTelemetryConfig(readTelemetryPrefs());

  // Crash sentinel (WARDEN-687): detect a main-process hard kill from a PRIOR
  // run BEFORE writing this instance's marker (so the pass never detects itself).
  // Emits one consent-gated crash per dead-PID marker (off → nothing), clears
  // those markers (consent-independent — no re-emit on a second relaunch), then
  // writes THIS instance's marker. Runs synchronously at startup — before the
  // window loads — so a crash during window load is still captured next launch.
  runCrashSentinelDetection();
  writeThisInstanceMarker();

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
  // Crash sentinel (WARDEN-687): clear THIS instance's marker on a real quit so a
  // clean quit → relaunch lands ZERO crash events (DONE criterion #2). Per-PID
  // keying means a concurrent instance's marker is untouched. A hard kill never
  // reaches before-quit, so the marker stays for the next launch to detect.
  clearThisInstanceMarker();
  // Transmission log (WARDEN-782): flush any pending debounced save so the last
  // sends are durable if the app closes mid-debounce (mirrors the window-state
  // flush-on-quit above). No-op when nothing is pending; never breaks the quit path.
  try { telemetryTransmissionLog.flushSave(); } catch {}
  cleanup();
});
