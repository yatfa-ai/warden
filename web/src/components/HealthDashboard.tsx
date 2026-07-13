import { useState, useEffect, useMemo } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { HealthData, Chat } from '@/lib/types';
import {
  HealthState,
  getHealthIcon,
  formatHealthState,
  normalizeHealthState,
  groupByHost,
  compareHostGroups,
  resourceTone,
  summarizeHostLoad,
  type HealthStateValue,
  type HostHealthGroup,
} from '@/lib/healthUtils';
import { StatusDot, type StatusTone } from '@/components/StatusDot';
import { Sparkline } from '@/components/Sparkline';
import { formatTimestamp, type TimestampFormat } from '@/lib/formatTimestamp';
import { Button } from '@/components/ui/button';
import { useHostStatuses } from '@/lib/useHostStatuses';
import { useActivitySeries } from '@/lib/useActivitySeries';
import { buildAgentActivity, selectAgentSparkline } from '@/lib/agentSparkline';

interface Props {
  onOpenChat: (id: string) => void;
  onClose: () => void;
  // Timestamp format pref (WARDEN-213): routes the fleet last-activity + "Last
  // updated" times through the shared formatTimestamp helper. Pure client-side.
  timestampFormat: TimestampFormat;
}

// Closed sits between idle and unknown: a dead session is non-critical and less
// actionable than an idle (potentially waking) one, so it sinks toward the tail.
// (WARDEN-245)
const HEALTH_SECTION_ORDER = ['healthy', 'warning', 'critical', 'idle', 'closed', 'unknown'] as const;

const SECTION_LABELS: Record<string, { title: string; color: string; icon: string }> = {
  healthy: { title: 'Healthy Agents', color: 'text-green-500', icon: '●' },
  warning: { title: 'Warning Agents', color: 'text-yellow-500', icon: '◐' },
  critical: { title: 'Critical Agents', color: 'text-red-500', icon: '●' },
  idle: { title: 'Idle Sessions', color: 'text-gray-500', icon: '○' },
  closed: { title: 'Closed Sessions', color: 'text-gray-500', icon: '■' },
  unknown: { title: 'Unknown Status', color: 'text-muted-foreground', icon: '·' }
};

// Per-state text colors for the host-mode distribution line. Mirrors the fleet
// summary bar's -500 shades exactly so a per-host line reads as a per-host copy
// of the fleet summary, not a new color vocabulary.
const HEALTH_DIST_COLOR: Record<HealthStateValue, string> = {
  [HealthState.HEALTHY]: 'text-green-500',
  [HealthState.WARNING]: 'text-yellow-500',
  [HealthState.CRITICAL]: 'text-red-500',
  [HealthState.IDLE]: 'text-gray-500',
  [HealthState.CLOSED]: 'text-gray-500',
  [HealthState.UNKNOWN]: 'text-muted-foreground',
};

// The Closed section is bounded so dead catalog sessions can no longer flood the
// panel: 5 rows collapsed, 20 expanded max, with the true total always visible
// so the cap is never silent. (WARDEN-245)
const CLOSED_COLLAPSED_LIMIT = 5;
const CLOSED_EXPANDED_LIMIT = 20;

type GroupMode = 'health' | 'host';

// Compact "used" portion of a docker-stats MemUsage string like
// "310.2MiB / 2GiB" → "310.2MiB" (everything before the first ' / '). Returns ''
// when there's nothing to show, including docker's `--` placeholder (emitted for
// a container too new to have a sample) so a fresh container renders no chip
// rather than a confusing `--`. (WARDEN-309)
function memUsedShort(memUsage?: string): string {
  if (!memUsage) return '';
  const used = memUsage.split('/')[0].trim();
  if (!used || /^[-\s]*$/.test(used)) return '';
  return used;
}

// resourceTone() moved to healthUtils (WARDEN-361) so the single band definition
// also colors the per-host aggregate load line (renderHostLoad) and the ＋ new-chat
// picker annotation. Elevated = CPU OR mem ≥ 80 (amber); ≥ 90 (red). (WARDEN-309)

// Inline chip label: "42% · 310.2MiB" (rounded CPU% · used memory). Each part is
// included only when present, so a chat with only cpuPct still renders "42%".
// (WARDEN-309)
function resourceLabel(agent: Chat): string {
  const parts: string[] = [];
  if (agent.cpuPct != null) parts.push(`${Math.round(agent.cpuPct)}%`);
  const used = memUsedShort(agent.memUsage);
  if (used) parts.push(used);
  return parts.join(' · ');
}

