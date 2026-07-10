// Health utility functions for frontend

import type { Chat } from '@/lib/types';

export const HealthState = {
  HEALTHY: 'healthy',
  WARNING: 'warning',
  CRITICAL: 'critical',
  IDLE: 'idle',
  UNKNOWN: 'unknown'
} as const;

export type HealthStateValue = typeof HealthState[keyof typeof HealthState];

/**
 * Get color class for a health state
 */
export function getHealthColor(state: HealthStateValue): string {
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
 */
export function getHealthBgColor(state: HealthStateValue): string {
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
 */
export function formatHealthState(state: HealthStateValue): string {
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
 * Get health state icon/indicator — a non-color cue used alongside color so
 * state survives grayscale / color-vision deficiency (WCAG 1.4.1).
 * Each glyph is distinct (healthy `✓` vs critical `✕`, unlike the old `●`/`●`).
 */
export function getHealthIcon(state: HealthStateValue): string {
  switch (state) {
    case HealthState.HEALTHY:
      return '✓';
    case HealthState.WARNING:
      return '◐';
    case HealthState.CRITICAL:
      return '✕';
    case HealthState.IDLE:
      return '○';
    default:
      return '·';
  }
}

/**
 * Safely normalize an arbitrary health-state string (from the wire) to a valid
 * HealthStateValue. Missing/garbage states collapse to UNKNOWN instead of
 * crashing the grouping/tally logic. Shared by the dashboard's health-row
 * rendering and by groupByHost's per-host tally (WARDEN-237).
 */
export function normalizeHealthState(state: string | undefined): HealthStateValue {
  if (!state) return HealthState.UNKNOWN;
  const validStates: Record<string, HealthStateValue> = {
    healthy: HealthState.HEALTHY,
    warning: HealthState.WARNING,
    critical: HealthState.CRITICAL,
    idle: HealthState.IDLE,
    unknown: HealthState.UNKNOWN,
  };
  return validStates[state.toLowerCase()] ?? HealthState.UNKNOWN;
}

// ---- Host grouping (Fleet Health Dashboard "Group by: Host" — WARDEN-237) ----

/** Per-host connectivity, as returned by /api/hosts/status. */
export type HostConnectivityStatus = 'online' | 'offline' | 'unknown';

export interface HostConnectivity {
  status: HostConnectivityStatus;
  latency_ms: number | null;
}

/** Count of agents in each health state on one host. */
export interface HostHealthCounts {
  healthy: number;
  warning: number;
  critical: number;
  idle: number;
  unknown: number;
}

/** One host's bucket: its agents plus a per-health-state tally. */
export interface HostHealthGroup {
  host: string;
  agents: Chat[];
  counts: HostHealthCounts;
}

const EMPTY_COUNTS: HostHealthCounts = { healthy: 0, warning: 0, critical: 0, idle: 0, unknown: 0 };

/**
 * Bucket agents by host and tally each health state per host.
 *
 * Pure (no React, no fetch) so it can be unit-tested standalone, mirroring
 * buildAttentionRollup. Only hosts that actually have agent chats appear; the
 * agent order within a host is the input order (the caller re-sorts if it wants
 * health-dot ordering). Agents with a missing host fall back to '(local)' so a
 * malformed record never falls through the cracks.
 */
export function groupByHost(agents: Chat[]): HostHealthGroup[] {
  const map = new Map<string, HostHealthGroup>();
  for (const agent of agents) {
    const host = agent.host || '(local)';
    let group = map.get(host);
    if (!group) {
      group = { host, agents: [], counts: { ...EMPTY_COUNTS } };
      map.set(host, group);
    }
    group.agents.push(agent);
    group.counts[normalizeHealthState(agent.healthState)] += 1;
  }
  return [...map.values()];
}

/**
 * Degraded-first ordering for host sections (WARDEN-237): a human diagnosing a
 * distributed fleet needs the worst host on top, distinguishable from scattered
 * single-agent problems. Priority:
 *   1. Offline hosts first — a down host is the highest-signal finding.
 *   2. Then critical-heavy hosts (more critical agents = worse).
 *   3. Then by total agent count (bigger host = bigger blast radius).
 *   4. Then by host name (stable, deterministic tiebreak).
 *
 * `connectivityOf(host)` maps a host name to its online/offline/unknown status
 * from the /api/hosts/status poll; a host with no record is treated as 'unknown'
 * (neutral — NOT prioritized as offline). Pure and unit-tested.
 */
export function compareHostGroups(
  a: HostHealthGroup,
  b: HostHealthGroup,
  connectivityOf: (host: string) => HostConnectivityStatus | undefined,
): number {
  const aOffline = connectivityOf(a.host) === 'offline' ? 0 : 1;
  const bOffline = connectivityOf(b.host) === 'offline' ? 0 : 1;
  if (aOffline !== bOffline) return aOffline - bOffline;                 // offline first
  if (a.counts.critical !== b.counts.critical) return b.counts.critical - a.counts.critical; // critical-heavy next
  if (a.agents.length !== b.agents.length) return b.agents.length - a.agents.length;        // bigger hosts next
  if (a.host < b.host) return -1;                                        // stable name tiebreak
  if (a.host > b.host) return 1;
  return 0;
}
