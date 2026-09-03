/** The per-row "reset to default" affordance (WARDEN-1276).
 *
 *  A small ghost icon-button rendered ONLY on preference rows whose current
 *  value differs from that preference's default — so its visibility doubles as
 *  the VS Code-style "modified" indicator, and a row sitting at its default
 *  carries no extra chrome at all.
 *
 *  It restores exactly ONE preference. The two shipped revert paths are
 *  all-or-nothing (the footer Cancel discards a whole section's draft; the two
 *  Reset-everything buttons take presets/snippets/host labels/watch patterns
 *  with them — the collateral WARDEN-956/957 had to make honest), so this is
 *  the missing middle, not a replacement: `ResetSection` is untouched.
 *
 *  Shape follows the established ghost icon-button row precedent
 *  (SnippetRow's Trash2: `variant="ghost" size="icon-sm"`), so it inherits the
 *  Button focus-visible ring and hover states rather than inventing any — the
 *  WARDEN-68 keyboard/hover checklist is satisfied by construction.
 *
 *  ── No layout shift (WARDEN-68) ──────────────────────────────────────────
 *  The button appears and disappears as the row's value crosses its default,
 *  which on a naive `{differs && <Button/>}` would reflow the row's label line
 *  every time. Instead the slot is ALWAYS rendered at a fixed size and only its
 *  CONTENT is conditional, so the geometry is identical in both states.
 *
 *  ── Sections wire it; it owns no persistence ────────────────────────────
 *  `onRestore` is the section's own write, so each persistence model keeps its
 *  existing path: a client/instant row calls its per-field setter (persistence
 *  rides App's saveUi effect, untouched), and a backend/drafted row writes the
 *  default into the existing draft via setConfig (the footer Save/Cancel
 *  contract, untouched). This component never knows which it is.
 */
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  clientPrefDefault,
  clientPrefDiffersFromDefault,
  configDraftDiffersFromDefault,
  configDraftWithFieldRestored,
  type ConfigFieldPath,
} from '../prefDefaultDiff';
import { type ResettableKey, type ResetUiDefaults } from '@/lib/storage';
import { type ConfigData, type SetConfig } from '../types';

export function ResetToDefaultButton({
  label,
  differs,
  onRestore,
}: {
  /** The row's human label, used verbatim in the accessible name. */
  label: string;
  /** Whether the row's value differs from its default (renders nothing when false). */
  differs: boolean;
  /** Restore this ONE preference to its default. */
  onRestore: () => void;
}) {
  return (
    // Fixed-size slot: reserved whether or not the button is showing, so a row
    // never reflows as its value crosses the default.
    <span className="inline-flex size-7 shrink-0 items-center justify-center align-middle">
      {differs && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-foreground"
          onClick={onRestore}
          aria-label={`Reset ${label} to default`}
          title={`Reset ${label} to default`}
        >
          <RotateCcw />
        </Button>
      )}
    </span>
  );
}

/** The CLIENT/instant wiring of the affordance.
 *
 *  Compares the live pref against `resetUiPrefDefaults()` (the same factory the
 *  shipped bulk reset uses, so the `terminalFontFamily` deviation is inherited
 *  rather than re-derived) and, on activation, writes the default through the
 *  row's OWN existing per-field setter. Persistence rides App's compile-locked
 *  saveUi effect unchanged — no new field, no new boundary, and the change is
 *  instant exactly like typing in the row would be.
 *
 *  Generic over the pref key so `setter` is type-checked against the default it
 *  will be handed: wiring a setter to the wrong key is a compile error. */
export function ClientPrefResetToDefaultButton<K extends ResettableKey>({
  label,
  prefKey,
  value,
  setter,
}: {
  label: string;
  prefKey: K;
  value: ResetUiDefaults[K];
  setter: (v: ResetUiDefaults[K]) => void;
}) {
  return (
    <ResetToDefaultButton
      label={label}
      differs={clientPrefDiffersFromDefault(prefKey, value)}
      onRestore={() => setter(clientPrefDefault(prefKey))}
    />
  );
}

/** The BACKEND/drafted wiring of the affordance, so each of the ~25 config rows
 *  is one element rather than a repeated read-compare-write triple.
 *
 *  Reads the field out of the live draft, compares it against its schema
 *  default, and on activation writes the default back INTO THE DRAFT — the
 *  footer contract is respected exactly as any other edit: the restore appears
 *  as a pending change in the existing `isDirty` state, Save commits it via
 *  PUT /api/config, and Cancel discards it. Nothing is written directly.
 *
 *  Routing the read and the write through the same `path` is the point: a
 *  hand-written pair could compare one field and restore another (the dotted
 *  `llm.*` rows especially), and this makes that unrepresentable. */
export function ConfigResetToDefaultButton({
  label,
  path,
  config,
  setConfig,
}: {
  label: string;
  path: ConfigFieldPath;
  config: ConfigData;
  setConfig: SetConfig;
}) {
  return (
    <ResetToDefaultButton
      label={label}
      differs={configDraftDiffersFromDefault(config, path)}
      onRestore={() => setConfig(configDraftWithFieldRestored(config, path))}
    />
  );
}
