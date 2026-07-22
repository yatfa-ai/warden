// Health utility functions for frontend

import type { Chat } from '@/lib/types';

export const HealthState = {
  HEALTHY: 'healthy',
  WARNING: 'warning',
  CRITICAL: 'critical',
  IDLE: 'idle',
  CLOSED: 'closed',
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
    case HealthState.CLOSED:
      // One shade darker than IDLE (gray-400): a closed (dead) session reads as
      // "more final" than an idle (waiting) one, while staying in the neutral gray
      // family. The distinct glyph (■ vs ○) is the non-color WCAG lever.
      return 'text-gray-500';
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
    case HealthState.CLOSED:
      return 'bg-gray-600';
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
    case HealthState.CLOSED:
      return 'Closed';
    default:
      return 'Unknown';
  }
}

/**
 * Get health state icon/indicator — a non-color cue used alongside color so
 * state survives grayscale / color-vision deficiency (WCAG 1.4.1).
 * Each glyph is distinct (healthy `✓` vs critical `✕`, unlike the old `●`/`●`).
 * Closed uses `■` (a filled block = stopped/terminated), distinct from idle's
 * open `○` (waiting). (WARDEN-245)
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
    case HealthState.CLOSED:
      return '■';
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
    closed: HealthState.CLOSED,
    unknown: HealthState.UNKNOWN,
  };
  return validStates[state.toLowerCase()] ?? HealthState.UNKNOWN;
}

// ---- Resource load coloring (shared by per-agent + per-host surfaces) ----

/**
 * Color a resource reading so a runaway (CPU- or memory-burning) agent — or, at
 * the host level (WARDEN-361), an overloaded host — pops in a dense fleet.
 *
 * CPU% is host-wide — on an N-core host one fully-burned core reads ~100/N — so
 * the bands are heuristic; memory is NOT diluted across cores and is the
 * stronger leak/OOM signal. A single band definition colors every resource
 * surface the same way: the per-agent ResourceChip in HealthDashboard
 * (WARDEN-309), the rolled-up host header line, and the ＋ new-chat picker
 * annotation (WARDEN-361). Elevated = CPU OR mem ≥ 80 (amber); ≥ 90 (red).
 *
 * Pure (no imports) so it loads standalone under the OXC test harness and can be
 * unit-tested like the host helpers below. Pass `undefined` (per-agent chip, field
 * absent) OR `null` (host roll-up, no agent had stats) for a missing reading and
 * it is treated as 0 (never trips a band on its own).
 */
export function resourceTone(cpuPct?: number | null, memPct?: number | null): string {
  const cpu = cpuPct ?? 0;
  const mem = memPct ?? 0;
  if (cpu >= 90 || mem >= 90) return 'text-red-500';
  if (cpu >= 80 || mem >= 80) return 'text-yellow-500';
  return 'text-muted-foreground';
}

// ---- Host grouping (Fleet Health Dashboard "Group by: Host" — WARDEN-237) ----

/** Per-host connectivity, as returned by /api/hosts/status. */
export type HostConnectivityStatus = 'online' | 'offline' | 'unknown';

// ---- Companion transport state (WARDEN-878 / roadmap WARDEN-270 Visibility) ----
// Per-host companion transport status, surfaced alongside the connectivity dot so
// the human can tell at a glance whether the companion is working on each host.
// `companion` is present on HostConnectivity ONLY when the companion transport is
// enabled (server.ts omits the field when the toggle is off); `inactive` covers
// LOCAL + a host no companion op has engaged yet. Mirrors src/companion.js's
// getCompanionStatus shape exactly (state + optional version/lastError/lastErrorAt).
export type CompanionState = 'active' | 'bootstrapping' | 'inactive' | 'error';

export interface CompanionStatus {
  state: CompanionState;
  /** Ping-verified companion manifest version (active only). */
  version?: string;
  /** Actionable last bootstrap error + recovery hint (error only). */
  lastError?: string;
  /** Epoch ms of the last failure (error only). */
  lastErrorAt?: number;
}

export interface HostConnectivity {
  status: HostConnectivityStatus;
  latency_ms: number | null;
  /** Per-host companion transport state (present only when the transport is enabled). */
  companion?: CompanionStatus;
}

