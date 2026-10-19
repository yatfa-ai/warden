// Pure item-set derivation for the themed right-click edit menu on free-text
// reply boxes (WARDEN-1830): Cut · Copy · Paste · separator · Select all.
// Electron ships no default context menu, so a right-click inside a typed-input
// box was silent. Which items exist, their order and which are disabled is decided
// here — separate from the component — so it can be unit-tested under the
// transpile-to-temp-`.mjs` harness (no React, no runtime imports).
//
// Rules:
//  - Cut / Copy need a non-empty selection.
//  - Cut / Paste mutate, so they are disabled for a readOnly field.
//  - A `disabled` field gets NO menu at all (empty list): it cannot be focused or
//    edited, so there is nothing for an edit menu to act on.

export type EditMenuItemId = 'cut' | 'copy' | 'paste' | 'select-all';

export type EditMenuItem =
  | { kind: 'item'; id: EditMenuItemId; label: string; disabled: boolean }
  | { kind: 'separator' };

export function editMenuItems({ hasSelection, readOnly, disabled, numberValue }: {
  hasSelection: boolean;
  readOnly?: boolean;
  disabled?: boolean;
  // WARDEN-1864 — the number-safe variant: a <input type="number"> child exposes
  // NO readable internal selection (selectionStart is null), so a mount on one
  // passes `numberValue: el.value` instead and enablement keys on the VALUE
  // (empty value → Cut and Copy disabled) rather than on a selection that can
  // never be read. Omitted (the default) = the text-mount semantics above.
  numberValue?: string;
}): EditMenuItem[] {
  if (disabled) return [];
  const hasContent = numberValue === undefined ? hasSelection : numberValue !== '';
  return [
    { kind: 'item', id: 'cut', label: 'Cut', disabled: !hasContent || !!readOnly },
    { kind: 'item', id: 'copy', label: 'Copy', disabled: !hasContent },
    { kind: 'item', id: 'paste', label: 'Paste', disabled: !!readOnly },
    { kind: 'separator' },
    { kind: 'item', id: 'select-all', label: 'Select all', disabled: false },
  ];
}

/** The selected slice of a field's value (selectionStart/End may arrive in either order). */
export function selectedText(value: string, start: number | null | undefined, end: number | null | undefined): string {
  const s = Math.min(start ?? 0, end ?? 0);
  const e = Math.max(start ?? 0, end ?? 0);
  return value.slice(s, e);
}
