import { useState, useEffect, useCallback } from 'react';
import type { ActivityEvent } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { useLiveTimeline } from '@/lib/useLiveTimeline';
import { formatUpdatedAgo } from '@/lib/timelinePacing';
import { formatTimestamp, type TimestampFormat } from '@/lib/formatTimestamp';

export function ActivityTimeline({ timestampFormat }: { timestampFormat: TimestampFormat }) {
  const [filtered, setFiltered] = useState<ActivityEvent[]>([]);
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [agentFilter, setAgentFilter] = useState<string>('all');
  const [hostFilter, setHostFilter] = useState<string>('all');
  const [limit, setLimit] = useState(100);
  // Re-render once per second so the "Updated Ns ago" label stays fresh.
  const [now, setNow] = useState(() => Date.now());

  const {
    events,
    loading,
    refreshing,
    isLive,
    setIsLive,
    lastUpdated,
    refresh,
  } = useLiveTimeline(limit);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Extract unique values for filters
  const allTypes = Array.from(new Set(events.map((e) => e.type)));
  const allAgents = Array.from(new Set(events.map((e) => e.container).filter(Boolean)));
  const allHosts = Array.from(new Set(events.map((e) => e.host).filter(Boolean)));

  // Apply filters
  useEffect(() => {
    let result = events;

    if (typeFilter !== 'all') {
      result = result.filter((e) => e.type === typeFilter);
    }

    if (agentFilter !== 'all') {
      result = result.filter((e) => e.container === agentFilter);
    }

    if (hostFilter !== 'all') {
      result = result.filter((e) => e.host === hostFilter);
    }

    setFiltered(result);
  }, [events, typeFilter, agentFilter, hostFilter]);

  // Group events by time period
  const groupedEvents = useCallback((events: ActivityEvent[]) => {
    const groups: { [key: string]: ActivityEvent[] } = {};
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    const oneDay = 24 * oneHour;
    const twoDays = 2 * oneDay;

    events.forEach((event) => {
      const eventTime = new Date(event.timestamp).getTime();
      const diff = now - eventTime;

      let groupKey: string;
      if (diff < oneHour) {
        groupKey = 'Last hour';
      } else if (diff < oneDay) {
        groupKey = 'Today';
      } else if (diff < twoDays) {
        groupKey = 'Yesterday';
      } else if (diff < 7 * oneDay) {
        groupKey = 'This week';
      } else {
        groupKey = 'Older';
      }

      if (!groups[groupKey]) {
        groups[groupKey] = [];
      }
      groups[groupKey].push(event);
    });

    return groups;
  }, []);

  const grouped = groupedEvents(filtered);

  const renderEvent = (event: ActivityEvent) => {
    const typeColors = {
      directive_proposed: 'text-blue-500',
      attached: 'text-green-500',
      ended: 'text-orange-500',
      error: 'text-red-500',
      snapshot: 'text-purple-500',
      agent_started: 'text-emerald-500',
      agent_ended: 'text-orange-500',
      agent_session_up: 'text-green-500',
      agent_session_down: 'text-amber-500',
      host_error: 'text-red-500',
      host_ok: 'text-sky-500',
    };

    const icons = {
      directive_proposed: '💬',
      attached: '🔌',
      ended: '🔌',
      error: '⚠️',
      snapshot: '📸',
      agent_started: '🟢',
      agent_ended: '🔴',
      agent_session_up: '▶️',
      agent_session_down: '⏹️',
      host_error: '🚫',
      host_ok: '✅',
    };

    const renderDetails = () => {
      switch (event.type) {
        case 'directive_proposed':
          return (
            <div className="text-sm">
              <span className="font-medium">{event.role || 'Agent'}</span>
              <span className="text-muted-foreground mx-1">→</span>
              <span className="font-mono text-xs bg-muted px-1 rounded">{event.directive?.slice(0, 60)}...</span>
            </div>
          );
        case 'attached':
          return (
            <div className="text-sm">
              <span className="font-mono text-xs bg-muted px-1 rounded">{event.id}</span>
              <span className="text-muted-foreground mx-1">attached to</span>
              <span className="font-medium">{event.container}</span>
            </div>
          );
        case 'ended':
          return (
            <div className="text-sm">
              <span className="font-mono text-xs bg-muted px-1 rounded">{event.id}</span>
              <span className="text-muted-foreground mx-1">ended</span>
              {event.code !== undefined && <span className="font-mono text-xs">(exit: {event.code})</span>}
            </div>
          );
        case 'error':
          return (
            <div className="text-sm">
              <span className="text-red-600">{event.error}</span>
              {event.context && <span className="text-muted-foreground ml-1">(context: {event.context})</span>}
            </div>
          );
        case 'snapshot':
          return (
            <div className="text-sm">
              <span className="font-mono text-xs bg-muted px-1 rounded">{event.id}</span>
              <span className="text-muted-foreground mx-1">pane updated</span>
            </div>
          );
        case 'agent_started':
        case 'agent_ended':
        case 'agent_session_up':
        case 'agent_session_down':
          return (
            <div className="text-sm flex items-center gap-1 flex-wrap">
              <span className="font-medium">{event.role || 'agent'}</span>
              {event.container && <span className="font-mono text-xs bg-muted px-1 rounded">{event.container}</span>}
              {event.project && <span className="text-muted-foreground text-xs">({event.project})</span>}
            </div>
          );
        case 'host_error':
          return <div className="text-sm text-red-600">host unreachable</div>;
        case 'host_ok':
          return <div className="text-sm text-muted-foreground">host reachable</div>;
        default:
          return null;
      }
    };

    return (
      <div key={event.timestamp} className="flex items-start gap-2 py-2 px-3 hover:bg-muted/50 rounded-lg transition-colors">
        <span className="text-lg">{icons[event.type] || '📌'}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={`text-xs font-semibold uppercase ${typeColors[event.type] || 'text-muted-foreground'}`}>
              {event.type.replace('_', ' ')}
            </span>
            <span className="text-xs text-muted-foreground">{formatTimestamp(event.timestamp, timestampFormat)}</span>
            {event.host && (
              <span className="text-xs font-mono text-muted-foreground bg-muted px-1 rounded">{event.host}</span>
            )}
          </div>
          {renderDetails()}
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header with filters */}
      <div className="flex-shrink-0 p-3 border-b space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Activity Timeline</h2>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setIsLive((v) => !v)}
              title={isLive ? 'Pause live updates' : 'Resume live updates'}
            >
              <span
                className={`inline-block size-2 rounded-full mr-1.5 ${
                  isLive ? 'bg-green-500 animate-pulse' : 'bg-muted-foreground'
                }`}
              />
              {isLive ? 'Live' : 'Paused'}
            </Button>
            <Button size="sm" variant="outline" onClick={refresh} disabled={loading || refreshing}>
              {refreshing ? 'Refreshing...' : 'Refresh'}
            </Button>
          </div>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="text-xs bg-muted border-0 rounded px-2 py-1"
          >
            <option value="all">All Types</option>
            {allTypes.map((t) => (
              <option key={t} value={t}>
                {t.replace('_', ' ')}
              </option>
            ))}
          </select>

          <select
            value={hostFilter}
            onChange={(e) => setHostFilter(e.target.value)}
            className="text-xs bg-muted border-0 rounded px-2 py-1"
          >
            <option value="all">All Hosts</option>
            {allHosts.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>

          <select
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
            className="text-xs bg-muted border-0 rounded px-2 py-1"
          >
            <option value="all">All Agents</option>
            {allAgents.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>

          <select
            value={String(limit)}
            onChange={(e) => setLimit(parseInt(e.target.value, 10))}
            className="text-xs bg-muted border-0 rounded px-2 py-1"
          >
            <option value="50">Last 50</option>
            <option value="100">Last 100</option>
            <option value="500">Last 500</option>
            <option value="1000">Last 1000</option>
          </select>
        </div>

        {/* Stats */}
        <div className="text-xs text-muted-foreground">
          Showing {filtered.length} of {events.length} events
          {!isLive
            ? ' · Paused'
            : lastUpdated
              ? ` · Updated ${formatUpdatedAgo(now, lastUpdated)}`
              : ''}
        </div>
      </div>

      {/* Event list */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {loading ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            Loading activity...
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            No activity recorded yet
          </div>
        ) : (
          <div className="p-2 space-y-4">
            {Object.entries(grouped).map(([groupName, groupEvents]) => (
              <div key={groupName}>
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 px-1">
                  {groupName}
                </h3>
                <div className="space-y-1">{groupEvents.map(renderEvent)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
