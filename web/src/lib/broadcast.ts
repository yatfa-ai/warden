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

import { formatFanoutToast, summarizeFanout, type FanoutToast, type FanoutToastVariant } from './fanout';

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
 *   dead, etc.).
 *
 * The three-branch shape itself is the shared formatFanoutToast (./fanout,
 * WARDEN-1034); only the broadcast COPY lives here. Broadcast is the reason the
 * failure phrase is passed as its OWN opaque unit: it succeeds with "Sent to"
 * but fails with "Failed to reach" — no object — so no verb+object
 * reconstruction can produce both. `sent` is mapped onto the shared `succeeded`
 * field; the public BroadcastSummary shape is unchanged.
 */
export function formatBroadcastToast(s: BroadcastSummary): BroadcastToast {
  return formatFanoutToast(
    { total: s.total, succeeded: s.sent, failed: s.failed },
    { success: 'Sent to', failure: 'Failed to reach' },
  );
}
