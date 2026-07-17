// Telemetry transport — the pipeline EXIT that POSTs already-redacted,
// schema-valid events to the user-configured receiver endpoint. (WARDEN-461)
//
// This is slice 3 of the warden-telemetry-client-optional-off-by-default roadmap.
// It is where two load-bearing roadmap invariants become ENFORCEABLE ON THE WIRE:
//
//   1. "disabling halts all traffic / off by default / revocable" — send() is a
//      STRICT no-op (fetchImpl is NEVER called) when consent is off/revoked OR no
//      endpoint is configured. The transport is the LAST gate; it cannot be
//      tricked into sending. Off-by-default is real here, not a marketing claim.
//   2. schema-version handshake — every POST carries X-Telemetry-Schema so the
//      receiver (a separate repo) can reject/coordinate on drift without parsing
//      the body.
//
// BEST-EFFORT, NEVER BLOCKS. It mirrors src/llm.js's bounded-retry shape (fetch +
// retry 429/5xx/network-blip, fail-fast on other 4xx, ≤3 attempts) but with one
// deliberate difference: telemetry is fire-and-forget, so on terminal failure it
// SWALLOWS (logs + drops the batch) instead of throwing. llm.js throws because its
// caller needs the result; this transport's caller does not, and a failed
// telemetry send must NEVER propagate up and break or block the host app.
//
// No third-party SaaS — only the configured endpointUrl; there is no hardcoded
// Sentry/PostHog host anywhere in this module (roadmap boundary).
//
// fetch + sleep are INJECTABLE so the test suite is fast, deterministic, and makes
// ZERO real network calls and waits ZERO real milliseconds. fetchImpl defaults to
// the global fetch (Node >= 18); sleepImpl defaults to a real setTimeout sleep.

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Bounded retry cap — mirrors llm.js's `for (attempt < 3)`. A down receiver never
// loops or blocks the app: after MAX_ATTEMPTS transient failures the batch is
// dropped, not retried forever.
const MAX_ATTEMPTS = 3;

// A response status is transient (retryable) when it is a rate-limit (429) or a
// server error (5xx). 4xx (other than 429) is permanent for this payload — the
// body is already schema-valid/redacted upstream, so retrying the identical body
// cannot fix a 400/401/404/422, and we fail fast rather than burn attempts.
function isTransientStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

// Jittered exponential backoff: base doubles per attempt, then +/-25% jitter so a
// fleet of clients retrying a down receiver do not thunder-herd in lockstep. The
// jitter is bounded and non-deterministic by design — tests inject a sleepImpl
// recorder and assert that backoff WAS slept (and how many times), never its exact
// ms, so Math.random here does not make the suite flaky.
function backoffMs(attempt) {
  const base = 200 * 2 ** attempt; // attempt 0 → 200, 1 → 400, 2 → 800 …
  const jitter = base * 0.25 * (Math.random() * 2 - 1); // +/-25% of base
  return Math.max(0, Math.round(base + jitter));
}

const noopLog = () => {};

// Build the wire payload for a batch — the pure, network-free seam. Split out so
// the header/body contract (schema-version handshake + JSON body of the events) is
// unit-testable in isolation, without a fetch mock. send() composes this.
//
//   schemaVersion — the version the events conform to (sent as X-Telemetry-Schema
//                   AND echoed in the body so the version travels with the data
//                   even if a proxy strips the header).
//   events        — the already-redacted, schema-valid event objects to POST.
//   authToken     — optional shared secret (WARDEN-569). When a non-empty string,
//                   sent as `Authorization: Bearer <token>` so a receiver that set
//                   AUTH_TOKEN accepts the batch. Empty/missing → header omitted →
//                   today's behavior (works against an AUTH_TOKEN-unset receiver).
//
// Returns { headers, body }:
//   headers — Content-Type + X-Telemetry-Schema (+ Authorization when a token is
//             supplied). HTTP header names are case-insensitive on the wire; sent
//             lowercase.
//   body    — JSON string of { schemaVersion, events }.
export function makePayload({ schemaVersion, events, authToken }) {
  const headers = {
    'content-type': 'application/json',
    'x-telemetry-schema': String(schemaVersion),
  };
  if (typeof authToken === 'string' && authToken.length > 0) {
    headers['authorization'] = `Bearer ${authToken}`;
  }
  const body = JSON.stringify({ schemaVersion, events });
  return { headers, body };
}

