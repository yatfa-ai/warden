// useWatchCatchup — the in-app catch-up surface for per-chat "watch" pings that
// fired while the human was AWAY (WARDEN-417). The recovery net under WARDEN-378's
// single OS-notification channel: when that channel no-ops (Notifications
// unsupported / denied / cleared / lost to DND), the watched chat's "needs you"
// transition is recorded durably at the fire site (useAttentionRollup) and surfaced
// here on the human's return, instead of being silently lost.
//
// This hook owns the surface STATE: it reads the durable miss log + the ack
// boundary (pure logic in watchCatchup.ts), recomputes the unacknowledged away
// misses on mount (an app reopen recovers the prior session's misses) and whenever
// the human RETURNS to Warden (visibilitychange → visible), and exposes the two
// ack paths — open-one (per-key) and dismiss-all (the seen boundary).
//
// `onOpenChat` is the SAME deep-link path fireWatchNotification.onclick and the
// AttentionBadge rows already use (App's openChat), so a click lands straight on
// the watched pane that needed the human. No new routing.
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  awayMisses,
  reconcileAwayMisses,
  loadWatchMissLog,
  getWatchSeen,
  stampWatchSeen,
  saveWatchMissLog,
  withoutKey,
  type WatchMiss,
} from '@/lib/watchCatchup';
import { indexByWatchKey } from '@/lib/chatWatch';
import type { AgentStateRow } from '@/lib/types';

export interface WatchCatchupState {
  /**
   * Unacknowledged away watch misses, deduped per key, urgency-ranked (erroring >
   * stuck > completed > waiting), with chats that have since recovered suppressed on
   * return (WARDEN-476). Empty → hide the surface.
   */
  misses: WatchMiss[];
  /** Deep-link to a watched chat's pane + acknowledge just that chat (per-key ack). */
  openMiss: (miss: WatchMiss) => void;
  /** Dismiss the whole catch-up — acknowledge every surfaced miss (ack-all). */
  dismiss: () => void;
  /**
   * Acknowledge (clear) every recorded miss for one chat key — the ack-on-open path
   * (WARDEN-417). Wired at App's openChat chokepoint so a watched chat opened via ANY
   * path (sidebar, OS-toast click, search, observer suggestion, catch-up row) clears
   * its catch-up and never re-surfaces as stale noise. Idempotent + short-circuits
   * when there is nothing to ack for the key.
   */
  ackKey: (key: string) => void;
}

/**
 * Surface the per-chat watch pings that fired while the human was away (WARDEN-417).
 *
 * The durable log (written at the fire site in useAttentionRollup, when the OS
 * channel lost the ping OR the human is away) is the single source of truth, so the
 * hook re-reads it on mount and on every visibility → visible transition — the two
 * moments a catch-up should appear (reopen after a close, and return-from-
 * backgrounded-tab). It does NOT re-read the LOG while present, because no new misses
 * are recorded for a present-and-delivered ping (shouldRecordMiss). It DOES re-
 * reconcile whenever the watched chats' CURRENT states refresh (the ~30s poll + the
 * visibility→visible refetch), so a miss whose chat recovered is suppressed on return
 * even though the recovery resolved a moment after the synchronous visibility re-read
 * (WARDEN-476).
 *
 * Ack mirrors whatsNew's lastSeen-stamp-on-visit so an acknowledged alert never
 * recurs as stale noise. There are THREE ack paths, all funneling through one
 * per-key clear (ackKey): (1) opening a watched chat via ANY path drops just that
 * chat's misses — ackKey is wired at App's openChat chokepoint, so the sidebar, the
 * OS-toast click, search, and the catch-up row all ack identically (the half-wired
 * ack the first attempt shipped — only the catch-up row acked — is what let a seen
 * ping re-surface as stale noise); (2) the catch-up row's openMiss (which calls
 * ackKey); (3) the × advances the seen boundary past every recorded miss (ack-all).
 */
