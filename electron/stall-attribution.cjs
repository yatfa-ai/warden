'use strict';

// Main-process STALL ATTRIBUTION probe (WARDEN-1376).
//
// WHY THIS EXISTS: warden's main-process event-loop freeze heartbeat
// (electron/telemetry-source.cjs) reports HOW LONG the loop was blocked
// (`performance-stall`, `lagMs`, `source: 'event-loop'`) but not WHAT blocked
// it — the main heartbeat has carried no attribution since it shipped, which is
// why the win32 `stall:event-loop` rows on the receiver could never be traced to
// a mechanism (WARDEN-1376). The SERVER child got the missing half in
// WARDEN-977/1278 (src/loop-monitor.js + src/telemetry-stalls.cjs: heartbeat +
// spans + a sync-I/O probe over the fs/child_process module objects). This
// module is that sync-I/O probe for the MAIN process, scoped to what main can
// honestly attribute today.
//
// MECHANISM — the module-object patch (WARDEN-977 technique, probe-verified
// there): `require('fs')` in main yields the SAME module object every other
// main-process module resolves sync calls through, and its members are
// writable, so wrapping `fs.readFileSync` etc. ONCE observes every runtime sync
// call site without touching those call sites — electron/main.cjs's
// window-state + transmission-log persists, the crash-sentinel scan, menu
// helpers. A NAMED destructured binding (`const { readFileSync } = require…`)
// would be invisible; no such binding exists in electron/ today (each use goes
// through `fs.`), and the wrapper preserves each member's own property
// descriptor so nothing else on the object is disturbed.
//
// WHAT IT COSTS: two clock reads and one aggregate update per sync fs call.
// Main performs a handful of sync calls per second at most. The probe WRITES
// NOTHING anywhere and EMITS NOTHING — it fills in-memory aggregates only; an
// event leaves the machine only via the consent-gated heartbeat path, exactly
// as before. (The server-side monitor runs always for the same reason: local
// observation is cheap; DELIVERY is what consent gates.)
//
// WHAT IT REPORTS: when the heartbeat detects a stall, `attributeStall` folds
// the probe's slow calls (≥ floor) that OVERLAP the blocked window
// [t - lagMs, t] into a bounded culprit list, longest overlap first — the same
// attribution-window rule the server monitor records (a synchronous block ends
// when the late tick finally runs, so the overdue gap is guaranteed to overlap
// every blocking call: anything that blocked the loop was still running when
// the loop was released). Culprit keys are CLOSED-SET kebab-case literals
// derived from the member name (`readFileSync` → `fs-read-file-sync`) — never a
// path, never a hostname — so the same structural redaction proof the
// `server-stall` culprits and `operational-metrics` operation names carry
// (WARDEN-443: paths/hostnames are hard exclusions) holds here too.
//
// An HONEST EMPTY attribution — nothing instrumented overlapped — is itself the
// finding: the blocker is somewhere not yet instrumented (a native call, GC,
// the OS), and the event ships without the field rather than naming a guess.
//
// This module is deliberately dependency-free (no electron import, injectable
// clock + targets) so it is unit-testable under `node --test` in isolation —
// the same discipline as electron/window-state.cjs and telemetry-source.cjs.

// ---------------------------------------------------------------------------
// Contract / constants. The kebab vocabulary mirrors src/telemetry-stalls.cjs's
// culprit-key shape so both runtimes' attribution reads the same on the wire.
// ---------------------------------------------------------------------------

// The reserved overflow key: when more distinct labels than `aggregateCap` are
// seen, the least-significant fold into this one (same shape the server
// monitor's SYNC_AGGREGATE_OVERFLOW_LABEL and telemetry-stalls.cjs use).
const ATTRIBUTION_OVERFLOW_KEY = '(other)';

// Bound on distinct aggregate labels retained (constants only, so bounded).
const DEFAULT_AGGREGATE_CAP = 64;
// Bound on the slow-call ring (each entry {label, startMs, durationMs}).
const DEFAULT_RING_CAP = 256;
// A sync call shorter than this is aggregated (totals) but takes no ring slot —
// thousands of individually-cheap calls cannot crowd out the one 2s blocker.
const DEFAULT_FLOOR_MS = 100;
// Bound on culprits attached to one event — mirrors the server-stall event's
// MAX_CULPRITS_PER_EVENT (65).
const MAX_CULPRITS_PER_EVENT = 65;