/**
 * Safely normalize an arbitrary companion-status object (from the wire) to a valid
 * CompanionStatus. Missing/garbage state collapses to 'inactive' (the same
 * "not applicable / not yet engaged" read the server emits) instead of crashing
 * the render. Only known state strings pass through; version/lastError/lastErrorAt
 * are carried only when correctly typed. (WARDEN-878)
 */
export function normalizeCompanionStatus(raw: unknown): CompanionStatus {
  if (!raw || typeof raw !== 'object') return { state: 'inactive' };
  const r = raw as Record<string, unknown>;
  const VALID: CompanionState[] = ['active', 'bootstrapping', 'inactive', 'error'];
  const state = typeof r.state === 'string' && (VALID as string[]).includes(r.state)
    ? (r.state as CompanionState)
    : 'inactive';
  const out: CompanionStatus = { state };
  if (typeof r.version === 'string') out.version = r.version;
  if (typeof r.lastError === 'string') out.lastError = r.lastError;
  if (typeof r.lastErrorAt === 'number') out.lastErrorAt = r.lastErrorAt;
  return out;
}

/** Count of agents in each health state on one host. */
export interface HostHealthCounts {
  healthy: number;
  warning: number;
  critical: number;
  idle: number;
  closed: number;
  unknown: number;
}

/** One host's bucket: its agents plus a per-health-state tally. */
export interface HostHealthGroup {
  host: string;
  agents: Chat[];
  counts: HostHealthCounts;
}

const EMPTY_COUNTS: HostHealthCounts = { healthy: 0, warning: 0, critical: 0, idle: 0, closed: 0, unknown: 0 };

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

// ---- Project grouping (Fleet Health Dashboard "Group by: Project" — WARDEN-741) ----

/**
 * One project's bucket: its agents plus a per-health-state tally. Mirrors
 * `HostHealthGroup` exactly (same counts shape) so the Host section's render
 * treatment transfers verbatim — only the bucket key (`project` vs `host`)
 * differs. Reuses `HostHealthCounts` (the shared health-tally shape, host-named
 * only by history) rather than introducing a duplicate identical interface.
 */
export interface ProjectHealthGroup {
  project: string;
  agents: Chat[];
  counts: HostHealthCounts;
}

/**
 * Bucket agents by project and tally each health state per project (WARDEN-741).
 *
 * The Project grouping mode answers "which of my projects is healthy vs. stuck
 * right now?" without mentally slicing the flat/host list by the per-row project
 * badge. Mirrors `groupByHost` end-to-end (WARDEN-237): buckets by a per-agent
 * key, tallies per-health-state via `normalizeHealthState`, reuses `EMPTY_COUNTS`,
 * and preserves input order within a project (the caller re-sorts if it wants
 * health-dot ordering). Agents with a missing project fall back to '(no project)'
 * — the project analog of `groupByHost`'s '(local)' host fallback — so a record
 * missing its project badge never falls through the cracks.
 *
 * Pure (no React, no fetch) so it loads standalone under the OXC test harness.
 */
export function groupByProject(agents: Chat[]): ProjectHealthGroup[] {
  const map = new Map<string, ProjectHealthGroup>();
  for (const agent of agents) {
    const project = agent.project || '(no project)';
    let group = map.get(project);
    if (!group) {
      group = { project, agents: [], counts: { ...EMPTY_COUNTS } };
      map.set(project, group);
    }
    group.agents.push(agent);
    group.counts[normalizeHealthState(agent.healthState)] += 1;
  }
  return [...map.values()];
}

