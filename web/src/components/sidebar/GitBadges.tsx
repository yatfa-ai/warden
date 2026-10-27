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
//   • GitRepoDetails (now in ./GitRepoDetails.tsx, WARDEN-1976) — the repo's full
//     detail (the old badge popover BODY): commit search, recent/unpushed/incoming
//     commit lists, stashes, reflog, branches, the origin row, and the aggregated
//     range-diff affordances.

import { useState } from 'react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { copyWithToast } from '@/lib/clipboardToast';
import { FileIcon } from 'lucide-react';
import { DiffBlock } from '@/components/DiffBlock';
import { cn } from '@/lib/utils';
import { basename } from '@/lib/chatDisplay';
import { formatTimestamp, formatAbsoluteFull } from '@/lib/formatTimestamp';
import { useTimestampFormat } from '@/lib/uiStore';
import type { GitCommit, GitFile, DiffStat } from './types';
import { DiffStatChip } from './DiffStatChip';
import { fetchBounded } from '@/lib/api';
import { readFileDiff } from '@/lib/gitDiffApi';

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
export const STALE_HEAD_AGE_MS = 7 * 86400_000;

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
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    if (!open && !fetched) {
      setLoading(true);
      // Clear any previous failure BEFORE retrying, so a retry that succeeds does
      // not render its diff underneath a stale error line.
      setError(null);
      try {
        // WARDEN-1187: read through the extracted seam, which honours BOTH halves
        // of warden's error convention (non-2xx, and the 200-with-{error} half the
        // `withGitRepo` no-cwd/catch-all paths use). It THROWS on failure, so the
        // failure can no longer arrive here disguised as an empty diff.
        // WARDEN-1144: bounded — this gates the row's `loading` ("loading diff…"),
        // whose only clear is the finally after this await. One-shot (an expand).
        const text = await readFileDiff(await fetchBounded(buildUrl()));
        // A genuinely empty diff stays empty and still renders "no diff" — only a
        // real failure takes the catch below.
        setDiff(text || null);
        // Cache the SUCCESS only. Setting this in a `finally` (as the pre-fix code
        // did) pinned a failed row to its error forever: the guard above is
        // `!open && !fetched`, so collapsing and re-expanding — the user's only
        // recovery affordance — silently did nothing until the component
        // remounted. On the failure path `fetched` stays false, so a re-expand
        // RE-ISSUES the fetch. Successful caching is unchanged.
        setFetched(true);
      } catch (e) {
        setDiff(null);
        setError(e instanceof Error && e.message ? e.message : 'Failed to load diff');
      } finally {
        setLoading(false);
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
        ) : error ? (
          // WARDEN-1187 / WARDEN-89: a backend failure is NOT "no diff". This row only
          // exists for a file the UI has already listed as changed, so rendering the
          // empty state here would assert — as a fact about the user's data — the exact
          // opposite of what the parent row just said. Kept in-place and quiet (the row
          // has no toast surface) at the row's own scale; `fetched` is not set on this
          // path, so collapsing and re-expanding retries the fetch.
          <div className="px-1 text-[10px] text-muted-foreground" role="status">
            could not load diff — {error}
          </div>
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
export function StashFile({ chatId, stashRef, file }: { chatId: string; stashRef: string; file: GitFile }) {
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

/** One expandable commit row — the `<li>` shared by all three commit lists in
 *  GitRepoDetails (recent, unpushed/outgoing, incoming). Click or Enter/Space
 *  toggles the row open, revealing the commit body (CommitMessage) plus its changed
 *  files, each a CommitFile whose per-file diff comes from /api/git-show.
 *
 *  The three lists had this block hand-copied three times (WARDEN-179 → 303/302 →
 *  348/347, each copy made from the last), 33 of 35 lines byte-identical. The ONLY
 *  behavior that varies between them is parameterized here: `hashClass` (the short
 *  hash's per-list tint — cyan recent / amber unpushed / blue incoming) and `title`
 *  (the row's hover, which names what KIND of commit this is before the shared
 *  "click to inspect…" clause). Everything else — the role="button" + tabIndex +
 *  aria-expanded + aria-label contract, the keyboard activation, the expansion body
 *  and its loading/failed/empty legs — is identical across the three and lives here
 *  once. Pure DRY extraction; zero behavior change. (WARDEN-1039.)
 *
 *  Expand state is NOT owned here: `expandedHash` / `toggleCommit` are threaded from
 *  the single enclosing GitRepoDetails, so all three lists keep sharing ONE open row
 *  (expanding an incoming commit still collapses an expanded recent one).
 *
 *  Module-level by requirement, matching the DiffInspectRow/CommitFile precedent:
 *  declaring it inside GitRepoDetails would make it a fresh component type every
 *  render, remounting the subtree and dropping the expanded row's state and focus. */
export function CommitRow({ cm, hashClass, title, expandedHash, toggleCommit, showCache, chatId, onOpenFile }: {
  cm: GitCommit;
  hashClass: string;
  title: string;
  expandedHash: string | null;
  toggleCommit: (hash: string) => void;
  showCache: Record<string, { files?: GitFile[]; message?: string; error?: string | null }>;
  chatId: string;
  onOpenFile?: (path: string) => void;
}) {
  return (
    <li className="rounded">
      {/* Themed right-click menu (Context-Menu Completeness roadmap / WARDEN-1297).
          The trigger wraps ONLY the row-header <div role="button"> below — the
          expansion body (CommitMessage + CommitFile rows) deliberately stays OUTSIDE
          it, so right-click inside an expanded commit's non-file regions does NOT
          resolve to this menu and the WARDEN-917 FILE menu on the CommitFile rows
          keeps its own coverage unambiguously. Same shape as the in-file
          GitChangedFile precedent and the fleet twin (FleetRecentCommits.tsx:390,
          "wraps the ROW div only").

          Radix's ContextMenu root renders no DOM and `asChild` merges only handlers,
          so the row's layout, role=button, tabIndex, aria-expanded/aria-label
          contract, the onClick toggle and the onKeyDown stopPropagation are all
          byte-identical — left-click and Enter/Space still expand. Pointer-context
          menu only, per the roadmap's desktop-pointer boundary.

          One wrap covers all THREE commit lists (recent · unpushed ↑N · incoming ↓N)
          because CommitRow is shared by design (WARDEN-1039). */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            role="button"
            tabIndex={0}
            aria-expanded={expandedHash === cm.hash}
            aria-label={`inspect files changed by commit ${cm.hash}`}
            onClick={(e) => { e.stopPropagation(); toggleCommit(cm.hash); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleCommit(cm.hash); } }}
            title={title}
            className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-accent cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
          >
            <span className={`shrink-0 font-mono text-[10px] ${hashClass}`}>{cm.hash}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[10px] text-foreground" title={cm.subject}>{cm.subject}</span>
              <span className="block text-[10px] text-muted-foreground">{cm.date}{cm.author ? ` · ${cm.author}` : ''}</span>
            </span>
            <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{expandedHash === cm.hash ? '▾' : '▸'}</span>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {/* Open-first house pattern (WARDEN-444/853/1263): the row's own primary
              action, surfaced in the menu for consistency. No new behavior — the
              same toggleCommit a left-click fires. */}
          <ContextMenuItem onSelect={() => toggleCommit(cm.hash)}>Inspect files</ContextMenuItem>
          {/* Every copy goes through copyWithToast — never bare navigator.clipboard,
              which fails silently in Electron. Wording mirrors the fleet twin. */}
          <ContextMenuItem onSelect={() => copyWithToast(cm.hash)}>Copy commit hash</ContextMenuItem>
          {/* The FULL subject: the row renders it `block truncate`, so on a long
              subject the on-screen text is not the whole value. */}
          <ContextMenuItem onSelect={() => copyWithToast(cm.subject)}>Copy commit subject</ContextMenuItem>
          {/* Author is rendered conditionally on the row (`cm.author ? …`), so the
              item mirrors that — no menu entry for a commit with no author. */}
          {cm.author && <ContextMenuItem onSelect={() => copyWithToast(cm.author)}>Copy author</ContextMenuItem>}
          {/* The displayed timestamp, verbatim (10px muted text, selection-hostile). */}
          <ContextMenuItem onSelect={() => copyWithToast(cm.date)}>Copy timestamp</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {expandedHash === cm.hash && (
        <div className="pb-1 pl-1">
          <CommitMessage message={showCache[cm.hash]?.message} />
          {!showCache[cm.hash] ? (
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
  // WARDEN-1342 (slice 4 — the reach fix): this freshness marker used to call
  // formatRelative directly, hardcoding relative mode on an always-visible row.
  // It honors the pref like every other timestamp surface now.
  const timestampFormat = useTimestampFormat();
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
        <span className={cn('shrink-0', headStale ? 'text-amber-400' : 'text-muted-foreground')}>· {formatTimestamp(headMs, timestampFormat)}</span>
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
