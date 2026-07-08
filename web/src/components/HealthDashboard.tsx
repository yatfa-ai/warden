import { useState, useEffect } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { HealthBadge } from './HealthBadge';
import type { HealthData } from '@/lib/types';
import { getHealthBgColor, HealthState } from '@/lib/healthUtils';
import type { HealthStateValue } from '@/lib/healthUtils';

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

function ago(ms: number) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// Safely normalize health state to a valid HealthStateValue
function normalizeHealthState(state: string | undefined): HealthStateValue {
  if (!state) return HealthState.UNKNOWN;
  // Check if the state is a valid HealthStateValue
  const validStates: Record<string, HealthStateValue> = {
    healthy: HealthState.HEALTHY,
    warning: HealthState.WARNING,
    critical: HealthState.CRITICAL,
    idle: HealthState.IDLE,
    unknown: HealthState.UNKNOWN
  };
  return validStates[state.toLowerCase()] ?? HealthState.UNKNOWN;
}

export function HealthDashboard({ onOpenChat, onClose }: Props) {
  const [healthData, setHealthData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0">
        <span className="font-semibold tracking-wide text-sm">Fleet Health</span>
        <button className="text-xs text-muted-foreground hover:text-foreground ml-auto" onClick={fetchHealth} disabled={loading}>
          {loading ? '…' : '↻'}
        </button>
        <button className="text-xs text-muted-foreground hover:text-foreground" onClick={onClose}>
          ×
        </button>
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

      {/* Health Groups */}
      {healthData && (
        <ScrollArea className="flex-1 min-h-0">
          <div className="p-2 flex flex-col gap-3">
            {HEALTH_SECTION_ORDER.filter(section => {
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
                    {agents.map(agent => (
                      <button
                        key={agent.id}
                        onClick={() => onOpenChat(agent.id)}
                        className="flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-xs hover:bg-accent transition-colors"
                      >
                        {/* Status Indicator */}
                        <span className={`size-2 rounded-full shrink-0 ${getHealthBgColor(normalizeHealthState(agent.healthState))}`} />

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
                        {agent.host !== '(local)' && (
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

                        {/* Health Badge */}
                        {agent.healthState && (
                          <HealthBadge state={normalizeHealthState(agent.healthState)} showLabel={false} size="sm" />
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
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
