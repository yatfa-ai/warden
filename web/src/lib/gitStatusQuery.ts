// gitStatusQuery — THE single owner of the per-agent /api/git-status fact
// (WARDEN-1211, roadmap WARDEN-1203 "one owner per fact", first CLIENT slice).
//
// Before this module, TWO independent client readers fetched the SAME
// `/api/git-status?id=<key||id>` fact for the SAME agent on different beats:
//   - ChatSidebar (the focused pane's git section) — refetched on every catalog
//     refresh (~60s cadence);
//   - useFleetGitStatus (Fleet Health's per-agent chips) — fetch-on-mount +
//     membership change + manual ↻ only (no auto-poll, by design).
// Same route, same key space (both key agents by `key || id`), no shared cache —
// so the two surfaces could disagree about one agent indefinitely. This module
// closes that: ONE TanStack Query cache key per agent (`['git-status', key]`)
// with ONE fetcher, and both readers become reads of the shared cache.
//
// PURITY CONTRACT (finding B of the ticket): this file has NO React and NO
// `@tanstack/react-query` import — the fetcher + the slice coercion + the URL /
// key derivation are plain functions with an injectable `fetcher`, so
// `node --test` drives them exactly the way gitStateSummary's pure seam is
// driven (transformWithOxc, no React test stack). The React/query glue lives in
// `gitStatusHooks.ts`; that separation is what keeps the WARDEN-89 gate and the
// slice coercions unit-testable in this repo's pure-layer convention.
//
// Acceptance gates (finding A — the two readers used DIFFERENT gates; the shared
// owner must not flatten either):
//   - The SHARED FETCHER applies the STRICT WARDEN-89 gate — `r.ok && !j.error`.
//     /api/git-status returns transport/no-cwd errors as HTTP-200 with an
//     `error` body (gitRoutes.js's withGitRepo wrapper), so an error-body
//     response is an ERROR (a thrown promise → the query's error state), never
//     a false clean/empty status. This is the gate Fleet Health already had.
//   - The SIDEBAR's branch-less → "no repo" rendering decision stays
//     CONSUMER-SIDE: a successfully-fetched payload with no `branch` renders the
//     section empty in the sidebar (see gitStatusHooks), it does NOT become an
//     error. The strict gate and the lenient render are different questions —
//     one about transport honesty, one about what a valid empty payload means.

import { buildFleetGitStatusUrl, type FleetGitStatusSlice } from '@/lib/gitStateSummary';

/** The ONE cache-key prefix for the per-agent git-status fact (TanStack Query). */
export const GIT_STATUS_KEY = 'git-status' as const;

/**
 * The query key for ONE agent's git-status fact: `['git-status', key]`.
 * The sidebar's `focused` and the fleet fan's eligible keys are the same
 * `key || id` space (App.tsx's focused lookup and fleetCommitSearchEligible
 * both emit it), so one key space covers both readers — this identity is the
 * whole point of the ticket.
 */
export function gitStatusQueryKey(key: string): readonly [typeof GIT_STATUS_KEY, string] {
  return [GIT_STATUS_KEY, key] as const;
}

/**
 * The ONE fetcher for the per-agent git-status fact. Fetches
 * `/api/git-status?id=<key>` (via the existing pure URL builder from
 * gitStateSummary — the sidebar's URL was byte-identical to the fleet's)
 * and applies the STRICT WARDEN-89 gate: a non-ok HTTP status OR an ok-with-
 * `error` body THROWS, so an unreachable / non-git agent lands in the query's
 * error state and is counted as that agent's error — never read as a false
 * clean/empty status. On success returns the FULL parsed body (the sidebar
 * reads branch/files/diffstat/... straight off it; the fleet fan coerces it to
 * a FleetGitStatusSlice via toFleetSlice).
 *
 * `fetcher` is injectable so node --test can drive the gate without a network.
 */
export async function fetchGitStatusPayload(
  key: string,
  fetcher: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const r = await fetcher(buildFleetGitStatusUrl(key));
  // WARDEN-89 false-empty guard: fetch() resolves (does NOT reject) on 4xx/5xx,
  // AND /api/git-status returns transport/no-cwd errors as HTTP-200 with an
  // `error` body. Gate on BOTH so the failure is an error, never a clean read.
  if (!r.ok) throw new Error(`git-status HTTP ${r.status}`);
  const j = (await r.json()) as Record<string, unknown>;
  if (j.error) throw new Error(`git-status error: ${String(j.error)}`);
  return j;
}

/**
 * Coerce a successfully-fetched /api/git-status body into the Fleet Health
 * slice (the per-agent chip fields). Lifted VERBATIM from useFleetGitStatus's
 * inline coercion so the fleet's semantics are unchanged and now testable:
 * every `typeof` coerce keeps null as null (typeof null === 'object') so a
 * non-git / no-branch / no-upstream cwd reads null — the null-is-quiet
 * discipline. headAgeMs/stalled stay provisional; buildFleetGitStatus(now)
 * enriches them (unchanged — see gitStateSummary).
 */
export function toFleetSlice(j: Record<string, unknown>): FleetGitStatusSlice {
  return {
    clean: typeof j.clean === 'boolean' ? j.clean : null,
    diffstat: (j.diffstat as FleetGitStatusSlice['diffstat']) ?? null,
    ahead: typeof j.ahead === 'number' ? j.ahead : null,
    conflictCount: (Array.isArray(j.files) ? j.files : []).filter(
      (f: { conflict?: boolean } | null) => f?.conflict === true,
    ).length,
    behind: typeof j.behind === 'number' ? j.behind : null,
    stashCount: typeof j.stashCount === 'number' ? j.stashCount : null,
    headDate: typeof j.headDate === 'string' ? j.headDate : null,
    headAgeMs: null,  // provisional — enriched by buildFleetGitStatus(now)
    stalled: false,   // provisional — enriched by buildFleetGitStatus(now)
  };
}
