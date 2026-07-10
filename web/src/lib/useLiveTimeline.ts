import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActivityEvent } from '@/lib/types';
import {
  POLL_INTERVAL_MS,
  shouldPoll,
  shouldRefreshOnVisibility,
} from '@/lib/timelinePacing';

// Makes the cross-host Activity Timeline "live": new events recorded
// server-side appear automatically (within one ~15s interval) without a manual
// Refresh, the human can freeze the feed with a Live/Pause toggle, and polling
// stops while the tab is hidden (resumes on focus). The cadence + visibility
// *decisions* are delegated to the pure helpers in timelinePacing.ts so they
// are unit-tested there; this hook owns only the React/DOM wiring (timers,
// listeners, fetch state).
//
// This mirrors the 30s `setInterval(fetchHostStatuses, 30000)` + clearInterval
// cleanup pattern already used for the agent list in ChatSidebar.tsx, and the
// useNotificationPrefs.ts hook convention for lib/ custom hooks.

export interface UseLiveTimelineResult {
  events: ActivityEvent[];
  /** True only for the very first fetch after mount/limit-change (drives the
   *  full-screen "Loading activity…" state). Background polls NEVER set this,
   *  so a live feed never blanks out from under the user. */
  loading: boolean;
  /** True during any in-flight fetch (initial or background). Drives the
   *  Refresh button's transient "Refreshing…" state. */
  refreshing: boolean;
  /** Live/Pause state. true (Live) = poll on a cadence while visible. */
  isLive: boolean;
  setIsLive: (next: boolean | ((prev: boolean) => boolean)) => void;
  /** ms-since-epoch of the last *successful* fetch, or null before the first. */
  lastUpdated: number | null;
  /** Last fetch error, if any. Stale events are retained on failure — a
   *  transient fetch error never wipes a feed the user is reading. */
  error: Error | null;
  /** Force a one-shot refresh (used by the Refresh button). Runs regardless of
   *  Live/Pause or visibility. */
  refresh: () => Promise<void>;
}

const isDocumentHidden = () =>
  typeof document !== 'undefined' ? document.hidden : false;

export function useLiveTimeline(limit: number): UseLiveTimelineResult {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isLive, setIsLive] = useState(true);
  const [isHidden, setIsHidden] = useState<boolean>(isDocumentHidden());
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [error, setError] = useState<Error | null>(null);

  // Has the first fetch for the current `limit` completed? Guards `loading` so
  // background polls never re-trigger the full-screen loader.
  const loadedRef = useRef(false);

  const fetchEvents = useCallback(
    async (opts?: { background?: boolean }) => {
      const background = opts?.background === true;
      if (background) setRefreshing(true);
      try {
        const res = await fetch(`/api/activity?limit=${limit}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        setEvents(j.events || []);
        setLastUpdated(Date.now());
        setError(null);
      } catch (e) {
        // Log (never silent) but keep stale data in place — a transient fetch
        // failure must not wipe a live feed the user is reading.
        console.error('Failed to fetch activity:', e);
        setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        if (background) setRefreshing(false);
        if (!loadedRef.current) {
          loadedRef.current = true;
          setLoading(false);
        }
      }
    },
    [limit],
  );

  // Initial / on-limit-change foreground fetch. Resetting the loader on a new
  // limit shows "Loading…" until the new window lands. (No `?after=`/incremental
  // merge: full re-fetch of the (small, capped) window each tick is simplest
  // and avoids dedup edge cases — the documented MVP.)
  useEffect(() => {
    loadedRef.current = false;
    setLoading(true);
    fetchEvents();
  }, [fetchEvents]);

  // Page Visibility: when the tab returns to the foreground while Live, refresh
  // immediately so the user sees fresh data at once instead of waiting up to
  // POLL_INTERVAL_MS for the next scheduled tick. The decision is delegated to
  // the pure shouldRefreshOnVisibility helper.
  useEffect(() => {
    const onVisibility = () => {
      const nextHidden = isDocumentHidden();
      if (shouldRefreshOnVisibility(isHidden, nextHidden, isLive)) {
        fetchEvents({ background: true });
      }
      setIsHidden(nextHidden);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [fetchEvents, isHidden, isLive]);

  // Polling cadence: a single setInterval that lives only while the gate is
  // open. Toggling Pause or hiding/showing the tab tears it down and (when the
  // gate re-opens) sets it back up — no leaked timers across visibility changes.
  useEffect(() => {
    if (!shouldPoll(isLive, !isHidden)) return;
    const id = setInterval(() => fetchEvents({ background: true }), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [isLive, isHidden, fetchEvents]);

  const refresh = useCallback(async () => {
    await fetchEvents({ background: true });
  }, [fetchEvents]);

  return {
    events,
    loading,
    refreshing,
    isLive,
    setIsLive,
    lastUpdated,
    error,
    refresh,
  };
}
