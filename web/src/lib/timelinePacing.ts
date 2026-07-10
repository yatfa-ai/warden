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
