// gitStatusHooks — the React + TanStack Query glue over the pure seam in
// gitStatusQuery.ts (WARDEN-1211). Two consumers, ONE cache key per agent:
//
//   - useGitStatus(key)       — ChatSidebar's focused-pane read.
//   - useFleetGitStatus(agents) — Fleet Health's fan (in useFleetGitStatus.ts),
//     rebuilt on useQueries over the same keys.
//
// Cadence discipline (unchanged from the surfaces this replaces — the roadmap's
// cost bar): NO auto-poll. Every query below runs with staleTime: Infinity +
// refetchOnMount/WindowFocus/Reconnect disabled, so a query fires only when (a)
// its key has no cached data yet (mount / membership change / focus change), or
// (b) someone explicitly invalidates or refetches. The sidebar refetches on the
// catalog cadence by invalidating in its own effect (as before); Fleet Health
// refreshes only via its manual ↻. Refetching a shared key on either surface
// heals the OTHER surface too — that is the defect this ticket closes.

import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { fetchGitStatusPayload, gitStatusQueryKey, GIT_STATUS_KEY } from '@/lib/gitStatusQuery';

/** Options every git-status query runs under — no auto-poll, no retry storms. */
export const GIT_STATUS_QUERY_OPTIONS = {
  staleTime: Infinity,
  gcTime: 5 * 60_000,
  retry: false, // an unreachable agent is a state, not a transient — don't hammer SSH
  refetchOnMount: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} as const;

/**
 * The focused-pane read of the shared git-status fact (replaces ChatSidebar's
 * private `fetchGitStatus`). Returns the raw query result for ONE agent key;
 * the sidebar keeps its branch-less → "no repo" rendering decision as a
 * consumer-side read of a SUCCESSFUL payload (`data && data.branch`), while a
 * thrown/failed fetch surfaces as `status === 'error'` (the strict WARDEN-89
 * gate lives in the shared fetcher, not here).
 *
 * The late-response guard the old gitReqRef provided is inherent: each key's
 * fetch writes only its OWN cache entry, and the consumer always reads the
 * focused key's entry — a late A response can never overwrite B's.
 *
 * Does not auto-refetch (staleTime: Infinity + no refetch triggers). The
 * sidebar's catalog-cadence liveness is driven by useInvalidateGitStatus below.
 */
export function useGitStatus(key: string | null | undefined): UseQueryResult<Record<string, unknown>, Error> {
  return useQuery({
    queryKey: gitStatusQueryKey(key ?? ''),
    queryFn: () => fetchGitStatusPayload(key as string),
    enabled: typeof key === 'string' && key.length > 0,
    ...GIT_STATUS_QUERY_OPTIONS,
  });
}

/**
 * Invalidate ONE agent's git-status fact (refetches it if any surface is
 * reading it). ChatSidebar calls this from its `[focused, chats]` effect — the
 * same beat the old private fetch fired on — so the focused pane stays live on
 * the catalog cadence while a currently-unfocused (e.g. fleet-only) agent's
 * entry stays cached, not hammered.
 */
export function useInvalidateGitStatus(): (key: string) => void {
  const qc = useQueryClient();
  return useMemo(() => (key: string) => {
    void qc.invalidateQueries({ queryKey: gitStatusQueryKey(key) });
  }, [qc]);
}

/**
 * Invalidate EVERY agent's git-status fact. Fleet Health's manual ↻ calls this:
 * one gesture refetches the fan, and any sidebar-held entry heals in the same
 * beat — the two surfaces can no longer disagree past the next refresh on
 * either side (the WARDEN-1211 observable).
 */
export function useInvalidateAllGitStatus(): () => void {
  const qc = useQueryClient();
  return useMemo(() => () => {
    void qc.invalidateQueries({ queryKey: [GIT_STATUS_KEY] });
  }, [qc]);
}

/**
 * Log resolved git-status errors once per settle (the WARDEN-89 "never swallow
 * a failure silently" trace the old fan's warn loop provided). Pure side
 * effect over a useQueries result set.
 */
export function useLogGitStatusErrors(
  results: ReadonlyArray<{ error: Error | null }>,
  keys: readonly string[],
): void {
  const signature = results.map((r) => r.error?.message ?? '').join('\u0000');
  useEffect(() => {
    results.forEach((r, i) => {
      if (r.error) console.warn('[fleet git-status] agent fetch failed:', r.error, `(key: ${keys[i] ?? '?'})`);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the joined error signature so the warn fires once per settle, not per render
  }, [signature]);
}
