'use strict';

// Telemetry OPERATIONAL-METRICS aggregator — slice M1 of the latency /
// operational-metrics channel (roadmap WARDEN-446 / design WARDEN-443).
//
// This module is the bounded-aggregate primitive the metrics channel needs.
// Since WARDEN-1258 it has a LIVE producer: the terminal linkifier's
// file-existence probe (src/fileExistsTelemetry.js → /api/file-exists in
// src/server.js) folds each probe's duration + ok/fail verdict into it, and the
// windowed snapshot rides to the Electron main process over the fork's IPC
// channel as a 'telemetry-metrics' message, where main records it as an
// `operational-metrics` event through the standard consent-gated pipeline.
//
// WHY CJS IN src/ (moved from electron/ by WARDEN-1258): the first wired call
// site is the BACKEND SERVER (ESM, src/server.js), and a `.cjs` file is
// CommonJS regardless of the package's "type": "module" — so one artifact
// serves the server AND stays require()-able from the Electron main process,
// exactly the discipline src/telemetry-consent.cjs established. The test
// harness (web/telemetry-metrics.test.mjs) loads it via createRequire.
//
// Everything here is PURE and ZERO-DEPENDENCY (no `require` of any kind) so it
// loads standalone under `node --test`, same as telemetry-source.cjs /
// telemetry-redact.cjs / window-state.cjs.
//
// ---------------------------------------------------------------------------
// WHY AGGREGATES AND NOT ROWS (the whole point of the slice)
// ---------------------------------------------------------------------------
// Every existing piece of the pipeline — record() → redact → validate → send,
// the NDJSON store, retention, dedup — is ONE PERSISTED ROW PER EVENT. That is
// affordable for incidents (~1 per 17 days observed live). Operational timings
// are orders of magnitude higher-frequency: a per-observation row would blow up
// local buffers, the wire, and the receiver's store.
//
// So this aggregator FOLDS each observation into a fixed-size accumulator and
// RETAINS NO ROW. Three independent bounds make the footprint constant:
//
//   1. FIXED BUCKET BOUNDARIES — a histogram with a constant number of counters
//      per operation (boundaries.length + 1, the extra one being the overflow
//      bucket for everything above the largest boundary). Recording 10 or
//      10,000,000 observations costs the same memory.
//   2. maxOperations CAP on distinct operation keys — names beyond the cap fold
//      into the reserved OVERFLOW_OPERATION key, so a buggy or unbounded caller
//      (e.g. one that interpolates an id into the name) can never grow the key
//      set without bound.
//   3. maxNameLength CAP on the operation name itself — an over-long name is
//      REJECTED, not truncated, so a name can never carry a payload.
//
// Total footprint is O(maxOperations × buckets) and is INDEPENDENT OF N, the
// number of observations. `web/telemetry-metrics.test.mjs` asserts that
// invariant through the public snapshot() surface at N = 10 vs N = 10,000.
//
// ---------------------------------------------------------------------------
// CALLER CONTRACT (read before instrumenting anything in M4)
// ---------------------------------------------------------------------------
// • `operation` MUST be a CONSTANT STRING LITERAL from a small, closed set
//   chosen at development time — e.g. 'settings-open', 'sync-refresh',
//   'discover-connect'. It must NEVER be built from user data: not a path, not
//   a hostname, not a chat/session name, not a project name, not an id. The
//   name is an aggregate KEY that would travel on the wire as-is; the redaction
//   engine (electron/telemetry-redact.cjs) is the safety net for event bodies,
//   not a licence to put user data in a metric key. maxNameLength is a
//   backstop against accidents here, not a substitute for the rule.
// • `durationMs` MUST be a wall-clock duration in milliseconds: a finite,
//   non-negative number. Anything else is rejected.
//
// Degenerate input is REJECTED, never thrown: record() returns false and bumps
// the window's `rejected` counter. Instrumentation must never be able to crash
// a real user operation it merely measures. (Invalid FACTORY OPTIONS, by
// contrast, DO throw — those are wire-up-time programming errors, surfaced at
// construction, long before any observation exists.)

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

// Ascending INCLUSIVE upper bounds, in milliseconds. An observation lands in
// the FIRST bucket whose boundary it is <= to; anything greater than the last
// boundary lands in the trailing overflow bucket. So with these defaults a
// duration of exactly 50 is bucket 0, 50.1 is bucket 1, 10000 is bucket 7, and
// 10000.1 is bucket 8 (overflow). buckets.length === boundaries.length + 1.
//
// The range is chosen for the pain the roadmap names: sub-100ms is "felt as
// instant", the 250–1000ms band is where "Settings opens slowly" lives, and the
// 2500ms+ tail is where sync lag becomes a complaint.
const DEFAULT_BUCKET_BOUNDARIES_MS = Object.freeze([
  50, 100, 250, 500, 1000, 2500, 5000, 10000,
]);

