// Git-status UI subsystem extracted from ChatSidebar.tsx (WARDEN-315).
// Pure structural move — no behavior, props, classname, or DOM change.
// Groups: the changed-file row, the project-chip WIP/collision badges,
// and the per-row branch badge (+ its expanded-commit file rows).

import { useState, useEffect, useMemo } from 'react';
import { Popover as RadixPopover } from 'radix-ui';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { GitCompare, FileIcon, Search, X, ExternalLink } from 'lucide-react';
import { DiffBlock } from '@/components/DiffBlock';
import { DiffViewer } from '@/components/DiffViewer';
import { CollisionCompareDialog } from '../CollisionCompareDialog';
import { cn } from '@/lib/utils';
import { findChat } from '@/lib/agentFilter';
import { displayName } from '@/lib/chatDisplay';
import { type ProjectGitAgent, type FileCollision } from '@/lib/gitStateSummary';
import { formatWhatsNewLine, type WhatsNewSummary } from '@/lib/whatsNew';
import { formatRelative, formatAbsoluteFull } from '@/lib/formatTimestamp';
import type { Chat } from '@/lib/types';
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
      <span className="inline-flex items-center">
        {segments.map((s, i) => (
          <span key={i} className={s.cls}>{s.text}</span>
        ))}
      </span>
      <span className="min-w-0 flex-1 truncate">{file.path}</span>
      {/* WARDEN-478: an "open this file in the FileViewer" affordance — a sibling of
          the path, shrunk to the right edge. The path's flex-1 + min-w-0 keep it
          truncating so long paths never push this icon off the row. */}
      {onOpenFile && <OpenFileAffordance path={file.path} onOpenFile={onOpenFile} className="shrink-0 ml-1" />}
    </>
  );
  if (onOpen || onOpenConflict) {
    return (
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
        className="flex items-center gap-1 w-full text-left rounded-sm text-[10px] text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
      >
        {content}
      </button>
    );
  }
  return (
    <span className="flex items-center gap-1 text-[10px] text-muted-foreground">{content}</span>
  );
}

// Compact uncommitted/unpushed WIP badges appended to the project filter chips
// (WARDEN-201), now explorable (WARDEN-268). Renders nothing for a clean, pushed
// project — so the chips stay quiet unless an agent actually has uncommitted
// (yellow `±N`) or unpushed (amber `↑N`) work. Reuses GitBranchBadge's exact glyph
// + color vocabulary so the chip totals read as part of the same visual system as
// the per-row branch badge.
//
// Each badge is a popover listing exactly the agents behind the count (the `±N`
// popover shows the dirty agents; the `↑N` popover shows the unpushed ones), and
// every row is a jump-to: click → open that agent's chat and close the popover.
// This makes a fleet WIP signal actionable — "±3" now tells you *which* 3 agents
// are dirty without filtering the sidebar to the whole project and scanning it.
// No new fetch: the contributing agents come from the cached gitStatus map via
// summarizeProjectGitState; displayName/branch are joined here in the React layer.
// Per-kind rendering config for GitStateBadge. Adding a third axis (behind,
// WARDEN-297) is a row in this table rather than another branch in every
// ternary. Each kind picks its glyph, color, label, the predicate that matches
// its popover rows, and the per-row branch-line suffix. Colors stay in the same
// visual system as the per-row GitBranchBadge: dirty yellow ±, unpushed amber ↑,
// behind blue ↓.
const GIT_STATE_KIND = {
  dirty:   { glyph: '±', color: 'text-yellow-400 hover:text-yellow-300', label: 'uncommitted changes', match: (a: ProjectGitAgent) => a.dirty,     suffix: () => '' },
  unpushed: { glyph: '↑', color: 'text-amber-400 hover:text-amber-300',  label: 'unpushed commits',    match: (a: ProjectGitAgent) => a.ahead > 0, suffix: (a: ProjectGitAgent) => (a.ahead > 0 ? ` · ↑ ${a.ahead}` : '') },
  behind:   { glyph: '↓', color: 'text-blue-400 hover:text-blue-300',    label: 'behind upstream',     match: (a: ProjectGitAgent) => a.behind > 0, suffix: (a: ProjectGitAgent) => (a.behind > 0 ? ` · ↓ ${a.behind}` : '') },
} as const;

