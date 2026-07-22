// AttentionList — the shared, drift-free rendering of the ranked "where am I needed,
// because X" rundown (Observer Intelligence roadmap WARDEN-8, Job #2).
//
// WARDEN-880: this rendering used to live inline inside AttentionBadge's popover, so
// the ranked answer was reachable ONLY as a TRANSIENT popover that dismissed on every
// pane switch. It is now extracted so TWO surfaces consume the IDENTICAL rendering:
//
//   1. AttentionBadge — the always-visible header trigger; this list fills its popover.
//   2. AttentionView  — a PERSISTENT peer tab in ObserverTabs (Sessions/Activity/
//      Directives/Attention) that stays mounted while the human opens/switches agent
//      panes, so multi-agent triage no longer re-opens the popover N times.
//
// Both consume App's lifted `attentionRollup` (single source of truth — no duplicate
// polling) and the shared pure helpers `rankAttention` / `pickCalloutTop` /
// `attentionReason` / `rollupSeverity`, so the ranking, the "because X" reasons, the
// duration suffixes, the mute/snooze row actions, and the severity tone are bit-for-bit
// identical across both surfaces. There is no second implementation to keep in sync.
//
// This component renders ONLY the directed callout + the sectioned rundown. The caller
// owns the zero-state decision (the badge hides entirely; the persistent view shows an
// EmptyState) and the scroll geometry (the popover caps height at max-h-72; the
// persistent view fills the panel) via the `className` / `scrollClassName` props.
import { useMemo, useState, type ReactNode } from 'react';
import { Bell, BellOff, Clock, Reply } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import {
  rankAttention,
  pickCalloutTop,
  attentionReason,
  rollupSeverity,
  type AttentionRollup,
  type AttentionItem,
  type AttentionSeverity,
} from '@/lib/attentionRollup';
import { activeSnoozedKeys, formatSnoozeRemaining, SNOOZE_DURATION_OPTIONS, type AlertMuteMode, type SnoozeMap } from '@/lib/snooze';
import { formatStateDuration, formatStateDurationVerbose, languishingTone, sortOldestEnteredAtFirst, type StateDurationTone } from '@/lib/stateDuration';
import type { AttentionAgent } from '@/lib/types';
import type { Snippet } from '@/lib/storage';
import { cn } from '@/lib/utils';
// WARDEN-770 — the inline reply affordance shared by every attention surface. Rendered
// (conditionally, only for replyable rows) inside AgentRow below.
import { QuickReply } from '@/components/QuickReply';

/**
 * The shared prop set every attention surface consumes. This is exactly the set App
 * already threads to the header `<AttentionBadge>` (WARDEN-436 lifted the rollup + the
 * mute/snooze/focus context up to App so the badge, the return banner, and now the
 * persistent view all share one rollup with no duplicate polling). The persistent
 * Attention view receives the SAME values, threaded through ObserverTabs.
 */
export interface AttentionListProps {
  /** The live, already-aggregated attention rollup (App's single source of truth). */
  rollup: AttentionRollup;
  /** Open the agent's chat pane (reuses App's openChat). */
  onOpenChat: (id: string) => void;
  /** Open the observer panel's Activity tab (reuses App's openActivityTab). */
  onOpenActivity: () => void;
  /** Opt-in desktop alerts (WARDEN-259). Used only for the per-row mute bell affordance. */
  attentionDesktopAlerts: boolean;
  /** WARDEN-364 — per-agent permanent mute set for the desktop channel's row bell. */
  mutedAlertKeys: string[];
  /** WARDEN-551 — chat key → snooze expiry (ms). The time-boxed twin of mutedAlertKeys. */
  snoozedAlertKeys: SnoozeMap;
  /** WARDEN-551/364 — unified mute/snooze setter for a chat key. */
  onSetAlertMute: (key: string, mode: AlertMuteMode) => void;
  /** WARDEN-482: the pane the human is currently focused on. pickCalloutTop excludes it
   *  when choosing the callout target so the directed answer never promotes the pane the
   *  human is already reading (the "trains the human to ignore it" product-killer). The
   *  sectioned rundown still lists it unchanged — no information loss. */
  focusedPaneKey?: string | null;
  /** WARDEN-770 — saved instruction snippets for the inline reply control's one-click fills. */
  snippets?: Snippet[];
  /** WARDEN-770 — surface the reply send outcome so App can toast it. */
  onReplyResult?: (ok: boolean, error?: string) => void;
}