// Full tooltip text for the resource chip: precise CPU%, mem%, and the raw
// used / total string. (WARDEN-309)
function resourceTitle(agent: Chat): string {
  const parts: string[] = [];
  if (agent.cpuPct != null) parts.push(`CPU ${agent.cpuPct.toFixed(1)}%`);
  if (agent.memPct != null) parts.push(`Mem ${agent.memPct.toFixed(1)}%`);
  if (agent.memUsage) parts.push(agent.memUsage);
  return parts.join(' · ');
}

// Rank a health state by its display order (healthy → unknown). Used to keep a
// host's agents in the same health-dot order the health-state view uses.
function healthRank(state: HealthStateValue): number {
  const i = HEALTH_SECTION_ORDER.indexOf(state);
  return i === -1 ? HEALTH_SECTION_ORDER.length : i;
}

/** Map a health state to a StatusDot color family. */
function healthTone(state: HealthStateValue): StatusTone {
  switch (state) {
    case HealthState.HEALTHY:
      return 'green';
    case HealthState.WARNING:
      return 'yellow';
    case HealthState.CRITICAL:
      return 'red';
    case HealthState.IDLE:
      return 'gray';
    case HealthState.CLOSED:
      // Same gray family as idle; the distinct glyph (■ vs ○) carries the
      // state under grayscale / CVD (WCAG 1.4.1). (WARDEN-245)
      return 'gray';
    default:
      return 'muted';
  }
}

// Most-recent last-known activity first, for ordering the bounded Closed section.
// Chats with no retained lastActivity sink to the bottom (stable among ties).
// (WARDEN-245)
function byRecencyDesc(a: Chat, b: Chat): number {
  const av = a.lastActivity ?? -Infinity;
  const bv = b.lastActivity ?? -Infinity;
  return bv - av;
}

/**
 * Health status indicator — pairs the health color with a distinct per-state
 * glyph (from getHealthIcon) plus an accessible name, so health state survives
 * grayscale / color-vision deficiency and is announced by screen readers.
 */
function HealthDot({ state }: { state: HealthStateValue }) {
  return (
    <StatusDot
      variant="glyph"
      glyph={getHealthIcon(state)}
      tone={healthTone(state)}
      label={formatHealthState(state)}
    />
  );
}

/**
 * Per-agent resource chip (CPU% · memory used) from `docker stats` (WARDEN-309).
 * Rendered ONLY when the chat carries a resource field — i.e. a yatfa docker
 * agent on a host whose `docker stats` succeeded. Bare-tmux/manual agents and
 * hosts whose stats failed render nothing (graceful N/A). Elevated usage
 * (CPU or mem ≥ 80%) is amber/red so a runaway is visible at a glance in a
 * 50-row fleet. `tabular-nums` keeps the digits equal-width so the chip doesn't
 * jitter as the numbers tick on refresh.
 */
function ResourceChip({ agent }: { agent: Chat }) {
  const label = resourceLabel(agent);
  if (!label) return null;
  return (
    <span
      className={`text-[10px] tabular-nums ${resourceTone(agent.cpuPct, agent.memPct)}`}
      title={resourceTitle(agent)}
    >
      {label}
    </span>
  );
}

