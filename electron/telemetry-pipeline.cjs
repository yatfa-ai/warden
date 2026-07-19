'use strict';

// Telemetry PIPELINE assembly — slice 5 of the optional, OFF-by-default telemetry
// client (roadmap WARDEN-446 / design WARDEN-443).
//
// This is the connective tissue that turns slices 1–4 from standalone, pure,
// isolated modules into one functioning `record()` path. A recorded event flows:
//
//   record(event)
//     → resolve effective tier (base / extended / off)
//     → off / unknown / undefined?  HARD NO-OP  (send nothing; also CLEAR the replay
//       buffer so a buffered event never survives an opt-out — WARDEN-671)
//     → flush the in-memory replay buffer first if non-empty (re-dispatch prior
//       transient-exhausted drops through dispatch(), in arrival order — WARDEN-671)
//     → redact(payload, { tier })                 [slice 2, SHIPPED — injected]
//     → validate(redacted)                        [schema check — injected]
//     → invalid?  drop pre-send (never send an invalid payload)
//     → send({ events, consent, endpointUrl, schemaVersion, fetchImpl, sleepImpl })
//                                                 [slice 3 contract — injected]
//     → transient-exhausted drop (replayable)? retain in the bounded replay buffer
//       and retry on the next dispatch opportunity (WARDEN-671); drifted / non-
//       retryable drops are permanent and never retained.
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
const {
  hostOf,
  noopTransmissionLog,
} = require('./telemetry-transmission-log.cjs');

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

// Default cap for the in-memory replay buffer (WARDEN-671). Bounds memory over a
// transient receiver outage: large enough to ride out a multi-event blip (a burst
// of crash/error signals during a receiver restart, wifi drop, or sleep/wake), small
// enough that a persistently-down receiver cannot grow memory unbounded (the
// drop-oldest ring rotates). Tunable per-pipeline via `replayBufferCap` (tests
// inject a small cap; main.cjs may override) — mirrors transmissionLog's cap seam.
const DEFAULT_REPLAY_BUFFER_CAP = 64;

