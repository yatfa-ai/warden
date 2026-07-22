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
import { rollupSeverity } from '@/lib/attentionRollup';
import { AttentionList, severityToneClass, type AttentionListProps } from '@/components/AttentionList';
import { EmptyState } from '@/components/EmptyState';
import { cn } from '@/lib/utils';

export function AttentionView(props: AttentionListProps) {
  const { rollup } = props;

  // Zero state — parity with the badge's `total === 0 && done.length === 0` gate. The
  // badge returns null here (absence = least noise for an always-on header); this pane
  // is something the human explicitly opened, so it renders an EmptyState instead. It
  // never cries wolf: a truly idle fleet shows the calm empty message, NOT an alarm.
  // (An all-finished fleet — total 0 but done > 0 — is NOT zero: those are positive
  // "go review their work" cues, so the list still renders with its green Finished
  // section and a positive header tone.)
  if (rollup.total === 0 && rollup.done.length === 0) {
    return (
      <div className="h-full overflow-y-auto">
        <EmptyState type="nothing-here" message="Nothing needs your attention right now." />
      </div>
    );
  }

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
      {/* The shared ranked rundown, filling the pane and scrolling in-panel (the badge
          caps the same list at max-h-72 inside its popover). The callout stays pinned
          above the scroll; the rundown fills the rest. */}
      <div className="flex-1 min-h-0">
        <AttentionList
          {...props}
          className="h-full min-h-0"
          scrollClassName="flex-1 min-h-0 overflow-y-auto"
        />
      </div>
    </div>
  );
}
