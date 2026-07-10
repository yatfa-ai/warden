// Pure helpers for parsing `git status --porcelain` output.
//
// Extracted from the /api/git-status route so the parsing is unit-testable —
// the porcelain format has subtle whitespace rules that are easy to break
// (see WARDEN-107).

/**
 * Parse `git status --porcelain` output into a list of changed files.
 *
 * The porcelain v1 format is a fixed-width record per line:
 *
 *     XY <path>
 *
 * where `X` is the index (staged) status and `Y` is the worktree status, each a
 * single character (a space means "no change in that slot"), followed by a
 * single space separator at position 2, then the path beginning at position 3.
 *
 *   " M file.js"  → X=' ' (not staged) Y='M' (worktree modified)  → status "M"
 *   "M  file.js"  → X='M' (staged)     Y=' ' (clean worktree)     → status "M"
 *   "A  file.js"  → X='A' (added)      Y=' '                       → status "A"
 *   "?? file.js"  → untracked                                      → status "??"
 *
 * CRITICAL: a status code can legitimately START WITH A SPACE (" M" = unstaged
 * modification — the single most common case). The full multi-line output must
 * therefore NEVER be `.trim()`-ed before parsing: trimming the whole blob strips
 * that leading space from the FIRST line, which then makes `substring(3)` read
 * one character too far and truncates the first file's path (e.g. "README.md"
 * becomes "EADME.md"). This function splits into lines first and preserves each
 * line's leading whitespace.
 *
 * Each file is also tagged `conflict: boolean` via `isConflictStatus` so a
 * conflicted path (UU/AA/…) can be rendered distinctly instead of falling
 * through to the generic-gray row. The field is additive — existing consumers
 * that destructure `{ path, status }` ignore it.
 *
 * @param {string|Buffer|undefined} output - Raw stdout from `git status --porcelain`.
 * @returns {Array<{path: string, status: string, conflict: boolean}>} Changed files, or `[]` when clean.
 */
// The unmerged (conflict) XY codes from `git status --porcelain` v1. For an
// unmerged path git sets BOTH columns — at least one 'U' (unmerged), or the
// both-added/both-deleted forms DD/AA. A repo mid-merge/cherry-pick/rebase
// emits exactly these for the paths it could not resolve automatically.
const UNMERGED_STATUS_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/**
 * Returns true if a porcelain XY status code marks an unmerged/conflicted path.
 *
 * The unmerged codes are `DD AU UD UA DU AA UU` — git writes one of these in
 * BOTH the index (X) and worktree (Y) columns when a path could not be merged
 * automatically (merge/cherry-pick/rebase conflict). Ordinary single-column
 * codes (`M`/`A`/`D`, with the other column a space) and `??` (untracked) are
 * never conflicts. Extracted as its own pure helper so conflict detection is
 * unit-testable in isolation, mirroring `parseGitStatusPorcelain`.
 *
 * @param {string|Buffer|undefined} xy - The raw two-char XY status code (e.g. "UU", "M", "??").
 * @returns {boolean}
 */
export function isConflictStatus(xy) {
  return UNMERGED_STATUS_CODES.has((xy ?? '').toString().trim());
}

export function parseGitStatusPorcelain(output) {
  const raw = (output ?? '').toString();
  return raw
    .split('\n')
    .map((line) => line.replace(/\r$/, '')) // tolerate CRLF (e.g. over SSH)
    .filter((line) => line.trim())           // drop the trailing empty line + blanks
    .map((line) => {
      const statusCode = line.substring(0, 2).trim();
      const filePath = line.substring(3).trim();
      return { path: filePath, status: statusCode || '??', conflict: isConflictStatus(statusCode) };
    })
    .filter((f) => f.path.length > 0);
}

