// Pane input telemetry (WARDEN-1385) — the SERVER half of the first measurement
// of the user-felt path: what happens to a keystroke between this process and
// tmux. The renderer half (keystroke→echo end-to-end + the paint leg + main-
// thread health) lives in web/src/lib/paneLatency.ts; the two meet in the
// histograms: every hop is its own closed-set operation, so a slow echo can be
// attributed to input write, tmux round trip, WS delivery or renderer paint by
// READING THE HISTOGRAMS BESIDE EACH OTHER instead of guessing.
//
// THE GAP IT CLOSES. Warden's telemetry measured the Electron main loop (the
// stall/heartbeat family) and the server event loop (WARDEN-1278) — but NOTHING
// measured the path a user's keystroke actually takes. Two freeze reports
// (0.1.71, 0.1.72) each produced a detector upgrade rather than a fix because
// the detector could not see the thing that lagged: sub-second input echo
// latency. loop-monitor's 1s floor is structurally blind to the 50–500ms jank
// a typist feels, and an event-loop stall was never the whole story anyway.
// This producer samples the two server-side hops of that path:
//
//   • `pane-input-write`   — WS message received → `pty.write()` done. The cost
//     of handing a keystroke to the transport, measured on THIS process's
//     monotonic clock. Normally tens of microseconds; a number here means the
//     server child itself is congested.
//   • `pane-input-roundtrip` — `pty.write()` done → the NEXT output chunk from
//     that pane's PTY. This is the tmux round trip: write → ssh/companion
//     transport → remote tmux → echo back. The echo is the next chunk because
//     tmux redraws after processing input — for a pane whose app is streaming
//     output the next chunk may be stream output rather than the echo, so the
//     histogram is an UPPER BOUND on the round trip. That is exactly what the
//     conviction needs: if this hop is slow while the write hop is fast, the
//     transport (ssh spawn per keystroke, ConPTY, companion channel) convicts.
//
// WHAT IT MAY NEVER CARRY (WARDEN-443 hard exclusions): pane keys, chat names,
// hostnames, container names, content. Telemetry gets the two hop HISTOGRAMS —
// counts, min/avg/max, fixed-boundary buckets, closed kebab-case operation
// literals (validator-enforced). The per-PANE dimension the ticket asks for is
// real but LOCAL-ONLY: the bounded ledger below feeds the owner's on-demand
// read surface (GET /api/diagnostics/pane-latency), which is where a pane key
// may appear, exactly like stalls.jsonl + /api/diagnostics/stalls before it.
// Telemetry is strictly ADDITIVE beside that surface and is not the channel a
// signal the owner needs on demand rides.
//
// CONSENT: recording is gated LIVE on the `operational-metrics` category (a
// latency is an operational metric — the same category file-exists probes ride;
// no new category, no new checkbox). When the category is off (the default),
// note*() refuses and flushNow() both skips sending AND drops the window, so
// nothing out-of-consent is even retained in memory. The window is flushed to
// the Electron main process over the fork's IPC channel (main builds the schema
// event and records it through the standard consent-gated pipeline); when the
// server runs standalone (no process.send), the flush is a no-op and the module
// is inert on the wire.
//
// The heavy lifting (bounded windows, fixed-boundary histograms, operation
// caps) is the M1 aggregator in src/telemetry-metrics.cjs; the consent gate,
// the IPC forward, the flushNow control flow and the unref'd start() are the
// shared scaffold in src/telemetryProducer.js (WARDEN-1352). This module is
// only the pane-specific policy: the two operations, the pending-input
// correlation, the bounded per-pane ledger, and the flush cadence.

import { createMetricAggregator } from './telemetry-metrics.cjs';
import { createConsentGatedWindow } from './telemetryProducer.js';

// The closed operation set — constant lowercase-kebab literals by the
// aggregator's caller contract (schema OPERATION_NAME_RE enforces the shape
// structurally, so a pane key can never ride one even if a caller tried).
export const PANE_INPUT_OPS = Object.freeze({
  /** WS input message received → pty.write() done (this process's leg). */
  WRITE: 'pane-input-write',
  /** pty.write() done → next output chunk from that pane's PTY (tmux round trip). */
  ROUNDTRIP: 'pane-input-roundtrip',
});

