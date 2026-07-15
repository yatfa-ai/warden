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
 * backgrounded-tab). It does NOT re-read while present, because no new misses are
 * recorded for a present-and-delivered ping (shouldRecordMiss), so the surface is
 * stable between returns.
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
export function useWatchCatchup(onOpenChat?: (id: string) => void): WatchCatchupState {
  const [misses, setMisses] = useState<WatchMiss[]>(() =>
    awayMisses(loadWatchMissLog(), getWatchSeen()),
  );

  const recompute = useCallback(() => {
    setMisses(awayMisses(loadWatchMissLog(), getWatchSeen()));
  }, []);

  // Mount (an app reopen recovers the prior session's unacked away misses) AND
  // return-from-away both re-read the durable log — the source of what fired while the
  // human was gone. No re-read while present: the fire site records only when the OS
  // channel lost the ping OR the human is away (shouldRecordMiss), so the surface is
  // stable between returns.
  useEffect(() => {
    recompute();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') recompute();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [recompute]);

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
    onOpenChat?.(miss.key);
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
