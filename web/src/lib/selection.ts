// Pure helpers for multi-select group/section toggles (WARDEN-371 Fleet Health
// batch-kill; the same tri-state pattern any "select all in this group" checkbox
// needs). Pure string-Set logic — no React, no Chat type — so they unit-test
// cleanly under the transpile-to-temp-`.mjs` + dynamic-`import()` harness (see
// selection.test.mjs). The component supplies the ids (the agents currently
// rendered in a section); these helpers decide the checkbox state + the next
// selection set.
//
// `import type`-free at runtime — erased by OXC, so this module loads under the
// same harness as kill.ts / fanout.ts.

/**
 * True when every id in `ids` is in `selected` (and `ids` is non-empty). Drives
 * the checked state of a group's select-all checkbox.
 *
 * (A select-all checkbox here is BOOLEAN — checked only when the whole group is
 * selected — rather than tri-state indeterminate. The shared ui/checkbox renders
 * a checkmark for indeterminate too (no dash variant), which would mislead, so we
 * keep it honest. toggleGroupSelection still does the right thing on click for a
 * partial selection: fill-to-all when not-all-selected, clear when all-selected.)
 */
export function isSelectedAll(selected: Set<string>, ids: string[]): boolean {
  return ids.length > 0 && ids.every((id) => selected.has(id));
}

/**
 * Tri-state group toggle: if every id in `ids` is already selected, DESELECT
 * exactly those ids; otherwise SELECT them all (adding to whatever else is
 * selected — a partial selection becomes full, an empty one becomes full). Never
 * touches ids outside `ids`, so toggling one section never disturbs another.
 *
 * Returns a NEW Set (the input is never mutated), so it composes safely as React
 * state (`setSelectedIds(prev => toggleGroupSelection(prev, ids))`).
 */
export function toggleGroupSelection(selected: Set<string>, ids: string[]): Set<string> {
  const next = new Set(selected);
  if (isSelectedAll(selected, ids)) {
    for (const id of ids) next.delete(id);
  } else {
    for (const id of ids) next.add(id);
  }
  return next;
}
