// Pure path-token extraction for the in-terminal file linkifier (WARDEN-227).
//
// Kept in its own module (not inline in PaneTile) so the regex + `:line[:col]`
// parsing has direct unit-test coverage — there is no front-end component test
// runner in this repo, but this module loads cleanly under Vite's OXC transform
// (see web/path-links.test.mjs, mirroring storage.test.mjs's harness).

export interface PathCandidate {
  /** Index in the source line where the FULL token (path + optional `:line[:col]`) starts. */
  start: number;
  /** Length of the full token (path + optional `:line[:col]`). */
  length: number;
  /** The bare file path (no `:line[:col]` suffix) — what existence/read use. */
  path: string;
  /** Optional 1-based line number from a `:line` suffix. */
  line?: number;
  /** Optional 1-based column number from a `:line:col` suffix. */
  col?: number;
}

// Match a path-like token: an optional leading `/` (absolute paths), zero or more
// `segment/` runs, then a final `name.ext`. An optional `:line` or `:line:col`
// suffix may follow (groups 2/3). The final segment MUST end in `.ext` so bare
// words / version numbers don't trigger probes. Deliberately permissive about the
// number of slashes — findPathCandidates post-filters, and the async existence
// check is the real gate (a token that isn't a real file under the chat's cwd is
// simply not linkified), exactly like VSCode's terminal linkifier.
const TOKEN_RE = /(\/?(?:[\w.~-]+\/)*[\w.~-]*\.[A-Za-z0-9][\w.~-]*)(?::(\d+)(?::(\d+))?)?/g;

// Find every path-like candidate on a single terminal line (already-trimmed via
// IBufferLine.translateToString). Returns [] when there are none. Pure and
// side-effect-free; PaneTile maps each candidate's start/length to an xterm range.
export function findPathCandidates(line: string): PathCandidate[] {
  const out: PathCandidate[] = [];
  for (const m of line.matchAll(TOKEN_RE)) {
    const start = m.index ?? 0;
    // Skip URL authorities (https://host/path…): the path-like tail never resolves
    // under cwd, so don't waste a probe. The match begins right after the URL's
    // `:/`, so the text immediately before it ends in `:/`.
    if (/:\/$/.test(line.slice(0, start))) continue;
    const path = m[1];
    const lineNo = m[2] ? parseInt(m[2], 10) : undefined;
    const col = m[3] ? parseInt(m[3], 10) : undefined;
    // Require either a path separator OR a `:line` suffix. A bare `name.ext` with
    // neither (package.json, README.md, a version like 1.2.3) is too ambiguous and
    // too common to probe on every occurrence.
    if (!path.includes('/') && lineNo === undefined) continue;
    out.push({ start, length: m[0].length, path, line: lineNo, col });
  }
  return out;
}
