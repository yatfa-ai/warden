// Git-status UI subsystem extracted from ChatSidebar.tsx (WARDEN-315).
// Pure structural move — no behavior, props, classname, or DOM change.
// Groups: the changed-file row, the project-chip WIP/collision badges,
// and the per-row branch badge (+ its expanded-commit file rows).

import { useState } from 'react';
import { Popover as RadixPopover } from 'radix-ui';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { GitCompare } from 'lucide-react';
import { DiffBlock } from '@/components/DiffBlock';
import { CollisionCompareDialog } from '../CollisionCompareDialog';
import { cn } from '@/lib/utils';
import { findChat } from '@/lib/agentFilter';
import { displayName } from '@/lib/chatDisplay';
import { type ProjectGitAgent, type FileCollision } from '@/lib/gitStateSummary';
import { formatWhatsNewLine, type WhatsNewSummary } from '@/lib/whatsNew';
import type { Chat } from '@/lib/types';
import type { GitCommit, GitFile, GitStash, DiffStat } from './types';

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
export function GitChangedFile({ file, onOpen }: { file: GitFile; onOpen?: (path: string, staged?: boolean) => void }) {
  const segments = fileStatusSegments(file);
  // Whether clicking this row should open the STAGED-only diff. Only working-tree
  // files with a non-blank staged slot (X) qualify; committed files have no slot.
  const x = file.staged;
  const isUntracked = x === '?' || file.worktree === '?';
  const isStaged = x !== undefined && !isUntracked && x !== ' ';
  const content = (
    <>
      <span className="inline-flex items-center">
        {segments.map((s, i) => (
          <span key={i} className={s.cls}>{s.text}</span>
        ))}
      </span>
      <span className="truncate">{file.path}</span>
    </>
  );
  if (onOpen) {
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onOpen(file.path, isStaged); }}
        // Stop the keydown from reaching the parent row's onKeyDown (Enter/Space → open
        // chat): without this, keyboard-activating the file button would open the chat
        // pane instead of the diff, because the row handler calls preventDefault() before
        // the button's activation click can fire.
        onKeyDown={(e) => e.stopPropagation()}
        title={`${fileSlotLabel(file)} · ${isStaged ? 'view staged diff' : 'view diff'}: ${file.path}`}
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

/**
 * A compact `+N −M` magnitude chip for an agent's uncommitted working-tree edits
 * (insertions/deletions from `git diff HEAD --shortstat`). Renders NOTHING for a
 * clean tree or an all-untracked WIP: `--shortstat` counts TRACKED (staged +
 * unstaged) edits only, so a purely-untracked WIP yields +0−0 which would read as
 * "nothing changed" (a lie) — untracked adds keep speaking through the existing
 * file count. Reuses the badge's green-add / red-del color language (WARDEN-411).
 */
