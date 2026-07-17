// Webhook "push" delivery channel (WARDEN-555) — the transport that POSTs a
// critical agent alert to a USER-CONFIGURED URL (ntfy/Discord/Slack/Telegram/
// Home Assistant) so a human AWAY from the machine still gets pinged the moment
// an agent newly needs attention or a token budget breaches — even with the
// Warden window closed to tray.
//
// Today every alert is delivered only as an in-app toast or an OS desktop
// notification (web/src/lib/desktopAlerts.ts), both of which require Warden's
// live window on a machine someone is sitting at. This is the missing channel
// that reaches BEYOND the desktop. It reuses the outbound-POST transport shape
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
// Plus the pure attention-transition diff the server-side sweep uses to decide
// WHICH newly-needy agent to ping (diffAttentionTransitions), so the sweep logic
// is testable without a server.

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Bounded retry cap — mirrors src/telemetry-send.js's MAX_ATTEMPTS. A down or
// slow webhook destination never loops or blocks the host app: after MAX_ATTEMPTS
// transient failures the alert is dropped, not retried forever.
const MAX_ATTEMPTS = 3;

// A response status is transient (retryable) when it is a rate-limit (429) or a
// server error (5xx). 4xx (other than 429) is permanent for this payload — the
// body is a fixed alert, so retrying the identical body cannot fix a 400/401/
// 404/410, and we fail fast rather than burn attempts. Mirrors telemetry-send.
function isTransientStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

// Jittered exponential backoff — the same shape as telemetry-send's backoffMs.
// Base doubles per attempt, then +/-25% jitter so a fleet of Warden instances
// retrying a down receiver do not thunder-herd in lockstep. The jitter is
// bounded and non-deterministic by design; tests inject a sleepImpl recorder
// and assert that backoff WAS slept (and how many times), never its exact ms.
function backoffMs(attempt) {
  const base = 200 * 2 ** attempt; // attempt 0 → 200, 1 → 400, 2 → 800 …
  const jitter = base * 0.25 * (Math.random() * 2 - 1); // +/-25% of base
  return Math.max(0, Math.round(base + jitter));
}

const noopLog = () => {};

// The result returned when the gate is closed (disabled or no URL). `dropped` is
// deliberately false: nothing was attempted OR discarded, the gate was simply
// closed — mirroring telemetry-send's consent/endpoint no-op contract so callers
// can distinguish "never tried" from "tried and gave up".
const NOOP_RESULT = Object.freeze({ ok: false, dropped: false, attempts: 0, status: null });

// The four attention-worthy pane states classifyPane (src/agentState.js) can
// produce — the same four web/src/lib/attentionRollup.ts folds into the
// "needs attention" badge. A transition INTO any of these (from a non-attention
// state) is what the server-side sweep pings about. `active`/`idle`/
// `capture_failed` are NOT alertable.
export const ATTENTION_STATES = Object.freeze(new Set(['stuck', 'erroring', 'waiting', 'blocked']));

// Build the webhook wire payload — the pure, network-free seam. Split out so the
// body contract ({ app, event, severity, agent, reason, ts }) is unit-testable
// in isolation, without a fetch mock. sendWebhook composes this.
//
//   event    — a machine-readable event id, e.g. 'attention-erroring',
//              'budget-breached', 'test'.
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