export function HealthDashboard({ onOpenChat, onClose, timestampFormat }: Props) {
  const [healthData, setHealthData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Host view is additive — Health stays the default so the existing dashboard
  // is unchanged unless a human opts into the per-host view (WARDEN-237).
  const [groupBy, setGroupBy] = useState<GroupMode>('health');
  const [collapsedHosts, setCollapsedHosts] = useState<Record<string, boolean>>({});
  // Closed-section expansion (WARDEN-245): collapsed shows the 5 most-recent dead
  // sessions; expanded shows up to 20. The true total is always surfaced so the
  // cap is never silent.
  const [closedExpanded, setClosedExpanded] = useState(false);
  // Shared /api/hosts/status poll (singleton) — fuses per-host connectivity into
  // each host section's summary line.
  const hostStatuses = useHostStatuses();
  // Per-agent 24h activity series for the row sparklines (WARDEN-299). Fetched on
  // its own slow ~60s cadence inside the hook — explicitly NOT part of the 10s
  // /api/health poll below, so adding the sparklines is a no-op on the hot path.
  const { series: activitySeries } = useActivitySeries();

  const fetchHealth = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/health');
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      const data = await res.json();
      setHealthData(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchHealth();
    // Poll every 10 seconds for updates
    const interval = setInterval(fetchHealth, 10000);
    return () => clearInterval(interval);
  }, []);

  // Bucket agents by host, order hosts degraded-first (offline → critical-heavy
  // → agent count), and order each host's agents healthy → critical. Pure inputs
  // → cheap to memoize; recomputes when the catalog or connectivity changes.
  //
  // The `.sort()` calls mutate `groups` and each `g.agents` in place. That is safe
  // because `groupByHost` returns fresh arrays it owns (a new array per host, plus
  // a spread copy of EMPTY_COUNTS) — nothing here is shared with `healthData`, so
  // sorting cannot mutate the wire data. If `groupByHost` is ever refactored to
  // return shared/cached arrays, these sorts would silently mutate them — revisit.
  const hostGroups = useMemo<HostHealthGroup[]>(() => {
    if (!healthData) return [];
    const groups = groupByHost(healthData.agents);
    groups.sort((a, b) => compareHostGroups(a, b, (h) => hostStatuses[h]?.status));
    for (const g of groups) {
      g.agents.sort(
        (a, b) => healthRank(normalizeHealthState(a.healthState)) - healthRank(normalizeHealthState(b.healthState)),
      );
    }
    return groups;
  }, [healthData, hostStatuses]);

  // Per-agent 24h activity series for the row sparklines (WARDEN-299), joined by
  // `container`. Memoized on `activitySeries` ONLY — the 24h series refreshes on
  // its own ~60s cadence, so the 10s /api/health tick above never recomputes it
  // (the per-row join is a plain O(1) Map lookup in renderSparkline).
  const agentActivity = useMemo(() => buildAgentActivity(activitySeries), [activitySeries]);
  const bucketCount = activitySeries?.buckets.length ?? 0;

  // The per-row sparkline, or null. Delegates the three cases (no container →
  // none; container + events → real series; container + no events → idle flat
  // baseline) to the pure selectAgentSparkline so the logic is unit-testable.
  // Sized with spacing tokens and tightened under `.compact` to track row density.
  const renderSparkline = (agent: Chat) => {
    const sel = selectAgentSparkline(agent, agentActivity, bucketCount);
    if (!sel) return null;
    return (
      <Sparkline
        values={sel.values}
        errors={sel.errors}
        ariaLabel={sel.ariaLabel}
        className="w-14 h-4 compact:w-12 compact:h-3.5"
      />
    );
  };

  // One agent row, reused by both the health-state and host views. `showHost`
  // hides the per-row host tag in host mode (the section header already names
  // the host — a repeated tag would be noise).
  const renderAgent = (agent: Chat, showHost: boolean) => (
    <button
      key={agent.id}
      onClick={() => onOpenChat(agent.id)}
      className="flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-xs hover:bg-accent active:bg-accent/80 transition-colors"
    >
      {/* Status Indicator */}
      <HealthDot state={normalizeHealthState(agent.healthState)} />

      {/* Agent Name */}
      <span className="truncate flex-1">
        {agent.name || agent.key || agent.id}
      </span>

      {/* Role Badge for agents */}
      {agent.isAgent && agent.role && (
        <span className="text-[10px] text-blue-400">
          {agent.role}
        </span>
      )}

      {/* Host/Project Info */}
      {showHost && agent.host !== '(local)' && (
        <span className="text-[10px] text-muted-foreground">
          {agent.host}
        </span>
      )}

      {/* Activity sparkline (WARDEN-299). Only yatfa agents (which carry a
          container) sparkline; manual/tmux chats render nothing. An agent with
          events draws a bar series (error buckets tint red); an idle agent — a
          container with zero events in the window — draws a deliberately flat
          baseline, not a blank (criterion #1). See selectAgentSparkline. */}
      {renderSparkline(agent)}

      {/* Last Activity */}
      {agent.lastActivity && (
        <span className="text-[10px] text-muted-foreground">
          {formatTimestamp(agent.lastActivity, timestampFormat, { withSuffix: true })}
        </span>
      )}

      {/* Resource usage (WARDEN-309): per-agent CPU% / memory from `docker stats`,
          cache-carried from discover (zero SSH on this 10s poll). Renders nothing
          when the chat has no resource fields. */}
      <ResourceChip agent={agent} />
    </button>
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0">
        <span className="font-semibold tracking-wide text-sm">Fleet Health</span>
        <div className="ml-auto flex items-center gap-1.5">
          {/* Group-by toggle (WARDEN-237): Health (default, no regression) / Host.
              Two shadcn Buttons in a labelled group — the active option uses
              variant="secondary" so the selection reads at a glance, and size="xs"
              supplies the compact sizing (replacing the old magic-number
              px-1.5 py-0.5 text-[10px]). */}
          <div
            className="flex items-center rounded-md border border-border overflow-hidden"
            role="group"
            aria-label="Group agents by"
          >
            <Button
              variant={groupBy === 'health' ? 'secondary' : 'ghost'}
              size="xs"
              aria-pressed={groupBy === 'health'}
              onClick={() => setGroupBy('health')}
              title="Group agents by health state"
              className="rounded-none"
            >Health</Button>
            <Button
              variant={groupBy === 'host' ? 'secondary' : 'ghost'}
              size="xs"
              aria-pressed={groupBy === 'host'}
              onClick={() => setGroupBy('host')}
              title="Group agents by host, with connectivity + health distribution"
              className="rounded-none"
            >Host</Button>
          </div>
          <button className="text-xs text-muted-foreground hover:text-foreground active:scale-95 transition-all duration-150 ease-out" onClick={fetchHealth} disabled={loading}>
            {loading ? '…' : '↻'}
          </button>
          <button className="text-xs text-muted-foreground hover:text-foreground active:scale-95 transition-all duration-150 ease-out" onClick={onClose}>
            ×
          </button>
        </div>
      </div>

      {/* Summary Bar */}
      {healthData && (
        <div className="px-3 py-2 border-b bg-muted/30">
          <div className="flex items-center gap-2 text-xs">
            <span className="font-medium">{healthData.summary.total} agents</span>
            <span className="text-muted-foreground">·</span>
            <span className="text-green-500">{healthData.summary.healthy} healthy</span>
            <span className="text-yellow-500">{healthData.summary.warning} warning</span>
            <span className="text-red-500">{healthData.summary.critical} critical</span>
            <span className="text-gray-500">{healthData.summary.idle} idle</span>
            <span className="text-gray-500">{healthData.summary.closed} closed</span>
          </div>
        </div>
      )}

      {/* Error State */}
      {error && (
        <div className="p-4 text-center text-xs text-red-500">
          Failed to load health data: {error}
        </div>
      )}

      {/* Loading State */}
      {loading && !healthData && (
        <div className="p-4 text-center text-xs text-muted-foreground">
          Loading health data…
        </div>
      )}

      {/* Agent catalog */}
      {healthData && (
        <ScrollArea className="flex-1 min-h-0 health-fleet-scroll">
          <div className="p-2 flex flex-col gap-3 min-w-0">
            {groupBy === 'health' ? (
              HEALTH_SECTION_ORDER.filter(section => {
                const agents = healthData.groups[section];
                return agents && agents.length > 0;
              }).map(section => {
                const agents = healthData.groups[section];
                const sectionInfo = SECTION_LABELS[section];
                const count = agents.length;

                // Closed section is bounded + recency-ordered (WARDEN-245): dead
                // catalog sessions no longer flood the panel. Sort most-recent
                // last-known activity first; cap 5 collapsed / 20 expanded. The
                // total (count, in the header) is always shown so the cap is
                // never silent, and a "...and M more" note surfaces the 20-cap.
                const isClosed = section === 'closed';
                const ordered = isClosed ? [...agents].sort(byRecencyDesc) : agents;
                const limit = isClosed
                  ? (closedExpanded ? CLOSED_EXPANDED_LIMIT : CLOSED_COLLAPSED_LIMIT)
                  : agents.length;
                const shown = isClosed ? ordered.slice(0, limit) : ordered;
                const hiddenBeyondCap = isClosed ? count - shown.length : 0;
                const showToggle = isClosed && count > CLOSED_COLLAPSED_LIMIT;

                return (
                  <div key={section} className="flex flex-col gap-1">
                    {/* Section Header */}
                    <div className={`px-2 py-1 text-[10px] uppercase tracking-wider font-semibold ${sectionInfo.color}`}>
                      {sectionInfo.icon} {sectionInfo.title} ({count})
                    </div>

                    {/* Agent List */}
                    <div className="flex flex-col gap-0.5">
                      {shown.map(agent => renderAgent(agent, true))}
                    </div>

                    {/* Closed-section expansion toggle (WARDEN-245). Collapsed →
                        "show more (N total)"; expanded → "show less". The label
                        always carries the true total so the cap is never silent. */}
                    {showToggle && (
                      <button
                        type="button"
                        onClick={() => setClosedExpanded(v => !v)}
                        className="self-start px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-accent rounded-md transition-colors"
                        aria-expanded={closedExpanded}
                      >
                        {closedExpanded
                          ? 'show less'
                          : `show more (${count} total)`}
                      </button>
                    )}

                    {/* When expanded but the total exceeds the 20-row hard cap,
                        surface the remainder so the cap is explicit, not silent. */}
                    {isClosed && closedExpanded && hiddenBeyondCap > 0 && (
                      <div className="px-2 text-[10px] text-muted-foreground/70">
                        …and {hiddenBeyondCap} more (showing {shown.length} of {count})
                      </div>
                    )}
                  </div>
                );
              })
            ) : (
              hostGroups.length === 0 ? (
                <div className="p-4 text-center text-xs text-muted-foreground">No agents to group.</div>
              ) : (
                hostGroups.map(group => {
                  const status = hostStatuses[group.host];
                  const collapsed = !!collapsedHosts[group.host];
                  const dist = HEALTH_SECTION_ORDER.filter(s => group.counts[s] > 0);
                  const hostLabel = group.host === '(local)' ? 'local' : group.host;
                  // Per-host rolled-up CPU/mem (WARDEN-361): mean cpu, MAX mem, or
                  // null when no agent carries docker-stats. Rendered in the line-2
                  // distribution area so an overloaded host (≥90% mem) is red and
                  // identifiable WITHOUT expanding rows or scanning per-agent chips.
                  // agentCount already sits on line 1, so this only shows cpu/mem.
                  const load = summarizeHostLoad(group.agents);
                  const hasLoad = load.avgCpu != null || load.memPct != null;
                  const loadTitle = `Host load: ${load.avgCpu != null ? `${load.avgCpu.toFixed(0)}% avg CPU` : 'no CPU data'} · ${load.memPct != null ? `${load.memPct.toFixed(0)}% max mem` : 'no mem data'} (across ${load.agentCount} agent${load.agentCount !== 1 ? 's' : ''})`;

                  return (
                    <div key={group.host} className="flex flex-col gap-1 min-w-0">
                      {/*
                        Per-host header — TWO lines, so the health distribution
                        (the most diagnosis-relevant content) always has its own
                        line and is never squeezed by a long hostname.

                        Why two lines (UX): the dashboard panel is 320px
                        (HEALTH_WIDTH). Fusing connectivity + a long hostname + a
                        rich 5-segment distribution onto one line is noisy and
                        fragile; giving the distribution line 2 the full panel
                        width (indented under the hostname) keeps it legible. The
                        distribution line itself is `flex-wrap`, so a very wide
                        distribution (5 states, 3-digit counts) that still exceeds
                        the panel width wraps to a third line rather than clipping
                        — no segment is ever cut off.

                        Overflow handling is NOT done here — it lives in CSS. The
                        `health-fleet-scroll` class on the ScrollArea (above)
                        switches Radix's `display:table` viewport wrapper to
                        `display:block`, which gives the wrapper a DEFINITE width
                        (the panel width). Only against that definite width can
                        `truncate flex-1 min-w-0` on the hostname actually shrink
                        and ellipsize it — on its own (under the table wrapper's
                        indefinite, grow-to-max-content sizing) it does nothing,
                        and a long FQDN inflates the row past the panel and
                        hard-clips without an ellipsis. See the rule + trace in
                        index.css. The `min-w-0`s here are belt-and-suspenders.
                        (WARDEN-237)
                      */}
                      <Button
                        variant="ghost"
                        onClick={() => setCollapsedHosts(prev => ({ ...prev, [group.host]: !prev[group.host] }))}
                        aria-expanded={!collapsed}
                        aria-label={`${hostLabel}: ${group.agents.length} agent${group.agents.length !== 1 ? 's' : ''}${collapsed ? ', expand' : ', collapse'}`}
                        title={collapsed ? 'Expand host' : 'Collapse host'}
                        className="flex flex-col items-stretch justify-start gap-0.5 h-auto w-full min-w-0 px-2 py-1 rounded-md font-normal"
                      >
                        {/* Line 1: chevron + connectivity dot + host (truncates) + status + count */}
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="text-[10px] text-muted-foreground/60 w-2 shrink-0">{collapsed ? '▸' : '▾'}</span>
                          <StatusDot
                            tone={status?.status === 'online' ? 'green' : status?.status === 'offline' ? 'red' : 'gray'}
                            variant={status?.status === 'online' ? 'solid' : status?.status === 'offline' ? 'square' : 'ring'}
                            label={
                              status?.status === 'online'
                                ? `Online${status.latency_ms ? ` (${status.latency_ms}ms)` : ''}`
                                : status?.status === 'offline' ? 'Offline' : 'Unknown connectivity'
                            }
                            title={
                              status?.status === 'online' && status.latency_ms
                                ? `${status.status} (${status.latency_ms}ms)`
                                : status?.status || 'unknown'
                            }
                          />
                          <span className="text-xs font-semibold truncate flex-1 min-w-0">
                            {hostLabel}
                          </span>
                          <span className="text-[10px] text-muted-foreground shrink-0">
                            {status?.status ?? 'unknown'}
                            {status?.status === 'online' && status.latency_ms ? ` ${status.latency_ms}ms` : ''}
                          </span>
                          <span className="text-[10px] text-muted-foreground/50 shrink-0">·</span>
                          <span className="text-[10px] text-muted-foreground shrink-0">
                            {group.agents.length} agent{group.agents.length !== 1 ? 's' : ''}
                          </span>
                        </div>
                        {/* Line 2: health distribution + rolled-up resource load (WARDEN-361).
                            Only non-zero health states are shown, colored to match the summary
                            bar. The trailing resource segment reuses resourceTone bands (≥80
                            amber, ≥90 red) so a host whose agents collectively sit at ≥90% mem
                            is red here too. Indented (pl-7) to align under the hostname.
                            `flex-wrap` makes the line bulletproof against overflow: if a very
                            wide distribution (all 5 states, 3-digit counts) + the load segment
                            still exceeds the panel width, the excess wraps to a third line
                            instead of being clipped. Each segment is its own flex item, so a
                            wrapped segment stays whole (it never breaks mid-word). (WARDEN-237) */}
                        {(dist.length > 0 || hasLoad) && (
                          <div className="flex flex-wrap items-center gap-1.5 min-w-0 pl-7">
                            {dist.map(s => (
                              <span key={s} className={`text-[10px] ${HEALTH_DIST_COLOR[s]}`}>
                                {group.counts[s]} {formatHealthState(s).toLowerCase()}
                              </span>
                            ))}
                            {/* Per-host resource aggregate (WARDEN-361): "41% cpu · 87% mem",
                                mean cpu · MAX mem across the host's agents. Colored by resourceTone
                                so ≥90% mem reads red. Rendered ONLY when at least one agent carries
                                docker-stats (graceful N/A — a bare-tmux / stats-less host renders
                                nothing, exactly as today). `tabular-nums` keeps the digits steady. */}
                            {hasLoad && (
                              <span
                                className={`text-[10px] tabular-nums ${resourceTone(load.avgCpu, load.memPct)}`}
                                title={loadTitle}
                              >
                                {load.avgCpu != null && `${Math.round(load.avgCpu)}% cpu`}
                                {load.avgCpu != null && load.memPct != null && ' · '}
                                {load.memPct != null && `${Math.round(load.memPct)}% mem`}
                              </span>
                            )}
                          </div>
                        )}
                      </Button>

                      {/* Agents beneath, reusing the standard row */}
                      {!collapsed && (
                        <div className="flex flex-col gap-0.5">
                          {group.agents.map(agent => renderAgent(agent, false))}
                        </div>
                      )}
                    </div>
                  );
                })
              )
            )}
          </div>
        </ScrollArea>
      )}

      {/* Timestamp */}
      {healthData && (
        <div className="px-3 py-1 border-t text-[10px] text-muted-foreground text-center">
          Last updated: {formatTimestamp(healthData.timestamp, timestampFormat)}
        </div>
      )}
    </div>
  );
}
