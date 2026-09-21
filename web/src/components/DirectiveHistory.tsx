import { useState } from 'react';
import { hostLabelFor } from '@/lib/chatDisplay';
import type { IssueLinkEntry } from '@/lib/issue-links';
import { useHostLabels } from '@/lib/uiStore';
import type { Directive } from '@/lib/types';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { copyText } from '@/lib/clipboard';
import { toast } from 'sonner';
import { EmptyState } from './EmptyState';
import { LiveFeedChrome } from './LiveFeedChrome';
import { MarkdownBody } from './MarkdownBody';
import { dayBucket, sortedFilterOptions } from '@/lib/timelinePacing';
import { formatTimestamp } from '@/lib/formatTimestamp';
import { useTimestampFormat } from '@/lib/uiStore';
import { useLiveTimeline } from '@/lib/useLiveTimeline';
import { useNowTicker } from '@/lib/useNowTicker';

// Read-only history of every directive that reached an agent (full text + target
// + time), sourced from the append-only directives.md via GET /api/directives.
// Shares ActivityTimeline's whole live-feed wiring through the same
// useLiveTimeline hook (path/select options, WARDEN-1353) and its whole chrome
// — Live/Pause, Refresh, the agent/host/limit filter row, the stats line and
// the fetch-failure strip — through the same LiveFeedChrome component
// (WARDEN-1419), so the two views read as one system and both exist exactly
// once. The directive text is the FULL body (not a 60-char snippet) in a
// scrollable MarkdownBody block — the whole point of this tab (see WARDEN-359).

// Pull the row array out of GET /api/directives' JSON. `Array.isArray` is
// deliberately STRICTER than the hook's default `json.events || []`: a
// malformed non-array body must degrade to [] rather than reach `.map()` in
// the filter derivations below and throw.
const selectDirectives = (json: any): Directive[] =>
  Array.isArray(json.directives) ? json.directives : [];

// Feed config for useLiveTimeline. Module-level constant: the hook reads
// options through a ref (see the options-stability note in useLiveTimeline.ts),
// so identity is irrelevant to correctness — a stable constant simply makes
// that contract visible at the call site.
const DIRECTIVES_FEED = {
  path: '/api/directives',
  select: selectDirectives,
  label: 'directives',
};

export function DirectiveHistory({
  agentFilter, setAgentFilter,
  hostFilter, setHostFilter,
  issueEntries,
}: {
  // WARDEN-879: the two filters are now OWNED by ObserverTabs (persisted across
  // restart via loadObs/saveObs) and passed in as controlled props. The Selects
  // and DirectiveEntry's context menu already call these setters, so they keep
  // working unchanged once the setters arrive from props instead of local useState.
  agentFilter: string;
  setAgentFilter: (v: string) => void;
  hostFilter: string;
  setHostFilter: (v: string) => void;
  // WARDEN-1394 — configured tracker entries for the markdown issue-key
  // linkifier (fleet-scoped, already ambiguity-filtered upstream). Undefined
  // (the default while the integration is off) renders directive text
  // byte-identically to before this prop existed.
  issueEntries?: IssueLinkEntry[];
}) {
  const [limit, setLimit] = useState(100);
  // Re-render once per second so the "Updated Ns ago" label stays fresh. ONE
  // ticker per feed (WARDEN-1419): this same `now` is passed to LiveFeedChrome,
  // so the header label and the row grouping below read the same instant.
  const now = useNowTicker();

  // The whole live-feed wiring — state cluster, bounded fetch, initial/limit
  // effect, visibility refresh, poll cadence, Refresh — lives in the shared
  // useLiveTimeline hook (WARDEN-1353), and the chrome around it — Live/Pause,
  // Refresh, the host/agent/limit filter row, the stats line and the
  // fetch-failure strip — lives in the shared LiveFeedChrome component
  // (WARDEN-1419); this component keeps only the clock tick above and the
  // directive-specific filter/grouping/rows below. Destructure rename: the
  // hook's result key is `events` (shared with ActivityTimeline, whose call
  // site must not change); locally the rows stay `directives`.
  const {
    events: directives,
    loading,
    refreshing,
    isLive,
    setIsLive,
    lastUpdated,
    error,
    refresh,
  } = useLiveTimeline<Directive>(limit, DIRECTIVES_FEED);

  // Unique filter options derived from loaded directives. Sorted (not feed
  // order) so the menus don't reshuffle under the cursor on every poll —
  // directives arrive newest-first from the server.
  const allAgents = sortedFilterOptions(directives.map((d) => d.container));
  const allHosts = sortedFilterOptions(directives.map((d) => d.host));

  const filtered = directives.filter((d) => {
    if (agentFilter !== 'all' && d.container !== agentFilter) return false;
    if (hostFilter !== 'all' && d.host !== hostFilter) return false;
    return true;
  });

  // Group by time period via the shared, tested `dayBucket` helper
  // (lib/timelinePacing.ts) — the SAME function ActivityTimeline calls, so the
  // two feeds cannot drift, and `Today`/`Yesterday` are decided by CALENDAR DAY
  // (matching what each row's own formatTimestamp renders) rather than by
  // elapsed milliseconds.
  const grouped = (() => {
    const groups: { [key: string]: Directive[] } = {};
    for (const d of filtered) {
      (groups[dayBucket(new Date(d.timestamp).getTime(), now)] ??= []).push(d);
    }
    return groups;
  })();

  return (
    <div className="flex flex-col h-full min-h-0">
      <LiveFeedChrome
        title="Directives"
        noun="directives"
        staleNoun="directives"
        isLive={isLive}
        setIsLive={setIsLive}
        refresh={refresh}
        loading={loading}
        refreshing={refreshing}
        lastUpdated={lastUpdated}
        now={now}
        error={error}
        hostFilter={hostFilter}
        setHostFilter={setHostFilter}
        agentFilter={agentFilter}
        setAgentFilter={setAgentFilter}
        allHosts={allHosts}
        allAgents={allAgents}
        limit={limit}
        setLimit={setLimit}
        filteredCount={filtered.length}
        // The RAW directive count, never `filtered.length` — it gates the
        // shared fetch-failure strip, and an active filter matching nothing
        // during a healthy fetch must not be dressed up as a failure.
        totalCount={directives.length}
      />

      {/* Directive list */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {loading ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            Loading directives...
          </div>
        ) : error && directives.length === 0 ? (
          <div className="flex items-center justify-center h-full text-destructive text-sm">⚠ {error.message}</div>
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
                      setAgentFilter={setAgentFilter}
                      setHostFilter={setHostFilter}
                      issueEntries={issueEntries}
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
  setAgentFilter,
  setHostFilter,
  issueEntries,
}: {
  directive: Directive;
  setAgentFilter: (v: string) => void;
  setHostFilter: (v: string) => void;
  issueEntries?: IssueLinkEntry[];
}) {
  const hostLabels = useHostLabels();
  // WARDEN-1342 (slice 4): the leaf that renders the directive timestamps
  // subscribes to the shared pref; DirectiveHistory no longer threads it.
  const timestampFormat = useTimestampFormat();
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
            <MarkdownBody issueEntries={issueEntries}>{directive.text}</MarkdownBody>
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
