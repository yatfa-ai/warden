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
import { useState, useEffect, useCallback } from 'react';
import {
  awayMisses,
  loadWatchMissLog,
  getWatchSeen,
  stampWatchSeen,
  saveWatchMissLog,
  withoutKey,
  type WatchMiss,
} from '@/lib/watchCatchup';

export interface WatchCatchupState {
  /** Unacknowledged away watch misses, newest-first, deduped per key. Empty → hide. */
  misses: WatchMiss[];
  /** Deep-link to a watched chat's pane + acknowledge just that chat (per-key ack). */
  openMiss: (miss: WatchMiss) => void;
  /** Dismiss the whole catch-up — acknowledge every surfaced miss (ack-all). */
  dismiss: () => void;
}

/**
 * Surface the per-chat watch pings that fired while the human was away (WARDEN-417).
 *
 * The durable log (written at the fire site in useAttentionRollup, only while the
 * tab is hidden) is the single source of truth, so the hook re-reads it on mount
 * and on every visibility → visible transition — the two moments a catch-up should
 * appear (reopen after a close, and return-from-backgrounded-tab). It does NOT
 * re-read while present, because no new misses are recorded while present (the
 * fire site is hidden-gated), so the surface is stable between returns.
 *
 * Ack mirrors whatsNew's lastSeen-stamp-on-visit so an acknowledged alert never
 * recurs as stale noise: opening a chat drops just that chat's misses (the others
 * remain), and the × advances the seen boundary past every recorded miss.
 */
export function useWatchCatchup(onOpenChat?: (id: string) => void): WatchCatchupState {
  const [misses, setMisses] = useState<WatchMiss[]>(() =>
    awayMisses(loadWatchMissLog(), getWatchSeen()),
  );

  const recompute = useCallback(() => {
    setMisses(awayMisses(loadWatchMissLog(), getWatchSeen()));
  }, []);

  // Mount (an app reopen recovers the prior session's unacked away misses) AND
  // return-from-away both re-read the durable log — the source of what fired while
  // the human was gone. No re-read while present: the fire site only records while
  // hidden, so the surface cannot change between returns.
  useEffect(() => {
    recompute();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') recompute();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [recompute]);

  const openMiss = useCallback((miss: WatchMiss) => {
    // Deep-link first (the row's primary job), via the same openChat path the OS
    // ping's onclick uses — then ack THIS chat only, so the other watched chats'
    // misses remain in the catch-up until the human opens or dismisses them.
    onOpenChat?.(miss.key);
    saveWatchMissLog(withoutKey(loadWatchMissLog(), miss.key));
    recompute();
  }, [onOpenChat, recompute]);

  const dismiss = useCallback(() => {
    // Advance the seen boundary past every recorded miss → all acknowledged. The
    // log entries remain (bounded ring-buffer history) but are now outside the away
    // window, so they never re-surface (until a fresh away period records new ones).
    stampWatchSeen();
    recompute();
  }, [recompute]);

  return { misses, openMiss, dismiss };
}
