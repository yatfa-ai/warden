// Git-status UI subsystem extracted from ChatSidebar.tsx (WARDEN-315).
//
// WARDEN-975: git is now ONE collapsible sidebar section describing ONLY the
// focused pane. Everything fleet-level that used to live here — the 6-axis
// ±/↑/↓/⚑/🗄/💤 GitStateBadges chip row, the ⚠/⏱/⇄ GitCollisionBadge rollups, the
// "triage first" GitTriageCallout, and the per-row ✦N WhatsNewMarker — is gone,
// together with the per-row GitBranchBadge popover. Every one of those surfaces
// deep-linked into a pane (onOpenChat), which the product decision forbids: a git
// control acts inside the git section and never opens, focuses or switches a pane.
//
// What remains is the focused-pane vocabulary, split so the section can render it
// INLINE instead of behind a popover trigger on a chat row:
//   • GitChangedFile / CommitFile / CommitMessage — the shared file + commit rows.
//   • GitRepoSummary — the one-line branch/state summary (the old badge trigger).
//   • GitRepoDetails — the repo's full detail (the old badge popover BODY): commit
//     search, recent/unpushed/incoming commit lists, stashes, reflog, branches,
//     the origin row, and the aggregated range-diff affordances.

import { useState, useEffect, useMemo } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { toast } from 'sonner';
import { copyText } from '@/lib/clipboard';
import { GitCompare, FileIcon, Search, X, ExternalLink } from 'lucide-react';
import { DiffBlock } from '@/components/DiffBlock';
import { DiffViewer } from '@/components/DiffViewer';
import { cn } from '@/lib/utils';
import { basename } from '@/lib/chatDisplay';
import { formatRelative, formatAbsoluteFull } from '@/lib/formatTimestamp';
import type { GitCommit, GitFile, GitStash, GitReflogEntry, GitRemote, GitBranch, DiffStat } from './types';
import { DiffStatChip } from './DiffStatChip';

/**
 * Color the porcelain X/Y columns for one changed file (WARDEN-369). Working-tree
 * files (from /api/git-status) carry `staged` (X) and `worktree` (Y); we color by
 * SLOT so a staged-for-commit file reads differently from an unstaged WIP file:
 *
 *   staged slot (X, non-blank)    → green-400   (the "about to commit" signal)
 *   worktree slot (Y, non-blank)  → yellow-400  (the existing WIP color)
 *   untracked (`?`)               → gray-400    `??`
 *   conflict                      → red-400     `!<code>`
 *
 * A partially-staged file ("MM" / "AM") emits BOTH a green and a yellow letter, so
 * it no longer falls through to the old strict-`===` gray default — it communicates
 * both halves at once. The letter itself (M/A/D/R/C) is shown verbatim in its slot's
 * color; the staged-vs-unstaged axis is the primary signal (the whole point), so D
 * is no longer forced red — a staged delete reads green, an unstaged delete yellow.
 *
 * Committed files (from /api/git-show) have NO X/Y columns, so this falls back to
 * the legacy single-letter color map (M=yellow, A=green, D=red) — a committed
 * modified file still reads yellow, exactly as before this change. The slot fields
 * are additive/optional, so this branch keeps every existing CommitFile row stable.
 *
 * Returns one or more `{ text, cls }` segments rendered as adjacent colored spans.
 */
function fileStatusSegments(file: GitFile): { text: string; cls: string }[] {
  if (file.conflict) {
    return [{ text: `!${file.status}`, cls: 'text-red-400' }];
  }
  const x = file.staged;
  const y = file.worktree;
  // Working-tree files (X/Y present). Committed files omit both → legacy fallback.
  if (x !== undefined || y !== undefined) {
    if (x === '?' || y === '?') {
      return [{ text: '??', cls: 'text-gray-400' }];
    }
    const segs: { text: string; cls: string }[] = [];
    if (x && x !== ' ') segs.push({ text: x, cls: 'text-green-400' });   // staged slot
    if (y && y !== ' ') segs.push({ text: y, cls: 'text-yellow-400' });  // worktree slot
    if (segs.length > 0) return segs;
  }
  // Legacy fallback: a committed file (no X/Y) or a degenerate status. M/A/D map
  // is preserved verbatim so CommitFile rows are unaffected.
  const cls =
    file.status === 'M' ? 'text-yellow-400' :
    file.status === 'A' ? 'text-green-400' :
    file.status === 'D' ? 'text-red-400' :
    'text-gray-400';
  return [{ text: file.status, cls }];
}

/** A human-readable label for a file's staged/unstaged state (for the tooltip). */
function fileSlotLabel(file: GitFile): string {
  if (file.conflict) return `conflict ${file.status}`;
  const x = file.staged;
  const y = file.worktree;
  if (x !== undefined || y !== undefined) {
    if (x === '?' || y === '?') return 'untracked';
    const staged = !!x && x !== ' ';
    const unstaged = !!y && y !== ' ';
    if (staged && unstaged) return 'staged + unstaged';
    if (staged) return 'staged';
    if (unstaged) return 'unstaged';
  }
  return file.status;
}

/** A compact "open this file in the FileViewer" affordance (WARDEN-478). A
 *  role="button" <span> — NEVER a <button>: it lives inside GitChangedFile's
 *  interactive <button> and CommitFile's role="button" row, where a nested real
 *  <button> would nest interactive elements (a recurring WARDEN-68 concern in
 *  this file). The <span> needs its own keydown (Enter/Space) since a non-button
 *  doesn't synthesize a click from the keyboard, and stopPropagation on click +
 *  keydown so triggering it never also opens the diff or toggles the commit's
 *  inline diff. Mirrors GitStateBadge's span-trigger (the same nested-in-an-
 *  interactive-row shape). Brightens on hover but is always visible so the new
 *  path is discoverable (not hidden behind a hover the human may never do). */
function OpenFileAffordance({ path, onOpenFile, className }: { path: string; onOpenFile: (path: string) => void; className?: string }) {
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={`open ${path} in the file viewer`}
      onClick={(e) => { e.stopPropagation(); onOpenFile(path); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          onOpenFile(path);
        }
      }}
      title={`open file: ${path}`}
      className={cn('inline-flex items-center text-muted-foreground hover:text-foreground rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary transition-colors duration-150', className)}
    >
      <FileIcon className="size-3" />
    </span>
  );
}

/** Copy via the Electron-safe helper + a sonner success/error toast — the same
 *  pattern every sibling Copy slice uses (FleetRecentCommits, DiffViewer,
 *  ConflictView). Never bare navigator.clipboard, which fails silently in
 *  Electron (WARDEN-68 Rule 3); the caller owns the toast per the copyText
 *  contract (lib/clipboard.ts). Module-level: GitChangedFile is rendered once
 *  per changed file, so there is no reason to re-create it per row. */
async function copyWithToast(text: string) {
  const ok = await copyText(text);
  if (ok) toast.success('Copied');
  else toast.error('Copy failed');
}

/** A single changed-file row: status indicator (M/A/D/??) + truncated path.
 *  Interactive (a real <button>) only when `onOpen` is supplied — it opens the
 *  per-file DiffViewer and the click stops propagation so it never also opens the
 *  parent chat row. Without `onOpen` it renders as a plain non-interactive <span>:
 *  this lets it be embedded inside ANOTHER interactive row (an expanded commit's
 *  touched-file list, where the whole row is the affordance) without nesting
 *  interactive elements or swallowing the parent's click — and avoids a <button>
 *  with no handler, which is poor a11y. A conflicted file (`conflict: true`,
 *  e.g. UU/AA) renders a distinct red `!`-prefixed token instead of the generic
 *  gray row, so it reads as a conflict rather than noise (WARDEN-186). A
 *  working-tree file colors its staged vs unstaged slots distinctly (WARDEN-369);
 *  clicking a STAGED file opens the staged-only diff (what will be committed). */