/**
 * Degraded-first ordering for project sections (WARDEN-741, extended WARDEN-780):
 * a human running multiple projects needs the worst project on top. Same priority
 * ladder as `compareHostGroups` (WARDEN-237), now INCLUDING the connectivity axis:
 *   1. Projects with ANY agent on an offline host first — the #1 Host-mode
 *      signal, surfaced in Project mode too (WARDEN-780). A project spans hosts,
 *      so the signal is "does any of its hosts read offline" rather than a single
 *      host status: a project counts as "has offline host" if ANY of its agents
 *      sits on a host whose connectivity is `'offline'`.
 *   2. Then critical-heavy projects (more critical agents = worse).
 *   3. Then by total agent count (bigger project = bigger blast radius).
 *   4. Then by project name (stable, deterministic tiebreak).
 *
 * `connectivityOf(host)` maps a host name to its online/offline/unknown status
 * from the /api/hosts/status poll; a host with no record is treated as 'unknown'
 * (neutral — NOT prioritized as offline), exactly as `compareHostGroups`
 * documents. It defaults to "no connectivity info" (`() => undefined`), so the
 * pre-WARDEN-780 call shape `compareProjectGroups(a, b)` — and the lower ladder
 * it exercised — still works unchanged. Pure and unit-tested alongside
 * `compareHostGroups`.
 */
export function compareProjectGroups(
  a: ProjectHealthGroup,
  b: ProjectHealthGroup,
  connectivityOf: (host: string) => HostConnectivityStatus | undefined = () => undefined,
): number {
  const aHasOffline = projectHasOfflineHost(a, connectivityOf) ? 0 : 1;
  const bHasOffline = projectHasOfflineHost(b, connectivityOf) ? 0 : 1;
  if (aHasOffline !== bHasOffline) return aHasOffline - bHasOffline;                         // offline-host project first (WARDEN-780)
  if (a.counts.critical !== b.counts.critical) return b.counts.critical - a.counts.critical; // critical-heavy next
  if (a.agents.length !== b.agents.length) return b.agents.length - a.agents.length;         // bigger projects next
  if (a.project < b.project) return -1;                                                      // stable name tiebreak
  if (a.project > b.project) return 1;
  return 0;
}

/**
 * Does any of this project's agents sit on a host whose connectivity is offline?
 * (WARDEN-780.) Reuses `groupByHost`'s `agent.host || '(local)'` fallback so a
 * record missing its host is checked against its effective host. Module-private:
 * only `compareProjectGroups` needs this verdict.
 */
function projectHasOfflineHost(
  group: ProjectHealthGroup,
  connectivityOf: (host: string) => HostConnectivityStatus | undefined,
): boolean {
  for (const agent of group.agents) {
    const host = agent.host || '(local)';
    if (connectivityOf(host) === 'offline') return true;
  }
  return false;
}

// ---- Per-project host span (Fleet Health "Group by: Project" — WARDEN-780) ----

/**
 * One host a project's agents span, with that host's connectivity + a count of
 * how many of the project's agents sit on it (WARDEN-780). The per-project
 * analog of the Host section's single connectivity dot — but a project can span
 * MANY hosts, so the "host span" is a LIST: one entry per distinct host, each
 * with its own online/offline dot and an agent count, so a coordinator in
 * Project mode can see whether a project's agents are co-located or scattered
 * (and spot one sitting partly on a DOWN host) without switching to Host mode.
 */
export interface ProjectHostSpan {
  host: string;
  status: HostConnectivityStatus;
  latency_ms: number | null;
  agentCount: number;
  /** Per-host companion transport state, the same field the Host header's dot reads. (WARDEN-878) */
  companion?: CompanionStatus;
}

/**
 * Summarize the SET of hosts a project's agents span (WARDEN-780): one
 * `ProjectHostSpan` per distinct host the project's agents run on (reusing
 * `groupByHost`'s `agent.host || '(local)'` fallback so a record missing its
 * host never falls through the cracks), each carrying that host's connectivity
 * and a count of how many of the project's agents sit on it.
 *
 * Ordered offline-first (a down host in the project surfaces first — the #1
 * signal from Host mode), then by agent count desc (a host holding more of the
 * project's agents is the more representative one), then by host name (stable) —
 * mirroring `compareHostGroups`' degraded-first rationale. A host with no
 * `hostStatuses` record resolves to `'unknown'` (neutral — NOT treated as
 * offline), exactly as `compareHostGroups` documents.
 *
 * `connectivityOf(host)` returns the full `HostConnectivity` (status + latency)
 * from the /api/hosts/status poll, or `undefined` when there is no record — the
 * helper needs the full object (not just status) so each span carries the
 * latency that the render folds into the dot's `title`. Pure (no React, no
 * fetch), unit-tested alongside `groupByProject` / `compareProjectGroups`.
 * Mirrors `summarizeHostLoad`'s purity discipline (return a complete summary
 * object the caller renders verbatim).
 */
