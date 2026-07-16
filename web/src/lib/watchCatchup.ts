// watchCatchup — durable in-app catch-up for per-chat "watch" pings that fired
// while the human was AWAY (WARDEN-417). The symmetric false-NEGATIVE half of the
// Observer Job #1 trust bar: WARDEN-390 closed the false-positive half (recovered
// states no longer read "needs attention"); this closes the miss half for the
// per-chat watch (WARDEN-378), at the point a miss is most likely AND most costly.
//
// WARDEN-378's watch ping has a SINGLE delivery channel — fireWatchNotification over
// the Web Notifications API — which silently no-ops when Notifications are
// unsupported (embedded webview), denied, cleared, or lost to DND. So a watched
// chat that newly needs the human while they are stepped away ("watch this chat,
// step away" — the watch's headline scenario) can be silently lost: nothing is
// recorded at the fire site, so on return there is no in-app trace it happened.
//
// This module records the watch alerts the OS channel did NOT reliably deliver —
// either because fireWatchNotification no-op'd (Notifications unsupported / denied /
// rejected) OR because the ping fired while the human was AWAY and may yet be cleared
// — into a BOUNDED client-side log, and exposes the pure logic that turns them into a
// reason-specific, deep-linking catch-up surfaced on the human's RETURN. It recovers
// what the OS channel lost, WITHOUT firing a new OS notification. Its job is to be
// the safety net under the OS channel, not a second channel: a ping the OS delivered
// to a PRESENT human is never recorded (shouldRecordMiss), so it can never re-surface
// as stale noise.
//
// Discipline (mirrors chatWatch.ts / desktopAlerts.ts / whatsNew.ts): pure +
// dependency-free (only `import type`, erased at transpile) so the unit test loads
// it standalone via Vite's OXC transform. The only I/O is the localStorage
// getters/setters, which mirror whatsNew.ts's LAST_SEEN_PREFIX discipline and the
// fleet `warden:lastClose` stamp — console.warn on quota, never throws.

import type { WatchReason } from '@/lib/chatWatch';
import type { AgentStateRow } from '@/lib/types';

// localStorage keys. LOG holds the bounded ring buffer of fired-while-away watch
// alerts; SEEN is the epoch-ms "last acknowledged" boundary (the catch-up's "since"
// cutoff). Mirrors whatsNew.ts's `warden:lastSeen:` prefix discipline (whatsNew.ts)
// and the fleet-wide `warden:lastClose` stamp (App.tsx): same String(epoch-ms)
// shape for SEEN, JSON array for LOG.
export const WATCH_MISS_LOG_KEY = 'warden:watchMissedLog';
export const WATCH_MISS_SEEN_KEY = 'warden:watchMissedSeen';

// Ring-buffer cap. A watched chat that flaps (e.g. waiting → active → waiting) can
// fire repeatedly across a long step-away; the log is bounded so it never grows
// unbounded in localStorage across a long session. 50 is generous (one away session
// rarely produces more than a handful) yet cheap to serialize, and it is only ever
// written when shouldRecordMiss says to (OS channel lost the ping OR the human is
// away) — never for a ping the OS delivered to a present human.
export const WATCH_MISS_LOG_MAX = 50;

/** One fired-while-away watch alert, recorded durably for catch-up on return. */
export interface WatchMiss {
  /** Pane key (row.key || row.id) — the deep-link target, same identity openChat uses. */
  key: string;
  /** Why the chat newly needed the human (the WatchReason from diffWatchAlerts). */
  reason: WatchReason;
  /** Agent display name (row.name || row.key || row.id) for the catch-up line. */
  name: string;
  /** The triggering signal (e.g. "press enter to continue"), quoted in the catch-up. Optional. */
  signal?: string;
  /** Epoch-ms when the watch ping fired (the away instant we are recovering). */
  firedAt: number;
}

/**
 * Pure: build a WatchMiss from a fired alert's row + reason. Sibling of
 * desktopAlerts.formatWatchMessage — captures the SAME {name, signal} the OS
 * notification would have shown, so the in-app catch-up conveys the identical
 * "which chat, why" information the lost OS ping carried. `now` is optional ONLY so
 * tests can pin the clock; production callers (recordWatchMiss) omit it.
 */
