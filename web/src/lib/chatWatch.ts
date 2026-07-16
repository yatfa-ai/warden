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

/**
 * Why a watched chat needs the human. Covers BOTH faces of "needs you":
 *  - the transition-based watch PING (diffWatchAlerts) — the reason a chat NEWLY needs
 *    you, so a once-per-transition ping can fire. Emits waiting/erroring/stuck/completed.
 *  - the persistent CURRENT-state row indicator (WARDEN-514, currentWatchNeed) — why a
 *    watched chat needs you RIGHT NOW, rendered at a glance on its row.
 * `blocked` is a persistent needs-you state (parity with the AttentionBadge's enabled
 * pane states) but is NOT a transition the ping fires on, so diffWatchAlerts never
 * emits it — only currentWatchNeed returns it. `completed` is the inverse: a
 * transition-only reason (a working→idle flip, detectWatchCompleted) that is never a
 * CURRENT persistent state, so currentWatchNeed never returns it (a finished chat's
 * current state is `idle` → null). One shared type keeps the ping + row wording in a
 * single WATCH_REASON_LABEL vocabulary (WARDEN-514).
 */
export type WatchReason = 'waiting' | 'erroring' | 'stuck' | 'completed' | 'blocked' | 'custom';

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
  // `blocked` (4) is unreachable on the ping path — diffWatchAlerts never emits it
  // (blocked is not a transition the ping fires on, only a persistent current-state
  // reason per WARDEN-514's currentWatchNeed) — so its slot here exists solely to
  // satisfy the exhaustive Record<WatchReason, number>. Placed lowest (a "waiting on
  // a dependency" state is the least actionable needs-you reason); never consulted.
  // `custom` (2, WARDEN-540) shares completed's tier: a user-authored pattern match
  // is an informational needs-you signal ("your pattern matched"), same tier as "it
  // finished." It TAKES PRECEDENCE in diffWatchAlerts when both a custom match and a
  // state transition newly appear in one tick (the user explicitly opted into the
  // pattern, so its specific signal wins the single per-key slot); this priority only
  // governs CROSS-tick cooldown escalation, where an erroring onset (0 < 2) over a
  // prior custom fire correctly counts as an escalation.
  erroring: 0, stuck: 1, completed: 2, custom: 2, waiting: 3, blocked: 4,
};

