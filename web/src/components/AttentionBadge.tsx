import { useMemo, useState, type ReactNode } from 'react';
import { TriangleAlert, Bell, BellOff } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import {
  rankAttention,
  attentionReason,
  type AttentionRollup,
  type AttentionItem,
} from '@/lib/attentionRollup';
import type { AttentionAgent } from '@/lib/types';
import { cn } from '@/lib/utils';

interface Props {
  /**
   * The live, already-aggregated attention rollup. WARDEN-436 lifted the
   * `useAttentionRollup` call UP to App so the SAME rollup feeds BOTH the header
   * badge AND the "While you were away" return banner (single source of truth, no
   * duplicate /api/health + /api/agent-states polling). This component consumes it
   * read-only: it derives its own `rankAttention` rundown + the directed callout
   * from the rollup it's handed.
   */
  rollup: AttentionRollup;
  /** Open the agent's chat pane (reuses App's openChat). */
  onOpenChat: (id: string) => void;
  /** Open the observer panel's Activity tab (reuses App's openActivityTab). */
  onOpenActivity: () => void;
  /** Opt-in desktop alerts (WARDEN-259). Now used only for the per-row mute bell
   * affordance (the routing decision itself moved to App with the lifted hook). */
  attentionDesktopAlerts: boolean;
  /** WARDEN-364 — per-agent mute set for the desktop channel's row bell. The
   * routing/mute DECISION now runs in App's lifted useAttentionRollup; this stays
   * so the badge's row bell can reflect + toggle the same set. */
  mutedAlertKeys: string[];
  onToggleMuteAlertKey: (key: string) => void;
}

/**
 * Always-visible header rollup of things that need a human's eye (WARDEN-228),
 * extended in WARDEN-344 to surface agents that are STUCK / ERRORING / WAITING-ON-YOU
 * / BLOCKED — the cases /api/health's inactivity-only classification reads as Healthy.
 *
 * Aggregates — via the `rollup` prop (WARDEN-436 lifted useAttentionRollup up to App,
 * so the same rollup feeds both this badge and the return banner with no duplicate
 * polling) — critical + warning fleet-health agents, stuck/erroring/waiting/blocked
 * pane states, pending directives, and recent errors into one glanceable count. Renders nothing when there is nothing to act on
 * (total === 0), so a healthy fleet shows no badge. Clicking opens a popover whose
 * rows deep-link into the existing agent pane and Activity tab via the handlers
 * passed from App (no new routing).
 *
 * The popover is the only place "recent errors"/"pending directives" expand to a
 * link; the individual events themselves aren't fetchable as REST items, so each
 * links to the Activity tab rather than a specific event.
 */
