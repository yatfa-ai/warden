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