export function useWatchCatchup(
  onOpenChat?: (id: string, anchor?: string) => void,
  // WARDEN-476: the watched chats' CURRENT states (exposed by useAttentionRollup as
  // its watchedStates return — built from the same open ∪ watched poll the watch diff
  // already rides, so zero extra SSH cost). Used at read-time to suppress away misses
  // whose chats have since RECOVERED on return, so the catch-up agrees with the live
  // return-banner callout. null/undefined before the first poll lands → no suppression
  // (every miss kept — the safe default; reconcileAwayMisses is a no-op on an empty
  // index). Trailing + optional so the existing call site stayed compatible pre-wire.
  currentStates?: AgentStateRow[] | null,
): WatchCatchupState {
  // Live current-states as a ref so the stable `compute`/`recompute` closures read the
  // freshest snapshot without their identity (and thus the visibility effect) churning
  // on every ~30s poll. The companion [currentStates] effect below is what re-runs the
  // reconciliation when a fresh poll lands.
  const currentStatesRef = useRef<AgentStateRow[] | null>(currentStates ?? null);
  currentStatesRef.current = currentStates ?? null;

  // Window + dedup + urgency-rank the durable log, then suppress the recovered chats
  // against the current snapshot (WARDEN-476). Pure end-to-end; reads currentStatesRef.
  const compute = useCallback((): WatchMiss[] => {
    const raw = awayMisses(loadWatchMissLog(), getWatchSeen());
    return reconcileAwayMisses(raw, indexByWatchKey(currentStatesRef.current));
  }, []);

  const [misses, setMisses] = useState<WatchMiss[]>(() => compute());

  const recompute = useCallback(() => {
    setMisses(compute());
  }, [compute]);

  // Mount (an app reopen recovers the prior session's unacked away misses) AND
  // return-from-away both re-read the durable log — the source of what fired while the
  // human was gone. The current-state reconciliation runs inside compute; the snapshot
  // here may be one poll stale at the instant of return (the visibility→visible refetch
  // resolves async), and the [currentStates] effect below re-reconciles once it lands.
  useEffect(() => {
    recompute();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') recompute();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [recompute]);

  // WARDEN-476: re-reconcile when fresh watched states arrive. The return-time agent-
  // states poll resolves ASYNC, AFTER the synchronous visibility recompute above; when
  // the new snapshot lands (a new ~30s poll, or the visibility→visible refetch), re-run
  // the reconciliation so a chat that recovered WHILE the human was away — or in the
  // moment between return and the poll resolving — is suppressed against the CURRENT
  // state, not the pre-return one. This is the path that makes the catch-up agree with
  // the live return-banner callout on return.
  useEffect(() => {
    recompute();
  }, [currentStates, recompute]);

  const ackKey = useCallback((key: string) => {
    // Per-key ack-on-open (WARDEN-417): drop every recorded miss for this chat so it
    // never re-surfaces as stale catch-up noise. Called from App's openChat chokepoint
    // (every path that opens a watched chat — sidebar, OS-toast click, search, observer
    // suggestion, catch-up row — funnels through openChat), so acking THERE means a ping
    // the human acted on is always acknowledged, regardless of which path they used.
    // Short-circuits when there is nothing to ack for the key (a non-watched chat, or
    // one with no recorded miss) so a routine openChat never pays a redundant write or
    // recompute. Idempotent — safe to call again after the chokepoint already cleared it.
    if (!key) return;
    const log = loadWatchMissLog();
    if (!log.some((m) => m.key === key)) return;
    saveWatchMissLog(withoutKey(log, key));
    recompute();
  }, [recompute]);

  const openMiss = useCallback((miss: WatchMiss) => {
    // Deep-link first (the row's primary job) via the same openChat path the OS ping's
    // onclick uses — openChat's chokepoint ack also fires — then ack THIS chat only
    // (idempotent with the chokepoint ack; guarantees a recompute even when onOpenChat
    // is absent), so the OTHER watched chats' misses remain until opened or dismissed.
    // WARDEN-877: thread miss.signal as the anchor so the deep-link lands on the
    // triggering line (the matched customMatch line for a custom ping, else the pane
    // signal) — the SAME findNext jump the attention rows produce. Undefined when the
    // miss carries no signal (focus-only open).
    onOpenChat?.(miss.key, miss.signal);
    ackKey(miss.key);
  }, [onOpenChat, ackKey]);

  const dismiss = useCallback(() => {
    // Advance the seen boundary past every recorded miss → all acknowledged. The
    // log entries remain (bounded ring-buffer history) but are now outside the away
    // window, so they never re-surface (until a fresh away period records new ones).
    stampWatchSeen();
    recompute();
  }, [recompute]);

  return { misses, openMiss, dismiss, ackKey };
}
