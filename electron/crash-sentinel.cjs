// Pure crash-sentinel decision logic for the Electron main process (WARDEN-687).
//
// WHY THIS FILE EXISTS. The one crash class that is structurally invisible to
// the telemetry source (electron/telemetry-source.cjs) is a HARD kill of the
// Electron MAIN process: a native segfault, an OOM-kill, SIGKILL, power loss,
// or an abrupt `process.exit()`. `uncaughtExceptionMonitor` intercepts only JS
// exceptions, so an abrupt/native termination bypasses it entirely — the
// reporter dies WITH the crash and emits NOTHING. A next-launch sentinel turns
// that undetectable death into one normal base-tier crash event: each instance
// writes a "I am alive" marker at startup; on the NEXT launch, a marker whose
// PID is no longer alive identifies a crashed instance → emit exactly ONE
// { type:'crash', runtime:'main', reason:'unexpected-termination' } → delete
// that marker so a further relaunch does not re-emit.
//
// WHY THIS FILE IS SPLIT OUT OF main.cjs (same discipline as window-state.cjs):
// main.cjs `require('electron')`, so it can only run under Electron itself — it
// cannot be exercised by `node --test`, and the worker sandbox cannot launch
// Electron (browser/visual QA is blocked). Every decision that must be CORRECT
// for the crash-sentinel feature lives here as a PURE function with no
// electron/Node dependency (the liveness check + filesystem I/O are INJECTED by
// the caller), so it is unit-tested directly in web/crash-sentinel.test.mjs.
// main.cjs wires the live APIs (fs.readdirSync/readFileSync/unlinkSync/
// writeFileSync, process.kill(pid, 0), process.pid, app.getPath('userData')) to
// these decisions.
//
// PER-PID MARKER DESIGN (decided WARDEN-687; mirrors the window-state.cjs
// injected-seam discipline). Each running instance owns ONE marker file named
// `crash-sentinel-<pid>.json` in userData, holding `{ pid, nonce }`:
//   • Per-PID FILENAMES make the per-PID keying structural — instance B's
//     clean-quit (delete its own file) can never clobber instance A's marker, so
//     two concurrent instances do not contend on a shared file (DONE criterion
//     #6: killing A then cleanly quitting B still emits A's crash on relaunch).
//   • The hard-kill case (the whole point) leaves the marker file on disk
//     untouched, because before-quit never runs — so the next launch detects it.
//   • The `nonce` is a per-startup value that guards against PID reuse (a stale
//     marker whose pid the OS recycled). It is carried in the marker so a richer
//     liveness predicate could consult it; the DEFAULT predicate keys on pid
//     alone (process.kill(pid, 0) → ESRCH when dead). PID reuse by a non-warden
//     process is a safe-direction false negative (a crash may be reported late,
//     when the recycled pid finally dies); it is NEVER a false positive.
//
// LIFECYCLE (wired in main.cjs):
//   app.whenReady() — AFTER applyTelemetryConfig(readTelemetryPrefs()):
//     1. read every crash-sentinel-<pid>.json in userData;
//     2. detectCrashes(markers, isAlive) → for each crashed marker, call the
//        source's consent-gated recordMainCrash() ONCE (off → nothing emitted),
//        then unlink the crashed marker file (housekeeping is consent-INdependent
//        so a second relaunch never re-emits — DONE criterion #4);
//     3. write THIS instance's fresh marker (overwriting any stale same-pid file).
//   before-quit — unlink ONLY this instance's marker file (per-PID). A hard kill
//     skips this entirely, leaving the marker for the next launch to detect.

const CRASH_SENTINEL_PREFIX = 'crash-sentinel-';
const CRASH_SENTINEL_SUFFIX = '.json';

// Defensive parse of one marker file's contents (a JSON string) or a pre-parsed
// object. Malformed/missing/non-object input → null, NEVER throws (WARDEN-89
// spirit). A usable marker requires a numeric `pid` (without it there is no
// process to probe); the `nonce` is optional but preserved when present.
function parseMarker(raw) {
  let v;
  try {
    v = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  if (typeof v.pid !== 'number' || !Number.isFinite(v.pid)) return null;
  return {
    pid: v.pid,
    nonce: typeof v.nonce === 'string' && v.nonce ? v.nonce : null,
  };
}

// The marker filename for a given pid: `crash-sentinel-<pid>.json`. Pure: a
// plain string template over the pid. The pid appears in the filename so the
// detection pass can enumerate markers with a directory listing.
function markerFileName(pid) {
  return `${CRASH_SENTINEL_PREFIX}${pid}${CRASH_SENTINEL_SUFFIX}`;
}

// The numeric pid encoded in a sentinel filename, or null if `name` is not a
// sentinel file. Pure: a parse of the filename's middle segment. (The pid is
// re-read from the file CONTENTS at detect time — parseMarker is authoritative —
// but this helper lets the caller list/delete by filename without re-reading.)
function pidFromFileName(name) {
  if (typeof name !== 'string') return null;
  if (!name.startsWith(CRASH_SENTINEL_PREFIX) || !name.endsWith(CRASH_SENTINEL_SUFFIX)) return null;
  const pidStr = name.slice(
    CRASH_SENTINEL_PREFIX.length,
    name.length - CRASH_SENTINEL_SUFFIX.length,
  );
  if (!/^[0-9]+$/.test(pidStr)) return null;
  const pid = Number.parseInt(pidStr, 10);
  return Number.isFinite(pid) ? pid : null;
}

// True iff `name` matches the `crash-sentinel-<digits>.json` shape. Used by the
// detection pass to enumerate ONLY marker files from userData (ignoring
// window-state.json, logs, etc.). Pure: a pattern check on the string.
function isCrashSentinelFile(name) {
  return pidFromFileName(name) !== null;
}

// The core detection decision. Pure over `(markers, isAlive)`: partitions the
// marker list into `crashed` (the pid is NO LONGER alive → a prior instance died
// hard) and `survivors` (the pid is STILL alive → a concurrent instance whose
// marker must be left untouched). `isAlive(marker) => boolean` is INJECTED so the
// decision is testable without a real process table; the default live predicate
// (main.cjs) wraps `process.kill(pid, 0)` (ESRCH when dead). A throwing
// predicate is treated as "dead" (the conservative, crash-reporting direction).
// Malformed markers (no numeric pid) are skipped — they are neither a crash to
// report nor a survivor to keep.
function detectCrashes(markers, isAlive) {
  const list = Array.isArray(markers) ? markers : [];
  const crashed = [];
  const survivors = [];
  for (const m of list) {
    if (!m || typeof m !== 'object' || typeof m.pid !== 'number' || !Number.isFinite(m.pid)) continue;
    let alive;
    try {
      alive = typeof isAlive === 'function' ? isAlive(m) === true : false;
    } catch {
      alive = false;
    }
    if (alive) survivors.push(m);
    else crashed.push(m);
  }
  return { crashed, survivors };
}

module.exports = {
  CRASH_SENTINEL_PREFIX,
  CRASH_SENTINEL_SUFFIX,
  parseMarker,
  markerFileName,
  pidFromFileName,
  isCrashSentinelFile,
  detectCrashes,
};