export function toWatchMiss(row: AgentStateRow, reason: WatchReason, now: number): WatchMiss {
  // WARDEN-540: for a custom-pattern ping the actionable signal is the matching line
  // (row.signal is classifyPane's signal, not the match — the match lives in
  // row.customMatch). Falls through to row.signal for every other reason, unchanged.
  const signal = reason === 'custom' && row.customMatch
    ? row.customMatch.line
    : (row.signal || undefined);
  return {
    key: row.key || row.id || '',
    name: row.name || row.key || row.id || '',
    reason,
    signal,
    firedAt: now,
  };
}

/**
 * Pure: append a miss to the log as a BOUNDED ring buffer — when the log is at the
 * cap, the OLDEST entry (index 0) is evicted (FIFO) so the most-recent `max` fires
 * are always retained and the store never grows unbounded across a long away
 * session. Returns a NEW array (immutable) so the caller can hand it to React state
 * and the unit test sees a stable shape. `max` defaults to WATCH_MISS_LOG_MAX but is
 * a parameter so the ring-buffer bound is unit-tested directly.
 */
export function appendWatchMiss(log: WatchMiss[], miss: WatchMiss, max: number = WATCH_MISS_LOG_MAX): WatchMiss[] {
  const next = [...log, miss];
  if (next.length > max) next.splice(0, next.length - max); // evict oldest first
  return next;
}

/**
 * Pure: drop every miss for a given key (the per-key ack-on-open path). Used when
 * the human opens a watched chat from the catch-up: that chat's alerts are
 * acknowledged and removed, while the OTHER chats' alerts remain in the catch-up.
 * Returns a NEW array (immutable).
 */
export function withoutKey(log: WatchMiss[], key: string): WatchMiss[] {
  return log.filter((m) => m.key !== key);
}

/**
 * Pure: is this miss inside the away window [since, ∞)? A miss at/after `since`
 * counts as "fired while away and not yet recovered"; strictly-before does not — it
 * predates the current away boundary (already acknowledged via the seen stamp).
 *
 * `since` is the catch-up's ack boundary (warden:watchMissedSeen, default 0): the
 * "While you were away" banner's `warden:lastClose` is the sibling concept for the
 * server-sourced activity path; the watch path is client-recorded (only while the
 * app runs), so its boundary is the last-acknowledged stamp rather than the last
 * app-close. Advancing `since` past a miss's firedAt (on dismiss) excludes that
 * miss — the "a seen alert is not re-surfaced" ack path.
 */
export function inAwayWindow(miss: WatchMiss, since: number): boolean {
  return miss.firedAt >= since;
}

// The persistent needs-you states a CURRENT snapshot can reconcile an away miss
// against (WARDEN-476). Mirrors chatWatch.ts WATCH_DIRECT_STATES (:42) — keep in
// sync. A watched chat whose current state is NOT one of these has RECOVERED since
// the miss fired, so its away miss is suppressed at read-time (reconcileAwayMisses)
// and the catch-up agrees with the live return-banner callout. Mirrored locally
// (not imported) to preserve this module's dependency-free discipline — the same
// way WATCH_MISS_REASON_LABEL below mirrors desktopAlerts' WATCH_REASON_LABEL.
const WATCH_NEEDS_YOU_STATES: ReadonlySet<string> = new Set(['waiting', 'erroring', 'stuck']);

// Urgency precedence for ranking surviving misses (WARDEN-476). Mirrors chatWatch.ts
// WATCH_REASON_PRIORITY (:54) — keep in sync. The catch-up ranks survivors by the
// SAME order the live pings FIRE in (diffWatchAlerts sorts its alerts by this table),
// so the in-app catch-up is consistent with the live channel. Lower number = MORE
// urgent (sorts first); a stable firedAt-desc tiebreak keeps same-reason misses
// newest-first. NOTE this ranks 'waiting' LAST among survivors — see WARDEN-476's PR:
// reusing the keyed fire-order table over attentionRollup's ATTENTION_RANK (which
// promotes 'waiting' first) is the deliberate choice, for cross-channel consistency
// with the order the pings themselves fire. Mirrored locally for the same
// dependency-free reason as WATCH_NEEDS_YOU_STATES above.
const WATCH_REASON_PRIORITY: Record<WatchReason, number> = {
  // `blocked` (4) mirrors chatWatch.ts (WARDEN-514): unreachable on the catch-up path —
  // a miss is a recorded TRANSITION ping, and the ping never fires on blocked — so its
  // slot exists only to satisfy the exhaustive Record<WatchReason, number>. `custom`
  // (2, WARDEN-540) mirrors chatWatch.ts's priority so a custom-pattern miss ranks in
  // the SAME urgency tier here as the ping fired there (cross-channel consistency).
  erroring: 0, stuck: 1, completed: 2, custom: 2, waiting: 3, blocked: 4,
};

