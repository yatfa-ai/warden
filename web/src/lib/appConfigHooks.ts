// appConfigHooks — React + TanStack Query glue over the pure seam in
// appConfigQuery.ts (WARDEN-1696).
//
// Cadence discipline (matches gitStatusHooks.ts): NO auto-poll and no
// focus/reconnect/mount refetch. staleTime: Infinity — the cache is filled by
// the first reader and then refreshed ONLY by App's refreshConfigPrefs, which
// runs on mount and after every Settings save (queryClient.fetchQuery with
// staleTime: 0), so subscribers live-update without a reload.

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { appConfigQueryKey, fetchAppConfig, selectCompanionTransportEnabled, selectIssueLinksEnabled, selectIssueLinkTrackersRaw, selectObserverAutoStart, selectObserverSessionTimeout, selectShowHostTags } from '@/lib/appConfigQuery';
import { normalizeIssueLinkEntries, unambiguousPrefixEntries, type IssueLinkEntry } from '@/lib/issue-links';
import { fetchBounded } from '@/lib/api';
import { resolvePollIntervalMs, WEB_POLL_DEFAULT_MS } from '@/lib/pollInterval';

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

/**
 * WARDEN-1709 — the resolved dashboard poll cadence (ms). `select` runs the tested
 * `resolvePollIntervalMs` (CLI default 1500 / sub-floor / over-ceiling → web-safe),
 * composed HERE so appConfigQuery.ts keeps its no-imports contract. Before config
 * loads (or on a failed first fetch) it is the 60s web default.
 */
export function usePollIntervalMs(): number {
  const { data } = useQuery({
    queryKey: appConfigQueryKey(),
    queryFn: appConfigQueryFn,
    ...APP_CONFIG_QUERY_OPTIONS,
    select: (cfg) => resolvePollIntervalMs(cfg?.pollIntervalMs),
  });
  return data ?? WEB_POLL_DEFAULT_MS;
}

/** WARDEN-37 — show the host tag in pane headers (defaults true until config loads). */
export function useShowHostTags(): boolean {
  const { data } = useQuery({
    queryKey: appConfigQueryKey(),
    queryFn: appConfigQueryFn,
    ...APP_CONFIG_QUERY_OPTIONS,
    select: selectShowHostTags,
  });
  return data ?? true;
}

/** WARDEN-1388 — issue-key link integration toggle (strict `=== true`; off until config loads). */
export function useIssueLinksEnabled(): boolean {
  const { data } = useQuery({
    queryKey: appConfigQueryKey(),
    queryFn: appConfigQueryFn,
    ...APP_CONFIG_QUERY_OPTIONS,
    select: selectIssueLinksEnabled,
  });
  return data ?? false;
}

const NO_ISSUE_ENTRIES: IssueLinkEntry[] = [];

/**
 * WARDEN-1388 — the tracker mapping, defensively re-normalized on every read (a
 * hand-edited config.json bypasses PUT sanitization). `select` returns the raw
 * array (TanStack structural sharing keeps its identity while the body is
 * unchanged) and the memo keeps the normalized array stable, so effects keyed on
 * it do not refire every render. Empty until config loads.
 */
export function useIssueLinkTrackers(): IssueLinkEntry[] {
  const { data } = useQuery({
    queryKey: appConfigQueryKey(),
    queryFn: appConfigQueryFn,
    ...APP_CONFIG_QUERY_OPTIONS,
    select: selectIssueLinkTrackersRaw,
  });
  return useMemo(() => {
    const out = normalizeIssueLinkEntries(data);
    return out.length === 0 ? NO_ISSUE_ENTRIES : out;
  }, [data]);
}

/**
 * WARDEN-1394 — the markdown issue-key linkifier's entry set for the fleet-level
 * markdown surfaces (observer messages, directive text, transcript messages).
 * Unlike the terminal (strict per-pane project scoping), the markdown path
 * consults EVERY configured entry whose prefix is unique across the set; a prefix
 * mapped under two projects links nowhere. Gated on the integration toggle so OFF
 * (the default) yields [] — no plugin registration, byte-identical rendering.
 */
export function useMarkdownIssueEntries(): IssueLinkEntry[] {
  const enabled = useIssueLinksEnabled();
  const trackers = useIssueLinkTrackers();
  return useMemo(
    () => (enabled ? unambiguousPrefixEntries(trackers) : NO_ISSUE_ENTRIES),
    [enabled, trackers],
  );
}
