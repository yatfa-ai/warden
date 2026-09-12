// Shared consent-gated telemetry window scaffold (WARDEN-1352) — the live
// consent gate, the IPC forward, the flushNow control flow, and the unref'd
// start() that every telemetry PRODUCER wraps its aggregator with. Extracted
// from src/fileExistsTelemetry.js (WARDEN-1258) and src/serverStallTelemetry.js
// (WARDEN-1278), which had defined this scaffold identically; the THIRD producer
// specified by WARDEN-1292 (src/requestTelemetry.js) composes this leaf instead
// of typing a third inlined copy that is redundant the day it merges.
//
// SCOPE — the scaffold, never the domain. What is shared is the POLICY: when a
// producer may record (live consent, exact-true, fail closed), where a snapshot
// goes (a missing forward is inert, not a crash), what happens to a window
// closed out-of-consent (it is DISCARDED — never retained, let alone
// transmitted), when a window is worth sending (the per-producer `hasAnything`
// predicate), and how the flush timer is armed (unref'd, so a library import —
// every test that loads server.js — never keeps the event loop alive on this
// timer alone).
//
// `hasAnything` is a genuine per-producer PARAMETER, not a collapsible
// falsiness test: the two aggregators return DIFFERENT window shapes (the
// metrics aggregate is an `operations[]` window, the stall aggregate a scalar
// `count` window), so emptiness is a domain fact each producer owns. Do not
// uniformize the shapes to shrink this signature.
//
// Deliberately NOT here: the aggregators (src/telemetry-metrics.cjs and
// src/telemetry-stalls.cjs also carry near-identical normalize* helpers, but
// they differ in their thrown TypeError prefixes, which tests assert — folding
// them is the WARDEN-1067 "what NOT to fold" case), the domain recorders, the
// flush-cadence constants, and each producer's public factory shape. A producer
// keeps its own identity; only the scaffold moved.
//
// Kept dependency-free (ZERO imports) so it is a true leaf — the same shape as
// src/retry.js, src/chatMeta.js, src/budget.js and src/health.js — and so no
// import cycle is structurally possible among its consumers.

/**
 * Build the consent-gated flush machinery for one telemetry producer.
 *
 * All collaborators are injectable so the unit tests run with a togglable
 * consent, a captured `send`, and a fake timer — no real waiting.
 *
 * @param {object} opts
 * @param {() => boolean} [opts.consent] live consent resolver. Only an exact
 *   `=== true` enables: a producer with no consent resolver — or one returning
 *   any other value — collects nothing (fail closed).
 * @param {(snapshot: object) => void} [opts.send] the IPC forward (server.js
 *   wires process.send). A missing or non-function send is inert, not a crash:
 *   the producer still folds and drops its windows, it just ships nothing.
 * @param {number} opts.intervalMs flush cadence in milliseconds.
 * @param {typeof setInterval} [opts.setIntervalImpl] injectable timer (tests
 *   run with a fake clock).
 * @param {{ flush: () => object }} opts.aggregator the producer's aggregator;
 *   `flush()` closes the window and returns its snapshot.
 * @param {(snapshot: object) => boolean} opts.hasAnything the per-producer
 *   predicate deciding whether a closed snapshot is worth sending.
 * @returns {{ isEnabled: () => boolean, flushNow: () => object|null,
 *             start: () => * }}
 *   `isEnabled` is exposed because the producers' own recorders gate themselves
 *   on the same live gate; `flushNow` returns the snapshot when one was
 *   forwarded, else null; `start` returns the armed timer.
 */
export function createConsentGatedWindow({
  consent,
  send,
  intervalMs,
  setIntervalImpl = setInterval,
  aggregator,
  hasAnything,
}) {
  const isEnabled = () => (typeof consent === 'function' ? consent() === true : false);
  const forward = typeof send === 'function' ? send : () => {};

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
    // An idle window is not sent at all. "Idle" is whatever the producer's
    // hasAnything predicate says it is — the aggregators return different
    // window shapes, so emptiness is a per-producer fact (each producer's
    // predicate carries its own rationale).
    if (!hasAnything(snapshot)) return null;
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

  return { isEnabled, flushNow, start };
}
