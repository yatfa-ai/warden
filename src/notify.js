// Webhook "push" delivery channel (WARDEN-555) — the transport that POSTs a
// critical agent alert to a USER-CONFIGURED URL (ntfy/Discord/Slack/Telegram/
// Home Assistant) so a human AWAY from the machine still gets pinged the moment
// an agent newly needs attention or a token budget breaches — even with the
// Warden window closed to tray.
//
// The other delivery channels are an in-app toast and an OS desktop
// notification (web/src/lib/desktopAlerts.ts), both of which require Warden's
// live window on a machine someone is sitting at. This is the channel that
// reaches BEYOND the desktop. It reuses the outbound-POST transport shape
// Warden already ships for telemetry (src/telemetry-send.js) — same bounded-
// retry, jittered-backoff, fire-and-forget contract, same injectable fetch/sleep
// for a deterministic test suite, and the same STRICT no-op gate.
//
// OFF BY DEFAULT; SENDS NOTHING until the user configures a URL and enables it.
// There is no yatfa SaaS — the payload goes ONLY to the user's own URL, exactly
// like the LLM API and telemetry endpoints. No hardcoded host anywhere.
//
// This module owns THREE things, each unit-testable in isolation:
//   1. makeWebhookPayload — the pure wire-payload seam ({ headers, body }).
//   2. sendWebhook        — the network transport (injectable fetch/sleep).
//   3. dispatchWebhook    — the config-reading wrapper the server hooks call.
// Plus the pure formatting helpers for the one POSITIVE signal that still
// routes through it (doneSeverity / doneReason / doneEndedIdentity).
//
// WARDEN-1274: this module used to own two PANE-TEXT transition diffs as well —
// diffAttentionTransitions (newly stuck/erroring/waiting/blocked) and
// diffDoneTransitions (active→idle "finished"). Both were driven by the fixed
// nine-regex pane classifier, so both GUESSED: "0 errors" in a passing test
// summary read as an error, and a crash returning to a prompt read as a finish.
// They are retired along with the 60s server-side sweep that called them. The
// two webhook routings that remain — `agent_ended` (a container that genuinely
// went away) and a token-budget breach (a counted number) — rest on observed
// facts, not inferences, which is exactly why they survive.

// Bounded-retry policy (cap, transient-status predicate, jittered backoff) and
// the two injectable defaults live in the shared src/retry.js leaf — the same
// primitives src/telemetry-send.js uses. Only the RETRY LOOP below is local to
// this module; it deliberately does NOT share telemetry-send's consent re-check,
// schema-drift circuit-break, or replayable exhaustion result.
import { realSleep, MAX_ATTEMPTS, isTransientStatus, backoffMs, noopLog } from './retry.js';

// The result returned when the gate is closed (disabled or no URL). `dropped` is
// deliberately false: nothing was attempted OR discarded, the gate was simply
// closed — mirroring telemetry-send's consent/endpoint no-op contract so callers
// can distinguish "never tried" from "tried and gave up".
const NOOP_RESULT = Object.freeze({ ok: false, dropped: false, attempts: 0, status: null });

// Build the webhook wire payload — the pure, network-free seam. Split out so the
// body contract ({ app, event, severity, agent, reason, ts }) is unit-testable
// in isolation, without a fetch mock. sendWebhook composes this.
//
//   event    — a machine-readable event id, e.g. 'done', 'budget-breached',
//              'test'.
//   severity — 'critical' | 'warning' | 'info' (drives the receiver's tone if it
//              cares; ntfy maps priority, Discord/Slack ignore it).
//   agent    — a human-readable agent identity (name or key), or null for a
//              fleet-wide event. NEVER transcript content.
//   reason   — the one-line human-readable "why" the user already sees in their
//              desktop toast (the bucket label + triggering signal).
//   ts       — epoch ms. Defaults to Date.now() so a real caller can omit it;
//              tests pass a fixed value for determinism.
//
// Returns { headers, body }:
//   headers — Content-Type only (HTTP header names are case-insensitive on the
//             wire; sent lowercase). The signing headers are added by sendWebhook
//             where the secret is known, not here (the payload is secret-free).
//   body    — JSON string of { app, event, severity, agent, reason, ts }.
export function makeWebhookPayload({ event, reason, agent, severity, ts } = {}) {
  const headers = { 'content-type': 'application/json' };
  const body = JSON.stringify({
    app: 'warden',
    event: String(event ?? ''),
    severity: String(severity ?? ''),
    agent: agent == null ? null : String(agent),
    reason: reason == null ? null : String(reason),
    ts: typeof ts === 'number' ? ts : Date.now(),
  });
  return { headers, body };
}

