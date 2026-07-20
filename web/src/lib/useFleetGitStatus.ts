// useFleetGitStatus — the lifted hook behind Fleet Health's missing repository-state
// axis (WARDEN-766). Fans /api/git-status across every active project agent (the SAME
// eligible fleet FleetRecentCommits / FleetCommitSearch fan over) and returns a
// per-agent { clean, diffstat } map + a fleet-wide dirty count + an honest error
// count — so HealthDashboard can surface, per agent, whether it has uncommitted WIP
// and its magnitude (±N via DiffStatChip), plus a "N dirty" count in the summary bar,
// WITHOUT leaving the fleet view for the sidebar's per-pane gitStatus.
//
// Mirrors useHostStatuses / useActivitySeries: a "fleet-wide fan-out lifted into a
// hook consumed by HealthDashboard" — the established pattern for cross-fleet data the
// dashboard needs in more than one place (here: a per-row chip inside renderAgent's
// scope AND a fleet summary count). A sibling self-contained panel like
// FleetRecentCommits can't reach into each row, so the fetch must live here at the
// HealthDashboard level (or a hook it calls); this hook delivers both the per-row map
// and the summary count for the same one fan-out cost.
//
// Refresh discipline (mirrors FleetRecentCommits.tsx VERBATIM — WARDEN-766's stated
// approach): fetch-on-mount + a MANUAL refresh() (bumps refreshTick). NO setInterval,
// NO auto-poll — this slice's N-fetch fan-out is paid on demand, never on a steady
// cadence (WARDEN-668's Page-Visibility Poller Gate cost discipline: don't burn
// SSH/docker-exec in a backgrounded tab). Achieved via an `eligibleKey` membership
// signature in the effect deps, NOT via a non-existent `useVisiblePoller` (the
// proposal's `useVisiblePoller` does not exist — visibility-gating is inline per-hook,
// and FleetRecentCommits achieves no-auto-poll without any visibility gate at all).
//
// The effect keys on `eligibleKey` (a primitive membership signature) + `refreshTick`
// — NOT on the `agents` array, whose reference churns every ~10s with healthData
// (HealthDashboard polls /api/health on a 10s setInterval and setHealthData()s a fresh
// res.json() each tick). Depending on the churned array would refire N /api/git-status
// fetches every 10s — the exact silent auto-poll this slice forbids. The freshest
// fleet is read from a useRef at fire time.
//
// The pure aggregation (buildFleetGitStatus + buildFleetGitStatusUrl + the shared
// fleetCommitSearchEligible gate) lives in @/lib/gitStateSummary (unit-tested without
// React, mirroring mergeFleetCommitsByEpoch / buildFleetRecentCommitsUrl); this file
// owns only the fan-out + the WARDEN-89 false-empty guard.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Chat } from '@/lib/types';
import {
  fleetCommitSearchEligible,
  buildFleetGitStatus,
  buildFleetGitStatusUrl,
  type FleetGitStatusResult,
  type FleetGitStatusSlice,
} from '@/lib/gitStateSummary';

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
  /** Pull a fresh view past mount (no auto-poll). */
  refresh: () => void;
  /** True only during a fetch whose result has not yet arrived (mount or manual ↻). */
  loading: boolean;
}

const EMPTY_RESULT: FleetGitStatusResult = { statusByKey: {}, dirtyCount: 0, errorCount: 0, conflictCount: 0, behindCount: 0, aheadCount: 0 };

/**
 * Fan /api/git-status across the eligible fleet and lift the result for
 * HealthDashboard. Pass `healthData?.agents ?? []` from HealthDashboard so the hook
 * no-ops cleanly before the first /api/health response lands (an empty eligible fleet
 * resolves immediately to an empty result rather than spinning loading forever).
 */
