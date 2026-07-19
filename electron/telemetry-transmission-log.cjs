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
// injected. Zero real network, zero real fs from inside this module — the OPTIONAL
// `save` seam is the only route to disk (production injects an atomic writer, tests
// inject a capturing fake), so the ring itself stays a pure in-memory data structure.
// The durable on-disk audit (WARDEN-782) is wired in main.cjs via that seam: the
// ring is seeded from the persisted file on startup and debounced-saved on record().
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

// Safe default save — a no-op. The persistence seam's default collaborator: when no
// save is injected, record() persists nothing and the log behaves EXACTLY as it did
// before WARDEN-782 (session-scoped, in-memory only). An unconfigured log must not
// touch disk.
const noop = () => {};

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
  seed() {},
  flushSave() {
    return false;
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

// Normalize one entry to the fixed 7-field metadata-only shape. Extracted so both
// record() AND seed() (the load path) share ONE normalization — the shape lives in
// exactly one place, and a field smuggled onto disk cannot survive into the live
// ring. `timestamp` defaults to the injected clock when the caller did not supply a
// finite one (record() never supplies one — the log owns timestamping; seed()
// supplies the loaded timestamps, which are preserved when finite).
function normalizeEntry(entry, clock) {
  const e = entry && typeof entry === 'object' ? entry : {};
  return {
    timestamp: Number.isFinite(e.timestamp) ? e.timestamp : clock(),
    endpointHost: typeof e.endpointHost === 'string' ? e.endpointHost : null,
    schemaVersion: typeof e.schemaVersion === 'number' ? e.schemaVersion : null,
    eventCount: typeof e.eventCount === 'number' ? e.eventCount : 0,
    outcome: e.outcome === 'ok' || e.outcome === 'dropped' ? e.outcome : null,
    attempts: typeof e.attempts === 'number' ? e.attempts : 0,
    status: e.status === null || typeof e.status === 'number' ? e.status : null,
  };
}

// Pure load-side parser (WARDEN-782): turn the persisted audit file's text into an
// array of raw entry objects with SKIP-MALFORMED semantics — one corrupt line is
// skipped, never fatal, so a single bad entry cannot blank the whole audit on
// startup. The file is NDJSON (one JSON object per line — the same discipline as the
// receiver-side warden-telemetry/store.mjs parseNdjson, and robust against mid-file
// corruption that a single JSON document could not survive). Missing/empty/non-
// string text → []. Never throws. Each surviving line's parsed object is RE-
// NORMALIZED by seed() before it reaches the live ring, so a parseable-but-malformed
// entry (a smuggled field, a bad type) is still reduced to the 7-field shape.
function parseTransmissionLog(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') out.push(parsed);
    } catch {
      // a partial/corrupt line must not poison the whole read — skip it
    }
  }
  return out;
}