// WARDEN-452: per-key cooldown window for the LIVE watch-ping channel. A watched
// chat that FLAPS (e.g. erroring → active → erroring) re-enters its needs-state on
// every poll, and each re-entry pings anew once the prior toast is dismissed / DND'd
// / auto-timed-out — the Web Notifications `tag` only REPLACES a still-displayed
// notification, so a long step-away from a flaky watched chat spams repeats of the
// SAME underlying "this agent is struggling" episode. This collapses a flapping key
// to ONE ping per episode window (escalations override + reset), matching the
// discipline the catch-up side already applies (watchCatchup.awayMisses dedups
// newest-per-key). ~5 min: long enough to silence a flap, short enough that a chat
// STILL struggling after it gets a (justified) reminder ping.
export const WATCH_PING_COOLDOWN_MS = 5 * 60 * 1000;

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
    // WARDEN-540: a user-authored pattern newly matched this poll. The matcher runs
    // server-side in pollAgentStates and attaches `customMatch` to the row; this is
    // its transition-into-fire (sibling of the state-transition branches below). Fires
    // ONLY on the NEWLY-PRESENT edge (prior had no customMatch, cur has one) — a
    // persistent match never re-fires, and the first-observation baseline (`if (!p)
    // continue` above) already suppressed a freshly-watched chat already matching.
    const customNewlyMatched = !!c.customMatch && !p.customMatch;
    let reason: WatchReason | null = null;
    // Precedence: a custom match takes the single per-key slot over a state
    // transition. The user EXPLICITLY opted into "ping me when X prints", so when X
    // newly prints (possibly alongside an erroring/stuck onset that would also fire),
    // the specific named signal is the more useful ping — and emitting only ONE alert
    // per key per diff keeps the contract (the cooldown + OS `tag` collapse per key).
    // This ADDS a signal; it relaxes none — the state still flows to the attention
    // rollup (the badge shows the row; only the PING label is the custom one).
    if (customNewlyMatched) {
      reason = 'custom';
    } else if (WATCH_DIRECT_STATES.has(curState) && priorState !== curState) {
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
 * The last watch ping that fired for a key — the cooldown's per-key tracker
 * (WARDEN-452). Sibling of the caller's watchPrevRef discipline: a {key → entry} map
 * the caller stashes in a ref and advances each fire, so a FLAPPING watched chat
 * re-fires ONE ping per episode window, not one per re-entry.
 */
export interface WatchLastFired {
  /** The reason that last fired — to detect a higher-urgency escalation since. */
  reason: WatchReason;
  /** Epoch-ms the last fire happened — the anchor the cooldown window is measured from. */
  firedAt: number;
}

/** Per-key last-fired map: { key → { reason, firedAt } }. */
export type WatchLastFiredMap = Record<string, WatchLastFired>;

/**
 * Pure: gate a diff's watch alerts through a per-key cooldown so a flapping watched
 * chat produces ONE ping per episode window — escalations override + reset (WARDEN-452).
 *
 * Sibling of diffWatchAlerts (above): diffWatchAlerts decides a chat newly entered a
 * needs-you state (change-into-state only); THIS decides whether that fresh alert may
 * actually FIRE given what already fired for that key recently. Without it, a watched
 * chat that flaps (erroring → active → erroring each poll) re-enters its needs-state
 * on every poll, and each re-entry pings anew once the prior toast is gone (the Web
 * Notifications `tag` only replaces a STILL-DISPLAYED notification). This collapses
 * such a key to one ping per window — the live channel as disciplined as the catch-up
 * side (watchCatchup.awayMisses dedups newest-per-key).
 *
 * Gate rule (lower WATCH_REASON_PRIORITY number = MORE urgent — mind the direction):
 *  - No prior fire for the key → FIRE; anchor the window at `now`.
 *  - A HIGHER-URGENCY escalation (priority[reason] < priority[last.reason]) → FIRE
 *    immediately AND reset the anchor to `now`. A genuinely worse state is never a
 *    false negative.
 *  - Same-or-lower urgency (priority[reason] >= priority[last.reason]) WITHIN the
 *    window → SUPPRESS: a re-entry into the same need-episode is the flap noise this
 *    collapses. The anchor is NOT advanced, so the window stays measured from the
 *    last ACTUAL fire — a continuously-flapping key re-pings once the window elapses
 *    (a new episode), never silenced indefinitely.
 *  - Same-or-lower urgency AFTER the window → FIRE; re-anchor at `now`.
 *
 * `completed` (priority 2) deliberately participates in the uniform rule rather than
 * being special-cased: a `waiting` (3) → `completed` (2) flip counts as an escalation
 * and fires/reset. Semantically `completed` is a different KIND of need (the agent
 * finished a task, not a degradation), but firing on it is correct — it is genuinely
 * new, actionable information ("review what I finished"), and special-casing it to
 * suppress would risk a false negative on a real signal. The single priority rule
 * keeps the gate explainable; the converse (`completed` → `waiting`) is a same-or-
 * lower-urgency re-entry and is suppressed within the window like any other.
 *
 * Returns the subset that may fire PLUS the updated last-fired map. `lastFired` is
 * treated immutably — a NEW map is returned (the input is never mutated), and every
 * prior anchor is carried forward so a key with no alert this diff (stable needs-
 * state, or momentarily recovered) KEEPS its anchor for the next diff. The caller
 * prunes un-watched keys (mirroring watchPrevRef's rebuild-from-watched) so a stale
 * anchor can't suppress a fresh re-watch's first ping. `now` is a parameter (not
 * Date.now()) so the unit test pins the clock, the discipline toWatchMiss follows.
 *
 * Pure + dependency-free (reads only the `import type`-erased shapes defined here) so
 * web/chatWatch.test.mjs loads it standalone alongside diffWatchAlerts via Vite's OXC
 * transform. At most one alert per key per diff (diffWatchAlerts' contract), so the
 * per-alert update never races itself within one call.
 */
export function applyWatchCooldown(
  alerts: WatchAlert[],
  lastFired: WatchLastFiredMap | null,
  now: number,
  cooldownMs: number = WATCH_PING_COOLDOWN_MS,
): { fire: WatchAlert[]; lastFired: WatchLastFiredMap } {
  const prev = lastFired || {};
  // Carry forward every prior anchor: a key that produced no alert this diff (stable
  // needs-state, or momentarily recovered) must KEEP its last-fire time so the window
  // is measured correctly when it next re-enters. The caller prunes un-watched keys.
  const next: WatchLastFiredMap = { ...prev };
  const fire: WatchAlert[] = [];
  for (const a of alerts) {
    const last = prev[a.key];
    const isEscalation = !!last
      && WATCH_REASON_PRIORITY[a.reason] < WATCH_REASON_PRIORITY[last.reason];
    const elapsed = last ? now - last.firedAt : Infinity;
    if (!last || isEscalation || elapsed >= cooldownMs) {
      fire.push(a);
      next[a.key] = { reason: a.reason, firedAt: now };
    }
    // else: suppressed — next[a.key] retains the carried-forward prior anchor (the
    // window is NOT slid forward, so a continuous flap re-pings once it elapses).
  }
  return { fire, lastFired: next };
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

// WARDEN-514: the persistent needs-you CURRENT states for a watched chat — the row
// indicator's "does this watched chat need me right now?" set. The watch PING's
// WATCH_DIRECT_STATES (waiting/erroring/stuck) PLUS 'blocked', for parity with the
// AttentionBadge's enabled pane states (blocked reads "needs you" on the badge too).
// 'active'/'idle' are NOT here — a happily-working or finished chat does not need you
// right now. 'completed' is a TRANSITION (a working→idle flip, detectWatchCompleted),
// not a current state: a finished chat's current state is 'idle', which is not here,
// so a completed chat naturally renders the neutral watch glyph (the proposal's
// "exclude the transient completed event"). Sibling of WATCH_DIRECT_STATES + blocked.
const WATCH_NEED_STATES = new Set(['waiting', 'erroring', 'stuck', 'blocked']);

/**
 * Pure: does a watched chat's CURRENT state need the human right now, and if so why?
 * (WARDEN-514.) Sibling of the transition-based diffWatchAlerts: THAT decides a chat
 * NEWLY entered a needs-you state (change-into-state only, for the once-per-transition
 * ping); THIS maps a chat's CURRENT state to the persistent reason the row indicator
 * shows at a glance — so a watched-but-closed pane that currently needs the human is
 * recognizable in Warden without relying on the transient OS toast.
 *
 *  - Returns the state as the reason for the persistent needs-you states (waiting /
 *    erroring / stuck / blocked — WATCH_NEED_STATES). `blocked` is included for parity
 *    with the AttentionBadge even though the transition ping never fires on it.
 *  - Returns null for active / idle / any unrecognized state → neutral (the row renders
 *    the unchanged watch glyph). `completed` is a transition, never a current state, so
 *    it can never be the return (a finished chat is currently `idle` → null).
 *
 * There is no existing "current state → reason" mapper because the watch subsystem is
 * transition-based (diffWatchAlerts); this is the current-state complement. Pure +
 * dependency-free (reads only the AgentStateRow shape — an `import type` erased at
 * transpile) so chatWatch.test.mjs loads it standalone alongside diffWatchAlerts.
 */
export function currentWatchNeed(row: AgentStateRow): WatchReason | null {
  // WARDEN-540: a currently-matching user pattern is a persistent needs-you signal —
  // the human asked to be told when X prints, and X is on the pane right now. It
  // takes precedence over the pane state (mirrors diffWatchAlerts' custom-takes-
  // precedence rule) so the row glyph + tooltip agree with the ping that fired.
  if (row?.customMatch) return 'custom';
  const s = row?.state;
  // WATCH_NEED_STATES holds exactly the WatchReason persistent needs-you states, so the
  // cast is sound; every other state (incl. the transition-only 'completed') → null.
  if (s && WATCH_NEED_STATES.has(s)) return s as WatchReason;
  return null;
}
