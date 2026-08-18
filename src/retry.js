// Shared bounded-retry primitives (WARDEN-1067) — the predicate, the backoff,
// the cap, and the two injectable defaults that every outbound-POST transport in
// Warden needs. Extracted from src/telemetry-send.js (WARDEN-461, the canonical
// jittered form) and src/notify.js (WARDEN-555), which had defined these five
// byte-identically; notify.js carried four comments whose only content was
// "mirrors telemetry-send". This module is that mirror's single subject.
//
// SCOPE — the primitives, never the loop. What is shared between the telemetry
// and webhook transports is the *policy* (how many attempts, which statuses are
// worth retrying, how long to wait between them). The retry LOOPS themselves are
// NOT duplicates and deliberately stay in their own modules: telemetry-send owns
// a live consent re-check before every send (WARDEN-585), a 415 schema-drift
// circuit-break (WARDEN-631), and a `replayable` exhaustion result (WARDEN-671),
// none of which notify.js has or should acquire. Folding the loops together
// would be a regression, not a consolidation.
//
// NOT a home for src/llm.js's retry. That third copy is genuinely *drifted* —
// linear (unjittered) backoff, two different bases in one loop, and a retry
// predicate missing the 5xx upper bound. Adopting these primitives there changes
// real timing and real retry behavior; that is a behavior change and belongs to
// its own ticket, not to this relocation.
//
// Kept dependency-free (ZERO imports) so it is a true leaf — the same shape as
// src/chatMeta.js, src/budget.js, src/health.js and src/gitStatus.js — and so no
// import cycle is structurally possible among its consumers.

// Default sleep for the injectable `sleepImpl` seam. Transports take sleep as a
// parameter so their test suites wait ZERO real milliseconds; this is only the
// production default.
export const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Bounded retry cap. A down or slow destination never loops or blocks the host
// app: after MAX_ATTEMPTS transient failures the payload is dropped, not retried
// forever.
export const MAX_ATTEMPTS = 3;

// A response status is transient (retryable) when it is a rate-limit (429) or a
// server error (5xx). 4xx (other than 429) is permanent for these payloads — the
// body is fixed by the time it reaches the transport (already schema-valid and
// redacted for telemetry; a fixed alert for the webhook), so retrying the
// identical body cannot fix a 400/401/404/410/422, and we fail fast rather than
// burn attempts.
export function isTransientStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

// Jittered exponential backoff: base doubles per attempt, then +/-25% jitter so a
// fleet of clients retrying a down receiver do not thunder-herd in lockstep. The
// jitter is bounded and non-deterministic by design — tests inject a sleepImpl
// recorder and assert that backoff WAS slept (and how many times), never its exact
// ms, so Math.random here does not make the suite flaky.
export function backoffMs(attempt) {
  const base = 200 * 2 ** attempt; // attempt 0 → 200, 1 → 400, 2 → 800 …
  const jitter = base * 0.25 * (Math.random() * 2 - 1); // +/-25% of base
  return Math.max(0, Math.round(base + jitter));
}

// Default for the injectable `log` seam — transports are fire-and-forget and must
// stay silent unless the caller supplies a logger.
export const noopLog = () => {};
