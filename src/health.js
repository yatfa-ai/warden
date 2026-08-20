// Health tracking for agent fleet.
// Classifies agents into health states based on activity timestamps and tmux status.
// Health states (at DEFAULT thresholds; the boundaries are user-configurable via
// cfg.healthWarningThresholdMin / cfg.healthCriticalThresholdMin):
//   - HEALTHY: output in last 5 minutes
//   - WARNING: no output in 5-30 minutes
//   - CRITICAL: no output in 30+ minutes (alive but silent) — a DEAD session is
//     never critical, it is CLOSED (see below).
//   - IDLE: manual session with no recent activity (different from WARNING)
//   - CLOSED: the tmux session is no longer alive (active === false). A closed
//     chat is not a failing agent; CRITICAL means "alive but silent 30+ min".
//     Both kind:'tmux' and kind:'yatfa' classify the same way here — no
//     kind-based special-casing. (WARDEN-245)
//   - UNKNOWN: undiscovered (lazy) chat — active is null/undefined.

const HEALTHY_DEFAULT_MIN = 5;   // minutes — default healthy→WARNING boundary
const WARNING_DEFAULT_MIN = 30; // minutes — default warning→CRITICAL boundary

/**
 * Health states for an agent
 */
export const HealthState = {
  HEALTHY: 'healthy',
  WARNING: 'warning',
  CRITICAL: 'critical',
  IDLE: 'idle',
  CLOSED: 'closed',
  UNKNOWN: 'unknown'
};

/**
 * The canonical, ORDERED health-state vocabulary — the ONE hand-written list on
 * the backend. Every other backend site that needs "all six states" derives from
 * this instead of re-typing the members (WARDEN-1104).
 *
 * The order is `HealthState`'s declaration order (healthy → unknown, closed
 * between idle and unknown per WARDEN-245) and is LOAD-BEARING: it fixes the
 * bucket order of `groupByHealth` and, more visibly, the segment order of
 * `getHealthSummary`'s human-readable `label`.
 *
 * Adding a state = add it to `HealthState` (in its display position) and every
 * derived site below picks it up. Two shipped bugs came from missing a site on
 * exactly such an addition: WARDEN-245 (`closed` missed the buckets) and
 * WARDEN-1064/1068 (`unknown` missed the summary, so a populated fleet's bar
 * read "0 agents").
 *
 * @type {string[]}
 */
export const HEALTH_STATES = Object.values(HealthState);

/**
 * Get health state for an agent based on activity and status
 * @param {Object} agent - Agent object from discoverAll
 * @param {number} lastActivity - Timestamp of last activity (ms since epoch)
 * @param {{healthyMin?: number, warningMin?: number}} [thresholds] - Configurable
 *   inactivity cutoffs in MINUTES. `healthyMin` is the healthy→WARNING boundary
 *   (default 5); `warningMin` is the warning→CRITICAL boundary (default 30) and
 *   ALSO drives the manual-tmux IDLE branch. Both fall back to today's constants
 *   when absent so callers that omit the arg are unaffected.
 * @returns {string} Health state
 */