// Max distinct operation keys retained per window. The reserved overflow key is
// NOT counted against this cap, so the key count is at most maxOperations + 1.
const DEFAULT_MAX_OPERATIONS = 64;

// Max characters in an operation name. Names are constant literals by contract
// (see CALLER CONTRACT above), so this is generous — it exists to bound memory
// and to make an accidental "name built from user data" bug fail loudly-ish
// (rejected + counted) rather than silently ship a long string.
const DEFAULT_MAX_NAME_LENGTH = 64;

// Reserved key that excess operations fold into. Double-underscore-fenced so it
// cannot collide with a real 'kebab-case-operation' literal. A caller that
// passes this name explicitly is treated as a folded name (it is reserved, not
// claimable).
const OVERFLOW_OPERATION = '__other__';

// ---------------------------------------------------------------------------
// Option validation (wire-up time — throws)
// ---------------------------------------------------------------------------

function normalizeBoundaries(buckets) {
  if (buckets === undefined) return DEFAULT_BUCKET_BOUNDARIES_MS.slice();
  if (!Array.isArray(buckets) || buckets.length === 0) {
    throw new TypeError('createMetricAggregator: buckets must be a non-empty array of ms boundaries');
  }
  const out = [];
  for (let i = 0; i < buckets.length; i += 1) {
    const b = buckets[i];
    if (typeof b !== 'number' || !Number.isFinite(b) || b <= 0) {
      throw new TypeError('createMetricAggregator: every bucket boundary must be a finite number > 0');
    }
    if (i > 0 && b <= buckets[i - 1]) {
      throw new TypeError('createMetricAggregator: bucket boundaries must be strictly ascending');
    }
    out.push(b);
  }
  return out;
}