// sendWebhook — POST a single alert to the configured webhook URL, gated with
// bounded retry. Never throws (push delivery is best-effort, exactly like
// telemetry-send). Returns a result object so a caller/tests can observe the
// outcome without try/catch:
//
//   ok       true iff the POST succeeded (2xx). Everything else is false.
//   dropped  true iff the alert was DROPPED (non-retryable 4xx, or transient
//            failures exhausted MAX_ATTEMPTS). false for the gate no-op.
//   attempts number of fetchImpl calls actually made (0 when gated off).
//   status   last HTTP status observed (null when gated off or a network error
//            that never produced a response).
//
// Params:
//   event/severity/agent/reason/ts — the alert fields (see makeWebhookPayload).
//   url        the configured webhook URL. Empty/missing + enabled false → no-op
//              (unconfigured/disabled = sends nothing). Never a hardcoded host.
//   secret     optional shared secret. When non-empty it is sent BOTH as
//              `authorization: Bearer <secret>` (ntfy/Home-Assistant style) AND
//              `x-webhook-secret: <secret>` (generic verifier style), so one
//              config works across receivers.
//   enabled    the resolved master-switch boolean. Falsy → no-op. This is the
//              LAST gate that makes "off by default" enforceable on the wire.
//   fetchImpl  defaults to global fetch (Node >= 18). Injected in tests.
//   sleepImpl  defaults to a real setTimeout sleep. Injected in tests so backoff
//              waits zero real time.
//   log        optional (level, message) sink for drop/retry warnings.
export async function sendWebhook({
  event,
  reason,
  agent,
  severity,
  ts,
  url,
  secret,
  enabled,
  fetchImpl = globalThis.fetch,
  sleepImpl = realSleep,
  log = noopLog,
} = {}) {
  // GATE — the last line of defense for the off-by-default invariant. If the
  // master switch is off (enabled falsy) OR no URL is configured (empty), send
  // NOTHING: do not even open a connection. fetchImpl is never called.
  if (!enabled || !url) return { ...NOOP_RESULT };

  const { headers, body } = makeWebhookPayload({ event, reason, agent, severity, ts });

  // Signing headers — added only when a secret is configured. Sent under two
  // names so the same secret authenticates against ntfy/Home-Assistant (which
  // read Authorization) and generic verifiers (which read X-Webhook-Secret).
  if (secret) {
    headers.authorization = `Bearer ${secret}`;
    headers['x-webhook-secret'] = String(secret);
  }

  let status = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      // Destination is EXACTLY url — never rewritten, never a hardcoded host. A
      // misconfigured/invalid URL simply throws here → network-error path.
      res = await fetchImpl(url, { method: 'POST', headers, body });
    } catch (e) {
      // Network blip (DNS, refused, reset, timeout, bad URL) — transient. Back
      // off and retry unless this was the final attempt; otherwise drop.
      status = null;
      log('warn', `webhook: network error (attempt ${attempt + 1}/${MAX_ATTEMPTS}): ${e?.message ?? e}`);
      if (attempt + 1 < MAX_ATTEMPTS) await sleepImpl(backoffMs(attempt));
      continue;
    }

    status = res.status;
    if (res.ok) {
      // 2xx — delivered. Nothing more to do.
      return { ok: true, dropped: false, attempts: attempt + 1, status };
    }
    if (isTransientStatus(res.status)) {
      // 429 / 5xx — transient. Back off and retry unless this was the final try.
      log('warn', `webhook: transient ${res.status} (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
      if (attempt + 1 < MAX_ATTEMPTS) await sleepImpl(backoffMs(attempt));
      continue;
    }

    // 4xx (except 429) — permanent for this payload (wrong route/auth/shape).
    // Retrying the identical body cannot help, so drop now without spending the
    // remaining attempts.
    log('warn', `webhook: non-retryable ${res.status}; dropping alert`);
    return { ok: false, dropped: true, attempts: attempt + 1, status };
  }

  // Exhausted all attempts on transient failures — drop the alert. Per the
  // best-effort rule this is logged + swallowed, NEVER thrown to the caller.
  log('warn', `webhook: exhausted ${MAX_ATTEMPTS} attempts; dropping alert (last status ${status})`);
  return { ok: false, dropped: true, attempts: MAX_ATTEMPTS, status };
}

// dispatchWebhook — the config-reading wrapper the server hooks call. Reads the
// webhook config off `cfg` and delegates to sendWebhook, so the budget +
// attention hooks do not each repeat the enabled/url/secret resolution. Returns
// the sendWebhook result (a promise); callers fire-and-forget it.
//
// `cfg` is the live config object (config.js load() result). `now` is an injected
// epoch-ms (the server passes Date.now(); tests pass a fixed value).
export function dispatchWebhook({
  event,
  reason,
  agent,
  severity,
  cfg,
  now,
  fetchImpl,
  sleepImpl,
  log,
}) {
  return sendWebhook({
    event,
    reason,
    agent,
    severity,
    ts: typeof now === 'number' ? now : Date.now(),
    url: cfg?.webhookUrl,
    secret: cfg?.webhookSecret,
    enabled: cfg?.webhookEnabled === true,
    fetchImpl,
    sleepImpl,
    log,
  });
}

// ─── Positive "agent finished" signal (WARDEN-575) ───────────────────────────
//
// The formatting half of the positive ping. WARDEN-1274 retired the pane-text
// half of it: the `active→idle` diff (diffDoneTransitions) inferred "finished"
// from a pane going quiet, so an agent that CRASHED back to its prompt read as a
// success — the worst-case false positive for this feature. What survives is the
// signal that was never a guess: the lifecycle `agent_ended` event (a container
// that genuinely went away, already SSH-noise-cleaned), bridged to this same
// dispatch by server.js. These helpers format that one.

// The NON-ALARMING severity for a "finished" transition (WARDEN-575). Positive
// signal — deliberately NOT critical/warning (the red/amber problem tones). 'info'
// so a receiver that maps severity→tone (ntfy priority) reads it as low-key, and
// the phone ping reads as crafted signal, not an alarm. Exported so the test pins
// it (and so a future severity-aware receiver stays consistent).
export function doneSeverity() {
  return 'info';
}

// The one-line human-readable "why" for a finished transition — the SAME wording
// the frontend watch ping uses for its `completed` reason
// (WATCH_REASON_LABEL.completed = 'finished a task', web/src/lib/desktopAlerts.ts)
// so the phone ping, the OS toast, and the in-app badge all speak with one voice on
// the positive signal. Appends the triggering signal line when present (an idle row
// usually carries none, but a real `signal` is surfaced when classifyPane attached
// one).
export function doneReason(signal) {
  const label = 'Finished a task';
  const sig = typeof signal === 'string' && signal.trim() ? signal.trim() : '';
  return sig ? `${label}: ${sig}` : label;
}

// Build the agent identity + reason for a lifecycle `agent_ended` event dispatched
// as a "finished" webhook (WARDEN-575). A lifecycle event carries no display `name`
// (it has { id, host, container, role, project }), so the agent field is derived —
// preferring the container name (a yatfa container is "{project}-{role}", the most
// pane-specific handle), then the unique id (host:session for a tmux chat). `role`
// and `project` are intentionally skipped: alone they are ambiguous (a bare
// "worker"/"local" identifies nothing on a phone ping), and a yatfa container
// already encodes both. The reason conveys that the container genuinely ended (the
// SSH-cleaned signal), distinct from a working→idle "finished a task." Used by
// tickLifecycle so the container-genuinely-ended case reaches the phone with the
// same positive severity + delivery contract as the working→idle case.
export function doneEndedIdentity(event) {
  const e = event || {};
  const agent = e.container || e.id || null;
  const reason = 'Agent finished (container ended)';
  return { agent, reason };
}

// Exported for tests / introspection. Not part of the public dispatch contract.
export const _INTERNALS = { MAX_ATTEMPTS, isTransientStatus, backoffMs };