/**
 * Pure: the unacknowledged away misses — the log filtered to the away window
 * (`firedAt >= since`), deduped to the NEWEST miss per chat key, then URGENCY-RANKED
 * (WARDEN-476). This is the candidate list the catch-up surface renders AFTER
 * reconcileAwayMisses suppresses the recovered ones.
 *
 * Dedup-by-newest (not oldest) means a chat that flapped (e.g. fired waiting, then
 * later erroring, while you were away) surfaces ONCE with its latest, most
 * actionable reason — never two rows for one chat. The urgency ranking (WATCH_REASON_PRIORITY)
 * puts a live "erroring" ABOVE a trivial "finished a task" (goal #2): a stable
 * firedAt-desc tiebreak keeps the prior newest-first behaviour for an equal-reason
 * set, so this is behaviour-preserving for single-reason inputs.
 */
export function awayMisses(log: WatchMiss[], since: number): WatchMiss[] {
  const inWindow = log.filter((m) => inAwayWindow(m, since));
  // Newest per key: walk in log order (oldest→newest), overwriting, so the LAST
  // entry seen for a key wins (the newest).
  const byKey = new Map<string, WatchMiss>();
  for (const m of inWindow) byKey.set(m.key, m);
  // Rank by URGENCY (WARDEN-476): reuses the watch fire-order precedence so the
  // catch-up is ordered the SAME way the live pings fire. The firedAt-desc tiebreak
  // preserves the prior newest-first order for an equal-reason set.
  return Array.from(byKey.values()).sort(
    (a, b) => WATCH_REASON_PRIORITY[a.reason] - WATCH_REASON_PRIORITY[b.reason] || b.firedAt - a.firedAt,
  );
}

/**
 * Pure (WARDEN-476): reconcile the away misses against the chats' CURRENT states on
 * return, suppressing any miss whose chat has since RECOVERED — so the catch-up only
 * ever directs the human to a chat that STILL needs them, agreeing with the co-rendered
 * live return-banner callout (whose rankAttention lead is recency-bound). Closes the
 * last false-positive trust hole in the per-chat watch catch-up (Observer Job #1).
 *
 * READ-TIME only — the durable log is the bounded history and a chat can re-error after
 * recovering (the next fire records a fresh miss), so the log is NEVER mutated here;
 * it must stay queryable. This is a display reconciliation, not an ack.
 *
 * Suppression rule (suppress = drop from the catch-up THIS return):
 *  - A miss whose key has a current snapshot that is NO LONGER a persistent needs-you
 *    state (not in WATCH_NEEDS_YOU_STATES) is suppressed — the chat recovered while the
 *    human was away, so directing them to it lands on a chat that needs nothing.
 *  - A key with NO current snapshot (host blip / not yet fetched this poll) is KEPT —
 *    suppressing without confirmation would risk a false NEGATIVE (silently dropping a
 *    real need), the worse failure mode. On a normal return the agent-states poll has
 *    run, so a current snapshot is present for every watched chat.
 *  - A 'completed' miss is ALWAYS KEPT: completed is a TRANSIENT working→idle event
 *    (detectWatchCompleted) whose landing state is 'idle' — the healthy/recovered
 *    state — so a naive "current state not needs-you → suppress" would drop EVERY
 *    completed miss. "Finished a task while you were away" is legitimate informational
 *    catch-up; it is ranked LOWEST (WATCH_REASON_PRIORITY) instead, satisfying goal #2
 *    without losing it.
 *
 * Order is PRESERVED (this is a filter, not a re-sort): pass it the urgency-ranked
 * output of awayMisses and the survivors stay urgency-ranked. Pure + dependency-free.
 *
 * `currentByKey` is a key→AgentStateRow index of the watched chats' current states
 * (built by the caller via indexByWatchKey, from useAttentionRollup's watched-states
 * exposure). null/empty is a no-op suppressor (keeps every miss) — the safe default
 * before any poll has landed.
 */
