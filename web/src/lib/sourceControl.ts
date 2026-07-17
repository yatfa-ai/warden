// Pure grouping of a focused repo's working-tree files into VS Code-style
// Source Control buckets, for the Source Control panel (WARDEN-431) — the
// single place repository working-tree changes now show (the scattered inline
// per-chat changed-file rows are removed).
//
// Reuses the porcelain slot classification already derived per-file by GitBadges
// (conflict / untracked / staged / unstaged); grouping is a sort over those, not
// a re-derivation. A partially-staged file (staged + unstaged slots both
// non-blank, e.g. porcelain "MM") belongs to BOTH Staged and Changes — exactly
// like VS Code, where it appears once per slot so each half can be diffed
// independently. In the Changes bucket its staged slot is blanked (' ') so the
// reused GitChangedFile row renders only the worktree letter and opens the
// COMBINED worktree-vs-HEAD diff (GitChangedFile derives `staged?` from the X
// slot); in the Staged bucket it renders as-is and opens the STAGED-only diff
// (`git diff --cached`). Conflicts land only in Merge; untracked only in
// Changes.
//
// Pure (no React, no @/ alias, zero imports) so it is unit-testable via
// node --test + transformWithOxc, mirroring whatsNew.test.mjs /
// gitStateSummary.test.mjs. TypeScript's structural typing makes a real
// GitFile[] (from @/components/sidebar/types) a valid GroupableFile[] at the
// call site without this module importing that type.

// The working-tree file shape this groups — a structural subset of the sidebar's
// GitFile (path + the porcelain X/Y slots + conflict flag). Defined locally so
// this module stays free of the @/ alias and is unit-testable directly.
export interface GroupableFile {
  path: string;
  status: string;
  staged?: string;
  worktree?: string;
  conflict?: boolean;
}

export interface FileGroup {
  // Conflicted files (UU/AA/…). Rendered with the red `!`-prefixed token.
  merge: GroupableFile[];
  // Files with a non-blank staged (X) slot. Clicking opens the staged-only diff.
  staged: GroupableFile[];
  // Unstaged + untracked files. A partially-staged file appears here too, with
  // its staged slot blanked so clicking opens the combined worktree-vs-HEAD diff.
  changes: GroupableFile[];
}

// Whether a file has a meaningful staged (X) / worktree (Y) porcelain slot.
// '?' is the untracked marker (handled separately) and ' ' is "no change in
// that slot" — neither counts as a real slot.
const hasStagedSlot = (f: GroupableFile): boolean =>
  f.staged !== undefined && f.staged !== ' ' && f.staged !== '?';
const hasWorktreeSlot = (f: GroupableFile): boolean =>
  f.worktree !== undefined && f.worktree !== ' ' && f.worktree !== '?';
const isUntracked = (f: GroupableFile): boolean =>
  f.staged === '?' || f.worktree === '?';

// Sort files by path for a stable, flicker-free order within each bucket. git
// status --porcelain is already path-sorted, but a per-bucket sort guarantees
// the order never depends on how the input was assembled.
const byPath = (a: GroupableFile, b: GroupableFile): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/**
 * Group a focused repo's working-tree files into VS Code-style Source Control
 * buckets: Merge (conflicted) / Staged / Changes (unstaged + untracked).
 *
 * A partially-staged file (both slots non-blank) is placed in BOTH Staged and
 * Changes: the Staged entry is the file as-is (opens the staged-only diff), and
 * the Changes entry is a shallow copy with the staged slot blanked to ' '
 * (opens the combined worktree-vs-HEAD diff, and renders only the worktree
 * letter). A pure-staged file (X non-blank, Y blank) appears only in Staged; a
 * pure-unstaged or untracked file appears only in Changes. A legacy committed
 * file (no X/Y slots — from /api/git-show, not /api/git-status) falls through to
 * Changes so it is never silently dropped.
 *
 * Each bucket is sorted by path. The function never throws and treats a
 * null/undefined/empty input as three empty buckets.
 */
export function groupGitFiles(files: GroupableFile[] | undefined | null): FileGroup {
  const merge: GroupableFile[] = [];
  const staged: GroupableFile[] = [];
  const changes: GroupableFile[] = [];
  if (!files || files.length === 0) return { merge, staged, changes };

  for (const file of files) {
    // Conflicts land only in Merge — they are not also shown as staged/changes.
    if (file.conflict) {
      merge.push(file);
      continue;
    }
    // Untracked ('??') lands only in Changes.
    if (isUntracked(file)) {
      changes.push(file);
      continue;
    }
    const stagedSlot = hasStagedSlot(file);
    const worktreeSlot = hasWorktreeSlot(file);
    if (stagedSlot) staged.push(file);
    if (worktreeSlot) {
      // A partially-staged file (staged + unstaged) appears in Changes with its
      // staged slot blanked so the row opens the COMBINED diff, not the staged
      // one — matching VS Code, where each slot is independently diffable. A
      // pure-unstaged file (no staged slot) renders as-is.
      changes.push(stagedSlot ? { ...file, staged: ' ' } : file);
    }
    if (!stagedSlot && !worktreeSlot) {
      // Legacy committed file (no X/Y) or a degenerate status — show in Changes
      // so a real entry is never silently dropped.
      changes.push(file);
    }
  }

  merge.sort(byPath);
  staged.sort(byPath);
  changes.sort(byPath);
  return { merge, staged, changes };
}