export function getHealthState(agent, lastActivity, thresholds = {}) {
  // Configurable boundaries (minutes → ms). Defaults preserve today's behavior.
  const healthyMs = (thresholds.healthyMin ?? HEALTHY_DEFAULT_MIN) * 60 * 1000;
  const warningMs = (thresholds.warningMin ?? WARNING_DEFAULT_MIN) * 60 * 1000;
  // Defense-in-depth against an INVERTED pair (warning > critical, e.g. 60/30):
  // the healthy band can never exceed the critical band, or the healthy→WARNING
  // boundary swallows the entire WARNING/CRITICAL range and a silently-failing
  // agent reads HEALTHY (a lying state). Clamp the healthy boundary to at most
  // the critical boundary so the 3-band ladder stays well-ordered regardless of
  // how the inversion entered (UI, PUT /api/config, or hand-edited config.json).
  // Errs toward alerting (conservative). (WARDEN-374)
  const effectiveHealthyMs = Math.min(healthyMs, warningMs);

  // Undiscovered (lazy) chats: active is null/undefined — not dead, just unknown.
  if (agent.active == null) {
    return HealthState.UNKNOWN;
  }
  // A chat whose tmux session is no longer alive is CLOSED — not critical. This
  // applies to both kind:'tmux' and kind:'yatfa' (a dead session is a dead
  // session regardless of how it was spawned). CRITICAL is reserved for an
  // ALIVE-but-silent agent (time-based rule below). (WARDEN-245)
  if (!agent.active) {
    return HealthState.CLOSED;
  }

  // Manual sessions with no recent activity are IDLE, not WARNING. Consumes the
  // SAME configured warning boundary as the agent classification below so a
  // raised critical threshold keeps manual-tmux classification consistent.
  if (agent.kind === 'tmux' && !agent.isAgent) {
    const timeSinceActivity = lastActivity ? Date.now() - lastActivity : Infinity;
    if (timeSinceActivity > warningMs) {
      return HealthState.IDLE;
    }
  }

  // No activity data - unknown
  if (!lastActivity) {
    return HealthState.UNKNOWN;
  }

  const timeSinceActivity = Date.now() - lastActivity;

  // Classify based on time since last activity. The healthy boundary is the
  // clamped effectiveHealthyMs (so an inverted pair can't lie); the WARNING→
  // CRITICAL boundary stays on warningMs. With the pair well-ordered the clamp
  // is a no-op and behavior is unchanged. (WARDEN-374)
  if (timeSinceActivity <= effectiveHealthyMs) {
    return HealthState.HEALTHY;
  } else if (timeSinceActivity <= warningMs) {
    return HealthState.WARNING;
  } else {
    return HealthState.CRITICAL;
  }
}

/**
 * Group agents by health state
 *
 * One empty bucket per canonical state, derived from HEALTH_STATES so a new
 * member can never silently lose its bucket (WARDEN-245 shipped exactly that).
 * `Object.fromEntries` deliberately yields a NORMAL, prototype-inheriting object
 * — the same kind the hand-written literal produced — so the `if (groups[state])`
 * guard below keeps its existing (quirky) behavior for inherited keys such as
 * `'constructor'`. Hardening that is a real behavior change and is out of scope
 * here (see WARDEN-885).
 *
 * @param {Array} agents - Array of agent objects with health state
 * @returns {Object} Agents grouped by health state
 */
export function groupByHealth(agents) {
  const groups = Object.fromEntries(HEALTH_STATES.map((state) => [state, []]));

  for (const agent of agents) {
    const state = agent.healthState || HealthState.UNKNOWN;
    if (groups[state]) {
      groups[state].push(agent);
    }
  }

  return groups;
}

/**
 * Calculate health summary for display
 *
 * Counts, `total` and `label` are all derived from HEALTH_STATES, so the three
 * can no longer disagree about which states exist — the exact defect shipped in
 * WARDEN-1064/1068, where the counts covered five of the six buckets
 * `groupByHealth` produced and the fleet bar read "0 agents" for a populated
 * fleet. The label format is asserted by callers/tests: `${n} ${state}` per
 * segment in canonical order, joined by ` · `.
 *
 * @param {Object} groups - Grouped agents by health state
 * @returns {Object} Summary with counts and label
 */
export function getHealthSummary(groups) {
  const counts = Object.fromEntries(
    HEALTH_STATES.map((state) => [state, groups[state]?.length || 0])
  );
  const total = HEALTH_STATES.reduce((sum, state) => sum + counts[state], 0);
  const label = HEALTH_STATES.map((state) => `${counts[state]} ${state}`).join(' · ');

  return {
    ...counts,
    total,
    label
  };
}
