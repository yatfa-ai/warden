// Pure + shared impure helpers for the multi-select batch-kill feature
// (WARDEN-328, reused by Fleet Health WARDEN-371).
//
// The PURE seam (summarizeKill → summarizeFanout, formatKillToast) is the
// testable part: reducing the allSettled outcomes into a per-agent summary and
// shaping the result-toast line. The accounting is shared with broadcast-send
// via summarizeFanout (the allSettled→summary reducer); only the kill-specific
// copy + the "kill failed" fallback live here.
//
// The IMPURE seam (runKillFanout) is the shared fan-out itself: Promise.allSettled
// over /api/kill per selected agent. It used to live inline in ChatSidebar; it now
// lives here so every multi-select kill surface (sidebar, Fleet Health) shares ONE
// copy of the fiddly fetch-and-reduce shape. Each surface passes its own
// `onSettled` reconciliation (the two surfaces reconcile differently) and keeps
// its view concerns (toast, selection clear) in the component.
//
// `import type` only below (besides summarizeFanout) — erased by OXC, so this
// module loads under the same transpile-to-temp-`.mjs` + dynamic-`import()`
// harness as broadcast.ts (see kill.test.mjs).

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
  const results = await Promise.allSettled(
    ids.map((id) =>
      fetch('/api/kill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      }).then(async (r) =>
        r.ok
          ? { ok: true }
          : { ok: false, error: (await r.json().catch(() => ({}))).error || `HTTP ${r.status}` },
      ),
    ),
  );
  const summary = summarizeKill(results, ids, nameOf);
  if (onSettled) await onSettled();
  return summary;
}