// Pure: the NEWLY attention-worthy transitions to ping about. Given the server's
// previous per-pane state map and the current /api/agent-states sweep result,
// returns the agents that transitioned INTO an attention state (stuck/erroring/
// waiting/blocked) from a NON-attention state (active/idle/absent/capture_failed)
// since the last sweep.
//
// Baseline-primed: an empty/null prevStates (the very first sweep, or the first
// sweep after the channel is enabled) returns [] — a pre-existing condition at
// launch/enable does NOT fire (mirrors shouldFireAlert / shouldFireBudgetAlert's
// priming discipline). The first sweep just seeds the baseline.
//
// One ping per NEW transition into attention — an agent MOVING between two
// attention states (e.g. waiting → erroring) is already known-needy (its key is
// in prevStates mapped to an attention state) and does NOT re-fire, mirroring
// desktopAlerts.diffNewAttention's same-key suppression. Recovery (attention →
// non-attention) silently re-arms the one-shot for the next breach; it never
// fires (the ticket is read-only alert delivery, no "recovered" ping).
//
// `prevStates` — Map<key, state> (or null/empty for the priming case).
// `agents`     — the pollAgentStates() result rows ({ key, state, signal, name,
//                 host, ... }). Rows whose state is not a string or not in
//                 ATTENTION_STATES (active/idle/capture_failed) are skipped.
export function diffAttentionTransitions(prevStates, agents) {
  if (!prevStates || prevStates.size === 0) return [];
  if (!Array.isArray(agents)) return [];
  const out = [];
  for (const a of agents) {
    if (!a || typeof a.state !== 'string') continue;
    if (!ATTENTION_STATES.has(a.state)) continue;
    const prev = prevStates.get(a.key);
    // Fire only on a transition INTO attention from a NON-attention state (or a
    // newly-seen key, whose prev is undefined → not in ATTENTION_STATES). An
    // agent already in an attention state last sweep is not a NEW transition.
    if (!ATTENTION_STATES.has(prev)) {
      out.push({
        key: a.key,
        state: a.state,
        signal: a.signal ?? null,
        name: a.name,
        host: a.host,
      });
    }
  }
  return out;
}

// Severity tone per attention state — mirrors desktopAlerts' red/amber split:
// stuck + erroring are BROKEN (critical); waiting + blocked need a human but are
// not broken (warning). Exported so the test pins the mapping.
export function attentionSeverity(state) {
  if (state === 'stuck' || state === 'erroring') return 'critical';
  if (state === 'waiting' || state === 'blocked') return 'warning';
  return 'info';
}

// ─── Positive "agent finished" transition (WARDEN-575) ───────────────────────
//
// The mirror of the problem-side diff above. The whole attention pipeline pings a
// human the instant an agent is stuck/erroring/waiting/blocked — but never when an
// agent FINISHES. A human who delegates a task and walks away must eyeball each
// pane to learn it's done. This adds the missing positive half: a transition-level
// "was genuinely working (active) → now idle" signal dispatched with a NON-ALARMING
// severity through the SAME proven webhook transport (and surfaced frontend-side in
// the AttentionBadge + desktop alert — see attentionRollup.ts / desktopAlerts.ts).
//
// Anti-noise crux — gate on GENUINE COMPLETION, not on idle. A dormant agent reading
// `idle` sweep after sweep never fires; only an agent that was genuinely WORKING
// (`active`) and just went idle does. This is the ticket's "sustained-active→idle"
// primary completion signal: a recently-active agent returning to its prompt is
// "finished a task," distinct from a pane that was always quiet.
//
// DELIBERATELY narrower than chatWatch's WORKING_STATES (web/src/lib/chatWatch.ts) /
// detectWatchCompleted, which treat active/stuck/erroring/blocked/waiting → idle ALL
// as "completed." The watch subsystem is per-chat OPT-IN, so its broader rule is
// precise enough to keep. The fleet done ping is NOT per-chat opt-in — broadening the
// same rule here would surface a "Finished a task" ping for an agent that ERRORED OUT
// and returned to its prompt (erroring→idle) or was repeating output (stuck→idle): a
// crash that reads as success is the worst-case false positive for this feature (the
// human skips reviewing the failure). `waiting→idle` is usually human-driven (no ping
// needed). So ONLY `active→idle` — the clean "was working → finished" — fires here.
// The container-genuinely-ended case is the OTHER genuine signal, carried by the
// lifecycle `agent_ended` bridge (see doneEndedIdentity + server.js), so BOTH genuine
// signals in the ticket's success criteria stay fully covered. (WARDEN-575 review:
// narrowed from the broader working set the first pass mirrored from chatWatch.)

