// Pure + shared impure helpers for the multi-select batch-interrupt feature
// (WARDEN-492, surfaced in the sidebar + Fleet Health).
//
// Interrupt is the non-destructive third fleet operation — the safe middle ground
// between batch Send (WARDEN-292, broadcast text) and batch Kill (WARDEN-328,
// `kill-session` destroys the chat's tmux session + scrollback). It sends a
// CONTROL KEY (Ctrl-C / Esc) to each selected agent's tmux session via the
// existing `POST /api/key` route (server.js → sendKey). The key signals only the
// foreground process (Ctrl-C → SIGINT) or dismisses a prompt / clears the input
// line (Esc); the session and its scrollback SURVIVE, so the human can continue
// — the observable difference from Kill.
//
// The PURE seam (summarizeKeySend → summarizeFanout, formatKeySendToast) is the
// testable part: reducing the allSettled outcomes into a per-agent summary and
// shaping the result-toast line. The accounting is shared with broadcast-send
// and batch-kill via summarizeFanout (the allSettled→summary reducer); only the
// keysend-specific copy + the "key send failed" fallback live here.
//
// The IMPURE seam (runKeySendFanout) is the shared fan-out itself: Promise.allSettled
// over /api/key per selected agent. It lives here (mirroring runKillFanout in
// kill.ts) because interrupt — like kill — is a TWO-surface operation (sidebar
// WARDEN-492, Fleet Health WARDEN-492), so the fetch-and-reduce shape lives once
// instead of being duplicated inline in each component. Unlike kill, interrupt is
// NON-DESTRUCTIVE: no tmux session is destroyed, so there is nothing to reconcile
// (no catalog forget, no re-discover). Recovery surfaces on the next
// `classifyPane` / health poll tick, not via an eager reconcile — hence no
// `onSettled` hook.
//
// `import type` only below (besides summarizeFanout) — erased by OXC, so this
// module loads under the same transpile-to-temp-`.mjs` + dynamic-`import()`
// harness as broadcast.ts / kill.ts (see keysend.test.mjs).

import { summarizeFanout } from './fanout';

/** Outcome of one agent's /api/key: either ok, or not-ok with a reason. */
export interface KeySendOutcome { ok: boolean; error?: string }

/** One agent the key did NOT reach. */
export interface KeySendFailure { id: string; name: string; error: string }

/** Per-agent result of a key-send fan-out. `sent` is the count that came back {ok:true}. */
export interface KeySendSummary {
  total: number;
  sent: number;
  failed: KeySendFailure[];
}

/**
 * Reduce `Promise.allSettled` outcomes into a per-agent key-send summary. Delegates
 * the shared allSettled accounting to summarizeFanout (success = fulfilled
 * `{ok:true}`; failure = rejected or fulfilled `{ok:false}`), mapping `succeeded`
 * → `sent` and defaulting a reason-less failure to "key send failed". See
 * summarizeFanout for the partial-failure-doesn't-abort-siblings contract.
 */
export function summarizeKeySend(
  results: PromiseSettledResult<KeySendOutcome>[],
  ids: string[],
  nameOf: (id: string) => string,
): KeySendSummary {
  const { total, succeeded, failed } = summarizeFanout(results, ids, nameOf, 'key send failed');
  return { total, sent: succeeded, failed };
}

/** Toast variant for a key-send summary — success only when every agent got it. */
export type KeySendToastVariant = 'success' | 'error';

export interface KeySendToast {
  title: string;
  description?: string;
  variant: KeySendToastVariant;
}

// The human-facing verb depends on what the key DOES, not the raw tmux token:
// C-c interrupts the foreground process (SIGINT); Escape dismisses a prompt /
// clears the input line. Both are non-destructive (the session + scrollback
// survive). An unrecognized key falls back to the generic "Sent {key} to" so the
// copy stays honest if the vocabulary grows later.
//
// `verb` is the past-tense subject ("Interrupted 3 agents" / "Sent Esc to 3
// agents"); `verbInf` is the bare infinitive used after "Failed to "
// ("Failed to interrupt 2 of 2 agents" / "Failed to send Esc to 2 of 2 agents").
const COPY: Record<string, { verb: string; verbInf: string; obj: string }> = {
  'C-c': { verb: 'Interrupted', verbInf: 'interrupt', obj: '' },
  Escape: { verb: 'Sent', verbInf: 'send', obj: ' Esc to' },
};

