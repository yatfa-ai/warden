// Generic helpers for a Promise.allSettled fan-out over a per-agent API
// (WARDEN-328). The broadcast-send reducer (WARDEN-292) and the batch-kill
// reducer share the EXACT same accounting — a result counts as a success only
// when its promise fulfilled AND carried `{ok:true}`; anything else (a rejected
// promise, or a fulfilled `{ok:false}` carrying an error) is a per-agent
// failure — so the logic lives once here instead of being duplicated.
//
// Both halves of the fan-out live here: the PURE reducer (summarizeFanout) and
// its IMPURE sibling (runFanout, the request loop that produces the results it
// reduces). This module was originally described as "pure", and that word is why
// the request half never landed here — each new fleet action (Send WARDEN-292,
// Kill WARDEN-328, Interrupt WARDEN-492) re-typed the identical
// allSettled-over-fetch block instead (WARDEN-974).
//
// Operation-specific concerns stay with the caller: the result-toast COPY
// (formatBroadcastToast / formatKillToast) and the fallback string for a
// fulfilled-{ok:false}-with-no-error ("send failed" vs "kill failed") are passed
// in, because those are the only places broadcast and kill legitimately differ.
//
// NO runtime imports below — only erased `import type`s plus the global `fetch`.
// Three test harnesses transpile this file standalone via OXC into a temp dir and
// import it directly with NO dependency-specifier rewrite (fanout.test.mjs,
// kill.test.mjs, keysend.test.mjs), so adding a runtime import here (e.g.
// `postJson` from ./api) would break all three. Keep it import-free.

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

/** Result-toast variant — success only when EVERY agent in the fan-out succeeded. */
export type FanoutToastVariant = 'success' | 'error';

/**
 * The shape every fan-out result formatter returns (formatKillToast /
 * formatBroadcastToast / formatKeySendToast). The three used to declare three
 * structurally identical interfaces; they now alias this one so the single
 * renderer (showFanoutToast in ./fanoutToast) has one type to accept.
 *
 * `description`, when present, is the `\n`-joined per-agent failure list — it
 * MUST be rendered with `whitespace-pre-line` (showFanoutToast does this) or the
 * lines collapse into one run-on string.
 */
export interface FanoutToast {
  title: string;
  description?: string;
  variant: FanoutToastVariant;
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

/**
 * POST one request per agent and settle them all — the impure half of a fleet
 * fan-out, whose output feeds straight into summarizeFanout.
 *
 * Every fleet action (Send /api/send, Kill /api/kill, Interrupt /api/key) had
 * its own byte-identical copy of this loop; `url` and `payloadOf` were the ONLY
 * divergences, so they are the only parameters (WARDEN-974).
 *
 * `Promise.allSettled` (NOT Promise.all) is load-bearing: a partial failure —
 * one host unreachable, one session already dead — must be reported per agent
 * and must NOT abort the sibling requests. Order is preserved, so `results[i]`
 * is the outcome for `ids[i]`, which is the positional pairing summarizeFanout
 * relies on for per-agent attribution.
 *
 * A non-ok response reads its body's `error` string, falling back to
 * `HTTP {status}` when the body carries none (or isn't JSON at all — hence the
 * `.catch`). A network-level failure REJECTS rather than fulfilling, which is
 * deliberate: summarizeFanout reads a rejection via `reason.message` and a
 * fulfilled failure via `value.error`. Routing this through api.ts's `postJson`
 * would convert those rejections into fulfilled `{ok:false}`s and silently move
 * every network failure onto the other reducer branch, so the raw `fetch` stays.
 */
export function runFanout(
  url: string,
  ids: string[],
  payloadOf: (id: string) => unknown,
): Promise<PromiseSettledResult<FanoutOutcome>[]> {
  return Promise.allSettled(
    ids.map((id) =>
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadOf(id)),
      }).then(async (r): Promise<FanoutOutcome> =>
        r.ok
          ? { ok: true }
          : { ok: false, error: (await r.json().catch(() => ({}))).error || `HTTP ${r.status}` },
      ),
    ),
  );
}