// Factory. All collaborators are injected; every injection has a safe default so
// an unconfigured log still works (records real time into a bounded ring). Returns:
//   .record(entry) — append one metadata-only entry to the bounded ring, then
//                    schedule a persisted save (debounced; noop when no `save`).
//   .entries()     — a SNAPSHOT (shallow copy) of the ring, oldest → newest.
//                    Callers cannot mutate the live ring through it.
//   .size()        — the current entry count.
//   .seed(arr)     — REPLACE the ring from a loaded array (the restart-restore
//                    path). Re-normalizes each entry + enforces the cap. Does NOT
//                    trigger a save (writing back what we just read is a no-op).
//   .flushSave()   — materialize a pending debounced save IMMEDIATELY (the quit
//                    path). Returns whether a pending write was flushed.
//
// `entry` is a partial metadata object; missing/invalid fields are normalized so
// a malformed transport result can never smuggle an unexpected field (or field
// type) into the ring. The shape — the ONLY fields ever stored — is:
//   { timestamp, endpointHost, schemaVersion, eventCount, outcome, attempts, status }
//
// Persistence seam (WARDEN-782): `save(entries)` is invoked with a ring snapshot
// after each record() (debounced via `debounceMs`); production injects an atomic
// fs writer, tests inject a capturing fake. Default noop → today's session-scoped
// behavior (nothing persisted). The ring stays pure + dependency-injected: `save`
// never reaches real fs from inside this module, so the seam is unit-testable with
// zero real fs (same discipline as the injected clock/cap).
function createTransmissionLog(opts) {
  const o = opts || {};
  const cap = Number.isInteger(o.cap) && o.cap > 0 ? o.cap : DEFAULT_CAP;
  const clock = typeof o.clock === 'function' ? o.clock : defaultClock;
  const save = typeof o.save === 'function' ? o.save : noop;
  const debounceMs =
    Number.isFinite(o.debounceMs) && o.debounceMs >= 0 ? Math.floor(o.debounceMs) : 0;
  const ring = [];
  let saveTimer = null;

  function snapshot() {
    return ring.slice();
  }

  // Persist a snapshot via the injected save. Wrapped so a throwing save (e.g. a
  // real fs failure not caught by production's writer) can never crash the telemetry
  // pipeline — durability is best-effort, never load-bearing on the send path.
  function fireSave() {
    saveTimer = null;
    try {
      save(snapshot());
    } catch {
      /* a persist failure must never crash the telemetry pipeline */
    }
  }

  function scheduleSave() {
    if (debounceMs <= 0) {
      fireSave(); // immediate — no timer, nothing to flush
      return;
    }
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(fireSave, debounceMs);
  }

  function record(entry) {
    ring.push(normalizeEntry(entry, clock));
    if (ring.length > cap) ring.shift(); // bounded — drop the OLDEST past the cap
    scheduleSave();
  }

  function seed(entries) {
    if (!Array.isArray(entries)) return;
    // REPLACE the ring (not append): re-seeding resets. Re-normalize each loaded
    // entry so a field corrupted on disk cannot survive into the live ring, then
    // enforce the cap (drop oldest past it, matching record()'s FIFO discipline).
    ring.length = 0;
    for (const raw of entries) ring.push(normalizeEntry(raw, clock));
    while (ring.length > cap) ring.shift();
    // NOTE: no scheduleSave() — the load path persists nothing (writing back what we
    // just read is a redundant rewrite of identical data).
  }

  function entries() {
    return snapshot();
  }

  function size() {
    return ring.length;
  }

  // Materialize a pending debounced save IMMEDIATELY (clearing the timer first).
  // Wired to the app's quit path so the last sends survive a close-mid-debounce.
  // Returns whether a pending write was flushed; a no-op (returns false) when
  // nothing is pending, so it is safe to call unconditionally on quit.
  function flushSave() {
    if (saveTimer == null) return false;
    clearTimeout(saveTimer);
    fireSave();
    return true;
  }

  return { record, entries, size, seed, flushSave };
}

// Defensive snapshot reader for the IPC surfacing seam (WARDEN-668). The main-
// process IPC handler `telemetry:transmission-log` is a thin delegate to this:
// it returns `log.entries()` (already a snapshot copy — the live ring is never
// handed out) on success and degrades to `[]` on ANY throw, so a renderer query
// can never crash the main process or block the verifiability panel. The same
// `[]`-on-failure contract the renderer accessor (getTelemetryTransmissionLog)
// uses on its side of the bridge — both seams degrade to "no sends" identically.
//
// Exported (not inlined in main.cjs) precisely SO the IPC handler's defensive
// contract is unit-testable in isolation: main.cjs cannot be require()'d in a
// test (it imports 'electron'), but this pure function can. A non-log argument
// (null/undefined/an object without entries()) also degrades to [] — a
// partially-wired pipeline must surface as "no sends", never as a crash.
function readSnapshot(log) {
  try {
    if (log && typeof log.entries === 'function') return log.entries();
  } catch {
    /* a renderer query must never crash the host — degrade to empty */
  }
  return [];
}

module.exports = {
  createTransmissionLog,
  hostOf,
  noopTransmissionLog,
  readSnapshot,
  parseTransmissionLog,
  DEFAULT_CAP,
};