/**
 * Shape the result toast for a key-send summary.
 *
 * `key` drives the verb because the two offered keys do visibly different things:
 * Ctrl-C interrupts (the common "all my agents are stuck" case), Esc dismisses a
 * prompt. The copy says what actually happened, not a generic "sent".
 *
 * - All sent → a one-line success: "Interrupted N agents" / "Sent Esc to N agents".
 * - Some/total failure → an error whose title carries the N/M tally and whose
 *   description lists each agent the key didn't reach with its reason (so the
 *   human can see WHICH sessions didn't respond and why — host unreachable,
 *   session dead, etc.). The description is the full failure list (not
 *   truncated): the selection caps it at a human-scale N, and sonner wraps a long
 *   description in a scrollable toast body. Rendered with `whitespace-pre-line`
 *   by the caller so each failure lands on its own line.
 */
export function formatKeySendToast(s: KeySendSummary, key: string): KeySendToast {
  const { verb = 'Sent', verbInf = 'send', obj = ` ${key} to` } = COPY[key] ?? {};
  if (s.failed.length === 0) {
    return { title: `${verb}${obj} ${s.sent} agent${s.sent === 1 ? '' : 's'}`, variant: 'success' };
  }
  const list = s.failed.map((f) => `${f.name}: ${f.error}`).join('\n');
  if (s.sent === 0) {
    return {
      title: `Failed to ${verbInf}${obj} ${s.failed.length} of ${s.total} agent${s.total === 1 ? '' : 's'}`,
      description: list,
      variant: 'error',
    };
  }
  return {
    title: `${verb}${obj} ${s.sent} of ${s.total} agents — ${s.failed.length} failed`,
    description: list,
    variant: 'error',
  };
}

/**
 * Fan a CONTROL KEY out to every selected agent via the existing per-target
 * /api/key path (server.js → sendKey → tmux send-keys), then reduce the outcomes
 * into a per-agent summary. Shared by every multi-select interrupt surface
 * (sidebar WARDEN-492, Fleet Health WARDEN-492) so the fetch-and-reduce shape
 * lives once — mirroring runKillFanout in kill.ts, which was extracted for the
 * same two-surface reason.
 *
 * `key` MUST be a member of the backend's ALLOWED_KEYS allowlist (src/tmux.js);
 * the dialog bounds its Select to exactly that vocabulary, and the backend
 * rejects anything unlisted, so an out-of-vocabulary key surfaces as a per-agent
 * failure rather than sending arbitrary bytes. This is the inherent safety bound
 * — no injection surface, same as the per-pane key path.
 *
 * Promise.allSettled (not Promise.all) so a partial failure — one host
 * unreachable, one session dead — is reported per-agent and does NOT abort the
 * other sends. Never throws: failure is encoded in the summary.
 *
 * No `onSettled` reconcile (contrast runKillFanout): interrupt changes no
 * catalog/session state, so there is nothing to refresh. A signaled agent
 * reclassifies off stuck/erroring on the next `classifyPane` tick
 * (src/agentState.js) and reflects in the attention/health surfaces then.
 *
 * Stale ids (an agent that died between selecting and interrupting) are still
 * sent to and reported as a per-agent failure rather than silently dropped.
 */
export async function runKeySendFanout(
  ids: string[],
  key: string,
  nameOf: (id: string) => string,
): Promise<KeySendSummary> {
  const results = await Promise.allSettled(
    ids.map((id) =>
      fetch('/api/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, key }),
      }).then(async (r) =>
        r.ok
          ? { ok: true }
          : { ok: false, error: (await r.json().catch(() => ({}))).error || `HTTP ${r.status}` },
      ),
    ),
  );
  return summarizeKeySend(results, ids, nameOf);
}