function GitStateBadge({ kind, count, agents, chats, gitStatus, onOpenChat }: {
  kind: 'dirty' | 'unpushed' | 'behind';
  count: number;
  // Already scoped to this chip (a project's subset, or `total.agents` for the
  // "All Projects" chip); filtered below by `kind`.
  agents: ProjectGitAgent[];
  chats: Chat[];
  // Minimal slice the popover rows read (just the branch label) — the full
  // gitStatus map ChatSidebar holds is structurally compatible.
  gitStatus: Record<string, { branch: string | null }>;
  onOpenChat: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (count <= 0) return null;
  const cfg = GIT_STATE_KIND[kind];
  const shown = agents.filter(cfg.match);
  const title = `${count} agent${count === 1 ? '' : 's'} with ${cfg.label} — click to list`;
  return (
    <RadixPopover.Root open={open} onOpenChange={setOpen}>
      <RadixPopover.Trigger asChild>
        {/* The chip is a real <button>, so the trigger is a role="button" <span>
            — NEVER a nested <button> (invalid HTML; browsers misbehave). The
            span needs its own keydown (Enter/Space) since a non-button doesn't
            synthesize a click from the keyboard. stopPropagation is mandatory so
            opening the popover does not also flip the project filter (the badge
            sits inside the chip's onClick=setProjectFilter button). Mirrors
            GitBranchBadge's trigger, just on a span instead of a button. */}
        <span
          role="button"
          tabIndex={0}
          aria-label={title}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              setOpen((o) => !o);
            }
          }}
          title={title}
          className={cn('ml-0.5 inline-flex items-center text-[10px] cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary', cfg.color)}
        >
          {cfg.glyph}{count}
        </span>
      </RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          sideOffset={4}
          align="start"
          onClick={(e) => e.stopPropagation()}
          className="z-50 min-w-56 max-w-80 rounded-md border border-border bg-popover p-1.5 text-popover-foreground shadow-lg outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
        >
          <div className="mb-1 px-0.5">
            <span className={cn('text-[10px] font-medium', cfg.color)}>
              {cfg.label} · {count} agent{count === 1 ? '' : 's'}
            </span>
          </div>
          <ul className="max-h-72 overflow-auto">
            {shown.map((a) => {
              const c = findChat(chats, a.key);
              const name = displayName(c);
              const branch = gitStatus[a.key]?.branch ?? null;
              return (
                <li key={a.key} className="rounded">
                  {/* role="button" div (not a <button>) so the row is keyboard-
                      operable without nesting interactive buttons inside the
                      portaled popover content. The CommitFile row uses the same
                      pattern. Click → jump to the agent + close the popover. */}
                  <div
                    role="button"
                    tabIndex={0}
                    aria-label={`open ${name}`}
                    onClick={(e) => { e.stopPropagation(); setOpen(false); onOpenChat(a.key); }}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setOpen(false); onOpenChat(a.key); } }}
                    title={`open ${name}`}
                    className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-accent cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[10px] text-foreground" title={name}>{name}</span>
                      {branch && (
                        <span className="block truncate text-[10px] text-cyan-400/80" title={branch}>
                          ⎇ {branch}{cfg.suffix(a)}
                        </span>
                      )}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}

export function GitStateBadges({ dirty, unpushed, behind, agents, chats, gitStatus, onOpenChat }: {
  dirty: number;
  unpushed: number;
  behind: number;
  agents: ProjectGitAgent[];
  chats: Chat[];
  gitStatus: Record<string, { branch: string | null }>;
  onOpenChat: (id: string) => void;
}) {
  return (
    <>
      <GitStateBadge kind="dirty" count={dirty} agents={agents} chats={chats} gitStatus={gitStatus} onOpenChat={onOpenChat} />
      <GitStateBadge kind="unpushed" count={unpushed} agents={agents} chats={chats} gitStatus={gitStatus} onOpenChat={onOpenChat} />
      <GitStateBadge kind="behind" count={behind} agents={agents} chats={chats} gitStatus={gitStatus} onOpenChat={onOpenChat} />
    </>
  );
}

