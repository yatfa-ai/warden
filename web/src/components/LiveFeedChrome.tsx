import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatUpdatedAgo } from '@/lib/timelinePacing';

/**
 * LiveFeedChrome — the ONE definition of the Observer live-feed chrome
 * (WARDEN-1419).
 *
 * The two Observer feeds — ActivityTimeline and DirectiveHistory — had
 * hand-copied their entire chrome: the Live/Paused toggle with its pulse dot,
 * the Refresh button, the host/agent/limit filter row (identical down to the
 * "All Hosts" / "Last 50" option lists), the "Showing N of M …" stats line, and
 * the fetch-failure strip. WARDEN-1353 deduplicated the *wiring* behind them
 * (both feeds now share `useLiveTimeline`) but deliberately left the JSX as two
 * copies, and the lockstep tax was immediate and measured: the failure strip
 * was BUILT TWICE (WARDEN-1060 for activity, WARDEN-1122 for directives), the
 * "filter menus reorder on every poll" bug was FIXED TWICE in one commit
 * (WARDEN-1113), and the copies needed three double-edits in their first nine
 * days. This component is where that stops.
 *
 * WHAT IS DELIBERATELY *NOT* FOLDED IN — this is a shared chrome, not a
 * uniformizer:
 *   - The feed's own row list, empty state and full-screen error arm stay with
 *     each caller: they render different row shapes and different copy.
 *   - `title`, `noun` and `staleNoun` are props precisely so the two feeds keep
 *     saying different things.
 *   - The Activity-only TYPE filter arrives through the `extraFilters` slot and
 *     is rendered FIRST in the filter row. DirectiveHistory passes nothing, and
 *     must never grow a type filter — it has no types.
 *
 * Rendered as a FRAGMENT of two siblings — the bordered header block and the
 * failure strip — matching the layout both callers already had: the strip is a
 * sibling of the header, not a child of it, so it spans the panel above the
 * scrolling list.
 */
export interface LiveFeedChromeProps {
  /** Panel heading (e.g. "Activity Timeline" / "Directives"). */
  title: string;
  /** Plural noun for the stats line: "Showing 3 of 40 <noun>". */
  noun: string;
  /**
   * Noun for the failure strip's tail: "showing last known <staleNoun>".
   * SEPARATE from `noun` on purpose — the activity feed counts "events" but
   * describes its retained rows as "activity"; collapsing the two would change
   * user-visible copy.
   */
  staleNoun: string;

  /** Live/Pause state and setter, straight from `useLiveTimeline`. */
  isLive: boolean;
  setIsLive: (next: boolean | ((prev: boolean) => boolean)) => void;
  /** One-shot refresh (the Refresh button). */
  refresh: () => void;
  /** First-fetch loading (disables Refresh, and gates the failure strip). */
  loading: boolean;
  /** Any in-flight fetch (drives the transient "Refreshing..." label). */
  refreshing: boolean;
  /** ms-since-epoch of the last successful fetch, or null before the first. */
  lastUpdated: number | null;
  /**
   * The feed's 1s-ticking clock (see `useNowTicker`). Passed IN rather than
   * ticked here so one feed has exactly ONE clock: the caller's row grouping
   * (`dayBucket`) and this header's "Updated Ns ago" must read the same instant.
   */
  now: number;
  /**
   * Last fetch error. `Error | null` — both feeds get this shape from
   * `useLiveTimeline` — so the strip renders `error.message`: an Error object
   * as a React child throws.
   */
  error: Error | null;

  /** Host filter (controlled by ObserverTabs, persisted across restart). */
  hostFilter: string;
  setHostFilter: (v: string) => void;
  /** Agent filter (controlled by ObserverTabs, persisted across restart). */
  agentFilter: string;
  setAgentFilter: (v: string) => void;
  /** Sorted, deduped option lists (see `sortedFilterOptions`). */
  allHosts: string[];
  allAgents: string[];
  /** Row-count cap, owned by the caller (it is the hook's fetch argument). */
  limit: number;
  setLimit: (n: number) => void;

  /** Rows currently shown after the caller's filtering. */
  filteredCount: number;
  /**
   * The RAW row count — `events.length` / `directives.length`, NEVER the
   * filtered count. It gates the failure strip: an active filter matching
   * nothing during a healthy fetch must not be dressed up as a failure.
   */
  totalCount: number;

  /**
   * Feed-specific Selects rendered before the shared three. ActivityTimeline
   * passes its type filter here; DirectiveHistory passes nothing.
   */
  extraFilters?: ReactNode;
}

export function LiveFeedChrome({
  title,
  noun,
  staleNoun,
  isLive,
  setIsLive,
  refresh,
  loading,
  refreshing,
  lastUpdated,
  now,
  error,
  hostFilter,
  setHostFilter,
  agentFilter,
  setAgentFilter,
  allHosts,
  allAgents,
  limit,
  setLimit,
  filteredCount,
  totalCount,
  extraFilters,
}: LiveFeedChromeProps) {
  return (
    <>
      {/* Header with filters */}
      <div className="flex-shrink-0 p-3 border-b space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">{title}</h2>
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
          {extraFilters}

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
          Showing {filteredCount} of {totalCount} {noun}
          {!isLive
            ? ' · Paused'
            : lastUpdated
              ? ` · Updated ${formatUpdatedAgo(now, lastUpdated)}`
              : ''}
        </div>
      </div>

      {/* Fetch-failure strip. The hook RETAINS stale rows on a failed poll (its
          catch clause keeps the previous rows in place — useLiveTimeline.ts) —
          without this, a feed that already had rows and then started failing
          would keep presenting stale state as live with no indicator at all,
          since each caller's full-screen error arm is unreachable while the
          list is non-empty. Non-blocking by design: the rows stay on screen.
          Gate on the RAW row count (`totalCount`), never the filtered count —
          an active filter matching nothing during a healthy fetch must not be
          dressed up as a failure. Render `error.message`: the hook stores an
          `Error` instance, and an Error object as a React child throws. */}
      {!loading && error && totalCount > 0 && (
        <div
          role="status"
          title={`Live updates failed: ${error.message}`}
          className="flex-shrink-0 flex items-start gap-2 px-3 py-1.5 border-b border-destructive/30 bg-destructive/10 text-destructive text-sm leading-snug"
        >
          <span aria-hidden="true">⚠</span>
          {/* No `truncate`: the panel is narrow, and clipping the message would
              hide the one diagnostic part of the strip (e.g. "HTTP 503"). */}
          <span className="min-w-0">
            Live updates failed ({error.message}) — showing last known {staleNoun}.
          </span>
        </div>
      )}
    </>
  );
}