// WARDEN-808 — sustained delivery-failure detector. A PURE read of the
// transmission-log ring: are the most recent `threshold` recorded outcomes ALL
// 'dropped'? This is the non-415 twin of the WARDEN-631 schema-drift signal.
// Today the runtime delivery surface arms a status ONLY on a 415 (drifted);
// every OTHER sustained failure (receiver down, persistent 5xx, broken network
// — all recorded as outcome:'dropped') is invisible at the always-visible status
// layer. This closes that one-sided trust bar.
//
// GUARDRAILS (do not flap, do not false-alarm):
//   • SUSTAINED only — arms when the most recent `threshold` outcomes are ALL
//     'dropped'. A single transient drop (threshold unreachable) does not arm,
//     so a momentary blip never shows a failure banner.
//   • Self-heals the instant any 'ok' enters the window (an ok breaks the
//     all-drops run) — unlike 415, which needs a manual Test-connection because
//     a 415 cannot self-heal.
//   • Fewer than `threshold` entries (incl. an EMPTY ring) → NOT armed, so a
//     freshly-started receiver with no traffic never false-alarms.
//   • A non-'dropped' outcome (an 'ok', or a malformed/null seeded entry) breaks
//     the run — conservative: never arm on garbage.
//
// CRITICAL DISTINCTION from the 415 breaker: this is PURE OBSERVABILITY. It must
// NEVER gate / pause sending. 415 is permanent (the receiver cannot accept this
// schema), so `drifted` correctly stops sending. A delivery failure is POTENTIALLY
// TRANSIENT (receiver restarting, wifi blip), so the client KEEPS sending — the
// next attempt may succeed and self-heal the status. This function decides only
// what the status banner SHOWS; dispatch() never reads it. (Grep guardrail: the
// new status introduces NO send-gating `return` in dispatch.)
function isDeliveryFailing(entries, threshold) {
  if (!Array.isArray(entries) || entries.length < threshold) return false;
  // entries() returns oldest → newest; inspect only the most recent `threshold`.
  const start = entries.length - threshold;
  for (let i = start; i < entries.length; i++) {
    if (!entries[i] || entries[i].outcome !== 'dropped') return false;
  }
  return true;
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
  // Optional local transmission log of ACTUAL send outcomes (WARDEN-583) —
  // verifiability's third leg. Default is the frozen no-op recorder, so an
  // unconfigured pipeline records nothing and behaves EXACTLY as before this
  // slice. A real bounded ring is injected by main.cjs so production captures
  // what actually landed on the wire (ok | dropped). It is a pure metadata-only
  // consumer of the transport result + the endpoint host; see recordOutcome below.
  const transmissionLog =
    o.transmissionLog && typeof o.transmissionLog.record === 'function'
      ? o.transmissionLog
      : noopTransmissionLog;

  // WARDEN-671 — bounded, session-scoped, IN-MEMORY replay buffer for transiently-
  // dropped sends. Closes the last silent-signal-loss site: an event that passed
  // every gate (consent → redact → validate) and reached the wire used to be DROPPED
  // FOREVER if the receiver was transiently unreachable for longer than the
  // transport's bounded-retry window (~1.4s of backoff). Now, when the transport
  // returns a TRANSIENT-EXHAUSTED drop (flagged replayable:true — see
  // src/telemetry-send.js), the redacted+validated payload is retained here and
  // replayed through dispatch() on the next dispatch opportunity.
  //
  // TRUST MODEL (consistency with WARDEN-443):
  //   1. IN-MEMORY ONLY — deliberately NOT persisted to disk. A durable on-disk
  //      queue is a later, trust-heavier slice (lingering telemetry files). The
  //      disk/privacy posture is unchanged: the raw payload was already in memory
  //      en route to fetch; this buffer holds that same reference, never writes it.
  //   2. BOUNDED ring, drop-oldest — hard cap so a long outage cannot grow memory
  //      unbounded. Mirrors telemetry-transmission-log.cjs's ring discipline.
  //   3. The flush routes through dispatch() — which re-resolves LIVE consent
  //      (layer-2 guard), re-checks the drift circuit-breaker, AND re-runs redact →
  //      validate. So a replayed payload CANNOT send when off/drifted and CANNOT
  //      leak un-redacted or reach the wire schema-invalid. Buffering the RAW
  //      payload (not a pre-redacted snapshot) is what makes re-validation free: a
  //      schema that drifted while the event sat in the buffer is re-checked on flush.
  //   4. NEVER buffers drifted (415) or non-retryable 4xx drops — only the
  //      transient-exhausted (replayable) drop is recoverable (replaying the others
  //      is futile and would fight the drift breaker / waste the retry budget).
  //   5. CLEARS the instant the effective tier flips to off — no event lingers after
  //      the user opts out (upholds "revocable"). record()'s layer-1 guard is the
  //      clear site.
  const replayBufferCap =
    Number.isInteger(o.replayBufferCap) && o.replayBufferCap > 0
      ? o.replayBufferCap
      : DEFAULT_REPLAY_BUFFER_CAP;
  const pendingRing = [];

  // WARDEN-808 — sustained delivery-failure detection window. The delivery-failing
  // status arms only when the most recent N recorded outcomes are ALL 'dropped'
  // (N ≥ 3 by default), so a single transient drop never flaps the banner. Tunable
  // per-pipeline so tests can inject a small window; main.cjs uses the default.
  const deliveryFailingThreshold =
    Number.isInteger(o.deliveryFailingThreshold) && o.deliveryFailingThreshold > 0
      ? o.deliveryFailingThreshold
      : 3;

  // WARDEN-631 — per-endpoint schema-drift circuit-breaker. Session-scoped,
  // in-memory, NEVER persisted (mirrors the transmission log's discipline): once
  // the current endpoint has returned a 415 (x-telemetry-schema mismatch) the
  // receiver CANNOT accept the current schema, so redact → validate → POST is
  // pure waste. `drifted` describes the CURRENT endpoint; it arms on a drifted
  // transport outcome and clears on anything that could resolve the mismatch —
  // an endpoint change (a different receiver may match), a schema-version change
  // (the client re-versioned), or a subsequent successful send (the endpoint is
  // confirmed matched again). See settle() + setEndpoint / setSchemaVersion.
  // `onRuntimeStatus` is the optional main→renderer bridge tap (Part 3): invoked
  // ONLY when drift arms or clears, so the renderer can surface the live state.
  // Default no-op — an unconfigured pipeline never reaches out.
  let drifted = false;
  const onRuntimeStatus = typeof o.onRuntimeStatus === 'function' ? o.onRuntimeStatus : () => {};

  // Push the current runtime status to the main→renderer tap. Called ONLY on a
  // real composite state change (every call site guards `if (drifted !== prev ||
  // delivery !== prev)`), so the bridge never sees a no-op transition and never
  // spams the renderer. `deliveryFailing` is derived FRESH from the ring here (a
  // pure read — it is never stored as independent state), so the payload always
  // reflects the live ring, including history seeded from disk on restart
  // (WARDEN-782). Wrapped so a throwing tap (a main-process wiring bug) can never
  // crash a send path.
  function emitRuntimeStatus() {
    try {
      onRuntimeStatus({
        drifted,
        deliveryFailing: isDeliveryFailing(transmissionLog.entries(), deliveryFailingThreshold),
      });
    } catch {
      /* a status tap must never break telemetry */
    }
  }

  // Resolve the current effective tier. A throwing consent resolver (slice 1 bug,
  // missing pref, etc.) degrades to OFF — telemetry must never crash the host.
  function effectiveTier() {
    try {
      return resolveTier(consent());
    } catch {
      return TIERS.OFF;
    }
  }

  // Record one ACTUAL-outcome entry when the transport returns a real result —
  // verifiability's third leg (WARDEN-583). Instead of swallowing the transport
  // outcome, a metadata-only entry is appended to the injected transmissionLog.
  // METADATA ONLY: endpointHost (hostname[:port], NEVER the full URL with path/
  // query), schemaVersion, the event count, and the transport's outcome/attempts/
  // status. Never the payload, a redacted field, or a chat/session identifier.
  // The timestamp is owned by the log (its injected clock), so this module never
  // touches Date.now().
  //
  // Only a REAL outcome is recorded:
  //   ok:true      → outcome 'ok'
  //   dropped:true → outcome 'dropped'
  //   anything else (the transport's gate no-op {ok:false,dropped:false}, a non-
  //   conforming/absent result, the default no-op transport) → NOTHING recorded.
  // "Consent off / unconfigured" therefore manifests as an ABSENCE of entries —
  // the observable proof that disabling halts all traffic — not a recorded
  // 'gated-off' outcome. (The dispatch consent guard below returns before
  // transportSend is ever called, so the real path never reaches here with the
  // gate closed; this guard just keeps the contract honest against the transport's
  // own defense-in-depth gate and against test fakes that return {ok:false,
  // dropped:false}.)
  function recordOutcome(res, eventCount) {
    if (!res || typeof res !== 'object') return;
    const ok = res.ok === true;
    const dropped = res.dropped === true;
    if (!ok && !dropped) return; // gate no-op / ambiguous → not a real send
    transmissionLog.record({
      endpointHost: hostOf(endpointUrl),
      schemaVersion,
      eventCount,
      outcome: ok ? 'ok' : 'dropped',
      attempts: typeof res.attempts === 'number' ? res.attempts : 0,
      status: res.status === null || typeof res.status === 'number' ? res.status : null,
    });
  }

  // The airtight processing core: resolve the tier → redact → validate → transport,
  // with its OWN consent guard. This redacts and validates the payload ITSELF (it
  // does not trust the caller to have done so), so no matter how it is reached —
  // record(), or the replay-buffer flush (WARDEN-671) — only a redacted + schema-
  // validated payload can ever reach transport, and only when the effective tier is
  // not OFF. The consent guard here is the SECOND layer of "off = nothing"; record()
  // is the first. Both layers re-resolve LIVE consent, so a consent revoked between the
  // entry gate and dispatch (or after a buffer held an event) still prevents a
  // send. Transport errors (sync throw OR async rejection) are swallowed: a
  // telemetry failure must never throw the instrumented process into a worse state
  // (mirrors telemetry-source's emit()).
  function dispatch(payload) {
    const tier = effectiveTier();
    if (tier === TIERS.OFF) return; // layer 2 consent guard (defense in depth)

    // WARDEN-631 — circuit-breaker. If the current endpoint already rejected the
    // current schema (415), do NOT redact/validate/POST: the receiver cannot
    // accept this schema, so collecting + sending is pure waste. Like the
    // consent-off guard above this records nothing and sends nothing — the
    // endpoint is "drifted", which is a stop condition consistent with "off halts
    // all traffic", relaxing nothing (a schema-MATCHED receiver never 415s, so
    // legitimate traffic is unaffected). The flag clears on endpoint/schema
    // change or a later successful send (see settle + setEndpoint/setSchemaVersion).
    if (drifted) return;

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
      const events = [redacted];
      // Capture the endpoint this send targets at DISPATCH time. The result may
      // resolve AFTER the user changed endpointUrl (a slow receiver that 415s, or
      // an in-flight send when the endpoint is re-pointed); settle must not then
      // arm/clear drift for the NEW endpoint based on the OLD one's outcome.
      const targetEndpoint = endpointUrl;
      const result = transportSend({
        events,
        consent: tier,
        endpointUrl,
        schemaVersion,
        authToken,
        fetchImpl,
        sleepImpl,
        // LIVE consent for the transport's in-loop re-check (WARDEN-585). Re-resolves
        // the SAME source this layer-2 guard uses — effectiveTier(), which re-reads
        // consent() and degrades to OFF on a throwing resolver — so a revoke that
        // lands during the transport's bounded-retry backoff halts the in-flight
        // batch before its next attempt. "Halts all traffic immediately" now holds
        // end-to-end (toggle → dispatch → WIRE), not just up to this boundary. The
        // snapshot `tier` above stays as the transport's entry gate; this callback
        // is the mid-loop re-check between attempts.
        isConsentActive: () => effectiveTier() !== TIERS.OFF,
      });
      // Route the transport outcome into the transmission log instead of
      // swallowing it (WARDEN-583 — verifiability's third leg), arm/clear the
      // drift circuit-breaker from the SAME outcome (WARDEN-631), AND re-derive the
      // sustained delivery-failing status from the ring (WARDEN-808). All three are
      // pure consumers of the SAME `res` + the ring; a single composite emit fires
      // when the runtime status actually changed. The transport never throws here
      // (this try wraps a synchronous call site) and the REAL transport never
      // rejects (it resolves with dropped:true on failure), so every real attempt
      // reaches settle. A rejection records/breaks nothing: the real transport does
      // not produce one, and the absence of an entry for a contract-violating
      // failure is acceptable (the absence is itself a signal, never a crash).
      const settle = (res) => {
        // WARDEN-808 — snapshot the delivery-failing derivation BEFORE the new
        // outcome is recorded, so the composite emit-on-change check below detects
        // a real transition — including from a ring seeded from disk on restart
        // (WARDEN-782): prev reflects the seeded state, so the first fresh 'ok'
        // after a restart-into-a-broken-receiver correctly emits a clear. Pure read.
        const prevDeliveryFailing = isDeliveryFailing(
          transmissionLog.entries(),
          deliveryFailingThreshold,
        );
        recordOutcome(res, events.length);
        // WARDEN-671 — retain the payload on a TRANSIENT-EXHAUSTED drop (the
        // transport flags these replayable:true) for replay on the next dispatch
        // opportunity. Checked BEFORE the drift early-returns and independent of the
        // stale-endpoint guard: staleness only governs DRIFT arming/clearing, not
        // whether a recoverable event is worth keeping. The raw `payload` is held
        // (not a pre-redacted snapshot) precisely so the flush re-runs redact →
        // validate against the LIVE schema — a schema that drifted while the event
        // sat in the buffer is re-checked, and a revoke that armed is honored (the
        // flush's dispatch re-resolves live consent). Bounded drop-oldest ring,
        // mirroring telemetry-transmission-log.cjs. A drifted (415) or non-retryable
        // 4xx drop never carries replayable, so it is never retained (replaying it
        // is futile / fights the drift breaker). IN-MEMORY ONLY — never persisted.
        if (res && typeof res === 'object' && res.replayable === true) {
          pendingRing.push(payload);
          if (pendingRing.length > replayBufferCap) pendingRing.shift(); // drop-oldest
        }
        // WARDEN-808 — re-derive delivery-failing AFTER the new outcome landed in
        // the ring. deliveryFailing is NEVER stored as state between outcomes — it
        // is a pure function of the ring — so this is the authoritative post-outcome
        // value (and the same value emitRuntimeStatus() pushes, derived fresh).
        const nextDeliveryFailing = isDeliveryFailing(
          transmissionLog.entries(),
          deliveryFailingThreshold,
        );
        // WARDEN-631 — drift update. A 415 arms the per-endpoint breaker (stop
        // futile sends); a 2xx success clears it (the endpoint is confirmed schema-
        // matched again). Only a real, recognized, FRESH outcome flips the flag —
        // the gate no-op, an ambiguous/absent result, a non-drift drop, and a
        // stale-endpoint result (the endpoint changed mid-flight) all leave it
        // untouched, so a transient/validator drop or a re-pointed receiver never
        // wedges a reachable receiver. Semantics UNCHANGED from WARDEN-631; only
        // the emit is now composite (one push when EITHER drifted OR deliveryFailing
        // changed — never one per flag, never a no-op re-emit).
        let nextDrifted = drifted;
        if (res && typeof res === 'object' && endpointUrl === targetEndpoint) {
          if (res.drifted === true) nextDrifted = true;
          else if (res.ok === true) nextDrifted = false;
        }
        if (nextDrifted !== drifted || nextDeliveryFailing !== prevDeliveryFailing) {
          drifted = nextDrifted;
          emitRuntimeStatus(); // pushes { drifted, deliveryFailing } — delivery derived fresh
        }
      };
      if (result && typeof result.then === 'function') {
        result.then(settle, () => {});
      } else if (result && typeof result === 'object') {
        settle(result); // a synchronous result-bearing transport
      }
    } catch {
      /* telemetry must never crash the host */
    }
  }

  // The assembled pipeline entry point.
  function record(event) {
    // Layer 1 — resolve the effective tier. off / unknown / undefined → HARD
    // NO-OP: never hand anything to dispatch() (dispatch() guards again — layer 2 —
    // so the two layers are independent). WARDEN-671: off also CLEARS the replay
    // buffer so no event lingers after the user opts out (upholds "revocable").
    // Events recorded while off were never dispatched, so the ring is normally empty
    // here, but a revoke that lands AFTER a replayable drop filled the ring must not
    // let a buffered event survive the opt-out — clear it at the natural clear site.
    const tier = effectiveTier();
    if (tier === TIERS.OFF) {
      pendingRing.length = 0;
      return;
    }
    // WARDEN-671 — flush the replay buffer before the new event, in arrival order.
    // A buffered event was a transient-exhausted drop; the next record() is the
    // "next dispatch opportunity" to retry it. Only flush when dispatch can actually
    // reach the transport — i.e. NOT drifted: a drifted dispatch short-circuits
    // BEFORE transportSend, so settle never runs and a drained event would be LOST
    // (not re-buffered). Gating on !drifted keeps the ring intact through a drift
    // outage; it drains once drift clears (an endpoint/schema change or a later
    // success). Fire-and-forget in arrival order (Q3): each dispatch() kicks off its
    // own async transport, matching the existing model. A re-drop (receiver STILL
    // down) re-buffers via settle; the bounded ring self-limits the churn (Q2 — a
    // persistently-down receiver just rotates the ring, which is acceptable and
    // preserves the "retain recent transiently-dropped sends" intent).
    if (pendingRing.length > 0 && !drifted) {
      const pending = pendingRing.splice(0); // drain (snapshot + clear); re-drops re-buffer
      for (const p of pending) dispatch(p);
    }
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
      const next = typeof url === 'string' && url ? url : null;
      if (next === endpointUrl) return;
      endpointUrl = next;
      // WARDEN-631 — a real endpoint change may resolve drift: the new destination
      // is a different receiver that may accept the current schema. applyTelemetry-
      // Config calls this on EVERY pref update (incl. a tier toggle), so the
      // change-guard above is what prevents a same-endpoint toggle from clearing
      // the breaker and re-arming a futile send.
      if (drifted) {
        drifted = false;
        emitRuntimeStatus();
      }
    },
    setAuthToken(token) {
      authToken = typeof token === 'string' && token ? token : null;
    },
    setSchemaVersion(v) {
      if (typeof v !== 'number' || v === schemaVersion) return;
      schemaVersion = v;
      // WARDEN-631 — a schema-version change may resolve drift: the client re-
      // versioned, so the next send re-probes rather than staying broken against
      // the version that mismatched. Change-guarded so a redundant set is a no-op.
      if (drifted) {
        drifted = false;
        emitRuntimeStatus();
      }
    },
    // WARDEN-631 / WARDEN-808 — the runtime status, for the main→renderer bridge
    // (Part 3) to pull on Settings mount (a push fires on every change, but the
    // renderer that opens AFTER a status armed needs the current value too).
    // Read-only. `deliveryFailing` is derived FRESH from the ring here — so the
    // pull path reflects history seeded from disk on restart (WARDEN-782) even
    // before any push has fired (a restart into a still-broken receiver shows the
    // armed status immediately; the next 'ok' self-heals it). It is never stored
    // as state — parity with the "derive, don't store" discipline.
    getRuntimeStatus() {
      return {
        drifted,
        deliveryFailing: isDeliveryFailing(transmissionLog.entries(), deliveryFailingThreshold),
      };
    },
    // WARDEN-631 — user-driven drift clear. Invoked when a "Test connection" probe
    // confirms the receiver is schema-matched again (the optional reset from the
    // ticket). A receiver fixed at the SAME url cannot otherwise clear the change-
    // guarded breaker in-session (setEndpoint no-ops on an unchanged url), so
    // without this the user is wedged until an endpoint/schema change or a restart.
    // Emits the transition so the renderer's warning clears. No-op if not armed.
    clearRuntimeDrift() {
      if (drifted) {
        drifted = false;
        emitRuntimeStatus();
      }
    },
  };
}

module.exports = {
  TIERS,
  SCHEMA_VERSION,
  BASE_EVENT_TYPES,
  resolveTier,
  createTelemetryPipeline,
  isDeliveryFailing,
};
