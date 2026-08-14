// Pure helpers for the multi-select broadcast-send feature (WARDEN-292).
//
// The request loop (one POST /api/send per selected agent) is the shared
// runFanout in ./fanout (WARDEN-974) — the same loop batch Kill and batch
// Interrupt use. ChatSidebar calls it and keeps only its view concerns (toast,
// selection clear); the loop is no longer re-typed in the component.
// These helpers are the TESTABLE pure seam: reducing the allSettled outcomes into
// a per-agent summary, and shaping the result toast line. Extracted so the fiddly
// sent/failed accounting and the failure-list copy have real tests instead of
// being asserted by hand.
//
// `import type` only below — erased by OXC, so this module loads under the
// transpile-to-temp-`.mjs` + dynamic-`import()` harness (see broadcast.test.mjs),
// matching chatDisplay.test.mjs / gitStateSummary.test.mjs.

import { summarizeFanout, type FanoutToast, type FanoutToastVariant } from './fanout';

/** Outcome of one agent's /api/send: either ok, or not-ok with a reason. */
export interface SendOutcome { ok: boolean; error?: string }

/** One agent that did NOT receive the broadcast. */
export interface BroadcastFailure { id: string; name: string; error: string }

/** Per-agent result of a broadcast fan-out. */
export interface BroadcastSummary {
  total: number;
  sent: number;
  failed: BroadcastFailure[];
}

/**
 * Reduce `Promise.allSettled` outcomes into a per-agent broadcast summary.
 *
 * A result counts as SENT only when the promise fulfilled AND carried `{ok:true}`
 * (the /api/send success shape from server.js:182-187). Anything else is a
 * failure: a rejected promise (network error / throw) or a fulfilled `{ok:false}`
 * carrying an `error` string (the 404-not-found / 500-sendPane-failed shapes).
 *
 * `ids` is passed in parallel because Promise.allSettled preserves array order —
 * `results[i]` is the outcome for `ids[i]` — so each failure is attributed to its
 * agent's display name via `nameOf`. Partial failure does NOT abort the other
 * sends (that's the allSettled contract, not Promise.all); this reducer merely
 * reports what happened per agent.
 */
export function summarizeBroadcast(
  results: PromiseSettledResult<SendOutcome>[],
  ids: string[],
  nameOf: (id: string) => string,
): BroadcastSummary {
  // The allSettled→summary accounting is shared with batch-kill via
  // summarizeFanout (WARDEN-328); only the field name (`succeeded` → `sent`) and
  // the reason-less-failure fallback ("send failed") are broadcast-specific.
  const { total, succeeded, failed } = summarizeFanout(results, ids, nameOf, 'send failed');
  return { total, sent: succeeded, failed };
}

/**
 * Toast variant / shape for a broadcast summary. Both alias the shared fan-out
 * types (./fanout) — see kill.ts for the rationale. The names are kept as
 * exported aliases so existing importers are unaffected.
 */
export type BroadcastToastVariant = FanoutToastVariant;

export type BroadcastToast = FanoutToast;

/**
 * Shape the result toast for a broadcast summary.
 *
 * - All sent → a one-line success: "Sent to N agents".
 * - Some/total failure → an error whose title carries the N/M tally and whose
 *   description lists each failed agent with its reason (so the human can see
 *   WHICH sessions didn't get the message and why — host unreachable, session
 *   dead, etc.). The description is the full failure list (not truncated): the
 *   sidebar's own selection caps it at a human-scale N, and sonner wraps a long
 *   description in a scrollable toast body. Rendered by showFanoutToast
 *   (./fanoutToast), which wraps it in `whitespace-pre-line` so each failure
 *   lands on its own line.
 */
export function formatBroadcastToast(s: BroadcastSummary): BroadcastToast {
  if (s.failed.length === 0) {
    return { title: `Sent to ${s.sent} agent${s.sent === 1 ? '' : 's'}`, variant: 'success' };
  }
  const list = s.failed.map((f) => `${f.name}: ${f.error}`).join('\n');
  if (s.sent === 0) {
    return {
      title: `Failed to reach ${s.failed.length} of ${s.total} agent${s.total === 1 ? '' : 's'}`,
      description: list,
      variant: 'error',
    };
  }
  return {
    title: `Sent to ${s.sent} of ${s.total} agents — ${s.failed.length} failed`,
    description: list,
    variant: 'error',
  };
}
