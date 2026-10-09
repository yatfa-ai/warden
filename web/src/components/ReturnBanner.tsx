import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu';
import { copyWithToast } from '@/lib/clipboardToast';
import { cn } from '@/lib/utils';
import { dotForState } from '@/components/AttentionBadge';
import {
  rankAttention,
  hasReturnContent,
  attentionReason,
  type AttentionItem,
  type AttentionRollup,
} from '@/lib/attentionRollup';

// WARDEN-436: the return banner may FIRST appear only within this window after the
// human returns (>60s away). It covers the rollup's cold-start window (the first
// /api/health + /api/agent-states polls fire on mount but take a round-trip to
// resolve — the callout fills in as they land). Matches the slowest poll cadence
// (AGENT_STATE_POLL_MS) so a slow first fetch can still latch the banner. After the
// window the banner never appears ambiently; a pane that LATER needs attention
// updates the header badge, not a spontaneous banner. See the windowed latch below.
const RETURN_BANNER_WINDOW_MS = 30_000;

// WARDEN-1612 (client-state slice 36): the return-after-absence banner, extracted
// from App.tsx. Its state (activitySinceClose / returnedAfterAbsence /
// bannerDismissed / returnWindowActive / bannerShownOnce) is read and written ONLY
// here, so banner-only state changes no longer re-render the whole App. It must stay
// continuously mounted (App renders it OUTSIDE the settings ternary) so the
// once-per-launch return check below does not re-run on Settings open/close. The
// warden:lastClose WRITE stays in App.tsx (handleBeforeUnload).
export interface ReturnBannerProps {
  rollup: AttentionRollup;
  onOpenChat: (id: string, anchor?: string) => void;
  onOpenActivity: () => void;
}