// send() — POST a batch to the configured receiver, consent-gated with bounded
// retry. Never throws (telemetry is best-effort). Returns a result object so a
// caller/tests can observe the outcome without try/catch:
//
//   ok       true iff the POST succeeded (2xx). Everything else is false.
//   dropped  true iff the batch was DROPPED (non-retryable 4xx, or transient
//            failures exhausted MAX_ATTEMPTS). A dropped batch is gone — there is
//            no retry queue. false for the consent/endpoint no-op (the gate was
//            simply closed; nothing was attempted or discarded).
//   revoked  true iff the batch was HALTED mid-loop because LIVE consent flipped
//            off between attempts (or before the first, as defense-in-depth).
//            Distinct from dropped: nothing was discarded — the user revoked, so
//            the transport stopped cleanly with no further fetch or backoff. Only
//            present on this outcome; absent (undefined) elsewhere, so existing
//            deepStrictEqual result assertions are unaffected (WARDEN-585).
//   drifted  true iff the receiver returned 415 (x-telemetry-schema mismatch —
//            the client and receiver disagree on the event-schema version). The
//            batch is STILL dropped (a schema mismatch is permanent for this
//            payload — the identical body + header would be rejected again, so it
//            is not retried), but the distinct flag lets the pipeline circuit-break
//            further sends to this drifted endpoint instead of silently losing
//            every subsequent event to the same version mismatch. Only present on
//            this outcome; absent (undefined) elsewhere (the other non-retryable
//            4xx — 400/401/403/404/422 — stay generic drops), so existing result
//            assertions are unaffected (WARDEN-631).
//   attempts number of fetchImpl calls actually made (0 when gated off or revoked
//            before the first attempt).
//   status   last HTTP status observed (null when gated off or a network error
//            that never produced a response).
//
// Params:
//   events        event objects to POST (already redacted/schema-valid upstream).
//   consent       the resolved consent boolean — true ONLY when the user has
//                 explicitly enabled telemetry (at least base tier) and not
//                 revoked it. The caller (slice 1's consent gate / a later
//                 pipeline-assembly slice) resolves the tiered/revocation state
//                 into this single boolean. Falsy (false/null/undefined) → no-op.
//   endpointUrl   the configured receiver ingest URL. Empty/missing → no-op
//                 (unconfigured = sends nothing). Never a hardcoded SaaS host.
//   schemaVersion the event-schema version for the handshake header.
//   authToken     optional shared secret (WARDEN-569). When a non-empty string,
//                 sent as `Authorization: Bearer <token>` (via makePayload). An
//                 empty/missing token sends no Authorization header — so an unset
//                 token still works against an AUTH_TOKEN-unset (open) receiver.
//   fetchImpl     defaults to global fetch (Node >= 18). Injected in tests.
//   sleepImpl     defaults to a real setTimeout sleep. Injected in tests so
//                 backoff waits zero real time.
//   log           optional (level, message) sink for drop/retry warnings. Defaults
//                 to a no-op; the pipeline-assembly layer injects the app logger.
//   isConsentActive optional LIVE consent resolver checked INSIDE the retry loop.
//                 Defaults to () => true (always active) so existing callers and
//                 tests are unchanged. The pipeline (slice 5) injects a resolver
//                 that re-reads the SAME live consent source its own layer-2 guard
//                 uses, so a revoke that lands between retry attempts — during a
//                 backoff sleep — halts the in-flight batch BEFORE the next
//                 fetchImpl. This closes the last window where a send could POST
//                 after the user turned telemetry off (WARDEN-585). A live
//                 resolver (not a snapshot) is what makes "revocable / halts all
//                 traffic immediately" true even mid-retry.
export async function send({
  events,
  consent,
  endpointUrl,
  schemaVersion,
  authToken = '',
  fetchImpl = globalThis.fetch,
  sleepImpl = realSleep,
  log = noopLog,
  isConsentActive = () => true,
} = {}) {
  // GATE — the last line of defense for the roadmap's core invariant. If consent
  // is off/revoked (falsy) OR no endpoint is configured (empty), send NOTHING: do
  // not even open a connection. fetchImpl is never called. This is what makes
  // "off by default / revocable / halts all traffic" enforceable on the wire.
  // (authToken is NOT a gate: an unset token is valid against an open receiver.)
  if (!consent || !endpointUrl) {
    return { ok: false, dropped: false, attempts: 0, status: null };
  }

  const { headers, body } = makePayload({ schemaVersion, events, authToken });

  let status = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // LIVE consent re-check (WARDEN-585). The entry gate checked consent ONCE
    // with a snapshot; between then and now — or between retry attempts during a
    // backoff sleep — the user may have revoked telemetry. Re-resolve LIVE
    // consent before EVERY fetchImpl (including the first, as defense-in-depth).
    // If it has flipped off, abort cleanly: no further fetch, no further backoff
    // sleep. A revoked send is DISTINCT from a drop (the user chose to stop;
    // nothing was discarded), so it returns revoked:true / dropped:false.
    if (!isConsentActive()) {
      log('info', `telemetry: consent revoked before attempt ${attempt + 1}; halting batch (last status ${status})`);
      return { ok: false, revoked: true, dropped: false, attempts: attempt, status };
    }
    let res;
    try {
      // Destination is EXACTLY endpointUrl — never rewritten, never a hardcoded
      // host. A misconfigured/invalid URL simply throws here → network-error path.
      res = await fetchImpl(endpointUrl, { method: 'POST', headers, body });
    } catch (e) {
      // Network blip (DNS, refused, reset, timeout, bad URL) — transient. Back off
      // and retry unless this was the final attempt; otherwise drop (no throw).
      status = null;
      log('warn', `telemetry: network error (attempt ${attempt + 1}/${MAX_ATTEMPTS}): ${e?.message ?? e}`);
      if (attempt + 1 < MAX_ATTEMPTS) await sleepImpl(backoffMs(attempt));
      continue;
    }

    status = res.status;
    if (res.ok) {
      // 2xx — delivered. The receiver owns the event now; nothing more to do.
      return { ok: true, dropped: false, attempts: attempt + 1, status };
    }
    if (isTransientStatus(res.status)) {
      // 429 / 5xx — transient. Back off and retry unless this was the final attempt.
      log('warn', `telemetry: transient ${res.status} (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
      if (attempt + 1 < MAX_ATTEMPTS) await sleepImpl(backoffMs(attempt));
      continue;
    }

    // 4xx (except 429) — permanent for this payload (wrong shape/schema/auth/route).
    // Retrying the identical body cannot help, so drop the batch now without
    // spending the remaining attempts.
    log('warn', `telemetry: non-retryable ${res.status}; dropping batch`);
    // A 415 is a schema-version mismatch: the receiver rejected X-Telemetry-Schema,
    // so it can NEVER accept this payload as-is. Flag it distinctly (ALONGSIDE the
    // drop — the bad batch is still not re-sent) so the pipeline can circuit-break
    // further sends to this drifted endpoint. Collecting + POSTing events the
    // receiver is guaranteed to reject is pure waste; surfacing the signal turns a
    // silent permanent loss into a stoppable, visible one (WARDEN-631).
    if (res.status === 415) {
      return { ok: false, dropped: true, drifted: true, attempts: attempt + 1, status };
    }
    return { ok: false, dropped: true, attempts: attempt + 1, status };
  }

  // Exhausted all attempts on transient failures — drop the batch. Per the
  // best-effort rule this is logged + swallowed, NEVER thrown to the caller.
  log('warn', `telemetry: exhausted ${MAX_ATTEMPTS} attempts; dropping batch (last status ${status})`);
  return { ok: false, dropped: true, attempts: MAX_ATTEMPTS, status };
}

// Exported for tests / introspection. Not part of the public transport contract.
export const _INTERNALS = { MAX_ATTEMPTS, isTransientStatus, backoffMs };
