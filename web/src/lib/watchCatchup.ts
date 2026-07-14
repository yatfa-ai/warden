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
// This module records those fired-WHILE-AWAY alerts into a BOUNDED client-side log
// and exposes the pure logic that turns them into a reason-specific, deep-linking
// catch-up surfaced on the human's RETURN — recovering what the OS channel lost,
// WITHOUT firing a new OS notification. Its job is to be the safety net under the
// OS channel, not a second channel.
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
// unbounded in localStorage across a long session. 50 is generous (one away
// session rarely produces more than a handful) yet cheap to serialize, and it is
// only ever written while the human is away (see recordWatchMiss's caller gate).
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
  return {
    key: row.key || row.id || '',
    name: row.name || row.key || row.id || '',
    reason,
    signal: row.signal || undefined,
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

/**
 * Pure: the unacknowledged away misses — the log filtered to the away window
 * (`firedAt >= since`), deduped to the NEWEST miss per chat key, newest-first.
 * This is the list the catch-up surface renders.
 *
 * Dedup-by-newest (not oldest) means a chat that flapped (e.g. fired waiting, then
 * later erroring, while you were away) surfaces ONCE with its latest, most
 * actionable reason — never two rows for one chat. Newest-first ordering puts the
 * most-recent need at the top of the catch-up.
 */
export function awayMisses(log: WatchMiss[], since: number): WatchMiss[] {
  const inWindow = log.filter((m) => inAwayWindow(m, since));
  // Newest per key: walk in log order (oldest→newest), overwriting, so the LAST
  // entry seen for a key wins (the newest).
  const byKey = new Map<string, WatchMiss>();
  for (const m of inWindow) byKey.set(m.key, m);
  return Array.from(byKey.values()).sort((a, b) => b.firedAt - a.firedAt);
}

// Reason → human phrasing for the catch-up line. Mirrors desktopAlerts'
// WATCH_REASON_LABEL (desktopAlerts.ts) so the in-app catch-up reads identically to
// the lost OS notification's body — the catch-up is the in-app twin of the ping.
const WATCH_MISS_REASON_LABEL: Record<WatchReason, string> = {
  waiting: 'waiting for your input',
  erroring: 'erroring',
  stuck: 'stuck (repeating output)',
  completed: 'finished a task',
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
 * Record a fired-WHILE-AWAY watch alert durably: build the miss, append it to the
 * bounded ring buffer, and persist. Called at the watch-ping fire site
 * (useAttentionRollup) ALONGSIDE fireWatchNotification — the record is written at
 * the same instant the (already-shipped) fire happens; nothing about WARDEN-378's
 * detection or firing changes.
 *
 * The caller gates this on the human being AWAY (document.visibilityState ===
 * 'hidden'): a ping the human is present for is already covered by the live
 * AttentionBadge + the OS notification, so recording it would only become stale
 * catch-up noise (the success criterion's converse case). Recording ONLY the
 * away-case pings is what makes the catch-up a false-negative recovery net instead
 * of a duplicate channel. Never throws.
 */
export function recordWatchMiss(row: AgentStateRow, reason: WatchReason, now: number = Date.now()): void {
  const log = loadWatchMissLog();
  const next = appendWatchMiss(log, toWatchMiss(row, reason, now));
  saveWatchMissLog(next);
}
