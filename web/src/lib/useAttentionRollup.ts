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
import { useState, useEffect, useCallback } from 'react';
import {
  buildAttentionRollup,
  EMPTY_ATTENTION_ROLLUP,
  type AttentionRollup,
} from '@/lib/attentionRollup';
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

export function useAttentionRollup(): AttentionRollupState {
  const [rollup, setRollup] = useState<AttentionRollup>(EMPTY_ATTENTION_ROLLUP);
  const [loading, setLoading] = useState(true);

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
    const tick = () => {
      if (document.visibilityState === 'visible') void fetchAll();
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
  }, [fetchAll]);

  return { rollup, loading };
}
