// Pure item-set derivation for the SelectionActionBar's themed right-click menu
// (WARDEN-1826). The menu is a set of ALIASES for the bar's buttons (plus one
// extra, "Copy selected agent names"), so which items exist and in what order is
// decided here — separate from the component — so it can be unit-tested under the
// transpile-to-temp-`.mjs` harness (no React, no runtime imports).
//
// Order is the bar's destructiveness gradient: Select all · Clear selection ·
// Interrupt N… · Watch/Unwatch N · Copy selected agent names, then a separator and
// the destructive Kill N… LAST. Kill never appears without being last/destructive.

export type SelectionBarMenuItemId =
  | 'select-all'
  | 'clear'
  | 'interrupt'
  | 'watch'
  | 'copy-names'
  | 'kill';

export type SelectionBarMenuItem =
  | { kind: 'item'; id: SelectionBarMenuItemId; label: string; destructive?: boolean }
  | { kind: 'separator' };

export function selectionBarMenuItems({ count, hasInterrupt, hasWatch, watchMode, names }: {
  count: number;
  hasInterrupt: boolean;
  hasWatch: boolean;
  watchMode?: 'watch' | 'unwatch';
  names?: readonly string[];
}): SelectionBarMenuItem[] {
  const items: SelectionBarMenuItem[] = [
    { kind: 'item', id: 'select-all', label: 'Select all' },
    { kind: 'item', id: 'clear', label: 'Clear selection' },
  ];
  if (hasInterrupt) items.push({ kind: 'item', id: 'interrupt', label: `Interrupt ${count}…` });
  if (hasWatch) items.push({ kind: 'item', id: 'watch', label: `${watchMode === 'unwatch' ? 'Unwatch' : 'Watch'} ${count}` });
  if ((names ?? []).some((n) => n)) items.push({ kind: 'item', id: 'copy-names', label: 'Copy selected agent names' });
  items.push({ kind: 'separator' });
  items.push({ kind: 'item', id: 'kill', label: `Kill ${count}…`, destructive: true });
  return items;
}
