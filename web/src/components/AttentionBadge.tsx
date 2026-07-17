import { useMemo, useState, type ReactNode } from 'react';
import { TriangleAlert, Bell, BellOff, Clock, CheckCircle2 } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import {
  rankAttention,
  pickCalloutTop,
  attentionReason,
  type AttentionRollup,
  type AttentionItem,
} from '@/lib/attentionRollup';
import { activeSnoozedKeys, formatSnoozeRemaining, SNOOZE_DURATION_OPTIONS, type AlertMuteMode, type SnoozeMap } from '@/lib/snooze';
import { formatStateDuration, formatStateDurationVerbose, languishingTone, sortOldestEnteredAtFirst, type StateDurationTone } from '@/lib/stateDuration';
import type { AttentionAgent } from '@/lib/types';
import { cn } from '@/lib/utils';

// WARDEN-587: the duration suffix's supplementary color escalates the longer an agent
// has been in its state — muted (fresh) → amber → red — so a glance picks out the
// LANGUISHING rows. The duration TEXT always carries the primary signal (WCAG 1.4.1);
// color is supplementary only.
const DURATION_TONE_CLASS: Record<StateDurationTone, string> = {
  fresh: 'text-muted-foreground',
  amber: 'text-yellow-500',
  red: 'text-red-500',
};

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
  /** WARDEN-551 — chat key → snooze expiry (ms). The time-boxed twin of
   * mutedAlertKeys: a snoozed agent is suppressed identically to a permanent
   * mute until its expiry, then auto-rearms. The row bell reflects + sets snoozes
   * through onSetAlertMute; the suppression decision itself runs in App's lifted
   * useAttentionRollup (same as permanent mute). */
  snoozedAlertKeys: SnoozeMap;
  /** WARDEN-551/364 — unified mute/snooze setter for a chat key. 'permanent'
   * adds it to the permanent mute set; '1h'/'tomorrow' start a time-boxed snooze;
   * 'off' clears both (manual re-arm). The two are mutually exclusive per key, so
   * the bell menu's options never let both apply at once. */
  onSetAlertMute: (key: string, mode: AlertMuteMode) => void;
  /** WARDEN-482: the pane the human is currently focused on. The directed callout must
   * never PROMOTE the pane the human is already reading (the "trains the human to
   * ignore it" product-killer), so pickCalloutTop excludes it when choosing the
   * callout target. The sectioned rundown still lists it unchanged — no information
   * loss, it just isn't the promoted answer. Optional + trailing so existing callers
   * that don't pass it get the old behavior (callout promotes ranked[0]). */
  focusedPaneKey?: string | null;
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
  snoozedAlertKeys,
  onSetAlertMute,
  focusedPaneKey,
}: Props) {
  const [open, setOpen] = useState(false);

  // The mute affordance is only meaningful while the desktop-alert channel is on
  // (master toggle). When it's off the whole routing layer is moot, so the rows
  // render exactly as before WARDEN-364 — no bell, no strike-through.
  const muteEnabled = attentionDesktopAlerts;
  // Fast membership check for the mute set on each render.
  const mutedSet = useMemo(() => new Set(mutedAlertKeys), [mutedAlertKeys]);
  // WARDEN-551: the set of snoozes still ACTIVE (expiry in the future). Computed
  // each render against a fresh clock so the row's muted visual + bell re-arm the
  // instant a snooze expires (App's prune effect also clears the stale entry from
  // state on cadence, so this never lingers past expiry).
  const snoozedSet = activeSnoozedKeys(snoozedAlertKeys, Date.now());

  // Zero-state: render nothing intrusive. (A neutral ✓ was considered per the AC,
  // but an absent element is the least-noise zero state for an always-on header.)
  // WARDEN-575: an all-finished fleet (no problems) is NOT zero — those agents are a
  // positive "go review their work" cue — so the badge stays visible with a green
  // tone when only `done` items remain. Only a truly idle fleet (no problems AND no
  // recently-finished) renders nothing.
  if (rollup.total === 0 && rollup.done.length === 0) return null;

  // The directed answer (WARDEN-384): the ONE pane a human should go to first,
  // "you're needed HERE, because X" — promoted above the flat rundown so the human
  // doesn't have to scan to find "first." calloutTop is null only when focus exclusion
  // leaves no eligible pane (WARDEN-482) or no pane/health agent needs attention (e.g.
  // just directives/errors counts remain), in which case the sectioned rundown alone is
  // the directed answer. The callout is gated to ≥2 deep-linkable items: with exactly
  // one pane needing attention the rundown's lone row already IS the answer, so
  // promoting it would just duplicate that single pane as both the callout and the row
  // beneath it.
  //
  // WARDEN-482: calloutTop is focus-EXCLUDED — it is never the pane the human is
  // already reading (pickCalloutTop skips focusedPaneKey). The rundown (`ranked`,
  // unchanged) still lists the focused pane, so nothing is lost — it just isn't the
  // PROMOTED answer. The exclusion is applied locally here (not inside the shared
  // rankAttention, which also feeds the ungated return-banner callout).
  const { ranked } = rankAttention(rollup);
  const calloutTop = pickCalloutTop(ranked, focusedPaneKey);

  const { critical, warning, stuck, erroring, waiting, blocked, custom, done, directives, errors, total } = rollup;
  // WARDEN-575: when the only items are recently-finished agents (total === 0,
  // done > 0), the badge reads as a POSITIVE cue (green) — not an alarm. Otherwise
  // the severity cue is red when something is broken (critical/stuck/erroring agent
  // or a recent error), else amber (warnings / waiting / blocked / pending
  // directives). Color is supplementary only — the count + glyph already convey the
  // state (WCAG 1.4.1).
  const onlyDone = total === 0 && done.length > 0;
  const tone = onlyDone
    ? 'text-emerald-500'
    : critical.length > 0 || stuck.length > 0 || erroring.length > 0 || errors > 0
      ? 'text-red-500'
      : 'text-yellow-500';
  // The header count + glyph: problems show their total behind the alert glyph; an
  // all-finished fleet shows the finished count behind a positive check glyph.
  const headerCount = onlyDone ? done.length : total;
  const headerLabel = onlyDone
    ? `${done.length} agent${done.length !== 1 ? 's' : ''} finished`
    : `${total} item${total !== 1 ? 's' : ''} need attention`;

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
        {calloutTop && ranked.length >= 2 && (
          <div className="px-1.5 pt-1.5">
            <Callout top={calloutTop} onClick={() => openChat(calloutTop.id)} />
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
                      snoozedUntil={muteEnabled && snoozedSet.has(key) ? (snoozedAlertKeys[key] ?? null) : null}
                      muteEnabled={muteEnabled}
                      onSetAlertMute={onSetAlertMute}
                    />
                  );
                })}
              </Section>
            )}
            {stuck.length > 0 && (
              <Section title="Stuck" count={stuck.length} tone="text-red-500">
                {sortOldestEnteredAtFirst(stuck).map((a) => (
                  <AgentRow key={a.key || a.id} agent={a} dot="bg-red-500" detail={a.signal} enteredAt={a.enteredAt} durationStateLabel="stuck" onClick={() => openChat(a.key || a.id)} />
                ))}
              </Section>
            )}
            {erroring.length > 0 && (
              <Section title="Erroring" count={erroring.length} tone="text-red-500">
                {sortOldestEnteredAtFirst(erroring).map((a) => (
                  <AgentRow key={a.key || a.id} agent={a} dot="bg-red-500" detail={a.signal} enteredAt={a.enteredAt} durationStateLabel="erroring" onClick={() => openChat(a.key || a.id)} />
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
                      snoozedUntil={muteEnabled && snoozedSet.has(key) ? (snoozedAlertKeys[key] ?? null) : null}
                      muteEnabled={muteEnabled}
                      onSetAlertMute={onSetAlertMute}
                    />
                  );
                })}
              </Section>
            )}
            {waiting.length > 0 && (
              <Section title="Waiting on you" count={waiting.length} tone="text-yellow-500">
                {sortOldestEnteredAtFirst(waiting).map((a) => (
                  <AgentRow key={a.key || a.id} agent={a} dot="bg-yellow-500" detail={a.signal} enteredAt={a.enteredAt} durationStateLabel="waiting" onClick={() => openChat(a.key || a.id)} />
                ))}
              </Section>
            )}
            {blocked.length > 0 && (
              <Section title="Blocked" count={blocked.length} tone="text-yellow-500">
                {sortOldestEnteredAtFirst(blocked).map((a) => (
                  <AgentRow key={a.key || a.id} agent={a} dot="bg-yellow-500" detail={a.signal} enteredAt={a.enteredAt} durationStateLabel="blocked" onClick={() => openChat(a.key || a.id)} />
                ))}
              </Section>
            )}
            {custom.length > 0 && (
              <Section title="Watch patterns" count={custom.length} tone="text-yellow-500">
                {sortOldestEnteredAtFirst(custom).map((a) => (
                  <AgentRow
                    key={a.key || a.id}
                    agent={a}
                    dot="bg-yellow-500"
                    // detail = the matching line + the pattern name that matched it, so
                    // the human sees both WHAT printed and WHICH of their rules tripped.
                    detail={a.customMatch ? `'${a.customMatch.line}' (${a.customMatch.pattern})` : undefined}
                    enteredAt={a.enteredAt}
                    durationStateLabel="matching a watch pattern"
                    onClick={() => openChat(a.key || a.id)}
                  />
                ))}
              </Section>
            )}
            {/*
              WARDEN-575: the POSITIVE "Finished" section — agents that recently
              completed a task (working→idle within the recent window). Green tone +
              a check dot, distinct from the red/amber problem sections above: this is
              "go review their work," not an alarm. Rendered LAST (after every problem
              section) so alarms always read first; a non-alarming cue never outranks
              a real problem. Deep-links into the pane for review.
            */}
            {done.length > 0 && (
              <Section title="Finished" count={done.length} tone="text-emerald-500">
                {sortOldestEnteredAtFirst(done).map((a) => (
                  <AgentRow
                    key={a.key || a.id}
                    agent={a}
                    dot="bg-emerald-500"
                    detail="Finished a task"
                    enteredAt={a.enteredAt}
                    durationStateLabel="finished"
                    // done reads as elapsed SINCE the finish ("3m ago"), not an ongoing
                    // hold — the active→idle transition that populated `done` IS the
                    // enteredAt stamp, so the duration is the age of the completion.
                    durationTense="ago"
                    onClick={() => openChat(a.key || a.id)}
                  />
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
  snoozedUntil = null,
  muteEnabled = false,
  onSetAlertMute,
  enteredAt,
  durationStateLabel,
  durationTense = 'ongoing',
}: {
  agent: AttentionAgent;
  dot: string;
  onClick: () => void;
  /** The triggering signal (repeating line / matched prompt) for a pane-state row —
   * shown muted under the name so the human sees WHY it needs attention (WARDEN-344). */
  detail?: string | null;
  /** WARDEN-364 permanent mute. Drives the BellOff icon specifically (the row's
   * line-through/opacity styling keys off `suppressed` = muted OR snoozed below). */
  muted?: boolean;
  /** WARDEN-551 — snooze expiry (ms) for this row, or null. A future timestamp
   * means the row is snoozed (Clock icon + countdown + "End snooze now"); null
   * means not snoozed. Only the health-bucket rows pass this (mirrors `muted`). */
  snoozedUntil?: number | null;
  muteEnabled?: boolean;
  onSetAlertMute?: (key: string, mode: AlertMuteMode) => void;
  /** WARDEN-587: the epoch-ms this agent entered its current state — drives the live
   * "stuck 2h 14m" duration suffix. Absent on health-bucket rows (Chat carries no
   * stamp) and on a row observed before any stamp landed → no suffix renders. */
  enteredAt?: number;
  /** WARDEN-587: a short verb for the verbose tooltip/aria ("stuck for 2 hours 14
   * minutes"). Omit → "in this state for …". */
  durationStateLabel?: string;
  /** WARDEN-587: 'ago' reads the duration as elapsed SINCE a completion (the green
   * "Finished" section: "3m ago"); 'ongoing' (default) reads it as a held state. */
  durationTense?: 'ongoing' | 'ago';
}) {
  const label = agent.name || agent.key || agent.id;
  const muteKey = agent.key || agent.id;
  const [muteMenuOpen, setMuteMenuOpen] = useState(false);
  // Read the clock once per render; the badge re-renders on the rollup cadence
  // and when App's prune effect clears an expired snooze, so this stays current.
  const now = Date.now();
  const isSnoozed = snoozedUntil != null && snoozedUntil > now;
  const remaining = snoozedUntil != null ? formatSnoozeRemaining(snoozedUntil, now) : '';
  // WARDEN-587: the live duration suffix + its supplementary tone + verbose tooltip.
  // formatStateDuration returns '' under a minute (and for an unstamped row), so a
  // freshly-observed row renders no suffix — never a false "0s". The visible text is
  // the primary signal (WCAG 1.4.1); color + tooltip are supplementary.
  const durationCompact = enteredAt != null ? formatStateDuration(enteredAt, now) : '';
  const durationVerbose = enteredAt != null ? formatStateDurationVerbose(enteredAt, now) : '';
  const durationTone = languishingTone(enteredAt, now);
  const durationAgo = durationTense === 'ago';
  const durationShown = durationCompact
    ? durationAgo ? `${durationCompact} ago` : durationCompact
    : '';
  const durationLabel = durationVerbose
    ? durationAgo
      ? `finished ${durationVerbose} ago`
      : `${durationStateLabel ?? 'in this state'} for ${durationVerbose}`
    : '';
  // Either suppression state mutes the row visually (line-through + dim), matching
  // the suppression the OS channel applies (WARDEN-551: a snoozed agent shows muted).
  const suppressed = muted || isSnoozed;
  return (
    <div className="flex items-stretch gap-0.5 pr-1">
      <Button variant="ghost" onClick={onClick} className={cn('flex-1 min-w-0 justify-start gap-2 h-auto px-2 py-1.5 font-normal text-xs text-foreground', suppressed && 'opacity-60')}>
        <span className={cn('size-2 rounded-full shrink-0 mt-0.5', dot)} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1">
            <span className={cn('truncate', suppressed && 'line-through')}>{label}</span>
            {agent.role && <span className="text-xs text-blue-400 shrink-0">{agent.role}</span>}
            {agent.host && agent.host !== '(local)' && <span className="text-xs text-muted-foreground shrink-0">{agent.host}</span>}
          </span>
          {/* detail = the triggering signal (the repeating line / matched prompt) shown
              muted under the agent name so the human can see WHY it needs attention. */}
          {detail ? <span className="block truncate text-[10px] text-muted-foreground">{detail}</span> : null}
        </span>
        {/*
          WARDEN-587: the live duration suffix — how long this agent has been in its
          current state. Right-aligned, supplementary tone (muted → amber → red the
          longer it languishes), with a verbose tooltip ("stuck for 2 hours 14
          minutes"). Rendered only when there is a stamp AND it has aged past a minute
          (formatStateDuration returns '' otherwise). tabular-nums so the count doesn't
          shift width as it ticks.
        */}
        {durationShown ? (
          <span
            className={cn('shrink-0 self-center text-[10px] tabular-nums', DURATION_TONE_CLASS[durationTone])}
            title={durationLabel}
          >
            {durationShown}
          </span>
        ) : null}
      </Button>
      {/*
        WARDEN-364 + WARDEN-551 — per-agent mute/snooze on the desktop-alert
        channel (health buckets only). The bell now opens a small menu of
        durations (permanent / 1 hour / until tomorrow) instead of toggling
        permanent mute in one click, so the human can pick a time-boxed snooze
        that auto-rearms. While suppressed it shows the state + a one-click resume.
        stopPropagation on the trigger so tapping the bell never also opens the
        chat pane. The icon swaps Bell (alerting) ↔ BellOff (permanent) ↔ Clock
        (snoozed) so the state is glanceable without color alone (WCAG 1.4.1); the
        menu is a nested Radix Popover layer with aria-haspopup/aria-expanded for
        screen readers. Uses the library <Button> (variant=ghost size=icon-xs) —
        WARDEN-68 Rule 1: no raw <button>.
      */}
      {muteEnabled && onSetAlertMute && (
        <Popover open={muteMenuOpen} onOpenChange={setMuteMenuOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={(e) => e.stopPropagation()}
              aria-haspopup="menu"
              aria-expanded={muteMenuOpen}
              aria-label={
                isSnoozed
                  ? `Snoozed desktop alerts for ${label}${remaining ? ` — resumes in ${remaining}` : ''}`
                  : muted
                    ? `Stop muting desktop alerts for ${label}`
                    : `Mute desktop alerts for ${label}`
              }
              title={
                isSnoozed
                  ? (remaining ? `Snoozed — resumes in ${remaining}` : 'Snoozed')
                  : muted
                    ? 'Unmute desktop alerts for this agent'
                    : 'Mute desktop alerts for this agent'
              }
              className="shrink-0 self-center text-muted-foreground hover:text-foreground"
            >
              {isSnoozed ? <Clock className="size-3.5" /> : muted ? <BellOff className="size-3.5" /> : <Bell className="size-3.5" />}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-48 p-1">
            {isSnoozed && (
              <div className="px-2 py-1 text-[10px] text-muted-foreground">
                Snoozed{remaining ? ` — resumes in ${remaining}` : ''}
              </div>
            )}
            {suppressed ? (
              <MuteMenuRow
                label={isSnoozed ? 'End snooze now' : 'Resume alerts'}
                onClick={() => { onSetAlertMute(muteKey, 'off'); setMuteMenuOpen(false); }}
              />
            ) : (
              <>
                <MuteMenuRow label="Mute permanently" onClick={() => { onSetAlertMute(muteKey, 'permanent'); setMuteMenuOpen(false); }} />
                {/*
                  The two time-boxed snooze durations come from the SHARED
                  SNOOZE_DURATION_OPTIONS (snooze.ts) so the per-row menu and the
                  bulk SnoozeDialog (WARDEN-581) offer byte-for-byte the same
                  durations + wording — one snooze vocabulary, two entry points.
                */}
                {SNOOZE_DURATION_OPTIONS.map((o) => (
                  <MuteMenuRow key={o.value} label={o.label} onClick={() => { onSetAlertMute(muteKey, o.value); setMuteMenuOpen(false); }} />
                ))}
              </>
            )}
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}

// A single full-width option row inside the per-row mute/snooze menu. Mirrors the
// row styling (ghost, left-aligned, compact) so the menu reads as part of the
// same attention system. Reuses the library <Button> (WARDEN-68 Rule 1).
function MuteMenuRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      className="w-full justify-start h-auto px-2 py-1.5 font-normal text-xs text-foreground"
    >
      {label}
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
  // WARDEN-587: show the same live duration the section rows do, so the promoted
  // "you're needed HERE" answer carries the languishing-vs-just-flipped signal too
  // ("stuck 2h 14m"). Absent for health-group tops (no enteredAt) → no suffix.
  const now = Date.now();
  const duration = top.enteredAt != null ? formatStateDuration(top.enteredAt, now) : '';
  const durationVerbose = top.enteredAt != null ? formatStateDurationVerbose(top.enteredAt, now) : '';
  const durationTone = languishingTone(top.enteredAt, now);
  const durationLabel = durationVerbose ? `for ${durationVerbose}` : '';
  return (
    <Button variant="ghost" onClick={onClick} className={cn(rowClass(), 'rounded-md border border-border bg-muted/40 py-2')}>
      <span className={cn('size-2 rounded-full shrink-0 mt-0.5', dotForState(top.state))} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="text-xs text-foreground">
          You&rsquo;re needed in <span className="font-semibold">{top.name}</span>
        </span>
        <span className="block truncate text-xs text-muted-foreground">{reason}</span>
      </span>
      {/*
        WARDEN-587: the duration suffix on the directed answer. Rendered only when a
        stamp aged past a minute is present, with the same supplementary tone + verbose
        tooltip as the section rows. Sits beside "open →" so the callout reads as one
        composed answer: where, why, and for how long.
      */}
      {duration ? (
        <span
          className={cn('shrink-0 self-center text-[10px] tabular-nums', DURATION_TONE_CLASS[durationTone])}
          title={durationLabel}
        >
          {duration}
        </span>
      ) : null}
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
