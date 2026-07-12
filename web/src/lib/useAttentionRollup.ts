// useAttentionRollup — the live, visibility-gated data source for the header
// AttentionBadge (WARDEN-228). Polls /api/health and /api/activity/stats on the
// same ~10s cadence HealthDashboard uses, then folds them into an AttentionRollup
// via the pure buildAttentionRollup aggregator.
//
// Why a standalone hook (not a shared /api/health context with HealthDashboard):
// the health side panel is collapsed by default, so the badge is the ONLY always-on
// health consumer. Duplicate /api/health polling only happens while the user has
// deliberately expanded HealthDashboard — an acceptable trade for a cheap local
// endpoint every 10s, and far smaller risk than refactoring HealthDashboard onto a
// shared context. See WARDEN-228 impl notes ("standalone hook is acceptable").
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  buildAttentionRollup,
  EMPTY_ATTENTION_ROLLUP,
  type AttentionRollup,
} from '@/lib/attentionRollup';
import { shouldFireAlert, fireAttentionNotification } from '@/lib/desktopAlerts';
import type { HealthData, ActivityStats } from '@/lib/types';

// Recent-error / recent-directive window. ActivityStats counts raw events in the
// queried window — there is NO server-side "unresolved"/"pending" flag — so a
// bounded recent window is the proxy for "needs your eye". 15 min is a glanceable
// "what just happened" horizon that doesn't grow unbounded over a long session.
// (The "While you were away" startup banner keeps its own since-last-close window;
// this is the live, always-on rollup, so it uses a fixed rolling window instead.)
export const ATTENTION_RECENT_WINDOW_MS = 15 * 60 * 1000;

// Match HealthDashboard's polling cadence.
const POLL_MS = 10_000;

export interface AttentionRollupState {
  rollup: AttentionRollup;
  /** True only during the very first fetch (before any data has arrived). */
  loading: boolean;
}

export function useAttentionRollup(attentionDesktopAlerts = false): AttentionRollupState {
  const [rollup, setRollup] = useState<AttentionRollup>(EMPTY_ATTENTION_ROLLUP);
  const [loading, setLoading] = useState(true);
  // The previous rollup, for the desktop-alert increase detector below. Tracked
  // in a ref (not state) so updating it never triggers a re-render and the gate
  // effect's only dependency is the rollup itself.
  const prevRef = useRef<AttentionRollup | null>(null);

  const fetchAll = useCallback(async () => {
    const after = new Date(Date.now() - ATTENTION_RECENT_WINDOW_MS).toISOString();
    // allSettled: a health OR stats failure must not blank the other half of the
    // rollup, and must not crash the badge. A failed half degrades to null and
    // buildAttentionRollup treats null as an empty bucket; the last good data for
    // the other half is preserved.
    const [healthRes, statsRes] = await Promise.allSettled([
      fetch('/api/health').then((r) => (r.ok ? (r.json() as Promise<HealthData>) : Promise.reject(new Error(`health ${r.status}`)))),
      fetch(`/api/activity/stats?after=${encodeURIComponent(after)}`).then((r) => (r.ok ? (r.json() as Promise<ActivityStats>) : Promise.reject(new Error(`stats ${r.status}`)))),
    ]);
    const health = healthRes.status === 'fulfilled' ? healthRes.value : null;
    const stats = statsRes.status === 'fulfilled' ? statsRes.value : null;
    setRollup(buildAttentionRollup(health, stats));
    setLoading(false);
  }, []);

  useEffect(() => {
    void fetchAll();
    // Visibility-gated: a backgrounded tab never burns requests (matches the catalog
    // auto-refresh in App.tsx). On regaining focus we poll immediately because state
    // may be stale while hidden.
    //
    // EXCEPT when desktop alerts are opted in (WARDEN-259): then the poll MUST keep
    // running while hidden, otherwise the rollup would never update while the human
    // is away and the "fire on increase-while-hidden" alert would have no trigger.
    // This reuses the SAME poll + subscriber (no second loop) — it only relaxes the
    // visibility guard for opted-in users, so the default-off case is unchanged.
    const tick = () => {
      if (attentionDesktopAlerts || document.visibilityState === 'visible') void fetchAll();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void fetchAll();
    };
    const intervalId = window.setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [fetchAll, attentionDesktopAlerts]);

  // Fire an OS desktop notification on a genuine rollup INCREASE while Warden is
  // unfocused (WARDEN-259). The always-on AttentionBadge already covers the
  // in-app case, so a desktop alert while looking at Warden is pure noise — hence
  // the hidden guard. shouldFireAlert returns true ONLY on a total increase, so a
  // persistent condition never repeats and a recovery never fires. prevRef always
  // advances (even when we don't fire) so the next comparison is against the last
  // rollup, not a stale one. No-op entirely when the pref is off.
  //
  // The initial EMPTY_ATTENTION_ROLLUP is a loading PLACEHOLDER, not real data
  // (buildAttentionRollup always returns a fresh object, so this reference check
  // is true only for the placeholder). Skipping it leaves prev=null until the
  // first REAL poll, so that first poll becomes the baseline instead of firing on
  // pre-existing attention at launch/reload — matches shouldFireAlert's
  // "either input missing → false" and the "While you were away" banner's role.
  useEffect(() => {
    if (rollup === EMPTY_ATTENTION_ROLLUP) return;
    const prev = prevRef.current;
    prevRef.current = rollup;
    if (!attentionDesktopAlerts) return;
    if (document.visibilityState === 'visible') return;
    if (shouldFireAlert(prev, rollup)) {
      fireAttentionNotification(rollup);
    }
  }, [rollup, attentionDesktopAlerts]);

  return { rollup, loading };
}
