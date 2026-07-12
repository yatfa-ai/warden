// Pure decision logic for how a *failed* observer turn is represented in the
// Observer timeline. Extracted from ObserverPanel's failStreamingObserver so the
// retry-affordance failure-mode coverage (the WARDEN-217 gap a reviewer flagged)
// is unit-testable without React/DOM. ObserverPanel remains the single source of
// truth for state; this only decides *what shape* a failure takes.

// Minimal structural view of a timeline item. ObserverPanel's full Item union is
// structurally compatible (every variant has id + kind; observer entries carry
// streaming/errored), so it is accepted here without importing the union — that
// would drag React/DOM into this module and form a circular graph.
export interface TimelineEntry {
  id: string;
  kind: string;
  streaming?: boolean;
  errored?: boolean;
}

export type FailObserverDecision =
  | { action: 'mark-streaming'; id: string } // mark the existing streaming turn failed
  | { action: 'synthesize' } // create an empty errored turn as a retry anchor
  | { action: 'none' }; // this turn is already marked failed — do nothing

// Decide how to represent a failed observer turn given the current timeline.
//   - A streaming observer turn is in flight → mark IT failed (the common
//     mid-text drop case; the partial text becomes the retry anchor).
//   - The current turn (the items after the last user message) already has an
//     errored observer → don't stack a second one (e.g. a backend `error` event
//     followed by a socket close both route through here).
//   - Otherwise the turn failed before any observer text existed — a backend
//     error during the "thinking" phase, or a dropped stream before the first
//     token. Synthesize an empty errored turn so a retry affordance surfaces
//     instead of the turn vanishing with no recourse (the gap WARDEN-217 fixes).
export function decideFailObserverTurn(items: TimelineEntry[]): FailObserverDecision {
  const last = items[items.length - 1];
  if (last && last.kind === 'observer' && last.streaming) {
    return { action: 'mark-streaming', id: last.id };
  }
  let lastUserIdx = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  const currentTurn = lastUserIdx >= 0 ? items.slice(lastUserIdx + 1) : items;
  if (currentTurn.some((it) => it.kind === 'observer' && it.errored)) {
    return { action: 'none' };
  }
  return { action: 'synthesize' };
}
