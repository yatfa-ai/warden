// Shared types for the sidebar subsystem, extracted from ChatSidebar.tsx
// (WARDEN-315). Pure structural move — no behavior change.

// One row from /api/git-log (a parsed %h|%s|%an|%ar git log line).
export type GitCommit = { hash: string; subject: string; author: string; date: string };

// One row from /api/git-stash (a parsed %gd|%s|%cr `git stash list` line) — the
// lazy detail behind the eager `stashCount` in /api/git-status. Read-only.
export type GitStash = { ref: string; subject: string; date: string };

export interface ClaudeSession { id: string; cwd: string; summary: string; mtime: number }

// One row from /api/claude-sessions-search (a session whose conversation body
// matched the query, across hosts — incl. sessions outside the top-40 list).
export interface SessionSearchResult { host: string; sessionId: string; cwd: string; summary: string; snippet: string; mtime: number }

export interface GitFile { path: string; status: string; conflict?: boolean }