export function reconcileAwayMisses(
  misses: WatchMiss[],
  currentByKey: Record<string, AgentStateRow> | null,
): WatchMiss[] {
  if (!currentByKey) return misses;
  return misses.filter((m) => {
    if (m.reason === 'completed') return true; // informational; never recovered-away
    const cur = currentByKey[m.key];
    if (!cur) return true; // no current snapshot → can't confirm recovery → keep
    return WATCH_NEEDS_YOU_STATES.has(cur.state); // keep only if still needs-you
  });
}

// Reason → human phrasing for the catch-up line. Mirrors desktopAlerts'
// WATCH_REASON_LABEL (desktopAlerts.ts) so the in-app catch-up reads identically to
// the lost OS notification's body — the catch-up is the in-app twin of the ping.
const WATCH_MISS_REASON_LABEL: Record<WatchReason, string> = {
  waiting: 'waiting for your input',
  erroring: 'erroring',
  stuck: 'stuck (repeating output)',
  completed: 'finished a task',
  // WARDEN-540: mirrors desktopAlerts' WATCH_REASON_LABEL. A custom-pattern ping IS
  // recorded as a miss (the catch-up covers every transition ping the OS channel
  // lost), so this phrasing is reachable — it reads identically to the lost toast.
  custom: 'matched a watch pattern',
  // WARDEN-514: mirrors desktopAlerts' WATCH_REASON_LABEL. Unreachable on the catch-up
  // path (a miss is a recorded transition ping, and the ping never fires on blocked),
  // but present so the mirror stays an exhaustive Record<WatchReason, string>.
  blocked: 'blocked — waiting on a dependency',
};

/**
 * Pure: the reason-specific catch-up line for ONE miss — names the chat and conveys
 * the reason, quoting the triggering signal verbatim when present (the WARDEN-68
 * beauty bar: the human knows WHICH chat and WHY without opening it). Mirrors
 * desktopAlerts.formatWatchMessage's body shape (`name · reason — 'signal'`) so the
 * catch-up carries the identical information the lost OS ping would have.
 */
export function formatWatchMiss(miss: WatchMiss): string {
  const label = WATCH_MISS_REASON_LABEL[miss.reason] || miss.reason;
  return `${miss.name} · ${label}${miss.signal ? ` — '${miss.signal}'` : ''}`;
}

/**
 * Pure: the one-glance summary header for N away misses, e.g.
 * "2 watched chats needed you while you were away". Pluralization is exact. Empty
 * input → empty string (the caller hides the surface when there is nothing to say).
 */
export function formatCatchupSummary(misses: WatchMiss[]): string {
  const n = misses.length;
  if (n === 0) return '';
  return `${n} watched chat${n === 1 ? ' needed' : 's needed'} you while you were away`;
}

// ---------------------------------------------------------------------------
// localStorage I/O — mirrors whatsNew.ts's getLastSeen/stampLastSeen discipline:
// absent/corrupt → a safe default, never throws; quota failure → console.warn.
// ---------------------------------------------------------------------------

/**
 * Read the bounded miss log. Returns [] when the key is absent or the stored value
 * is corrupt/unparseable — never throws (WARDEN-89 discipline: a bad value is
 * ignored, not fatal, so a corrupt log can never crash the catch-up or the poll).
 */
export function loadWatchMissLog(): WatchMiss[] {
  if (typeof localStorage === 'undefined') return [];
  const raw = localStorage.getItem(WATCH_MISS_LOG_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as WatchMiss[]) : [];
  } catch {
    return [];
  }
}

/**
 * Persist the miss log (JSON). Never throws — a quota/serialize failure is
 * console.warn'd, matching whatsNew.stampLastSeen / saveUi. The in-memory append
 * already produced the new array (the caller holds it), so a persist failure only
 * means the catch-up won't survive a reload; the current session still surfaces it.
 */
export function saveWatchMissLog(log: WatchMiss[]): void {
  try {
    localStorage.setItem(WATCH_MISS_LOG_KEY, JSON.stringify(log));
  } catch (e) {
    console.warn('[warden:watchCatchup] saveWatchMissLog failed', e);
  }
}