export function GitChangedFile({ file, onOpen, onOpenConflict, onOpenFile }: { file: GitFile; onOpen?: (path: string, staged?: boolean) => void; onOpenConflict?: (path: string) => void; onOpenFile?: (path: string) => void }) {
  const segments = fileStatusSegments(file);
  // Whether clicking this row should open the STAGED-only diff. Only working-tree
  // files with a non-blank staged slot (X) qualify; committed files have no slot.
  const x = file.staged;
  const isUntracked = x === '?' || file.worktree === '?';
  const isStaged = x !== undefined && !isUntracked && x !== ' ';
  // WARDEN-428: a conflicted file (UU/AA/UD/…) opens the read-only ours-vs-theirs
  // ConflictView instead of the staged diff — `git diff --cached` on an unmerged
  // path is not a usable ours/theirs view. Falls back to onOpen only when no
  // conflict handler is wired (e.g. a display-only call site).
  const useConflict = file.conflict && !!onOpenConflict;
  const content = (
    <>
      <span className="inline-flex items-center shrink-0">
        {segments.map((s, i) => (
          <span key={i} className={s.cls}>{s.text}</span>
        ))}
      </span>
      <span className="min-w-0 flex-1 wrap-anywhere">{file.path}</span>
      {/* WARDEN-478: an "open this file in the FileViewer" affordance — a sibling of
          the path, shrunk to the right edge. WARDEN-892: the path wraps internally
          (no truncation) so a long path never pushes this icon off the row; the
          row's flex-wrap drops the icon to its own line before letting it clip. */}
      {onOpenFile && <OpenFileAffordance path={file.path} onOpenFile={onOpenFile} className="shrink-0 ml-1" />}
    </>
  );
  const row = onOpen || onOpenConflict ? (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        if (useConflict) onOpenConflict!(file.path);
        else onOpen?.(file.path, isStaged);
      }}
      // Stop the keydown from reaching the parent row's onKeyDown (Enter/Space → open
      // chat): without this, keyboard-activating the file button would open the chat
      // pane instead of the diff, because the row handler calls preventDefault() before
      // the button's activation click can fire.
      onKeyDown={(e) => e.stopPropagation()}
      title={`${fileSlotLabel(file)} · ${useConflict ? 'view conflict' : isStaged ? 'view staged diff' : 'view diff'}: ${file.path}`}
      className="flex flex-wrap items-center gap-1 w-full text-left rounded-sm text-[10px] text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
    >
      {content}
    </button>
  ) : (
    <span className="flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">{content}</span>
  );
  return (
    // Themed right-click Copy menu (Context-Menu Completeness roadmap / WARDEN-917).
    // Wrapping the ROW here closes all three call sites at once — the Source Control
    // panel's buckets, an expanded commit's/stash's touched-file list, and the
    // non-interactive <span> inside CommitFile (the gap WARDEN-875's comment named) —
    // with no new props and no change to SourceControlPanel. The path is otherwise
    // completely uncopyable: left-click on the <button> branch is consumed to open the
    // diff/ConflictView, so there is no drag-select and, until now, no menu.
    //
    // Radix's ContextMenu root renders no DOM element and `asChild` merges only
    // handlers onto the existing <button>/<span>, so the row's layout, its role, and the
    // interactive-nesting shape documented above are all unchanged — as is the onKeyDown
    // stopPropagation that keeps the parent chat row from stealing Enter/Space.
    //
    // Nesting (call sites 2 + 3 sit inside ChatRows' own ContextMenuTrigger via
    // GitBranchBadge): exactly ONE menu opens, and no explicit stopPropagation is needed.
    // Radix's trigger calls event.preventDefault() after opening
    // (@radix-ui/react-context-menu/dist/index.mjs:84-88) and the ANCESTOR trigger wraps
    // its open handler in composeEventHandlers, which skips when event.defaultPrevented
    // (@radix-ui/primitive/dist/index.mjs:3-9) — so the innermost trigger wins. Same
    // mechanism PaneTile relies on for its terminal-inside-pane menus (WARDEN-380);
    // verified live here by right-clicking a file row inside an expanded sidebar commit.
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent>
        {/* The full path, never truncated — the row wraps but is not selectable. */}
        <ContextMenuItem onSelect={() => copyWithToast(file.path)}>Copy file path</ContextMenuItem>
        {/* Mirrors the "Copy filename" vocabulary of the DiffViewer / FileViewer /
            ConflictView siblings this row opens (WARDEN-472 / 445 / 536). */}
        <ContextMenuItem onSelect={() => copyWithToast(basename(file.path))}>Copy filename</ContextMenuItem>
        {/* The same human-readable staged/unstaged/conflict label the row's title
            attribute shows — hover-only text, so copying it needed a menu. */}
        <ContextMenuItem onSelect={() => copyWithToast(fileSlotLabel(file))}>Copy status</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// WARDEN-669: the >7d HEAD-commit staleness threshold — the age at which a repo's
// last commit is treated as STALE and its freshness label tints amber. Shared by the
// repo summary line's `· Nd` append (WARDEN-545) and the branch-topology list below
// (WARDEN-577), so both agree by construction rather than by a second magic number.
const STALE_HEAD_AGE_MS = 7 * 86400_000;

/** Shared body for the two byte-mirrored "click a touched file → lazily fetch its
 *  diff → reveal it inline via <DiffBlock>" rows: CommitFile (committed) and StashFile
 *  (stashed). Owns the open/diff/loading/fetched quartet so a re-collapse/re-expand is
 *  instant. The ONLY behavior that varies between the two is parameterized here:
 *  `buildUrl` (which per-file diff endpoint + how the change is addressed — a commit
 *  `hash` vs a stash `ref`), `label` (committed|stashed, interpolated into the
 *  aria-label + title), and the optional `onOpenFile` (renders the open-in-FileViewer
 *  affordance — StashFile never passes it; when absent the toggle span gains `ml-auto`
 *  to right-pack exactly as StashFile did). Pure DRY extraction; zero behavior change.
 *  (Collapses the CommitFile/StashFile mirror — WARDEN-340, WARDEN-478, WARDEN-864.) */
function DiffInspectRow({ file, buildUrl, label, onOpenFile }: { file: GitFile; buildUrl: () => string; label: 'committed' | 'stashed'; onOpenFile?: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetched, setFetched] = useState(false);

  const toggle = async () => {
    if (!open && !fetched) {
      setLoading(true);
      try {
        const r = await fetch(buildUrl());
        const j = await r.json();
        setDiff(typeof j.diff === 'string' ? j.diff : null);
      } catch {
        setDiff(null);
      } finally {
        setLoading(false);
        setFetched(true);
      }
    }
    setOpen((o) => !o);
  };

  return (
    <div className="pl-2">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={`inspect ${label} diff for ${file.path}`}
        onClick={(e) => { e.stopPropagation(); toggle(); }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggle(); } }}
        title={`click to inspect this file's ${label} diff`}
        className="flex w-full items-center gap-1 rounded px-0.5 py-px text-left hover:bg-accent cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
      >
        <div className="min-w-0 flex-1"><GitChangedFile file={file} /></div>
        {/* WARDEN-478: open this file in the FileViewer. The flex-1 path wrapper above
            packs this icon + the toggle to the right edge. The inner GitChangedFile is
            rendered WITHOUT onOpenFile so it stays a non-interactive <span> (no nested
            affordance) — when onOpenFile is present this row owns the only open-file
            control; when absent (stashed rows) nothing renders here and ml-auto on the
            toggle span right-packs it instead. */}
        {onOpenFile && <OpenFileAffordance path={file.path} onOpenFile={onOpenFile} className="shrink-0" />}
        <span className={`${onOpenFile ? 'shrink-0' : 'ml-auto shrink-0'} text-[10px] text-muted-foreground`}>{loading ? '…' : open ? '▾' : '▸'}</span>
      </div>
      {open && (
        loading ? (
          <div className="px-1 text-[10px] text-muted-foreground">loading diff…</div>
        ) : diff ? (
          <DiffBlock diff={diff} />
        ) : (
          <div className="px-1 text-[10px] text-muted-foreground">no diff</div>
        )
      )}
    </div>
  );
}

/** One touched-file row inside an expanded commit. Click to fetch and reveal the
 *  committed diff for that file (`git show --format= <hash> -- <path>`). Delegates the
 *  shared diff-fetch + inline-reveal machinery to DiffInspectRow; this wrapper only
 *  supplies the committed-diff endpoint + the `committed` label. */
// Exported (WARDEN-597) so the FleetRecentCommits feed can render the SAME expanded
// commit → changed-files → per-file /api/git-show diff path the per-agent popover
// uses, without duplicating the diff machinery. Each row in that cross-fleet feed
// passes its OWN agent key as `chatId` (git-show's `id` param), so the per-file diff
// resolves against the right repo — the component is multi-agent where this badge is
// single-agent, but `chatId` is just the git-show `id`, so it composes cleanly.
export function CommitFile({ chatId, hash, file, onOpenFile }: { chatId: string; hash: string; file: GitFile; onOpenFile?: (path: string) => void }) {
  return (
    <DiffInspectRow
      file={file}
      label="committed"
      onOpenFile={onOpenFile}
      buildUrl={() => `/api/git-show?id=${encodeURIComponent(chatId)}&hash=${encodeURIComponent(hash)}&path=${encodeURIComponent(file.path)}`}
    />
  );
}

/** One touched-file row inside an expanded stash. Click to fetch and reveal the
 *  stashed diff for that file (`git diff stash@{n}^ stash@{n} -- <path>` via
 *  /api/git-stash-show). Delegates the shared diff-fetch + inline-reveal machinery to
 *  DiffInspectRow; the only thing this wrapper supplies is the stashed-diff endpoint
 *  (addressed by its reflog selector `ref=stash@{n}`, not a commit hash) and the
 *  `stashed` label. (WARDEN-340) */
function StashFile({ chatId, stashRef, file }: { chatId: string; stashRef: string; file: GitFile }) {
  return (
    <DiffInspectRow
      file={file}
      label="stashed"
      buildUrl={() => `/api/git-stash-show?id=${encodeURIComponent(chatId)}&ref=${encodeURIComponent(stashRef)}&path=${encodeURIComponent(file.path)}`}
    />
  );
}

/** The commit's body — the "why" behind the change — rendered above the changed-
 *  files list inside an expanded commit. Undefined/empty → renders nothing, so a
 *  subject-only commit stays compact (the collapsed row already shows the subject).
 *  whitespace-pre-wrap preserves the message's own line breaks; break-words +
 *  muted text-[10px] match DiffBlock's density. (WARDEN-388) */
// Exported (WARDEN-597) — see CommitFile's export note. Shared by the FleetRecentCommits
// feed so a cross-fleet commit row expands to the SAME commit body this badge shows.
export function CommitMessage({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <div className="whitespace-pre-wrap break-words px-1 pb-0.5 text-[10px] text-muted-foreground">{message}</div>
  );
}

/**
 * The one-line repo summary for the focused pane (WARDEN-975) — the content the
 * per-row GitBranchBadge trigger used to render, now a NON-INTERACTIVE <span> that
 * lives on the git section's header line so it reads whether the section is
 * expanded or collapsed. Nothing here is clickable: the section's own collapse
 * <Button> owns the header's interaction, and a git control must never navigate.
 *
 * Carries every always-on signal the badge carried, so nothing readable before is
 * unreachable after: the mid-operation ⚠ (WARDEN-186/511), branch name OR the
 * detached-HEAD ⎇ + short SHA (WARDEN-239), last-commit freshness with its >7d
 * amber stale tint (WARDEN-545), the yellow ± dirty glyph with its +N −M magnitude
 * (WARDEN-411/670 — on-surface here rather than tooltip-only, since the section has
 * the room a chat row did not), the 🔒 no-remote durability marker (WARDEN-243),
 * ↑N unpushed (WARDEN-153), ↓N behind (WARDEN-225) and 🗄N stashed (WARDEN-211).
 * The full hover keeps the badge's titleParts vocabulary verbatim.
 */
