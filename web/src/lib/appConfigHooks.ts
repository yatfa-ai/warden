// appConfigHooks — React + TanStack Query glue over the pure seam in
// appConfigQuery.ts (WARDEN-1696).
//
// Cadence discipline (matches gitStatusHooks.ts): NO auto-poll and no
// focus/reconnect/mount refetch. staleTime: Infinity — the cache is filled by
// the first reader and then refreshed ONLY by App's refreshConfigPrefs, which
// runs on mount and after every Settings save (queryClient.fetchQuery with
// staleTime: 0), so subscribers live-update without a reload.

import { useQuery } from '@tanstack/react-query';
import { appConfigQueryKey, fetchAppConfig, selectCompanionTransportEnabled, selectObserverAutoStart, selectObserverSessionTimeout } from '@/lib/appConfigQuery';
import { fetchBounded } from '@/lib/api';

/**
 * The fetcher the /api/config query runs through: the shared BOUNDED deadline
 * (transport-only retry; any HTTP status is returned as-is, so fetchAppConfig's
 * `r.ok` gate still applies). Lives here, not in appConfigQuery.ts, to keep that
 * module's single-import-free purity seam.
 */
export const boundedAppConfigFetcher: typeof fetch = (input, init) =>
  fetchBounded(String(input), { init });

/** Query function shared by the hook and App.refreshConfigPrefs. */
export const appConfigQueryFn = () => fetchAppConfig(boundedAppConfigFetcher);

/** Options every app-config query runs under — no auto-poll, no refetch triggers. */
export const APP_CONFIG_QUERY_OPTIONS = {
  staleTime: Infinity,
  refetchOnMount: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} as const;

/** Whether the companion transport is enabled (defaults true until config loads). */
export function useCompanionTransportEnabled(): boolean {
  const { data } = useQuery({
    queryKey: appConfigQueryKey(),
    queryFn: appConfigQueryFn,
    ...APP_CONFIG_QUERY_OPTIONS,
    select: selectCompanionTransportEnabled,
  });
  return data ?? true;
}

/** WARDEN-332 — observer auto-start (defaults false until config loads). */
export function useObserverAutoStart(): boolean {
  const { data } = useQuery({
    queryKey: appConfigQueryKey(),
    queryFn: appConfigQueryFn,
    ...APP_CONFIG_QUERY_OPTIONS,
    select: selectObserverAutoStart,
  });
  return data ?? false;
}

/**
 * WARDEN-332 — observer idle timeout in minutes; null disables auto-close.
 * null is a LEGITIMATE value, so NO `?? 30` on data: only `undefined` (no body
 * cached yet) falls back to the boot default 30.
 */
export function useObserverSessionTimeout(): number | null {
  const { data } = useQuery({
    queryKey: appConfigQueryKey(),
    queryFn: appConfigQueryFn,
    ...APP_CONFIG_QUERY_OPTIONS,
    select: selectObserverSessionTimeout,
  });
  return data === undefined ? 30 : data;
}
