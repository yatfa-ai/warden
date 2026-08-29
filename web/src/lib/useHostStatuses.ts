// Shared /api/hosts/status read for host-list connectivity dots (WARDEN-113,
// WARDEN-198) and the Fleet Health Dashboard's per-host view (WARDEN-237).
//
// WARDEN-1213 (roadmap WARDEN-1203 "one owner per fact"): the fact is owned by
// TanStack Query under ONE cache key (`['host-statuses']`), replacing the
// hand-rolled module singleton (cache / inFlight / ref-counted interval /
// visibilitychange listener) with the library's own equivalents. Every consumer
// mounts the same query, so they share one in-flight request and one poll, and
// the poll stops shortly after the last consumer unmounts (gcTime at the poll
// cadence). The behaviours the singleton accumulated are preserved verbatim:
//
//   - 30s fixed cadence, 5s freshness window (staleTime) — WARDEN-609 option (a);
//   - a backgrounded tab never burns SSH: `refetchIntervalInBackground: false`
//     pauses the interval while hidden, and refetchOnWindowFocus refreshes
//     immediately on focus regain (WARDEN-609/325);
//   - last-known-value-on-error: TanStack does not clear `data` when a refetch
//     fails (retry: false), so a transient blip keeps the previous map instead
//     of wiping connectivity to "unknown" — blank-free host dots;
//   - WARDEN-915 checking-retry: when the settled data still carries a `checking`
//     host, the refetchInterval callback shortens to ONE ~1.2s follow-up poll;
//     the decision (and its termination argument) stays in
//     `shouldScheduleCheckingRetry` (unit-tested in web/healthUtils.test.mjs).

import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { HostConnectivity, HostConnectivityStatus } from '@/lib/healthUtils';
import { normalizeCompanionStatus, shouldScheduleCheckingRetry } from '@/lib/healthUtils';

const POLL_MS = 30_000; // fixed host-dot cadence (see WARDEN-609: option (a))
const FRESH_MS = 5_000; // a response younger than this is reused as-is
// WARDEN-915: /api/hosts/status is served from a background-refreshed cache and
// never blocks on live SSH, so a host it has not probed yet comes back as
// `checking`. Rather than wait a full 30s cadence for its dot to fill in, a
// response containing any `checking` host earns one short follow-up.
const CHECKING_RETRY_MS = 1_200;

/** The ONE cache key for the /api/hosts/status fact (TanStack Query). */
export const HOST_STATUSES_KEY = 'host-statuses' as const;

/** What one /api/hosts/status response normalizes into. */
export interface HostStatusesData {
  /** host -> connectivity, exactly what consumers render. */
  statuses: Record<string, HostConnectivity>;
  /** The coerced raw host rows, kept so the checking-retry predicate (which
   * reads the raw `checking` flag dropped during normalization) can run. */
  hosts: unknown[];
}

function normalizeStatus(raw: string | undefined): HostConnectivityStatus {
  return raw === 'online' ? 'online' : raw === 'offline' ? 'offline' : 'unknown';
}

/** Fetch + normalize one /api/hosts/status response (the old singleton's body). */
export async function fetchHostStatuses(): Promise<HostStatusesData> {
  const res = await fetch('/api/hosts/status');
  if (!res.ok) throw new Error(`hosts/status ${res.status}`);
  const data = await res.json();
  const hosts = Array.isArray(data?.hosts) ? data.hosts : [];
  const statuses: Record<string, HostConnectivity> = {};
  for (const h of hosts as Array<{ host: string; status?: string; latency_ms?: number | null; companion?: unknown }>) {
    if (!h || typeof h.host !== 'string') continue;
    // WARDEN-878: carry the per-host companion field through when the server
    // emitted it (present only while the transport is enabled). Absent → the
    // field stays undefined and the UI renders no companion indicator.
    statuses[h.host] = {
      status: normalizeStatus(h.status),
      latency_ms: h.latency_ms ?? null,
      ...(h.companion !== undefined ? { companion: normalizeCompanionStatus(h.companion) } : {}),
    };
  }
  return { statuses, hosts };
}

// The provider's client, captured on first hook use so the non-hook
// `refreshHostStatuses()` export (kept for signature compatibility) can reach
// the same cache. HealthDashboard only calls it from an event handler while a
// consumer of the query is mounted, so the capture is always set by then.
let sharedClient: QueryClient | null = null;

/** Options for the shared host-statuses query (see the module header). */
export const HOST_STATUSES_QUERY_OPTIONS = {
  staleTime: FRESH_MS,
  gcTime: POLL_MS, // stop polling shortly after the last consumer unmounts
  retry: false, // a failed poll is a state (keep last known), not a storm to retry
  refetchIntervalInBackground: false, // hidden tab never burns SSH (WARDEN-609)
  refetchOnWindowFocus: true, // refresh immediately on focus regain (WARDEN-609/325)
  // WARDEN-915: while the settled data still carries a `checking` host, poll on
  // the short follow-up cadence; otherwise the fixed 30s host-dot cadence. The
  // interval only runs for an active query, so `subscribers > 0` is inherent and
  // at most ONE follow-up is scheduled per settle (the interval is re-evaluated
  // per tick, never stacked).
  refetchInterval: (query: { state: { data?: HostStatusesData } }) =>
    shouldScheduleCheckingRetry(query.state.data?.hosts, { subscribers: 1, retryPending: false })
      ? CHECKING_RETRY_MS
      : POLL_MS,
} as const;

/**
 * Force an immediate out-of-band refresh of the shared /api/hosts/status poll.
 * Use after an action that changes per-host state the poll carries but that the
 * caller wants reflected before the next 30s tick — e.g. WARDEN-882's companion
 * removal, where the backend clears the host's companionStatus and the row's
 * CompanionIndicator should flip to "inactive" at once rather than lagging up
 * to 30s. Goes through the shared cache entry, so a refresh already underway is
 * deduped by TanStack rather than doubled.
 */
export function refreshHostStatuses(): Promise<void> {
  if (!sharedClient) return Promise.resolve();
  return sharedClient.refetchQueries({ queryKey: [HOST_STATUSES_KEY] }).then(() => undefined);
}

/**
 * Subscribe to the shared /api/hosts/status poll. Returns the latest per-host
 * connectivity map (host -> { status, latency_ms }). Every consumer mounts the
 * same TanStack Query key, so they share a single in-flight request and one
 * 30s interval; the query goes inactive (and stops polling) once the last
 * consumer unmounts. On a failed refetch the previous map is kept (TanStack
 * does not clear `data` on error), so connectivity dots never blank out.
 */
export function useHostStatuses(): Record<string, HostConnectivity> {
  const queryClient = useQueryClient();
  sharedClient = queryClient;
  const { data } = useQuery({
    queryKey: [HOST_STATUSES_KEY],
    queryFn: fetchHostStatuses,
    ...HOST_STATUSES_QUERY_OPTIONS,
  });
  return data?.statuses ?? {};
}