export function GitRepoSummary({ branch, clean, ahead, behind, inProgress, stashCount, diffstat, detached, headSha, headDate, upstream, className }: {
  branch: string;
  clean: boolean | null;
  ahead?: number | null;
  behind?: number | null;
  inProgress?: { operation: string | null; detail?: string | null };
  stashCount?: number | null;
  diffstat?: DiffStat | null;
  detached?: boolean;
  headSha?: string | null;
  headDate?: string | null;
  upstream?: string | null;
  className?: string;
}) {
  const aheadCount = typeof ahead === 'number' ? ahead : 0;
  const behindCount = typeof behind === 'number' ? behind : 0;
  // Shelved work-in-progress (`git stash`): porcelain status is clean while real,
  // recoverable work is parked, so the count is surfaced separately (WARDEN-211).
  const stashN = typeof stashCount === 'number' ? stashCount : 0;
  // The operation an agent is blocked mid-way through (merge/rebase/cherry-pick/
  // revert/bisect), or null when none is in progress. This is the highest-value
  // signal in the summary: a blocked agent produces nothing until noticed (WARDEN-186).
  const operation = inProgress?.operation || null;
  // WARDEN-511: the operation's progress detail — rebase "N/M · onto <sha> ·
  // stopped at <sha>", or the SHA being applied for merge/cherry-pick/revert.
  // null when no detail is available (bisect, rebase-apply, or nothing in
  // progress). Folded into the operation clause below so a hover tells a human
  // WHERE the agent is stuck, not just that it is.
  const detail = inProgress?.detail || null;
  // The full operation clause, reused by both the tooltip (titleParts) and the
  // on-surface ⚠ glyph's own title so they never drift. detail null → the plain
  // "<op> in progress" rendering is unchanged from pre-WARDEN-511.
  const inProgressTitle = operation
    ? (detail ? `${operation} in progress · ${detail}` : `${operation} in progress`)
    : null;
  // WARDEN-239: detached HEAD — render an amber ⎇ + short SHA instead of the
  // misleading "HEAD" label. ahead/behind stay null (no upstream), so the
  // ↑/↓ markers naturally don't render.
  const isDetached = detached === true;
  const sha = typeof headSha === 'string' ? headSha.trim() : '';
  // WARDEN-545: last-commit freshness derived from headDate (strict ISO-8601 from
  // git %cI). Date.parse → NaN when headDate is missing/invalid, so headFresh is
  // false and no marker renders (a repo with no commits / non-git cwd). Rendered for
  // BOTH branch AND detached repos: headDate is fetched unconditionally server-side
  // (gated on `branch`, which is the literal 'HEAD' for detached). Stale (>7d) gets
  // an amber tint so a quiet repo pops; fresh stays muted.
  const headMs = typeof headDate === 'string' && headDate ? Date.parse(headDate) : NaN;
  const headFresh = Number.isFinite(headMs);
  const headStale = headFresh && Date.now() - headMs > STALE_HEAD_AGE_MS;
  // WARDEN-243: a named branch with NO upstream tracking (never `push -u`'d) is
  // local-only work with no remote backup — a durability risk a human glancing at
  // the summary needs to see. Distinct from a synced 0/0 branch (which HAS an
  // upstream): ahead/behind are null in BOTH cases, so the upstream name is the
  // only signal. Excluded for detached HEAD (branch === 'HEAD', rendered as its
  // own amber glyph by WARDEN-239 — a detached HEAD has no @{u} by definition).
  const noUpstream = !isDetached && !!branch && branch !== 'HEAD' && !upstream;
  const hasMagnitude = !!diffstat && diffstat.insertions + diffstat.deletions > 0;
  const titleParts = isDetached
    ? [`detached HEAD${sha ? ` @ ${sha}` : ''}`, 'commits not on a branch; at risk if reflog expires']
    : [branch];
  if (!isDetached && branch && branch !== 'HEAD') {
    if (upstream) titleParts.push(`tracking ${upstream}`);
    else titleParts.push('no remote tracking — local-only, not backed up');
  }
  // WARDEN-545: fold the exact last-commit time into the hover so a glance at the
  // `· Nd` append can be resolved to a precise clock time without expanding.
  if (headFresh) titleParts.push(`last commit ${formatAbsoluteFull(headMs)}`);
  if (inProgressTitle) titleParts.push(inProgressTitle);
  if (clean === false) {
    // WARDEN-411: fold the magnitude into the dirty tooltip so a hover distinguishes
    // a 4-line WIP from a 1000-line rewrite without expanding the file list.
    const mag = hasMagnitude ? ` (+${diffstat!.insertions} −${diffstat!.deletions})` : '';
    titleParts.push(`uncommitted changes${mag}`);
  }
  if (stashN > 0) titleParts.push(`${stashN} stashed`);
  if (!isDetached && aheadCount > 0) titleParts.push(`${aheadCount} unpushed`);
  if (!isDetached && behindCount > 0) titleParts.push(`${behindCount} behind remote`);

  return (
    <span
      className={cn('inline-flex flex-wrap items-center gap-x-1 gap-y-0 min-w-0 max-w-full text-[10px] normal-case tracking-normal', isDetached ? 'text-amber-400' : 'text-cyan-400', className)}
      title={titleParts.join(' · ')}
    >
      {operation && <span className="shrink-0 text-red-400 font-medium" title={inProgressTitle || `${operation} in progress`}>⚠ {operation}</span>}
      {isDetached ? (
        <>
          <span className="shrink-0" title="detached HEAD — commits not on a branch; at risk if reflog expires">⎇</span>
          {sha && <span className="min-w-0 wrap-anywhere font-mono">{sha}</span>}
        </>
      ) : (
        <span className="min-w-0 wrap-anywhere">⎇ {branch}</span>
      )}
      {headFresh && (
        <span className={cn('shrink-0', headStale ? 'text-amber-400' : 'text-muted-foreground')}>· {formatRelative(headMs)}</span>
      )}
      {clean === false && (
        <span className="inline-flex shrink-0 items-center gap-0.5">
          <span className="text-yellow-400">±</span>
          {/* WARDEN-670: the working-tree MAGNITUDE, not just the fact of WIP.
              DiffStatChip owns its own null / +0−0 guard, so an all-untracked WIP
              renders the bare ± with no misleading +0−0. */}
          {hasMagnitude && <DiffStatChip diffstat={diffstat} />}
        </span>
      )}
      {noUpstream && <span className="shrink-0 text-muted-foreground" title="no remote tracking — local-only work, not backed up remotely">🔒</span>}
      {upstream && <span className="shrink-0 text-muted-foreground/80" title={`tracking ${upstream}`}>→ {upstream}</span>}
      {aheadCount > 0 && <span className="shrink-0 text-amber-400">↑{aheadCount}</span>}
      {behindCount > 0 && <span className="shrink-0 text-blue-400">↓{behindCount}</span>}
      {stashN > 0 && <span className="shrink-0 text-fuchsia-400" title={`${stashN} stashed`}>🗄{stashN}</span>}
    </span>
  );
}

/**
 * The focused repo's FULL detail, rendered INLINE inside the git section
 * (WARDEN-975). This is the per-row GitBranchBadge's popover BODY, verbatim in
 * content and behaviour — commit search, the recent / unpushed / incoming commit
 * lists with their per-commit changed-files + inline diffs, the aggregated
 * "full diff" range affordances, stashes, the reflog, the branch topology and the
 * origin row — minus the popover shell and its chat-row trigger.
 *
 * Lazy-fetch discipline is unchanged, only re-anchored: everything the popover
 * fetched on first OPEN is fetched when the section is first EXPANDED, each guarded
 * so a re-expand reuses the cache. The component stays mounted while collapsed (only
 * its body is hidden) so those caches — and any expanded commit — survive a
 * collapse/expand round trip exactly as they survived a popover close/reopen. The
 * caller keys it by chat id, so switching the focused pane remounts it with a clean
 * cache rather than showing the previous repo's commits.
 *
 * Nothing here navigates: every control opens a diff, expands a list, or opens a
 * file — never a pane.
 */
