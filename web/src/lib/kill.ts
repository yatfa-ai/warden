// Pure helpers for the multi-select batch-kill feature (WARDEN-328).
//
// The fan-out itself (Promise.allSettled over /api/kill per selected agent) lives
// in the ChatSidebar component because it touches fetch + toast + selection
// state. These helpers are the TESTABLE pure seam: reducing the allSettled
// outcomes into a per-agent summary, and shaping the result-toast line. The
// accounting is shared with broadcast-send via summarizeFanout (the
// allSettled→summary reducer); only the kill-specific copy + the "kill failed"
// fallback live here.
//
// `import type` only below — erased by OXC, so this module loads under the same
// transpile-to-temp-`.mjs` + dynamic-`import()` harness as broadcast.ts (see
// kill.test.mjs).

import { summarizeFanout } from './fanout';

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

/** Toast variant for a kill summary — success only when every agent was stopped. */
export type KillToastVariant = 'success' | 'error';

export interface KillToast {
  title: string;
  description?: string;
  variant: KillToastVariant;
}

/**
 * Shape the result toast for a kill summary.
 *
 * - All stopped → a one-line success: "Stopped N agents".
 * - Some/total failure → an error whose title carries the N/M tally and whose
 *   description lists each agent that wasn't stopped with its reason (so the
 *   human can see WHICH sessions are still running and why — host unreachable,
 *   session already dead, etc.). The description is the full failure list (not
 *   truncated): the sidebar's own selection caps it at a human-scale N, and
 *   sonner wraps a long description in a scrollable toast body. Rendered with
 *   `whitespace-pre-line` by the caller so each failure lands on its own line.
 */
export function formatKillToast(s: KillSummary): KillToast {
  if (s.failed.length === 0) {
    return { title: `Stopped ${s.stopped} agent${s.stopped === 1 ? '' : 's'}`, variant: 'success' };
  }
  const list = s.failed.map((f) => `${f.name}: ${f.error}`).join('\n');
  if (s.stopped === 0) {
    return {
      title: `Failed to stop ${s.failed.length} of ${s.total} agent${s.total === 1 ? '' : 's'}`,
      description: list,
      variant: 'error',
    };
  }
  return {
    title: `Stopped ${s.stopped} of ${s.total} agents — ${s.failed.length} failed`,
    description: list,
    variant: 'error',
  };
}
