import { loopMonitor } from './loop-monitor.js';

// --- Background sweep supervisor (WARDEN-1169) -------------------------------
//
// The three always-resident sweeps below — lifecycle, budget, attention — each
// hand-rolled the SAME scaffolding: an interval timer, a fire-and-forget kick
// wrapped in loopMonitor.trace, an in-flight handle, a start, a config-driven
// restart, and an await-the-seed test seam. The lockstep was measured, not
// suspected: WARDEN-947 changed 163 lines in this file and 76 of them (46.6%)
// were this scaffolding written out twice across 6 hunks, and WARDEN-977 then
// added one hand-written trace() wrapper per sweep. This factory owns the
// scaffolding ONCE — timer, kick, start/stop/restart, seam.
//
// What it deliberately does NOT own: the tick bodies (each keeps its own
// re-entrancy flag and its own self-gate — their DI shapes genuinely differ),
// and none of the sweeps' real asymmetries. Every asymmetry is a PARAMETER,
// because flattening any of them is a silent behavior change:
//
//   intervalMs  cadence differs (60s / 120s / 60s), and budget's constant is
//               IMPORTED from src/budget.js — so this takes a plain value and
//               never assumes a locally-declared one.
//   enabled     lifecycle is unconditional; budget/attention gate on cfg.
//   guardKick   ⚠ lifecycle's kick has NO .catch(). trace() preserves the tick's
//               own rejection identity so the sweep behaves exactly as untraced,
//               and attaching a handler would CHANGE lifecycle's crash
//               semantics. guardKick:false keeps that. It necessarily also turns
//               off the in-flight handle: a bare .finally() chained onto an
//               un-caught rejection would itself reject, unhandled. The two
//               travel together — which is also why lifecycle has no test seam.
//   startOnce   lifecycle's start is one-shot (a second call must NOT re-kick a
//               live sweep); budget/attention re-kick on every start so a later
//               enable wakes their parked timer without a second start call.
//   onEnable /  restart()'s two legs carry DIFFERENT side effects: budget blanks
//   onDisable   its cache on disable ONLY; attention resets its diff baseline on
//               BOTH legs (clean prime on enable, no stale state on disable).
//   isRunning   read-only view of the tick's own re-entrancy flag, for settled().
export function createSweepSupervisor({
  name,
  intervalMs,
  tick,
  enabled = null,
  guardKick = true,
  startOnce = false,
  isRunning = () => false,
  onEnable = null,
  onDisable = null,
}) {
  const label = `sweep:${name}`;
  let timer = null;
  // WARDEN-947: handle on the sweep kicked FIRE-AND-FORGET by start()/restart().
  // Production never reads it; it exists so a test that drives its OWN sweeps can
  // await the kicked one instead of racing it. See settled().
  let inFlight = null;

  const kick = guardKick
    ? () => {
        // The `.catch` is the same lesson as appendStateEvent: a fire-and-forget async
        // call needs a REAL rejection handler, or a future throw outside the tick's own
        // try/catch escapes as an unhandledRejection and kills the process on Node >= 15.
        // Traced for the stall monitor (WARDEN-977) — see the guardKick:false arm below.
        const p = loopMonitor.trace(label, tick)
          .catch(() => { /* a kicked sweep must never take the server down */ })
          .finally(() => { if (inFlight === p) inFlight = null; });
        inFlight = p;
      }
    // Traced (WARDEN-977): an always-on sweep is the most plausible window for one
    // of the remaining synchronous sites to land on a user-visible request, so the
    // stall monitor must be able to name it. `trace` returns the tick's own promise
    // (rejection identity preserved), so the sweep behaves exactly as untraced.
    : () => loopMonitor.trace(label, tick);

  function arm() { if (!timer) timer = setInterval(kick, intervalMs); }
  function disarm() { if (timer) { clearInterval(timer); timer = null; } }

  return {
    start() {
      if (startOnce && timer) return;
      arm();
      kick();
    },
    // Used by the self-gating ticks: a disabled sweep clears its OWN timer so no
    // sweep runs while off, which is what makes start() safe to call unconditionally
    // at startup — it parks until the human opts in.
    stop() { disarm(); },
    // React to a config change: enable → ensure the timer runs + sweep now;
    // disable → stop, then run the sweep's own teardown side effect.
    restart() {
      if (!enabled || enabled()) {
        arm();
        onEnable?.();
        kick();
      } else if (timer) {
        disarm();
        onDisable?.();
      }
    },
    // Test seam: resolves once no sweep is in flight — the one kicked by
    // start()/restart() included. A test that enables the feature via PUT /api/config
    // and then drives its own tick() sweeps MUST await this first, or the kicked sweep
    // lands mid-test and stomps the baseline/cache it primed. The isRunning() spin
    // covers the re-entrant case (a kick that no-op'd because an earlier sweep was
    // still running), so this is deterministic — not a timed sleep.
    async settled() {
      await inFlight;
      while (isRunning()) await new Promise((r) => setImmediate(r));
    },
  };
}
