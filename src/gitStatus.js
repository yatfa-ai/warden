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
 * @param {string|Buffer|undefined} output - Raw stdout from `git status --porcelain`.
 * @returns {Array<{path: string, status: string}>} Changed files, or `[]` when clean.
 */
export function parseGitStatusPorcelain(output) {
  const raw = (output ?? '').toString();
  return raw
    .split('\n')
    .map((line) => line.replace(/\r$/, '')) // tolerate CRLF (e.g. over SSH)
    .filter((line) => line.trim())           // drop the trailing empty line + blanks
    .map((line) => {
      const statusCode = line.substring(0, 2).trim();
      const filePath = line.substring(3).trim();
      return { path: filePath, status: statusCode || '??' };
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
