// Pure helpers behind the inline quick-reply affordance on the attention surfaces
// (WARDEN-770): the AttentionBadge popover's waiting/blocked rows, the return-banner
// callout, and the WatchCatchup rows.
//
// WARDEN-770 closes the "last mile" of the human-in-the-loop: every attention surface
// already ROUTES the human to a needy agent (detection is exhaustively built), but
// none could actually RESPOND — every action was a deep-link into the pane. These
// helpers decide WHICH agents are replyable and gate the send, so the human can answer
// a "press enter" / "needs approval" agent from the surface that surfaced it, with zero
// pane/workspace switches.
//
// Scope discipline (from the WARDEN-770 proposal): only the two states that resolve
// with a short one-line human input get the affordance — `waiting` (parked at a
// human-input prompt) and `blocked` (waiting on approval/dependency). `stuck` /
// `erroring` / `custom` need INSPECTION, not a one-liner, so they stay open-pane-only.
//
// DISCIPLINE (mirrors attentionRollup.ts / watchCatchup.ts): pure + dependency-free —
// only `import type` (erased at transpile) — so quickReply.test.mjs loads the REAL
// module standalone via Vite's OXC transform and exercises these rules with plain
// inputs. The actual network send (POST /api/send {id,text} and POST /api/key {id,key}
// via the shared postJson helper) lives in the QuickReply component, NOT here —
// keeping it out is what lets this module load import-free under the test harness.
import type { Snippet } from '@/lib/storage';

/** The pane states that resolve with a short human input and so earn the inline
 *  quick-reply affordance. Kept as a Set so `canReply` is O(1) and the membership is
 *  declarations in one place (add a state here and every surface picks it up). */
const REPLYABLE_STATES: ReadonlySet<string> = new Set(['waiting', 'blocked']);

/**
 * Whether an attention item in `state` should show the inline quick-reply control.
 *
 * The gating decision for all three WARDEN-770 surfaces:
 *  - AttentionBadge popover rows — passed `replyable` explicitly from the waiting +
 *    blocked Sections (the section IS the state, so the call site knows).
 *  - Return-banner callout — called with `attentionTop.state` (a ranked AttentionItem
 *    can be any state; only waiting/blocked earn the reply affordance).
 *  - WatchCatchup rows — called with the miss's `reason` (a WatchReason, which is a
 *    string subtype, so it flows through unchanged).
 *
 * Pure + total: every other state (stuck/erroring/critical/warning/custom/idle/…)
 * returns false, and an empty/unknown state returns false rather than throwing — so a
 * future state or a malformed row degrades to open-pane-only (today's behavior), never
 * to a broken reply control on a state that can't be answered with a one-liner.
 */
export function canReply(state: string): boolean {
  return REPLYABLE_STATES.has(state);
}

/**
 * The reply text that should actually be sent, or `null` when there is nothing to send.
 *
 * Trims surrounding whitespace (a trailing newline from the textarea, leading spaces
 * from a paste) and returns `null` for an empty OR whitespace-only input — so a blank
 * textarea or an accidental space-bar press can NEVER reach /api/send. This is the pure
 * core of the WARDEN-292 confirm gate (mirrored from BroadcastDialog): nothing is sent
 * until the human confirms with non-empty content. `canSendReply` composes this with the
 * in-flight `sending` flag.
 *
 * Returns the TRIMMED text (not the raw input) so /api/send receives exactly what the
 * human meant, without a trailing newline that tmux send-keys would turn into a stray
 * extra Enter.
 */
export function sanitizeReplyText(text: string): string | null {
  const trimmed = (text ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The confirm-gate predicate for the reply Send button: true only when there is real
 * (non-whitespace) text to send AND no send is already in flight.
 *
 * Composes `sanitizeReplyText` (the empty/whitespace guard) with the `sending` flag
 * (the double-send guard), matching BroadcastDialog's `canSend = count > 0 &&
 * trimmed.length > 0 && !sending` (WARDEN-292) — adapted to the single-target reply
 * (no recipient count; the target is the one row the affordance hangs off). Pure so the
 * gate's contract is unit-tested directly: empty → false, whitespace → false, sending →
 * false, only real-text-while-idle → true.
 *
 * Note: this gates the TYPED-TEXT Send path. The "↵ Continue" press-Enter quick-action
 * (POST /api/key {key:'Enter'}) is a deliberately one-click action — the click itself is
 * the explicit confirm gesture (mirrors PaneTile.sendSnippet, the single-target one-click
 * send with no confirm step) — so it does not route through this predicate.
 */
export function canSendReply({ text, sending }: { text: string; sending: boolean }): boolean {
  return !sending && sanitizeReplyText(text) !== null;
}

/**
 * The maximum number of snippets shown as one-click fill chips inside the compact reply
 * control. The ticket names "the top of the existing snippets library" as the quick-reply
 * row: a flat list of every saved snippet would overflow the narrow (w-72) popover, so
 * only the first few are surfaced as chips. Picking a chip INSERTS its text into the
 * textarea (insert-only — it does NOT auto-send; the WARDEN-292 confirm gate still
 * governs), mirroring BroadcastDialog's snippet picker. Centralized here so every reply
 * surface shows the same slice of the library.
 */
export const QUICK_REPLY_SNIPPET_PREVIEW = 4;

/**
 * The slice of the snippet library shown as one-click fills in the reply control (the
 * first `QUICK_REPLY_SNIPPET_PREVIEW`, in library order). Pure + defensive against a null
 * list (degrades to empty — the chip row hides). Kept here so the "which snippets show"
 * rule is testable alongside the gating predicates, not buried in the component.
 */
export function replySnippetPreview(snippets: Snippet[] | null | undefined): Snippet[] {
  const list = Array.isArray(snippets) ? snippets : [];
  return list.slice(0, QUICK_REPLY_SNIPPET_PREVIEW);
}
