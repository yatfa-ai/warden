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
}

export function useActivitySeries(): ActivitySeriesState {
  const [series, setSeries] = useState<ActivitySeries | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    const after = new Date(Date.now() - WINDOW_MS).toISOString();
    try {
      const res = await fetch(`/api/activity/series?after=${encodeURIComponent(after)}`);
      if (!res.ok) return;
      const data = (await res.json()) as ActivitySeries;
      setSeries(data);
    } catch {
      // Transient network blip — keep the last known series rather than blanking
      // the sparklines to "no data" on every flake.
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

  return { series, loading };
}
