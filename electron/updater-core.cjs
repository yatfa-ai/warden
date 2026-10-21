// Auto-update PURE core (WARDEN-1887): version comparison, the update-state
// reducer and the platform capability decision. Deliberately ELECTRON-FREE and
// electron-updater-free (the menu-template.cjs / window-state.cjs split): main.cjs
// cannot be required under `node --test`, so everything that DECIDES something
// lives here and is asserted in web/updater-core.test.mjs. updater.cjs wires the
// live electron-updater events into this reducer.

/**
 * Parse "MAJOR.MINOR.PATCH[-prerelease][+build]" (a leading "v" is tolerated).
 * Returns null for anything that is not a plain semver — callers treat null as
 * "cannot say it is newer", the conservative direction (no prompt).
 */
function parseVersion(v) {
  if (typeof v !== 'string') return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split('.') : [],
  };
}

function comparePre(a, b) {
  // A version WITH a prerelease tag is lower than the same version without one.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const an = /^\d+$/.test(a[i]);
    const bn = /^\d+$/.test(b[i]);
    if (an && bn) {
      const d = Number(a[i]) - Number(b[i]);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (an !== bn) {
      return an ? -1 : 1; // numeric identifiers sort below alphanumeric ones
    } else if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
}

/** -1 | 0 | 1, or null when either side is not a parseable version. */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  return comparePre(pa.pre, pb.pre);
}

/** True only when `candidate` is strictly newer than `current` (unparseable → false). */
function isNewerVersion(current, candidate) {
  return compareVersions(current, candidate) === -1;
}

/**
 * Can this runtime install an update silently (download + apply on next start)?
 *  - Windows (NSIS): yes.
 *  - Linux: only as an AppImage (electron-updater replaces the AppImage file;
 *    it needs the APPIMAGE env var the AppImage runtime sets).
 *  - macOS: NO — silent install needs a signed (ideally notarized) build and
 *    ours are unsigned. The honest path there is "new version available →
 *    download page" (decided out of scope in the ticket).
 */
function canInstallSilently({ platform, env = {} } = {}) {
  if (platform === 'win32') return true;
  if (platform === 'linux') return Boolean(env.APPIMAGE);
  return false;
}

const RELEASES_BASE = 'https://github.com/yatfa-ai/warden/releases';

/**
 * Where a user who cannot be updated silently goes to get `version`.
 * macOS gets the DMG directly (artifactName in package.json is
 * `yatfa-warden-${version}.${ext}`); everything else gets the release page,
 * which carries every per-OS artifact.
 */
function downloadUrlFor({ platform, version }) {
  if (!parseVersion(version)) return `${RELEASES_BASE}/latest`;
  const v = version.trim().replace(/^v/, '');
  if (platform === 'darwin') return `${RELEASES_BASE}/download/v${v}/yatfa-warden-${v}.dmg`;
  return `${RELEASES_BASE}/tag/v${v}`;
}

function initialState({ currentVersion, enabled, silent }) {
  return {
    status: enabled ? 'idle' : 'disabled',
    currentVersion: currentVersion || null,
    version: null,        // the newer version found, when any
    percent: null,        // download progress 0-100 while downloading
    silent: Boolean(silent),
    downloadUrl: null,    // set on the manual (no-silent-install) path
    error: null,          // last failure message (quiet, never fatal)
    lastCheckedAt: null,  // epoch ms of the last completed check
  };
}

/**
 * The update-state reducer. Pure: (state, event) -> state. Events:
 *   {type:'check-start'}
 *   {type:'available', version, downloadUrl?}
 *   {type:'progress', percent}
 *   {type:'downloaded', version}
 *   {type:'not-available', at}
 *   {type:'error', message, at?}
 *
 * Invariants the tests pin:
 *  - 'disabled' (dev/unpackaged) is terminal: nothing ever leaves it.
 *  - 'ready' (a downloaded update is pending) is sticky: a later check, a late
 *    error or a not-available can never clobber it — the update is on disk.
 *  - 'available' (the manual path's only update affordance) is sticky against
 *    check-start/error: a periodic or manual re-check, or a transient failure of
 *    one, must not erase the known update. A later 'available' (newer),
 *    'not-available' (withdrawn release) or 'downloaded' still replaces it.
 *  - an 'available' version that is not strictly newer than the running one is
 *    treated as up to date (belt-and-braces over the feed).
 */