/**
 * Read the ack boundary (epoch-ms). 0 when never acknowledged → every recorded miss
 * is in the away window and surfaces. Mirrors whatsNew.getLastSeen's
 * parseInt-with-guard. Never throws.
 */
export function getWatchSeen(): number {
  if (typeof localStorage === 'undefined') return 0;
  const raw = localStorage.getItem(WATCH_MISS_SEEN_KEY);
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Stamp the ack boundary (epoch-ms). `now` is optional ONLY so tests can pin the
 * clock; production callers omit it. Never throws — quota failure is console.warn'd.
 * Returns the epoch written.
 */
export function stampWatchSeen(now: number = Date.now()): number {
  try {
    localStorage.setItem(WATCH_MISS_SEEN_KEY, String(now));
  } catch (e) {
    console.warn('[warden:watchCatchup] stampWatchSeen failed', e);
  }
  return now;
}

/**
 * Pure: should this fired watch alert be recorded for catch-up? The recording rule
 * for the recovery net (WARDEN-417). Record when EITHER:
 *   - the OS channel LOST the ping (`delivered === false` — Notifications
 *     unsupported, permission denied, or a restrictive webview rejected `new
 *     Notification`), so the catch-up is the ONLY channel that can carry it; OR
 *   - the human is AWAY (`visibilityState === 'hidden'`) — even when the OS DID
 *     deliver, a ping fired while the human is away may yet be cleared / DND'd /
 *     auto-dismissed before they see it (the success criterion's explicit "cleared"
 *     case), so it is recorded to be recoverable on return.
 *
 * A ping the human is PRESENT for (`visibilityState === 'visible'`) AND the OS
 * delivered is NOT recorded — the human saw it, so recording it would only become
 * stale catch-up noise (the success criterion's converse). That is the one
 * combination the catch-up deliberately stays silent on: it is already covered by the
 * live OS toast, so the catch-up has nothing to recover.
 *
 * This is the gate that carries BOTH of the ticket's measurable outcomes — "recover
 * the miss" (record when lost-or-away) and "no stale noise" (don't record when
 * present-and-delivered) — so it is extracted PURE + dependency-free and unit-tested
 * directly (the discipline chatWatch.ts / desktopAlerts.ts follow), rather than
 * living as untested inline logic at the fire site. `delivered` is the boolean
 * fireWatchNotification returns; `visibilityState` is the live
 * document.visibilityState the caller passes in.
 *
 * Scope boundary (deliberate, reconciled with the success criterion): the ONE
 * unrecovered subcase is "walked away from the desk leaving Warden visible & focused
 * AND the OS delivered AND the ping was cleared" — `delivered` is true and
 * `visibilityState` is 'visible', so this returns false and nothing is recorded.
 * Recovering it would require detecting "returned to the desk" with no visibility /
 * focus change, which needs always-on idle detection — forbidden by the roadmap's
 * "no always-on work" constraint. The success criterion is framed around "stepping
 * away" → Warden hidden → "returning" (visibilitychange), which this gate fully
 * covers; the visible-and-walked-away + OS-delivered posture is an accepted,
 * documented limitation, not a regression.
 */
export function shouldRecordMiss(delivered: boolean, visibilityState: string): boolean {
  return !delivered || visibilityState === 'hidden';
}

/**
 * Record a fired watch alert durably: build the miss, append it to the bounded ring
 * buffer, and persist. Called at the watch-ping fire site (useAttentionRollup) AFTER
 * fireWatchNotification returns, ONLY when shouldRecordMiss says to — i.e. when the
 * OS channel lost the ping OR the human is away. The record is written at the same
 * instant the (already-shipped) fire happens; nothing about WARDEN-378's detection or
 * firing changes.
 *
 * Gating the record on shouldRecordMiss (not recording every fire) is what makes the
 * catch-up a false-negative recovery net instead of a duplicate channel: a ping the OS
 * delivered to a PRESENT human is never recorded, so it can never re-surface as stale
 * catch-up noise (the success criterion's converse). A ping the OS LOST, or one fired
 * while AWAY (possibly cleared), IS recorded so it can be recovered on return. Never
 * throws.
 */
export function recordWatchMiss(row: AgentStateRow, reason: WatchReason, now: number = Date.now()): void {
  const log = loadWatchMissLog();
  const next = appendWatchMiss(log, toWatchMiss(row, reason, now));
  saveWatchMissLog(next);
}
