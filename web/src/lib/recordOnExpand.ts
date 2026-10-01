// Pure core of useRecordOnExpand (WARDEN-1494).
//
// WHY THIS EXISTS: the `panel-expand-sidebar` / `panel-expand-observer`
// feature-usage capabilities were recorded INLINE on the header buttons only,
// so every other path that expands the same panel (Alt+S / Alt+O via
// PaneGrid's onToggleSidebar/onToggleObserver, `openActivityTab` from the
// attention banner/badge) contributed nothing and biased the adoption count.
// The single seam that every path shares is the STATE TRANSITION itself:
// collapsed true -> false. This module is the arithmetic over that edge.
//
// Deliberately dependency-free (no React import, no sampler import) so the
// repo's `node --test` suite can load it directly — see
// web/recordOnExpand.test.mjs.

/** True exactly on the expand edge (collapsed true -> false). Mount, the
 *  collapse direction and no-change all return false. */
export function isExpandTransition(prev: boolean, next: boolean): boolean {
  return prev === true && next === false;
}

/**
 * Evaluate one observation of the collapsed flag: records through `record`
 * only on the expand edge, and returns the value to keep as the new `prev`.
 */
export function observeCollapsed(
  prev: boolean,
  next: boolean,
  record: () => void,
): boolean {
  if (isExpandTransition(prev, next)) record();
  return next;
}
