'use strict';

// WARDEN-1508 — the builders that turn a process-memory window into a
// `process-memory` schema event. Split out of electron/main.cjs so they are
// unit-testable under `node --test` via createRequire (the
// telemetry-shape-event.cjs pattern).
//
// RUNTIME/PRODUCER PAIRING. Unlike the runtime-pinned types, `process-memory`
// is legitimately emitted by all three runtimes, so the SCHEMA cannot pin the
// runtime — the BUILDERS do:
//   • buildMainProcessMemoryEvent — the path main's own sampler uses for the
//     two processes MAIN observes: `main` (process.memoryUsage()) and
//     `renderer` (app.getAppMetrics()). It REFUSES `server`.
//   • buildServerProcessMemoryEvent — the path the forked server child's
//     `telemetry-process-memory` IPC window uses. It accepts ONLY `server`:
//     a window arriving over the child's channel cannot claim to be main or
//     the renderer, and a main-path window cannot masquerade as the server.
//
// CONSENT NOTE (do not "fix" this module to check consent): the per-category
// gate lives at the RECEIPT in main.cjs (`operational-metrics`, re-checked per
// window — the mid-flip gap) and again per event type at the pipeline.
//
// CARRIER HYGIENE: NUMBERS ONLY. A snapshot with ANY unexpected key, a
// non-integer / negative byte count, min > avg or avg > max, or a missing
// window stamp yields null — the same closed-key discipline the schema's
// validator re-applies at validate time.

const WINDOW_KEYS = new Set([
  'startedAt', 'endedAt', 'samples',
  'rssMinBytes', 'rssAvgBytes', 'rssMaxBytes', 'heapUsedMaxBytes', 'processAgeMs',
]);

const MAIN_PATH_RUNTIMES = new Set(['main', 'renderer']);
const SERVER_PATH_RUNTIMES = new Set(['server']);

function isNonNegInt(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function buildProcessMemoryEvent(allowedRuntimes, { snapshot, runtime, schemaVersion, appVersion, platform, now }) {
  if (!allowedRuntimes.has(runtime)) return null;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  for (const k of Object.keys(snapshot)) {
    if (!WINDOW_KEYS.has(k)) return null;
  }
  const { startedAt, endedAt, samples, rssMinBytes, rssAvgBytes, rssMaxBytes, heapUsedMaxBytes, processAgeMs } = snapshot;
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return null;
  if (typeof endedAt !== 'number' || !Number.isFinite(endedAt)) return null;
  if (!isNonNegInt(samples) || samples <= 0) return null;
  for (const v of [rssMinBytes, rssAvgBytes, rssMaxBytes, processAgeMs]) {
    if (!isNonNegInt(v)) return null;
  }
  if (heapUsedMaxBytes !== undefined && !isNonNegInt(heapUsedMaxBytes)) return null;
  // The honest-order invariant: min <= avg <= max.
  if (rssMinBytes > rssAvgBytes || rssAvgBytes > rssMaxBytes) return null;
  const ts = typeof now === 'function' ? now() : Date.now();
  const event = {
    schemaVersion,
    type: 'process-memory',
    runtime,
    timestamp: ts,
    windowStartedAt: startedAt,
    windowEndedAt: endedAt,
    samples,
    rssMinBytes,
    rssAvgBytes,
    rssMaxBytes,
    processAgeMs,
  };
  if (heapUsedMaxBytes !== undefined) event.heapUsedMaxBytes = heapUsedMaxBytes;
  if (typeof appVersion === 'string' && appVersion) event.appVersion = appVersion;
  if (typeof platform === 'string' && platform) event.platform = platform;
  return event;
}

function buildMainProcessMemoryEvent(args) {
  return buildProcessMemoryEvent(MAIN_PATH_RUNTIMES, args);
}

function buildServerProcessMemoryEvent(args) {
  return buildProcessMemoryEvent(SERVER_PATH_RUNTIMES, args);
}

module.exports = { buildMainProcessMemoryEvent, buildServerProcessMemoryEvent };