export function DiffStatChip({ diffstat, className }: { diffstat?: DiffStat | null; className?: string }) {
  if (!diffstat) return null;
  // The all-untracked guard: no tracked edits → render nothing, not +0−0.
  if (diffstat.insertions === 0 && diffstat.deletions === 0) return null;
  return (
    <span className={cn('inline-flex items-center gap-1 font-mono text-[10px]', className)}>
      <span className="text-emerald-400">+{diffstat.insertions}</span>
      <span className="text-red-400">−{diffstat.deletions}</span>
    </span>
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
function CommitFile({ chatId, hash, file }: { chatId: string; hash: string; file: GitFile }) {
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
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{loading ? '…' : open ? '▾' : '▸'}</span>
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
export function GitBranchBadge({ branch, clean, commits, loading, onFetch, ahead, behind, chatId, inProgress, stashCount, diffstat, incomingCommits, incomingLoading, onFetchIncoming, outgoingCommits, outgoingLoading, onFetchOutgoing, detached, headSha, upstream, className }: {
  branch: string;
  clean: boolean | null;
  commits?: GitCommit[];
  loading?: boolean;
  onFetch?: () => void;
  ahead?: number | null;
  behind?: number | null;
  chatId: string;
  inProgress?: { operation: string | null };
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
  // WARDEN-243: the short upstream tracking branch (e.g. origin/feature), or null
  // when HEAD has no upstream — a named branch never `push -u`'d. ahead/behind are
  // null either way (no @{u}), so without this a non-tracking branch is a bare
  // cyan label indistinguishable from a synced 0/0 branch. When null (and not
  // detached) the badge renders a distinct muted "no remote" marker so the
  // durability risk (local-only work, no remote backup) is visible at a glance.
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
  // signal in the badge: a blocked agent produces nothing until noticed (WARDEN-186).
  const operation = inProgress?.operation || null;
  // WARDEN-239: detached HEAD — render an amber ⎇ + short SHA instead of the
  // misleading "HEAD" label. ahead/behind stay null (no upstream), so the
  // ↑/↓ markers naturally don't render.
  const isDetached = detached === true;
  const sha = typeof headSha === 'string' ? headSha.trim() : '';
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
  if (operation) titleParts.push(`${operation} in progress`);
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

  const toggleCommit = (hash: string) => {
    if (expandedHash === hash) {
      setExpandedHash(null);
    } else {
      setExpandedHash(hash);
      if (!showCache[hash]) fetchShow(hash);
    }
  };

  return (
    <RadixPopover.Root onOpenChange={(open) => {
      if (!open) return;
      // Lazy-fetch ALL signals on first open: the local recent commits, the incoming
      // list (only when behind upstream), and shelved stashes (only when some are
      // parked). Each fetch is guarded so a repeat open reuses the cache instead of
      // re-hitting the endpoint.
      if (commits === undefined && !loading) onFetch?.();
      if (behindCount > 0 && incomingCommits === undefined && !incomingLoading) onFetchIncoming?.();
      if (aheadCount > 0 && outgoingCommits === undefined && !outgoingLoading) onFetchOutgoing?.();
      if (stashN > 0 && stashList === undefined && !stashLoading) fetchStash();
    }}>
      <RadixPopover.Trigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className={cn('inline-flex items-center gap-0.5 text-[10px] cursor-pointer', isDetached ? 'text-amber-400 hover:text-amber-300' : 'text-cyan-400 hover:text-cyan-300', className)}
          title={`${titleParts.join(' · ')} — click for recent commits`}
        >
          {operation && <span className="text-red-400 font-medium" title={`${operation} in progress`}>⚠ {operation}</span>}
          {isDetached ? (
            <>
              <span title="detached HEAD — commits not on a branch; at risk if reflog expires">⎇</span>
              {sha && <span className="font-mono">{sha}</span>}
            </>
          ) : branch}
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
              recent commits · {isDetached ? `detached${sha ? ` @ ${sha}` : ''}` : branch}
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
          {loading && (!commits || commits.length === 0) ? (
            <div className="flex items-center gap-1.5 px-1 py-1">
              <Skeleton className="size-2 rounded-full" /><span className="text-[10px] text-muted-foreground">loading…</span>
            </div>
          ) : commits && commits.length > 0 ? (
            <ul className="max-h-72 overflow-auto">
              {commits.map((cm) => (
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
                            <CommitFile key={f.path} chatId={chatId} hash={cm.hash} file={f} />
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
            <div className="px-1 py-1 text-[10px] text-muted-foreground">no commits</div>
          )}
          {aheadCount > 0 && (
            <div className="mt-1.5 border-t border-border pt-1.5">
              <div className="mb-1 px-0.5">
                <span className="text-[10px] font-medium text-amber-400">unpushed · ↑ {aheadCount} ahead</span>
              </div>
              {outgoingLoading && (!outgoingCommits || outgoingCommits.length === 0) ? (
                <div className="flex items-center gap-1.5 px-1 py-1">
                  <Skeleton className="size-2 rounded-full" /><span className="text-[10px] text-muted-foreground">loading…</span>
                </div>
              ) : outgoingCommits && outgoingCommits.length > 0 ? (
                <ul className="max-h-72 overflow-auto">
                  {outgoingCommits.map((cm) => (
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
                                <CommitFile key={f.path} chatId={chatId} hash={cm.hash} file={f} />
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
                <div className="px-1 py-1 text-[10px] text-muted-foreground">no unpushed commits</div>
              )}
            </div>
          )}
          {behindCount > 0 && (
            <div className="mt-1.5 border-t border-border pt-1.5">
              <div className="mb-1 px-0.5">
                <span className="text-[10px] font-medium text-blue-400">incoming · ↓ {behindCount} behind</span>
              </div>
              {incomingLoading && (!incomingCommits || incomingCommits.length === 0) ? (
                <div className="flex items-center gap-1.5 px-1 py-1">
                  <Skeleton className="size-2 rounded-full" /><span className="text-[10px] text-muted-foreground">loading…</span>
                </div>
              ) : incomingCommits && incomingCommits.length > 0 ? (
                <ul className="max-h-72 overflow-auto">
                  {incomingCommits.map((cm) => (
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
                                <CommitFile key={f.path} chatId={chatId} hash={cm.hash} file={f} />
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
                <div className="px-1 py-1 text-[10px] text-muted-foreground">no incoming commits</div>
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
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
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
function WhatsNewPopoverContent({ summary, files, diffstat, onOpenDiff }: {
  summary: WhatsNewSummary;
  files?: GitFile[];
  // WARDEN-411: working-tree edit magnitude (insertions/deletions), rendered as a
  // +N −M chip in the working-tree header. null/zero (clean or all-untracked WIP)
  // → DiffStatChip renders nothing.
  diffstat?: DiffStat | null;
  onOpenDiff?: (path: string, staged?: boolean) => void;
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
              <GitChangedFile key={file.path + '-' + i} file={file} onOpen={onOpenDiff} />
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
export function WhatsNewMarker({ summary, since, files, diffstat, onOpenDiff }: {
  summary: WhatsNewSummary;
  // The raw lastSeen epoch (null = never visited). Used both to gate visibility
  // and to anchor the tooltip's "since your last visit" framing.
  since: number | null;
  files?: GitFile[];
  // WARDEN-411: working-tree edit magnitude, passed through to the catch-up
  // popover's working-tree header chip.
  diffstat?: DiffStat | null;
  onOpenDiff?: (path: string, staged?: boolean) => void;
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
        <WhatsNewPopoverContent summary={summary} files={files} diffstat={diffstat} onOpenDiff={onOpenDiff} />
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
