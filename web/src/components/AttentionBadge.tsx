import { useState } from 'react';
import { TriangleAlert, CheckCircle2 } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { rollupSeverity } from '@/lib/attentionRollup';
import { AttentionList, severityToneClass, type AttentionListProps } from '@/components/AttentionList';
import { cn } from '@/lib/utils';

// Re-export dotForState (WARDEN-436) so App's existing import path is unchanged now that
// the helper lives alongside the shared AttentionList rendering (WARDEN-880).
export { dotForState } from '@/components/AttentionList';

/**
 * Always-visible header rollup of things that need a human's eye (WARDEN-228),
 * extended in WARDEN-344 to surface agents that are STUCK / ERRORING / WAITING-ON-YOU
 * / BLOCKED — the cases /api/health's inactivity-only classification reads as Healthy.
 *
 * Aggregates — via the `rollup` prop (WARDEN-436 lifted useAttentionRollup up to App,
 * so the same rollup feeds this badge, the return banner, AND the persistent Attention
 * view with no duplicate polling) — critical + warning fleet-health agents,
 * stuck/erroring/waiting/blocked pane states, pending directives, and recent errors into
 * one glanceable count. Renders nothing when there is nothing to act on (total === 0), so
 * a healthy fleet shows no badge. Clicking opens a popover whose rows deep-link into the
 * existing agent pane and Activity tab via the handlers passed from App (no new routing).
 *
 * WARDEN-880: the popover's ranked "where am I needed, because X" rundown is now the
 * SHARED `<AttentionList>` — the identical rendering the persistent Attention view
 * consumes — so the two surfaces can never drift. This component is just the always-on
 * trigger button + the transient popover wrapper around that shared list.
 *
 * The popover is the only place "recent errors"/"pending directives" expand to a
 * link; the individual events themselves aren't fetchable as REST items, so each
 * links to the Activity tab rather than a specific event.
 */
export function AttentionBadge(props: AttentionListProps) {
  const { rollup } = props;
  const [open, setOpen] = useState(false);

  // Zero-state: render nothing intrusive. (A neutral ✓ was considered per the AC,
  // but an absent element is the least-noise zero state for an always-on header.)
  // WARDEN-575: an all-finished fleet (no problems) is NOT zero — those agents are a
  // positive "go review their work" cue — so the badge stays visible with a green
  // tone when only `done` items remain. Only a truly idle fleet (no problems AND no
  // recently-finished) renders nothing.
  if (rollup.total === 0 && rollup.done.length === 0) return null;

  // WARDEN-575 / WARDEN-880: the severity tone is the shared, tested rollupSeverity
  // decision (positive/red/amber) mapped to a class by severityToneClass — the SAME
  // mapping the persistent Attention view's header uses, so the two always agree.
  const { onlyDone } = rollupSeverity(rollup);
  const tone = severityToneClass(rollup);
  const { total, done } = rollup;
  // The header count + glyph: problems show their total behind the alert glyph; an
  // all-finished fleet shows the finished count behind a positive check glyph.
  const headerCount = onlyDone ? done.length : total;
  const headerLabel = onlyDone
    ? `${done.length} agent${done.length !== 1 ? 's' : ''} finished`
    : `${total} item${total !== 1 ? 's' : ''} need attention`;

  // Deep-linking from a row closes the popover (the human is navigating away to a
  // pane/tab). The persistent Attention view passes these straight through with no
  // close — staying mounted is its whole purpose — so the close lives here, in the
  // wrapper, not in the shared list.
  const openChat = (id: string) => {
    setOpen(false);
    props.onOpenChat(id);
  };
  const goActivity = () => {
    setOpen(false);
    props.onOpenActivity();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={headerLabel}
          className="h-7 gap-1 px-2 text-muted-foreground hover:text-foreground"
        >
          {onlyDone
            ? <CheckCircle2 className={cn('size-3.5', tone)} />
            : <TriangleAlert className={cn('size-3.5', tone)} />}
          <span className={cn('text-xs font-medium tabular-nums', tone)}>{headerCount}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <div className="flex items-center gap-2 px-3 py-2 border-b">
          {onlyDone
            ? <CheckCircle2 className={cn('size-3.5', tone)} />
            : <TriangleAlert className={cn('size-3.5', tone)} />}
          <span className="text-sm font-semibold">
            {onlyDone ? `${done.length} finished` : `${total} need attention`}
          </span>
        </div>
        <AttentionList
          {...props}
          onOpenChat={openChat}
          onOpenActivity={goActivity}
        />
      </PopoverContent>
    </Popover>
  );
}