export function summarizeProjectHosts(
  agents: Chat[],
  connectivityOf: (host: string) => HostConnectivity | undefined,
): ProjectHostSpan[] {
  const counts = new Map<string, number>();
  for (const agent of agents) {
    const host = agent.host || '(local)';
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  const spans: ProjectHostSpan[] = [];
  for (const [host, agentCount] of counts) {
    const conn = connectivityOf(host);
    spans.push({
      host,
      status: conn?.status ?? 'unknown',
      latency_ms: conn?.latency_ms ?? null,
      agentCount,
      // WARDEN-878: carry the companion field through so the Project-mode host
      // span shows the same per-host transport state the Host header does.
      ...(conn?.companion ? { companion: conn.companion } : {}),
    });
  }
  spans.sort((a, b) => {
    const aOffline = a.status === 'offline' ? 0 : 1;
    const bOffline = b.status === 'offline' ? 0 : 1;
    if (aOffline !== bOffline) return aOffline - bOffline;                  // offline host first
    if (a.agentCount !== b.agentCount) return b.agentCount - a.agentCount;  // more agents next
    if (a.host < b.host) return -1;                                         // stable name tiebreak
    if (a.host > b.host) return 1;
    return 0;
  });
  return spans;
}

// ---- Per-host resource load roll-up (WARDEN-361) ----

/**
 * Rolled-up resource load for one host's agents (WARDEN-361). `agentCount` is
 * every agent on the host (the denominator); `avgCpu` / `memPct` are null when
 * none of those agents carry docker-stats data.
 */
export interface HostLoadSummary {
  agentCount: number;
  /** Mean of the present cpuPct values, or null if no agent has stats. */
  avgCpu: number | null;
  /** Max memPct across agents, or null if no agent has stats. */
  memPct: number | null;
}

/**
 * Roll one host's agents up to a single resource-load summary, so a fleet
 * manager can spot an overloaded host WITHOUT expanding rows or mentally summing
 * N per-agent chips — surfaced in the Fleet Health "Group by: Host" header and
 * the ＋ new-chat host picker (WARDEN-361), on top of the per-agent capture from
 * WARDEN-309 already cache-carried into /api/health.
 *
 * Aggregate semantics (chosen, not arbitrary):
 *   - avgCpu = MEAN of present cpuPct values. CPU% is host-wide (a fully-burned
 *     core on an N-core host reads ~100/N), so the mean is a fair "how busy is
 *     this host's fleet" reading.
 *   - memPct = MAX (deliberately not mean) of present memPct values. Memory is
 *     the strong leak/OOM signal and is not diluted; a single memory-hogging
 *     container is the actionable thing a human must see. Averaging would hide
 *     the hog — 8 agents averaging ~11% mem masks the one container at 95% that
 *     is about to OOM the host. Max surfaces it.
 *
 * Both aggregates are null when NO agent on the host carries docker-stats data
 * (bare-tmux/manual agents, non-yatfa containers, hosts whose stats failed), so
 * the caller renders exactly nothing — matching ResourceChip's graceful-N/A
 * pattern (fields simply absent, no broken chips).
 *
 * Pure (no React, no fetch), unit-tested alongside groupByHost / compareHostGroups.
 */
export function summarizeHostLoad(agents: Chat[]): HostLoadSummary {
  let cpuSum = 0;
  let cpuN = 0;
  let memMax: number | null = null;
  for (const a of agents) {
    if (a.cpuPct != null) {
      cpuSum += a.cpuPct;
      cpuN += 1;
    }
    if (a.memPct != null && (memMax === null || a.memPct > memMax)) {
      memMax = a.memPct;
    }
  }
  return {
    agentCount: agents.length,
    avgCpu: cpuN > 0 ? cpuSum / cpuN : null,
    memPct: memMax,
  };
}