export function AttentionBadge({
  rollup,
  onOpenChat,
  onOpenActivity,
  attentionDesktopAlerts,
  mutedAlertKeys,
  onToggleMuteAlertKey,
}: Props) {
  const [open, setOpen] = useState(false);

  // The mute affordance is only meaningful while the desktop-alert channel is on
  // (master toggle). When it's off the whole routing layer is moot, so the rows
  // render exactly as before WARDEN-364 — no bell, no strike-through.
  const muteEnabled = attentionDesktopAlerts;
  // Fast membership check for the mute set on each render.
  const mutedSet = useMemo(() => new Set(mutedAlertKeys), [mutedAlertKeys]);

  // Zero-state: render nothing intrusive. (A neutral ✓ was considered per the AC,
  // but an absent element is the least-noise zero state for an always-on header.)
  if (rollup.total === 0) return null;

  // The directed answer (WARDEN-384): the ONE pane a human should go to first,
  // "you're needed HERE, because X" — promoted above the flat rundown so the human
  // doesn't have to scan to find "first." top is null only when no pane/health agent
  // needs attention (e.g. just directives/errors counts remain), in which case the
  // sectioned rundown alone is the directed answer. The callout is gated to ≥2
  // deep-linkable items: with exactly one pane needing attention the rundown's lone
  // row already IS the answer, so promoting it would just duplicate that single pane
  // as both the callout and the row beneath it.
  const { top, ranked } = rankAttention(rollup);

  const { critical, warning, stuck, erroring, waiting, blocked, directives, errors, total } = rollup;
  // Severity cue: red when something is broken (critical/stuck/erroring agent or a
  // recent error), else amber (warnings / waiting / blocked / pending directives).
  // Color is supplementary only — the count + alert glyph already convey "needs
  // attention" (WCAG 1.4.1).
  const tone = critical.length > 0 || stuck.length > 0 || erroring.length > 0 || errors > 0
    ? 'text-red-500'
    : 'text-yellow-500';

  const openChat = (id: string) => {
    setOpen(false);
    onOpenChat(id);
  };
  const goActivity = () => {
    setOpen(false);
    onOpenActivity();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`${total} item${total !== 1 ? 's' : ''} need attention`}
          className="h-7 gap-1 px-2 text-muted-foreground hover:text-foreground"
        >
          <TriangleAlert className={cn('size-3.5', tone)} />
          <span className={cn('text-xs font-medium tabular-nums', tone)}>{total}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <div className="flex items-center gap-2 px-3 py-2 border-b">
          <TriangleAlert className={cn('size-3.5', tone)} />
          <span className="text-sm font-semibold">{total} need attention</span>
        </div>
        {top && ranked.length >= 2 && (
          <div className="px-1.5 pt-1.5">
            <Callout top={top} onClick={() => openChat(top.id)} />
          </div>
        )}
        {/*
          Bounded with max-h-* + overflow-y-auto (NOT Radix ScrollArea). The Radix
          Viewport is height:100%, which needs a *definite* ancestor height to resolve
          against — but max-height (and flex-1/min-h-0 through an overflow:visible
          PopoverContent) does NOT establish one, so a ScrollArea grows to fit all rows
          and never scrolls (verified: rows past ~7 were clipped & unreachable). A plain
          div's own max-height directly caps its own scroll, so it shrinks for short lists
          and scrolls for long ones (e.g. a host outage taking many agents critical).
        */}
        <div className="max-h-72 overflow-y-auto">
          <div className="p-1.5 flex flex-col gap-2">
            {/*
              Section order is severity: red first (critical health, then the red pane
              states stuck/erroring), then amber (warning health, then waiting/blocked),
              then the event-count sections. Each row deep-links straight into the pane.
            */}
            {critical.length > 0 && (
              <Section title="Critical" count={critical.length} tone="text-red-500">
                {critical.map((a) => {
                  const key = a.key || a.id;
                  return (
                    <AgentRow
                      key={key}
                      agent={a}
                      dot="bg-red-500"
                      onClick={() => openChat(key)}
                      muted={muteEnabled && mutedSet.has(key)}
                      muteEnabled={muteEnabled}
                      onToggleMute={() => onToggleMuteAlertKey(key)}
                    />
                  );
                })}
              </Section>
            )}
            {stuck.length > 0 && (
              <Section title="Stuck" count={stuck.length} tone="text-red-500">
                {stuck.map((a) => (
                  <AgentRow key={a.key || a.id} agent={a} dot="bg-red-500" detail={a.signal} onClick={() => openChat(a.key || a.id)} />
                ))}
              </Section>
            )}
            {erroring.length > 0 && (
              <Section title="Erroring" count={erroring.length} tone="text-red-500">
                {erroring.map((a) => (
                  <AgentRow key={a.key || a.id} agent={a} dot="bg-red-500" detail={a.signal} onClick={() => openChat(a.key || a.id)} />
                ))}
              </Section>
            )}
            {warning.length > 0 && (
              <Section title="Warnings" count={warning.length} tone="text-yellow-500">
                {warning.map((a) => {
                  const key = a.key || a.id;
                  return (
                    <AgentRow
                      key={key}
                      agent={a}
                      dot="bg-yellow-500"
                      onClick={() => openChat(key)}
                      muted={muteEnabled && mutedSet.has(key)}
                      muteEnabled={muteEnabled}
                      onToggleMute={() => onToggleMuteAlertKey(key)}
                    />
                  );
                })}
              </Section>
            )}
            {waiting.length > 0 && (
              <Section title="Waiting on you" count={waiting.length} tone="text-yellow-500">
                {waiting.map((a) => (
                  <AgentRow key={a.key || a.id} agent={a} dot="bg-yellow-500" detail={a.signal} onClick={() => openChat(a.key || a.id)} />
                ))}
              </Section>
            )}
            {blocked.length > 0 && (
              <Section title="Blocked" count={blocked.length} tone="text-yellow-500">
                {blocked.map((a) => (
                  <AgentRow key={a.key || a.id} agent={a} dot="bg-yellow-500" detail={a.signal} onClick={() => openChat(a.key || a.id)} />
                ))}
              </Section>
            )}
            {directives > 0 && (
              <Section title="Pending directives" count={directives} tone="text-blue-500">
                <LinkRow label={`${directives} directive${directives !== 1 ? 's' : ''} proposed`} dot="bg-blue-500" onClick={goActivity} />
              </Section>
            )}
            {errors > 0 && (
              <Section title="Recent errors" count={errors} tone="text-red-500">
                <LinkRow label={`${errors} error${errors !== 1 ? 's' : ''} in the last 15m`} dot="bg-red-500" onClick={goActivity} />
              </Section>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Section({ title, count, tone, children }: { title: string; count: number; tone: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className={cn('px-2 py-1 text-xs uppercase tracking-wider font-semibold', tone)}>
        {title} ({count})
      </div>
      {children}
    </div>
  );
}

function rowClass() {
  // Full-width, left-aligned, compact row overriding Button's centered h-8 default.
  return 'w-full justify-start gap-2 h-auto px-2 py-1.5 font-normal text-xs text-foreground';
}

function AgentRow({
  agent,
  dot,
  onClick,
  detail,
  muted = false,
  muteEnabled = false,
  onToggleMute,
}: {
  agent: AttentionAgent;
  dot: string;
  onClick: () => void;
  /** The triggering signal (repeating line / matched prompt) for a pane-state row —
   * shown muted under the name so the human sees WHY it needs attention (WARDEN-344). */
  detail?: string | null;
  /** WARDEN-364 per-agent mute. Only the health-bucket rows (critical/warning) pass
   * these; pane-state rows pass none, so no bell renders there. */
  muted?: boolean;
  muteEnabled?: boolean;
  onToggleMute?: () => void;
}) {
  const label = agent.name || agent.key || agent.id;
  return (
    <div className="flex items-stretch gap-0.5 pr-1">
      <Button variant="ghost" onClick={onClick} className={cn('flex-1 min-w-0 justify-start gap-2 h-auto px-2 py-1.5 font-normal text-xs text-foreground', muted && 'opacity-60')}>
        <span className={cn('size-2 rounded-full shrink-0 mt-0.5', dot)} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1">
            <span className={cn('truncate', muted && 'line-through')}>{label}</span>
            {agent.role && <span className="text-xs text-blue-400 shrink-0">{agent.role}</span>}
            {agent.host && agent.host !== '(local)' && <span className="text-xs text-muted-foreground shrink-0">{agent.host}</span>}
          </span>
          {/* detail = the triggering signal (the repeating line / matched prompt) shown
              muted under the agent name so the human can see WHY it needs attention. */}
          {detail ? <span className="block truncate text-[10px] text-muted-foreground">{detail}</span> : null}
        </span>
      </Button>
      {/*
        WARDEN-364 — per-agent mute on the desktop-alert channel (health buckets
        only). stopPropagation so tapping the bell never also opens the chat pane.
        aria-pressed reflects the toggle state for screen readers; the icon swaps
        Bell ↔ BellOff so the state is glanceable without color alone (WCAG 1.4.1).
        Uses the library <Button> (variant=ghost size=icon-xs) — same component the
        row itself uses right beside it (WARDEN-68 Rule 1: no raw <button>).
      */}
      {muteEnabled && onToggleMute && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={(e) => {
            e.stopPropagation();
            onToggleMute();
          }}
          aria-pressed={muted}
          aria-label={muted ? `Stop muting desktop alerts for ${label}` : `Mute desktop alerts for ${label}`}
          title={muted ? 'Unmute desktop alerts for this agent' : 'Mute desktop alerts for this agent'}
          className="shrink-0 self-center text-muted-foreground hover:text-foreground"
        >
          {muted ? <BellOff className="size-3.5" /> : <Bell className="size-3.5" />}
        </Button>
      )}
    </div>
  );
}

function LinkRow({ label, dot, onClick }: { label: string; dot: string; onClick: () => void }) {
  return (
    <Button variant="ghost" onClick={onClick} className={rowClass()}>
      <span className={cn('size-2 rounded-full shrink-0', dot)} aria-hidden />
      <span className="truncate flex-1">{label}</span>
      <span className="text-xs text-muted-foreground">view →</span>
    </Button>
  );
}

/**
 * Directed callout for the single ranked "you're needed HERE, because X" pane
 * (WARDEN-384). Rendered once at the top of the popover, above the sectioned
 * rundown, so a human with several panes needing attention sees the one to act on
 * first without scanning. Clicking deep-links into the pane via the existing
 * openChat — no new routing. Styled as a distinct headline (bordered + muted fill)
 * so it reads as the answer, not another list row.
 */
function Callout({ top, onClick }: { top: AttentionItem; onClick: () => void }) {
  // The "because X": the shared attentionReason helper (WARDEN-436) — the concrete
  // signal when one flows (pane states), else a state-keyed fallback (health-group
  // agents carry no signal of their own). Shared with the return-banner callout so
  // the phrasing is identical across both surfaces.
  const reason = attentionReason(top);
  return (
    <Button variant="ghost" onClick={onClick} className={cn(rowClass(), 'rounded-md border border-border bg-muted/40 py-2')}>
      <span className={cn('size-2 rounded-full shrink-0 mt-0.5', dotForState(top.state))} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="text-xs text-foreground">
          You&rsquo;re needed in <span className="font-semibold">{top.name}</span>
        </span>
        <span className="block truncate text-xs text-muted-foreground">{reason}</span>
      </span>
      <span className="text-xs text-muted-foreground shrink-0">open →</span>
    </Button>
  );
}

// Callout urgency dot — red for live-failure / severe states, amber for the
// "act on this" / mild ones, mirroring the rundown Section dots so the promoted
// answer reads as part of the same attention system. Exported (WARDEN-436) so the
// return-banner callout — which presents the SAME ranked `top` — reuses the exact
// state→color mapping and the two surfaces stay visually consistent.
export function dotForState(state: string): string {
  return state === 'erroring' || state === 'stuck' || state === 'critical'
    ? 'bg-red-500'
    : 'bg-yellow-500';
}
