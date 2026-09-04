// Pointing Settings search AT the matched row (WARDEN-1290).
//
// Search used to answer only WHICH SECTION holds a setting: you typed `tray`,
// clicked Appearance, and then scanned a 16-row section by eye for the row the
// search already knew it had matched. `searchSectionsWithRows` (sectionSearch.ts)
// now reports the matching rows' anchor ids; this module is the thin DOM arm
// that turns those ids into a visible highlight plus a scroll to the first one.
//
// Kept OUT of SettingsPage.tsx so the class name has exactly one home (it is
// paired with the `.settings-row-match` rule in index.css) and so the two
// invariants below are stated once rather than re-derived at the call site.
//
// ---------------------------------------------------------------------------
// Invariant 1 — HIDDEN SECTIONS MUST NOT BE TOUCHED
// ---------------------------------------------------------------------------
// SettingsPage keeps EVERY section mounted and toggles visibility with the
// `hidden` class (so a half-typed draft survives a section switch). Ids are
// document-global, so an ungated `getElementById` happily finds — and would
// highlight and scroll to — a row in a section nobody can see. Every lookup is
// therefore gated on its owning `<section>` not being hidden.
//
// ---------------------------------------------------------------------------
// Invariant 2 — A MISSING ANCHOR IS NORMAL, NOT AN ERROR
// ---------------------------------------------------------------------------
// The backend-config sections do not render their rows until the `/api/config`
// GET resolves, and a conditional row (the custom-font input, the webhook
// fields) is absent whenever its branch is off. Searching during that window
// must do nothing at all — no crash, no partial scroll. Every lookup is
// null-tolerant by construction.

/**
 * The highlight class applied to a matched row's container.
 *
 * Defined in index.css rather than composed from Tailwind utilities here: the
 * class is applied from JS, so utilities named only in a string literal would
 * depend on those exact literals existing somewhere Tailwind scans — a
 * silent-breakage shape. One authored rule, one name, no scan dependency.
 */
export const ROW_MATCH_CLASS = 'settings-row-match';

/**
 * The element to highlight for a given anchor control.
 *
 * The anchor id sits on the CONTROL (an Input, a Switch, a SelectTrigger), and
 * highlighting a bare 24px switch reads as a rendering artifact rather than as
 * "this is your row". Its PARENT is the row container in every shape these
 * sections use: `<div class="flex flex-col gap-2">` around a Label+Input+hint,
 * or `<div class="flex items-center gap-2">` around a Switch+Label. Falling
 * back to the element itself keeps a control that is somehow a direct child of
 * the section from highlighting the whole section.
 */
export function rowContainerFor(el: HTMLElement): HTMLElement {
  const parent = el.parentElement;
  if (!parent || parent.tagName === 'SECTION') return el;
  return parent;
}

/** Whether this element lives in a section that is currently on screen. */
function isVisible(el: HTMLElement): boolean {
  const section = el.closest('section');
  // No enclosing <section> is not a reason to skip: only a `hidden` one is.
  return !section?.classList.contains('hidden');
}

/** Remove every row highlight currently in the document. */
export function clearRowMatchHighlights(root: Document | HTMLElement = document): void {
  for (const el of Array.from(root.querySelectorAll(`.${ROW_MATCH_CLASS}`))) {
    el.classList.remove(ROW_MATCH_CLASS);
  }
}

/**
 * Highlight the given rows and return the first one that actually resolved.
 *
 * Always clears prior highlights first, so this is idempotent and a query that
 * now matches nothing leaves the pane clean. The returned element is the
 * scroll target — the CALLER scrolls, so the "which row" decision and the
 * "when to move the viewport" decision stay separable.
 */
export function applyRowMatchHighlights(
  anchorIds: readonly string[],
  root: Document = document,
): HTMLElement | null {
  clearRowMatchHighlights(root);
  let first: HTMLElement | null = null;
  for (const id of anchorIds) {
    const el = root.getElementById(id);
    // Invariant 2: not rendered yet (config still loading, conditional row off).
    if (!el) continue;
    // Invariant 1: mounted but in a section the user is not looking at.
    if (!isVisible(el)) continue;
    const row = rowContainerFor(el);
    row.classList.add(ROW_MATCH_CLASS);
    if (!first) first = row;
  }
  return first;
}