// Default flush cadence — the same 5-minute window the file-exists and stall
// producers close on, so every server-side telemetry channel lands on one
// rhythm. An idle window (no keystrokes) is not sent at all.
export const PANE_INPUT_FLUSH_MS = 5 * 60_000;

// Correlation window: a pending input older than this is STALE — its echo (or
// its next output chunk) is presumed lost, so it is dropped rather than folded
// as a monstrous latency that would poison the histogram's tail. Generous
// against real lag (the conviction must see a 2s echo) but bounded against
// garbage (a pane that produced no output for a minute must not fold a 60s
// sample the moment it finally does).
export const PENDING_INPUT_MAX_AGE_MS = 10_000;

// The per-pane LOCAL ledger's bounds — the owner's read surface, not telemetry.
// MAX_PANES bounds the map (a workspace with more open panes than this rotates
// the oldest entry out; the aggregate histograms above are unaffected), and
// RING_PER_PANE bounds the samples kept per pane (enough for a p50/p95 over the
// last minute of typing, small enough to be constant-memory).
export const LEDGER_MAX_PANES = 64;
export const LEDGER_RING_PER_PANE = 32;

// Bounded ring buffer of one pane's round-trip samples (ms, monotonic-clock
// deltas), oldest first, plus the epoch-ms stamp of the last sample for the
// "how stale is this reading" question the endpoint answers.
function createRing(capacity) {
  const buf = [];
  return {
    push(value, at) {
      buf.push({ ms: value, at });
      if (buf.length > capacity) buf.shift();
    },
    get size() { return buf.length; },
    lastAt() { return buf.length ? buf[buf.length - 1].at : null; },
    values() { return buf.map((s) => s.ms); },
  };
}

// Percentile over a SMALL sample by sort (n ≤ 32 — sorting is free here).
// Returns null on an empty sample: "no samples" is an honest absence, never 0.
export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/**
 * Create the pane-input telemetry producer.
 *
 * All collaborators are injectable so the unit tests run with a fake clock, a
 * captured `send`, and a togglable consent — no timers, no IPC, no real typing.
 *
 *   consent()  — live resolver: is the `operational-metrics` category enabled?
 *   send(snapshot) — the IPC forward (server.js wires process.send).
 *   intervalMs / setIntervalImpl — the flush cadence + injectable timer.
 *   now()      — the MONOTONIC-ish duration clock for the pending-input
 *                correlation (production passes performance.now; tests pass a
 *                controllable fake). Window STAMPS stay epoch (the aggregator's
 *                own default clock) so the event builder's contract is
 *                unchanged — only the hop DURATIONS come from this clock.
 *   ledgerMaxPanes / ledgerRing — the local ledger's bounds (tests shrink them).
 *
 * Returns { noteInputWritten, notePaneOutput, ledger, flushNow, start }.
 */
