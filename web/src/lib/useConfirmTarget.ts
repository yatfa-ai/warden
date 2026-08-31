// useConfirmTarget — the pending-target confirmation state machine shared by the
// three App.tsx ConfirmDialogs (force-kill / kill-chat / close-workspace),
// WARDEN-1239.
//
// All three are the same machine: hold a target id in state, run an action on
// confirm, clear the target on cancel. Before this hook that machine was
// hand-copied 3x — the confirm/cancel legs of the force-kill and kill-chat
// copies were byte-identical once identifiers were normalised (a MANUAL
// convergence: 90f0f1f rewrote the force-kill legs to match kill's), while the
// close-workspace copy differed only in that its action is synchronous and its
// cancel was a one-line arrow. Hand-copied machines drift; the third copy was
// literally born ungated because it had no shared function to inherit the gate
// from (5be7147 added its target with no confirmDestructiveActions consult).
//
// WHY A HOOK, NOT A <ConfirmDialog> WRAPPER (same reasoning as useAsyncConfirm,
// WARDEN-1017): web/dialogMaxWidth.test.mjs is a STATIC SOURCE SCANNER over every
// <DialogContent> call site under web/src with anti-silently-empty-scan floors.
// App.tsx routes all three dialogs through the shared <ConfirmDialog> component
// (zero raw <DialogContent> in App.tsx), and this extraction changes no JSX —
// the three <ConfirmDialog> tags and their props stay byte-identical.
//
// THE GATE IS A PER-CALLER PREDICATE, DELIBERATELY. Two of the three machines
// consult the "Confirm before destructive actions" preference (force-kill,
// kill-chat); the close-workspace machine does not, because closing a workspace
// only removes its panes from the grid — the chats stay in the sidebar catalog
// and can be reopened, so it is not destructive and was never meant to be gated.
// Omitting the predicate keeps that asymmetry structural instead of normalising
// it away: a gated caller must say what it consults, and an ungated caller
// visibly passes nothing (WARDEN-1239 rules this out of scope — do not "fix").
//
// NON-MEMBER: useAsyncConfirm (also in this directory). That one drives the
// fleet dialogs' BUSY/DISMISSAL machine (spinner, block Esc mid-flight); this
// hook drives the pending-TARGET machine (which id, confirm vs cancel). A
// dialog needs one or the other, not both.
import { useCallback, useState } from 'react';

export interface ConfirmTarget {
  /** The pending target id, or null while the dialog is closed. */
  target: string | null;
  /**
   * Request the action on `id`. With a predicate: opens the dialog when it
   * returns true, fires the action immediately when false (the power-user
   * opt-out). Without one: always opens the dialog — the action can then only
   * be reached via `confirm`.
   */
  request: (id: string) => void;
  /** Pass as `<ConfirmDialog onConfirm>`: clears the target, then acts on it. */
  confirm: () => void;
  /** Pass as `<ConfirmDialog onOpenChange>`-dismissal: clears the target only. */
  cancel: () => void;
}

export function useConfirmTarget(
  /**
   * The action to run on confirm (or immediately when the predicate opts out).
   * Sync for close-workspace, async fire-and-forget for the two kill paths —
   * both fit `void action(id)`, which discards a promise and is a no-op around
   * a void return.
   */
  action: (id: string) => void | Promise<unknown>,
  /** Per-caller gate. Pass one ONLY when the action is destructive; omit it
   *  when the dialog is unconditional. See the header before "normalising". */
  shouldConfirm?: () => boolean,
): ConfirmTarget {
  const [target, setTarget] = useState<string | null>(null);

  // The gate leg. A missing predicate is the ungated machine: request === open.
  const request = useCallback((id: string) => {
    if (shouldConfirm === undefined || shouldConfirm()) setTarget(id);
    else void action(id);
  }, [action, shouldConfirm]);

  // The confirm leg — byte-for-byte the machine all three copies ran: snapshot
  // the target, clear it, then act on the snapshot. Clearing BEFORE acting is
  // observable: the dialog must close even if the action throws synchronously,
  // and no later re-render can resurrect the id.
  const confirm = useCallback(() => {
    const id = target;
    setTarget(null);
    if (id) void action(id);
  }, [target, action]);

  // The cancel leg. Empty deps, stable identity — same as every hand-written
  // copy, so downstream identity comparisons change nothing.
  const cancel = useCallback(() => setTarget(null), []);

  return { target, request, confirm, cancel };
}
