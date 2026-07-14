// Per-chat "watch" transition detector + types (WARDEN-378) — the deterministic,
// non-LLM, per-chat, opt-in complement to the fleet-wide Attention desktop alert
// (WARDEN-259). The human marks a SPECIFIC chat "watch"; this module decides WHEN
// that chat newly needs them, so a targeted, reason-specific ping can fire.
//
// Sibling of observer.js's diffAlerts (src/observer.js:383-418): the same
// change-into-state-only, never-twice, first-observation-is-baseline transition
// semantics, lifted to the per-chat watch path. The signal comes from the
// /api/agent-states rows (classifyPane, no LLM — WARDEN-344), NOT the Observer.
//
// One deliberate delta from diffAlerts' ALERTABLE_STATES (src/observer.js:371): the
// watch ALSO fires on newly-entering 'waiting' — the primary use case ("ping me
// when a chat needs my input"). The fleet Observer excludes waiting (too noisy
// fleet-wide); a per-chat opt-in is precise enough to include it. 'completed' is
// derived exactly as detectCompleted's transcript-less fallback (src/observer.js:366):
// a working state → idle transition. Bare idle (a non-working → idle flip, e.g.
// capture recovery) does NOT fire — it is not a "needs you" signal.
//
// Pure + dependency-free (only `import type`, erased at transpile) so the unit
// test loads it standalone via Vite's OXC transform, mirroring attentionRollup.ts
// and desktopAlerts.ts.
import type { AgentStateRow } from '@/lib/types';

/** Why a watched chat newly needs the human. */
export type WatchReason = 'waiting' | 'erroring' | 'stuck' | 'completed';

/** A single watched-chat transition that warrants a targeted ping. */
export interface WatchAlert {
  key: string;
  reason: WatchReason;
  /** The triggering /api/agent-states row (carries name + signal for the body). */
  row: AgentStateRow;
  fromState: string | null;
  toState: string;
}

// States that directly warrant a watch ping when newly entered. Mirrors observer.js's
// ALERTABLE_STATES (src/observer.js:371) PLUS 'waiting' — the per-chat opt-in is
// precise enough to surface "waiting for your input", the watch's primary case.
// 'idle' is intentionally NOT here: bare idle is not a "needs you" signal. A
// working→idle flip fires 'completed' instead (detectWatchCompleted below).
const WATCH_DIRECT_STATES = new Set(['waiting', 'erroring', 'stuck']);

// "Working" states — a transition from one of these to 'idle' means the agent just
// finished a task ('completed'). Mirrored verbatim from observer.js's detectCompleted
// (src/observer.js:361). The /api/agent-states endpoint carries no transcript phase,
// so only detectCompleted's fallback branch applies here (src/observer.js:366).
const WORKING_STATES = new Set(['active', 'stuck', 'erroring', 'blocked', 'waiting']);

// Urgency precedence for sorting multiple alerts in one diff (mirrors observer.js's
// ALERT_PRIORITY, src/observer.js:372): an error is more actionable than "it
// finished", which beats a bare waiting. Determines only the ORDER alerts fire in,
// never whether they fire.
const WATCH_REASON_PRIORITY: Record<WatchReason, number> = {
  erroring: 0, stuck: 1, completed: 2, waiting: 3,
};

/**
 * Did a watched agent just complete a task? The transcript-less fallback of
 * detectCompleted (src/observer.js:366): a working state → idle flip. The
 * /api/agent-states rows carry no transcript phase, so detectCompleted's phase-based
 * branch (mid-turn → awaiting-input) is unreachable here — only the working→idle
 * fallback applies. Pure — exercised directly in the unit test.
 */
export function detectWatchCompleted(priorState: string | null, curState: string): boolean {
  return !!priorState && WORKING_STATES.has(priorState) && curState === 'idle';
}

/**
 * Pure: diff a prior per-key state snapshot against a freshly observed one and
 * surface ONLY watched chats that newly entered a needs-you state (waiting /
 * erroring / stuck / completed) since the last observation. Sibling of
 * observer.js's diffAlerts (src/observer.js:383-418).
 *
 *  - Fires on change-into-state ONLY: a chat already in the state produces no
 *    alert, and a chat with no prior baseline (first observation) produces none
 *    either — the near-zero-false-signal bar (matches diffAlerts'
 *    `if (!p) continue`).
 *  - Never twice: the same persistent state never re-fires (priorState === curState
 *    is never newlyEntered; a working→idle 'completed' needs the prior to be a
 *    DIFFERENT working state, so idle→idle never fires).
 *  - Recovery never fires: a transition OUT of a needs-you state (e.g. erroring →
 *    active) is not itself a needs-you state, so it produces no alert.
 *  - At most ONE alert per watched chat per diff: the direct states (waiting/
 *    erroring/stuck) are mutually exclusive with 'completed' (completed requires
 *    curState 'idle'; the direct states are not 'idle').
 *
 * `prevByKey` / `curByKey` are /api/agent-states rows keyed by pane key. Only keys
 * in `watchedKeys` are considered. A watched key absent from `curByKey` this poll
 * is skipped (its prior is preserved by the caller) — a host blip or a gone chat
 * neither fires nor drops the baseline.
 */
export function diffWatchAlerts(
  prevByKey: Record<string, AgentStateRow> | null,
  curByKey: Record<string, AgentStateRow> | null,
  watchedKeys: string[] | Set<string> | null,
): WatchAlert[] {
  const prev = prevByKey || {};
  const cur = curByKey || {};
  const keys = watchedKeys ? Array.from(watchedKeys) : [];
  const alerts: WatchAlert[] = [];
  for (const key of keys) {
    const c = cur[key];
    if (!c) continue; // not observed this poll → keep prior, no diff
    const p = prev[key];
    if (!p) continue; // first observation → baseline, no fire (diffAlerts: `if (!p) continue`)
    const curState = c.state;
    const priorState = p.state;
    let reason: WatchReason | null = null;
    if (WATCH_DIRECT_STATES.has(curState) && priorState !== curState) {
      reason = curState as WatchReason;
    } else if (detectWatchCompleted(priorState, curState)) {
      reason = 'completed';
    }
    if (reason) {
      alerts.push({ key, reason, row: c, fromState: priorState ?? null, toState: curState });
    }
  }
  alerts.sort((a, b) => WATCH_REASON_PRIORITY[a.reason] - WATCH_REASON_PRIORITY[b.reason]);
  return alerts;
}

/**
 * Build a key → row index from a /api/agent-states row list, for diffWatchAlerts.
 * Keys on the pane `key` (falling back to `id`) — the same identity openPanes and
 * watchedChats use. Only the last row for a key is kept (a key should appear once;
 * defensive against a duplicate).
 */
export function indexByWatchKey(rows: AgentStateRow[] | null): Record<string, AgentStateRow> {
  const out: Record<string, AgentStateRow> = {};
  if (Array.isArray(rows)) {
    for (const r of rows) {
      const k = r?.key ?? r?.id;
      if (k) out[k] = r;
    }
  }
  return out;
}
