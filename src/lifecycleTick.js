// Cross-host lifecycle tick (WARDEN-1669): the periodic discoverAll() sweep, its
// transition diff, and the WARDEN-575 done-webhook bridge. Moved verbatim out of
// server.js; the sweep supervisor (createSweepSupervisor({ name: 'lifecycle' }))
// and LIFECYCLE_INTERVAL_MS stay there. Leaf imports only — never server.js (no cycle).
import { loadCatalog } from './config.js';
import { discoverAll } from './chats.js';
import { appendEvent } from './activity.js';
import { buildSnapshot, diffLifecycles } from './lifecycle.js';
import * as notify from './notify.js';

// --- Cross-host agent lifecycle polling -------------------------------------
// appendEvent() is only reached from the local attach/observe path, so a remote
// agent that starts/finishes/errors while no Warden pane is open on its host
// leaves no trace. This periodic discoverAll() over EVERY configured host feeds
// two snapshots into the pure diffLifecycles() (src/lifecycle.js) to emit
// host-attributed lifecycle events on state TRANSITIONS only — so event volume
// stays negligible against the 7-day rotation regardless of the 60s cadence.
// `cfg` is injected live (the same object server.js mutates in place), so config
// flips are still read at tick time.
export function createLifecycleTick({ cfg }) {
  let prevSnapshot = new Map(); // id → { host, container, role, project, active, ok }
  // Re-entrancy guard. A single discoverAll sweep can take longer than the 60s tick
  // (slow/unreachable hosts each wait on ConnectTimeout; per-agent SSH on Windows),
  // so without this guard ticks overlap and pile up — compounding load into the
  // exact global slowdown WARDEN-147 introduced. A tick already in flight makes the
  // next interval a no-op rather than stacking a second full-fleet sweep on it.
  let lifecycleRunning = false;

  async function tickLifecycle(deps = {}) {
    if (lifecycleRunning) return;
    lifecycleRunning = true;
    return tickLifecycleBody(deps).finally(() => { lifecycleRunning = false; });
  }

  // WARDEN-575: append a lifecycle event to the activity log AND, when it is a genuine
  // agent_ended (container gone, host reachable — already SSH-noise-cleaned by
  // buildSnapshot's carry-forward), bridge it to the POSITIVE done webhook so a human
  // away from the machine learns an agent FINISHED, not only that it broke. The
  // done-routing gate (webhookAlertDone) is checked here so the lifecycle sweep adds
  // ZERO webhook cost when the positive routing is off; the channel gate inside
  // dispatchWebhook is the second line of defense. Fire-and-forget + .catch so a slow
  // receiver never blocks the lifecycle sweep. Non-alarming 'info' severity, so the
  // container-ended ping ("Agent finished (container ended)", doneEndedIdentity) reads as
  // a positive tone on the phone.
  //
  // WARDEN-1274: this is now the ONLY done webhook. Its sibling — the 60s attention
  // sweep's active→idle "Finished a task" ping — is retired, because that transition was
  // GUESSED from pane text (a crash that returns to a prompt reads as a success). THIS
  // signal is different in kind and is why it survives: `agent_ended` is a container that
  // genuinely went away, already SSH-noise-cleaned by buildSnapshot's carry-forward — an
  // observed fact, not an inference. The `webhookAlertDone` gate is unchanged and still
  // routes it.
  //
  // `deps` (test seam, defaults to {} in production) threads fetchImpl/sleepImpl to
  // the webhook transport — mirroring tickBudget so the bridge is testable with ZERO
  // real network. Production callers (the timer, startLifecyclePoll) pass nothing →
  // dispatchWebhook falls through to globalThis.fetch.
  async function appendLifecycleEvent(event, deps = {}) {
    // A single lifecycle event must never break the tick — a write failure is
    // swallowed (the prior sync try/catch is now an await + catch since the append
    // is async — WARDEN-831). AWAITING (not fire-and-forget) preserves the prior
    // ordering guarantee: the event is on disk before the tick continues, so a
    // concurrent /api/activity reader (or a test) never observes the tick's state
    // change before the event lands. The append is async I/O, so this does not
    // block the event loop — it only orders the tick behind its own append.
    try { await appendEvent(event); } catch { /* ignore single-event write failures */ }
    if (event && event.type === 'agent_ended' && cfg.webhookAlertDone) {
      const { agent, reason } = notify.doneEndedIdentity(event);
      notify.dispatchWebhook({
        event: 'done',
        severity: notify.doneSeverity(),
        agent,
        reason,
        cfg,
        now: Date.now(),
        fetchImpl: deps.fetchImpl,
        sleepImpl: deps.sleepImpl,
      }).catch(() => {});
    }
  }

  async function tickLifecycleBody(deps = {}) {
    // No remote hosts and no catalog → discoverAll has nothing to observe. But
    // FIRST drain any pending transitions in prevSnapshot against an empty fleet.
    // The last agent ending (or the user removing their last configured host) can
    // empty the catalog/hosts while prevSnapshot still tracks it; this guard would
    // otherwise short-circuit BEFORE the diff — permanently suppressing that final
    // agent_ended, or emitting it minutes late with a wrong timestamp once some
    // other agent later reappears (the only thing that would un-freeze the diff).
    // diffLifecycles(prev, ∅) emits agent_ended for every tracked chat, so draining
    // then going dormant captures the real disappearance(s) and frees the snapshot.
    if (!cfg.hosts.length && !(await loadCatalog()).length) {
      if (prevSnapshot.size > 0) {
        for (const event of diffLifecycles(prevSnapshot, new Map())) {
          await appendLifecycleEvent(event, deps);
        }
        prevSnapshot = new Map();
      }
      return;
    }
    let chats, errors;
    try {
      // Lean sweep: { activity: false } skips the per-agent activity SSH (remote)
      // and the per-session capture-pane (local). The lifecycle diff needs only
      // alive/dead TRANSITIONS, not timestamps — and those per-agent round-trips
      // (a fresh ssh.exe each on Windows, which has no ControlMaster multiplexing)
      // were the bulk of the unconditional 60s sweep's cost.
      ({ chats, errors } = await discoverAll(cfg.hosts, cfg, { activity: false }));
    } catch {
      return; // transient discovery failure; retry next tick
    }
    const failingHosts = new Set((errors || []).map((e) => e.host));
    const next = buildSnapshot(prevSnapshot, chats, failingHosts);

    // First run: seed the baseline SILENTLY. An empty prevSnapshot would otherwise
    // emit agent_started for every currently-running agent (a one-time burst).
    if (prevSnapshot.size === 0) {
      prevSnapshot = next;
      return;
    }

    for (const event of diffLifecycles(prevSnapshot, next)) {
      await appendLifecycleEvent(event, deps);
    }
    prevSnapshot = next;
  }

  return tickLifecycle;
}
