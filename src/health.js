// Health tracking for agent fleet.
// Classifies agents into health states based on activity timestamps and tmux status.
// Health states:
//   - HEALTHY: output in last 5 minutes
//   - WARNING: no output in 5-30 minutes
//   - CRITICAL: no output in 30+ minutes or dead tmux
//   - IDLE: manual session with no recent activity (different from WARNING)

const HEALTHY_THRESHOLD_MS = 5 * 60 * 1000;  // 5 minutes
const WARNING_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Health states for an agent
 */
export const HealthState = {
  HEALTHY: 'healthy',
  WARNING: 'warning',
  CRITICAL: 'critical',
  IDLE: 'idle',
  UNKNOWN: 'unknown'
};

/**
 * Get health state for an agent based on activity and status
 * @param {Object} agent - Agent object from discoverAll
 * @param {number} lastActivity - Timestamp of last activity (ms since epoch)
 * @returns {string} Health state
 */
export function getHealthState(agent, lastActivity) {
  // Undiscovered (lazy) chats: active is null/undefined — not dead, just unknown.
  if (agent.active == null) {
    return HealthState.UNKNOWN;
  }
  // If agent is not active (tmux session dead), it's critical
  if (!agent.active) {
    return HealthState.CRITICAL;
  }

  // Manual sessions with no recent activity are IDLE, not WARNING
  if (agent.kind === 'tmux' && !agent.isAgent) {
    const timeSinceActivity = lastActivity ? Date.now() - lastActivity : Infinity;
    if (timeSinceActivity > WARNING_THRESHOLD_MS) {
      return HealthState.IDLE;
    }
  }

  // No activity data - unknown
  if (!lastActivity) {
    return HealthState.UNKNOWN;
  }

  const timeSinceActivity = Date.now() - lastActivity;

  // Classify based on time since last activity
  if (timeSinceActivity <= HEALTHY_THRESHOLD_MS) {
    return HealthState.HEALTHY;
  } else if (timeSinceActivity <= WARNING_THRESHOLD_MS) {
    return HealthState.WARNING;
  } else {
    return HealthState.CRITICAL;
  }
}

/**
 * Get color class for a health state
 * @param {string} state - Health state
 * @returns {string} CSS color class
 */
export function getHealthColor(state) {
  switch (state) {
    case HealthState.HEALTHY:
      return 'text-green-400';
    case HealthState.WARNING:
      return 'text-yellow-400';
    case HealthState.CRITICAL:
      return 'text-red-400';
    case HealthState.IDLE:
      return 'text-gray-400';
    default:
      return 'text-muted-foreground';
  }
}

/**
 * Get background color class for a health state
 * @param {string} state - Health state
 * @returns {string} CSS background color class
 */
export function getHealthBgColor(state) {
  switch (state) {
    case HealthState.HEALTHY:
      return 'bg-green-500';
    case HealthState.WARNING:
      return 'bg-yellow-500';
    case HealthState.CRITICAL:
      return 'bg-red-500';
    case HealthState.IDLE:
      return 'bg-gray-500';
    default:
      return 'bg-muted-foreground';
  }
}

/**
 * Format health state for display
 * @param {string} state - Health state
 * @returns {string} Display label
 */
export function formatHealthState(state) {
  switch (state) {
    case HealthState.HEALTHY:
      return 'Healthy';
    case HealthState.WARNING:
      return 'Warning';
    case HealthState.CRITICAL:
      return 'Critical';
    case HealthState.IDLE:
      return 'Idle';
    default:
      return 'Unknown';
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
  const total = healthy + warning + critical + idle;

  const label = `${healthy} healthy · ${warning} warning · ${critical} critical · ${idle} idle`;

  return {
    healthy,
    warning,
    critical,
    idle,
    total,
    label
  };
}
