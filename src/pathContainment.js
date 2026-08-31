// Single source of the working-directory containment rule (WARDEN-1234).
//
// The rule: a resolved path is inside a resolved working directory iff it IS
// the directory, or starts with the directory PLUS a path separator. The
// separator is the whole game: without it a pure string-prefix match also
// accepts a SIBLING whose name merely extends the cwd (cwd /x/proj lets
// /x/proj-secret.txt through) — the prefix-sibling traversal hole documented in
// the Path Validation Security knowledge article (WARDEN-96, Vector 2) and
// shipped broken once before (WARDEN-39: the remote bash `case` glob was
// "$CWD"* with no separator). Until this module the rule was written out six
// times — three shell fragments (buildReadFileScript, buildFileExistsScript,
// buildGitDiffScript) and three JS clauses (resolveLocalFile's guard plus the
// lexical and realpath arms of git.js's isPathWithinCwd) — which is six places
// a future edit could quietly drop the guard from. Each language now has ONE
// copy, here.
//
// The two artifacts:
//   * isWithinResolvedCwd — the JS clause, for already-resolved paths.
//   * CWD_CONTAINMENT_CASE — the bash `case` fragment spliced into the remote
//     (SSH/docker) scripts that enforce containment shell-side.
// The two languages cannot share an implementation (a JS boolean and a shell
// exit path are different beasts), so consolidation applies within each: one
// clause, one fragment, consumed by every site.
//
// Side-effect-free at module load (only a `node:path` import, no top-level
// statements), so it is safe to import from the pure helper modules (git.js)
// that must boot nothing when imported (WARDEN-606).
//
// Scope note: observer.js carries two further containment checks of its own
// (around its data-dir writes) that WARDEN-1234 deliberately left out of this
// consolidation.
//
// Regression pins: src/pathContainment.test.js covers BOTH artifacts including
// the sibling-prefix case; the bash fragment is additionally executed through a
// real shell with a prefix-sibling payload by src/read-file.test.js,
// src/file-exists.test.js, and src/gitDiff.test.js, so a future edit that
// drops the separator fails the suite instead of shipping.

import path from 'node:path';

// The JS clause. Both arguments must already be RESOLVED — lexical
// path.resolve output or fs.realpathSync.native output; which one (and whether
// a missing target is tolerated before this runs) is the caller's containment
// MODEL, not this function's. See isPathWithinCwd in git.js for the two-stage
// lexical-then-realpath form, and resolveLocalFile in server.js for the
// realpath-only form. Returns true iff resolvedPath IS resolvedCwd or lies
// beneath it behind a separator.
export function isWithinResolvedCwd(resolvedPath, resolvedCwd) {
  return resolvedPath === resolvedCwd || resolvedPath.startsWith(resolvedCwd + path.sep);
}

// The bash fragment. The splicing script must have set $RESOLVED and
// $RESOLVED_CWD (each builder computes both — realpath -e for must-exist
// targets, pwd -P + realpath -m + fallback for may-be-deleted ones) before this
// text runs. The `/*` arm requires the separator; the bare `"$RESOLVED_CWD"`
// arm admits the exact match (the cwd itself is in bounds). `*` in a case
// pattern matches `/`, which is exactly why the separator must live IN the
// pattern rather than being left to chance in the payload. A literal `|`
// alternation inside a case pattern is safe — bash tokenizes it at parse time;
// only a `$VAR`-sourced `|` breaks a case pattern (the WARDEN-140 interop
// trap).
export const CWD_CONTAINMENT_CASE =
  'case "$RESOLVED" in "$RESOLVED_CWD"/*|"$RESOLVED_CWD") ;; *) echo "ERROR path must be within working directory"; exit 1 ;; esac';
