import type { Chat } from '@/lib/types';

/**
 * The host key for a pane — its resolved host (the chat's host wins, e.g.
 * 'myserver' or '(local)', falling back to the restore hint (`host` prop) then
 * '(local)').
 *
 * SEND-TIME / RENDER-TIME value only — it must NEVER appear in the attach
 * effect's dependency array. `chat` is supplied by the parent grid via
 * `chats.find((c) => (c.key || c.id) === t.id)`, which transiently returns
 * `undefined` during catalog refreshes, workspace switches, and mid-spawn. When
 * `chat` is momentarily absent the fallback engages and, for a remote pane whose
 * `chat.host` (e.g. 'myserver') disagrees with `paneHost[id]` (unset or stale),
 * `hostKey` flips between values across renders. In 0.1.11 `hostKey` sat in the
 * attach effect's deps, so each flip re-fired the effect: cleanup sent `detach`,
 * the body sent a fresh `attach`, and the backend bound a SECOND live PTY to the
 * same xterm → duplicated text, jumping/flicker, dropped lines (WARDEN-365).
 * Read it via a ref at send-time instead.
 */
export function hostKeyOf(chat: Chat | null | undefined, host: string | undefined): string {
  return chat?.host || host || '(local)';
}

/**
 * The inputs the attach effect has at render time. Split into TRIGGER values
 * (returned by {@link attachEffectDeps} — a change re-binds the live PTY) and
 * SEND-TIME values (read via refs inside the effect body — a change must NOT
 * re-bind). Declaring both in one type makes the gap between them — the whole
 * of the WARDEN-365 fix — explicit and unit-testable.
 */
export interface AttachTriggerInputs {
  /** Stable, unique pane identity — the primary re-attach trigger. */
  id: string;
  /** Bumped by Retry / Re-spawn — the explicit re-attach trigger. */
  retryNonce: number;
  /**
   * `paneHost[id]`. A SEND-TIME input (read via `hostRef`), NOT a trigger.
   * Accepted here only so the component can hand over its full render context
   * and the regression test can prove a change here does NOT re-attach.
   * Predates the 0.1.11 breakage as a latent mount-race; dropping it from the
   * deps fixes that in the same stroke. (WARDEN-365.)
   */
  host?: string;
  /**
   * The pane's resolved host key ({@link hostKeyOf}). A SEND-TIME input (read via
   * a ref), NOT a trigger. Accepted here so the test can prove the 0.1.11
   * regression — `hostKey` flipping on a transient `chats.find()` miss — no
   * longer re-attaches a live pane (WARDEN-365).
   */
  hostKey: string;
}

/**
 * The attach effect's dependency tuple — the values that, when changed,
 * legitimately require a tear-down + re-bind of the live PTY (WARDEN-365).
 *
 * Intentionally returns ONLY `[id, retryNonce]`. `host` and `hostKey` are
 * accepted on the input (see {@link AttachTriggerInputs}) precisely so this
 * function can prove — in code, and under test — that they are deliberately
 * NOT triggers: varying them must not change the returned tuple. The component
 * routes its `useEffect` deps through this function, so the "single attach per
 * pane lifetime" contract lives in exactly one place and cannot be silently
 * re-widened by an inline edit.
 *
 * Re-adding `host` / `hostKey` to the returned tuple
 * re-introduces the 0.1.11 regression — do not.
 */
export function attachEffectDeps(inputs: AttachTriggerInputs): readonly [string, number] {
  return [inputs.id, inputs.retryNonce];
}