function reduceUpdateState(state, event) {
  if (state.status === 'disabled') return state;
  if (state.status === 'ready' && event.type !== 'downloaded') return state;
  switch (event.type) {
    case 'check-start':
      if (state.status === 'downloading' || state.status === 'available') return state;
      return { ...state, status: 'checking', error: null };
    case 'available': {
      if (!isNewerVersion(state.currentVersion, event.version)) {
        return { ...state, status: 'up-to-date', version: null, percent: null, downloadUrl: null, error: null };
      }
      return {
        ...state,
        status: state.silent ? 'downloading' : 'available',
        version: event.version,
        percent: state.silent ? 0 : null,
        downloadUrl: state.silent ? null : (event.downloadUrl || null),
        error: null,
      };
    }
    case 'progress': {
      if (state.status !== 'downloading') return state;
      const p = Number(event.percent);
      return { ...state, percent: Number.isFinite(p) ? Math.max(0, Math.min(100, Math.round(p))) : state.percent };
    }
    case 'downloaded':
      return { ...state, status: 'ready', version: event.version || state.version, percent: 100, downloadUrl: null, error: null };
    case 'not-available':
      return { ...state, status: 'up-to-date', version: null, percent: null, downloadUrl: null, error: null, lastCheckedAt: event.at ?? state.lastCheckedAt };
    case 'error': {
      const message = String(event.message || 'update check failed').slice(0, 300);
      // A known manual-path update survives a failed re-check: keep the chip,
      // just record the quiet error and when the check happened.
      if (state.status === 'available') return { ...state, error: message, lastCheckedAt: event.at ?? state.lastCheckedAt };
      // A failed download keeps knowing which version it was after; a failed
      // check just records the quiet error.
      return { ...state, status: 'error', error: message, percent: null, lastCheckedAt: event.at ?? state.lastCheckedAt };
    }
    default:
      return state;
  }
}

/** Pull the `version:` scalar out of an electron-builder feed (latest*.yml). */
function parseFeedVersion(yml) {
  if (typeof yml !== 'string') return null;
  const m = /^version:\s*['"]?([^'"\s#]+)['"]?\s*$/m.exec(yml);
  return m && parseVersion(m[1]) ? m[1] : null;
}

/** The feed file a given platform's installer publishes. */
function feedNameFor(platform) {
  if (platform === 'darwin') return 'latest-mac.yml';
  if (platform === 'linux') return 'latest-linux.yml';
  return 'latest.yml';
}

/**
 * What a MANUAL "Check for Updates…" tells the user, as a plain description the
 * main process renders in a native dialog. `action` names the primary button's
 * effect ('install' | 'download' | null); there is always a plain dismiss.
 */
function describeManualResult(state) {
  const cur = state.currentVersion || 'unknown';
  switch (state.status) {
    case 'disabled':
      return { message: 'Updates are unavailable', detail: 'Automatic updates only run in the installed app, not in a development run.', action: null };
    case 'ready':
      return { message: `Version ${state.version} is ready to install`, detail: 'It has been downloaded. Restart Yatfa Warden to apply it, or keep working — it will be applied the next time the app starts.', action: 'install', actionLabel: 'Restart Now' };
    case 'downloading':
      return { message: `Downloading version ${state.version}…`, detail: `${state.percent ?? 0}% downloaded. You can keep working; it will be applied the next time the app starts.`, action: null };
    case 'available':
      return { message: `Version ${state.version} is available`, detail: `You are running ${cur}. This installation can't update itself silently, so download the new version and install it over this one.`, action: 'download', actionLabel: 'Download' };
    case 'up-to-date':
      return { message: "You're up to date", detail: `Yatfa Warden ${cur} is the latest version.`, action: null };
    case 'error':
      return { message: "Couldn't check for updates", detail: `${state.error || 'Unknown error'}\n\nThe app keeps working normally; it will try again automatically.`, action: null };
    default:
      return { message: 'Checking for updates…', detail: 'This is taking a moment. Try again shortly.', action: null };
  }
}

/** Application-menu label for the update item, reflecting the current state. */
function menuLabelFor(state) {
  if (state && state.status === 'ready') return `Restart to Apply Update (${state.version})…`;
  return 'Check for Updates…';
}

module.exports = {
  parseFeedVersion,
  feedNameFor,
  describeManualResult,
  menuLabelFor,
  parseVersion,
  compareVersions,
  isNewerVersion,
  canInstallSilently,
  downloadUrlFor,
  initialState,
  reduceUpdateState,
  RELEASES_BASE,
};
