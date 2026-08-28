// The git section (WARDEN-431, widened by WARDEN-975): the SINGLE place git appears
// in the sidebar, and it describes ONLY the currently focused pane.
//
// Collapsed it is one header line — the collapse chevron, the label, the changed-file
// count and the repo summary (branch or detached HEAD, last-commit freshness, ±
// magnitude, upstream / no-remote marker, ↑ahead, ↓behind, 🗄stash). Expanded it adds
// everything the per-row branch badge used to carry behind a popover: the working
// tree grouped like VS Code into Merge Changes (conflicted) / Staged Changes /
// Changes (unstaged + untracked), and the repo's full detail — commit search, the
// recent / unpushed / incoming commit lists with per-commit changed files and inline
// diffs, the aggregated range diffs, stashes, the reflog, and the branch topology.
//
// Read-only end to end: clicks open the existing per-file DiffViewer (a staged file
// opens the staged-only diff, a CONFLICTED file opens the ours-vs-theirs ConflictView),
// expand a commit list, or open a file in the FileViewer. Nothing here can stage,
// unstage, commit or otherwise mutate the repo (WARDEN-199 read-only line) — and,
// per WARDEN-975, nothing here opens, focuses or switches a PANE either: a git
// control acts inside this section and nowhere else.
//
// Self-contained + props-driven (the focused pane's id, its git status, the three
// commit caches + their fetchers, the open handlers, and the collapse state + setter)
// so the in-flight sidebar redesign (WARDEN-257) re-hosts rather than rebuilds it.

import { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { GitChangedFile, GitRepoSummary, GitRepoDetails } from './GitBadges';
import { groupGitFiles } from '@/lib/sourceControl';
import type { GitCommit, GitFile, DiffStat } from './types';

// The focused repo's git-status slice — the per-chat gitStatus entry ChatSidebar
// fetches from the read-only /api/git-status route, in full. Owned by ChatSidebar;
// the section only reads it. WARDEN-975 widened this from the WARDEN-431 subset
// (branch / clean / cwd / files / inProgress) to every field the per-row badge read,
// so nothing readable from an agent row before is unreachable here after.
export interface SourceControlGitInfo {
  branch: string | null;
  clean: boolean | null;
  cwd?: string;
  files?: GitFile[];
  inProgress?: { operation: string | null; detail?: string | null };
  detached?: boolean;
  headSha?: string | null;
  headDate?: string | null;
  ahead?: number | null;
  behind?: number | null;
  upstream?: string | null;
  stashCount?: number | null;
  diffstat?: DiffStat | null;
}

// One VS Code-style bucket: a colored header label + the reused GitChangedFile
// rows. The row look (status token + truncated path) comes from GitChangedFile
// unchanged — this only supplies the section heading and the click handlers.
function FileSection({ label, files, onOpenDiff, onOpenConflict, onOpenFile, tone }: {
  label: string;
  files: GitFile[];
  onOpenDiff: (path: string, staged?: boolean) => void;
  onOpenConflict?: (path: string) => void;
  onOpenFile?: (path: string) => void;
  tone: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className={cn('px-2 pb-0.5 text-[10px] font-medium uppercase tracking-wider', tone)}>
        {label} · {files.length}
      </div>
      <div className="flex flex-col gap-0.5 px-1">
        {files.map((file) => (
          <GitChangedFile key={file.path} file={file} onOpen={onOpenDiff} onOpenConflict={onOpenConflict} onOpenFile={onOpenFile} />
        ))}
      </div>
    </div>
  );
}

/**
 * The collapsible "Source Control" section: everything about the FOCUSED pane's
 * repository, and nothing about any other pane. Renders nothing when the focused pane
 * has no git repo (non-git cwd, bare tmux, not-yet-fetched, or no focused pane) —
 * empty/hidden, never an error. A clean repo shows "Working tree clean". Collapse
 * state is owned by the caller (persisted across reload like the other sidebar panels).
 */
export function SourceControlPanel({ chatId, gitInfo, onOpenDiff, onOpenConflict, onOpenFile, commits, commitsLoading, commitsError, onFetchCommits, incomingCommits, incomingLoading, incomingError, onFetchIncoming, outgoingCommits, outgoingLoading, outgoingError, onFetchOutgoing, collapsed, onCollapsedChange }: {
  // The focused pane's id — the `id` every /api/git-* route resolves the repo by.
  // Empty/undefined when nothing is focused (the section renders nothing anyway).
  chatId?: string | null;
  gitInfo?: SourceControlGitInfo | null;
  onOpenDiff: (path: string, staged?: boolean) => void;
  // WARDEN-428: a CONFLICTED file (UU/AA/UD/…) opens the read-only ours-vs-theirs
  // ConflictView instead of the staged diff (`git diff --cached` on an unmerged path
  // is not a usable ours/theirs view). WARDEN-975 wires it here: this section is now
  // the only surface that lists working-tree files, so it owns that route.
  onOpenConflict?: (path: string) => void;
  // WARDEN-478: open a file's full content (read + blame + history) in the FileViewer,
  // from a working-tree row here or a committed row inside the detail below.
  onOpenFile?: (path: string) => void;
  // The three commit caches + their lazy fetchers, owned by ChatSidebar and keyed by
  // chat id there; this section forwards the FOCUSED pane's slice to GitRepoDetails.
  commits?: GitCommit[];
  commitsLoading?: boolean;
  // WARDEN-1014: each cache's failure reason rides alongside it, so a /api/git-log
  // failure renders as a failure instead of an empty commit list.
  commitsError?: string | null;
  onFetchCommits?: () => void;
  incomingCommits?: GitCommit[];
  incomingLoading?: boolean;
  incomingError?: string | null;
  onFetchIncoming?: () => void;
  outgoingCommits?: GitCommit[];
  outgoingLoading?: boolean;
  outgoingError?: string | null;
  onFetchOutgoing?: () => void;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}) {
  // groupGitFiles is pure and tolerates a null/undefined input (three empty
  // buckets). Called unconditionally so hook order is stable across the
  // focused-pane-changes / data-arrives transitions that gate the early return.
  const group = useMemo(() => groupGitFiles(gitInfo?.files), [gitInfo?.files]);

  // No branch ⟺ the focused pane's cwd is not a git repo. The shared query
  // (['git-status', key], WARDEN-1211) stores a SUCCESSFUL branch-less payload
  // as valid data — never an error — and this panel's own !gitInfo?.branch
  // gate below renders nothing for it. Also covers "pane isn't focused /
  // status hasn't landed yet". In all those cases render nothing — the section
  // is the single place for git, so absent a repo there is nothing to show and
  // no error to surface.
  if (!gitInfo || !gitInfo.branch || !chatId) return null;

  const changedCount = gitInfo.files?.length ?? 0;
  const hasChanges = group.merge.length > 0 || group.staged.length > 0 || group.changes.length > 0;

  return (
    <div className="flex flex-col">
      <Button
        type="button"
        variant="ghost"
        onClick={() => onCollapsedChange(!collapsed)}
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? 'expand' : 'collapse'} source control`}
        title={`${collapsed ? 'expand' : 'collapse'} source control${gitInfo.cwd ? ` · ${gitInfo.cwd}` : ''}`}
        className="flex-wrap justify-start gap-1 w-full h-auto px-2 pt-2 pb-1 text-xs font-normal uppercase tracking-wider text-muted-foreground/60 hover:text-foreground"
      >
        <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
        <span>Source Control</span>
        {changedCount > 0 && (
          <span className="text-[10px] text-muted-foreground">{changedCount}</span>
        )}
        {/* The repo summary — the whole of the old per-row branch badge's always-on
            vocabulary, non-interactive so the header's only control stays the collapse
            toggle it sits inside (a nested <button> would be invalid HTML, WARDEN-68). */}
        <GitRepoSummary
          className="ml-auto"
          branch={gitInfo.branch}
          clean={gitInfo.clean}
          ahead={gitInfo.ahead}
          behind={gitInfo.behind}
          inProgress={gitInfo.inProgress}
          stashCount={gitInfo.stashCount}
          diffstat={gitInfo.diffstat}
          detached={gitInfo.detached}
          headSha={gitInfo.headSha}
          headDate={gitInfo.headDate}
          upstream={gitInfo.upstream}
        />
      </Button>
      {!collapsed && (
        <div className="flex flex-col gap-0.5 pb-1">
          {hasChanges ? (
            <>
              {group.merge.length > 0 && (
                <FileSection label="Merge Changes" files={group.merge} onOpenDiff={onOpenDiff} onOpenConflict={onOpenConflict} onOpenFile={onOpenFile} tone="text-red-400" />
              )}
              {group.staged.length > 0 && (
                <FileSection label="Staged Changes" files={group.staged} onOpenDiff={onOpenDiff} onOpenConflict={onOpenConflict} onOpenFile={onOpenFile} tone="text-green-400" />
              )}
              {group.changes.length > 0 && (
                <FileSection label="Changes" files={group.changes} onOpenDiff={onOpenDiff} onOpenConflict={onOpenConflict} onOpenFile={onOpenFile} tone="text-yellow-400" />
              )}
            </>
          ) : gitInfo.clean === true ? (
            <div className="px-2 py-0.5 text-[10px] text-muted-foreground">Working tree clean</div>
          ) : null}
        </div>
      )}
      {/* The repo's full detail. Keyed by chat id so switching the focused pane
          REMOUNTS it with a clean per-commit / stash / reflog / branch cache instead
          of showing the previous repo's rows; it stays mounted while collapsed (it
          renders no body then) so those caches survive a collapse/expand round trip,
          exactly as they survived a popover close/reopen. */}
      <GitRepoDetails
        key={chatId}
        expanded={!collapsed}
        chatId={chatId}
        branch={gitInfo.branch}
        clean={gitInfo.clean}
        ahead={gitInfo.ahead}
        behind={gitInfo.behind}
        stashCount={gitInfo.stashCount}
        diffstat={gitInfo.diffstat}
        detached={gitInfo.detached}
        headSha={gitInfo.headSha}
        upstream={gitInfo.upstream}
        commits={commits}
        loading={commitsLoading}
        commitsError={commitsError}
        onFetch={onFetchCommits}
        incomingCommits={incomingCommits}
        incomingLoading={incomingLoading}
        incomingError={incomingError}
        onFetchIncoming={onFetchIncoming}
        outgoingCommits={outgoingCommits}
        outgoingLoading={outgoingLoading}
        outgoingError={outgoingError}
        onFetchOutgoing={onFetchOutgoing}
        onOpenFile={onOpenFile}
      />
    </div>
  );
}
