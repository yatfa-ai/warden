// Pure helpers for the multi-select broadcast-send feature (WARDEN-292).
//
// The fan-out itself (Promise.allSettled over /api/send per selected agent) lives
// in the ChatSidebar component because it touches fetch + toast + selection state.
// These helpers are the TESTABLE pure seam: reducing the allSettled outcomes into
// a per-agent summary, and shaping the result toast line. Extracted so the fiddly
// sent/failed accounting and the failure-list copy have real tests instead of
// being asserted by hand.
//
// `import type` only below — erased by OXC, so this module loads under the
// transpile-to-temp-`.mjs` + dynamic-`import()` harness (see broadcast.test.mjs),
// matching chatDisplay.test.mjs / gitStateSummary.test.mjs.

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
  const failed: BroadcastFailure[] = [];
  let sent = 0;
  results.forEach((res, i) => {
    const id = ids[i];
    if (res.status === 'fulfilled' && res.value?.ok) {
      sent += 1;
    } else {
      const error =
        res.status === 'rejected'
          ? (res.reason instanceof Error ? res.reason.message : String(res.reason ?? 'unknown error'))
          : (res.value?.error || 'send failed');
      failed.push({ id, name: nameOf(id) ?? id, error });
    }
  });
  return { total: results.length, sent, failed };
}

/** Toast variant for a broadcast summary — success only when every agent got it. */
export type BroadcastToastVariant = 'success' | 'error';

export interface BroadcastToast {
  title: string;
  description?: string;
  variant: BroadcastToastVariant;
}

/**
 * Shape the result toast for a broadcast summary.
 *
 * - All sent → a one-line success: "Sent to N agents".
 * - Some/total failure → an error whose title carries the N/M tally and whose
 *   description lists each failed agent with its reason (so the human can see
 *   WHICH sessions didn't get the message and why — host unreachable, session
 *   dead, etc.). The description is the full failure list (not truncated): the
 *   sidebar's own selection caps it at a human-scale N, and sonner wraps a long
 *   description in a scrollable toast body.
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