function normalizePositiveInt(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new TypeError(`createMetricAggregator: ${label} must be a positive integer`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a bounded per-operation latency aggregator.
 *
 * @param {object} [options]
 * @param {number[]} [options.buckets]        Ascending inclusive ms upper bounds.
 * @param {number}   [options.maxOperations]  Cap on distinct operation keys.
 * @param {number}   [options.maxNameLength]  Cap on operation-name length.
 * @param {() => number} [options.now]        Injectable clock (tests / windows).
 * @returns {{ record: Function, snapshot: Function, flush: Function,
 *             boundaries: number[], maxOperations: number, maxNameLength: number }}
 */
function createMetricAggregator(options) {
  const opts = options || {};
  const boundaries = normalizeBoundaries(opts.buckets);
  const maxOperations = normalizePositiveInt(opts.maxOperations, DEFAULT_MAX_OPERATIONS, 'maxOperations');
  const maxNameLength = normalizePositiveInt(opts.maxNameLength, DEFAULT_MAX_NAME_LENGTH, 'maxNameLength');
  if (opts.now !== undefined && typeof opts.now !== 'function') {
    throw new TypeError('createMetricAggregator: now must be a function returning a timestamp');
  }
  const now = opts.now || (() => Date.now());

  const bucketCount = boundaries.length + 1; // + overflow bucket

  /** @type {Map<string, object>} operation -> accumulator */
  let operations = new Map();
  /** @type {object|null} the reserved overflow accumulator, created lazily */
  let overflow = null;
  /** @type {Set<string>} distinct names folded into overflow (bounded, see below) */
  let foldedNames = new Set();
  // False once a distinct folded name could NOT be registered because the
  // folded-name registry was already at its own cap — i.e. `foldedOperations`
  // became a LOWER BOUND rather than an exact count. The registry is capped at
  // maxOperations so the aggregator's footprint stays constant even when a
  // pathological caller emits unbounded distinct names.
  let foldedNamesExact = true;
  let rejected = 0;
  let startedAt = now();

  function newAccumulator(operation) {
    return {
      operation,
      count: 0,
      okCount: 0,
      failCount: 0,
      min: 0,
      max: 0,
      sum: 0,
      buckets: Array.from({ length: bucketCount }, () => 0),
    };
  }

  // First boundary the value is <= to; else the trailing overflow bucket.
  function bucketIndexFor(durationMs) {
    for (let i = 0; i < boundaries.length; i += 1) {
      if (durationMs <= boundaries[i]) return i;
    }
    return boundaries.length;
  }

  function fold(acc, durationMs, ok) {
    if (acc.count === 0) {
      acc.min = durationMs;
      acc.max = durationMs;
    } else {
      if (durationMs < acc.min) acc.min = durationMs;
      if (durationMs > acc.max) acc.max = durationMs;
    }
    acc.count += 1;
    if (ok) acc.okCount += 1;
    else acc.failCount += 1;
    acc.sum += durationMs;
    acc.buckets[bucketIndexFor(durationMs)] += 1;
  }

  function registerFoldedName(operation) {
    if (foldedNames.has(operation)) return;
    if (foldedNames.size >= maxOperations) {
      foldedNamesExact = false;
      return;
    }
    foldedNames.add(operation);
  }

  /**
   * Fold ONE observation. Retains no per-observation row.
   *
   * @param {string} operation   Constant literal name (see CALLER CONTRACT).
   * @param {number} durationMs  Finite, non-negative wall-clock milliseconds.
   * @param {{ ok?: boolean }} [meta]  ok defaults to true; only an explicit
   *                                   `false` counts the observation as failed.
   * @returns {boolean} true when folded, false when rejected (never throws).
   */
  function record(operation, durationMs, meta) {
    if (typeof operation !== 'string' || operation.length === 0 || operation.length > maxNameLength) {
      rejected += 1;
      return false;
    }
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) {
      rejected += 1;
      return false;
    }
    const ok = !(meta && meta.ok === false);

    // The reserved key is never claimable by a caller: passing it explicitly is
    // treated exactly like an over-cap name.
    const isReserved = operation === OVERFLOW_OPERATION;
    const existing = isReserved ? undefined : operations.get(operation);
    if (existing) {
      fold(existing, durationMs, ok);
      return true;
    }
    if (!isReserved && operations.size < maxOperations) {
      const acc = newAccumulator(operation);
      operations.set(operation, acc);
      fold(acc, durationMs, ok);
      return true;
    }
    if (!overflow) overflow = newAccumulator(OVERFLOW_OPERATION);
    registerFoldedName(operation);
    fold(overflow, durationMs, ok);
    return true;
  }

  // Public, copied projection of an accumulator — callers can never reach or
  // mutate internal state through a snapshot.
  function projectRecord(acc) {
    return {
      operation: acc.operation,
      count: acc.count,
      okCount: acc.okCount,
      failCount: acc.failCount,
      min: acc.min,
      avg: acc.sum / acc.count,
      max: acc.max,
      buckets: acc.buckets.slice(),
    };
  }

  /**
   * The current window as a plain, freshly-copied object. Does NOT mutate or
   * reset anything — call it as often as you like.
   *
   * Shape: {
   *   startedAt, endedAt,          // from the injected clock
   *   boundaries: number[],        // buckets.length === boundaries.length + 1
   *   operations: Record[],        // sorted by name; overflow always last
   *   rejected,                    // observations refused by validation
   *   foldedOperations,            // distinct names folded into __other__
   *   foldedOperationsExact,       // false => foldedOperations is a lower bound
   * }
   */
  function snapshot() {
    const list = [...operations.values()]
      .sort((a, b) => (a.operation < b.operation ? -1 : a.operation > b.operation ? 1 : 0))
      .map(projectRecord);
    if (overflow) list.push(projectRecord(overflow)); // reserved key always last
    return {
      startedAt,
      endedAt: now(),
      boundaries: boundaries.slice(),
      operations: list,
      rejected,
      foldedOperations: foldedNames.size,
      foldedOperationsExact: foldedNamesExact,
    };
  }

  /**
   * Window boundary: return the current window AND reset to an empty one, so
   * two consecutive windows never double-count. The returned snapshot is a
   * detached copy and is unaffected by later record() calls.
   */
  function flush() {
    const out = snapshot();
    operations = new Map();
    overflow = null;
    foldedNames = new Set();
    foldedNamesExact = true;
    rejected = 0;
    startedAt = out.endedAt; // next window starts where this one ended
    return out;
  }

  return {
    record,
    snapshot,
    flush,
    // Echoed effective configuration, so a caller (and the tests) can assert the
    // bounds without reaching into internals.
    boundaries: boundaries.slice(),
    maxOperations,
    maxNameLength,
  };
}

module.exports = {
  DEFAULT_BUCKET_BOUNDARIES_MS,
  DEFAULT_MAX_OPERATIONS,
  DEFAULT_MAX_NAME_LENGTH,
  OVERFLOW_OPERATION,
  createMetricAggregator,
};
