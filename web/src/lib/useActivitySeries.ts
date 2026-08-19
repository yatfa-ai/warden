// useActivitySeries — the slow-cadence data source for the Fleet Health per-agent
// sparklines (WARDEN-299). Deliberately a SEPARATE concern from the 10s
// /api/health poll in HealthDashboard: the series is a 24h aggregate over the
// JSONL activity log, so it changes slowly and must NEVER land on the hot health
// path (no perf regression on the catalog render). Mirrors useHostStatuses /
// useAttentionRollup: a cheap local endpoint, kept as its own hook rather than
// folded into a shared /api/health context.
//
// Only HealthDashboard consumes this today; when the sidebar ChatRow / a per-host
// rollup adopt the Sparkline (future work, explicitly out of scope here), a
// ref-counted singleton like useHostStatuses is the natural next step.
import { useState } from 'react';
import type { ActivitySeries } from '@/lib/types';
import { useVisiblePoller } from '@/lib/useVisiblePoller';

// Slow cadence: a 24h hourly aggregate doesn't move in seconds. ~60s keeps the
// sparkline fresh without contention with the 10s /api/health poll. Visibility-
// gated below so a backgrounded tab never burns requests (matches the catalog
// auto-refresh in App.tsx and useHostStatuses).
const POLL_MS = 60_000;
// Default window mirrors the server's /api/activity/series default (last 24h),
// so a bare mount needs no params and the per-row sparkline shows a full day.
const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ActivitySeriesState {
  series: ActivitySeries | null;
  /** True only during the very first fetch (before any data has arrived). */
  loading: boolean;
  /** Last fetch error, if any; cleared by the next successful poll. Mirrors
   *  useLiveTimeline's channel (WARDEN-1060). Load-bearing because `series`
   *  alone cannot distinguish "still loading" from "loaded, and it failed":
   *  both failure paths below leave `series` null with `loading` false, so
   *  without this the panels render their loading string forever (WARDEN-1078).
   *  Stale data is still retained on failure — see the catch below. */
  error: Error | null;
}

export function useActivitySeries(): ActivitySeriesState {
  const [series, setSeries] = useState<ActivitySeries | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const load = async () => {
    const after = new Date(Date.now() - WINDOW_MS).toISOString();
    try {
      const res = await fetch(`/api/activity/series?after=${encodeURIComponent(after)}`);
      // A non-2xx (502/503 mid-restart, dev proxy down, a throw out of the
      // server's /api/activity/series handler) is a real failure, not a no-op:
      // record it so an observer can say so instead of claiming to be loading.
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as ActivitySeries;
      setSeries(data);
      setError(null);
    } catch (e) {
      // Transient network blip — keep the last known series rather than blanking
      // the sparklines to "no data" on every flake. That retention is deliberate
      // and preserved; what is NEW is that the failure is also RECORDED, so the
      // persistent case (no data ever arrived) is representable. Consumers gate
      // their error UI on `series == null` so a blip after a good poll still
      // renders the last good chart rather than swapping it for an error.
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setLoading(false);
    }
  };

  // Visibility-gated slow cadence: mount-poll once, then a POLL_MS tick that only
  // fires while the tab is visible, plus an immediate refresh on regaining focus
  // — a backgrounded tab never burns requests (WARDEN-753). The `cancelled` guard
  // the inline effect carried is intentionally dropped: React 19 treats a
  // setState after unmount as a silent no-op, so an in-flight fetch that resolves
  // post-unmount behaves identically (no crash, no warning, no state update).
  useVisiblePoller(load, POLL_MS, []);

  return { series, loading, error };
}
