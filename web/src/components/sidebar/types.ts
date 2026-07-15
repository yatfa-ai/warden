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

// One row from /api/git-reflog (a parsed %h|%gs|%cr `git reflog` line) — the
// agent's OPERATION history: the non-commit git ops that leave no commit AND no
// dirty file (`reset --hard`, `checkout`, an abandoned rebase, a force-push), so
// they are diagnosable only here. `subject` is git's %gs — the operation itself
// (e.g. "reset: moving to HEAD~1", "checkout: moving from main to feat"). The
// fourth read-only axis alongside commit history / working-tree state / shelved
// WIP; fetched lazily on expand (no always-on badge). (WARDEN-460.)
export type GitReflogEntry = { hash: string; subject: string; date: string };

// One per-session token-usage ledger, summed from every assistant turn's
// `message.usage` across the transcript (model-agnostic raw token counts, NOT
// dollar cost). `total = input+output+cacheCreation+cacheRead`. Optional +
// nullable: a session with no/missing usage carries `null` so the row renders
// without a token badge (graceful-empty contract). (WARDEN-367.)
export interface TokenUsage { input: number; output: number; cacheCreation: number; cacheRead: number; total: number }

export interface ClaudeSession { id: string; cwd: string; summary: string; mtime: number; tokenUsage?: TokenUsage | null }

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

// Net insertions/deletions of an agent's uncommitted working-tree edits, parsed
// from `git diff HEAD --shortstat` (the "N files changed, N insertions(+), N
// deletions(-)" summary line). Additive field on /api/git-status alongside the
// porcelain file list — WHERE stashCount/files show PARKED work / WHICH files are
// dirty, this shows HOW MUCH (a 4-file WIP could be four one-line tweaks or a
// 1000-line rewrite). null when the tree matches HEAD or the stat is unavailable
// (WARDEN-411).
//
// CAVEAT: counts TRACKED (staged + unstaged) edits vs HEAD only — a purely-
// UNTRACKED new file (`??` in porcelain) contributes to the file list but NOT to
// these numbers (GitHub/gitk behave identically). The chip must therefore render
// only when `insertions + deletions > 0` so an all-untracked WIP shows no
// misleading `+0 −0`; untracked adds keep speaking through the existing file count.
export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
}
