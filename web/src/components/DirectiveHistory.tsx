import { useCallback, useEffect, useRef, useState } from 'react';
import { hostLabelFor } from '@/lib/chatDisplay';
import { useHostLabels } from '@/lib/hostLabels';
import type { Directive } from '@/lib/types';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { copyText } from '@/lib/clipboard';
import { toast } from 'sonner';
import { EmptyState } from './EmptyState';
import { MarkdownBody } from './MarkdownBody';
import { formatUpdatedAgo } from '@/lib/timelinePacing';
import { formatTimestamp, type TimestampFormat } from '@/lib/formatTimestamp';
import { POLL_INTERVAL_MS, shouldPoll, shouldRefreshOnVisibility } from '@/lib/timelinePacing';

// Read-only history of every directive that reached an agent (full text + target
// + time), sourced from the append-only directives.md via GET /api/directives.
// Mirrors ActivityTimeline's filter row (agent + host + limit) and its live/poll
// cadence (same tested timelinePacing helpers), so the two views read as one
// system. The directive text is the FULL body (not a 60-char snippet) in a
// scrollable MarkdownBody block — the whole point of this tab (see WARDEN-359).

const DIRECTIVE_POLL_MS = POLL_INTERVAL_MS; // directives change rarely, but a sent directive should appear live.

