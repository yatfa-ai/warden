'use strict';

// Local transmission log of ACTUAL send outcomes — slice 7 of the optional,
// OFF-by-default telemetry client (roadmap WARDEN-446 / WARDEN-583). This closes
// verifiability's MISSING THIRD LEG.
//
// Verifiability ships two legs today (web/src/lib/telemetry/transparency.ts):
//   • describeCollection — the PROMISE (what consent says it collects)
//   • previewPayload    — the PREVIEW (the exact redacted payload the pipeline
//                          WOULD transmit for a candidate event)
// The third leg — a record of what was ACTUALLY sent on the wire — did not exist.
// The transport (src/telemetry-send.js) returns a rich per-batch outcome
// `{ ok, dropped, attempts, status }`, but the pipeline SWALLOWED it (the old
// `result.then(() => {}, () => {})` at the dispatch call site), so an opt-in user
// could not inspect whether sends landed, how many, or that sending stopped when
// they toggled telemetry off. This module is that local, metadata-only record.
//
// METADATA ONLY. By construction an entry NEVER carries payload content, redacted
// fields, or chat/session identifiers. It is a pure consumer of (a) the transport
// result object and (b) the endpoint HOST (hostname[:port] only — never the full
// URL with path/query). It re-collects nothing and introduces no new data leaving
// the machine — it is a user-owned local audit of sends the client already made.
//
// PURE + DEPENDENCY-INJECTED. The clock is injected (test discipline: never
// Date.now() directly in a seam callers observe indirectly) and the ring cap is
// injected. Zero real network, zero real fs — it is a pure in-memory data
// structure, session-scoped (a durable on-disk audit log is a later slice).
//
// The bounded-ring discipline mirrors web/src/lib/telemetry/client.ts:142-145
// (`buffer.push(safe); if (buffer.length > maxBuffer) buffer.shift()`): the
// OLDEST entry drops past the cap so a long-lived session cannot grow memory
// unbounded.

// Default cap — bounds memory over a long session. Generous enough to give the
// user a meaningful recent-history window, bounded enough that a chatty session
// never leaks memory. Mirrors the spirit of client.ts's maxBuffer.
const DEFAULT_CAP = 200;

// Safe default clock — the wall clock. Tests inject a deterministic clock so the
// recorded timestamps are pin-able; production uses real time.
const defaultClock = () => Date.now();

// A frozen no-op recorder. The pipeline's DEFAULT transmissionLog collaborator:
// when no log is injected, the pipeline records nothing and behaves EXACTLY as it
// did before this slice (today's behavior). An unconfigured pipeline must not
// allocate or retain anything.
const noopTransmissionLog = Object.freeze({
  record() {},
  entries() {
    return [];
  },
  size() {
    return 0;
  },
});

// Derive the endpoint HOST (hostname[:port]) from a full endpoint URL — metadata
// only. Returns null for an empty/invalid URL. Deliberately the HOST and not the
// full URL: a full URL carries path/query segments that could include identifying
// tokens, and the log's contract is "where did it go" (a stable destination
// label), not the full request line. Exported so the pipeline (which holds
// endpointUrl) shares one derivation and the host-only discipline lives in
// exactly one place — unit-testable in isolation here.
function hostOf(endpointUrl) {
  if (typeof endpointUrl !== 'string' || !endpointUrl) return null;
  try {
    return new URL(endpointUrl).host;
  } catch {
    return null; // a malformed/unparseable URL yields no host, never a crash
  }
}

// Factory. All collaborators are injected; every injection has a safe default so
// an unconfigured log still works (records real time into a bounded ring). Returns:
//   .record(entry) — append one metadata-only entry to the bounded ring.
//   .entries()     — a SNAPSHOT (shallow copy) of the ring, oldest → newest.
//                    Callers cannot mutate the live ring through it.
//   .size()        — the current entry count.
//
// `entry` is a partial metadata object; missing/invalid fields are normalized so
// a malformed transport result can never smuggle an unexpected field (or field
// type) into the ring. The shape — the ONLY fields ever stored — is:
//   { timestamp, endpointHost, schemaVersion, eventCount, outcome, attempts, status }
function createTransmissionLog(opts) {
  const o = opts || {};
  const cap = Number.isInteger(o.cap) && o.cap > 0 ? o.cap : DEFAULT_CAP;
  const clock = typeof o.clock === 'function' ? o.clock : defaultClock;
  const ring = [];

  function record(entry) {
    const e = entry && typeof entry === 'object' ? entry : {};
    // Normalize + stamp. `timestamp` defaults to the injected clock when the
    // caller did not supply one (the pipeline never does — the log owns
    // timestamping, so the pipeline never touches Date.now()).
    const stamped = {
      timestamp: Number.isFinite(e.timestamp) ? e.timestamp : clock(),
      endpointHost: typeof e.endpointHost === 'string' ? e.endpointHost : null,
      schemaVersion: typeof e.schemaVersion === 'number' ? e.schemaVersion : null,
      eventCount: typeof e.eventCount === 'number' ? e.eventCount : 0,
      outcome: e.outcome === 'ok' || e.outcome === 'dropped' ? e.outcome : null,
      attempts: typeof e.attempts === 'number' ? e.attempts : 0,
      status: e.status === null || typeof e.status === 'number' ? e.status : null,
    };
    ring.push(stamped);
    if (ring.length > cap) ring.shift(); // bounded — drop the OLDEST past the cap
  }

  function entries() {
    return ring.slice(); // snapshot copy — the live ring is never exposed
  }

  function size() {
    return ring.length;
  }

  return { record, entries, size };
}

module.exports = {
  createTransmissionLog,
  hostOf,
  noopTransmissionLog,
  DEFAULT_CAP,
};