// ⚠ badge for cross-agent file-edit collisions (WARDEN-288). Surfaces on a project
// chip (and the "All Projects" chip) when ≥2 active agents in that project each
// have the SAME file path in their uncommitted working tree — a divergence
// waiting to become a merge conflict. The proactive complement to WARDEN-185,
// which surfaces a conflict AFTER an agent is already blocked; this warns before
// either agent commits. A glance at the chip's ⚠N then tells a human which paths
// two agents are racing on, so they can coordinate before the collision lands.
//
// Mirrors GitStateBadge's explorable-popover structure exactly (so the two badges
// read as one system): a role="button" <span> trigger — NEVER a nested <button>,
// since the chip is itself a <button> (invalid HTML; browsers misbehave);
// stopPropagation on click/keydown so opening the popover does not also flip the
// project filter; a RadixPopover whose rows are role="button" <div>s that call
// onOpenChat(key) and close. The popover lists each colliding path as a header
// with its contributing agents beneath — a human can jump to either agent.
// No new fetch: the collisions come from the cached gitStatus map via
// detectProjectFileCollisions (which reads the per-chat `files` already cached).
export function GitCollisionBadge({ collisions, chats, gitStatus, onOpenChat, showProject }: {
  // Already scoped to this chip (a project's paths, or `total.paths` for the
  // "All Projects" chip). Empty ⇒ renders nothing (no ⚠ on a clean chip).
  collisions: FileCollision[];
  chats: Chat[];
  // Minimal slice the popover rows read (just the branch label) — the full
  // gitStatus map ChatSidebar holds is structurally compatible.
  gitStatus: Record<string, { branch: string | null }>;
  onOpenChat: (id: string) => void;
  // Show a project tag on each path header (the "All Projects" chip, where the
  // same path can collide in two different projects and needs disambiguation).
  // Looked up from the first contributor's chat in the React layer — the helper
  // stays display-field-free, exactly like ProjectGitAgent.
  showProject?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // The path + contributors scoped to the "Compare edits" dialog (WARDEN-321): set
  // by the per-path Compare action below, null while the dialog is closed. Lives
  // in the badge (not its parent) so the change stays minimal — the badge already
  // owns its popover `open` state and has collisions/chats/gitStatus/onOpenChat in
  // hand, which is everything the dialog needs.
  const [compareTarget, setCompareTarget] = useState<{ path: string; agents: FileCollision['agents'] } | null>(null);
  const count = collisions.length;
  if (count <= 0) return null;
  const title = `${count} file${count === 1 ? '' : 's'} edited by 2+ agents — click to list`;
  return (
    <>
    <RadixPopover.Root open={open} onOpenChange={setOpen}>
      <RadixPopover.Trigger asChild>
        {/* role="button" <span> (not a nested <button>): the chip is already a
            <button>, so the trigger must not be one. The span needs its own
            keydown (Enter/Space) since a non-button doesn't synthesize a click
            from the keyboard, and stopPropagation so opening the popover doesn't
            flip the project filter. Mirrors GitStateBadge's trigger. */}
        <span
          role="button"
          tabIndex={0}
          aria-label={title}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              setOpen((o) => !o);
            }
          }}
          title={title}
          className="ml-0.5 inline-flex items-center text-[10px] cursor-pointer rounded-sm text-red-400 hover:text-red-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
        >
          ⚠{count}
        </span>
      </RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          sideOffset={4}
          align="start"
          onClick={(e) => e.stopPropagation()}
          className="z-50 min-w-56 max-w-80 rounded-md border border-border bg-popover p-1.5 text-popover-foreground shadow-lg outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
        >
          <div className="mb-1 px-0.5">
            <span className="text-[10px] font-medium text-red-400">
              same file · 2+ agents · {count} path{count === 1 ? '' : 's'}
            </span>
          </div>
          <div className="max-h-72 overflow-auto flex flex-col gap-1">
            {collisions.map((col) => {
              // The project the first contributor belongs to — disambiguates the
              // same path colliding in two different projects on the "All Projects" chip.
              const project = showProject ? findChat(chats, col.agents[0]?.key)?.project : undefined;
              return (
                <div key={`${col.path}·${col.agents.map((a) => a.key).join(',')}`} className="rounded">
                  <div className="flex items-center gap-1 px-1 py-0.5" title={col.path}>
                    <span className="truncate text-[10px] text-foreground">{col.path}</span>
                    {project && (
                      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground" title={project}>{project}</span>
                    )}
                  </div>
                  {/* The resolution layer (WARDEN-321): open the per-path compare
                      dialog showing each agent's uncommitted diff stacked. A real
                      shadcn <Button> — the header row above is plain, so there's no
                      nested-interactive issue (the chip and the popover trigger are
                      the only buttons/role=button in play) — per WARDEN-68.
                      stopPropagation + close the popover so the dialog takes focus,
                      mirroring the per-agent rows' setOpen(false) + jump discipline. */}
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={(e) => { e.stopPropagation(); setOpen(false); setCompareTarget({ path: col.path, agents: col.agents }); }}
                    className="ml-1 mb-0.5 text-muted-foreground hover:text-foreground"
                    aria-label={`compare each agent's uncommitted edits to ${col.path}`}
                    title={`compare each agent's uncommitted edits to ${col.path}`}
                  >
                    <GitCompare />
                    Compare edits
                  </Button>
                  <ul>
                    {col.agents.map((a) => {
                      const c = findChat(chats, a.key);
                      const name = displayName(c);
                      const branch = gitStatus[a.key]?.branch ?? null;
                      return (
                        <li key={a.key} className="rounded">
                          {/* role="button" div (not a <button>) so the row is keyboard-
                              operable without nesting interactive buttons inside the
                              portaled popover content. Mirrors GitStateBadge's rows.
                              Click → jump to the agent + close the popover. */}
                          <div
                            role="button"
                            tabIndex={0}
                            aria-label={`open ${name}`}
                            onClick={(e) => { e.stopPropagation(); setOpen(false); onOpenChat(a.key); }}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setOpen(false); onOpenChat(a.key); } }}
                            title={`open ${name}`}
                            className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-accent cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[10px] text-foreground" title={name}>{name}</span>
                              {branch && (
                                <span className="block truncate text-[10px] text-cyan-400/80" title={branch}>
                                  ⎇ {branch}
                                </span>
                              )}
                            </span>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
      {/* Scoped to the path + contributors selected by the Compare action above.
          Rendered as a sibling of the popover (not inside it) so Radix's Dialog
          portal stacks cleanly above the already-dismissed popover. */}
      <CollisionCompareDialog
        open={!!compareTarget}
        onOpenChange={(o) => { if (!o) setCompareTarget(null); }}
        path={compareTarget?.path ?? ''}
        agents={compareTarget?.agents ?? []}
        chats={chats}
        gitStatus={gitStatus}
        onOpenChat={onOpenChat}
      />
    </>
  );
}

/** One touched-file row inside an expanded commit. Click to fetch and reveal the
 *  committed diff for that file (`git show --format= <hash> -- <path>`). Owns its
 *  diff fetch state so a re-collapse/re-expand is instant. */
function CommitFile({ chatId, hash, file, onOpenFile }: { chatId: string; hash: string; file: GitFile; onOpenFile?: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetched, setFetched] = useState(false);

  const toggle = async () => {
    if (!open && !fetched) {
      setLoading(true);
      try {
        const r = await fetch(`/api/git-show?id=${encodeURIComponent(chatId)}&hash=${encodeURIComponent(hash)}&path=${encodeURIComponent(file.path)}`);
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
        aria-label={`inspect committed diff for ${file.path}`}
        onClick={(e) => { e.stopPropagation(); toggle(); }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggle(); } }}
        title="click to inspect this file's committed diff"
        className="flex w-full items-center gap-1 rounded px-0.5 py-px text-left hover:bg-accent cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
      >
        <div className="min-w-0 flex-1"><GitChangedFile file={file} /></div>
        {/* WARDEN-478: open this committed file in the FileViewer. The flex-1 path
            wrapper above packs this icon + the toggle to the right edge. The inner
            GitChangedFile is rendered WITHOUT onOpenFile so it stays a non-interactive
            <span> (no nested affordance) — this row owns the only open-file control. */}
        {onOpenFile && <OpenFileAffordance path={file.path} onOpenFile={onOpenFile} className="shrink-0" />}
        <span className="shrink-0 text-[10px] text-muted-foreground">{loading ? '…' : open ? '▾' : '▸'}</span>
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

/** The commit's body — the "why" behind the change — rendered above the changed-
 *  files list inside an expanded commit. Undefined/empty → renders nothing, so a
 *  subject-only commit stays compact (the collapsed row already shows the subject).
 *  whitespace-pre-wrap preserves the message's own line breaks; break-words +
 *  muted text-[10px] match DiffBlock's density. (WARDEN-388) */
function CommitMessage({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <div className="whitespace-pre-wrap break-words px-1 pb-0.5 text-[10px] text-muted-foreground">{message}</div>
  );
}

// The cyan branch badge (+ yellow ±). Made interactive: click opens a popover showing
// the last few commits (git log) for the chat's repo. Commits are lazily fetched on
// first open and cached by chatId; the ↻ affordance re-fetches. The popover is portaled
// to document.body via Radix Popover so it isn't clipped by the `truncate` name span
// this badge sits inside (in ChatRow). stopPropagation on clicks keeps it from also
// opening the chat pane (mirrors the other inline buttons in these rows).
export function GitBranchBadge({ branch, clean, commits, loading, onFetch, ahead, behind, chatId, inProgress, stashCount, diffstat, incomingCommits, incomingLoading, onFetchIncoming, outgoingCommits, outgoingLoading, onFetchOutgoing, detached, headSha, headDate, upstream, onOpenFile, className }: {
  branch: string;
  clean: boolean | null;
  commits?: GitCommit[];
  loading?: boolean;
  onFetch?: () => void;
  ahead?: number | null;
  behind?: number | null;
  chatId: string;
  inProgress?: { operation: string | null; detail?: string | null };
  stashCount?: number | null;
  // WARDEN-411: net insertions/deletions of the working-tree edits vs HEAD, or
  // null when clean/unavailable. Surfaced in the badge tooltip so a hover shows
  // the magnitude alongside the ± dirty glyph; the on-surface glyph stays a bare
  // ± to avoid cluttering the already-dense badge (the chip lives in the file list).
  diffstat?: DiffStat | null;
  // WARDEN-225: the "behind" half — commits @{u} has that HEAD doesn't. Lazily
  // fetched on open when behindCount > 0, with its own cache/loader so it refreshes
  // independently of the local recent-commits list. Explorable (WARDEN-348): each row
  // expands to its changed files + per-file diff via /api/git-show — these are local
  // objects reachable from the upstream remote-tracking ref (@{u}), so git show serves
  // them without a pull.
  incomingCommits?: GitCommit[];
  incomingLoading?: boolean;
  onFetchIncoming?: () => void;
  // WARDEN-252: the "ahead/unpushed" half — commits HEAD has that @{u} doesn't. The
  // symmetric counterpart to incomingCommits. Lazily fetched on open when aheadCount
  // > 0, with its own cache/loader. Explorable (WARDEN-303): each row expands to its
  // changed files + per-file diff via /api/git-show. Both halves are explorable —
  // outgoing commits are reachable from HEAD, incoming from @{u} (WARDEN-348).
  outgoingCommits?: GitCommit[];
  outgoingLoading?: boolean;
  onFetchOutgoing?: () => void;
  // WARDEN-239: HEAD is not on a branch (an agent checked out a specific commit).
  // Rendered as a distinct amber glyph + the short SHA instead of the misleading
  // literal "HEAD" branch label. ahead/behind are null on detached (no @{u}).
  detached?: boolean;
  headSha?: string | null;
  // WARDEN-545: the strict ISO-8601 committer date of HEAD (git %cI) — the last-
  // commit FRESHNESS, threaded end-to-end from /api/git-status. Rendered as an
  // always-on `· Nd` append on the un-expanded badge so a human scanning the
  // sidebar can pick out a synced-but-stalled agent (committed days ago, silent
  // since) without expanding its commit list; ahead/behind measure divergence
  // from upstream, never recency. Stale (>7d) gets a warning tint. null when the
  // repo has no commits / is non-git, or for a branch-less cwd.
  headDate?: string | null;
  // WARDEN-243: the short upstream tracking branch (e.g. origin/feature), or null
  // when HEAD has no upstream — a named branch never `push -u`'d. ahead/behind are
  // null either way (no @{u}), so without this a non-tracking branch is a bare
  // cyan label indistinguishable from a synced 0/0 branch. When null (and not
  // detached) the badge renders a distinct muted "no remote" marker so the
  // durability risk (local-only work, no remote backup) is visible at a glance.
  upstream?: string | null;
  // WARDEN-478: open a touched file's full content in the FileViewer from inside
  // this badge's commit popovers. Threaded down to each CommitFile row (recent,
  // outgoing, incoming) so a committed file is readable — with blame/history one
  // click away — not just diffable. Optional: omitted call sites render unchanged.
  onOpenFile?: (path: string) => void;
  className?: string;
}) {
  const aheadCount = typeof ahead === 'number' ? ahead : 0;
  const behindCount = typeof behind === 'number' ? behind : 0;
  // Shelved work-in-progress (`git stash`): porcelain status is clean while real,
  // recoverable work is parked, so the count is surfaced separately (WARDEN-211).
  const stashN = typeof stashCount === 'number' ? stashCount : 0;
  // The operation an agent is blocked mid-way through (merge/rebase/cherry-pick/
  // revert/bisect), or null when none is in progress. This is the highest-value
  // signal in the badge: a blocked agent produces nothing until noticed (WARDEN-186).
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
  // false and no marker renders (a repo with no commits / non-git cwd). The marker
  // is always-on for BOTH branch AND detached agents: headDate is fetched
  // unconditionally server-side (gated on `branch`, which is the literal 'HEAD'
  // for detached), so this proves the unconditional fetch reaches detached agents
  // too — the whole point of the Refinement-1 fix. Stale (>7d) gets an amber tint
  // so quiet agents pop; fresh stays muted so active ones recede into the row.
  const STALE_HEAD_AGE_MS = 7 * 86400_000;
  const headMs = typeof headDate === 'string' && headDate ? Date.parse(headDate) : NaN;
  const headFresh = Number.isFinite(headMs);
  const headStale = headFresh && Date.now() - headMs > STALE_HEAD_AGE_MS;
  // WARDEN-243: a named branch with NO upstream tracking (never `push -u`'d) is
  // local-only work with no remote backup — a durability risk a human glancing at
  // the badge needs to see. Distinct from a synced 0/0 branch (which HAS an
  // upstream): ahead/behind are null in BOTH cases, so the upstream name is the
  // only signal. Excluded for detached HEAD (branch === 'HEAD', rendered as its
  // own amber glyph by WARDEN-239 — a detached HEAD has no @{u} by definition).
  const noUpstream = !isDetached && !!branch && branch !== 'HEAD' && !upstream;
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
    const mag = diffstat && diffstat.insertions + diffstat.deletions > 0 ? ` (+${diffstat.insertions} −${diffstat.deletions})` : '';
    titleParts.push(`uncommitted changes${mag}`);
  }
  if (stashN > 0) titleParts.push(`${stashN} stashed`);
  if (!isDetached && aheadCount > 0) titleParts.push(`${aheadCount} unpushed`);
  if (!isDetached && behindCount > 0) titleParts.push(`${behindCount} behind remote`);

  // Per-commit expand state + the /api/git-show files cache (keyed by hash) so a
  // repeat expansion is instant. The popover owns the interaction, so this state
  // lives here rather than being prop-drilled through ChatRow/ChatSidebar.
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

  // WARDEN-398: the aggregated range-diff modal target. Set by the "View full diff"
  // affordance in the outgoing (↑N) or incoming (↓N) section; null while closed.
  // WARDEN-449: extended to the ± (worktree) axis — `git diff HEAD`, no count (the
  // magnitude is the in-scope `diffstat` prop, not a commit count). Rendered by the
  // generalized DiffViewer (range mode) as a sibling of this popover.
  const [rangeDiff, setRangeDiff] = useState<{ kind: 'outgoing' | 'incoming' | 'worktree'; count?: number } | null>(null);
  // Controlled open so the "View full diff" affordance can dismiss this popover
  // before the DiffViewer modal opens on top (mirrors GitStateBadge's /
  // GitCollisionBadge's setOpen(false) + open-dialog discipline).
  const [popoverOpen, setPopoverOpen] = useState(false);

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

  // WARDEN-528: resolve the ONE remote this badge speaks for + the deep-link URLs.
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

  return (
    <>
    <RadixPopover.Root open={popoverOpen} onOpenChange={(open) => {
      setPopoverOpen(open);
      if (!open) {
        // WARDEN-498: drop any active commit-message search on close so a reopen starts
        // from the unfiltered browse list (a stale term persisting across opens would be
        // confusing — and the search effect's clear-on-empty path drops its results).
        setGrepInput('');
        return;
      }
      // Lazy-fetch ALL signals on first open: the local recent commits, the incoming
      // list (only when behind upstream), and shelved stashes (only when some are
      // parked). Each fetch is guarded so a repeat open reuses the cache instead of
      // re-hitting the endpoint.
      if (commits === undefined && !loading) onFetch?.();
      if (behindCount > 0 && incomingCommits === undefined && !incomingLoading) onFetchIncoming?.();
      if (aheadCount > 0 && outgoingCommits === undefined && !outgoingLoading) onFetchOutgoing?.();
      if (stashN > 0 && stashList === undefined && !stashLoading) fetchStash();
      // WARDEN-460: the reflog (operation history) is the diagnostic for a repo
      // that looks clean but has done something surprising, so it has no count
      // gate — fetch it on every first open (guarded so repeat opens reuse cache).
      if (reflogList === undefined && !reflogLoading) fetchReflog();
      // WARDEN-528: the remote identity (which repo host this maps to) is relevant
      // for every repo — not just a dirty one — so it has no count gate either.
      if (remoteList === undefined && !remoteLoading) fetchRemote();
      // WARDEN-577: the local branch topology is relevant for every repo too (not
      // just a dirty one), so it has no count gate — fetch on every first open
      // (guarded so repeat opens reuse the cache), alongside reflog/remote.
      if (branchList === undefined && !branchLoading) fetchBranches();
    }}>
      <RadixPopover.Trigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className={cn('inline-flex items-center gap-0.5 text-[10px] cursor-pointer', isDetached ? 'text-amber-400 hover:text-amber-300' : 'text-cyan-400 hover:text-cyan-300', className)}
          title={`${titleParts.join(' · ')} — click for recent commits`}
        >
          {operation && <span className="text-red-400 font-medium" title={inProgressTitle || `${operation} in progress`}>⚠ {operation}</span>}
          {isDetached ? (
            <>
              <span title="detached HEAD — commits not on a branch; at risk if reflog expires">⎇</span>
              {sha && <span className="font-mono">{sha}</span>}
            </>
          ) : branch}
          {headFresh && (
            // WARDEN-545: always-on `· Nd` last-commit freshness append. Stale
            // (>7d) tints amber so a quiet agent pops while fresh ones stay muted.
            // Rendered for branch AND detached agents (headDate is fetched
            // unconditionally server-side), so a human scanning the un-expanded
            // sidebar can pick out stalled agents without expanding a commit list.
            <span className={headStale ? 'text-amber-400' : 'text-muted-foreground'}>· {formatRelative(headMs)}</span>
          )}
          {clean === false && <span className="text-yellow-400">±</span>}
          {noUpstream && <span className="text-muted-foreground" title="no remote tracking — local-only work, not backed up remotely">🔒</span>}
          {aheadCount > 0 && <span className="text-amber-400">↑{aheadCount}</span>}
          {behindCount > 0 && <span className="text-blue-400">↓{behindCount}</span>}
          {stashN > 0 && <span className="text-fuchsia-400" title={`${stashN} stashed`}>🗄{stashN}</span>}
        </button>
      </RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          sideOffset={4}
          align="start"
          onClick={(e) => e.stopPropagation()}
          className="z-50 min-w-64 max-w-80 rounded-md border border-border bg-popover p-1.5 text-popover-foreground shadow-lg outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
        >
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
                  onClick={(e) => { e.stopPropagation(); setPopoverOpen(false); setRangeDiff({ kind: 'worktree' }); }}
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
                  onClick={(e) => { e.stopPropagation(); setPopoverOpen(false); setRangeDiff({ kind: 'outgoing', count: aheadCount }); }}
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
                  onClick={(e) => { e.stopPropagation(); setPopoverOpen(false); setRangeDiff({ kind: 'incoming', count: behindCount }); }}
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
                    <li key={s.ref || i} className="rounded px-1 py-0.5 text-left">
                      <span className="block truncate text-[10px] text-foreground" title={s.subject}>{s.subject}</span>
                      {s.date && <span className="block text-[10px] text-muted-foreground">{s.date}</span>}
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
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
      {/* WARDEN-398: the aggregated range-diff modal. Rendered as a sibling of the
          popover (not inside it) so Radix's Dialog portal stacks cleanly above the
          already-dismissed popover — the same sibling discipline CollisionCompareDialog
          uses. Range mode fetches /api/git-range-diff; filePath is unused here. */}
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

// ---- Per-agent "What's new since you last looked" (WARDEN-356) --------------
//
// The marker + catch-up popover for the rare-visitor human: a glanceable indigo
// pill on a sidebar row when commits have landed on THIS agent since the human
// last visited it — the one-glance answer to "which of my agents shipped work I
// haven't seen?" Clicking opens the "What's new since your last visit" popover
// (the catch-up view) listing the new commits + current working-tree changes +
// stash, with a one-glance summary line ("3 new commits · 7 changed files ·
// 1 stash"). No new fetch — it renders from the git-log + git-status data the
// row already holds.
//
// Visually DISTINCT from the other sidebar signals by design (AC #2):
//   • stuck / erroring (WARDEN-343) → red ⚠ op in GitBranchBadge
//   • new terminal output            → cyan "new" pill in PaneTile
//   • currently dirty / unpushed     → the ± ↑ ↓ badges (current state)
// This is a SINCE-signal ("commits landed since YOUR last visit"), not a state-
// signal, so it clears the moment the pane is opened/focused again (App re-stamps
// lastSeen). Indigo is unused by any git badge, so the marker can't be mistaken
// for one of them.

/**
 * The catch-up popover: the new commits + current working-tree changes + stash,
 * behind a one-glance summary line. Reuses GitChangedFile so each changed-file
 * row opens the per-file DiffViewer exactly like the inline list does. Rendered
 * portaled via Radix so it isn't clipped by the row's `truncate` name span.
 */
function WhatsNewPopoverContent({ summary, files, diffstat, onOpenDiff, onOpenConflict, onOpenFile }: {
  summary: WhatsNewSummary;
  files?: GitFile[];
  // WARDEN-411: working-tree edit magnitude (insertions/deletions), rendered as a
  // +N −M chip in the working-tree header. null/zero (clean or all-untracked WIP)
  // → DiffStatChip renders nothing.
  diffstat?: DiffStat | null;
  onOpenDiff?: (path: string, staged?: boolean) => void;
  onOpenConflict?: (path: string) => void;
  // WARDEN-478: open a catch-up-view dirty file in the FileViewer (mirrors onOpenDiff).
  onOpenFile?: (path: string) => void;
}) {
  const line = formatWhatsNewLine(summary);
  const hasFiles = (files?.length ?? 0) > 0;
  return (
    <RadixPopover.Content
      sideOffset={4}
      align="start"
      onClick={(e) => e.stopPropagation()}
      className="z-50 min-w-64 max-w-80 rounded-md border border-border bg-popover p-1.5 text-popover-foreground shadow-lg outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
    >
      <div className="mb-1 px-0.5">
        <span className="text-[10px] font-medium text-indigo-400">What's new since your last visit</span>
        {line && <div className="text-[10px] text-muted-foreground">{line}</div>}
      </div>
      {summary.newCommits.length > 0 && (
        <div className="mb-1">
          <div className="px-0.5 pb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground/70">
            ● new commits · {summary.newCommits.length}{summary.truncated ? '+' : ''}
          </div>
          <ul className="max-h-60 overflow-auto">
            {summary.newCommits.map((cm) => (
              // Display-only (like the incoming list in GitBranchBadge): the
              // commit is already in HEAD, but the per-commit /api/git-show expand
              // is intentionally omitted from the catch-up view to keep it a
              // one-glance summary — the GitBranchBadge popover remains the place
              // to drill into a commit's files.
              <li key={cm.hash} className="rounded px-1 py-0.5 text-left">
                <div className="flex items-center gap-1.5">
                  <span className="shrink-0 font-mono text-[10px] text-indigo-400/80">{cm.hash}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[10px] text-foreground" title={cm.subject}>{cm.subject}</span>
                    <span className="block text-[10px] text-muted-foreground">{cm.date}{cm.author ? ` · ${cm.author}` : ''}</span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {hasFiles && files && (
        <div className={summary.newCommits.length > 0 ? 'mt-1 border-t border-border pt-1' : ''}>
          <div className="px-0.5 pb-0.5 flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground/70">
            <span>± working-tree changes · {files.length}</span>
            {/* WARDEN-411: the "and how much" extension — magnitude chip alongside
                the file count. tracking-normal/normal-case shed the header's
                uppercase+wide-tracking so the +N −M reads as a clean diffstat. */}
            <DiffStatChip diffstat={diffstat} className="tracking-normal normal-case" />
          </div>
          <div className="flex flex-col gap-0.5">
            {files.map((file, i) => (
              <GitChangedFile key={file.path + '-' + i} file={file} onOpen={onOpenDiff} onOpenConflict={onOpenConflict} onOpenFile={onOpenFile} />
            ))}
          </div>
        </div>
      )}
      {summary.stashCount > 0 && (
        <div className="mt-1 border-t border-border pt-1 px-0.5">
          <span className="text-[10px] text-fuchsia-400">🗄 {summary.stashCount} stash{summary.stashCount === 1 ? '' : 'es'} shelved</span>
        </div>
      )}
    </RadixPopover.Content>
  );
}

/**
 * The per-agent unreviewed-progress marker. A subtle indigo "✦N" pill; clicking
 * opens the WhatsNewPopoverContent catch-up view. Renders nothing when there's
 * no progress since the last visit (the caller passes the precomputed summary +
 * `since`; this double-checks the gate so a stale call site can't paint a "0").
 */
export function WhatsNewMarker({ summary, since, files, diffstat, onOpenDiff, onOpenConflict, onOpenFile }: {
  summary: WhatsNewSummary;
  // The raw lastSeen epoch (null = never visited). Used both to gate visibility
  // and to anchor the tooltip's "since your last visit" framing.
  since: number | null;
  files?: GitFile[];
  // WARDEN-411: working-tree edit magnitude, passed through to the catch-up
  // popover's working-tree header chip.
  diffstat?: DiffStat | null;
  onOpenDiff?: (path: string, staged?: boolean) => void;
  onOpenConflict?: (path: string) => void;
  // WARDEN-478: open a catch-up-view dirty file in the FileViewer.
  onOpenFile?: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const count = summary.newCommits.length;
  // Gate: never visited, or visited but nothing new → render nothing.
  if (since === null || count === 0) return null;
  // "+" when truncated: the fetch hit its cap with all-new commits, so there may
  // be more beyond the window — never silently understate "what you missed."
  const plus = summary.truncated ? '+' : '';
  const title = `${count}${plus} commit${count === 1 && !summary.truncated ? '' : 's'} since your last visit — click to review`;
  return (
    <RadixPopover.Root open={open} onOpenChange={setOpen}>
      <RadixPopover.Trigger asChild>
        {/* A real <button> (the row is role="button"); stopPropagation so opening
            the popover does not also open the chat pane — mirrors GitBranchBadge. */}
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          aria-label={title}
          title={title}
          className="ml-1 inline-flex items-center text-[10px] text-indigo-400 hover:text-indigo-300 bg-indigo-500/10 hover:bg-indigo-500/20 px-1 rounded cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary transition-colors duration-150"
        >
          ✦{count}{plus}
        </button>
      </RadixPopover.Trigger>
      <RadixPopover.Portal>
        <WhatsNewPopoverContent summary={summary} files={files} diffstat={diffstat} onOpenDiff={onOpenDiff} onOpenConflict={onOpenConflict} onOpenFile={onOpenFile} />
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