// WARDEN-587: the duration suffix's supplementary color escalates the longer an agent
// has been in its state — muted (fresh) → amber → red — so a glance picks out the
// LANGUISHING rows. The duration TEXT always carries the primary signal (WCAG 1.4.1);
// color is supplementary only. The -600 shades (not -500) keep the count readable on the
// light popover background at text-[10px] — escalation must not make a languishing row's
// duration HARDER to read than a fresh one (the opposite of the intent). The dot (not the
// text) already carries the section's red/amber severity, so the text need only tick up.
const DURATION_TONE_CLASS: Record<StateDurationTone, string> = {
  fresh: 'text-muted-foreground',
  amber: 'text-amber-600',
  red: 'text-red-600',
};

// severity → supplementary tone class. Shared by the badge trigger, the badge popover
// header, and the persistent Attention view header so the three never drift on which
// rollup reads which color (the severity DECISION itself is the tested pure helper
// rollupSeverity in attentionRollup.ts; this maps it to a class at the call site).
const SEVERITY_TONE_CLASS: Record<AttentionSeverity, string> = {
  positive: 'text-emerald-500',
  red: 'text-red-500',
  amber: 'text-yellow-500',
};

/** The supplementary severity tone class for a rollup (e.g. the header count color). */
export function severityToneClass(rollup: AttentionRollup): string {
  return SEVERITY_TONE_CLASS[rollupSeverity(rollup).severity];
}

/**
 * The shared ranked "where am I needed, because X" rundown: the directed callout (the
 * ONE pane to act on first, focus-excluded, gated to ≥2 deep-linkable items so it never
 * just duplicates the lone row beneath it) + the sectioned rundown in severity order
 * (critical → stuck → erroring → warnings → waiting → blocked → watch patterns →
 * finished → pending directives → recent errors). Every row deep-links into the pane or
 * the Activity tab via the handlers from App.
 *
 * `className` is applied to the root column; `scrollClassName` to the rundown's scroll
 * container. Defaults match the popover (root `flex flex-col`, rundown `max-h-72
 * overflow-y-auto`); the persistent Attention view passes fill-height values so the
 * rundown scrolls within the panel instead of a fixed cap.
 */