// The sync fs members worth observing — mirrors src/loop-monitor.js's
// SYNC_FS_METHODS (including the fd-level primitives, which a path-level list
// misses) plus copy/rename, the operations the atomic persist paths use.
const SYNC_FS_METHODS = Object.freeze([
  'readFileSync', 'writeFileSync', 'appendFileSync', 'readdirSync',
  'statSync', 'lstatSync', 'existsSync', 'realpathSync',
  'mkdirSync', 'renameSync', 'unlinkSync', 'rmSync', 'readlinkSync',
  'openSync', 'closeSync', 'readSync', 'writeSync', 'readvSync', 'writevSync',
  'fstatSync', 'ftruncateSync', 'truncateSync', 'fsyncSync', 'fdatasyncSync',
  'mkdtempSync', 'opendirSync', 'rmdirSync', 'copyFileSync', 'cpSync',
  'accessSync', 'globSync',
  'chmodSync', 'chownSync', 'utimesSync', 'symlinkSync', 'linkSync',
]);

// The sync child_process members — main's boot-time `execSync` (killStalePort)
// is the one runtime site today; wrapping the module object keeps any future
// sync child-process call attributable too.
const SYNC_CHILD_PROCESS_METHODS = Object.freeze([
  'execSync', 'execFileSync', 'spawnSync',
]);

// The kebab-case culprit vocabulary validator shape — byte-identical to the
// OPERATION_NAME_RE the canonical schema (web/src/lib/telemetry/schema.ts)
// enforces for `operational-metrics` operation names and `server-stall`
// culprit keys. Lowercase letters, digits, hyphens; ≤64 chars. No path (needs a
// separator) and no hostname (needs a dot + TLD) can match, which makes the
// WARDEN-443 hard exclusions STRUCTURAL rather than a caller promise.
const CULPRIT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// `readFileSync` + prefix `fs` → `fs-read-file-sync`. camelCase → kebab, one
// dash per capital boundary. Pure + injectable so tests pin the vocabulary.
function kebabLabel(prefix, method) {
  const p = typeof prefix === 'string' && prefix ? prefix : 'unknown';
  const m = typeof method === 'string' && method ? method : 'unknown';
  const kebab = m
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
  return `${p}-${kebab}`;
}

// --- the probe ---------------------------------------------------------------

// Wrap one member of one module object with a duration timer. Preserves the
// original's own property DESCRIPTOR (WARDEN-977 gotcha: redefining with a bare
// assignment silently drops siblings like fs.realpathSync.native on some
// copies of the object) and records the duration in a `finally` so a throwing
// call is still attributed. Returns the wrapper (also left in place on the
// object); null when the member is absent or non-writable/non-configurable.
function wrapMethod(obj, method, onCall) {
  if (!obj || typeof obj !== 'object') return null;
  const original = obj[method];
  if (typeof original !== 'function') return null;
  const descriptor = Object.getOwnPropertyDescriptor(obj, method);
  if (descriptor && descriptor.configurable === false) return null;
  if (descriptor && descriptor.writable === false) return null;
  const wrapper = function wrapped(...args) {
    const startedAt = onCall.clock();
    try {
      return original.apply(this, args);
    } finally {
      try {
        onCall.record(method, startedAt, onCall.clock() - startedAt);
      } catch {
        /* an instrumentation failure must never disturb the call itself */
      }
    }
  };
  // WARDEN-977 gotcha: copy the ORIGINAL's own property descriptors onto the
  // wrapper — `fs.realpathSync.native` and friends live on the function object,
  // and a bare wrapper would silently drop them for every caller.
  try {
    for (const name of Object.getOwnPropertyNames(original)) {
      if (name === 'length' || name === 'name' || name === 'prototype') continue;
      const d = Object.getOwnPropertyDescriptor(original, name);
      if (d) Object.defineProperty(wrapper, name, d);
    }
  } catch {
    /* a non-copyable own property must not stop the wrap */
  }
  try {
    Object.defineProperty(obj, method, {
      ...descriptor,
      value: wrapper,
      writable: true,
      configurable: true,
    });
  } catch {
    return null;
  }
  return wrapper;
}

