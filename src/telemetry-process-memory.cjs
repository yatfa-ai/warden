'use strict';

// Telemetry PROCESS-MEMORY producer core (WARDEN-1508) — the bounded fold that
// turns slow RSS / heap / process-age samples into ONE aggregate per runtime
// per window, for the `process-memory` event (schema v10).
//
// WHY: the consented stream had no memory vantage, so "a long session without
// restart stays fast" (WARDEN-1491's bar) was unreadable and the
// `unexpected-termination` crashes carried no resource evidence. This module
// is the instrument; it must not itself lag the app, so:
//
//   • FIXED-SIZE ACCUMULATORS — min / running-mean / max / sample count / max
//     heap / last age. Recording 10 or 10,000 samples costs the same memory
//     (the web/telemetry-metrics.test.mjs invariant, asserted for this module
//     in web/telemetry-process-memory.test.mjs through the public snapshot()
//     surface). No sample is retained.
//   • SLOW CADENCE — one sample per ~30 s (~10 per 5-minute window).
//   • UNREF'D TIMERS — a library import (every test that loads server.js)
//     never keeps the event loop alive on this module's timers.
//
// NUMBERS ONLY: nothing here ever sees a path, hostname or name — a source's
// `read()` returns three numbers, and the aggregate carries only numbers.
//
// CONSENT: the `operational-metrics` category (no new category). The producer
// gates LIVE on the injected `consent()` resolver (only an exact `true`
// enables): while OFF it takes no sample and retains nothing, and a window
// closed out-of-consent is DISCARDED, never sent. The receipt in
// electron/main.cjs re-checks the category before anything is built or
// recorded (the mid-flip gap), exactly like the workspace-shape window.
//
// CJS in src/ for the same reason src/telemetry-metrics.cjs is: the server
// child (ESM) AND the Electron main process (CJS) both consume it. ZERO
// dependencies, so it loads standalone under `node --test`.

// ~10 samples per 5-minute window.
const PROCESS_MEMORY_SAMPLE_MS = 30_000;
const PROCESS_MEMORY_FLUSH_MS = 5 * 60_000;

// The closed runtime set a window may name (mirrors the schema's Runtime).
const PROCESS_MEMORY_RUNTIMES = Object.freeze(['main', 'renderer', 'server']);

function isNonNegInt(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

// A bounded fold of one runtime's samples. `now` is the epoch clock stamping the
// window (injectable for tests).
function createMemoryAggregator({ now = Date.now } = {}) {
  let startedAt = now();
  let samples = 0;
  let rssMin = 0;
  let rssMax = 0;
  let rssMean = 0; // running mean — no unbounded sum, no overflow
  let heapMax = null;
  let lastAgeMs = 0;

  // Fold ONE sample. Strict: only non-negative INTEGER byte counts fold; a
  // corrupt reading (NaN, negative, float, string) is dropped, never folded.
  function record({ rssBytes, heapUsedBytes, ageMs }) {
    if (!isNonNegInt(rssBytes)) return false;
    if (heapUsedBytes !== undefined && heapUsedBytes !== null && !isNonNegInt(heapUsedBytes)) return false;
    samples += 1;
    if (samples === 1) { rssMin = rssBytes; rssMax = rssBytes; rssMean = rssBytes; }
    else {
      if (rssBytes < rssMin) rssMin = rssBytes;
      if (rssBytes > rssMax) rssMax = rssBytes;
      rssMean += (rssBytes - rssMean) / samples;
    }
    if (isNonNegInt(heapUsedBytes) && (heapMax === null || heapUsedBytes > heapMax)) heapMax = heapUsedBytes;
    if (typeof ageMs === 'number' && Number.isFinite(ageMs) && ageMs >= 0) lastAgeMs = Math.round(ageMs);
    return true;
  }

  // The window as the builder consumes it. `heapUsedMaxBytes` is OMITTED (not
  // null / 0) when no sample carried a heap figure.
  function snapshot() {
    const s = {
      startedAt,
      endedAt: now(),
      samples,
      rssMinBytes: samples ? rssMin : 0,
      rssAvgBytes: samples ? Math.round(rssMean) : 0,
      rssMaxBytes: samples ? rssMax : 0,
      processAgeMs: lastAgeMs,
    };
    if (heapMax !== null) s.heapUsedMaxBytes = heapMax;
    return s;
  }

  // Close the window: return its snapshot and start a fresh one.
  function flush() {
    const s = snapshot();
    startedAt = s.endedAt;
    samples = 0; rssMin = 0; rssMax = 0; rssMean = 0; heapMax = null; lastAgeMs = 0;
    return s;
  }

  return { record, snapshot, flush };
}

// The producer: one aggregator per source runtime, a slow sampling timer and a
// window-flush timer.
//
//   sources  — [{ runtime, read }]; `read()` returns { rssBytes, heapUsedBytes?,
//              ageMs } or null (nothing to sample right now — e.g. no renderer
//              process yet). A throwing read is swallowed: instrumentation
//              must never take the app down.
//   consent  — live resolver; only an exact `true` samples / sends.
//   send     — (runtime, snapshot) => void, called for each non-empty window.
function createProcessMemoryProducer({
  sources,
  consent,
  send,
  now = Date.now,
  sampleMs = PROCESS_MEMORY_SAMPLE_MS,
  flushMs = PROCESS_MEMORY_FLUSH_MS,
  setIntervalImpl = setInterval,
} = {}) {
  const list = Array.isArray(sources) ? sources : [];
  for (const src of list) {
    if (!src || !PROCESS_MEMORY_RUNTIMES.includes(src.runtime) || typeof src.read !== 'function') {
      throw new TypeError('createProcessMemoryProducer: each source needs a known runtime and a read()');
    }
  }
  const entries = list.map((src) => ({ src, agg: createMemoryAggregator({ now }) }));
  const isEnabled = () => (typeof consent === 'function' ? consent() === true : false);
  const forward = typeof send === 'function' ? send : () => {};

  // Take ONE sample from every source. Off-consent: nothing is read, nothing
  // is retained.
  function sampleNow() {
    if (!isEnabled()) return 0;
    let folded = 0;
    for (const { src, agg } of entries) {
      let reading = null;
      try { reading = src.read(); } catch { reading = null; }
      if (reading && agg.record(reading)) folded += 1;
    }
    return folded;
  }

  // Close every window. Consent OFF → DISCARD (nothing out-of-consent is
  // retained, let alone sent). Consent ON → forward each NON-EMPTY window.
  // Returns the forwarded [{runtime, snapshot}] list.
  function flushNow() {
    const enabled = isEnabled();
    const sent = [];
    for (const { src, agg } of entries) {
      const snap = agg.flush();
      if (!enabled || snap.samples === 0) continue;
      forward(src.runtime, snap);
      sent.push({ runtime: src.runtime, snapshot: snap });
    }
    return sent;
  }

  // Arm both timers, UNREF'd.
  function start() {
    const timers = [setIntervalImpl(sampleNow, sampleMs), setIntervalImpl(flushNow, flushMs)];
    for (const t of timers) if (t && typeof t.unref === 'function') t.unref();
    return timers;
  }

  return { sampleNow, flushNow, start, isEnabled };
}

module.exports = {
  PROCESS_MEMORY_SAMPLE_MS,
  PROCESS_MEMORY_FLUSH_MS,
  PROCESS_MEMORY_RUNTIMES,
  createMemoryAggregator,
  createProcessMemoryProducer,
};