export function DirectiveHistory({
  timestampFormat,
  agentFilter, setAgentFilter,
  hostFilter, setHostFilter,
}: {
  timestampFormat: TimestampFormat;
  // WARDEN-879: the two filters are now OWNED by ObserverTabs (persisted across
  // restart via loadObs/saveObs) and passed in as controlled props. The Selects
  // and DirectiveEntry's context menu already call these setters, so they keep
  // working unchanged once the setters arrive from props instead of local useState.
  agentFilter: string;
  setAgentFilter: (v: string) => void;
  hostFilter: string;
  setHostFilter: (v: string) => void;
}) {
  const [directives, setDirectives] = useState<Directive[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isLive, setIsLive] = useState(true);
  const [isHidden, setIsHidden] = useState<boolean>(typeof document !== 'undefined' ? document.hidden : false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(100);
  // Re-render once per second so the "Updated Ns ago" label stays fresh.
  const [now, setNow] = useState(() => Date.now());

  const loadedRef = useRef(false);
  const isHiddenRef = useRef(isHidden);
  isHiddenRef.current = isHidden;

  const fetchDirectives = useCallback(
    async (opts?: { background?: boolean }) => {
      const background = opts?.background === true;
      if (background) setRefreshing(true);
      try {
        const res = await fetch(`/api/directives?limit=${limit}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        setDirectives(Array.isArray(j.directives) ? j.directives : []);
        setLastUpdated(Date.now());
        setError(null);
      } catch (e) {
        // Stale data is retained on a transient fetch error — never wipe a feed
        // the user is reading. Surface the error inline instead.
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (background) setRefreshing(false);
        else setLoading(false);
        loadedRef.current = true;
      }
    },
    [limit],
  );

  // Initial + on-limit-change fetch.
  useEffect(() => {
    loadedRef.current = false;
    setLoading(true);
    fetchDirectives();
  }, [fetchDirectives]);

  const refresh = useCallback(() => fetchDirectives({ background: true }), [fetchDirectives]);

  // Re-render tick for the relative "Updated Ns ago" label.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Visibility tracking — pause polling while hidden, refresh on return (when Live).
  useEffect(() => {
    const onVisibility = () => {
      const nextHidden = typeof document !== 'undefined' ? document.hidden : false;
      if (shouldRefreshOnVisibility(isHiddenRef.current, nextHidden, isLive)) refresh();
      setIsHidden(nextHidden);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [isLive, refresh]);

  // Live polling cadence.
  useEffect(() => {
    if (!shouldPoll(isLive, !isHidden)) return;
    const id = setInterval(() => fetchDirectives({ background: true }), DIRECTIVE_POLL_MS);
    return () => clearInterval(id);
  }, [isLive, isHidden, fetchDirectives]);

  // Unique filter options derived from loaded directives.
  const allAgents = Array.from(new Set(directives.map((d) => d.container).filter(Boolean))) as string[];
  const allHosts = Array.from(new Set(directives.map((d) => d.host).filter(Boolean))) as string[];

  const filtered = directives.filter((d) => {
    if (agentFilter !== 'all' && d.container !== agentFilter) return false;
    if (hostFilter !== 'all' && d.host !== hostFilter) return false;
    return true;
  });

  // Group by the same time-period buckets ActivityTimeline uses, for consistency.
  const grouped = (() => {
    const groups: { [key: string]: Directive[] } = {};
    const oneHour = 60 * 60 * 1000;
    const oneDay = 24 * oneHour;
    const twoDays = 2 * oneDay;
    for (const d of filtered) {
      const diff = now - new Date(d.timestamp).getTime();
      let key: string;
      if (diff < oneHour) key = 'Last hour';
      else if (diff < oneDay) key = 'Today';
      else if (diff < twoDays) key = 'Yesterday';
      else if (diff < 7 * oneDay) key = 'This week';
      else key = 'Older';
      (groups[key] ??= []).push(d);
    }
    return groups;
  })();

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header with filters */}
      <div className="flex-shrink-0 p-3 border-b space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Directives</h2>
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
          <Select value={hostFilter} onValueChange={setHostFilter}>
            <SelectTrigger className="h-7 w-auto text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Hosts</SelectItem>
              {allHosts.map((h) => (
                <SelectItem key={h} value={h}>
                  {h}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={agentFilter} onValueChange={setAgentFilter}>
            <SelectTrigger className="h-7 w-auto text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Agents</SelectItem>
              {allAgents.map((a) => (
                <SelectItem key={a} value={a}>
                  {a}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={String(limit)} onValueChange={(v) => setLimit(parseInt(v, 10))}>
            <SelectTrigger className="h-7 w-auto text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="50">Last 50</SelectItem>
              <SelectItem value="100">Last 100</SelectItem>
              <SelectItem value="500">Last 500</SelectItem>
              <SelectItem value="1000">Last 1000</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Stats */}
        <div className="text-xs text-muted-foreground">
          Showing {filtered.length} of {directives.length} directives
          {!isLive
            ? ' · Paused'
            : lastUpdated
              ? ` · Updated ${formatUpdatedAgo(now, lastUpdated)}`
              : ''}
        </div>
      </div>

      {/* Directive list */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {loading ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            Loading directives...
          </div>
        ) : error && directives.length === 0 ? (
          <div className="flex items-center justify-center h-full text-destructive text-sm">⚠ {error}</div>
        ) : filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full p-4">
            <EmptyState type="no-data" message="No directives sent yet" />
          </div>
        ) : (
          <div className="p-2 space-y-4">
            {Object.entries(grouped).map(([groupName, items]) => (
              <div key={groupName}>
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 px-1">
                  {groupName}
                </h3>
                <div className="space-y-2">
                  {items.map((d, i) => (
                    <DirectiveEntry
                      key={`${d.timestamp}-${i}`}
                      directive={d}
                      timestampFormat={timestampFormat}
                      setAgentFilter={setAgentFilter}
                      setHostFilter={setHostFilter}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DirectiveEntry({
  directive,
  timestampFormat,
  setAgentFilter,
  setHostFilter,
}: {
  directive: Directive;
  timestampFormat: TimestampFormat;
  setAgentFilter: (v: string) => void;
  setHostFilter: (v: string) => void;
}) {
  const hostLabels = useHostLabels();
  // `container` is null for legacy pre-WARDEN-642 local directives (WARDEN-733).
  // Hoist to a const so its truthiness narrows through the onSelect closures
  // below — a `directive.container` property access would widen back to
  // `string | null` inside them (TS does not carry property narrowing into
  // callbacks, since the property could be mutated between check and invocation).
  const container = directive.container;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="py-2 px-3 rounded-lg border bg-card/50">
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <span className="text-xs font-semibold uppercase text-emerald-500">sent</span>
            <span className="text-xs text-muted-foreground">{formatTimestamp(directive.timestamp, timestampFormat)}</span>
            <span className="text-xs font-mono text-muted-foreground bg-muted px-1 rounded">
              {container ? `${container}@` : ''}{hostLabelFor(directive.host, hostLabels) || directive.host}
            </span>
            <span className="text-xs font-medium">{directive.role || 'agent'}</span>
          </div>
          {/* Full directive text in a scrollable block — not a truncated snippet. */}
          <div className="max-h-64 overflow-y-auto rounded-md bg-muted/30 p-2 text-sm">
            <MarkdownBody>{directive.text}</MarkdownBody>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={async () => {
            await copyText(directive.text);
            toast.success('Copied');
          }}
        >
          Copy directive text
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={async () => {
            await copyText(container ? `${container}@${directive.host}` : directive.host);
            toast.success('Copied');
          }}
        >
          Copy agent@host
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={async () => {
            await copyText(formatTimestamp(directive.timestamp, timestampFormat));
            toast.success('Copied');
          }}
        >
          Copy timestamp
        </ContextMenuItem>
        {/* Filter group only when the row carries a filterable identity — never
            render an empty Filter label (the roadmap bans half-empty menus). */}
        {(container || directive.host) && (
          <>
            <ContextMenuSeparator />
            <ContextMenuLabel>Filter</ContextMenuLabel>
            {container && (
              <ContextMenuItem onSelect={() => setAgentFilter(container)}>
                Filter to this agent
              </ContextMenuItem>
            )}
            {directive.host && (
              <ContextMenuItem onSelect={() => setHostFilter(directive.host)}>Filter to this host</ContextMenuItem>
            )}
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