export function AttentionList({
  rollup,
  onOpenChat,
  onOpenActivity,
  attentionDesktopAlerts,
  mutedAlertKeys,
  snoozedAlertKeys,
  onSetAlertMute,
  focusedPaneKey,
  snippets,
  onReplyResult,
  className,
  scrollClassName = 'max-h-72 overflow-y-auto',
}: AttentionListProps & { className?: string; scrollClassName?: string }) {
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

  const { critical, warning, stuck, erroring, waiting, blocked, custom, done, directives, errors } = rollup;

  return (
    <div className={cn('flex flex-col', className)}>
      {calloutTop && ranked.length >= 2 && (
        <div className="px-1.5 pt-1.5">
          <Callout top={calloutTop} onClick={() => onOpenChat(calloutTop.id)} />
        </div>
      )}
      {/*
        Bounded with max-h-* + overflow-y-auto by default (NOT Radix ScrollArea). The
        Radix Viewport is height:100%, which needs a *definite* ancestor height to
        resolve against — but max-height (and flex-1/min-h-0 through an overflow:visible
        PopoverContent) does NOT establish one, so a ScrollArea grows to fit all rows and
        never scrolls (verified: rows past ~7 were clipped & unreachable). A plain div's
        own max-height directly caps its own scroll, so it shrinks for short lists and
        scrolls for long ones (e.g. a host outage taking many agents critical). The
        persistent view overrides this with a fill-height class so it scrolls in-panel.
      */}
      <div className={scrollClassName}>
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
                    onClick={() => onOpenChat(key)}
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
                <AgentRow key={a.key || a.id} agent={a} dot="bg-red-500" detail={a.signal} enteredAt={a.enteredAt} durationStateLabel="stuck" onClick={() => onOpenChat(a.key || a.id)} />
              ))}
            </Section>
          )}
          {erroring.length > 0 && (
            <Section title="Erroring" count={erroring.length} tone="text-red-500">
              {sortOldestEnteredAtFirst(erroring).map((a) => (
                <AgentRow key={a.key || a.id} agent={a} dot="bg-red-500" detail={a.signal} enteredAt={a.enteredAt} durationStateLabel="erroring" onClick={() => onOpenChat(a.key || a.id)} />
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
                    onClick={() => onOpenChat(key)}
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
                <AgentRow
                  key={a.key || a.id}
                  agent={a}
                  dot="bg-yellow-500"
                  detail={a.signal}
                  enteredAt={a.enteredAt}
                  durationStateLabel="waiting"
                  onClick={() => onOpenChat(a.key || a.id)}
                  // WARDEN-770: the two states that resolve with a one-line human
                  // input earn the inline reply affordance. waiting (parked at a
                  // "press enter"/"needs input" prompt) is the headline case.
                  replyable
                  snippets={snippets}
                  onReplyResult={onReplyResult}
                />
              ))}
            </Section>
          )}
          {blocked.length > 0 && (
            <Section title="Blocked" count={blocked.length} tone="text-yellow-500">
              {sortOldestEnteredAtFirst(blocked).map((a) => (
                <AgentRow
                  key={a.key || a.id}
                  agent={a}
                  dot="bg-yellow-500"
                  detail={a.signal}
                  enteredAt={a.enteredAt}
                  durationStateLabel="blocked"
                  onClick={() => onOpenChat(a.key || a.id)}
                  // WARDEN-770: blocked (waiting on approval/dependency) is the
                  // second replyable state — the human can unblock inline.
                  replyable
                  snippets={snippets}
                  onReplyResult={onReplyResult}
                />
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
                  onClick={() => onOpenChat(a.key || a.id)}
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
                  onClick={() => onOpenChat(a.key || a.id)}
                />
              ))}
            </Section>
          )}
          {directives > 0 && (
            <Section title="Pending directives" count={directives} tone="text-blue-500">
              <LinkRow label={`${directives} directive${directives !== 1 ? 's' : ''} proposed`} dot="bg-blue-500" onClick={onOpenActivity} />
            </Section>
          )}
          {errors > 0 && (
            <Section title="Recent errors" count={errors} tone="text-red-500">
              <LinkRow label={`${errors} error${errors !== 1 ? 's' : ''} in the last 15m`} dot="bg-red-500" onClick={onOpenActivity} />
            </Section>
          )}
        </div>
      </div>
    </div>
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
  replyable = false,
  snippets,
  onReplyResult,
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
  /** WARDEN-770 — show the inline reply affordance. Passed ONLY from the waiting +
   * blocked sections (the two states that resolve with a one-line human input);
   * every other section omits it so critical/stuck/erroring/warning/custom/done rows
   * are untouched (preserves the existing deep-link + severity ordering). */
  replyable?: boolean;
  /** WARDEN-770 — the snippet library for the reply control's one-click fills. */
  snippets?: Snippet[];
  /** WARDEN-770 — surface the reply send outcome so App can toast it. */
  onReplyResult?: (ok: boolean, error?: string) => void;
}) {
  const label = agent.name || agent.key || agent.id;
  const muteKey = agent.key || agent.id;
  const [muteMenuOpen, setMuteMenuOpen] = useState(false);
  // WARDEN-770: the inline reply panel's expand/collapse state. Off by default so the
  // row stays compact; the Reply toggle reveals the QuickReply control below the row.
  // Collapses automatically on a successful send (QuickReply.onDismiss).
  const [replyOpen, setReplyOpen] = useState(false);
  // Read the clock once per render; the badge/view re-renders on the rollup cadence
  // and when App's prune effect clears an expired snooze, so this stays current.
  const now = Date.now();
  const isSnoozed = snoozedUntil != null && snoozedUntil > now;
  const remaining = snoozedUntil != null ? formatSnoozeRemaining(snoozedUntil, now) : '';
  // WARDEN-587: the live duration suffix + its supplementary tone + verbose tooltip.
  // formatStateDuration returns '' under a minute (and for an unstamped row), so a
  // freshly-observed row renders no suffix — never a false "0s". The visible text is
  // the primary signal (WCAG 1.4.1); color + tooltip are supplementary. The 'ago' (done)
  // tense passes a sub-minute label so a JUST-finished pane reads "<1m ago" instead of
  // nothing — recency is the signal in the transient 3-min Finished window, so hiding the
  // first minute would bury the most relevant readout. The ongoing tense stays suppressed
  // under a minute (its false-precision guard).
  const durationCompact = enteredAt != null
    ? formatStateDuration(enteredAt, now, durationTense === 'ago' ? { subMinute: '<1m' } : undefined)
    : '';
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
    <div className="flex flex-col">
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
        WARDEN-770 — the inline reply toggle (waiting/blocked rows only). A distinct
        affordance from the row's onClick deep-link (which still opens the pane): this
        reveals the QuickReply control below the row so the human can answer a "press
        enter"/"needs approval" agent WITHOUT leaving the surface. stopPropagation on
        the trigger so tapping it never also opens the chat pane (mirrors the mute bell
        below). Uses the library <Button> (variant=ghost size=icon-xs) — WARDEN-68
        Rule 1: no raw <button>. aria-expanded reflects the panel state for screen
        readers.
      */}
      {replyable && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={(e) => { e.stopPropagation(); setReplyOpen((v) => !v); }}
          aria-haspopup="dialog"
          aria-expanded={replyOpen}
          aria-label={replyOpen ? `Hide reply to ${label}` : `Reply to ${label} without opening the pane`}
          title={replyOpen ? 'Hide reply' : 'Reply without opening the pane'}
          className="shrink-0 self-center text-muted-foreground hover:text-foreground"
        >
          <Reply className="size-3.5" />
        </Button>
      )}
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
      {/*
        WARDEN-770 — the expanded inline reply control (waiting/blocked rows only).
        Rendered below the row when the Reply toggle is open, so the human can type a
        reply / pick a snippet / press Enter and send straight to this agent's tmux
        session via /api/send + /api/key — zero pane switches. The control owns its
        textarea + the confirm gate; on a successful send it collapses itself via
        onDismiss. The target id is the row's pane identity (agent.key || agent.id),
        the SAME key onOpenChat would deep-link — so the reply lands in the correct pane.
      */}
      {replyable && replyOpen && (
        <QuickReply
          targetId={muteKey}
          targetLabel={label}
          snippets={snippets ?? []}
          onReplyResult={onReplyResult}
          onDismiss={() => setReplyOpen(false)}
        />
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
 * (WARDEN-384). Rendered once at the top of the rundown, above the sections, so a
 * human with several panes needing attention sees the one to act on first without
 * scanning. Clicking deep-links into the pane via the caller's onOpenChat — no new
 * routing. Styled as a distinct headline (bordered + muted fill) so it reads as the
 * answer, not another list row.
 */
function Callout({ top, onClick }: { top: AttentionItem; onClick: () => void }) {
  // The "because X": the shared attentionReason helper (WARDEN-436) — the concrete
  // signal when one flows (pane states), else a state-keyed fallback (health-group
  // agents carry no signal of their own). Shared across every surface that presents
  // the ranked answer so the phrasing is identical.
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
// state→color mapping and the surfaces stay visually consistent. WARDEN-880: also
// re-exported from AttentionBadge so App's existing import path is unchanged.
export function dotForState(state: string): string {
  return state === 'erroring' || state === 'stuck' || state === 'critical'
    ? 'bg-red-500'
    : 'bg-yellow-500';
}
