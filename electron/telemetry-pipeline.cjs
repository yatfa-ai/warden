'use strict';

// Telemetry PIPELINE assembly — slice 5 of the optional, OFF-by-default telemetry
// client (roadmap WARDEN-446 / design WARDEN-443).
//
// This is the connective tissue that turns slices 1–4 from standalone, pure,
// isolated modules into one functioning `record()` path. A recorded event flows:
//
//   record(event)
//     → resolve effective tier (base / extended / off)
//     → off / unknown / undefined?  HARD NO-OP  (drop, buffer nothing, never send)
//     → redact(payload, { tier })                 [slice 2, SHIPPED — injected]
//     → validate(redacted)                        [schema check — injected]
//     → invalid?  drop pre-send (never send an invalid payload)
//     → send({ events, consent, endpointUrl, schemaVersion, fetchImpl, sleepImpl })
//                                                 [slice 3 contract — injected]
//
// Two load-bearing guarantees become ACTUAL runtime behavior here, by construction:
//   1. Consent-off is a HARD NO-OP at the entry point — nothing buffered, nothing
//      handed to transport. (A second guard at the dispatch boundary means even a
//      direct dispatch() call no-ops when consent is off — defense in depth.)
//   2. Only a REDACTED + SCHEMA-VALIDATED payload reaches transport — redact() →
//      validate() → send() is composed so no un-redacted or schema-invalid event
//      can reach the wire.
//
// Developed as a PURE, FULLY-TESTED module against the contracts, with consent /
// redact / validate / send INJECTED — the same no-hard-merge-dependency pattern
// slices 2, 3, and 4 used. It builds and tests NOW; the live wiring is a small
// follow-up that lands once slice 1 (WARDEN-457) and slice 3 (WARDEN-461) ship.
//
// ===========================================================================
// DECISION A — module home: MAIN-PROCESS CJS (option A1)
// ===========================================================================
// The live call site is electron/main.cjs calling `telemetry.setRecord(...)`. The
// source layer (slice 4) and the transport (slice 3) are main-process / backend
// concerns — slice 3 explicitly concluded "a network-POSTing transport is a
// main/backend concern, not a renderer one." Co-locating the pipeline alongside
// electron/telemetry-source.cjs keeps the source↔sink family together and lets
// main.cjs bind `record()` straight in with no IPC. Slice 1 (WARDEN-457) is NOT
// shipped, so the live wiring is deferred; the module is relocatable (contracts
// are params) so the home can be revisited when slice 1 lands without rework.
//
// ===========================================================================
// DECISION B — canonical schema: thread ONE schema from the SHIPPED source module
// ===========================================================================
// Slice 1's canonical schema module is NOT shipped. Until it lands, the pipeline
// threads the schema from the shipped source module (electron/telemetry-source.cjs):
//   - SCHEMA_VERSION (1), BASE_EVENT_TYPES, and validateBaseEvent are the shared
//     contract that client + receiver + source already agree on.
// The default `validate` IS validateBaseEvent and `schemaVersion` defaults to
// SCHEMA_VERSION — so source, pipeline, and (future) slice 1 all agree on v1.
// When slice 1 ships its canonical module, pass its validator via `validate` and
// its version via `schemaVersion` (the seam); no pipeline code change is needed,
// and telemetry-source.cjs's local copy can then be reconciled to the same source.
//
// ===========================================================================
// WHY redact is INJECTED (not `require()`d directly)
// ===========================================================================
// consent (slice 1), validate (slice 1's canonical schema), and send (slice 3's
// transport) are all UN-SHIPPED, so they are injected and developed against their
// contracts now with fakes. redact (slice 2) IS shipped — but it lives in
// web/src/lib/telemetry/redact.ts (TypeScript/ESM), which a main-process CJS
// module cannot `require()` (no TS→CJS build exists at runtime; vite is a
// devDependency). Injecting redact (a) sidesteps the TS↔CJS boundary, (b) keeps
// the module maximally pure/testable, and (c) is exactly the "relocatable without
// rework" argument. The tests inject the REAL slice-2 redact (loaded via Vite's
// OXC transform), so the composition is proven against the shipped engine, and
// main.cjs will wire whatever CJS form slice 1 reconciles the redactor to.

const {
  SCHEMA_VERSION,
  BASE_EVENT_TYPES,
  validateBaseEvent,
} = require('./telemetry-source.cjs');

// Effective consent tiers (mirrors slice 2's ConsentTier). Anything other than
// 'base' / 'extended' resolves to 'off' (hard no-op) — a missing or corrupt
// consent value can never accidentally send.
const TIERS = Object.freeze({ BASE: 'base', EXTENDED: 'extended', OFF: 'off' });

// Resolve an arbitrary consent value to a known tier. Unknown / undefined → 'off'.
function resolveTier(value) {
  if (value === TIERS.BASE || value === TIERS.EXTENDED) return value;
  return TIERS.OFF;
}

// Safe default consent resolver: OFF. Slice 1's consent pref is injected.
function defaultConsent() {
  return TIERS.OFF;
}

// Safe default transport: sends NOTHING. Out of the box the pipeline cannot phone
// home — a real transport (slice 3) is injected. Returns undefined (no promise).
function noopSend() {}

// Safe default redact: absent-redactor safety. Without the REAL slice-2 redactor
// wired, the pipeline must NEVER pass an un-redacted payload to transport. This
// default returns null for any structured payload, so the default validator
// (validateBaseEvent) rejects it → the event is dropped pre-send. Net effect: with
// no redactor wired, NOTHING is sent — the same off-by-default posture. (The real
// redact is always injected in tests and in live wiring; this is just the safety
// net that upholds "no un-redacted payload, by construction".)
function defaultRedact(payload) {
  return payload === null || payload === undefined ? payload : null;
}

