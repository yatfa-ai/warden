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

export interface GitFile { path: string; status: string; conflict?: boolean }
