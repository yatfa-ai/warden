// Pin-state helpers for the sidebar's pinned-chat persistence (WARDEN-1240).
//
// The /api/pins PUT replaces the stored list wholesale, so the client must (a)
// never mistake a failed/error-bodied load for "no pins" — otherwise the next
// pin write wipes every stored pin — and (b) never build a pin array from stale
// snapshot state when several toggles land quickly. These pure functions make
// both rules testable; the fetch wiring that uses them lives in ChatSidebar.

/** Parse a GET /api/pins response body into a pin set, or null if it is not a
 *  trustworthy pin list (non-ok status, error body, or a non-array `pins`).
 *  Callers must treat null as "unknown", never as "empty". */
export function parseLoadedPins(body: unknown): Set<string> | null {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { pins?: unknown }).pins)) {
    return null;
  }
  const pins = (body as { pins: unknown[] }).pins.filter(
    (p): p is string => typeof p === 'string' && p.length > 0,
  );
  return new Set(pins);
}

/** Compute the next pin set for toggling `chatId` off `current`. Pure: returns
 *  a new Set, never mutates. Toggle requests are serialized against this ref
 *  view of the state, not the React snapshot, so a burst of rapid clicks each
 *  build on the previous request's result instead of all on the same snapshot. */
export function nextPins(current: Set<string>, chatId: string): Set<string> {
  const next = new Set(current);
  if (next.has(chatId)) next.delete(chatId);
  else next.add(chatId);
  return next;
}