export function useFleetGitStatus(agents: readonly Chat[]): FleetGitStatusState {
  // The eligible fleet: active project agents, keyed & deduped by key || id, in
  // catalog order. Memoized on `agents` — a CHEAP filter, fine to recompute. This
  // GATES on `project` (reused from FleetRecentCommits / FleetCommitSearch for
  // consistency with the sibling fleet fans): an agent with a cwd but no `project`
  // is NOT fanned. Acceptable for v1 — matches those siblings, and the WARDEN-89
  // errorCount discipline below already surfaces any no-cwd miss honestly.
  const eligible = useMemo(() => fleetCommitSearchEligible(agents), [agents]);
  // A primitive SIGNATURE of the eligible fleet (the joined agent keys). A string is
  // value-compared in the effect's deps, so it is identical across the 10s healthData
  // array churn and changes ONLY when the actual member SET changes (a key
  // added/removed/replaced). `fleetCommitSearchEligible` already dedupes by key, so
  // the key list IS the fleet identity — this is what the fetch effect depends on,
  // NOT the churned array reference. Mirrors FleetRecentCommits' eligibleKey verbatim.
  const eligibleKey = eligible.map((a) => a.key).join('\n');
  // Hand the effect the FRESHEST eligible fleet without putting that churned array
  // reference in the deps: the effect dereferences this ref at fire time. (Reading
  // `eligible` straight from the effect closure would also work — same membership
  // between signature-unchanged renders — but the ref is unambiguously current and
  // survives any future re-render mid-fan-out.) Mirrors FleetRecentCommits' eligibleRef.
  const eligibleRef = useRef(eligible);
  eligibleRef.current = eligible;

  const [result, setResult] = useState<FleetGitStatusResult>(EMPTY_RESULT);
  const [loading, setLoading] = useState(false);
  // Bumped by the manual refresh() to force a refetch (fetch-on-mount otherwise).
  const [refreshTick, setRefreshTick] = useState(0);

  const refresh = useCallback(() => setRefreshTick((t) => t + 1), []);

  // Fetch-on-mount + manual refresh. NO auto-poll: this view's N-fetch fan-out is
  // paid on demand, never on a steady cadence. The effect keys on `eligibleKey` (a
  // primitive signature of fleet membership) + `refreshTick` (the manual ↻) — NOT on
  // the `eligible` array, whose reference churns every ~10s with healthData. So it
  // fires ONLY on mount, on a real membership change (a key added/removed), or on a
  // manual refresh — never on the 10s health tick. The freshest eligible fleet is
  // read from `eligibleRef` at fire time so the fan-out always iterates the current
  // fleet. Mirrors FleetRecentCommits.tsx's fetch effect discipline verbatim.
  useEffect(() => {
    const cur = eligibleRef.current;
    // No eligible agents → resolve immediately to an empty result rather than spinning
    // the loading state forever (e.g. a fleet with no active project chats, or before
    // the first /api/health response lands an empty agents list).
    if (cur.length === 0) {
      setResult(EMPTY_RESULT);
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    (async () => {
      // Promise.allSettled (the fleet convention — ChatSidebar's handleBroadcast /
      // handleKillSelected + FleetRecentCommits / FleetCommitSearch): one unreachable
      // / non-git agent never rejects the whole; a per-agent failure is counted and
      // surfaced as an honest "· N unreachable" note (WARDEN-89 — never let a failure
      // masquerade as a clean/empty status). One fetch per agent (N, not 2N —
      // /api/git-status is a single-shot probe with no outgoing join).
      const settled = await Promise.allSettled(
        cur.map(async ({ key }) => {
          const r = await fetch(buildFleetGitStatusUrl(key));
          // WARDEN-89 false-empty guard: fetch() resolves (does NOT reject) on a
          // 4xx/5xx, AND /api/git-status returns transport/no-cwd errors as HTTP-200
          // with an `error` body (gitRoutes.js's withGitRepo wrapper spreads
          // `{ ...defaults, error }`). Gate on BOTH `r.ok` AND `!j.error` so an
          // unreachable / non-git agent is counted as that agent's error, NEVER read
          // as a false clean/empty status. Throwing here routes the agent to its
          // ok:false outcome via the allSettled rejection below.
          if (!r.ok) throw new Error(`git-status HTTP ${r.status}`);
          const j = await r.json();
          if (j.error) throw new Error(`git-status error: ${j.error}`);
          // Carry the slice the UI reads. clean is boolean | null (null for a non-git
          // / no-branch cwd — the server gates `clean: branch ? clean : null`); the
          // `typeof === 'boolean'` coerce keeps null as null (typeof null === 'object'),
          // so an unknown-state agent is neither dirty nor clean. diffstat is
          // { files, insertions, deletions } | null (null for clean / non-git /
          // all-untracked); `?? null` coerces an absent field to null. ahead (WARDEN-822)
          // is the # of unpushed commits, a top-level number the server ALREADY serves
          // (`ahead: branch ? ahead : null`, parsed from one `git rev-list --left-right
          // --count @{u}...HEAD` — RIGHT count = HEAD has, upstream doesn't = unpushed);
          // the `typeof === 'number'` coerce keeps null as null (null for a non-git /
          // detached / no-upstream cwd, 0 for in-sync) — the SAME null-is-quiet discipline
          // clean follows. This is the PER-AGENT commit count (drives the per-row ↑N's
          // magnitude); the fleet-wide count of stranded AGENTS is derived in
          // buildFleetGitStatus from `ahead > 0`. conflictCount
          // (WARDEN-796) is the # of unmerged PATHS, derived from the SAME response's
          // porcelain `files[]` (each row already tagged `conflict: boolean` by
          // gitStatus.js's parseGitStatusPorcelain) — the data ALREADY flows on this
          // fetch; this stops discarding it. `j.files` is null for a clean / non-git
          // cwd (the server default, gitRoutes.js:517), so the Array.isArray guard
          // keeps the count 0 there. This is the PER-AGENT path count (drives the
          // per-row ⚑'s "N unmerged"); the fleet-wide count of blocked AGENTS is
          // derived in buildFleetGitStatus from `conflictCount > 0`.
          const status: FleetGitStatusSlice = {
            clean: typeof j.clean === 'boolean' ? j.clean : null,
            diffstat: j.diffstat ?? null,
            ahead: typeof j.ahead === 'number' ? j.ahead : null,
            conflictCount: (Array.isArray(j.files) ? j.files : []).filter(
              // Each porcelain row is tagged `conflict: boolean` by gitStatus.js
              // (isConflictStatus on the unmerged DD/AU/UD/UA/DU/AA/UU codes). `=== true`
              // (not truthy) defends against a malformed body; a present-but-falsy field
              // is not a conflict.
              (f: { conflict?: boolean } | null) => f?.conflict === true,
            ).length,
            // behind (WARDEN-815): the # of commits this agent's HEAD is behind its
            // upstream — the staleness axis. A direct pass-through of /api/git-status's
            // top-level `behind` (parseAheadBehind → gitRoutes.js:646), NOT derived like
            // conflictCount. The `typeof === 'number'` coerce keeps null as null (typeof
            // null === 'object') so a non-git / no-branch / no-upstream cwd reads null
            // — the same null-is-quiet discipline `clean` follows. The fleet-wide count
            // of stale AGENTS is derived in buildFleetGitStatus from `behind > 0`.
            behind: typeof j.behind === 'number' ? j.behind : null,
          };
          return { ok: true as const, key, status };
        }),
      );
      if (cancelled) return;
      // Unwrap allSettled → outcomes in input (catalog) order; a rejected promise (a
      // thrown !r.ok / j.error, or a bad-JSON throw) becomes that agent's error
      // outcome, keyed from the same `cur` entry so it still carries its key.
      const outcomes = settled.map((s, i) =>
        s.status === 'fulfilled' ? s.value : { ok: false as const, key: cur[i].key },
      );
      // WARDEN-89: never swallow a per-agent failure silently — log with context so a
      // network failure, a non-ok HTTP, or an HTTP-200 `error` body leaves a trace
      // instead of a silent "clean." Mirrors FleetRecentCommits.tsx's warn loop.
      for (const s of settled) {
        if (s.status === 'rejected') console.warn('[fleet git-status] agent fetch failed:', s.reason);
      }
      setResult(buildFleetGitStatus(outcomes));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `eligibleKey` is the
    // primitive membership signature (value-stable across the 10s healthData array
    // churn); the fan-out reads the freshest fleet from `eligibleRef`, so `eligible`
    // is intentionally NOT in deps — depending on the array would refire every 10s.
  }, [eligibleKey, refreshTick]);

  return { ...result, refresh, loading };
}
