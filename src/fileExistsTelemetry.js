// File-exists probe telemetry (WARDEN-1258) — the FIRST live producer for the
// `operational-metrics` consent category (design-article authorization of
// 2026-08-19; the category itself is registered in telemetry-consent.cjs).
//
// WHAT IT MEASURES — exactly the dimensions the ticket's territory names:
//   • how many probes are issued            → per-operation `count`
//   • what share succeed                    → `okCount` / `failCount`
//   • the latency split local vs remote     → two operations, each with its own
//                                              min/avg/max + bucket histogram
//   • cache-hit behaviour                   → a third operation fed by the
//                                              RENDERER's per-pane cache-hit
//                                              delta, piggybacked on each probe
//                                              request (the renderer never
//                                              probes on a hit, so the server
//                                              only learns hits from the client)
//
// WHAT IT MAY NEVER CARRY (WARDEN-443 hard exclusions): file paths, hostnames,
// chat content, credentials. The aggregator folds observations into counts /
// ratios / latencies and retains no per-observation row; operation names are
// CONSTANT kebab-case literals (the aggregator's caller contract), and the
// schema validator enforces that pattern structurally, so a path or hostname
// can never ride an aggregate key.
//
// CONSENT: recording is gated LIVE on the `operational-metrics` category — when
// the category is off (the default), record() refuses and flushNow() both
// skips sending AND drops the window, so nothing is even retained in memory
// while off. The window is flushed to the Electron main process over the
// fork's IPC channel (main builds the schema event and records it through the
// standard consent-gated pipeline); when the server runs standalone (no
// process.send), the flush is a no-op and the module is inert on the wire.
//
// The heavy lifting (bounded windows, fixed-boundary histograms, operation
// caps) is the M1 aggregator in src/telemetry-metrics.cjs; this module is only
// the probe-specific policy: which operations exist, the consent gate, the
// flush cadence, and the IPC forward.

import { createMetricAggregator } from './telemetry-metrics.cjs';

// The closed operation set — constant literals by the aggregator's caller
// contract. NOTE the names are lowercase kebab-case ONLY: the schema validator
// (web/src/lib/telemetry/schema.ts OPERATION_NAME_RE) rejects anything else,
// which is precisely the structural hard-exclusion proof for this event type.
// Keep them short (<20 chars) and single-class so the redactor's high-entropy
// rule can never fire on them either.
export const FILE_EXISTS_OPS = Object.freeze({
  /** LOCAL chat existence probes (/api/file-exists, host === LOCAL). */
  LOCAL: 'file-exists-local',
  /** REMOTE chat existence probes (buildFileExistsScript over SSH). */
  REMOTE: 'file-exists-remote',
  /** Cache HITS in the renderer's per-pane cache, reported as deltas. */
  CACHE_HIT: 'file-exists-cache-hit',
});

// Default flush cadence. A window closes every 5 minutes; an idle window (no
// observations, nothing rejected) is not sent at all, so a session that never
// linkifies ships nothing.
export const FILE_EXISTS_FLUSH_MS = 5 * 60_000;

// Defensive bound on a single renderer-reported cache-hit delta (a non-integer,
// negative, or absurdly large value is corrupt input, not a measurement — treat
// it as 0 rather than fold garbage into the aggregate).
const MAX_CACHE_HIT_DELTA = 65_535;

// The probe-specific policy around the shared M1 aggregator. All collaborators
// are injectable so the unit tests run with a fake clock, a captured `send`,
// and a togglable consent — no timers, no IPC, no real waiting.
//
//   consent()  — live resolver: is the `operational-metrics` category enabled?
//   send(snapshot) — the IPC forward (server.js wires process.send).
//   intervalMs / setIntervalImpl — the flush cadence + injectable timer.
//
// Returns { recordProbe, recordCacheHits, flushNow, start }.
export function createFileExistsTelemetry({
  consent,
  send,
  intervalMs = FILE_EXISTS_FLUSH_MS,
  setIntervalImpl = setInterval,
  aggregator = createMetricAggregator(),
} = {}) {
  const isEnabled = () => (typeof consent === 'function' ? consent() === true : false);
  const forward = typeof send === 'function' ? send : () => {};

  // Fold ONE probe observation. `kind` is 'local' | 'remote'; `ok` is the
  // exists:true/false verdict; `durationMs` the wall-clock cost of resolving
  // it (for a remote chat that includes the SSH round trip — the latency the
  // territory section wants split by branch).
  function recordProbe(kind, durationMs, ok) {
    if (!isEnabled()) return false;
    const op = kind === 'remote' ? FILE_EXISTS_OPS.REMOTE : FILE_EXISTS_OPS.LOCAL;
    return aggregator.record(op, durationMs, { ok: ok !== false });
  }

  // Fold a renderer-reported cache-hit DELTA (k hits served from the pane's
  // per-path cache since the last probe request). Cache hits have no server
  // duration — they are a COUNTS-only observation riding the same aggregate
  // shape with duration 0, so `count` is the number of hits and the latency
  // fields stay honestly zero.
  function recordCacheHits(hits) {
    if (!isEnabled()) return false;
    // Strict: only a real JSON number folds. A numeric STRING or any other
    // hand-crafted shape is corrupt input, not a measurement.
    if (typeof hits !== 'number' || !Number.isInteger(hits) || hits <= 0 || hits > MAX_CACHE_HIT_DELTA) return false;
    let folded = false;
    for (let i = 0; i < hits; i += 1) {
      folded = aggregator.record(FILE_EXISTS_OPS.CACHE_HIT, 0, { ok: true }) || folded;
    }
    return folded;
  }

  // Close the window. Consent ON → forward a non-empty snapshot; consent OFF →
  // DROP the window without sending (and drop anything a mid-window consent
  // flip may have left behind — nothing out-of-consent is retained, let alone
  // transmitted). Returns the snapshot when one was forwarded, else null.
  function flushNow() {
    if (!isEnabled()) {
      aggregator.flush(); // discard, keep the next window's start fresh
      return null;
    }
    const snapshot = aggregator.flush();
    const hasAnything = snapshot.operations.length > 0 || snapshot.rejected > 0;
    if (!hasAnything) return null;
    forward(snapshot);
    return snapshot;
  }

  // Arm the periodic flush. UNREF'd so a library import (every test that loads
  // server.js) never keeps the event loop alive on this timer alone.
  function start() {
    const t = setIntervalImpl(flushNow, intervalMs);
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  }

  return { recordProbe, recordCacheHits, flushNow, start };
}