export function GitRepoDetails({ branch, clean, commits, loading, onFetch, ahead, behind, chatId, stashCount, diffstat, incomingCommits, incomingLoading, onFetchIncoming, outgoingCommits, outgoingLoading, onFetchOutgoing, detached, headSha, upstream, onOpenFile, expanded }: {
  branch: string;
  clean: boolean | null;
  commits?: GitCommit[];
  loading?: boolean;
  onFetch?: () => void;
  ahead?: number | null;
  behind?: number | null;
  chatId: string;
  stashCount?: number | null;
  // WARDEN-411: net insertions/deletions of the working-tree edits vs HEAD, or null
  // when clean/unavailable. Rendered as the uncommitted section's +N −M chip and
  // threaded to the aggregated worktree DiffViewer so the chip and the diff agree.
  diffstat?: DiffStat | null;
  // WARDEN-225: the "behind" half — commits @{u} has that HEAD doesn't. Lazily
  // fetched on expand when behindCount > 0, with its own cache/loader so it refreshes
  // independently of the local recent-commits list. Explorable (WARDEN-348): each row
  // expands to its changed files + per-file diff via /api/git-show — these are local
  // objects reachable from the upstream remote-tracking ref (@{u}), so git show serves
  // them without a pull.
  incomingCommits?: GitCommit[];
  incomingLoading?: boolean;
  onFetchIncoming?: () => void;
  // WARDEN-252: the "ahead/unpushed" half — commits HEAD has that @{u} doesn't. The
  // symmetric counterpart to incomingCommits. Lazily fetched on expand when aheadCount
  // > 0, with its own cache/loader. Explorable (WARDEN-303): each row expands to its
  // changed files + per-file diff via /api/git-show. Both halves are explorable —
  // outgoing commits are reachable from HEAD, incoming from @{u} (WARDEN-348).
  outgoingCommits?: GitCommit[];
  outgoingLoading?: boolean;
  onFetchOutgoing?: () => void;
  // WARDEN-239: HEAD is not on a branch (an agent checked out a specific commit).
  // Rendered as the detached short SHA (+ its commit deep-link) instead of the
  // misleading literal "HEAD" branch label. ahead/behind are null on detached.
  detached?: boolean;
  headSha?: string | null;
  // WARDEN-243: the short upstream tracking branch (e.g. origin/feature), or null
  // when HEAD has no upstream. Selects the primary remote for the deep-links below.
  upstream?: string | null;
  // WARDEN-478: open a touched file's full content in the FileViewer from inside the
  // commit lists. Threaded to each CommitFile row (recent, outgoing, incoming) so a
  // committed file is readable — with blame/history one click away — not just diffable.
  onOpenFile?: (path: string) => void;
  // Whether the git section is expanded. Drives BOTH the body's visibility and the
  // lazy fetches (the popover's onOpenChange, re-anchored).
  expanded: boolean;
}) {
  const aheadCount = typeof ahead === 'number' ? ahead : 0;
  const behindCount = typeof behind === 'number' ? behind : 0;
  const stashN = typeof stashCount === 'number' ? stashCount : 0;
  const isDetached = detached === true;
  const sha = typeof headSha === 'string' ? headSha.trim() : '';

  // Per-commit expand state + the /api/git-show files cache (keyed by hash) so a
  // repeat expansion is instant. This component owns the interaction, so the state
  // lives here rather than being prop-drilled through the section/ChatSidebar.
  const [expandedHash, setExpandedHash] = useState<string | null>(null);
  const [showCache, setShowCache] = useState<Record<string, { files?: GitFile[]; message?: string; error?: string | null }>>({});
  const [showLoading, setShowLoading] = useState<Record<string, boolean>>({});

  // Lazy stash detail (mirror of fetchShow for commits): undefined = not yet
  // fetched, [] = fetched-but-empty (stashes dropped since the count was read),
  // so we don't refetch forever on a legitimately-empty result.
  const [stashList, setStashList] = useState<GitStash[] | undefined>(undefined);
  const [stashLoading, setStashLoading] = useState(false);

  // Lazy reflog detail (WARDEN-460): the agent's operation history — resets,
  // checkouts, abandoned rebases, force-pushes (the non-commit ops that leave no
  // commit AND no dirty file, diagnosable only in the reflog). Unlike stash this
  // has no eager count prop (the roadmap keeps it off the always-on badge), so we
  // fetch it on every first-open of the expanded view, guarded by `=== undefined`
  // so a repeat open reuses the cache. undefined = not yet fetched, [] = fetched-
  // but-empty (a fresh repo with no commits, or a non-git cwd soft-fail).
  const [reflogList, setReflogList] = useState<GitReflogEntry[] | undefined>(undefined);
  const [reflogLoading, setReflogLoading] = useState(false);

  // WARDEN-528: which remote repo this checkout maps to + its web host URL — the one
  // coordination fact every OTHER git facet omits. Lazily fetched on first open
  // (mirrors reflog: undefined = not yet fetched, [] = fetched-but-empty so a repeat
  // open reuses the cache). Read-only (/api/git-remote runs `git remote -v`, which
  // never mutates); never gated on a count because the remote identity is relevant
  // for EVERY repo (the deep-links + origin row render from it), not just a dirty one.
  const [remoteList, setRemoteList] = useState<GitRemote[] | undefined>(undefined);
  const [remoteLoading, setRemoteLoading] = useState(false);

  // WARDEN-577: the agent's local branches — the topology the badge's single
  // current-branch name only gestures at (which OTHER branches exist, whether
  // work is scattered, whether a branch is stranded/unmerged or its upstream
  // gone). Lazily fetched on first open (mirrors reflog/remote: undefined = not
  // yet fetched, [] = fetched-but-empty so a repeat open reuses the cache).
  // Read-only (/api/git-branch runs `git for-each-ref refs/heads/`, which never
  // mutates); never gated on a count because every repo with a commit has at
  // least one branch.
  const [branchList, setBranchList] = useState<GitBranch[] | undefined>(undefined);
  const [branchLoading, setBranchLoading] = useState(false);

  // Per-stash expand state + the /api/git-stash-show files cache (keyed by ref), a
  // parallel of expandedHash/showCache/showLoading for commits — so expanding a
  // stash is INDEPENDENT of expanding a commit (and vice versa). Mirrors the
  // commit-inspect pattern exactly; the only divergence is `ref=` instead of
  // `hash=` (a stash is addressed by its reflog selector stash@{n}). (WARDEN-340)
  const [expandedStashRef, setExpandedStashRef] = useState<string | null>(null);
  const [stashShowCache, setStashShowCache] = useState<Record<string, { files?: GitFile[]; error?: string | null }>>({});
  const [stashShowLoading, setStashShowLoading] = useState<Record<string, boolean>>({});

  // WARDEN-398: the aggregated range-diff modal target. Set by the "View full diff"
  // affordance in the outgoing (↑N) or incoming (↓N) section; null while closed.
  // WARDEN-449: extended to the ± (worktree) axis — `git diff HEAD`, no count (the
  // magnitude is the in-scope `diffstat` prop, not a commit count). Rendered by the
  // generalized DiffViewer (range mode) as a sibling of this section body.
  const [rangeDiff, setRangeDiff] = useState<{ kind: 'outgoing' | 'incoming' | 'worktree'; count?: number } | null>(null);

  // WARDEN-498: commit-message search across the per-agent lists. A small debounced
  // input above the lists fetches /api/git-log?grep= for each VISIBLE range (recent
  // always; outgoing when ahead; incoming when behind) so one term filters every list
  // at once. Results are held LOCALLY (mirrors the stash/reflog lazy-fetch pattern:
  // expanded-view-only, transient, lives in the badge that owns the interaction) so the
  // cached browse lists stay intact — clearing the box simply drops these and each
  // section reverts to its cached list (no refetch). The list RENDERING is unchanged —
  // only each section's data source swaps (see listFor below), so matches drill down via
  // the existing expand→changed-files→DiffBlock path with no new row type.
  const [grepInput, setGrepInput] = useState('');
  // searchResults is keyed by range: '' (recent), 'outgoing', 'incoming'. A key's value
  // is `undefined` while that range's fetch is pending (or not yet started for this
  // term); `{ status: 'ok', commits }` once it resolved (possibly empty); or
  // `{ status: 'error' }` if the fetch failed (non-ok HTTP, network, or bad JSON). The
  // three states keep "loading", "fetched, no matches", and "fetch failed" distinct so
  // the empty/error states are honest (WARDEN-89 — never let a failure masquerade as a
  // barren history).
  type GrepResult = { status: 'ok'; commits: GitCommit[] } | { status: 'error' };
  const [searchResults, setSearchResults] = useState<Record<string, GrepResult | undefined>>({});
  const [searchLoading, setSearchLoading] = useState(false);
  const searching = grepInput.trim().length > 0;

  useEffect(() => {
    const q = grepInput.trim();
    if (!q) {
      // Cleared → drop search results so every section reverts to its cached browse list.
      setSearchResults({});
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    // Clear the previous term's results immediately so stale matches are never rendered
    // under the new query while the debounce + fetch are in flight (mirrors the
    // WARDEN-161 session-search discipline in OpenChatBrowserPage).
    setSearchResults({});
    let cancelled = false;
    // Only the ranges currently shown by the popover are worth searching — a hidden list
    // (e.g. outgoing when not ahead) has no rows to match, so skip it rather than issuing
    // a harmless-but-wasteful fetch. `range` is '' for the recent (HEAD-reachable) list.
    const ranges: string[] = [''];
    if (aheadCount > 0) ranges.push('outgoing');
    if (behindCount > 0) ranges.push('incoming');
    const t = setTimeout(async () => {
      const settled = await Promise.all(
        ranges.map(async (range): Promise<[string, GrepResult]> => {
          try {
            const url = `/api/git-log?id=${encodeURIComponent(chatId)}&grep=${encodeURIComponent(q)}` + (range ? `&range=${range}` : '');
            const r = await fetch(url);
            // WARDEN-89: fetch() resolves (does not reject) on a 4xx/5xx — gate on r.ok
            // so a server error surfaces as { status: 'error' } instead of reading
            // undefined `j.commits` as an empty list (false-empty disease).
            if (!r.ok) throw new Error(`git-log grep HTTP ${r.status}`);
            const j = await r.json();
            return [range, { status: 'ok', commits: Array.isArray(j.commits) ? j.commits : [] }];
          } catch (error) {
            // WARDEN-89: never swallow silently — log with the range + term so a network
            // failure or bad JSON leaves a trace instead of looking like "no matches".
            console.warn('[WARDEN-498 git-log grep] failed:', error, { range, q });
            return [range, { status: 'error' }];
          }
        }),
      );
      if (cancelled) return;
      const next: Record<string, GrepResult | undefined> = {};
      for (const [range, result] of settled) next[range] = result;
      setSearchResults(next);
      setSearchLoading(false);
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [grepInput, chatId, aheadCount, behindCount]);

  // Resolve what a given section should render right now: its grep-filtered results when
  // a search is active, else its cached browse list. Returns the items (possibly
  // undefined while pending) and whether the section is in a loading state. Used below
  // to swap each list's data source without touching its row markup.
  const listFor = (range: '' | 'outgoing' | 'incoming', browse: GitCommit[] | undefined, browseLoading: boolean) => {
    if (searching) {
      const hit = searchResults[range];
      if (hit === undefined) return { items: undefined, loading: true, error: false };
      if (hit.status === 'error') return { items: undefined, loading: false, error: true };
      return { items: hit.commits, loading: false, error: false };
    }
    return { items: browse, loading: !!browseLoading, error: false };
  };

  // Resolve each section's render source once (browse cache vs grep results) so the JSX
  // below reads the same whether or not a search is active.
  const recent = listFor('', commits, !!loading);
  const outList = listFor('outgoing', outgoingCommits, !!outgoingLoading);
  const incList = listFor('incoming', incomingCommits, !!incomingLoading);

  const fetchShow = async (hash: string) => {
    if (showCache[hash] || showLoading[hash]) return;
    setShowLoading((p) => ({ ...p, [hash]: true }));
    try {
      const r = await fetch(`/api/git-show?id=${encodeURIComponent(chatId)}&hash=${encodeURIComponent(hash)}`);
      const j = await r.json();
      setShowCache((p) => ({ ...p, [hash]: { files: Array.isArray(j.files) ? j.files : [], message: typeof j.message === 'string' ? j.message : undefined, error: j.error } }));
    } catch {
      setShowCache((p) => ({ ...p, [hash]: { files: [], error: 'fetch failed' } }));
    } finally {
      setShowLoading((p) => ({ ...p, [hash]: false }));
    }
  };

  // Always fetch (like fetchGitLog); dedup is handled at the call site (onOpenChange
  // guards on stashList === undefined, and the refresh button is disabled while loading).
  const fetchStash = async () => {
    setStashLoading(true);
    // A refresh is an explicit request for FRESH data, so drop the per-stash caches
    // and collapse any expanded stash row. Stash refs (`stash@{n}`) are reflog
    // selectors, NOT immutable keys like commit hashes — `stash@{0}` shifts to a
    // DIFFERENT stash whenever one is popped or created above it. Without this reset,
    // after the agent adds/pops a stash the refreshed subject (e.g. "WIP: B") would
    // render under a stale file list cached for the PREVIOUS stash@{0} (e.g. "WIP: A")
    // — subject and files would disagree, and toggleStash's dedup guard would keep
    // serving the stale entry on re-collapse. CommitFile's cache-by-hash pattern
    // doesn't have this problem because a hash always names the same commit (WARDEN-340).
    setStashShowCache({});
    setExpandedStashRef(null);
    try {
      const r = await fetch(`/api/git-stash?id=${encodeURIComponent(chatId)}`);
      const j = await r.json();
      setStashList(Array.isArray(j.stashes) ? j.stashes : []);
    } catch {
      setStashList([]);
    } finally {
      setStashLoading(false);
    }
  };

  // Always fetch (mirrors fetchStash); dedup is at the call site (onOpenChange
  // guards on reflogList === undefined, and the refresh button is disabled while
  // loading). Read-only — /api/git-reflog never mutates the repo.
  const fetchReflog = async () => {
    setReflogLoading(true);
    try {
      const r = await fetch(`/api/git-reflog?id=${encodeURIComponent(chatId)}`);
      const j = await r.json();
      setReflogList(Array.isArray(j.entries) ? j.entries : []);
    } catch {
      setReflogList([]);
    } finally {
      setReflogLoading(false);
    }
  };

  // Always fetch (mirrors fetchReflog); dedup is at the call site (onOpenChange
  // guards on remoteList === undefined). Read-only — /api/git-remote runs
  // `git remote -v`, which never mutates the repo.
  const fetchRemote = async () => {
    setRemoteLoading(true);
    try {
      const r = await fetch(`/api/git-remote?id=${encodeURIComponent(chatId)}`);
      const j = await r.json();
      setRemoteList(Array.isArray(j.remotes) ? j.remotes : []);
    } catch {
      setRemoteList([]);
    } finally {
      setRemoteLoading(false);
    }
  };

  // Always fetch (mirrors fetchReflog/fetchRemote); dedup is at the call site
  // (onOpenChange guards on branchList === undefined). Read-only — /api/git-branch
  // runs `git for-each-ref`, which never mutates the repo.
  const fetchBranches = async () => {
    setBranchLoading(true);
    try {
      const r = await fetch(`/api/git-branch?id=${encodeURIComponent(chatId)}`);
      const j = await r.json();
      setBranchList(Array.isArray(j.branches) ? j.branches : []);
    } catch {
      setBranchList([]);
    } finally {
      setBranchLoading(false);
    }
  };

  // WARDEN-975: the lazy-fetch trigger, re-anchored from the popover's onOpenChange
  // to the SECTION's expand. Identical policy, identical guards: fetch the local
  // recent commits, the incoming list (only when behind upstream), the outgoing list
  // (only when ahead), and shelved stashes (only when some are parked) on first
  // expand; fetch the reflog / remote / branch topology unconditionally (they are the
  // diagnostics for a repo that LOOKS clean, so they carry no count gate). Every call
  // is guarded on its cache being undefined, so a re-expand reuses it rather than
  // re-hitting the endpoint. Collapsing drops any active commit-message search so a
  // re-expand starts from the unfiltered browse lists (the popover did the same on
  // close — a stale term surviving would be confusing).
  //
  // Deps are the gate values only: the fetchers close over the freshest state and the
  // `=== undefined` guards make a repeat run a no-op, so re-running on a count change
  // (e.g. ahead 0 → 1 after a commit lands) is exactly the desired top-up.
  useEffect(() => {
    if (!expanded) {
      setGrepInput('');
      return;
    }
    if (commits === undefined && !loading) onFetch?.();
    if (behindCount > 0 && incomingCommits === undefined && !incomingLoading) onFetchIncoming?.();
    if (aheadCount > 0 && outgoingCommits === undefined && !outgoingLoading) onFetchOutgoing?.();
    if (stashN > 0 && stashList === undefined && !stashLoading) fetchStash();
    if (reflogList === undefined && !reflogLoading) fetchReflog();
    if (remoteList === undefined && !remoteLoading) fetchRemote();
    if (branchList === undefined && !branchLoading) fetchBranches();
    // Deps are the gate values only — NOT the fetchers. The parent's onFetch* props are
    // fresh arrows each render, so depending on them would re-run this every render;
    // the loading flags they'd bring are read inside the guards anyway. (oxlint's
    // exhaustive-deps warning here is deliberate, matching the several other
    // intentionally-narrow effect dep lists in this codebase.)
  }, [expanded, aheadCount, behindCount, stashN, commits, incomingCommits, outgoingCommits, stashList, reflogList, remoteList, branchList]);

  // WARDEN-528: resolve the ONE remote this section speaks for + the deep-link URLs.
  // A repo can have several remotes (origin, upstream, fork); the branch HEAD is on
  // tracks a specific one (`origin/feature` → the `origin` remote), so prefer that —
  // else the first remote with a web URL (conventionally `origin` in `git remote -v`
  // order). The branch / HEAD / upstream labels below deep-link to THAT host. When
  // there is no web-resolvable remote (non-git, SSH-only, or all bare paths) every
  // link is null and the origin row renders nothing — the badge stays as today.
  const primaryRemote = useMemo<GitRemote | null>(() => {
    if (!remoteList || remoteList.length === 0) return null;
    if (upstream) {
      const remoteName = upstream.split('/')[0];
      const tracked = remoteList.find((r) => r.name === remoteName);
      if (tracked) return tracked;
    }
    return remoteList.find((r) => r.web) ?? remoteList[0];
  }, [remoteList, upstream]);
  const originWeb = primaryRemote?.web ?? null;
  // Encode a ref for a /tree/ URL segment PRESERVING the path separator: a slash-
  // bearing branch (`feature/x`, the common case) must stay `feature/x` in the href,
  // not collapse to `feature%2Fx` (which hosts that don't decode %2F in the path
  // won't resolve). Each segment is still encoded so spaces/`#`/`?` are safe.
  const encodeTreeRef = (ref: string) => ref.split('/').map(encodeURIComponent).join('/');
  // branch → {web}/tree/{branch}; detached sha → {web}/commit/{sha}; the upstream
  // tracking ref (e.g. origin/feature) → {web}/tree/{feature} (remote prefix stripped,
  // but a slash-bearing branch like feature/x is preserved). All URL-encoded. null
  // when there is no web host to link to.
  const branchHref = !isDetached && branch && branch !== 'HEAD' && originWeb
    ? `${originWeb}/tree/${encodeTreeRef(branch)}` : null;
  const shaHref = isDetached && sha && originWeb ? `${originWeb}/commit/${encodeURIComponent(sha)}` : null;
  const upstreamBranch = upstream && upstream.includes('/') ? upstream.slice(upstream.indexOf('/') + 1) : upstream;
  const upstreamHref = !isDetached && upstream && originWeb && upstreamBranch
    ? `${originWeb}/tree/${encodeTreeRef(upstreamBranch)}` : null;

  const toggleCommit = (hash: string) => {
    if (expandedHash === hash) {
      setExpandedHash(null);
    } else {
      setExpandedHash(hash);
      if (!showCache[hash]) fetchShow(hash);
    }
  };

  // Fetch the changed files for ONE stash (the stash's tree diff vs its base) via
  // /api/git-stash-show. A parallel of fetchShow for commits — `ref` is the stash
  // reflog selector (stash@{n}) from parseStashList / /api/git-stash. Dedup'd so a
  // repeat expand reuses the cache instead of re-hitting the endpoint. (WARDEN-340)
  const fetchStashShow = async (ref: string) => {
    if (stashShowCache[ref] || stashShowLoading[ref]) return;
    setStashShowLoading((p) => ({ ...p, [ref]: true }));
    try {
      const r = await fetch(`/api/git-stash-show?id=${encodeURIComponent(chatId)}&ref=${encodeURIComponent(ref)}`);
      const j = await r.json();
      setStashShowCache((p) => ({ ...p, [ref]: { files: Array.isArray(j.files) ? j.files : [], error: j.error } }));
    } catch {
      setStashShowCache((p) => ({ ...p, [ref]: { files: [], error: 'fetch failed' } }));
    } finally {
      setStashShowLoading((p) => ({ ...p, [ref]: false }));
    }
  };

  // Toggle a stash's expand, mirroring toggleCommit. Expanded state keys off a
  // separate expandedStashRef (not expandedHash) so a stash and a commit can be
  // open at the same time. (WARDEN-340)
  const toggleStash = (ref: string) => {
    if (expandedStashRef === ref) {
      setExpandedStashRef(null);
    } else {
      setExpandedStashRef(ref);
      if (!stashShowCache[ref]) fetchStashShow(ref);
    }
  };

  // Collapsed ⇒ render no body (the section header alone speaks), but stay MOUNTED so
  // the caches above survive a collapse/expand round trip exactly as they survived a
  // popover close/reopen. The range-diff DiffViewer is a sibling of the body for the
  // same reason it was a sibling of the popover: it must outlive whatever opened it.
  return (
    <>
      {expanded && (
        <div className="flex flex-col px-1 pb-1 text-[10px]">
          <div className="mb-1 flex items-center justify-between gap-2 px-0.5">
            <span className="truncate text-[10px] font-medium text-muted-foreground">
              recent commits ·{' '}
              {isDetached ? (
                <>
                  detached
                  {sha && (shaHref ? (
                    // WARDEN-528: deep-link the detached HEAD commit to {web}/commit/<sha>.
                    <a href={shaHref} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()} title={`open commit ${sha} on the host`} className="font-mono text-primary underline underline-offset-2 hover:opacity-80">{` @ ${sha}`}</a>
                  ) : (
                    ` @ ${sha}`
                  ))}
                </>
              ) : branchHref ? (
                // WARDEN-528: deep-link the branch to {web}/tree/<branch>.
                <a href={branchHref} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()} title={`open branch ${branch} on the host`} className="text-primary underline underline-offset-2 hover:opacity-80">{branch}</a>
              ) : branch}
              {aheadCount > 0 && <span className="text-amber-400"> · ↑ {aheadCount} unpushed</span>}
            </span>
            <IconTooltip label="refresh" disabled={loading || incomingLoading || outgoingLoading}>
              <button
                type="button"
                // One ↻ refreshes ALL halves (local recent + incoming + outgoing), so a
                // human checking for fresh commits after a remote fetch doesn't have to
                // hunt for a second button.
                onClick={(e) => { e.stopPropagation(); onFetch?.(); if (behindCount > 0) onFetchIncoming?.(); if (aheadCount > 0) onFetchOutgoing?.(); }}
                className="shrink-0 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                disabled={loading || incomingLoading || outgoingLoading}
              >↻</button>
            </IconTooltip>
          </div>
          {/* WARDEN-528: the compact origin row — which source repo this checkout maps
              to. Renders ONLY when a remote was resolved (non-git / SSH-only / all-bare
              remotes render nothing, leaving the badge exactly as before). The host +
              owner/repo (or the raw URL for a non-web remote) deep-link to the repo's
              web home; when HEAD tracks an upstream, that ref links to its branch too.
              stopPropagation on each anchor keeps a click from toggling the popover —
              target="_blank" opens the system browser (mirrors MarkdownBody.tsx's <a>). */}
          {primaryRemote && (
            <div className="mb-1 flex flex-wrap items-center gap-x-1 gap-y-0.5 px-0.5 text-[10px] text-muted-foreground">
              {originWeb ? (
                <a
                  href={originWeb}
                  target="_blank"
                  rel="noreferrer noopener"
                  onClick={(e) => e.stopPropagation()}
                  title={`open ${originWeb} in the browser`}
                  className="inline-flex min-w-0 max-w-full items-center gap-0.5 text-primary underline underline-offset-2 hover:opacity-80"
                >
                  <ExternalLink className="size-2.5 shrink-0" />
                  <span className="min-w-0 truncate">{primaryRemote.host}{primaryRemote.owner && primaryRemote.repo ? ` · ${primaryRemote.owner}/${primaryRemote.repo}` : ''}</span>
                </a>
              ) : (
                // Non-web remote (bare/file/single-segment) — show the raw URL, not
                // clickable (no browser target exists). Owner/repo are absent here.
                <span className="inline-flex min-w-0 max-w-full items-center gap-0.5" title={primaryRemote.url}>
                  <ExternalLink className="size-2.5 shrink-0 opacity-40" />
                  <span className="min-w-0 truncate">{primaryRemote.url}</span>
                </span>
              )}
              {upstreamHref && (
                <>
                  <span className="text-muted-foreground/60">·</span>
                  <a
                    href={upstreamHref}
                    target="_blank"
                    rel="noreferrer noopener"
                    onClick={(e) => e.stopPropagation()}
                    title={`open ${upstream} on ${primaryRemote.host} in the browser`}
                    className="text-primary underline underline-offset-2 hover:opacity-80"
                  >
                    {upstream}
                  </a>
                </>
              )}
            </div>
          )}
          {/* WARDEN-498: commit-message search across every visible list. Debounced
              (the effect at the top of the component fetches on a 300ms settle). A
              non-empty term swaps each section's data source to its grep results via
              listFor; the ✕ clears it so the unfiltered browse lists return. shadcn
              <Input>/<Button> — never raw form elements (WARDEN-68); the leading Search
              icon + trailing clear use the shadcn icon-input convention (relative
              wrapper, absolutely-positioned affordances, padded input). Sizes are on the
              Tailwind scale (text-xs), not arbitrary literals (WARDEN-68 Rule 2).
              stopPropagation keeps typing/clearing from toggling the row/pane beneath.
              Searches the FULL message (subject + body), case-insensitive, over a wider
              window than the browse cap. */}
          <div className="relative mb-1">
            <Search className="pointer-events-none absolute left-1.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="text"
              value={grepInput}
              onChange={(e) => setGrepInput(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="search commit messages…"
              aria-label="search commit messages"
              className="h-6 text-xs md:text-xs pl-6 pr-6"
            />
            {(searching || searchLoading) && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={(e) => { e.stopPropagation(); setGrepInput(''); }}
                onKeyDown={(e) => e.stopPropagation()}
                aria-label="clear commit search"
                title="clear search"
                className="absolute right-0.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="size-3" />
              </Button>
            )}
          </div>
          {recent.error ? (
            <div className="px-1 py-1 text-[10px] text-destructive">search failed — try again</div>
          ) : recent.loading && (!recent.items || recent.items.length === 0) ? (
            <div className="flex items-center gap-1.5 px-1 py-1">
              <Skeleton className="size-2 rounded-full" /><span className="text-[10px] text-muted-foreground">{searching ? 'searching…' : 'loading…'}</span>
            </div>
          ) : recent.items && recent.items.length > 0 ? (
            <ul className="max-h-72 overflow-auto">
              {recent.items.map((cm) => (
                <li key={cm.hash} className="rounded">
                  <div
                    role="button"
                    tabIndex={0}
                    aria-expanded={expandedHash === cm.hash}
                    aria-label={`inspect files changed by commit ${cm.hash}`}
                    onClick={(e) => { e.stopPropagation(); toggleCommit(cm.hash); }}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleCommit(cm.hash); } }}
                    title="click to inspect the files this commit changed"
                    className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-accent cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                  >
                    <span className="shrink-0 font-mono text-[10px] text-cyan-400/80">{cm.hash}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[10px] text-foreground" title={cm.subject}>{cm.subject}</span>
                      <span className="block text-[10px] text-muted-foreground">{cm.date}{cm.author ? ` · ${cm.author}` : ''}</span>
                    </span>
                    <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{expandedHash === cm.hash ? '▾' : '▸'}</span>
                  </div>
                  {expandedHash === cm.hash && (
                    <div className="pb-1 pl-1">
                      <CommitMessage message={showCache[cm.hash]?.message} />
                      {showLoading[cm.hash] && !showCache[cm.hash] ? (
                        <div className="px-1 text-[10px] text-muted-foreground">loading files…</div>
                      ) : (showCache[cm.hash]?.files?.length ?? 0) > 0 ? (
                        <div className="flex flex-col gap-0.5">
                          {showCache[cm.hash]!.files!.map((f) => (
                            <CommitFile key={f.path} chatId={chatId} hash={cm.hash} file={f} onOpenFile={onOpenFile} />
                          ))}
                        </div>
                      ) : (
                        <div className="px-1 text-[10px] text-muted-foreground">{showCache[cm.hash]?.error ? 'failed to load' : 'no files'}</div>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-1 py-1 text-[10px] text-muted-foreground">{searching ? 'no matching commits' : 'no commits'}</div>
          )}
          {clean === false && (
            <div className="mt-1.5 border-t border-border pt-1.5">
              <div className="mb-1 flex items-center justify-between gap-2 px-0.5">
                <span className="flex items-center gap-1 text-[10px] font-medium text-yellow-400">
                  uncommitted · ±
                  {/* The ± magnitude (+N −M) — the SAME `git diff HEAD --shortstat` the
                      full diff below covers, so the chip's count and the diff content are
                      consistent by construction (WARDEN-411). Renders nothing for an
                      all-untracked WIP (DiffStatChip's own +0−0 guard). */}
                  <DiffStatChip diffstat={diffstat} />
                </span>
                {/* WARDEN-449: the ± axis's aggregated "full diff" — the net `git diff
                    HEAD` of every uncommitted (staged+unstaged) change as one view,
                    answering "what is this agent changing right now, in full?" without
                    expanding each dirty file (WARDEN-151). Mirrors the ↑/↓ affordances
                    (WARDEN-398); appears only when the tree is dirty (`clean === false`),
                    just as those appear only when ahead/behind > 0. A real <Button>
                    (WARDEN-68); closes the popover so the DiffViewer modal takes focus. */}
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={(e) => { e.stopPropagation(); setRangeDiff({ kind: 'worktree' }); }}
                  className="text-muted-foreground hover:text-yellow-300"
                  aria-label="view the full uncommitted diff"
                  title="view the aggregated uncommitted diff — net git diff HEAD"
                >
                  <GitCompare />
                  full diff
                </Button>
              </div>
            </div>
          )}
          {aheadCount > 0 && (
            <div className="mt-1.5 border-t border-border pt-1.5">
              <div className="mb-1 flex items-center justify-between gap-2 px-0.5">
                <span className="text-[10px] font-medium text-amber-400">unpushed · ↑ {aheadCount} ahead</span>
                {/* WARDEN-398: the net unified diff of the WHOLE unpushed set as one
                    view — answers "what is this agent about to push?" without expanding
                    each commit. A real <Button> (not a role=button div): it sits in the
                    plain section header, so there's no nested-interactive issue (the chip
                    + popover trigger are the only other buttons, neither an ancestor of
                    this portaled content) — per WARDEN-68. Closes the popover so the
                    DiffViewer modal takes focus. */}
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={(e) => { e.stopPropagation(); setRangeDiff({ kind: 'outgoing', count: aheadCount }); }}
                  className="text-muted-foreground hover:text-amber-300"
                  aria-label={`view the full unpushed diff (${aheadCount} commit${aheadCount === 1 ? '' : 's'})`}
                  title={`view the aggregated unpushed diff (${aheadCount} commit${aheadCount === 1 ? '' : 's'}) — net git diff @{u}..HEAD`}
                >
                  <GitCompare />
                  full diff
                </Button>
              </div>
              {outList.error ? (
                <div className="px-1 py-1 text-[10px] text-destructive">search failed — try again</div>
              ) : outList.loading && (!outList.items || outList.items.length === 0) ? (
                <div className="flex items-center gap-1.5 px-1 py-1">
                  <Skeleton className="size-2 rounded-full" /><span className="text-[10px] text-muted-foreground">{searching ? 'searching…' : 'loading…'}</span>
                </div>
              ) : outList.items && outList.items.length > 0 ? (
                <ul className="max-h-72 overflow-auto">
                  {outList.items.map((cm) => (
                    // Explorable (WARDEN-303): each row expands to its changed files +
                    // per-file diff via /api/git-show — these commits are local objects
                    // reachable from HEAD. The incoming list below is explorable too
                    // (WARDEN-348): reachability from @{u}'s remote-tracking ref — not
                    // HEAD-membership — is what makes git show reliable there. Mirrors
                    // the recent-commits row above, diverging only in the amber hash
                    // color to match this list's "unpushed" styling.
                    <li key={cm.hash} className="rounded">
                      <div
                        role="button"
                        tabIndex={0}
                        aria-expanded={expandedHash === cm.hash}
                        aria-label={`inspect files changed by commit ${cm.hash}`}
                        onClick={(e) => { e.stopPropagation(); toggleCommit(cm.hash); }}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleCommit(cm.hash); } }}
                        title="unpushed commit (local, not yet pushed) — click to inspect the files this commit changed"
                        className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-accent cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                      >
                        <span className="shrink-0 font-mono text-[10px] text-amber-400/80">{cm.hash}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[10px] text-foreground" title={cm.subject}>{cm.subject}</span>
                          <span className="block text-[10px] text-muted-foreground">{cm.date}{cm.author ? ` · ${cm.author}` : ''}</span>
                        </span>
                        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{expandedHash === cm.hash ? '▾' : '▸'}</span>
                      </div>
                      {expandedHash === cm.hash && (
                        <div className="pb-1 pl-1">
                          <CommitMessage message={showCache[cm.hash]?.message} />
                          {showLoading[cm.hash] && !showCache[cm.hash] ? (
                            <div className="px-1 text-[10px] text-muted-foreground">loading files…</div>
                          ) : (showCache[cm.hash]?.files?.length ?? 0) > 0 ? (
                            <div className="flex flex-col gap-0.5">
                              {showCache[cm.hash]!.files!.map((f) => (
                                <CommitFile key={f.path} chatId={chatId} hash={cm.hash} file={f} onOpenFile={onOpenFile} />
                              ))}
                            </div>
                          ) : (
                            <div className="px-1 text-[10px] text-muted-foreground">{showCache[cm.hash]?.error ? 'failed to load' : 'no files'}</div>
                          )}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="px-1 py-1 text-[10px] text-muted-foreground">{searching ? 'no matching commits' : 'no unpushed commits'}</div>
              )}
            </div>
          )}
          {behindCount > 0 && (
            <div className="mt-1.5 border-t border-border pt-1.5">
              <div className="mb-1 flex items-center justify-between gap-2 px-0.5">
                <span className="text-[10px] font-medium text-blue-400">incoming · ↓ {behindCount} behind</span>
                {/* WARDEN-398: the net unified diff of the WHOLE incoming set as one
                    view — answers "what will land if I bring this agent up to upstream?"
                    without expanding each commit. See the outgoing affordance above for
                    the <Button>-not-div rationale (WARDEN-68). */}
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={(e) => { e.stopPropagation(); setRangeDiff({ kind: 'incoming', count: behindCount }); }}
                  className="text-muted-foreground hover:text-blue-300"
                  aria-label={`view the full incoming diff (${behindCount} commit${behindCount === 1 ? '' : 's'})`}
                  title={`view the aggregated incoming diff (${behindCount} commit${behindCount === 1 ? '' : 's'}) — net git diff HEAD..@{u}`}
                >
                  <GitCompare />
                  full diff
                </Button>
              </div>
              {incList.error ? (
                <div className="px-1 py-1 text-[10px] text-destructive">search failed — try again</div>
              ) : incList.loading && (!incList.items || incList.items.length === 0) ? (
                <div className="flex items-center gap-1.5 px-1 py-1">
                  <Skeleton className="size-2 rounded-full" /><span className="text-[10px] text-muted-foreground">{searching ? 'searching…' : 'loading…'}</span>
                </div>
              ) : incList.items && incList.items.length > 0 ? (
                <ul className="max-h-72 overflow-auto">
                  {incList.items.map((cm) => (
                    // Explorable (WARDEN-348): an incoming commit is reachable from
                    // the branch's upstream remote-tracking ref (@{u}, a LOCAL object
                    // updated by the last git fetch), so a per-commit /api/git-show is
                    // reliable WITHOUT a pull — reachability, not HEAD-membership, is
                    // what git show needs. Mirrors the unpushed/outgoing rows above,
                    // diverging only in the blue hash color to match this list's styling.
                    <li key={cm.hash} className="rounded">
                      <div
                        role="button"
                        tabIndex={0}
                        aria-expanded={expandedHash === cm.hash}
                        aria-label={`inspect files changed by commit ${cm.hash}`}
                        onClick={(e) => { e.stopPropagation(); toggleCommit(cm.hash); }}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleCommit(cm.hash); } }}
                        title="incoming commit (behind upstream, already fetched) — click to inspect the files this commit changed"
                        className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-accent cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                      >
                        <span className="shrink-0 font-mono text-[10px] text-blue-400/80">{cm.hash}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[10px] text-foreground" title={cm.subject}>{cm.subject}</span>
                          <span className="block text-[10px] text-muted-foreground">{cm.date}{cm.author ? ` · ${cm.author}` : ''}</span>
                        </span>
                        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{expandedHash === cm.hash ? '▾' : '▸'}</span>
                      </div>
                      {expandedHash === cm.hash && (
                        <div className="pb-1 pl-1">
                          <CommitMessage message={showCache[cm.hash]?.message} />
                          {showLoading[cm.hash] && !showCache[cm.hash] ? (
                            <div className="px-1 text-[10px] text-muted-foreground">loading files…</div>
                          ) : (showCache[cm.hash]?.files?.length ?? 0) > 0 ? (
                            <div className="flex flex-col gap-0.5">
                              {showCache[cm.hash]!.files!.map((f) => (
                                <CommitFile key={f.path} chatId={chatId} hash={cm.hash} file={f} onOpenFile={onOpenFile} />
                              ))}
                            </div>
                          ) : (
                            <div className="px-1 text-[10px] text-muted-foreground">{showCache[cm.hash]?.error ? 'failed to load' : 'no files'}</div>
                          )}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="px-1 py-1 text-[10px] text-muted-foreground">{searching ? 'no matching commits' : 'no incoming commits'}</div>
              )}
            </div>
          )}
          {stashN > 0 && (
            <div className="mt-1.5 border-t border-border pt-1.5">
              <div className="mb-0.5 flex items-center justify-between gap-2 px-0.5">
                <span className="truncate text-[10px] font-medium text-fuchsia-400">🗄 stashed work · {stashN}</span>
                <IconTooltip label="refresh stashes" disabled={stashLoading}>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); fetchStash(); }}
                    className="shrink-0 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                    disabled={stashLoading}
                  >↻</button>
                </IconTooltip>
              </div>
              {stashLoading && stashList === undefined ? (
                <div className="flex items-center gap-1.5 px-1 py-1">
                  <Skeleton className="size-2 rounded-full" /><span className="text-[10px] text-muted-foreground">loading…</span>
                </div>
              ) : stashList && stashList.length > 0 ? (
                <ul className="max-h-40 overflow-auto">
                  {stashList.map((s, i) => (
                    // Explorable (WARDEN-340): each stash row expands to its changed
                    // files + per-file diff via /api/git-stash-show, mirroring the
                    // recent/outgoing commit rows above. A role="button" div (not a
                    // <button>) so it's keyboard-operable without nesting interactive
                    // rows (each StashFile is itself a role="button" div) inside this
                    // portaled popover — the same pattern CommitFile/the commit rows use.
                    <li key={s.ref || i} className="rounded">
                      <div
                        role="button"
                        tabIndex={0}
                        aria-expanded={expandedStashRef === s.ref}
                        aria-label={`inspect files in stash ${s.ref}`}
                        onClick={(e) => { e.stopPropagation(); toggleStash(s.ref); }}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleStash(s.ref); } }}
                        title="click to inspect the files this stash changed"
                        className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-accent cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[10px] text-foreground" title={s.subject}>{s.subject}</span>
                          {s.date && <span className="block text-[10px] text-muted-foreground">{s.date}</span>}
                        </span>
                        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{expandedStashRef === s.ref ? '▾' : '▸'}</span>
                      </div>
                      {expandedStashRef === s.ref && (
                        <div className="pb-1 pl-1">
                          {stashShowLoading[s.ref] && !stashShowCache[s.ref] ? (
                            <div className="px-1 text-[10px] text-muted-foreground">loading files…</div>
                          ) : (stashShowCache[s.ref]?.files?.length ?? 0) > 0 ? (
                            <div className="flex flex-col gap-0.5">
                              {stashShowCache[s.ref]!.files!.map((f) => (
                                <StashFile key={f.path} chatId={chatId} stashRef={s.ref} file={f} />
                              ))}
                            </div>
                          ) : (
                            <div className="px-1 text-[10px] text-muted-foreground">{stashShowCache[s.ref]?.error ? 'failed to load' : 'no files'}</div>
                          )}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="px-1 py-1 text-[10px] text-muted-foreground">no stashes</div>
              )}
            </div>
          )}
          {/* WARDEN-460: read-only "recent operations" (git reflog). The fourth axis
              alongside commits / working-tree / stash: the non-commit ops (reset,
              checkout, abandoned rebase, force-push) that leave no commit AND no dirty
              file. Rendered once the lazy fetch has started (no count gate — the reflog
              is the diagnostic for a repo that LOOKS clean), reusing the stash row
              styling. Expanded-view-only; no always-on badge. */}
          {(reflogList !== undefined || reflogLoading) && (
            <div className="mt-1.5 border-t border-border pt-1.5">
              <div className="mb-0.5 flex items-center justify-between gap-2 px-0.5">
                <span className="truncate text-[10px] font-medium text-muted-foreground">⏱ recent operations</span>
                <IconTooltip label="refresh operations" disabled={reflogLoading}>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); fetchReflog(); }}
                    className="shrink-0 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                    disabled={reflogLoading}
                  >↻</button>
                </IconTooltip>
              </div>
              {reflogLoading && reflogList === undefined ? (
                <div className="flex items-center gap-1.5 px-1 py-1">
                  <Skeleton className="size-2 rounded-full" /><span className="text-[10px] text-muted-foreground">loading…</span>
                </div>
              ) : reflogList && reflogList.length > 0 ? (
                <ul className="max-h-40 overflow-auto">
                  {reflogList.map((op, i) => (
                    /* WARDEN-460: key by index, NOT op.hash. A reflog records ops, and
                       several ops point HEAD at the SAME commit — `git reset --hard HEAD~1`
                       revisits a prior commit, so one hash can appear on multiple rows.
                       Unlike stash refs (stash@{0}, stash@{1}, …), the reflog has no
                       per-entry unique selector, so `op.hash || i` still collides on a
                       duplicated (non-empty) hash. The list is a static snapshot fetched on
                       expand/refresh, so positional keys are correct. */
                    <li key={i} className="rounded px-1 py-0.5 text-left">
                      {/* The subject IS the operation (git's %gs), e.g. "reset: moving to HEAD~1" / "checkout: moving from main to feat". */}
                      <span className="block truncate text-[10px] text-foreground" title={op.subject}>{op.subject}</span>
                      {op.hash && <span className="block text-[10px] text-muted-foreground"><span className="font-mono">{op.hash}</span>{op.date ? ` · ${op.date}` : ''}</span>}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="px-1 py-1 text-[10px] text-muted-foreground">no operations</div>
              )}
            </div>
          )}
          {/* WARDEN-577: the agent's local branches — the topology the badge's single
              current-branch name only gestures at. Each row: current-marker, name
              (bold + ● when HEAD is on it), `· Nd` freshness (reuses formatRelative,
              amber when stale like the badge append), `↑N`/`↓N` (ahead/behind, the
              same glyphs/colors the badge uses), an amber `gone` when the upstream
              tracking ref was deleted, and a green `✓` when merged into HEAD (shown
              only on non-current branches — current is trivially merged, so the ✓
              would be noise there; its ABSENCE on another branch is the "stranded
              work" signal). The name deep-links to {web}/tree/<branch> via the same
              primaryRemote web base + encodeTreeRef the HEAD/upstream links use
              (WARDEN-528); a repo with no web remote renders the name plain. Read-
              only throughout — list+render only, no checkout/merge/delete affordance
              (the WARDEN-199 line). stopPropagation on the link keeps a click from
              toggling the popover; target=_blank opens the system browser. */}
          {(branchList !== undefined || branchLoading) && (
            <div className="mt-1.5 border-t border-border pt-1.5">
              <div className="mb-0.5 flex items-center justify-between gap-2 px-0.5">
                <span className="truncate text-[10px] font-medium text-muted-foreground">⎇ branches · {branchList?.length ?? 0}</span>
                <IconTooltip label="refresh branches" disabled={branchLoading}>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); fetchBranches(); }}
                    className="shrink-0 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                    disabled={branchLoading}
                  >↻</button>
                </IconTooltip>
              </div>
              {branchLoading && branchList === undefined ? (
                <div className="flex items-center gap-1.5 px-1 py-1">
                  <Skeleton className="size-2 rounded-full" /><span className="text-[10px] text-muted-foreground">loading…</span>
                </div>
              ) : branchList && branchList.length > 0 ? (
                <ul className="max-h-40 overflow-auto">
                  {branchList.map((b, i) => {
                    const ms = b.headDate ? Date.parse(b.headDate) : NaN;
                    const fresh = Number.isFinite(ms);
                    const stale = fresh && Date.now() - ms > STALE_HEAD_AGE_MS;
                    const href = originWeb ? `${originWeb}/tree/${encodeTreeRef(b.name)}` : null;
                    const titleParts = [b.name];
                    if (b.current) titleParts.push('current');
                    if (b.gone) titleParts.push('upstream gone — remote tracking branch deleted, work is local-only');
                    else if (b.upstream) titleParts.push(`tracking ${b.upstream}`);
                    else titleParts.push('no remote tracking — local-only, not backed up');
                    if (fresh) titleParts.push(`last commit ${formatAbsoluteFull(ms)}`);
                    if (b.ahead > 0) titleParts.push(`${b.ahead} unpushed`);
                    if (b.behind > 0) titleParts.push(`${b.behind} behind remote`);
                    if (!b.merged) titleParts.push('not merged into HEAD — may carry unlanded commits');
                    return (
                      <li
                        /* key by name when stable; a duplicate/empty name (a
                           pathological repo) falls back to the positional index so
                           the list never crashes. */
                        key={b.name || i}
                        className="flex items-center gap-1 rounded px-1 py-0.5 text-left text-[10px]"
                      >
                        <span className={b.current ? 'text-cyan-400' : 'text-muted-foreground/40'}>{b.current ? '●' : '○'}</span>
                        {href ? (
                          <a
                            href={href}
                            target="_blank"
                            rel="noreferrer noopener"
                            onClick={(e) => e.stopPropagation()}
                            title={titleParts.join(' · ')}
                            className={cn('min-w-0 flex-1 truncate underline underline-offset-2 hover:opacity-80', b.current ? 'font-medium text-primary' : 'text-primary/80')}
                          >
                            {b.name}
                          </a>
                        ) : (
                          <span
                            title={titleParts.join(' · ')}
                            className={cn('min-w-0 flex-1 truncate', b.current ? 'font-medium text-foreground' : 'text-foreground/80')}
                          >
                            {b.name}
                          </span>
                        )}
                        {fresh && (
                          <span className={stale ? 'text-amber-400' : 'text-muted-foreground'}>· {formatRelative(ms)}</span>
                        )}
                        {b.ahead > 0 && <span className="text-amber-400">↑{b.ahead}</span>}
                        {b.behind > 0 && <span className="text-blue-400">↓{b.behind}</span>}
                        {b.gone && <span className="text-amber-400">gone</span>}
                        {b.merged && !b.current && <span className="text-green-400" title="merged into HEAD">✓</span>}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="px-1 py-1 text-[10px] text-muted-foreground">no branches</div>
              )}
            </div>
          )}
        </div>
      )}
      {/* WARDEN-398: the aggregated range-diff modal. Rendered as a sibling of the
          section body (not inside it) so it survives a collapse and Radix's Dialog
          portal stacks cleanly — the same sibling discipline it had beside the
          popover. Range mode fetches /api/git-range-diff; filePath is unused here. */}
      <DiffViewer
        chatId={chatId}
        filePath=""
        range={rangeDiff?.kind}
        count={rangeDiff?.count}
        diffstat={rangeDiff?.kind === 'worktree' ? diffstat : undefined}
        open={!!rangeDiff}
        onOpenChange={(o) => { if (!o) setRangeDiff(null); }}
      />
    </>
  );
}
