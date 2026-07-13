import { useState, type ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { useAttentionRollup } from '@/lib/useAttentionRollup';
import type { AttentionRollupOptions } from '@/lib/attentionRollup';
import type { AttentionAgent } from '@/lib/types';
import { cn } from '@/lib/utils';

interface Props {
  /** Open the agent's chat pane (reuses App's openChat). */
  onOpenChat: (id: string) => void;
  /** Open the observer panel's Activity tab (reuses App's openActivityTab). */
  onOpenActivity: () => void;
  /** Opt-in desktop alerts (WARDEN-259). Forwarded to useAttentionRollup so the
   * existing poll keeps running while hidden AND fires an OS notification on a
   * rollup increase while Warden is unfocused. */
  attentionDesktopAlerts: boolean;
  /** Pane keys currently open in the workspace — passed to /api/agent-states so the
   * rich pane-state classification (stuck/erroring/waiting/blocked) covers only what
   * the human is watching (WARDEN-344). */
  openPanes: string[];
  /** Per-state toggle: silence a noisy state (e.g. "waiting") without losing others
   * (WARDEN-344). */
  attentionStates?: AttentionRollupOptions['enabledStates'];
}

/**
 * Always-visible header rollup of things that need a human's eye (WARDEN-228),
 * extended in WARDEN-344 to surface agents that are STUCK / ERRORING / WAITING-ON-YOU
 * / BLOCKED — the cases /api/health's inactivity-only classification reads as Healthy.
 *
 * Aggregates — via useAttentionRollup — critical + warning fleet-health agents,
 * stuck/erroring/waiting/blocked pane states, pending directives, and recent errors
 * into one glanceable count. Renders nothing when there is nothing to act on
 * (total === 0), so a healthy fleet shows no badge. Clicking opens a popover whose
 * rows deep-link into the existing agent pane and Activity tab via the handlers
 * passed from App (no new routing).
 *
 * The popover is the only place "recent errors"/"pending directives" expand to a
 * link; the individual events themselves aren't fetchable as REST items, so each
 * links to the Activity tab rather than a specific event.
 */
export function AttentionBadge({ onOpenChat, onOpenActivity, attentionDesktopAlerts, openPanes, attentionStates }: Props) {
  const { rollup } = useAttentionRollup(attentionDesktopAlerts, openPanes, attentionStates);
  const [open, setOpen] = useState(false);

  // Zero-state: render nothing intrusive. (A neutral ✓ was considered per the AC,
  // but an absent element is the least-noise zero state for an always-on header.)
  if (rollup.total === 0) return null;

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
                {critical.map((a) => (
                  <AgentRow key={a.key || a.id} agent={a} dot="bg-red-500" onClick={() => openChat(a.key || a.id)} />
                ))}
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
                {warning.map((a) => (
                  <AgentRow key={a.key || a.id} agent={a} dot="bg-yellow-500" onClick={() => openChat(a.key || a.id)} />
                ))}
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

function AgentRow({ agent, dot, onClick, detail }: { agent: AttentionAgent; dot: string; onClick: () => void; detail?: string | null }) {
  return (
    <Button variant="ghost" onClick={onClick} className={rowClass()}>
      <span className={cn('size-2 rounded-full shrink-0 mt-0.5', dot)} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1">
          <span className="truncate">{agent.name || agent.key || agent.id}</span>
          {agent.role && <span className="text-xs text-blue-400 shrink-0">{agent.role}</span>}
          {agent.host && agent.host !== '(local)' && <span className="text-xs text-muted-foreground shrink-0">{agent.host}</span>}
        </span>
        {/* detail = the triggering signal (the repeating line / matched prompt) shown
            muted under the agent name so the human can see WHY it needs attention. */}
        {detail ? <span className="block truncate text-[10px] text-muted-foreground">{detail}</span> : null}
      </span>
    </Button>
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
