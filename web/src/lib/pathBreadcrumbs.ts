// Pure path-segmentation helpers for the FileViewer's clickable breadcrumbs
// (WARDEN-740).
//
// Kept UI-free (no React, no shadcn, no lucide) so it lives in src/lib and can
// be unit-tested directly via the OXC-transform harness the other lib tests use
// (see web/breadcrumbs.test.mjs, mirroring web/path-links.test.mjs). The
// FileViewer's `filePath` is cwd-relative — the same string POSTed to
// /api/read-file (FileViewer.tsx) and the same shape /api/git-ls's `dir` arg
// takes. These helpers split that string into the breadcrumb geometry: the
// directory segments (each a clickable crumb whose own dir /api/git-ls lists)
// and the final file segment (the open file, not clickable).
//
// The geometry mirrors the ticket's segmentation contract exactly:
//   segments        = filePath.split('/').filter(non-empty, non-'.')
//   i-th ancestor   = segments.slice(0, i).join('/')   // '' for i=0 (repo root)
//   file parent dir = segments.slice(0, -1).join('/')   // '' for a root-level file

/** Split a cwd-relative file path into its non-empty segments.
 *
 *  Robust to a leading `./`, a trailing `/`, and doubled separators — all of
 *  which would otherwise produce phantom empty segments. `read-file` accepts a
 *  leading `./` verbatim (the in-terminal linkifier captures `./foo/bar`
 *  as-is — see path-links WARDEN-227), so normalizing it away here keeps the
 *  breadcrumb cosmetically clean without changing the path's meaning (a
 *  navigated sibling always comes back from /api/git-ls without a `./` prefix,
 *  via fileBrowserTree.joinPath, so the breadcrumb mirrors the path correctly
 *  after any navigation regardless).
 *
 *  A lone `.` segment (from `./` or `foo/./bar`) is dropped for the same
 *  reason — it is a no-op path component, not a real directory. */
export function splitPathSegments(filePath: string): string[] {
  return filePath.split('/').filter((s) => s.length > 0 && s !== '.');
}

/** The cwd-relative dir whose /api/git-ls listing opens when the i-th ancestor
 *  crumb is clicked. Ancestor 0 is the repo root (`dir=''`); ancestor i (i>=1)
 *  is the directory named by `segments[i-1]`. Pure over the segment array
 *  produced by splitPathSegments — pass that array (NOT the raw path) so the
 *  `./` / trailing-slash normalization is applied once, consistently. */
export function ancestorDir(segments: string[], i: number): string {
  return segments.slice(0, i).join('/');
}

/** The cwd-relative directory containing the file — its parent dir, the last
 *  ancestor. `''` for a root-level file (no parent above the repo root). */
export function parentDir(filePath: string): string {
  const segs = splitPathSegments(filePath);
  return segs.slice(0, -1).join('/');
}

/** How many crumb boxes the breadcrumb run renders before it collapses the
 *  middle of the path behind an overflow menu (WARDEN-1006). Four is the
 *  collapsed total: the root crumb, the `…` trigger, and the two crumbs
 *  nearest the open file. */
export const MAX_VISIBLE_CRUMBS = 4;

/** Split the crumb list into the run that stays on screen and the run that
 *  moves into the `…` overflow menu (WARDEN-1006).
 *
 *  WHY THIS EXISTS: the crumbs are fixed-size click targets, so a deep path's
 *  min-content width exceeds the dialog title row. Before this, a deep path
 *  either painted over the toolbar buttons or — once the row was made to clip —
 *  had its tail crumbs silently sliced off past the clip edge: invisible AND
 *  unclickable, with nothing on screen saying they existed. Collapsing is the
 *  structural half of the fix (CSS shrink alone cannot choose WHICH crumbs to
 *  drop): the middle of the path moves into a menu that still lists it, so the
 *  navigation those crumbs provide survives the collapse, and the `…` says the
 *  collapse happened.
 *
 *  Keeps the ROOT crumb and the crumbs NEAREST THE FILE — the two ends a human
 *  orients by — and hides the middle, which is the conventional breadcrumb
 *  collapse and the opposite of clipping the deep end off.
 *
 *  Pure and total: `[...lead, ...hidden, ...tail]` always reconstructs the input
 *  in order, so no crumb can be lost by collapsing (pinned in breadcrumbs.test.mjs).
 *
 *  @param maxVisible total crumb BOXES to render when collapsed (the `…` counts
 *  as one). Clamped to >= 3 so a collapse always leaves a lead crumb, the
 *  trigger, and at least one tail crumb. */
export function collapseCrumbs<T>(
  crumbs: T[],
  maxVisible: number = MAX_VISIBLE_CRUMBS,
): { lead: T[]; hidden: T[]; tail: T[] } {
  const cap = Math.max(3, Math.floor(maxVisible));
  // Short enough to render whole — nothing hidden, so no `…` is shown either.
  if (crumbs.length <= cap) return { lead: crumbs, hidden: [], tail: [] };
  const tailCount = cap - 2; // one box for the root crumb, one for the `…` trigger
  return {
    lead: crumbs.slice(0, 1),
    hidden: crumbs.slice(1, crumbs.length - tailCount),
    tail: crumbs.slice(crumbs.length - tailCount),
  };
}
