// Pure decision logic for how a *failed* observer turn is represented in the
// Observer timeline. Extracted from ObserverPanel's failStreamingObserver so the
// retry-affordance failure-mode coverage (the WARDEN-217 gap a reviewer flagged)
// is unit-testable without React/DOM. ObserverPanel remains the single source of
// truth for state; this only decides *what shape* a failure takes.
//
// WARDEN-1163 also makes it the home of the *cause* of a transport failure:
// turning a CloseEvent into a sentence a developer can act on is pure mapping,
// so it lives here where it can be pinned by tests instead of inside the socket
// handler.

// The cause of a failed observer turn, carried from the point it originates to
// both output channels. Before WARDEN-1163 this was a bare `errored: boolean` —
// a boolean is the entire channel capacity, so the reason for a dropped socket
// was destroyed at the moment it occurred.
export interface ObserverFailure {
  // Human-readable cause, rendered in the chat next to the failed turn.
  message: string;
  // Raw diagnostic detail for the DevTools console entry. Absent for failures
  // that carry no transport detail (a backend `error` message, which reports its
  // own real text through the meta line).
  detail?: ObserverFailureDetail;
}

export interface ObserverFailureDetail {
  // Which failure path fired — the socket's `close` event, its (spec-empty)
  // `error` event, or the client-side connection timeout.
  path: 'close' | 'error' | 'timeout';
  // Whether this socket ever reached OPEN: the difference between "never
  // connected" and "dropped mid-generation".
  hadOpened: boolean;
  // WebSocket close code (close path only).
  code?: number;
  // Close-frame reason. Empty for an abnormal closure (1006), which by
  // definition has no close frame — so a bare reason passthrough renders nothing.
  reason?: string;
  // Whether the peer sent a close frame (close path only).
  wasClean?: boolean;
}

// Minimal structural view of a timeline item. ObserverPanel's full Item union is
// structurally compatible (every variant has id + kind; observer entries carry
// streaming/failure), so it is accepted here without importing the union — that
// would drag React/DOM into this module and form a circular graph.
export interface TimelineEntry {
  id: string;
  kind: string;
  streaming?: boolean;
  failure?: ObserverFailure;
}

export type FailObserverDecision =
  | { action: 'mark-streaming'; id: string } // mark the existing streaming turn failed
  | { action: 'synthesize' } // create an empty errored turn as a retry anchor
  | { action: 'none' }; // this turn is already marked failed — do nothing

// Decide how to represent a failed observer turn given the current timeline.
//   - A streaming observer turn is in flight → mark IT failed (the common
//     mid-text drop case; the partial text becomes the retry anchor).
//   - The current turn (the items after the last user message) already has a
//     failed observer → don't stack a second one (e.g. a backend `error` event
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
  if (currentTurn.some((it) => it.kind === 'observer' && it.failure != null)) {
    return { action: 'none' };
  }
  return { action: 'synthesize' };
}

// The fallback cause for a failure whose real text is reported elsewhere: a
// backend `{type:'error'}` message renders its own message as a meta line, so
// the turn itself keeps the wording it has always had rather than duplicating it.
export const GENERIC_OBSERVER_FAILURE: ObserverFailure = { message: 'Generation failed.' };

// WebSocket close codes are a small fixed vocabulary (RFC 6455 §7.4.1). The code
// alone is not legible to a developer reading a chat, and 1006 — the one users
// hit most — carries an EMPTY reason, so printing the reason alone renders
// nothing at all. Map code → meaning so every close explains itself.
const CLOSE_CODE_MEANINGS: Record<number, string> = {
  1000: 'the server closed the connection normally',
  1001: 'the server is going away (shutting down, or the page navigated away)',
  1002: 'the connection was closed on a protocol error',
  1003: 'the server rejected the kind of data it received',
  1005: 'the connection closed without a status code',
  1006: 'abnormal closure — no close frame arrived, so the server is down, unreachable, or the connection was dropped in transit',
  1007: 'the connection was closed on inconsistent payload data',
  1008: 'the server refused the connection on policy grounds (an auth or upgrade check rejected it)',
  1009: 'a message was too large to process',
  1010: 'the server did not negotiate an extension the client required',
  1011: 'the server hit an unexpected error and closed the connection',
  1012: 'the server is restarting',
  1013: 'the server is overloaded — try again shortly',
  1015: 'the TLS handshake failed',
};

// Human-readable meaning of a close code. An unmapped code still names itself
// rather than resolving to a blank clause.
export function describeCloseCode(code: number): string {
  return CLOSE_CODE_MEANINGS[code] ?? `the connection closed with an unrecognised code (${code})`;
}

// Turn a CloseEvent (plus whether the socket had ever opened) into the cause of
// the failure. The highest-value distinction is the first clause: a connection
// that was NEVER ESTABLISHED is a different problem from one that DROPPED
// MID-GENERATION, and the two must never read the same. An abnormal closure
// (1006 — the server-is-down / tunnel-died signature) likewise must not read
// like a clean or policy-driven close, which is why the meaning is spelled out
// rather than the number printed on its own.
export function describeSocketFailure(input: {
  code: number;
  reason?: string;
  wasClean?: boolean;
  hadOpened: boolean;
}): ObserverFailure {
  const { code, hadOpened } = input;
  const reason = (input.reason ?? '').trim();
  const stage = hadOpened
    ? 'Observer connection lost mid-generation'
    : 'Observer connection could not be established';
  const said = reason ? ` — the server said: "${reason}"` : '';
  return {
    message: `${stage}: ${describeCloseCode(code)}${said} (close code ${code}).`,
    detail: {
      path: 'close',
      hadOpened,
      code,
      reason: input.reason ?? '',
      wasClean: input.wasClean ?? false,
    },
  };
}