// The single genuine "was working" state — only `active→idle` reads as "finished"
// here. See the anti-noise note above for why this is intentionally narrower than the
// watch subsystem's WORKING_STATES. `idle`/`capture_failed` are excluded; an agent
// that was never `active` going idle is a no-op (the anti-noise gate).
const DONE_WORKING_STATES = Object.freeze(new Set(['active']));

// Pure: the NEWLY-finished transitions to ping about (WARDEN-575). Given the
// server's previous per-pane state map and the current /api/agent-states sweep
// result, returns the agents that transitioned from `active` to `idle` since the
// last sweep — i.e. "was genuinely working, just stopped = finished." (Only
// `active→idle`, the genuine completion signal — see DONE_WORKING_STATES above.)
//
// Sibling of diffAttentionTransitions, sharing its discipline so the positive
// signal is as trustworthy as the problem signal:
//  - Baseline-primed: an empty/null prevStates (first sweep, or first sweep after
//    the channel is enabled) returns [] — a pre-existing idle agent at launch does
//    NOT fire. The first sweep just seeds the baseline.
//  - One ping per NEW active→idle transition. An agent that stays idle (idle→idle)
//    never fires; an agent that goes idle then active again re-arms (the next
//    active→idle fires again). Recovery / no-change never fires.
//  - Does NOT fire on ABSENCE: an agent missing from the current sweep (host blip,
//    pane detach, capture_failed) is intentionally NOT treated as "finished" here —
//    the attention sweep is not carry-forward-protected the way the lifecycle sweep
//    is, so absence is SSH-noise-unsafe. A container GENUINELY ending is the
//    lifecycle sweep's already-SSH-cleaned `agent_ended` event, which tickLifecycle
//    bridges to this same done dispatch (see server.js) — that is the
//    "container-genuinely-ended" signal, deliberately kept out of this diff.
//
// `prevStates` — Map<key, state> (or null/empty for the priming case). SAME baseline
//                 diffAttentionTransitions advances, so the two diffs share one sweep
//                 at zero extra capture cost.
// `agents`     — the pollAgentStates() result rows ({ key, state, signal, name,
//                 host, ... }).
export function diffDoneTransitions(prevStates, agents) {
  if (!prevStates || prevStates.size === 0) return [];
  if (!Array.isArray(agents)) return [];
  const out = [];
  for (const a of agents) {
    if (!a || a.state !== 'idle') continue; // fires ONLY on a present, idle row
    const prev = prevStates.get(a.key);
    // Fire only when the agent WAS active (genuinely working) last sweep and is idle
    // now. An agent already idle (idle→idle), newly-seen (prev undefined → never
    // active), or coming from a non-active state (erroring/stuck/waiting/blocked →
    // idle — an error-out or stall, NOT a finish) never fires.
    if (DONE_WORKING_STATES.has(prev)) {
      out.push({
        key: a.key,
        state: 'done',
        signal: a.signal ?? null,
        name: a.name,
        host: a.host,
      });
    }
  }
  return out;
}

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
// one). Sibling of attentionReason for the positive case.
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

// The one-line human-readable "why" for an attention state — the SAME wording
// desktopAlerts.INAPP_REASON uses (WARDEN-402) so the phone ping, the in-app
// toast, and the desktop alert all speak with one voice. Appends the triggering
// signal line when present (the classifier's `signal`) so the ping is specific,
// not just a label.
export function attentionReason(state, signal) {
  const label = {
    stuck: 'Stuck (repeating output)',
    erroring: 'Erroring',
    waiting: 'Waiting for your input',
    blocked: 'Blocked on a dependency',
  }[state];
  if (!label) return state;
  const sig = typeof signal === 'string' && signal.trim() ? signal.trim() : '';
  return sig ? `${label}: ${sig}` : label;
}

// Exported for tests / introspection. Not part of the public dispatch contract.
export const _INTERNALS = { MAX_ATTEMPTS, isTransientStatus, backoffMs, ATTENTION_STATES, DONE_WORKING_STATES };