export function ReturnBanner({ rollup, onOpenChat, onOpenActivity }: ReturnBannerProps) {
  const [activitySinceClose, setActivitySinceClose] = useState<any>(null);
  // WARDEN-436: the return banner now surfaces the ranked "you're needed HERE"
  // callout as its lead. Visibility is split into two concerns:
  //  - returnedAfterAbsence: the user-initiated RETURN trigger (set once on mount
  //    when >60s elapsed since warden:lastClose). This is the conservative,
  //    never-ambient gate — the banner can ONLY ever show right after a return.
  //  - bannerDismissed: the human clicked × — suppresses the banner until the next
  //    return (so it never re-pops ambiently mid-session).
  // The actual show/hide is DERIVED below (returnedAfterAbsence && !dismissed &&
  // hasReturnContent(...)) so the ranked callout can fill in once the rollup
  // arrives without an imperative setShow, and so the gate broadening — also fire
  // on a non-null ranked top, not just since-close activity events — lives in one
  // pure, unit-tested predicate (hasReturnContent).
  const [returnedAfterAbsence, setReturnedAfterAbsence] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  useEffect(() => {
    // Check for activity since last close — the "While you were away" return
    // digest. The RETURN trigger (returnedAfterAbsence) fires whenever >60s
    // elapsed since warden:lastClose, REGARDLESS of whether any activity events
    // occurred: WARDEN-436 broadened the banner so it also surfaces the ranked
    // "you're needed HERE" callout (current rollup state) even when nothing
    // happened while away. The since-close event tally is fetched separately and
    // shown as secondary context beneath the callout. (The actual show/hide is
    // derived in render from returnedAfterAbsence + hasReturnContent.)
    const checkActivitySinceClose = async () => {
      const lastCloseStr = localStorage.getItem('warden:lastClose');
      if (lastCloseStr) {
        const lastClose = parseInt(lastCloseStr, 10);
        const now = Date.now();
        if (now - lastClose > 60000) { // Only show if closed for more than 1 minute
          setReturnedAfterAbsence(true);
          try {
            const res = await fetch(`/api/activity/stats?after=${new Date(lastClose).toISOString()}`);
            const stats = await res.json();
            if (stats.total > 0) {
              setActivitySinceClose(stats);
            }
          } catch (e) {
            console.error('Failed to fetch activity stats:', e);
          }
        }
      }
    };
    checkActivitySinceClose();
  }, []);

  // The single directed "you're needed HERE, because X" answer — the banner's lead.
  // top is null when no pane/health agent currently needs attention (only raw
  // directive/error counts, which have no pane to deep-link). Recomputed only when
  // the rollup reference changes (the hook's own useMemo already stabilizes it).
  const attentionTop = useMemo<AttentionItem | null>(
    () => rankAttention(rollup).top,
    [rollup],
  );
  // The since-close activity tally — STABLE: fetched once on mount
  // (checkActivitySinceClose), never re-fetched, so it can't drive a later pop-in.
  const activityTotalSinceClose = activitySinceClose?.total ?? 0;

  // ── Return-banner visibility: a windowed latch (WARDEN-436 conservative constraint)
  //
  // The banner may FIRST appear only within RETURN_BANNER_WINDOW_MS of the human
  // returning. Once it has appeared it stays until dismissed; if the fleet was
  // healthy at return and nothing surfaced within the window, it NEVER appears.
  // This keeps the banner a strictly user-initiated RETURN digest, never an ambient
  // surface: a pane that becomes stuck/critical LATER (well after return, mid-work)
  // updates the header AttentionBadge — NOT a spontaneous full-width banner.
  //
  // Within the window the banner DISPLAYS the LIVE attentionTop ("needed right now",
  // per WARDEN-427 decision #3): if the rollup is cold at first paint the callout
  // fills in as the first poll resolves, falling back to the tally alone. Intended
  // tradeoff (review nit): because the latch watches the LIVE top, a pane that turns
  // stuck/critical up to ~30s AFTER return can surface in the banner mid-work. This
  // is bounded (one window, strictly return-initiated) and is the cost of decision
  // #3 wanting live "needed right now" state to fill in rather than a strictly
  // at-return-instant snapshot.
  const [returnWindowActive, setReturnWindowActive] = useState(false);
  const [bannerShownOnce, setBannerShownOnce] = useState(false);
  useEffect(() => {
    if (!returnedAfterAbsence) return;
    // Open the return window once the return is detected.
    setReturnWindowActive(true);
    const timer = window.setTimeout(() => setReturnWindowActive(false), RETURN_BANNER_WINDOW_MS);
    return () => window.clearTimeout(timer);
  }, [returnedAfterAbsence]);
  useEffect(() => {
    // Latch "shown" the first time content appears WHILE the return window is open.
    // The latch is what freezes the decision: after the window, a newly-non-null
    // attentionTop can no longer trigger the banner (returnWindowActive is false).
    if (returnWindowActive && !bannerShownOnce && hasReturnContent(activityTotalSinceClose, attentionTop)) {
      setBannerShownOnce(true);
    }
  }, [returnWindowActive, bannerShownOnce, activityTotalSinceClose, attentionTop]);
  const showReturnBanner = bannerShownOnce && !bannerDismissed;

  if (!showReturnBanner) return null;
  // The callout's deep-link, shared by the Button click and the context menu's "Open"
  // item so the two cannot drift.
  const openTop = (top: AttentionItem) => onOpenChat(top.id, top.anchor ?? undefined);
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2 bg-blue-50 dark:bg-blue-950 border-b border-blue-200 dark:border-blue-800">
      {/*
        WARDEN-436 — the ranked "you're needed HERE, because X" callout is the
        banner's LEAD (one-click deep-link into the pane that needs the human,
        via the same openChat the header badge uses). The since-close event
        tally is demoted to secondary context on its right. The banner renders
        the callout whenever the rollup's top is non-null (no >=2 gate — the
        banner has no rundown beneath it, unlike the badge popover); it fills in
        as soon as the rollup arrives (the first ~poll after return) and falls
        back to the tally alone in the first seconds or when no pane needs
        attention.
        Layout (WARDEN-436 review fix): the right cluster (View Activity + ×)
        is shrink-0 so the dismiss × is ALWAYS reachable; the callout Button is
        `shrink min-w-0` (overriding the <Button> base `shrink-0`) so a long
        agent name TRUNCATES instead of forcing the row wider and stranding ×
        off-screen at narrow viewports. The name is capped (`max-w-40`) +
        truncate; "You're needed in" is shrink-0 (label never clips); the reason
        is `max-w-sm` + truncate. Statically reasoned from the flex/overflow
        model — not browser-measured here (worker sandbox blocks Chromium;
        deferred to the reviewer sandbox per WARDEN-130/WARDEN-68).
      */}
      <div className="flex items-center gap-3 text-sm min-w-0">
        {attentionTop && (
          // WARDEN-1360: the banner callout no longer carries an inline reply.
          // It was gated on canReply(state) — true only for the removed
          // waiting/blocked buckets — so no ranked top can ever be replyable
          // again. (The QuickReply control survives on the WATCH lane, in
          // WatchCatchup, whose reasons are a user-authored literal, not a
          // substring guess.)
          <div className="flex flex-col gap-1 min-w-0 shrink">
            <div className="flex items-center gap-1 min-w-0">
              {/*
                WARDEN-1663 — themed right-click menu on the directed callout, matching
                its twin Callout in AttentionList (WARDEN-1269). `asChild` composes
                the context-menu handler onto the existing deep-link Button (no wrapper, so
                the shrink/min-w-0 truncation layout above is untouched); left-click
                still opens the pane. No manual handlers or preventDefault here (WARDEN-926).
              */}
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    onClick={() => openTop(attentionTop)}
                    aria-label={`You're needed in ${attentionTop.name ?? attentionTop.id}. Open it.`}
                    className="shrink min-w-0 gap-2 h-auto py-1 px-2.5 rounded-md bg-white/80 dark:bg-blue-900/50 hover:bg-white dark:hover:bg-blue-900/70 text-blue-900 dark:text-blue-50 font-normal"
                  >
                    <span className={cn('size-2 rounded-full shrink-0', dotForState(attentionTop.state))} aria-hidden />
                    <span className="text-sm whitespace-nowrap shrink-0">You&rsquo;re needed in</span>
                    <span className="text-sm font-semibold max-w-40 truncate">{attentionTop.name ?? attentionTop.id}</span>
                    <span className="text-xs text-blue-700/90 dark:text-blue-200/80 max-w-sm truncate">{attentionReason(attentionTop)}</span>
                    <span className="text-xs text-blue-600 dark:text-blue-300 shrink-0 whitespace-nowrap">open →</span>
                  </Button>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onSelect={() => openTop(attentionTop)}>Open</ContextMenuItem>
                  <ContextMenuSeparator />
                  {/* The (max-w-40 truncated) name shown in "You're needed in {name}". */}
                  <ContextMenuItem onSelect={() => copyWithToast(attentionTop.name || attentionTop.id)}>Copy pane name</ContextMenuItem>
                  {/* The (max-w-sm truncated) "because X" line, fully copyable here. */}
                  <ContextMenuItem onSelect={() => copyWithToast(attentionReason(attentionTop))}>Copy reason</ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            </div>
          </div>
        )}
        {activitySinceClose && (
          <span className="text-blue-700 dark:text-blue-300 min-w-0">
            <span className="font-medium text-blue-900 dark:text-blue-100 mr-2">While you were away:</span>
            {activitySinceClose.directive_sent > 0 && (
              <span className="mr-3">{activitySinceClose.directive_sent} directive{activitySinceClose.directive_sent !== 1 ? 's' : ''} sent</span>
            )}
            {activitySinceClose.attached > 0 && (
              <span className="mr-3">{activitySinceClose.attached} session{activitySinceClose.attached !== 1 ? 's' : ''} attached</span>
            )}
            {activitySinceClose.error > 0 && (
              <span className="mr-3 text-red-600 dark:text-red-400">{activitySinceClose.error} error{activitySinceClose.error !== 1 ? 's' : ''}</span>
            )}
            {activitySinceClose.total > 0 && (
              <span className="text-blue-600 dark:text-blue-400">{activitySinceClose.total} total event{activitySinceClose.total !== 1 ? 's' : ''}</span>
            )}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button
          variant="ghost"
          onClick={onOpenActivity}
          className="h-auto px-2 py-1 text-xs rounded bg-blue-200 dark:bg-blue-800 text-blue-900 dark:text-blue-100 hover:bg-blue-300 dark:hover:bg-blue-700"
        >
          View Activity
        </Button>
        <Button
          variant="ghost"
          onClick={() => setBannerDismissed(true)}
          aria-label="Dismiss return banner"
          className="h-auto px-1.5 py-1 text-base leading-none text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-200"
        >
          ×
        </Button>
      </div>
    </div>
  );
}
