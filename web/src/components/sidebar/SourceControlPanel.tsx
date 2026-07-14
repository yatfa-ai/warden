// The Source Control panel (WARDEN-431): the SINGLE place a focused pane's
// repository working-tree changes are shown — grouped like VS Code into Merge
// Changes (conflicted) / Staged Changes / Changes (unstaged + untracked). The
// scattered inline per-chat changed-file rows are removed; this panel re-points
// to whichever pane is focused. Read-only end to end: clicks open the existing
// per-file DiffViewer (a staged file opens the staged-only diff via the same
// /api/git-diff route the inline rows used); nothing here can stage, unstage,
// commit, or otherwise mutate the repo (WARDEN-199 read-only line).
//
// Self-contained + props-driven (focused gitInfo, onOpenDiff, collapse state +
// setter) so the in-flight sidebar redesign (WARDEN-257) re-hosts rather than
// rebuilds it. Reuses GitChangedFile for every row (WARDEN-107/369/186) and the
// pure groupGitFiles sort over the porcelain slots — no new backend, no new
// viewer, no reinvented row look.

import { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { GitChangedFile } from './GitBadges';
import { groupGitFiles } from '@/lib/sourceControl';
import type { GitFile } from './types';

// The focused repo's git-status slice — a structural subset of the per-chat
// gitStatus entry ChatSidebar already fetches via the read-only /api/git-status
// route (branch / clean / cwd / files / inProgress). Owned by ChatSidebar; the
// panel only reads it.
export interface SourceControlGitInfo {
  branch: string | null;
  clean: boolean | null;
  cwd?: string;
  files?: GitFile[];
  inProgress?: { operation: string | null };
}

// One VS Code-style bucket: a colored header label + the reused GitChangedFile
// rows. The row look (status token + truncated path) comes from GitChangedFile
// unchanged — this only supplies the section heading and the click handler.
function FileSection({ label, files, onOpenDiff, tone }: {
  label: string;
  files: GitFile[];
  onOpenDiff: (path: string, staged?: boolean) => void;
  tone: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className={cn('px-2 pb-0.5 text-[10px] font-medium uppercase tracking-wider', tone)}>
        {label} · {files.length}
      </div>
      <div className="flex flex-col gap-0.5 px-1">
        {files.map((file) => (
          <GitChangedFile key={file.path} file={file} onOpen={onOpenDiff} />
        ))}
      </div>
    </div>
  );
}

/**
 * A collapsible "Source Control" section showing the focused pane's repo changes,
 * grouped like VS Code. Renders nothing when the focused pane has no git repo
 * (non-git cwd, bare tmux, not-yet-fetched, or no focused pane) — empty/hidden,
 * never an error. A clean repo shows "Working tree clean". Collapse state is
 * owned by the caller (persisted across reload like the other sidebar panels).
 */
export function SourceControlPanel({ gitInfo, onOpenDiff, collapsed, onCollapsedChange }: {
  gitInfo?: SourceControlGitInfo | null;
  onOpenDiff: (path: string, staged?: boolean) => void;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}) {
  // groupGitFiles is pure and tolerates a null/undefined input (three empty
  // buckets). Called unconditionally so hook order is stable across the
  // focused-pane-changes / data-arrives transitions that gate the early return.
  const group = useMemo(() => groupGitFiles(gitInfo?.files), [gitInfo?.files]);

  // No branch ⟺ the focused pane's cwd is not a git repo (fetchGitStatus stores
  // an entry only when /api/git-status returns a branch), or the pane isn't
  // focused / status hasn't landed yet. In all those cases render nothing — the
  // panel is the single place for repo changes, so absent a repo there is
  // nothing to show and no error to surface.
  if (!gitInfo || !gitInfo.branch) return null;

  const changedCount = gitInfo.files?.length ?? 0;
  const hasChanges = group.merge.length > 0 || group.staged.length > 0 || group.changes.length > 0;
  const branchTitle = gitInfo.cwd ? `${gitInfo.branch} · ${gitInfo.cwd}` : gitInfo.branch;
  const isMerging = !!gitInfo.inProgress?.operation;

  return (
    <div className="flex flex-col">
      <Button
        type="button"
        variant="ghost"
        onClick={() => onCollapsedChange(!collapsed)}
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? 'expand' : 'collapse'} source control`}
        title={`${collapsed ? 'expand' : 'collapse'} source control`}
        className="justify-start gap-1 w-full h-auto px-2 pt-2 pb-1 text-xs font-normal uppercase tracking-wider text-muted-foreground/60 hover:text-foreground"
      >
        <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
        <span>Source Control</span>
        {changedCount > 0 && (
          <span className="text-[10px] text-muted-foreground">{changedCount}</span>
        )}
        <span
          className="ml-auto truncate text-[10px] normal-case tracking-normal text-cyan-400/80"
          title={branchTitle}
        >
          {isMerging && <span className="text-red-400" title={`${gitInfo.inProgress!.operation} in progress`}>⚠ </span>}
          ⎇ {gitInfo.branch}
        </span>
      </Button>
      {!collapsed && (
        <div className="flex flex-col gap-0.5 pb-1">
          {hasChanges ? (
            <>
              {group.merge.length > 0 && (
                <FileSection label="Merge Changes" files={group.merge} onOpenDiff={onOpenDiff} tone="text-red-400" />
              )}
              {group.staged.length > 0 && (
                <FileSection label="Staged Changes" files={group.staged} onOpenDiff={onOpenDiff} tone="text-green-400" />
              )}
              {group.changes.length > 0 && (
                <FileSection label="Changes" files={group.changes} onOpenDiff={onOpenDiff} tone="text-yellow-400" />
              )}
            </>
          ) : gitInfo.clean === true ? (
            <div className="px-2 py-0.5 text-[10px] text-muted-foreground">Working tree clean</div>
          ) : null}
        </div>
      )}
    </div>
  );
}