// Install the probe over the given targets (production passes the REAL
// require('fs') / require('child_process') module objects; tests pass plain
// objects). Returns a probe handle:
//   .attributeStall({ windowStartMs, windowEndMs, limit }) — fold slow calls
//       overlapping the window into [{culprit, overlapMs}], longest first.
//   .totals() — current per-label aggregate snapshot (diagnostics/tests).
//   .dispose() — restore every wrapped member to its original function.
//
// Aggregates are per-label {calls, totalMs}; a call at or above `floorMs`
// additionally pushes {label, startMs, durationMs} onto a bounded ring
// (drop-oldest). `attributeStall` walks the ring ONLY — an aggregate total
// spread across the session cannot be attributed to one window honestly.
function installSyncIoProbe(opts) {
  const o = opts || {};
  const clock = typeof o.now === 'function' ? o.now : () => Date.now();
  const floorMs = Number.isFinite(o.floorMs) && o.floorMs >= 0 ? o.floorMs : DEFAULT_FLOOR_MS;
  const ringCap = Number.isInteger(o.ringCap) && o.ringCap > 0 ? o.ringCap : DEFAULT_RING_CAP;
  const aggregateCap =
    Number.isInteger(o.aggregateCap) && o.aggregateCap > 0 ? o.aggregateCap : DEFAULT_AGGREGATE_CAP;

  const aggregates = new Map(); // label -> {calls, totalMs}
  const ring = []; // {label, startMs, durationMs} — newest pushed, oldest dropped
  const unwraps = [];

  // Each target gets its own recorder so the label carries the target prefix.
  const makeRecorder = (prefix) => ({
    clock,
    record(method, startedAt, durationMs) {
      const label = kebabLabel(prefix, method);
      if (!CULPRIT_NAME_RE.test(label)) return; // vocabulary is closed by construction
      let agg = aggregates.get(label);
      if (!agg) {
        if (aggregates.size >= aggregateCap) return; // bounded — drop beyond the cap
        agg = { calls: 0, totalMs: 0 };
        aggregates.set(label, agg);
      }
      agg.calls += 1;
      agg.totalMs += durationMs;
      if (durationMs >= floorMs) {
        ring.push({ label, startMs: startedAt, durationMs });
        if (ring.length > ringCap) ring.shift(); // drop-oldest
      }
    },
  });

  const targets = Array.isArray(o.targets) ? o.targets : [];
  for (const t of targets) {
    if (!t || typeof t.obj !== 'object') continue;
    const prefix = typeof t.prefix === 'string' && t.prefix ? t.prefix : 'unknown';
    const recorder = makeRecorder(prefix);
    const methods = Array.isArray(t.methods) ? t.methods : [];
    for (const method of methods) {
      const originalDescriptor = Object.getOwnPropertyDescriptor(t.obj, method);
      const wrapper = wrapMethod(t.obj, method, recorder);
      if (!wrapper) continue;
      unwraps.push(() => {
        try {
          Object.defineProperty(t.obj, method, originalDescriptor);
        } catch {
          /* a restore failure on a disposed probe must never crash the host */
        }
      });
    }
  }

  function attributeStall(window) {
    const w = window || {};
    const start = Number.isFinite(w.windowStartMs) ? w.windowStartMs : -Infinity;
    const end = Number.isFinite(w.windowEndMs) ? w.windowEndMs : Infinity;
    const limit = Number.isInteger(w.limit) && w.limit > 0 ? Math.min(w.limit, MAX_CULPRITS_PER_EVENT) : MAX_CULPRITS_PER_EVENT;
    // Fold every slow call overlapping [start, end] into per-culprit overlap.
    const perCulprit = new Map(); // culprit -> overlapMs
    for (const entry of ring) {
      const callStart = entry.startMs;
      const callEnd = entry.startMs + entry.durationMs;
      const overlap = Math.min(callEnd, end) - Math.max(callStart, start);
      if (overlap <= 0) continue;
      perCulprit.set(entry.label, (perCulprit.get(entry.label) || 0) + overlap);
    }
    if (perCulprit.size === 0) return []; // honest empty — the blocker is elsewhere
    const sorted = [...perCulprit.entries()].sort((a, b) => b[1] - a[1]);
    const kept = sorted.slice(0, limit).map(([culprit, overlapMs]) => ({
      culprit,
      overlapMs: Math.round(overlapMs),
    }));
    if (sorted.length > kept.length) {
      kept.push({ culprit: ATTRIBUTION_OVERFLOW_KEY, overlapMs: 0 });
    }
    return kept;
  }

  function totals() {
    const out = {};
    for (const [label, agg] of aggregates) out[label] = { ...agg };
    return out;
  }

  function dispose() {
    for (const undo of unwraps) undo();
    unwraps.length = 0;
    aggregates.clear();
    ring.length = 0;
  }

  return { attributeStall, totals, dispose };
}

// Validate one attribution entry against the wire shape the canonical schema
// enforces (culprit: closed-set kebab; overlapMs: finite ≥ 0). Exported so the
// source's validateBaseEvent and this module share ONE definition.
function isValidAttributionEntry(c) {
  if (!c || typeof c !== 'object') return false;
  if (typeof c.culprit !== 'string' || !CULPRIT_NAME_RE.test(c.culprit)) return false;
  if (typeof c.overlapMs !== 'number' || !Number.isFinite(c.overlapMs) || c.overlapMs < 0) return false;
  return true;
}

module.exports = {
  installSyncIoProbe,
  kebabLabel,
  isValidAttributionEntry,
  SYNC_FS_METHODS,
  SYNC_CHILD_PROCESS_METHODS,
  CULPRIT_NAME_RE,
  ATTRIBUTION_OVERFLOW_KEY,
  MAX_CULPRITS_PER_EVENT,
};
