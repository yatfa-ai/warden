// Pure + shared impure helpers for the multi-select batch-kill feature
// (WARDEN-328, reused by Fleet Health WARDEN-371).
//
// The PURE seam (summarizeKill → summarizeFanout, formatKillToast) is the
// testable part: reducing the allSettled outcomes into a per-agent summary and
// shaping the result-toast line. The accounting is shared with broadcast-send
// via summarizeFanout (the allSettled→summary reducer); only the kill-specific
// copy + the "kill failed" fallback live here.
//
// The IMPURE seam (runKillFanout) is the shared fan-out itself: one POST to
// /api/kill per selected agent, via the shared runFanout request loop
// (./fanout, WARDEN-974). It used to live inline in ChatSidebar; it now
// lives here so every multi-select kill surface (sidebar, Fleet Health) shares ONE
// copy of the fiddly fetch-and-reduce shape. Each surface passes its own
// `onSettled` reconciliation (the two surfaces reconcile differently) and keeps
// its view concerns (toast, selection clear) in the component.
//
// `import type` only below (besides runFanout + summarizeFanout) — erased by
// OXC, so this module loads under the same transpile-to-temp-`.mjs` +
// dynamic-`import()` harness as broadcast.ts (see kill.test.mjs).

import { formatFanoutToast, runFanout, summarizeFanout, type FanoutToast, type FanoutToastVariant } from './fanout';

/** Outcome of one agent's /api/kill: either ok, or not-ok with a reason. */
export interface KillOutcome { ok: boolean; error?: string }

/** One agent that was NOT stopped. */
export interface KillFailure { id: string; name: string; error: string }

/** Per-agent result of a kill fan-out. `stopped` is the count that came back {ok:true}. */
export interface KillSummary {
  total: number;
  stopped: number;
  failed: KillFailure[];
}

/**
 * Reduce `Promise.allSettled` outcomes into a per-agent kill summary. Delegates
 * the shared allSettled accounting to summarizeFanout (success = fulfilled
 * `{ok:true}`; failure = rejected or fulfilled `{ok:false}`), mapping `succeeded`
 * → `stopped` and defaulting a reason-less failure to "kill failed". See
 * summarizeFanout for the partial-failure-doesn't-abort-siblings contract.
 */
export function summarizeKill(
  results: PromiseSettledResult<KillOutcome>[],
  ids: string[],
  nameOf: (id: string) => string,
): KillSummary {
  const { total, succeeded, failed } = summarizeFanout(results, ids, nameOf, 'kill failed');
  return { total, stopped: succeeded, failed };
}

/**
 * Toast variant / shape for a kill summary. Both alias the shared fan-out types
 * (./fanout) — the three formatters emit structurally identical toasts, and one
 * renderer (showFanoutToast) consumes all three. The names are kept as exported
 * aliases so existing importers are unaffected.
 */
export type KillToastVariant = FanoutToastVariant;

export type KillToast = FanoutToast;

/**
 * Shape the result toast for a kill summary.
 *
 * - All stopped → a one-line success: "Stopped N agents".
 * - Some/total failure → an error whose title carries the N/M tally and whose
 *   description lists each agent that wasn't stopped with its reason (so the
 *   human can see WHICH sessions are still running and why — host unreachable,
 *   session already dead, etc.).
 *
 * The three-branch shape itself is the shared formatFanoutToast (./fanout,
 * WARDEN-1034); only the kill COPY lives here. "Failed to stop" is passed as its
 * own opaque phrase rather than derived from "Stopped" — see FanoutToastPhrases.
 * `stopped` is mapped onto the shared `succeeded` field; the public KillSummary
 * shape is unchanged.
 */
export function formatKillToast(s: KillSummary): KillToast {
  return formatFanoutToast(
    { total: s.total, succeeded: s.stopped, failed: s.failed },
    { success: 'Stopped', failure: 'Failed to stop' },
  );
}

/**
 * Fan a KILL out to every selected agent via the existing per-target /api/kill
 * path (server.js → killTmux + catalog forget), then reduce the outcomes into a
 * per-agent summary. Shared by every multi-select kill surface (sidebar
 * WARDEN-328, Fleet Health WARDEN-371) so the fetch-and-reduce shape lives once.
 *
 * This is the batch analogue of App.tsx's per-row performKill — but deliberately
 * its OWN fan-out (NOT N calls to a per-row path): the per-row path drives a
 * single confirm slot and an optimistic-per-id UI built for one id, so batching
 * it races the slot and clobbers the wrong dialog.
 *
 * Promise.allSettled (not Promise.all) so a partial failure — one host
 * unreachable, one session already dead — is reported per-agent and does NOT
 * abort the other kills. Never throws: failure is encoded in the summary.
 *
 * `onSettled` is the surface-specific reconciliation, run AFTER every kill has
 * settled so the killing surface reflects the dead sessions immediately (re-read
 * the catalog + re-discover each distinct host). It's a callback because the two
 * surfaces reconcile differently: the sidebar calls App-level refresh +
 * discoverHost; Fleet Health does its own fetchHealth + a direct /api/discover
 * per host. The result toast + selection clear stay with the caller.
 *
 * Stale ids (an agent that died between selecting and killing) are still sent to
 * and reported as a per-agent failure rather than silently dropped.
 */
export async function runKillFanout(
  ids: string[],
  nameOf: (id: string) => string,
  onSettled?: () => void | Promise<void>,
): Promise<KillSummary> {
  const results = await runFanout('/api/kill', ids, (id) => ({ id }));
  const summary = summarizeKill(results, ids, nameOf);
  if (onSettled) await onSettled();
  return summary;
}
