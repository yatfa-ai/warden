// WARDEN-332 — pure lifecycle decisions for the observer tab manager.
//
// Two preference-driven behaviors shipped dead in Settings (pre-WARDEN-332):
// "Auto-start Observer" (spawn+open a bound observer session for the focused
// chat) and "Session Auto-stop" (close an observer tab idle past N minutes).
// Both were persisted correctly (server.js get/set + config.js DEFAULTS) but,
// until this module, had ZERO behavioral consumers — the entire task was on the
// apply-side (renderer). This file is the extraction that wired them: the
// decision cores are pure functions of (sessions/state, time); only the side
// effects (createNew / closeTab) live in ObserverTabs. Extracting them here
// makes them unit-testable under `node --test` (transpiled TS -> ESM via Vite's
// OXC transform — same harness as observerTurns.test.mjs, WARDEN-130).
//
// Activity model (documented): a session counts as "active" while it receives
// incoming observer WS events (token streams, tool calls, gate prompts, …).
// ObserverPanel bumps the timestamp per session from its ws.onmessage; the tab
// is also seeded with a timestamp when opened. Bumping on every render would be
// wrong — a passive tab must age out. See ObserverTabs.tsx for the wiring.

import type { SessionMeta } from '@/lib/types';

/** One minute, in ms — the idle-tick granularity. Sub-minute precision is not
 *  required for a minutes-scale timeout; the periodic close check runs on this
 *  cadence. Exported so the component's interval and tests share one constant. */
export const IDLE_TICK_MS = 60_000;

/**
 * Behavior 1 — auto-start dedup (the correctness half).
 *
 * "Auto-start Observer" must spawn AT MOST ONE observer session for a given
 * focused chat. The component guards re-triggering per-key (an "already
 * attempted" Set), but that alone cannot detect a binding that already existed
 * before auto-start was enabled (e.g. the user manually clicked "observe" on a
 * chat, then later toggled auto-start on and re-focused it). This is the
 * guarantee against that duplicate: returns true iff some session in `sessions`
 * is already bound to `chatKey`. A null/empty key never matches (nothing to
 * bind).
 */
export function hasBoundSession(
  sessions: SessionMeta[],
  chatKey: string | null | undefined,
): boolean {
  if (!chatKey) return false;
  return sessions.some((s) => s.chatKey === chatKey);
}

/**
 * Behavior 2 — auto-stop selection.
 *
 * Given the open tab ids, their last-activity timestamps (ms since epoch), a
 * timeout in MINUTES, and the current time (ms), returns the ids whose activity
 * is strictly older than the timeout. `timeoutMinutes == null` (the user cleared
 * the field) disables auto-stop entirely → returns []. A tab with no recorded
 * timestamp is treated as active (never closed): closing requires a known-stale
 * signal, and the caller seeds every open id with a timestamp, so a missing one
 * is an edge we fail-safe rather than aggressively reap.
 */
export function selectIdleTabs(
  openIds: string[],
  lastActivity: Record<string, number>,
  timeoutMinutes: number | null | undefined,
  nowMs: number,
): string[] {
  if (timeoutMinutes == null || timeoutMinutes <= 0) return [];
  const cutoff = nowMs - timeoutMinutes * 60_000; // timeoutMinutes is in minutes
  return openIds.filter((id) => {
    const ts = lastActivity[id];
    return ts != null && Number.isFinite(ts) && ts < cutoff;
  });
}
