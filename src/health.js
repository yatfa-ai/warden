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
 * @param {Array} agents - Array of agent objects with health state
 * @returns {Object} Agents grouped by health state
 */
export function groupByHealth(agents) {
  const groups = {
    healthy: [],
    warning: [],
    critical: [],
    idle: [],
    closed: [],
    unknown: []
  };

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
 * @param {Object} groups - Grouped agents by health state
 * @returns {Object} Summary with counts and label
 */
export function getHealthSummary(groups) {
  const healthy = groups.healthy?.length || 0;
  const warning = groups.warning?.length || 0;
  const critical = groups.critical?.length || 0;
  const idle = groups.idle?.length || 0;
  const closed = groups.closed?.length || 0;
  const total = healthy + warning + critical + idle + closed;

  const label = `${healthy} healthy · ${warning} warning · ${critical} critical · ${idle} idle · ${closed} closed`;

  return {
    healthy,
    warning,
    critical,
    idle,
    closed,
    total,
    label
  };
}
