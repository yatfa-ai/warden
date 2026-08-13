// AttentionView — the PERSISTENT home for the ranked "where am I needed, because X"
// answer (Observer Intelligence roadmap WARDEN-8, Job #2). WARDEN-880.
//
// Before this view the ranked answer was reachable ONLY as a transient popover on the
// header AttentionBadge — a popover that dismisses on every pane switch. During
// multi-agent triage (open the ranked #1 pane → address it → return for the next) the
// human had to re-open that popover N times. This view is a peer tab in ObserverTabs
// (Sessions / Activity / Directives / Attention) that STAYS MOUNTED while the human
// opens/switches agent panes, so the fleet-wide directed answer stays visible.
//
// It is a thin shell over the SHARED `<AttentionList>` — the identical rendering the
// badge popover consumes — fed by App's lifted `attentionRollup` (single source of
// truth, no duplicate polling) and the shared pure helpers. So the ranking, the
// "because X" reasons, the duration suffixes, the mute/snooze row actions, and the
// severity tone are bit-for-bit identical to the header badge. There is no second
// implementation to keep in sync.
//
// The one difference from the badge is the zero state: the badge hides entirely when
// nothing needs attention (it's an always-on header element, so absence is the least
// noise). This is a pane the human explicitly opened, so it renders an EmptyState
// instead of vanishing — it never cries wolf, but it also never disappears.
import { TriangleAlert, CheckCircle2 } from 'lucide-react';
import { rollupSeverity, filterAttentionRollup, attentionFilterOptions } from '@/lib/attentionRollup';
import { AttentionList, severityToneClass, type AttentionListProps } from '@/components/AttentionList';
import { EmptyState } from '@/components/EmptyState';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

export function AttentionView({
  hostFilter = 'all',
  setHostFilter,
  agentFilter = 'all',
  setAgentFilter,
  ...props
}: AttentionListProps & {
  // WARDEN-971: the host + agent filters, OWNED by ObserverTabs (persisted across
  // reload via loadObs/saveObs `attentionFilters`) and passed in as controlled props —
  // the same convention Activity/Directives already use (WARDEN-879).
  //
  // Deliberately OPT-IN, and threaded through THIS component rather than the shared
  // `<AttentionList>`: that list is also the body of the header AttentionBadge's
  // transient popover, which must stay byte-for-byte unchanged (filter chrome in a
  // small dismiss-on-navigate popover is wrong). Omitting the setters — as the badge
  // path does by never passing them — renders zero filter chrome and behaves exactly
  // as before, mirroring the existing optional `className`/`scrollClassName` props.
  hostFilter?: string;
  setHostFilter?: (v: string) => void;
  agentFilter?: string;
  setAgentFilter?: (v: string) => void;
}) {
  const { rollup: unfiltered } = props;
  // The controls render only when this surface actually owns the filter state.
  const showFilters = Boolean(setHostFilter && setAgentFilter);

  // Zero state — parity with the badge's `total === 0 && done.length === 0` gate. The
  // badge returns null here (absence = least noise for an always-on header); this pane
  // is something the human explicitly opened, so it renders an EmptyState instead. It
  // never cries wolf: a truly idle fleet shows the calm empty message, NOT an alarm.
  // (An all-finished fleet — total 0 but done > 0 — is NOT zero: those are positive
  // "go review their work" cues, so the list still renders with its green Finished
  // section and a positive header tone.)
  //
  // WARDEN-971: this gate reads the UNFILTERED rollup, so it is the genuinely-idle-fleet
  // case only. "Your filter hid everything" is a DIFFERENT state with a different message
  // further down — showing this calm one there would actively lie during the host outage
  // this filter exists for.
  if (unfiltered.total === 0 && unfiltered.done.length === 0) {
    return (
      <div className="h-full overflow-y-auto">
        <EmptyState type="nothing-here" message="Nothing needs your attention right now." />
      </div>
    );
  }

  // WARDEN-971: filter the BUCKETS, upstream of the ranking — so the summary header
  // count, the directed callout, the section counts and the severity tone all describe
  // the SAME set the list shows. A header reading "12 need attention" over a list of 3
  // is the contradiction this avoids. 'all'/'all' returns the identical object.
  const rollup = filterAttentionRollup(unfiltered, hostFilter, agentFilter);
  // Options come from the UNFILTERED rollup — otherwise picking a host would empty the
  // very dropdown you just used.
  const { hosts, agents } = attentionFilterOptions(unfiltered);
  // The filtered-empty case, evaluated on the same gate as the idle one above (so the
  // untouched directives/errors counts, which have no host, still count as content).
  const filteredEmpty = rollup.total === 0 && rollup.done.length === 0;
  const clearFilters = () => { setHostFilter?.('all'); setAgentFilter?.('all'); };

  const { onlyDone } = rollupSeverity(rollup);
  const tone = severityToneClass(rollup);
  const { total, done } = rollup;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Slim summary header — mirrors the badge popover's header (icon + tone + count)
          so the pane reads as the same attention system. The tab strip above already
          labels the view; this carries the glanceable count + severity tone. */}
      <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0">
        {onlyDone
          ? <CheckCircle2 className={cn('size-3.5', tone)} />
          : <TriangleAlert className={cn('size-3.5', tone)} />}
        <span className="text-sm font-semibold">
          {onlyDone ? `${done.length} finished` : `${total} need attention`}
        </span>
      </div>
      {/* Filters (WARDEN-971) — the same markup/sizing as the Activity + Directives tabs
          so the three peer views read as one system. `shrink-0` keeps the row pinned
          under the header; only the rundown below scrolls. */}
      {showFilters && (
        <div className="flex items-center gap-2 flex-wrap px-3 py-2 border-b shrink-0">
          <Select value={hostFilter} onValueChange={(v) => setHostFilter?.(v)}>
            <SelectTrigger className="h-7 w-auto text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Hosts</SelectItem>
              {hosts.map((h) => (
                <SelectItem key={h} value={h}>
                  {h}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={agentFilter} onValueChange={(v) => setAgentFilter?.(v)}>
            <SelectTrigger className="h-7 w-auto text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Agents</SelectItem>
              {agents.map((a) => (
                <SelectItem key={a} value={a}>
                  {a}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {/* The shared ranked rundown, filling the pane and scrolling in-panel (the badge
          caps the same list at max-h-72 inside its popover). The callout stays pinned
          above the scroll; the rundown fills the rest. */}
      <div className="flex-1 min-h-0">
        {filteredEmpty ? (
          // The fleet DOES need attention — this filter is hiding it. Say so, and give a
          // one-click way back to All Hosts / All Agents.
          <div className="h-full overflow-y-auto">
            <EmptyState
              type="no-results"
              message="No attention items match the current host/agent filter. The fleet still needs your attention elsewhere."
              action={{ label: 'Clear filters', onClick: clearFilters }}
            />
          </div>
        ) : (
          <AttentionList
            {...props}
            rollup={rollup}
            className="h-full min-h-0"
            scrollClassName="flex-1 min-h-0 overflow-y-auto"
          />
        )}
      </div>
    </div>
  );
}