/**
 * Parse `git rev-list --left-right --count @{u}...HEAD` output into
 * `{ ahead, behind }`.
 *
 * For the symmetric difference `@{u}...HEAD` (upstream ... HEAD), git prints
 * two tab-separated counts:
 *
 *   `<behind>\t<ahead>`
 *
 * The LEFT count is commits reachable from `@{u}` but not `HEAD` — commits the
 * upstream has that we don't (= behind / remote is ahead of us). The RIGHT
 * count is commits reachable from `HEAD` but not `@{u}` — local commits not yet
 * pushed (= ahead / unpushed). So `"0\t3"` means "0 behind, 3 ahead" (3
 * unpushed commits), and `"2\t0"` means "2 behind, 0 ahead".
 *
 * When there is no upstream (detached HEAD, an untracked branch, or a non-git
 * cwd) git exits non-zero with empty stdout. We surface that — and any other
 * malformed/garbage output — as `{ ahead: null, behind: null }` rather than
 * throwing, mirroring `parseGitStatusPorcelain`'s tolerance of missing/empty
 * input (see WARDEN-153).
 *
 * @param {string|Buffer|undefined} output - Raw stdout from the rev-list command.
 * @returns {{ ahead: number | null, behind: number | null }}
 */
export function parseAheadBehind(output) {
  const raw = (output ?? '').toString().trim();
  if (!raw) return { ahead: null, behind: null };
  const parts = raw.split('\t');
  if (parts.length !== 2) return { ahead: null, behind: null };
  const behind = parseInt(parts[0], 10);
  const ahead = parseInt(parts[1], 10);
  if (Number.isNaN(behind) || Number.isNaN(ahead)) return { ahead: null, behind: null };
  return { ahead, behind };
}

/**
 * Count the number of `git stash list` entries.
 *
 * Delegates to `parseStashList` (same line-splitting/CRLF/empty-filter pipeline)
 * rather than re-implementing it — mirroring how `parseGitStatusPorcelain` reuses
 * `isConflictStatus`. `git stash list` prints one reflog line per shelved WIP
 * entry; an empty output (no stashes, or a non-git / no-cwd repo whose
 * `git stash list` errors to stderr) has zero entries. We surface the count so a
 * stashed-but-clean tree reads `stashCount: N` instead of a misleading
 * `clean: true` — the core gap, since `git status --porcelain` emits no stash
 * entries (WARDEN-211).
 *
 * Mirrors `parseAheadBehind`: empty / undefined / whitespace-only input → `null`
 * (the frontend renders no indicator), `N` entries → `N`. The route additionally
 * guards non-git/no-cwd with `branch ? count : null`.
 *
 * @param {string|Buffer|undefined} output - Raw stdout from `git stash list`.
 * @returns {number | null}
 */
export function parseStashCount(output) {
  const count = parseStashList(output).length;
  return count > 0 ? count : null;
}

/**
 * Parse `git stash list --pretty=format:%gd|%s|%cr` output into
 * `[{ ref, subject, date }]`.
 *
 * `%gd` is the reflog selector (`stash@{0}`), `%s` the stash subject (e.g.
 * "WIP on main: abc1234 …"), and `%cr` the relative committer date. The subject
 * sits in the MIDDLE and MAY contain the `|` separator (a stash created with a
 * custom message like "merge a | b"), so — like `parseGitLogLine` — we peel the
 * ref off the front and the date off the back, leaving everything between as the
 * subject. CRLF (over SSH) is tolerated per line.
 *
 * Empty / undefined input → `[]` (no stashes), never throws. Exported for unit
 * tests. See WARDEN-211.
 *
 * @param {string|Buffer|undefined} output - Raw stdout from `git stash list --pretty`.
 * @returns {Array<{ ref: string, subject: string, date: string }>}
 */
export function parseStashList(output) {
  const raw = (output ?? '').toString();
  return raw
    .split('\n')
    .map((line) => line.replace(/\r$/, '')) // tolerate CRLF (e.g. over SSH)
    .filter((line) => line.trim())           // drop the trailing empty line + blanks
    .map((line) => {
      const firstPipe = line.indexOf('|');
      if (firstPipe === -1) return { ref: line, subject: '', date: '' };
      const ref = line.slice(0, firstPipe);
      const tail = line.slice(firstPipe + 1);
      const lastPipe = tail.lastIndexOf('|');
      if (lastPipe === -1) return { ref, subject: tail, date: '' };
      const date = tail.slice(lastPipe + 1);
      const subject = tail.slice(0, lastPipe);
      return { ref, subject, date };
    });
}
