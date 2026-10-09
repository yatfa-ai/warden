// Token-spend budget tick (WARDEN-1688): the slow-cadence accumulator body, its
// budgetState/prevBudgetState/budgetRunning state and BUDGET_PER_HOST_LIMIT. Moved
// verbatim out of server.js; the sweep supervisor (createSweepSupervisor({ name:
// 'budget' })) stays there (src/telemetry-stalls-coverage.test.js scans server.js for
// it). Leaf imports only — never server.js (no cycle). `cfg` is injected live (the
// same object server.js mutates in place); `stopSweep` late-binds the supervisor.
import { computeBudgetState, shouldFireBudgetAlert, resolveBudgetConfig } from './budget.js';
import { completeSessionRows } from './sessionCache.js';
import * as notify from './notify.js';

// ---- Token-spend budget slow-cadence accumulator (WARDEN-415) ---------------
//
// The backend owns the budget check on its OWN slow beat (BUDGET_INTERVAL_MS,
// ~120s) — deliberately decoupled from the 2s monitor tick so it never joins the
// per-tick capture cost. Each tick REUSES the existing per-session token totals
// (through `sessionCache`, the ONE owner of the cross-host session list since
// WARDEN-1208 — the SAME rows /api/claude-sessions-all serves; do NOT re-read
// transcripts with new logic, and do NOT add a second fan-out here: that
// duplication is exactly what the cache was introduced to remove),
// filters to sessions active in the configured window, sums their lifetime
// totals (semantics documented in budget.js), and caches the pure
// computeBudgetState result. /api/budget returns the cache — instant, no SSH —
// so the frontend's progress surface + debounce check stay cheap. One
// unreachable host degrades to "no spend from it" (the cache never rejects and
// leaves a failed fetch's slot untouched); it
// never fails the whole sweep.
export function createBudgetTick({ cfg, sessionCache, local, stopSweep }) {
  let budgetState = null;
  // Previous-sweep snapshot for the budget-breach webhook debounce (WARDEN-555).
  // Kept SERVER-SIDE (the frontend has its OWN prev in useTokenBudget) so the
  // webhook fires on the !alerted → alerted transition even with the Warden
  // window closed to tray. Baseline-primed: null on the first tick → no fire.
  let prevBudgetState = null;
  // Re-entrancy guard, same rationale as lifecycleRunning: a sweep over slow hosts
  // can exceed the 120s beat, so an in-flight tick makes the next a no-op. Owned by
  // the tick (not the supervisor), which only reads it for its settle seam.
  let budgetRunning = false;
  // Per-host fetch ceiling. Sessions are mtime-sorted descending and the window is
  // recent, so window-active sessions sit at the front; this caps transcript reads
  // (local) + the grep+awk SSH pass (remote) on a very active host. 100 is far
  // above any realistic 24h session count.
  const BUDGET_PER_HOST_LIMIT = 100;

  // `deps` is a test seam (defaults to {} in production), identical in shape to
  // the lifecycle bridge's: `fetchImpl`/`sleepImpl` flow through to the webhook transport
  // so a test drives the full gate → computeBudgetState → shouldFireBudgetAlert →
  // dispatch path with ZERO real network. Production calls pass no args, so
  // deps.fetchImpl is undefined and dispatchWebhook falls through to globalThis.fetch
  // exactly as before.
  async function tickBudget(deps = {}) {
    // Self-gate: a disabled budget clears its own timer (and cache) so no sweep
    // runs while off. This makes startBudgetPoll safe to call unconditionally at
    // startup — it parks until the human opts in.
    if (!cfg.tokenBudgetEnabled) {
      stopSweep();
      budgetState = null;
      return;
    }
    if (budgetRunning) return;
    budgetRunning = true;
    try {
      const { threshold, perSessionThreshold, windowMs } = resolveBudgetConfig(cfg);
      const hosts = [local, ...cfg.hosts];
      // Reuse the existing session-usage fetch — single SSH pass per remote host
      // returning the enriched header (cwd/summary + four token ints), identical
      // to /api/claude-sessions-all. We only need mtime + tokenUsage.total +
      // identity, so the same rows feed computeBudgetState directly.
      //
      // ONE OWNER (WARDEN-1208). This used to be its OWN `Promise.allSettled`
      // fan-out, duplicating the route's over the same rows on an unrelated beat —
      // the duplication this comment block has always described ("the SAME
      // functions /api/claude-sessions-all uses") but did not prevent. Both readers
      // now share `sessionCache`, so a sweep landing near a page load costs ONE
      // enumeration per host instead of two, and each warms the slots the other
      // reads.
      //
      // `wait: true` is the slow-cadence mode: unlike the request path there is no
      // user waiting, so this awaits every fetch it launches with NO settle bound
      // and keeps the complete-rows behaviour the budget math has always had. A
      // host that fails still degrades to "no spend from it" — the cache leaves a
      // failed fetch's slot untouched and never rejects — exactly as the previous
      // `allSettled` + fulfilled-filter did.
      //
      // PROJECTED DOWN TO A BARE ARRAY, deliberately. The cache fetches through the
      // richer `remoteClaudeSessionsDetail` (that is how the route keeps its
      // `unreachable` discriminator), but this sweep consumes only the rows, so the
      // frozen `remoteClaudeSessions` contract (WARDEN-1196) is neither widened nor
      // relied on here, and the sweep does NOT start consuming `unreachable` — that
      // would be a behaviour change outside this slice.
      const settled = await sessionCache.snapshot(hosts, BUDGET_PER_HOST_LIMIT, { wait: true });
      // PENDING HOSTS CONTRIBUTE NOTHING TO THE BUDGET MATH, and this projection is
      // load-bearing rather than defensive.
      //
      // `wait: true` awaits every fetch this sweep LAUNCHES, but it cannot wait on
      // one it merely JOINED at a smaller limit (launcher-only settle discipline,
      // and a joined fetch fills the slot at ITS launcher's window). So when a
      // page-1 route fetch — `perHost = offset + limit + 1`, typically 41 — is in
      // flight as the 120s tick fires, this sweep can arrive holding a REAL but
      // TRUNCATED 41-row slot for a host it asked 100 rows of. The cache tells us
      // exactly that via `pending`.
      //
      // Those rows are mtime-DESCENDING, so on a host with more than 41 sessions
      // active in the window the truncation silently DROPS spend, and the result is
      // cached for the next 120s. That is a wrong NUMBER, not a slow response —
      // strictly worse than the honest degradation, and worse than the pre-cache
      // behaviour (which always fanned out at the full 100).
      //
      // `completeSessionRows` excludes those hosts, degrading each to "no spend from
      // it this tick" — the SAME pre-existing semantics an unreachable or failed
      // host already gets here, self-correcting on the next tick. The ROUTE
      // deliberately does the OPPOSITE with the same flag (it keeps the rows and
      // discloses `pendingHosts`), because it renders a list rather than computing a
      // number; that divergence is documented on the helper.
      const sessions = completeSessionRows(settled);
      budgetState = computeBudgetState(sessions, {
        now: Date.now(),
        windowMs,
        threshold,
        perSessionThreshold,
      });
      // Webhook push for a budget breach (WARDEN-555). Fires ONLY on the transition
      // into an alerted state (the debounced one-shot), server-side, so it reaches
      // the user's phone even with the window closed to tray. shouldFireBudgetAlert
      // is the same pure debounce the frontend uses; this keeps its OWN prev. Fire-
      // and-forget: dispatchWebhook already swallows terminal failure, and we never
      // let a rejection escape the tick (the .catch is belt-and-suspenders). The
      // dispatch is gated on cfg.webhookAlertBudget inside the helper chain; prev is
      // advanced unconditionally so the debounce tracks reality regardless.
      if (cfg.webhookAlertBudget && shouldFireBudgetAlert(prevBudgetState, budgetState)) {
        const offender = budgetState.topOffender;
        notify.dispatchWebhook({
          event: 'budget-breached',
          severity: 'critical',
          agent: offender ? (offender.cwd || offender.id || 'fleet') : 'fleet',
          reason: budgetState.perSessionBreached
            ? `Per-session token budget exceeded: top session at ${offender?.total ?? 0} tokens (${offender?.cwd || offender?.id || 'unknown'}).`
            : `Fleet token budget exceeded: ${budgetState.fleetSpent} tokens spent across active sessions in the last ${Math.round(windowMs / 3_600_000)}h window.`,
          cfg,
          now: Date.now(),
          fetchImpl: deps.fetchImpl,
          sleepImpl: deps.sleepImpl,
        }).catch(() => {});
      }
      prevBudgetState = budgetState;
    } catch {
      // A transient failure leaves the previous cache in place (no blanking) so a
      // blip doesn't flap the progress surface / re-arm the one-shot spuriously.
    } finally {
      budgetRunning = false;
    }
  }

  return {
    tickBudget,
    getBudgetState: () => budgetState,
    clearBudgetState: () => { budgetState = null; },
    isRunning: () => budgetRunning,
  };
}