// The pipeline factory. All collaborators are injected; every injection has a
// safe default so an unconfigured pipeline sends nothing. Returns:
//   .record(event)    — the assembled entry point: consent gate (layer 1) →
//                       dispatch (redact → validate → transport).
//   .dispatch(payload)— the airtight processing core: consent gate (layer 2) →
//                       redact → validate → transport. Exposed for direct testing
//                       and as the future buffer-flush entry point; it redacts +
//                       validates the payload itself, so it cannot leak.
//   .effectiveTier()  — the resolved tier (for tests + live introspection)
//   .setConsent(fn) / .setRedact(fn) / .setValidate(fn) / .setSend(fn)
//   .setEndpoint(url) / .setAuthToken(token) / .setSchemaVersion(n)
//                     — hot-swap seams (slice 1/3 wiring + WARDEN-569 auth)
function createTelemetryPipeline(opts) {
  const o = opts || {};
  let consent = typeof o.consent === 'function' ? o.consent : defaultConsent;
  let redact = typeof o.redact === 'function' ? o.redact : defaultRedact;
  let validate = typeof o.validate === 'function' ? o.validate : validateBaseEvent;
  let transportSend = typeof o.send === 'function' ? o.send : noopSend;
  let schemaVersion = typeof o.schemaVersion === 'number' ? o.schemaVersion : SCHEMA_VERSION;
  let endpointUrl = typeof o.endpointUrl === 'string' && o.endpointUrl ? o.endpointUrl : null;
  // Optional shared-secret auth token (WARDEN-569). Threaded through to the
  // transport, which sends it as `Authorization: Bearer <token>` when non-empty.
  // null/empty = no header = today's behavior (works against an open receiver).
  // NOT a consent/endpoint gate — an unset token is a valid posture.
  let authToken = typeof o.authToken === 'string' && o.authToken ? o.authToken : null;
  const fetchImpl = o.fetchImpl; // optional — threaded through to the transport
  const sleepImpl = o.sleepImpl; // optional — threaded through to the transport

  // Resolve the current effective tier. A throwing consent resolver (slice 1 bug,
  // missing pref, etc.) degrades to OFF — telemetry must never crash the host.
  function effectiveTier() {
    try {
      return resolveTier(consent());
    } catch {
      return TIERS.OFF;
    }
  }

  // The airtight processing core: resolve the tier → redact → validate → transport,
  // with its OWN consent guard. This redacts and validates the payload ITSELF (it
  // does not trust the caller to have done so), so no matter how it is reached —
  // record() or a future durable-queue flush — only a redacted + schema-validated
  // payload can ever reach transport, and only when the effective tier is not OFF.
  // The consent guard here is the SECOND layer of "off = nothing"; record() is the
  // first. Both layers re-resolve LIVE consent, so a consent revoked between the
  // entry gate and dispatch (or after a buffer held an event) still prevents a
  // send. Transport errors (sync throw OR async rejection) are swallowed: a
  // telemetry failure must never throw the instrumented process into a worse state
  // (mirrors telemetry-source's emit()).
  function dispatch(payload) {
    const tier = effectiveTier();
    if (tier === TIERS.OFF) return; // layer 2 consent guard (defense in depth)

    let redacted;
    try {
      redacted = redact(payload, { tier });
    } catch {
      return; // a throwing redactor degrades to a dropped event, not a crash
    }
    let ok;
    try {
      ok = validate(redacted);
    } catch {
      return; // a throwing validator degrades to a dropped event, not a crash
    }
    if (!ok) return; // schema-invalid → drop pre-send (never send an invalid payload)

    try {
      const result = transportSend({
        events: [redacted],
        consent: tier,
        endpointUrl,
        schemaVersion,
        authToken,
        fetchImpl,
        sleepImpl,
      });
      if (result && typeof result.then === 'function') {
        result.then(() => {}, () => {}); // swallow async transport rejections
      }
    } catch {
      /* telemetry must never crash the host */
    }
  }

  // The assembled pipeline entry point.
  function record(event) {
    // Layer 1 — resolve the effective tier. off / unknown / undefined → HARD
    // NO-OP: buffer nothing (there is no buffer — a durable queue is a later,
    // out-of-scope slice) and never hand anything to dispatch(). dispatch() guards
    // again (layer 2), so the two layers are independent.
    if (effectiveTier() === TIERS.OFF) return;
    dispatch(event);
  }

  return {
    record,
    dispatch,
    effectiveTier,
    setConsent(fn) {
      if (typeof fn === 'function') consent = fn;
    },
    setRedact(fn) {
      if (typeof fn === 'function') redact = fn;
    },
    setValidate(fn) {
      if (typeof fn === 'function') validate = fn;
    },
    setSend(fn) {
      if (typeof fn === 'function') transportSend = fn;
    },
    setEndpoint(url) {
      endpointUrl = typeof url === 'string' && url ? url : null;
    },
    setAuthToken(token) {
      authToken = typeof token === 'string' && token ? token : null;
    },
    setSchemaVersion(v) {
      if (typeof v === 'number') schemaVersion = v;
    },
  };
}

module.exports = {
  TIERS,
  SCHEMA_VERSION,
  BASE_EVENT_TYPES,
  resolveTier,
  createTelemetryPipeline,
};
