// Shared types for the sidebar subsystem, extracted from ChatSidebar.tsx
// (WARDEN-315). Pure structural move — no behavior change.

// One row from /api/git-log (a parsed %h|%s|%an|%ar|%ct git log line). `epoch`
// is git's %ct (committer date, UNIX seconds) — the exact timestamp the per-agent
// "What's new since" since-filter compares against lastSeen (WARDEN-356).
// Optional so a stale pre-%ct cache entry degrades safely.
export type GitCommit = { hash: string; subject: string; author: string; date: string; epoch?: number };

// One row from /api/git-stash (a parsed %gd|%s|%cr `git stash list` line) — the
// lazy detail behind the eager `stashCount` in /api/git-status. Read-only.
export type GitStash = { ref: string; subject: string; date: string };

export interface ClaudeSession { id: string; cwd: string; summary: string; mtime: number }

// One row from /api/claude-sessions-search (a session whose conversation body
// matched the query, across hosts — incl. sessions outside the top-40 list).
export interface SessionSearchResult { host: string; sessionId: string; cwd: string; summary: string; snippet: string; mtime: number }

// One changed file from /api/git-status (parsed from a porcelain v1 `XY <path>`
// line) or /api/git-show (a `--name-status` letter for a committed file).
//
// `status` is the collapsed/trimmed porcelain code existing consumers read (e.g.
// "M", "A", "D", "??", "MM"); for committed files it is a single `--name-status`
// letter (M/A/D/R/C) and the X/Y fields are absent.
//
// `staged` / `worktree` are the raw porcelain X/Y columns (WARDEN-369) — present
// ONLY for working-tree files from /api/git-status: X = index/staged status,
// Y = worktree/unstaged status, each a single character (' ' = no change in that
// slot, '?' = untracked). The position is what lets a renderer tell a
// STAGED-for-commit file apart from unstaged WIP (both collapse to status:"M"),
// and is what the staged-only diff path keys on (clicking a staged file opens
// `git diff --cached`). Absent for committed files, where the legacy M/A/D color
// map is used instead.
export interface GitFile {
  path: string;
  status: string;
  staged?: string;
  worktree?: string;
  conflict?: boolean;
}
