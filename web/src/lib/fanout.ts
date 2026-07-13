// Generic pure helper for a Promise.allSettled fan-out over a per-agent API
// (WARDEN-328). The broadcast-send reducer (WARDEN-292) and the batch-kill
// reducer share the EXACT same accounting — a result counts as a success only
// when its promise fulfilled AND carried `{ok:true}`; anything else (a rejected
// promise, or a fulfilled `{ok:false}` carrying an error) is a per-agent
// failure — so the logic lives once here instead of being duplicated.
//
// Operation-specific concerns stay with the caller: the result-toast COPY
// (formatBroadcastToast / formatKillToast) and the fallback string for a
// fulfilled-{ok:false}-with-no-error ("send failed" vs "kill failed") are passed
// in, because those are the only places broadcast and kill legitimately differ.
//
// `import type` only below — erased by OXC, so this module loads under the same
// transpile-to-temp-`.mjs` + dynamic-`import()` harness as broadcast.ts (see
// broadcast.test.mjs / kill.test.mjs).

/** Outcome of one agent's API call: either ok, or not-ok with a reason. */
export interface FanoutOutcome { ok: boolean; error?: string }

/** One agent for which the fan-out operation did NOT succeed. */
export interface FanoutFailure { id: string; name: string; error: string }

/** Per-agent result of a fan-out. `succeeded` is the count that came back {ok:true}. */
export interface FanoutSummary {
  total: number;
  succeeded: number;
  failed: FanoutFailure[];
}

/**
 * Reduce `Promise.allSettled` outcomes into a per-agent fan-out summary.
 *
 * A result counts as SUCCEEDED only when the promise fulfilled AND carried
 * `{ok:true}`. Anything else is a failure: a rejected promise (network error /
 * throw) reads `reason.message` (or stringifies a non-Error reason); a fulfilled
 * `{ok:false}` reads its `error` string, falling back to `defaultError` when the
 * backend gave no reason.
 *
 * `ids` is passed in parallel because Promise.allSettled preserves array order —
 * `results[i]` is the outcome for `ids[i]` — so each failure is attributed to
 * its agent's display name via `nameOf` (which may return undefined for a
 * dead/unknown id; `?? id` then keeps the raw id so the target is still
 * identifiable). Partial failure does NOT abort the other calls (the allSettled
 * contract, not Promise.all); this reducer merely reports what happened per
 * agent.
 */
export function summarizeFanout(
  results: PromiseSettledResult<FanoutOutcome>[],
  ids: string[],
  nameOf: (id: string) => string | undefined,
  defaultError = 'operation failed',
): FanoutSummary {
  const failed: FanoutFailure[] = [];
  let succeeded = 0;
  results.forEach((res, i) => {
    const id = ids[i];
    if (res.status === 'fulfilled' && res.value?.ok) {
      succeeded += 1;
    } else {
      const error =
        res.status === 'rejected'
          ? (res.reason instanceof Error ? res.reason.message : String(res.reason ?? 'unknown error'))
          : (res.value?.error || defaultError);
      failed.push({ id, name: nameOf(id) ?? id, error });
    }
  });
  return { total: results.length, succeeded, failed };
}
