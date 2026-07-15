// Pure token-spend budget logic (WARDEN-415) — the ALARM that completes the
// meter WARDEN-367 shipped. The backend owns the slow-cadence fetch (server.js's
// tickBudget reuses the existing per-session token totals from
// localClaudeSessions / remoteClaudeSessions — the SAME functions
// /api/claude-sessions-all uses); this module owns only the pure window filter,
// summation, threshold check, and the fire-once-per-crossing debounce.
//
// Kept dependency-free (no imports) so src/budget.test.js can import it directly
// under `node --test`. The server and the frontend's web/src/lib/tokenBudget.ts
// each mirror the contract here (the debounce helper is duplicated on both sides
// deliberately — see shouldFireBudgetAlert below).

// Slow-cadence accumulator interval (ms). Deliberately decoupled from the 2s
// monitor tick so the budget check never joins the per-tick capture cost: it
// reuses the existing session-usage fetch on its own slow beat. 120s is fine
// resolution for a spend signal (you don't need second-precision on token cost),
// and it bounds the transcript-read / SSH cost of the sweep.
export const BUDGET_INTERVAL_MS = 120_000;

// Default thresholds — mirrored into config.js DEFAULTS so a persisted config
// missing these keys still resolves. A backend that reads a stale config
// (pre-WARDEN-415) falls back to these via Number(...) > 0 guards in tickBudget.
export const DEFAULT_TOKEN_BUDGET_THRESHOLD = 2_000_000;          // fleet, windowed
export const DEFAULT_TOKEN_BUDGET_PER_SESSION_THRESHOLD = 1_000_000; // single runaway
export const DEFAULT_TOKEN_BUDGET_WINDOW_HOURS = 24;

// Resolve the configured threshold/window from a possibly-stale or partial cfg,
// applying the same defaults config.js DEFAULTS would. Centralized so tickBudget
// and tests resolve identically. `null`/0/invalid perSessionThreshold means
// "disabled" (returns 0) — the per-session alarm is opt-in.
export function resolveBudgetConfig(cfg) {
  const threshold = posFinite(cfg?.tokenBudgetThresholdTokens, DEFAULT_TOKEN_BUDGET_THRESHOLD);
  const perSessionThreshold = posFinite(cfg?.tokenBudgetPerSessionThresholdTokens, 0);
  const windowHours = posFinite(cfg?.tokenBudgetWindowHours, DEFAULT_TOKEN_BUDGET_WINDOW_HOURS);
  return { threshold, perSessionThreshold, windowHours, windowMs: windowHours * 3_600_000 };
}
function posFinite(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

// One session as the budget sees it. Only `mtime` (the window filter), the
// lifetime `tokenUsage.total` (summation), and identity (top-offender deep-link)
// matter; cwd/summary/host ride along so the offending session is deep-linkable.
// tokenUsage may be null/absent (no usage recorded) — those rows contribute 0.
//
// SEMANTICS (the design decision WARDEN-415 leaves to the worker): the window
// filters which SESSIONS count (active in the window — mtime within now-windowMs),
// but each contributes its FULL lifetime token total, NOT just the turns within
// the window. This is approximation (a): cheap, reuses the existing per-session
// totals (no new transcript logic), and it still catches a runaway — an active
// looping agent has a RECENT mtime AND a large lifetime total, so it lands in the
// sum. The alternative — true windowed spend (sum only turns timestamped within
// the window) — needs new on-host logic and a fresh SSH design, which the slice's
// "no new polling beyond the existing fetch" constraint rules out. The chosen
// semantics are stated in the Settings tooltip so the human knows what "spent in
// the last 24h" means.
//
// Returns a flat, JSON-serializable snapshot the /api/budget endpoint returns
// verbatim and the frontend consumes unchanged.
export function computeBudgetState(sessions, opts) {
  const now = opts.now;
  const windowMs = opts.windowMs;
  const threshold = opts.threshold;
  const perSessionThreshold = opts.perSessionThreshold;
  const cutoff = now - windowMs;

  // Window filter: only sessions active in the window (mtime >= cutoff). A null
  // / non-finite mtime can't be windowed → excluded (can't prove it's active).
  const active = (Array.isArray(sessions) ? sessions : [])
    .filter((s) => s && typeof s.mtime === 'number' && Number.isFinite(s.mtime) && s.mtime >= cutoff);

  let fleetSpent = 0;
  let topOffender = null;
  let topTotal = 0;
  // Per-session usage distribution (WARDEN-466). The same numbers this loop
  // already sums into fleetSpent + reduces to the single topOffender — returned
  // verbatim so /api/health can join each LIVE agent's token total beside its
  // CPU/mem at the kill-decision surface (see server.js /api/health's cwd+host
  // join). Only sessions with real usage contribute (a 0-total row renders no
  // chip), which also bounds the payload to the rows that matter. Additive: the
  // existing fleetSpent / topOffender / breach fields are unchanged.
  const sessionUsage = [];
  for (const s of active) {
    const total = num(s?.tokenUsage?.total);
    fleetSpent += total;
    if (total > 0) {
      sessionUsage.push({ id: s.id, host: s.host, cwd: s.cwd, total });
      // The offender is the single heaviest window-active session (the specific
      // runaway a per-session alarm points at). Only sessions with real usage can
      // be the offender; ties resolve to the first-seen (stable).
      if (total > topTotal) {
        topTotal = total;
        topOffender = {
          id: s.id,
          host: s.host,
          cwd: s.cwd,
          summary: s.summary,
          total,
        };
      }
    }
  }

  // fleetBreached = aggregate windowed spend crossed the fleet threshold.
  // perSessionBreached = the heaviest single session crossed the per-session
  // threshold (the "specific runaway" signal). Either fires the alarm.
  const fleetBreached = threshold > 0 && fleetSpent >= threshold;
  const perSessionBreached = perSessionThreshold > 0 && topTotal >= perSessionThreshold;

  return {
    evaluatedAt: now,
    windowMs,
    threshold,
    perSessionThreshold,
    sessionCount: active.length,
    fleetSpent,
    fleetBreached,
    topOffender,
    perSessionBreached,
    // Per-session usage entries (WARDEN-466) — the distribution the fleetSpent
    // sum + topOffender reduction are derived from. Additive; consumers that
    // ignore it are unaffected.
    sessionUsage,
    // `alerted` is the single boolean the debounce keys on — true when EITHER
    // threshold is breached. Recovery (both back under) clears it, re-arming the
    // one-shot for the next breach.
    alerted: fleetBreached || perSessionBreached,
  };
}

// Coerce a usage field to a non-negative finite number, never throwing. Mirrors
// server.js's `tok()` contract: real values are JSON numbers; absent/invalid
// contribute 0. (Inline rather than imported so this module stays import-free.)
function num(v) {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Pure: fire ONLY on the transition INTO an alerted state (!prev.alerted →
// next.alerted). This is the "debounced one-shot" WARDEN-415 requires — fires
// once per crossing, never while persistently over (no spam every tick), never
// on recovery, never on the first observation (the baseline-priming discipline
// from shouldFireAlert: a pre-existing condition at launch/reload does not fire;
// the launch-with-breach case is handled by the hook's priming step instead).
//
// The frontend mirrors this exact function in web/src/lib/tokenBudget.ts so the
// debounce is unit-testable on both sides without coupling them at runtime.
export function shouldFireBudgetAlert(prev, next) {
  if (!prev || !next) return false;
  return !prev.alerted && next.alerted;
}
