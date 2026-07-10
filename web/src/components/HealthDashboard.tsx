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
  type HealthStateValue,
  type HostHealthGroup,
} from '@/lib/healthUtils';
import { StatusDot, type StatusTone } from '@/components/StatusDot';
import { useHostStatuses } from '@/lib/useHostStatuses';

interface Props {
  onOpenChat: (id: string) => void;
  onClose: () => void;
}

const HEALTH_SECTION_ORDER = ['healthy', 'warning', 'critical', 'idle', 'unknown'] as const;

const SECTION_LABELS: Record<string, { title: string; color: string; icon: string }> = {
  healthy: { title: 'Healthy Agents', color: 'text-green-500', icon: '●' },
  warning: { title: 'Warning Agents', color: 'text-yellow-500', icon: '◐' },
  critical: { title: 'Critical Agents', color: 'text-red-500', icon: '●' },
  idle: { title: 'Idle Sessions', color: 'text-gray-500', icon: '○' },
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
  [HealthState.UNKNOWN]: 'text-muted-foreground',
};

type GroupMode = 'health' | 'host';

function ago(ms: number) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
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
    default:
      return 'muted';
  }
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

export function HealthDashboard({ onOpenChat, onClose }: Props) {
  const [healthData, setHealthData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Host view is additive — Health stays the default so the existing dashboard
  // is unchanged unless a human opts into the per-host view (WARDEN-237).
  const [groupBy, setGroupBy] = useState<GroupMode>('health');
  const [collapsedHosts, setCollapsedHosts] = useState<Record<string, boolean>>({});
  // Shared /api/hosts/status poll (singleton) — fuses per-host connectivity into
  // each host section's summary line.
  const hostStatuses = useHostStatuses();

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

      {/* Last Activity */}
      {agent.lastActivity && (
        <span className="text-[10px] text-muted-foreground">
          {ago(agent.lastActivity)} ago
        </span>
      )}
    </button>
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0">
        <span className="font-semibold tracking-wide text-sm">Fleet Health</span>
        <div className="ml-auto flex items-center gap-1.5">
          {/* Group-by toggle (WARDEN-237): Health (default, no regression) / Host */}
          <div
            className="flex items-center rounded-md border border-border overflow-hidden"
            role="group"
            aria-label="Group agents by"
          >
            <button
              onClick={() => setGroupBy('health')}
              aria-pressed={groupBy === 'health'}
              title="Group agents by health state"
              className={`px-1.5 py-0.5 text-[10px] transition-colors ${groupBy === 'health' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >Health</button>
            <button
              onClick={() => setGroupBy('host')}
              aria-pressed={groupBy === 'host'}
              title="Group agents by host, with connectivity + health distribution"
              className={`px-1.5 py-0.5 text-[10px] transition-colors ${groupBy === 'host' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >Host</button>
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
        <ScrollArea className="flex-1 min-h-0">
          <div className="p-2 flex flex-col gap-3">
            {groupBy === 'health' ? (
              HEALTH_SECTION_ORDER.filter(section => {
                const agents = healthData.groups[section];
                return agents && agents.length > 0;
              }).map(section => {
                const agents = healthData.groups[section];
                const sectionInfo = SECTION_LABELS[section];
                const count = agents.length;

                return (
                  <div key={section} className="flex flex-col gap-1">
                    {/* Section Header */}
                    <div className={`px-2 py-1 text-[10px] uppercase tracking-wider font-semibold ${sectionInfo.color}`}>
                      {sectionInfo.icon} {sectionInfo.title} ({count})
                    </div>

                    {/* Agent List */}
                    <div className="flex flex-col gap-0.5">
                      {agents.map(agent => renderAgent(agent, true))}
                    </div>
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

                  return (
                    <div key={group.host} className="flex flex-col gap-1">
                      {/* Per-host summary line: connectivity fused with health distribution */}
                      <button
                        onClick={() => setCollapsedHosts(prev => ({ ...prev, [group.host]: !prev[group.host] }))}
                        aria-expanded={!collapsed}
                        aria-label={`${hostLabel}: ${group.agents.length} agent${group.agents.length !== 1 ? 's' : ''}${collapsed ? ', expand' : ', collapse'}`}
                        title={collapsed ? 'Expand host' : 'Collapse host'}
                        className="flex items-center gap-1.5 px-2 py-1 rounded-md text-left hover:bg-accent/60 transition-colors w-full"
                      >
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
                        <span className="text-xs font-semibold truncate">
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
                        {/* Health distribution — only non-zero states, colored to match the summary bar */}
                        {dist.length > 0 && (
                          <span className="flex items-center gap-1.5 ml-auto shrink-0">
                            {dist.map(s => (
                              <span key={s} className={`text-[10px] ${HEALTH_DIST_COLOR[s]}`}>
                                {group.counts[s]} {formatHealthState(s).toLowerCase()}
                              </span>
                            ))}
                          </span>
                        )}
                      </button>

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
          Last updated: {new Date(healthData.timestamp).toLocaleTimeString()}
        </div>
      )}
    </div>
  );
}
