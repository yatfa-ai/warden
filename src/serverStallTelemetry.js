// Server-stall telemetry (WARDEN-1278) — the FIRST telemetry producer that runs
// in the SERVER CHILD's own runtime, and the first event ever emitted with
// `runtime: 'server'`.
//
// THE GAP IT CLOSES. warden's backend is a forked child of the Electron main
// process, and until the v6 schema bump the wire had no `server` runtime — so
// the heaviest worker in the app (SSH, tmux, config reads, background sweeps)
// could emit NO event under ANY consent, by construction. Its event-loop stall
// machinery (src/loop-monitor.js, WARDEN-977) has meanwhile been detecting
// multi-second freezes WITH attribution and delivering them to three LOCAL
// channels only. The owner's own journal carries hundreds of real repeated
// freezes that reach nobody who could act on them.
//
// THIS MODULE IS ADDITIVE, NOT A REPLACEMENT. The three local channels
// (stalls.jsonl, the stderr line, GET /api/diagnostics/stalls) are byte-
// untouched: they are the OWNER's on-demand read surface, and the "telemetry is
// deliberately NOT the channel" note in server.js / stall-log.js is about THAT
// — telemetry is opt-in and off by default, so it cannot be the channel for a
// signal the owner needs to read on demand. It can perfectly well be an
// additional one for the maintainer, with consent.
//
// WHAT IT MAY NEVER CARRY (WARDEN-443 hard exclusions): file paths, hostnames,
// chat content, credentials. The aggregator (src/telemetry-stalls.cjs) folds
// stalls into counts / durations / a lag histogram / a per-culprit map whose
// keys are projected onto a CLOSED SET before they can become aggregate keys,
// and the schema validator enforces that kebab-case shape structurally — so a
// route path, an agent name or a session id can never ride one. There is no
// free-text field in the event at all.
//
// CONSENT: recording is gated LIVE on the `incidents` category (a freeze IS an
// incident — the same category `performance-stall` already rides; there is no
// new category and no new checkbox). When the category is off (the default),
// record() refuses and flushNow() both skips sending AND drops the window, so
// nothing out-of-consent is even retained in memory. The window is flushed to
// the Electron main process over the fork's IPC channel (main builds the schema
// event and records it through the standard consent-gated pipeline); when the
// server runs standalone (no process.send), the flush is a no-op and the module
// is inert on the wire.

import { createStallAggregator } from './telemetry-stalls.cjs';

// Default flush cadence — the SAME 5-minute window the file-exists metrics
// producer uses, so the two channels close on one rhythm. An idle window (no
// stalls) is not sent at all, so a healthy session ships nothing.
export const SERVER_STALL_FLUSH_MS = 5 * 60_000;

// The stall-specific policy around the shared bounded aggregator. All
// collaborators are injectable so the unit tests run with a fake clock, a
// captured `send`, and a togglable consent — no timers, no IPC, no real waiting.
//
//   consent()      — live resolver: is the `incidents` category enabled?
//   send(snapshot) — the IPC forward (server.js wires process.send).
//   intervalMs / setIntervalImpl — the flush cadence + injectable timer.
//   knownSegments  — the live route-segment set for culprit-key mapping, as a
//                    Set or a THUNK returning one (server.js passes a thunk: the
//                    route table is only complete after the last app.get()).
//
// Returns { recordStall, flushNow, start }.
export function createServerStallTelemetry({
  consent,
  send,
  intervalMs = SERVER_STALL_FLUSH_MS,
  setIntervalImpl = setInterval,
  knownSegments,
  aggregator = createStallAggregator({ knownSegments }),
} = {}) {
  const isEnabled = () => (typeof consent === 'function' ? consent() === true : false);
  const forward = typeof send === 'function' ? send : () => {};

  // Fold ONE stall record — the exact object src/loop-monitor.js's
  // buildStallRecord produces, handed straight from the setOnStall callback.
  // Returns false when consent is off or the record is degenerate; NEVER
  // throws, because this runs on the stall path of a process whose job is not
  // to observe itself.
  function recordStall(record) {
    if (!isEnabled()) return false;
    return aggregator.record(record);
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
    // A window with no stalls is the healthy case and is the overwhelming
    // majority — sending it would be pure noise on the wire and in the store.
    const hasAnything = snapshot.count > 0 || snapshot.rejected > 0;
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

  return { recordStall, flushNow, start };
}

/**
 * Derive the set of STATIC route segments from a live express app, so the
 * culprit-key mapping's closed set can never drift from the real route table.
 *
 * A `:param` segment is deliberately EXCLUDED — that is exactly the position a
 * session id / collection id occupies, and it must map to the `id` placeholder,
 * not to a literal.
 *
 * Defensive: an express version whose router is not reachable yields an empty
 * set, and the aggregator falls back to its own vendored ROUTE_SEGMENTS list.
 * Losing the live set costs RESOLUTION (routes stop being distinguishable in the
 * aggregate), never SAFETY — an unknown segment folds to `id` either way.
 *
 * @param {object} app an express application
 * @returns {Set<string>}
 */
export function routeSegmentsOf(app) {
  const out = new Set();
  const router = app && (app.router || app._router);
  const stack = router && Array.isArray(router.stack) ? router.stack : [];
  for (const layer of stack) {
    const routePath = layer && layer.route && layer.route.path;
    if (typeof routePath !== 'string') continue;
    for (const seg of routePath.split('/')) {
      if (!seg || seg.startsWith(':')) continue;
      out.add(seg);
    }
  }
  return out;
}
