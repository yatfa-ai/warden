// Auto-update CONTROLLER (WARDEN-1887). Electron-free by injection (the
// menu-template.cjs split): every live dependency — electron-updater's
// autoUpdater, fetch, timers, the packaged flag — is passed in, so the whole
// orchestration (dev-inert, silent vs manual path, in-flight dedupe, failures
// never throwing) is unit-tested in web/updater.test.mjs. main.cjs wires the
// live Electron APIs in installAutoUpdater().
//
// TWO PATHS, one state machine (updater-core.cjs):
//  - SILENT (Windows NSIS, Linux AppImage): electron-updater checks the GitHub
//    release feed, downloads in the background (blockmap-differential), and
//    installs when the app next quits/starts (autoInstallOnAppQuit). Nothing is
//    ever installed under a running session — the only mid-session apply is the
//    user's explicit "Restart" click.
//  - MANUAL (unsigned macOS, non-AppImage Linux): electron-updater is NEVER
//    loaded — Squirrel.Mac refuses unsigned updates, so the silent machinery
//    would only surface errors. Instead the feed file is fetched directly and
//    compared; a newer version becomes an 'available' state carrying a download
//    URL. No silent-install error can exist because nothing silent runs.
const core = require('./updater-core.cjs');

const STARTUP_DELAY_MS = 30 * 1000;           // let the app finish booting first
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // periodic re-check
const FETCH_TIMEOUT_MS = 15 * 1000;

function createUpdater({
  currentVersion,
  isPackaged,
  platform,
  env = {},
  getAutoUpdater,           // () => electron-updater autoUpdater (lazy; silent path only)
  fetchText,                // (url, {timeoutMs}) => Promise<string>
  timers = { setTimeout, clearTimeout, setInterval, clearInterval },
  now = () => Date.now(),
  log = () => {},
  onStateChange = () => {},
  startupDelayMs = STARTUP_DELAY_MS,
  intervalMs = CHECK_INTERVAL_MS,
} = {}) {
  const enabled = Boolean(isPackaged);
  const silent = enabled && core.canInstallSilently({ platform, env });
  let state = core.initialState({ currentVersion, enabled, silent });
  let inFlight = null;
  let startupTimer = null;
  let intervalTimer = null;
  let wired = false;

  function dispatch(event) {
    const next = core.reduceUpdateState(state, event);
    if (next === state) return;
    state = next;
    try { onStateChange(state); } catch (e) { log('onStateChange threw', e); }
  }

  function wireAutoUpdater(au) {
    if (wired) return;
    wired = true;
    au.autoDownload = true;
    au.autoInstallOnAppQuit = true;   // "applies on the next app start"
    au.allowPrerelease = false;
    au.allowDowngrade = false;
    au.logger = {
      info: (m) => log('[electron-updater]', m),
      warn: (m) => log('[electron-updater] WARN', m),
      error: (m) => log('[electron-updater] ERROR', m),
      debug: () => {},
    };
    au.on('checking-for-update', () => dispatch({ type: 'check-start' }));
    au.on('update-available', (info) => dispatch({ type: 'available', version: info && info.version }));
    au.on('update-not-available', () => dispatch({ type: 'not-available', at: now() }));
    au.on('download-progress', (p) => dispatch({ type: 'progress', percent: p && p.percent }));
    au.on('update-downloaded', (info) => dispatch({ type: 'downloaded', version: info && info.version }));
    au.on('error', (err) => dispatch({ type: 'error', message: err && err.message, at: now() }));
  }

  async function checkSilent() {
    const au = getAutoUpdater();
    wireAutoUpdater(au);
    dispatch({ type: 'check-start' });
    await au.checkForUpdates(); // events drive the state; a rejection is caught by the caller
  }

  async function checkManual() {
    dispatch({ type: 'check-start' });
    const text = await fetchText(
      `${core.RELEASES_BASE}/latest/download/${core.feedNameFor(platform)}`,
      { timeoutMs: FETCH_TIMEOUT_MS },
    );
    const version = core.parseFeedVersion(text);
    if (!version) throw new Error('update feed has no readable version');
    if (core.isNewerVersion(currentVersion, version)) {
      dispatch({ type: 'available', version, downloadUrl: core.downloadUrlFor({ platform, version }) });
    } else {
      dispatch({ type: 'not-available', at: now() });
    }
  }

  // Never rejects: a failed check/download is logged, recorded as a quiet
  // 'error' state, and retried on the normal schedule.
  function checkNow() {
    if (!enabled) return Promise.resolve(state);
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        await (silent ? checkSilent() : checkManual());
      } catch (e) {
        log('update check failed', e && e.message ? e.message : e);
        dispatch({ type: 'error', message: e && e.message, at: now() });
      } finally {
        inFlight = null;
      }
      return state;
    })();
    return inFlight;
  }

  function start() {
    if (!enabled || startupTimer || intervalTimer) return;
    startupTimer = timers.setTimeout(() => { startupTimer = null; void checkNow(); }, startupDelayMs);
    intervalTimer = timers.setInterval(() => { void checkNow(); }, intervalMs);
    // Never keep the process alive for an update check.
    for (const t of [startupTimer, intervalTimer]) { if (t && typeof t.unref === 'function') t.unref(); }
  }

  function stop() {
    if (startupTimer) timers.clearTimeout(startupTimer);
    if (intervalTimer) timers.clearInterval(intervalTimer);
    startupTimer = intervalTimer = null;
  }

  // The ONLY mid-session apply, reached by an explicit user click on a
  // downloaded update. Returns false when nothing is ready to install.
  function installNow() {
    if (!enabled || !silent || state.status !== 'ready') return false;
    try {
      getAutoUpdater().quitAndInstall(false, true);
      return true;
    } catch (e) {
      log('quitAndInstall failed', e && e.message ? e.message : e);
      return false;
    }
  }

  return { start, stop, checkNow, installNow, getState: () => state, enabled, silent };
}

module.exports = { createUpdater, STARTUP_DELAY_MS, CHECK_INTERVAL_MS, FETCH_TIMEOUT_MS };
