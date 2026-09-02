// useFleetGitStatus — the lifted hook behind Fleet Health's repository-state axis
// (WARDEN-766). Fans /api/git-status across every active project agent (the SAME
// eligible fleet FleetRecentCommits fans over) and returns a per-agent
// { clean, diffstat, ... } map + fleet-wide dirty/conflict/behind/ahead/stalled/
// stashed counts + an honest error count.
//
// WARDEN-1211: the fan no longer issues PRIVATE fetches. Each leg is a TanStack
// Query over the SHARED cache key `['git-status', key]` (the same key the
// sidebar's focused-pane read uses), so a fact fetched by either surface is
// served to both — the two surfaces can no longer disagree about one agent.
// One fetch, not two, for an agent held by both.
//
// Refresh discipline (UNCHANGED): fetch-on-mount + a MANUAL refresh() (bumps an
// invalidation of every git-status key). NO setInterval, NO auto-poll — every
// query runs staleTime: Infinity with all refetch triggers off, so the N-fetch
// fan is paid ONLY when a key first enters the fleet, on a real membership
// change (new keys mount-fetch), or on the manual ↻. The 10s /api/health tick
// reallocates the agents array but changes no cache key, so it fires nothing.
//
// The pure aggregation (buildFleetGitStatus + fleetCommitSearchEligible + the
// shared fetcher/slice seam) lives in @/lib/gitStateSummary and
// @/lib/gitStatusQuery (unit-tested without React); this file owns only the
// fan-out + result assembly.

import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import type { Chat } from '@/lib/types';
import {
  fleetCommitSearchEligible,
  buildFleetGitStatus,
  type FleetGitStatusResult,
  type FleetGitStatusSlice,
} from '@/lib/gitStateSummary';
import {
  fetchGitStatusPayload,
  gitStatusQueryKey,
  toFleetSlice,
} from '@/lib/gitStatusQuery';
import { GIT_STATUS_QUERY_OPTIONS, boundedGitStatusFetcher, useInvalidateAllGitStatus, useLogGitStatusErrors } from '@/lib/gitStatusHooks';

export interface FleetGitStatusState extends FleetGitStatusResult {
  /** # of fanned agents with status.clean === false (the fleet "N dirty" count). */
  dirtyCount: number;
  /** # of fanned agents whose fetch failed (surfaced honestly, WARDEN-89). */
  errorCount: number;
  /** # of fanned agents blocked mid-merge/rebase with unmerged paths (the fleet "N conflict" count, WARDEN-796). */
  conflictCount: number;
  /** # of fanned agents running on stale, behind-upstream code (the fleet "N behind" count, WARDEN-815). */
  behindCount: number;
  /** # of fanned agents with committed-but-unpushed work (the fleet "N unpushed" count, WARDEN-822). */
  aheadCount: number;
  /** # of fanned agents whose HEAD commit is >7d old (the fleet "N stalled" count, WARDEN-847). */
  stalledCount: number;
  /** # of fanned agents holding parked `git stash` WIP (the fleet "N stashed" count, WARDEN-871). */
  stashedCount: number;
  /** Pull a fresh view past mount (no auto-poll). */
  refresh: () => void;
  /** True only during a fetch whose result has not yet arrived (mount or manual ↻). */
  loading: boolean;
}

/**
 * Fan /api/git-status across the eligible fleet and lift the result for
 * HealthDashboard. Pass `healthData?.agents ?? []` so the hook no-ops cleanly
 * before the first /api/health response lands.
 */
export function useFleetGitStatus(agents: readonly Chat[]): FleetGitStatusState {
  // The eligible fleet: active project agents, keyed & deduped by key || id, in
  // catalog order — the SAME gate the sibling fleet fans use.
  const eligible = useMemo(() => fleetCommitSearchEligible(agents), [agents]);
  const keys = useMemo(() => eligible.map((a) => a.key), [eligible]);

  // One SHARED-cache query per eligible agent (WARDEN-1211). New keys (mount or
  // membership change) fetch because they have no cached entry; existing keys
  // with data never refetch here — only an explicit invalidation (the manual ↻,
  // or the sidebar's catalog-cadence invalidation of ITS focused key) refetches
  // them. The array identity churn of `agents` is irrelevant: useQueries keys on
  // the key LIST, value-compared.
  const queries = useQueries({
    queries: keys.map((key) => ({
      queryKey: gitStatusQueryKey(key),
      queryFn: () => fetchGitStatusPayload(key, boundedGitStatusFetcher),
      ...GIT_STATUS_QUERY_OPTIONS,
    })),
  });

  useLogGitStatusErrors(queries, keys);

  const refresh = useInvalidateAllGitStatus();
  const loading = queries.some((q) => q.isFetching);

  // Assemble outcomes in catalog order: a settled error → that agent's honest
  // error outcome; settled data → the Fleet slice via the shared coercion; a
  // still-pending first fetch contributes NO outcome yet (loading covers it) —
  // it is neither a status nor an error until it lands.
  const result = useMemo(() => {
    if (keys.length === 0) {
      return buildFleetGitStatus([] as { ok: false; key: string }[], Date.now());
    }
    const outcomes = queries.map((q, i) =>
      q.isError
        ? { ok: false as const, key: keys[i] }
        : q.data
          ? { ok: true as const, key: keys[i], status: toFleetSlice(q.data) as FleetGitStatusSlice }
          : null,
    );
    return buildFleetGitStatus(
      outcomes.filter((o): o is { ok: true; key: string; status: FleetGitStatusSlice } | { ok: false; key: string } => o !== null),
      Date.now(),
    );
    // `queries` identity changes per render; the outcome-relevant inputs are the
    // per-key data/error/fetching statuses — the map+filter derives them, and
    // Date.now() must be read at assembly time, so this memo is per-render-shape
    // (cheap) rather than stable. Assembly is pure and fast; correctness over
    // micro-stability.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queries, keys]);

  return { ...result, refresh, loading };
}
