// useAsyncConfirm — the async-confirm state machine shared by the fleet-action
// dialogs (BroadcastDialog / KeySendDialog / KillDialog), WARDEN-1017.
//
// All three are the same machine: a `busy` flag, a reset-on-open, a guarded
// try/finally confirm that closes on resolve, and a dismissal guard that blocks
// Esc/overlay close while the fan-out is in flight. Before this hook that machine
// was hand-copied 3x — the confirm bodies were byte-identical modulo one comment
// word, and the dismissal guard was verbatim in all three.
//
// WHY IT IS EXTRACTED (not a tidiness claim): commit 66658c9 (WARDEN-735) fixed a
// user-visible defect born of exactly this copy-paste — the WARDEN-490 friendly
// host labels reached only 2 of 4 hand-copies, so the other two shipped raw SSH
// hostnames. Extraction was the chosen remedy there, but it lifted only the target
// LIST; this finishes the other half. The part that is now identical by
// construction is the one governing whether a destructive fan-out can be dismissed
// mid-flight — the piece where a silent per-dialog drift is most costly.
//
// WHY A HOOK, NOT A <ConfirmDialogShell> WRAPPER: web/dialogMaxWidth.test.mjs is a
// STATIC SOURCE SCANNER over every `<DialogContent>` call site under web/src, and
// it asserts class-wide invariants plus explicit anti-silently-empty-scan floors
// (>= 5 call sites; at least one prefixed `max-w-*`; at least one overriding the
// base `grid` display). A wrapper component would swallow three `<DialogContent>`
// tags and their `sm:max-w-md` classes out of the scanned caller files, weakening
// those scans. A hook touches ZERO JSX, so every invariant is provably unaffected.
//
// NON-MEMBER: SnoozeDialog. Its `onSnooze` returns void and its handler is
// synchronous — it has no busy state and no dismissal guard by design. Folding it
// in would invent a loading state for an operation that cannot be in flight.
import { useEffect, useState } from 'react';

export interface AsyncConfirm {
  /** True while a confirm action is in flight. Drives spinners + `disabled`. */
  busy: boolean;
  /**
   * The guarded confirm body. No-ops unless `enabled` (each dialog keeps its own
   * `canX` predicate — Broadcast's also requires non-empty text). Otherwise marks
   * busy, awaits `action`, and closes the dialog on resolve.
   *
   * `action` is expected to RESOLVE rather than reject even on partial failure:
   * every caller fans out with Promise.allSettled and encodes per-target failure
   * in a summary the parent has already toasted by the time it resolves. The
   * `finally` is nevertheless real — it restores the button if that ever changes.
   */
  run: (action: () => Promise<unknown>, enabled: boolean) => Promise<void>;
  /** Pass as `<Dialog onOpenChange>` — blocks dismissal ONLY while busy. */
  guardOpenChange: (open: boolean) => void;
}

/**
 * Async-confirm state for a dialog driven by `open` / `onOpenChange` props.
 *
 * Takes `onOpenChange` (the ticket's sketch threaded a separate `close` argument
 * through every `run` call): closing on resolve and guarding dismissal are two
 * uses of the SAME prop, so binding it once here is what stops the two from
 * drifting apart at a call site — the whole point of the extraction.
 *
 * The reset-on-open is deliberately scoped to `busy` only. BroadcastDialog and
 * KeySendDialog keep their own `[open]` effects for their extra fields (msg /
 * picked / key); two effects on the same dep are fine — they touch disjoint
 * state, so ordering is irrelevant. KillDialog reset nothing else, so its effect
 * is fully absorbed.
 */
export function useAsyncConfirm(
  open: boolean,
  onOpenChange: (open: boolean) => void,
): AsyncConfirm {
  const [busy, setBusy] = useState(false);

  // Start every open fresh: a previous attempt's spinner must not linger.
  useEffect(() => {
    if (open) setBusy(false);
  }, [open]);

  const run = async (action: () => Promise<unknown>, enabled: boolean) => {
    if (!enabled) return;
    setBusy(true);
    try {
      await action();
      onOpenChange(false);
    } finally {
      // Runs AFTER the close request, and that ordering is observable: the
      // component stays mounted across the close, so this restores the footer
      // button to its idle label rather than leaving a spinner behind. Do not
      // "simplify" it into the try block.
      setBusy(false);
    }
  };

  const guardOpenChange = (next: boolean) => {
    if (!busy) onOpenChange(next);
  };

  return { busy, run, guardOpenChange };
}
