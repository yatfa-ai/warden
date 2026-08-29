// Pure (React/DOM-free) decision + formatting helpers for the live Activity
// Timeline. Kept side-effect-free and independent of `document` / `Date.now` so
// the cadence + visibility logic is unit-testable today (see
// timelinePacing.test.mjs, run via `npm test`) and stays trivially
// reason-about-able. The hook (useLiveTimeline.ts) consumes these so its
// runtime behavior is literally driven by the tested pure functions.
//
// Background: the cross-host lifecycle events backing this feed are recorded
// server-side roughly every 60s (WARDEN-147); these helpers define how the FE
// exposes that stream as a "live, not frozen" feed (WARDEN-192) — mirroring the
// 30s auto-refresh already given to the agent list in ChatSidebar.tsx.

/** Refresh cadence for the live timeline, in ms. The backend records events
 *  roughly every 60s, so a 15s poll feels live (a new event lands within one
 *  interval) without wasted requests. */
export const POLL_INTERVAL_MS = 15_000;

/**
 * Whether background polling should be active. Polling runs ONLY while the feed
 * is Live AND the tab is visible — frozen when the user hits Pause, and paused
 * while hidden (resumes on focus) to avoid hammering `/api/activity` for a feed
 * nobody is looking at.
 */
export function shouldPoll(isLive: boolean, isVisible: boolean): boolean {
  return isLive && isVisible;
}

/**
 * Whether to fire an *immediate* refresh when document visibility changes.
 * Only when the tab transitions hidden -> visible *while Live*: the user has
 * just returned to a live feed and should see fresh data at once rather than
 * waiting up to POLL_INTERVAL_MS for the next scheduled tick. Staying hidden,
 * going visible -> hidden, or returning while Paused must NOT trigger a fetch.
 */
export function shouldRefreshOnVisibility(
  prevHidden: boolean,
  nextHidden: boolean,
  isLive: boolean,
): boolean {
  return isLive && prevHidden && !nextHidden;
}

/**
 * Dedupe + drop falsy + sort, so a filter menu built from a newest-first feed
 * keeps a stable order across polls instead of following feed recency.
 *
 * Both feeds behind these menus arrive newest-first from the server
 * (`src/activity.js`, `src/observer.js`), and `Set` iteration is insertion
 * order — so an unsorted `Array.from(new Set(...))` renders the options as
 * "whichever host/agent was most recently active", reshuffling them under the
 * user's cursor on every poll. Sorting makes the order a function of the option
 * VALUES rather than of feed recency.
 *
 * Mirrors attentionFilterOptions (attentionRollup.ts:253-256), which already
 * holds this invariant for the Attention tab's equivalent Selects.
 *
 * The `string` return type is load-bearing: Radix `SelectItem` requires a
 * non-empty `string` value, so callers no longer need an `as string[]` cast or
 * an inline `: x is string` type guard to satisfy it.
 */
export function sortedFilterOptions(values: (string | undefined | null)[]): string[] {
  const seen = new Set<string>();
  for (const v of values) {
    // Falsy (undefined / null / '') is not a selectable option — an empty
    // string is also rejected outright by Radix SelectItem.
    if (v) seen.add(v);
  }
  return Array.from(seen).sort((x, y) => x.localeCompare(y));
}

/** The group headers both Observer feeds bucket their rows under. */
export type DayBucket = 'Last hour' | 'Today' | 'Yesterday' | 'This week' | 'Older';

/**
 * Which group header a row belongs under, given its timestamp and the current
 * time (both ms since epoch). Takes `now` explicitly (never reads a clock) so
 * it is testable without time mocks.
 *
 * WHY THIS EXISTS: `Today` and `Yesterday` are CALENDAR-DAY claims, but both
 * feeds used to assign them from elapsed milliseconds alone (`diff < 24h` ->
 * 'Today'). A day boundary is a wall-clock event that a duration cannot see, so
 * the header was wrong for an ordinary fraction of rows every night — at Mon
 * 09:00 a Sun 14:00 event is 19h old and read `Today`, and just after midnight
 * the 24h-wide `Today` bucket held almost nothing but yesterday's events. That
 * is the worst possible failure for the "while I was away" catch-up surface,
 * whose entire job is telling a returning human WHEN things happened.
 *
 * It pairs with `formatAbsolute` (lib/formatTimestamp.ts), which each row's own
 * timestamp renders through: that helper decides "is this today?" by
 * `toDateString()` equality, so the calendar comparisons below use exactly the
 * same test. That alignment IS the fix — it is what makes it impossible for a
 * row to sit under a `Today` heading while its own timestamp reads a past date.
 *
 * `Last hour` stays on elapsed time and is checked FIRST, so a 23:30 -> 00:15
 * event (35 min old, previous calendar day) still reads `Last hour` rather than
 * `Yesterday`. `This week` / `Older` also stay on elapsed time — they are vague
 * enough to remain honest.
 */
export function dayBucket(timestamp: number, now: number): DayBucket {
  const oneHour = 60 * 60 * 1000;
  const oneDay = 24 * oneHour;
  const diff = now - timestamp;

  if (diff < oneHour) return 'Last hour';

  const eventDate = new Date(timestamp).toDateString();
  if (eventDate === new Date(now).toDateString()) return 'Today';

  // Derive yesterday by CALENDAR arithmetic, not by subtracting 24h. A local
  // calendar day is not always 24 hours long — it is 23h on a DST
  // spring-forward day and 25h on fall-back — so `now - 24h` lands on the
  // wrong calendar day around a transition, which is the very elapsed-ms-vs-
  // wall-clock confusion this helper exists to remove. `setDate` walks the
  // calendar and handles variable-length days plus month/year rollover
  // (Mar 1 -> Feb 28) for us.
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (eventDate === yesterday.toDateString()) return 'Yesterday';

  if (diff < 7 * oneDay) return 'This week';
  return 'Older';
}

/**
 * Human label for "how long since the last successful refresh", given the
 * current time and the last update timestamp (both ms since epoch). Returns
 * null when there has been no update yet. Takes `now` explicitly (never reads
 * a clock) so it is testable without time mocks.
 */
export function formatUpdatedAgo(now: number, lastUpdated: number | null): string | null {
  if (lastUpdated == null) return null;
  // Clamp to >= 0 so a clock-skew / out-of-order timestamp can't produce a
  // negative or "NaN" label.
  const secs = Math.max(0, Math.floor((now - lastUpdated) / 1000));
  if (secs < 1) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}