export function createPaneInputTelemetry({
  consent,
  send,
  intervalMs = PANE_INPUT_FLUSH_MS,
  setIntervalImpl = setInterval,
  aggregator = createMetricAggregator(),
  now = () => performance.now(),
  ledgerMaxPanes = LEDGER_MAX_PANES,
  ledgerRing = LEDGER_RING_PER_PANE,
} = {}) {
  // The consent gate, the IPC forward, the flushNow control flow and the
  // unref'd start() are the SHARED scaffold (WARDEN-1352). This producer's
  // window shape is the operations[] aggregate, so a window is worth sending
  // when ANY operation folded or anything was rejected.
  const gated = createConsentGatedWindow({
    consent,
    send,
    intervalMs,
    setIntervalImpl,
    aggregator,
    hasAnything: (snapshot) => snapshot.operations.length > 0 || snapshot.rejected > 0,
  });
  const isEnabled = gated.isEnabled;

  /** pane key → { at, clock } — the ONE pending input per pane (the latest
   *  keystroke wins; a burst of typing folds as the last keystroke's age). */
  const pending = new Map();
  /** pane key → ring — the LOCAL per-pane ledger (never telemetry). */
  const ledger = new Map();

  function ledgerFor(key) {
    let ring = ledger.get(key);
    if (!ring) {
      // Bound the map: past the cap, rotate the OLDEST entry out (insertion
      // order is creation order; refresh-on-write would need a full LRU — the
      // histograms are the completeness guarantee, the ledger is a lead list).
      if (ledger.size >= ledgerMaxPanes) {
        const oldest = ledger.keys().next().value;
        ledger.delete(oldest);
      }
      ring = createRing(ledgerRing);
      ledger.set(key, ring);
    }
    return ring;
  }

  /**
   * Fold the WRITE leg and open the pane's pending-input correlation. Called
   * by the WS layer AFTER `pty.write()` of an input completes, with the age of
   * the write leg in ms (message received → write done) and the pane key.
   * Returns false when consent is off or the observation was rejected.
   */
  function noteInputWritten(key, writeLegMs) {
    if (!isEnabled()) return false;
    if (typeof key !== 'string' || key.length === 0) return false;
    const folded = aggregator.record(PANE_INPUT_OPS.WRITE, writeLegMs, { ok: true });
    pending.set(key, { at: now(), stamp: Date.now() });
    return folded;
  }

  /**
   * Fold the ROUND-TRIP leg for a pane whose PTY just produced output while an
   * input was pending. The FIRST output chunk after a keystroke is the echo
   * candidate; later chunks find no pending input and cost one Map probe.
   * A pending input older than PENDING_INPUT_MAX_AGE_MS is dropped, not folded.
   * Returns false when nothing correlated (the common, healthy case).
   */
  function notePaneOutput(key) {
    if (typeof key !== 'string' || key.length === 0) return false;
    const entry = pending.get(key);
    if (!entry) return false;
    pending.delete(key);
    if (!isEnabled()) return false;
    const ms = now() - entry.at;
    if (!(ms >= 0) || ms > PENDING_INPUT_MAX_AGE_MS) return false;
    ledgerFor(key).push(ms, entry.stamp);
    return aggregator.record(PANE_INPUT_OPS.ROUNDTRIP, ms, { ok: true });
  }

  /**
   * The LOCAL per-pane ledger projection for the diagnostics endpoint: one row
   * per pane with samples plus p50/p95/max, newest-first by last sample. Pane
   * keys appear HERE by design — this surface is the owner's, and it is the
   * "which pane" half of the attribution telemetry cannot carry.
   */
  function ledgerSnapshot() {
    const rows = [];
    for (const [key, ring] of ledger) {
      const values = ring.values();
      rows.push({
        pane: key,
        samples: ring.size,
        p50Ms: percentile(values, 50),
        p95Ms: percentile(values, 95),
        maxMs: values.length ? Math.max(...values) : null,
        lastAt: ring.lastAt(),
      });
    }
    rows.sort((a, b) => ((a.lastAt ?? 0) < (b.lastAt ?? 0) ? 1 : -1));
    return rows;
  }

  /**
   * Drop one pane's PENDING input correlation (detach / PTY exit): the echo of
   * a keystroke written to a dying PTY will never arrive, so the pending entry
   * must not sit there until it can fold as a stale monster. The LEDGER row is
   * deliberately KEPT — it is the owner's evidence about the pane that just
   * ended, and the next attach to the same pane continues it.
   */
  function dropPending(key) {
    pending.delete(key);
  }

  /** Drop one pane's pending input AND ledger row (complete reset; tests). */
  function forgetPane(key) {
    pending.delete(key);
    ledger.delete(key);
  }

  /**
   * The CURRENT aggregate window, WITHOUT closing it (read-only observation —
   * the diagnostics endpoint curls this mid-window and must never split the
   * telemetry window the way a flush would).
   */
  function windowSnapshot() {
    return aggregator.snapshot();
  }

  /** How many pane correlations are currently open (the endpoint's sanity read). */
  function pendingCount() {
    return pending.size;
  }

  return {
    noteInputWritten,
    notePaneOutput,
    dropPending,
    forgetPane,
    ledgerSnapshot,
    windowSnapshot,
    pendingCount,
    flushNow: gated.flushNow,
    start: gated.start,
    isEnabled,
  };
}
