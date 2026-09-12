import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActivityEvent } from '@/lib/types';
import { fetchBounded, pollerFetchOptions } from '@/lib/api';
import {
  POLL_INTERVAL_MS,
  shouldPoll,
  shouldRefreshOnVisibility,
} from '@/lib/timelinePacing';

// Makes a cross-host feed "live": new rows recorded server-side appear
// automatically (within one ~15s interval) without a manual Refresh, the human
// can freeze the feed with a Live/Pause toggle, and polling stops while the tab
// is hidden (resumes on focus). The cadence + visibility *decisions* are
// delegated to the pure helpers in timelinePacing.ts so they are unit-tested
// there; this hook owns only the React/DOM wiring (timers, listeners, fetch
// state).
//
// Generalized over `{path, select, label}` (WARDEN-1353) so BOTH timeline
// feeds — the activity feed (ActivityTimeline) and the directives feed
// (DirectiveHistory) — share this ONE wiring cluster. The defaults reproduce
// the original activity-feed behavior exactly.
//
// This mirrors the 30s `setInterval(fetchHostStatuses, 30000)` + clearInterval
// cleanup pattern already used for the agent list in ChatSidebar.tsx, and the
// useNotificationPrefs.ts hook convention for lib/ custom hooks.

export interface UseLiveTimelineOptions<T> {
  /** Endpoint path; `?limit=` is appended by the hook. Default: '/api/activity'. */
  path?: string;
  /** Pull the row array out of the parsed JSON. Default: the activity shape,
   *  `(json) => json.events || []`. A feed with a defensively-parsed payload
   *  (e.g. DirectiveHistory's `Array.isArray` guard) preserves that stricter
   *  form in its own `select` — the default must not silently downgrade it. */
  select?: (json: any) => T[];
  /** Label used in the console.error on fetch failure. Default: 'activity'. */
  label?: string;
}

export interface UseLiveTimelineResult<T = ActivityEvent> {
  events: T[];
  /** True only for the very first fetch after mount/limit-change (drives the
   *  full-screen "Loading…" state). Background polls NEVER set this,
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
  /** Last fetch error, if any. Stale rows are retained on failure — a
   *  transient fetch error never wipes a feed the user is reading. */
  error: Error | null;
  /** Force a one-shot refresh (used by the Refresh button). Runs regardless of
   *  Live/Pause or visibility. */
  refresh: () => Promise<void>;
}

const isDocumentHidden = () =>
  typeof document !== 'undefined' ? document.hidden : false;

// WARDEN-1144: this read gates `loading` (first fetch) and `refreshing` (every
// background tick), so it is bounded by the shared deadline on the POLLER policy
// — no retries, deadline < the poll period. The next tick IS the retry; a stalled
// one must not stack attempts against an already-blocked server. The mount fetch
// and the manual Refresh share the same options deliberately: they run on a
// surface that DOES tick again, so the shorter leash is right for them too.
const FETCH_OPTS = pollerFetchOptions(POLL_INTERVAL_MS);

// Defaults reproducing the original activity-feed behavior exactly. The
// generic `defaultSelect` instantiates to the hook's row type at the
// destructuring default below.
const DEFAULT_PATH = '/api/activity';
const DEFAULT_LABEL = 'activity';
const defaultSelect = <T>(json: any): T[] => json.events || [];

export function useLiveTimeline<T = ActivityEvent>(
  limit: number,
  opts?: UseLiveTimelineOptions<T>,
): UseLiveTimelineResult<T> {
  const [events, setEvents] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isLive, setIsLive] = useState(true);
  const [isHidden, setIsHidden] = useState<boolean>(isDocumentHidden());
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [error, setError] = useState<Error | null>(null);

  // Has the first fetch for the current `limit` completed? Guards `loading` so
  // background polls never re-trigger the full-screen loader.
  const loadedRef = useRef(false);

  // ⚠️ OPTIONS-REFERENCE STABILITY — the one real trap of the WARDEN-1353
  // generalization. `opts` is read through a ref and is deliberately EXCLUDED
  // from the `useCallback` dep array below. A component passing an inline
  // object literal (or an inline `select` arrow) creates a fresh reference on
  // every render; keying the memo on `opts` — or on anything re-derived from
  // it per render — would re-create `fetchEvents` each render, and the
  // `[fetchEvents]` initial-fetch effect below would re-fire in a loop: an
  // infinite fetch storm. Reading through the ref keeps the memo keyed on
  // `[limit]` alone — byte-identical to pre-generalization — so ANY consumer,
  // including one that passes options inline, is loop-safe by construction.
  // Options are therefore read at call time and treated as static feed config
  // (both consumers pass module-level constants); mutating them mid-mount is
  // not a supported reload trigger.
  const optsRef = useRef<UseLiveTimelineOptions<T> | undefined>(opts);
  optsRef.current = opts;

  const fetchEvents = useCallback(
    async (backgroundOpts?: { background?: boolean }) => {
      const { path = DEFAULT_PATH, select = defaultSelect, label = DEFAULT_LABEL } =
        optsRef.current ?? {};
      const background = backgroundOpts?.background === true;
      if (background) setRefreshing(true);
      try {
        const res = await fetchBounded(`${path}?limit=${limit}`, FETCH_OPTS);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        setEvents(select(j));
        setLastUpdated(Date.now());
        setError(null);
      } catch (e) {
        // Log (never silent) but keep stale data in place — a transient fetch
        // failure must not wipe a live feed the user is reading.
        console.error(`Failed to fetch ${label}:`, e);
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
