// Pure resolver for relative file references inside rendered markdown docs
// (WARDEN-805).
//
// MarkdownBody's `a:` renderer unconditionally emits an external `target=_blank`
// link, so a doc's `[setup](./INSTALL.md)` or `[see utils](../lib/utils.ts)`
// opens a blank browser tab pointed at a meaningless relative URL — warden
// serves no file-by-raw-path route. This resolver decides, for a given markdown
// href, whether it is a RELATIVE FILE REFERENCE that can be opened in-place in
// the FileViewer (via the already-wired `onNavigate`), and if so returns the
// repo-relative path to open. Everything else (schemes, anchors, absolute
// paths) returns null so MarkdownBody falls back to its unchanged external
// rendering.
//
// Kept UI-free (no React) and browser-safe (NO `node:path` import — the lib
// runs in the browser bundle) so it lives in src/lib and can be unit-tested
// directly via the OXC-transform harness the other lib tests use (see
// web/docLinks.test.mjs, mirroring web/path-links.test.mjs). The `baseFilePath`
// is the FileViewer's cwd-relative `filePath` — the same string POSTed to
// /api/read-file and split by pathBreadcrumbs.splitPathSegments.

/**
 * Resolve a markdown link `href` against the directory of the doc rendering it.
 *
 * Returns the repo-relative path to open in-place, or null when the href is NOT
 * a relative file reference (so the caller renders it as an external link, as
 * it did before WARDEN-805).
 *
 * Returns null for:
 *   - URLs with a scheme: `http:`, `https:`, `mailto:`, `tel:`, `ftp:`, `data:`,
 *     `file:`, … (anything matching `/^[a-z][a-z0-9+.-]*:/i`). Also catches the
 *     degenerate single-letter colon case (`C:\…`) which is a Windows path, not
 *     a repo-relative ref.
 *   - Protocol-relative `//host/path`.
 *   - Absolute paths `/foo` — not a RELATIVE file reference; rendered external
 *     (unchanged) rather than reinterpreted against the repo root.
 *   - Anchor-only (`#section`) and empty hrefs (``). In-document anchor
 *     scrolling is explicitly out of scope for WARDEN-805.
 *   - Query-only / fragment-only hrefs that strip down to nothing.
 *
 * For relative hrefs (`./x`, `../y`, `dir/z.md`, `z.md`): posix-resolve against
 * `dirname(baseFilePath)`. `./` segments are dropped and `../` segments pop the
 * stack; a `../` that would climb past the repo root CLAMPS to root (the result
 * never starts with `../`). Any trailing `#anchor` / `?query` is stripped from
 * the resolved path before returning (so `[x](./INSTALL.md#install)` resolves
 * to the file path; the anchor is dropped — consistent with anchor-only being
 * out of scope). Mirrors the repo-relative normalization `joinPath` establishes
 * (fileBrowserTree.ts): the result is a bare `dir/name` string with no leading
 * slash and no doubled separators.
 */
export function resolveDocRelative(baseFilePath: string, href: string): string | null {
  if (typeof href !== 'string') return null;
  // Defensive trim — react-markdown hrefs are clean, but a stray space would
  // otherwise survive into the resolved path.
  const h = href.trim();
  if (h === '') return null;

  // Reject scheme URLs (http:, https:, mailto:, tel:, ftp:, data:, file:, …).
  if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return null;
  // Reject protocol-relative //host/path.
  if (h.startsWith('//')) return null;
  // Reject absolute paths — not a relative file reference.
  if (h.startsWith('/')) return null;

  // Drop a trailing ?query and/or #fragment from the path before resolving.
  // (Anchor-only `#section` and query-only `?x` hrefs strip down to '' here and
  // are treated as non-file references below.)
  let pathPart = h;
  const q = pathPart.indexOf('?');
  if (q !== -1) pathPart = pathPart.slice(0, q);
  const f = pathPart.indexOf('#');
  if (f !== -1) pathPart = pathPart.slice(0, f);
  if (pathPart === '') return null;

  // Build the resolved path on a segment stack seeded with the base doc's dir,
  // then extended with the href's segments. `.` and empty segments are no-ops;
  // `..` pops one segment, clamped at root (never underflows to a leading `..`).
  const stack: string[] = [];
  for (const seg of posixDirname(baseFilePath).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (stack.length > 0) stack.pop();
      continue;
    }
    stack.push(seg);
  }
  for (const seg of pathPart.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (stack.length > 0) stack.pop();
      continue;
    }
    stack.push(seg);
  }
  return stack.join('/');
}

// The directory portion of a cwd-relative file path (the doc's containing dir),
// posix-style. `docs/README.md` -> `docs`; `a/b/c.md` -> `a/b`; `README.md` and
// `` -> `` (root-level file / unknown). Hand-rolled (not `node:path`) so the
// lib stays browser-safe. Used only to seed the resolution stack.
function posixDirname(p: string): string {
  if (typeof p !== 'string' || p === '') return '';
  const i = p.lastIndexOf('/');
  if (i === -1) return '';
  return p.slice(0, i);
}
