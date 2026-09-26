/** The write-only secret field (WARDEN-1461): the shared render for the three
 *  /api/config secrets — the Observer auth token (WARDEN-350), the telemetry
 *  receiver auth token (WARDEN-569) and the webhook shared secret (WARDEN-970).
 *
 *  The STATE half lives in one place already: `useWriteOnlySecret()` in
 *  `useBackendConfig.ts` (WARDEN-1075/1076). This is the RENDER half those
 *  proposals deferred — until now each section hand-copied the whole block,
 *  which is how the single WARDEN-883 a11y fix (608358a) had to be hand-applied
 *  to all three copies during review.
 *
 *  The block is, in order:
 *  - a `type="password"` Input, empty until the human types (the GET returns
 *    only a masked set + tail, never the secret);
 *  - the 3-way placeholder ternary: the amber pending-clear placeholder /
 *    `••••• set (…tail)` / 'Not set';
 *  - the WARDEN-883 Remove gate (`isSet && !pendingClear`) and its local
 *    ConfirmDialog (destructive; onConfirm removes + closes);
 *  - either the amber pending-clear sentence with Undo, or the muted
 *    saved/not-set hint.
 *
 *  ── Everything that differs stays in the section file ───────────────────
 *  The section keeps its OWN verbatim copy for each divergence: the `id` and
 *  `label` (which MUST be written as string literals in the section file —
 *  web/sectionSearch.test.mjs's rename guard substring-matches the label over
 *  the section source and its anchor guard regex-matches `id="…"` there, so
 *  building either from a variable or hoisting it in here turns those guards
 *  red), the pending-clear `noun` (token/secret), the `savedHint`/`emptyHint`
 *  sentences (six distinct strings across the three sections), the
 *  ConfirmDialog title/description/confirmLabel triple, and the change side
 *  effect (`onInputChange` — Telemetry and Notifications clear their prior
 *  Test-connection verdict on every keystroke; Observer has none).
 *
 *  ── The dialog moves with the field ──────────────────────────────────────
 *  The ConfirmDialog portals (Radix DialogContent), so rendering it from here
 *  instead of the section's outer fragment changes nothing visually. The open
 *  state is owned here; `onRemove`/`onUndo` remain the section's write paths
 *  into `useWriteOnlySecret`, so the state half is untouched.
 */
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

export interface WriteOnlySecretFieldProps {
  /** The input's DOM id. MUST be a string literal at the call site in the
   *  section file — the anchor guard reads the section SOURCE. */
  id: string;
  /** The row's visible label. MUST be a string literal at the call site in
   *  the section file — the rename guard reads the section SOURCE. */
  label: string;
  /** The noun in the pending-clear sentence ("token" / "secret"). */
  noun: string;
  /** Whether a secret is stored (the masked GET's `*Set` boolean). */
  isSet: boolean;
  /** The masked last-N tail from the GET, or null. */
  tail: string | null;
  /** The current draft input value. */
  input: string;
  /** Called on every keystroke with the new value. The section's own closure
   *  keeps its side effects (the Telemetry/Notifications verdict clears). */
  onInputChange: (v: string) => void;
  /** Whether a removal is queued (pendingClear): the input shows the amber
   *  pending-clear placeholder and the hint swaps to Undo. */
  pendingClear: boolean;
  /** Queue the clear — fired by the ConfirmDialog's confirm. */
  onRemove: () => void;
  /** Cancel a queued clear (the Undo link). */
  onUndo: () => void;
  /** The saved-hint sentence, as a function of the tail so each section keeps
   *  its own verbatim copy (the tail may be null). */
  savedHint: (tail: string | null) => string;
  /** The not-set hint sentence. */
  emptyHint: string;
  /** ConfirmDialog strings — verbatim per section. */
  confirmTitle: string;
  confirmDescription: string;
  confirmLabel: string;
}

export function WriteOnlySecretField({
  id,
  label,
  noun,
  isSet,
  tail,
  input,
  onInputChange,
  pendingClear,
  onRemove,
  onUndo,
  savedHint,
  emptyHint,
  confirmTitle,
  confirmDescription,
  confirmLabel,
}: WriteOnlySecretFieldProps) {
  // WARDEN-883 — confirm the irreversible secret removal (cleartext is deleted;
  // the consumer falls back to env / config-file credentials). Always gated by
  // the confirm, matching the Reset section's stance that reverting credentials
  // is worth the friction regardless of the kill-confirm toggle.
  const [confirmRemoveOpen, setConfirmRemoveOpen] = useState(false);
  return (
    <>
      <div className="flex flex-col gap-2">
        <Label htmlFor={id}>{label}</Label>
        <div className="flex items-center gap-2">
          <Input
            id={id}
            type="password"
            className="flex-1"
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            placeholder={
              pendingClear
                ? 'Will be removed on Save'
                : isSet
                  ? `••••• set${tail ? ` (…${tail})` : ''}`
                  : 'Not set'
            }
          />
          {/* WARDEN-883 — Remove surfaces only when a secret is stored and not
              already queued for removal. The confirm dialog gates the click. */}
          {isSet && !pendingClear && (
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => setConfirmRemoveOpen(true)}
            >
              Remove
            </Button>
          )}
        </div>
        {pendingClear ? (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            The saved {noun} will be removed when you press Save.{' '}
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0 align-baseline"
              onClick={onUndo}
            >
              Undo
            </Button>
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {isSet ? savedHint(tail) : emptyHint}
          </p>
        )}
      </div>
      {/* WARDEN-883 — confirm the secret removal before queueing the clear. */}
      <ConfirmDialog
        open={confirmRemoveOpen}
        onOpenChange={(o) => { if (!o) setConfirmRemoveOpen(false); }}
        title={confirmTitle}
        description={confirmDescription}
        confirmLabel={confirmLabel}
        destructive
        onConfirm={() => { onRemove(); setConfirmRemoveOpen(false); }}
      />
    </>
  );
}
