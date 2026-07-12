import { useState, useEffect, useCallback, useMemo } from 'react';
import { Popover as RadixPopover } from 'radix-ui';
import { toast } from 'sonner';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/EmptyState';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Checkbox } from '@/components/ui/checkbox';
import { SlidersHorizontal, WifiOff } from 'lucide-react';
import { NewChatForm } from './NewChatForm';
import { CollectionsSection } from './CollectionsSection';
import { CreateCollectionDialog } from './CreateCollectionDialog';
import { BroadcastDialog } from './BroadcastDialog';
import { summarizeBroadcast, formatBroadcastToast } from '@/lib/broadcast';
import { DiffViewer } from './DiffViewer';
import { DiffBlock } from './DiffBlock';
import { useNotificationPrefs } from '@/lib/useNotificationPrefs';
import { cn } from '@/lib/utils';
import { summarizeProjectGitState, detectProjectFileCollisions, type ProjectGitAgent, type FileCollision } from '@/lib/gitStateSummary';
import type { Chat, Collection } from '@/lib/types';
import { loadUi, saveUi } from '@/lib/storage';
import { THIS_MACHINE, ago, basename, chatType, displayName, hostTagOf } from '@/lib/chatDisplay';
import {
  matchesAgentFilter, compareChats, sortChats, findChat,
  FILTER_OPTIONS, SORT_OPTIONS,
  type AgentFilter, type AgentSort,
} from '@/lib/agentFilter';
import { StatusDot } from '@/components/StatusDot';

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

/** A single changed-file row: status indicator (M/A/D/??) + truncated path.
 *  Interactive (a real <button>) only when `onOpen` is supplied — it opens the
 *  per-file DiffViewer and the click stops propagation so it never also opens the
 *  parent chat row. Without `onOpen` it renders as a plain non-interactive <span>:
 *  this lets it be embedded inside ANOTHER interactive row (an expanded commit's
 *  touched-file list, where the whole row is the affordance) without nesting
 *  interactive elements or swallowing the parent's click — and avoids a <button>
 *  with no handler, which is poor a11y. A conflicted file (`conflict: true`,
 *  e.g. UU/AA) renders a distinct red `!`-prefixed token instead of the generic
 *  gray row, so it reads as a conflict rather than noise (WARDEN-186). */
function GitChangedFile({ file, onOpen }: { file: GitFile; onOpen?: (path: string) => void }) {
  const color =
    file.conflict ? 'text-red-400' :
    file.status === 'M' ? 'text-yellow-400' :
    file.status === 'A' ? 'text-green-400' :
    file.status === 'D' ? 'text-red-400' :
    'text-gray-400';
  // Prefix conflicted codes with `!` so a UU/AA row is unmistakable next to an
  // ordinary ` M`/`A ` row — the bare code alone could read as a status letter.
  const token = file.conflict ? `!${file.status}` : file.status;
  const content = (
    <>
      <span className={color}>{token}</span>
      <span className="truncate">{file.path}</span>
    </>
  );
  if (onOpen) {
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onOpen(file.path); }}
        // Stop the keydown from reaching the parent row's onKeyDown (Enter/Space → open
        // chat): without this, keyboard-activating the file button would open the chat
        // pane instead of the diff, because the row handler calls preventDefault() before
        // the button's activation click can fire.
        onKeyDown={(e) => e.stopPropagation()}
        title={file.conflict ? `conflict ${file.status} · ${file.path}` : `view diff: ${file.path}`}
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

interface Props {
  chats: Chat[];
  sshHosts: string[];
  activeTabs: string[];
  hiddenTabs: string[];
  openPanes: Set<string>;
  onOpenChat: (id: string) => void;
  onClosePane: (id: string) => void;
  onRemoveActive: (id: string) => void;
  onReorder: (from: number, to: number) => void;
  onHideTab: (id: string) => void;
  onUnhideTab: (id: string) => void;
  onKill: (id: string) => void;
  onRename: (session: string, kind: string, name: string, host?: string) => void;
  onResume: (id: string, description: string, cwd: string, host: string) => void;
  onRefresh: () => void;
  onDiscoverHost: (host: string) => void;
  loading: boolean;
  lastRefreshAt?: number | null;
  // Display customization
  showHostTags?: boolean;
  showTypeBadges?: boolean;
  showStatusIndicators?: boolean;
  showProjectBadges?: boolean;
  hideOfflineHosts?: boolean;
  // Open the full-page "Open chat" browser view (App-level boolean). Replaces the
  // former in-sidebar modal trigger.
  onOpenChatBrowser: () => void;
  // Host connectivity statuses (polled at the App level so they stay live while
  // the full-page browser view — which replaces this sidebar — is open).
  hostStatuses: Record<string, { status: 'online' | 'offline' | 'unknown'; latency_ms: number | null }>;
}

const LABEL: Record<string, string> = { '(local)': 'this machine' };

const TYPE_COLOR: Record<string, string> = {
  resume: 'text-cyan-400', claude: 'text-green-400', shell: 'text-yellow-400',
  yatfa: 'text-blue-400', manual: 'text-violet-400', '?': 'text-muted-foreground',
};

// Skeleton components for loading states
function ChatRowSkeleton({ dim = false }: { dim?: boolean }) {
  return (
    <div className={`flex items-center gap-2 px-2 py-1.5 rounded-md ${dim ? 'opacity-60' : ''}`}>
      <Skeleton className="size-2 rounded-full" />
      <Skeleton className="flex-1 h-3" />
      <Skeleton className="h-3 w-12" />
    </div>
  );
}

function SessionRowSkeleton() {
  return (
    <div className="flex flex-col gap-0.5 px-2 py-1.5 rounded-md">
      <Skeleton className="h-3 w-3/4" />
      <Skeleton className="h-2.5 w-1/2" />
    </div>
  );
}

// Subtle "updated Xs ago" affordance next to the sidebar ↻ button, signalling
// the agent list is live. Re-renders only itself each second (not the whole
// sidebar) so the relative time visibly advances between auto-refresh ticks.
function UpdatedAgo({ at }: { at?: number | null }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  if (!at) return null;
  return <span className="text-[10px] text-muted-foreground tabular-nums">{ago(at)} ago</span>;
}

/**
 * A small expand/collapse section header — "▾/▸ label (count)" — that toggles a
 * collapsed summary group in the sidebar (hidden tabs, offline hosts).
 * Built on shadcn <Button> per WARDEN-68 (Rule 1 + Rule 2): no raw <button>, and
 * sizes come from the Tailwind scale (text-xs) rather than arbitrary literals.
 */
function SectionToggle({ expanded, onClick, label, title }: {
  expanded: boolean;
  onClick: () => void;
  label: string;
  title?: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      title={title}
      className="justify-start gap-1 w-full h-auto px-2 pt-2 pb-1 text-xs font-normal uppercase tracking-wider text-muted-foreground/60"
    >
      <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      <span className="flex-1 truncate text-left">{label}</span>
    </Button>
  );
}

/**
 * The contextual action bar for multi-select broadcast (WARDEN-292). Appears at
 * the foot of a fleet view only when ≥1 agent is selected, showing the live
 * count and the three selection actions: select-all (within the current visible
 * list), clear, and "Send to N…" (which opens the confirm-and-send dialog —
 * nothing is sent until the dialog's explicit Confirm). Built on shadcn <Button>
 * per the WARDEN-68 quality bar. shrink-0 so it stays pinned at the bottom while
 * the fleet list scrolls above it.
 */
function BroadcastActionBar({ count, onSelectAll, onClear, onSend }: {
  count: number;
  onSelectAll: () => void;
  onClear: () => void;
  onSend: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5 px-2 py-1.5 border-t shrink-0 bg-accent/40">
      <span className="text-xs text-muted-foreground whitespace-nowrap">{count} selected</span>
      <div className="ml-auto flex items-center gap-1">
        <Button variant="ghost" size="xs" onClick={onSelectAll} title="select every agent in this list">All</Button>
        <Button variant="ghost" size="xs" onClick={onClear} title="clear the selection">Clear</Button>
        <Button size="xs" onClick={onSend}>Send to {count}…</Button>
      </div>
    </div>
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

function GitStateBadges({ dirty, unpushed, behind, agents, chats, gitStatus, onOpenChat }: {
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
function GitCollisionBadge({ collisions, chats, gitStatus, onOpenChat, showProject }: {
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
  const count = collisions.length;
  if (count <= 0) return null;
  const title = `${count} file${count === 1 ? '' : 's'} edited by 2+ agents — click to list`;
  return (
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
  );
}

export function ChatSidebar({ chats, sshHosts, activeTabs, hiddenTabs, openPanes, onOpenChat, onRemoveActive, onReorder, onHideTab, onUnhideTab, onKill, onRename, onResume, onRefresh, onDiscoverHost, loading, lastRefreshAt, showHostTags, showTypeBadges, showStatusIndicators, showProjectBadges, hideOfflineHosts, onOpenChatBrowser, hostStatuses }: Props) {
  const [view, setView] = useState<{ kind: 'root' } | { kind: 'host'; host: string } | { kind: 'collection'; collection: Collection }>({ kind: 'root' });
  const [hiddenExpanded, setHiddenExpanded] = useState(false);
  const [offlineExpanded, setOfflineExpanded] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [tabSearchQuery, setTabSearchQuery] = useState('');
  const [resumingSessionId, setResumingSessionId] = useState<string | null>(null);
  const [pinnedChatIds, setPinnedChatIds] = useState<Set<string>>(new Set());
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [hostSessions, setHostSessions] = useState<Record<string, { sessions: ClaudeSession[]; claudeAvailable?: boolean }>>({});
  const [loadingHost, setLoadingHost] = useState<string | null>(null);
  const [gitStatus, setGitStatus] = useState<Record<string, { branch: string | null; detached?: boolean; headSha?: string | null; clean: boolean | null; cwd: string; files?: GitFile[]; ahead?: number | null; behind?: number | null; inProgress?: { operation: string | null }; stashCount?: number | null }>>({});
  // recent commit history (git log) per chatId — cached so re-expanding the badge is instant
  const [gitLog, setGitLog] = useState<Record<string, GitCommit[]>>({});
  const [gitLogLoading, setGitLogLoading] = useState<Record<string, boolean>>({});
  // incoming (behind) commit history per chatId — the commits @{u} has that HEAD
  // doesn't (the "↓N behind" half of WARDEN-153's count). A separate cache from the
  // local gitLog so each half refreshes independently and the popover shows both.
  // limit 50 (not 5): the whole behind list is the point, and it's cached so a
  // re-expand is instant. Only fetched when behindCount > 0 — the badge gates the
  // section — but the call is harmless on a non-behind repo (returns []).
  const [gitLogIncoming, setGitLogIncoming] = useState<Record<string, GitCommit[]>>({});
  const [gitLogIncomingLoading, setGitLogIncomingLoading] = useState<Record<string, boolean>>({});
  // outgoing (ahead/unpushed) commit history per chatId — the commits HEAD has that
  // @{u} doesn't (the "↑N unpushed" half of WARDEN-153's count, explorable per
  // WARDEN-252). A separate cache from gitLog/gitLogIncoming so each third refreshes
  // independently and the popover shows all three. limit 50 (not 5): the whole
  // unpushed list is the point, and it's cached so a re-expand is instant. Only
  // fetched when aheadCount > 0 — the badge gates the section — but the call is
  // harmless on a non-ahead repo (returns []).
  const [gitLogOutgoing, setGitLogOutgoing] = useState<Record<string, GitCommit[]>>({});
  const [gitLogOutgoingLoading, setGitLogOutgoingLoading] = useState<Record<string, boolean>>({});
  // Per-file diff dialog (WARDEN-151): which chatId + path is shown in the DiffViewer.
  const [diffTarget, setDiffTarget] = useState<{ chatId: string; path: string } | null>(null);
  const { prefs } = useNotificationPrefs();
  const [agentFilter, setAgentFilter] = useState<AgentFilter>('all');
  const [agentSort, setAgentSort] = useState<AgentSort>('manual');

  // Multi-select broadcast (WARDEN-292): the set of selected agent ids, held at
  // the ChatSidebar level so it can span the active/hidden/idle fleet lists in
  // whichever fleet view (host or collection) is open. Keyed by `c.key || c.id`
  // — the same identity openPanes/pinnedChatIds use — so a row stays selected
  // across the active→hidden→idle regrouping within one view. Selection is
  // scoped to the current fleet view: navigating away (back to root, into a
  // host/collection, or opening a chat) clears it, so the human's mental model
  // is "the agents I picked in THIS list," never a stale cross-view mix. v1
  // wires selection into ChatRow (the fleet lists) only — OpenedChatRow (the
  // root active-tabs working set) is intentionally excluded.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [broadcastOpen, setBroadcastOpen] = useState(false);

  // Extract project counts from active agents
  const projectCounts = chats.reduce((acc, c) => {
    if (c.active && c.project) {
      acc[c.project] = (acc[c.project] || 0) + 1;
    }
    return acc;
  }, {} as Record<string, number>);

  // Per-project + global uncommitted (dirty) / unpushed WIP counts for the project
  // filter chips (WARDEN-201). Reuses the cached gitStatus map (populated per open
  // tab) — no new fetch. A still-loading or non-git agent counts as neither, so the
  // chips only flag agents whose repo state is actually known to be dirty/unpushed.
  const gitStateSummary = useMemo(
    () => summarizeProjectGitState(chats, gitStatus),
    [chats, gitStatus],
  );

  // Cross-agent file-edit collisions (WARDEN-288): changed-file paths ≥2 active
  // agents in the same project both have uncommitted — the proactive complement
  // to the dirty/unpushed WIP summary above (which counts HOW MANY agents have
  // WIP; this catches WHEN two are editing the SAME file). Reuses the same
  // cached gitStatus map — whose value already carries each chat's changed
  // `files` from /api/git-status — so no new fetch, no backend change.
  const fileCollisions = useMemo(
    () => detectProjectFileCollisions(chats, gitStatus),
    [chats, gitStatus],
  );

  const fetchHostSessions = async (host: string) => {
    setLoadingHost(host);
    try {
      const r = await fetch(`/api/claude-sessions?host=${encodeURIComponent(host)}`);
      const j = await r.json();
      setHostSessions((p) => ({ ...p, [host]: { sessions: j.sessions || [], claudeAvailable: j.claudeAvailable } }));
    } catch (error) {
      console.error('[fetchHostSessions] Failed:', error);
      if (prefs.notifyErrors) toast.error(`Failed to fetch sessions for ${host}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    setLoadingHost(null);
  };

  const fetchGitStatus = useCallback(async (chatId: string) => {
    try {
      const r = await fetch(`/api/git-status?id=${encodeURIComponent(chatId)}`);
      const j = await r.json();
      if (j.branch) {
        setGitStatus((p) => ({ ...p, [chatId]: { branch: j.branch, detached: j.detached, headSha: j.headSha, clean: j.clean, cwd: j.cwd, files: j.files, ahead: j.ahead, behind: j.behind, inProgress: j.inProgress, stashCount: j.stashCount } }));
      }
    } catch (error) {
      // Git status is non-critical, so just log it without showing a toast
      console.error('[git-status] Failed:', error);
    }
  }, []);

  // Fetch recent commits for a chat. Results (even an empty list) are cached per chatId
  // so re-expanding the badge doesn't refetch; the badge's refresh affordance re-runs this.
  const fetchGitLog = useCallback(async (chatId: string) => {
    setGitLogLoading((p) => ({ ...p, [chatId]: true }));
    try {
      const r = await fetch(`/api/git-log?id=${encodeURIComponent(chatId)}&limit=5`);
      const j = await r.json();
      setGitLog((p) => ({ ...p, [chatId]: Array.isArray(j.commits) ? j.commits : [] }));
    } catch (error) {
      // Non-critical: cache an empty list so a transient failure doesn't loop on re-expand.
      console.error('Failed to fetch git log:', error);
      setGitLog((p) => ({ ...p, [chatId]: [] }));
    } finally {
      setGitLogLoading((p) => ({ ...p, [chatId]: false }));
    }
  }, []);

  // Fetch the incoming (behind) commits — git log HEAD..@{u} — for a chat. Mirrors
  // fetchGitLog but hits the range=incoming flag (WARDEN-225). Cached per chatId so a
  // re-expand is instant; a transient failure caches [] so it won't loop.
  const fetchGitLogIncoming = useCallback(async (chatId: string) => {
    setGitLogIncomingLoading((p) => ({ ...p, [chatId]: true }));
    try {
      const r = await fetch(`/api/git-log?id=${encodeURIComponent(chatId)}&limit=50&range=incoming`);
      const j = await r.json();
      setGitLogIncoming((p) => ({ ...p, [chatId]: Array.isArray(j.commits) ? j.commits : [] }));
    } catch (error) {
      console.error('Failed to fetch incoming git log:', error);
      setGitLogIncoming((p) => ({ ...p, [chatId]: [] }));
    } finally {
      setGitLogIncomingLoading((p) => ({ ...p, [chatId]: false }));
    }
  }, []);

  // Fetch the outgoing (ahead/unpushed) commits — git log @{u}..HEAD — for a chat.
  // Mirrors fetchGitLogIncoming but hits range=outgoing (WARDEN-252). Cached per
  // chatId so a re-expand is instant; a transient failure caches [] so it won't loop.
  const fetchGitLogOutgoing = useCallback(async (chatId: string) => {
    setGitLogOutgoingLoading((p) => ({ ...p, [chatId]: true }));
    try {
      const r = await fetch(`/api/git-log?id=${encodeURIComponent(chatId)}&limit=50&range=outgoing`);
      const j = await r.json();
      setGitLogOutgoing((p) => ({ ...p, [chatId]: Array.isArray(j.commits) ? j.commits : [] }));
    } catch (error) {
      console.error('Failed to fetch outgoing git log:', error);
      setGitLogOutgoing((p) => ({ ...p, [chatId]: [] }));
    } finally {
      setGitLogOutgoingLoading((p) => ({ ...p, [chatId]: false }));
    }
  }, []);

  // Load pinned chat ids from the backend on mount
  useEffect(() => {
    const fetchPins = async () => {
      try {
        const r = await fetch('/api/pins');
        const j = await r.json();
        setPinnedChatIds(new Set(j.pins || []));
      } catch (error) {
        console.error('[pins] Failed:', error);
      }
    };
    fetchPins();
  }, []);

  // Toggle a chat's pinned state and persist it
  const togglePin = async (chatId: string) => {
    const newPins = new Set(pinnedChatIds);
    if (newPins.has(chatId)) {
      newPins.delete(chatId);
    } else {
      newPins.add(chatId);
    }
    try {
      const r = await fetch('/api/pins', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pins: Array.from(newPins) }),
      });
      if (r.ok) {
        setPinnedChatIds(newPins);
      }
    } catch (error) {
      console.error('[pins-save] Failed:', error);
    }
  };

  // --- Multi-select broadcast (WARDEN-292) -------------------------------------
  // A broadcast is a chat operation (it types into agent tmux sessions), so its
  // result toast is gated on the same pref as kill/resume/rename (notifyChatOps)
  // — success AND failure — matching App.tsx's convention for chat-op feedback.
  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const selectAll = (ids: string[]) => setSelectedIds(new Set(ids));
  const clearSelection = () => setSelectedIds(new Set());

  // Selection is scoped to the current fleet view — clear it whenever the view
  // changes (root ↔ host ↔ collection). Opening a chat from a fleet view also
  // navigates to root (openFromHost), so this covers the "selected, then peeked
  // at a chat" path too: the selection has been discharged or abandoned by then.
  useEffect(() => { setSelectedIds(new Set()); }, [view]);

  // Resolve the selected ids to their chats (in chats order) for the confirm
  // dialog's target list. Stale ids (an agent that died between selecting and
  // sending) simply don't resolve here and are absent from the list — but they
  // are STILL sent to in handleBroadcastSend (which iterates selectedIds, not
  // this list) so a dead target is reported as a per-agent failure rather than
  // silently dropped.
  const selectedChats = useMemo(
    () => (selectedIds.size === 0 ? [] : chats.filter((c) => selectedIds.has(c.key || c.id))),
    [chats, selectedIds],
  );

  // Fan the message out to every selected agent via the existing per-target
  // /api/send path (server.js:182 → sendPane → tmux send-keys), then summarize.
  // Promise.allSettled (not Promise.all) so a partial failure — one host
  // unreachable, one session dead — is reported per-agent and does NOT abort the
  // other sends. Never throws: failure is encoded in the summary. Returns the
  // summary so the BroadcastDialog can close on completion.
  const handleBroadcastSend = async (text: string) => {
    const ids = Array.from(selectedIds);
    const results = await Promise.allSettled(
      ids.map((id) =>
        fetch('/api/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, text }),
        }).then(async (r) =>
          r.ok
            ? { ok: true }
            : { ok: false, error: (await r.json().catch(() => ({}))).error || `HTTP ${r.status}` },
        ),
      ),
    );
    const nameOf = (id: string) => {
      const c = findChat(chats, id);
      return c ? displayName(c) : id;
    };
    const summary = summarizeBroadcast(results, ids, nameOf);
    const outcome = formatBroadcastToast(summary);
    if (prefs.notifyChatOps) {
      if (outcome.variant === 'success') {
        toast.success(outcome.title);
      } else {
        // whitespace-pre-line so the per-agent failure list (joined with \n in
        // formatBroadcastToast) renders one failure per line instead of
        // collapsing to a single run-on line — sonner's default description
        // element normalizes whitespace.
        toast.error(outcome.title, { description: <span className="whitespace-pre-line">{outcome.description}</span> });
      }
    }
    // The broadcast's intent is discharged — clear the selection regardless of
    // outcome. Failed targets remain visible in the toast; the human can
    // re-select and retry if needed.
    setSelectedIds(new Set());
    return summary;
  };

  const enterHost = (host: string) => {
    const status = hostStatuses[host];
    if (status?.status === 'offline') {
      // Show helpful error instead of navigating
      toast.error(`Cannot reach ${host} — SSH connection failed. Please check:
• Network connectivity
• SSH daemon is running
• SSH keys are configured`);
      return;
    }
    setView({ kind: 'host', host });
    fetchHostSessions(host);
    onDiscoverHost(host);
  };

  // Collections management
  const fetchCollections = async () => {
    try {
      const r = await fetch('/api/collections');
      const j = await r.json();
      setCollections(j.collections || []);
    } catch (error) {
      console.error('[collections] Failed:', error);
      if (prefs.notifyErrors) toast.error(`Failed to fetch collections: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const enterCollection = (collection: Collection) => { setView({ kind: 'collection', collection }); };

  const handleCreateCollection = () => { setCreateDialogOpen(true); fetchCollections(); };

  const handleCollectionCreated = (_collection: Collection) => {
    fetchCollections();
    // Optionally enter the newly created collection
    // enterCollection(_collection);
  };

  // Fetch collections on mount
  useEffect(() => {
    fetchCollections();
  }, []);

  // Load filter/sort from localStorage on mount
  useEffect(() => {
    const ui = loadUi();
    if (ui.agentFilter) setAgentFilter(ui.agentFilter);
    if (ui.agentSort) setAgentSort(ui.agentSort);
  }, []);

  // Save filter/sort to localStorage when changed
  useEffect(() => {
    const ui = loadUi();
    ui.agentFilter = agentFilter;
    ui.agentSort = agentSort;
    saveUi(ui);
  }, [agentFilter, agentSort]);

  // Fetch git status for active chats (lazy loading)
  useEffect(() => {
    activeTabs.forEach((id) => {
      const c = findChat(chats, id);
      if (c) fetchGitStatus(id);
    });
  }, [chats, activeTabs, fetchGitStatus]);

  const handleSpawned = (chat: Chat) => { onRefresh(); onOpenChat(chat.key || chat.id); setView({ kind: 'root' }); };
  const hosts = [THIS_MACHINE, ...sshHosts];

  // "Hide offline hosts" display pref (WARDEN-164): when ON, SSH hosts whose last
  // polled status is 'offline' collapse out of the live host list into an
  // expandable "Offline (N)" summary row. THIS_MACHINE and online/unknown hosts
  // are never hidden — only explicitly 'offline' ones. Derived on every render,
  // so the 30s status poll drives it: a recovered host re-appears inline and a
  // dropped one collapses away, with no extra wiring. When OFF (default),
  // isOfflineHidden is always false → visibleHosts === filteredHosts, no summary.
  const hideOffline = hideOfflineHosts === true;
  const isOfflineHidden = (h: string) =>
    hideOffline && h !== THIS_MACHINE && hostStatuses[h]?.status === 'offline';

  // Hosts after the project filter (unchanged behavior) — the offline split is
  // applied on top of this so filtering stays consistent.
  const filteredHosts = hosts.filter((h) => {
    if (!projectFilter) return true;
    const n = chats.filter((c) => c.host === h && c.active && c.project === projectFilter).length;
    return n > 0;
  });
  const offlineHosts = filteredHosts.filter(isOfflineHidden);
  const visibleHosts = filteredHosts.filter((h) => !isOfflineHidden(h));

  // Renders one host row. Shared by the live list and the expanded offline
  // summary so the two stay identical — expanding the summary reveals the exact
  // same rows (the WARDEN-178 colorblind-safe StatusDot, incl. offline=square,
  // + retry/inspect still works via enterHost).
  const renderHost = (h: string) => {
    const n = chats.filter((c) => c.host === h && c.active && (!projectFilter || c.project === projectFilter)).length;
    const hostStatus = hostStatuses[h];
    return (
      <button key={h} onClick={() => enterHost(h)} className="flex items-center gap-2 px-2 py-1.5 compact:py-1 rounded-md text-left text-xs hover:bg-accent active:bg-accent/80 w-full transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background">
        <StatusDot
          tone={n ? 'green' : 'muted'}
          variant={n ? 'solid' : 'ring'}
          label={n ? `${n} active chat${n !== 1 ? 's' : ''}` : 'No active chats'}
        />
        <span className="flex-1 truncate">{LABEL[h] || h}</span>
        {h === THIS_MACHINE && <span className="text-[10px] text-cyan-400">local</span>}
        {h !== THIS_MACHINE && (
          <StatusDot
            tone={hostStatus?.status === 'online' ? 'green' : hostStatus?.status === 'offline' ? 'red' : 'gray'}
            variant={hostStatus?.status === 'online' ? 'solid' : hostStatus?.status === 'offline' ? 'square' : 'ring'}
            label={
              hostStatus?.status === 'online'
                ? `Online${hostStatus?.latency_ms ? ` (${hostStatus.latency_ms}ms)` : ''}`
                : hostStatus?.status === 'offline' ? 'Offline' : 'Unknown'
            }
            title={hostStatus?.status === 'online' && hostStatus?.latency_ms ?
              `${hostStatus.status} (${hostStatus.latency_ms}ms)` :
              hostStatus?.status || 'unknown'}
          />
        )}
        {n > 0 && <span className="text-[10px] text-muted-foreground">{n}</span>}
        <span className="text-muted-foreground/60">›</span>
      </button>
    );
  };

  // Wrapper functions for loading states
  const handleResume = async (id: string, description: string, cwd: string, host: string) => {
    if (resumingSessionId) return; // Prevent double-click
    setResumingSessionId(id);
    try {
      await onResume(id, description, cwd, host);
    } finally {
      setResumingSessionId(null);
    }
  };

  if (view.kind === 'collection') {
    const { collection: C } = view;
    let agents = collections.length > 0
      ? chats.filter((chat) => {
          // Apply the same filtering logic as getAgentsInCollection
          if (!C.criteria) return true;
          const { criteria } = C;
          let matches = true;
          if (criteria.role && chat.role !== criteria.role) matches = false;
          if (matches && criteria.project && chat.project !== criteria.project) matches = false;
          if (matches && criteria.host && chat.host !== criteria.host) matches = false;
          if (matches && criteria.custom && Array.isArray(criteria.custom) && criteria.custom.length > 0) {
            const customMatch = criteria.custom.some((value) =>
              chat.role === value || chat.project === value || chat.host === value || chat.name === value
            );
            if (!customMatch) matches = false;
          }
          return matches;
        })
      : [];

    // Apply agent filter + sort to collection agents
    agents = sortChats(agents.filter((c) => matchesAgentFilter(c, agentFilter, hiddenTabs)), agentSort);

    const active = agents.filter((c) => c.active);
    const idle = agents.filter((c) => !c.active);
    const visibleActive = active.filter((c) => !hiddenTabs.includes(c.key || c.id));
    const hiddenActive = active.filter((c) => hiddenTabs.includes(c.key || c.id));
    const openFromCollection = (key: string) => { onOpenChat(key); setView({ kind: 'root' }); };

    return (
      <div className="flex flex-col h-full min-h-0 animate-in slide-in-from-right-2 duration-150">
        <div className="flex items-center gap-2 compact:gap-1 px-2 py-2 compact:py-1.5 border-b shrink-0">
          <IconTooltip label="back"><button className="text-xs text-muted-foreground hover:text-foreground px-1 active:scale-95 transition-all duration-150 ease-out" onClick={() => setView({ kind: 'root' })}>‹</button></IconTooltip>
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ backgroundColor: C.metadata?.color || '#6366f1' }}
          />
          <span className="text-xs font-medium flex-1 truncate">{C.name}</span>
          <span className="text-[10px] text-muted-foreground">{agents.length}</span>
        </div>
        <ScrollArea className="flex-1 min-h-0">
          <div className="p-1.5 flex flex-col gap-0.5">
            {C.metadata?.description && (
              <div className="px-2 pt-1 pb-2 text-[10px] text-muted-foreground">{C.metadata.description}</div>
            )}
            {(visibleActive.length > 0 || idle.length > 0 || hiddenActive.length > 0) && (
              <div className="px-2 pt-1 pb-1 text-[10px] uppercase tracking-wider text-green-500/80 font-semibold">● matching agents</div>
            )}
            {visibleActive.map((c) => <ChatRow key={c.id} c={c} open={openPanes.has(c.key || c.id)} onOpen={() => openFromCollection(c.key || c.id)} hostStatus={hostStatuses[c.host]?.status} onKill={() => onKill(c.key || c.id)} onRename={onRename} onHide={() => onHideTab(c.key || c.id)} showHostTags={showHostTags} showTypeBadges={showTypeBadges} showStatusIndicators={showStatusIndicators} showProjectBadges={showProjectBadges} isPinned={pinnedChatIds.has(c.id)} onTogglePin={() => togglePin(c.id)} selected={selectedIds.has(c.key || c.id)} onToggleSelect={() => toggleSelect(c.key || c.id)} selectionActive={selectedIds.size > 0} />)}
            {hiddenActive.length > 0 && (
              <>
                <SectionToggle expanded={hiddenExpanded} onClick={() => setHiddenExpanded(!hiddenExpanded)} label={`hidden (${hiddenActive.length})`} />
                {hiddenExpanded && hiddenActive.map((c) => (
                  <ChatRow key={c.id} c={c} open={openPanes.has(c.key || c.id)} onOpen={() => openFromCollection(c.key || c.id)} hostStatus={hostStatuses[c.host]?.status} onKill={() => onKill(c.key || c.id)} onRename={onRename} onUnhide={() => onUnhideTab(c.key || c.id)} dim showHostTags={showHostTags} showTypeBadges={showTypeBadges} showStatusIndicators={showStatusIndicators} showProjectBadges={showProjectBadges} isPinned={pinnedChatIds.has(c.id)} onTogglePin={() => togglePin(c.id)} selected={selectedIds.has(c.key || c.id)} onToggleSelect={() => toggleSelect(c.key || c.id)} selectionActive={selectedIds.size > 0} />
                ))}
              </>
            )}
            {idle.length > 0 && (
              <>
                <div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground/60">idle</div>
                {idle.map((c) => <ChatRow key={c.id} c={c} open={openPanes.has(c.key || c.id)} onOpen={() => openFromCollection(c.key || c.id)} hostStatus={hostStatuses[c.host]?.status} onKill={() => onKill(c.key || c.id)} onRename={onRename} dim showHostTags={showHostTags} showTypeBadges={showTypeBadges} showStatusIndicators={showStatusIndicators} showProjectBadges={showProjectBadges} isPinned={pinnedChatIds.has(c.id)} onTogglePin={() => togglePin(c.id)} selected={selectedIds.has(c.key || c.id)} onToggleSelect={() => toggleSelect(c.key || c.id)} selectionActive={selectedIds.size > 0} />)}
              </>
            )}
            {agents.length === 0 && (
              <div className="p-3">
                <EmptyState type="no-results" message="no agents match this collection" />
              </div>
            )}
          </div>
        </ScrollArea>
        {selectedIds.size > 0 && (
          <BroadcastActionBar
            count={selectedIds.size}
            onSelectAll={() => selectAll(agents.map((c) => c.key || c.id))}
            onClear={clearSelection}
            onSend={() => setBroadcastOpen(true)}
          />
        )}
        {/* Rendered in each view's own return because host/collection are
            early-return branches — a single copy at the root would never mount
            while a fleet view (where selection lives) is active. Only one view
            is mounted at a time, so only one dialog instance exists. */}
        <BroadcastDialog
          open={broadcastOpen}
          onOpenChange={setBroadcastOpen}
          targets={selectedChats}
          onSend={handleBroadcastSend}
        />
      </div>
    );
  }

  if (view.kind === 'host') {
    const H = view.host;
    const hostChats = chats.filter((c) => c.host === H && (!projectFilter || c.project === projectFilter));

    // Apply agent filter + sort to host chats
    const sortedHostChats = sortChats(
      hostChats.filter((c) => matchesAgentFilter(c, agentFilter, hiddenTabs)),
      agentSort,
    );

    const active = sortedHostChats.filter((c) => c.active);
    const idle = sortedHostChats.filter((c) => !c.active);
    const visibleActive = active.filter((c) => !hiddenTabs.includes(c.key || c.id));
    const hiddenActive = active.filter((c) => hiddenTabs.includes(c.key || c.id));
    const info = hostSessions[H] || {};
    const sessions = info.sessions || [];
    const openFromHost = (key: string) => { onOpenChat(key); setView({ kind: 'root' }); };
    return (
      <div className="flex flex-col h-full min-h-0 animate-in slide-in-from-right-2 duration-150">
        <div className="flex items-center gap-2 compact:gap-1 px-2 py-2 compact:py-1.5 border-b shrink-0">
          <IconTooltip label="back"><button className="text-xs text-muted-foreground hover:text-foreground px-1 rounded active:scale-95 transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background hover:bg-accent/50" onClick={() => setView({ kind: 'root' })}>‹</button></IconTooltip>
          <span className="text-xs font-medium flex-1 truncate">{LABEL[H] || H}</span>
          <AgentFilterSortControls
            agentFilter={agentFilter}
            agentSort={agentSort}
            onFilterChange={setAgentFilter}
            onSortChange={setAgentSort}
            hideHostSort
          />
          <IconTooltip label="rescan" disabled={loadingHost === H}><button className="text-xs text-muted-foreground hover:text-foreground rounded px-1 active:scale-95 transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background hover:bg-accent/50" onClick={() => fetchHostSessions(H)} disabled={loadingHost === H}>
            {loadingHost === H ? <Skeleton className="h-3 w-3" /> : '↻'}
          </button></IconTooltip>
        </div>
        <ScrollArea className="flex-1 min-h-0">
          <div className="p-1.5 flex flex-col gap-0.5">
            {(visibleActive.length > 0 || idle.length > 0 || hiddenActive.length > 0) && (
              <div className="px-2 pt-1 pb-1 text-[10px] uppercase tracking-wider text-green-500/80 font-semibold">● live (tmux)</div>
            )}
            {visibleActive.map((c) => <ChatRow key={c.id} c={c} open={openPanes.has(c.key || c.id)} onOpen={() => openFromHost(c.key || c.id)} hostStatus={hostStatuses[c.host]?.status} onKill={() => onKill(c.key || c.id)} onRename={onRename} onHide={() => onHideTab(c.key || c.id)} gitInfo={gitStatus[c.key || c.id]} gitCommits={gitLog[c.key || c.id]} gitLogLoading={gitLogLoading[c.key || c.id]} onFetchGitLog={() => fetchGitLog(c.key || c.id)} incomingCommits={gitLogIncoming[c.key || c.id]} incomingLoading={gitLogIncomingLoading[c.key || c.id]} onFetchIncoming={() => fetchGitLogIncoming(c.key || c.id)} outgoingCommits={gitLogOutgoing[c.key || c.id]} outgoingLoading={gitLogOutgoingLoading[c.key || c.id]} onFetchOutgoing={() => fetchGitLogOutgoing(c.key || c.id)} onOpenDiff={(path) => setDiffTarget({ chatId: c.key || c.id, path })} showHostTags={showHostTags} showTypeBadges={showTypeBadges} showStatusIndicators={showStatusIndicators} showProjectBadges={showProjectBadges} isPinned={pinnedChatIds.has(c.id)} onTogglePin={() => togglePin(c.id)} selected={selectedIds.has(c.key || c.id)} onToggleSelect={() => toggleSelect(c.key || c.id)} selectionActive={selectedIds.size > 0} />)}
            {hiddenActive.length > 0 && (
              <>
                <SectionToggle expanded={hiddenExpanded} onClick={() => setHiddenExpanded(!hiddenExpanded)} label={`hidden (${hiddenActive.length})`} />
                {hiddenExpanded && hiddenActive.map((c) => (
                  <ChatRow key={c.id} c={c} open={openPanes.has(c.key || c.id)} onOpen={() => openFromHost(c.key || c.id)} hostStatus={hostStatuses[c.host]?.status} onKill={() => onKill(c.key || c.id)} onRename={onRename} onUnhide={() => onUnhideTab(c.key || c.id)} dim gitInfo={gitStatus[c.key || c.id]} gitCommits={gitLog[c.key || c.id]} gitLogLoading={gitLogLoading[c.key || c.id]} onFetchGitLog={() => fetchGitLog(c.key || c.id)} incomingCommits={gitLogIncoming[c.key || c.id]} incomingLoading={gitLogIncomingLoading[c.key || c.id]} onFetchIncoming={() => fetchGitLogIncoming(c.key || c.id)} outgoingCommits={gitLogOutgoing[c.key || c.id]} outgoingLoading={gitLogOutgoingLoading[c.key || c.id]} onFetchOutgoing={() => fetchGitLogOutgoing(c.key || c.id)} onOpenDiff={(path) => setDiffTarget({ chatId: c.key || c.id, path })} showHostTags={showHostTags} showTypeBadges={showTypeBadges} showStatusIndicators={showStatusIndicators} showProjectBadges={showProjectBadges} isPinned={pinnedChatIds.has(c.id)} onTogglePin={() => togglePin(c.id)} selected={selectedIds.has(c.key || c.id)} onToggleSelect={() => toggleSelect(c.key || c.id)} selectionActive={selectedIds.size > 0} />
                ))}
              </>
            )}
            {idle.length > 0 && (
              <>
                <div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground/60">idle</div>
                {idle.map((c) => <ChatRow key={c.id} c={c} open={openPanes.has(c.key || c.id)} onOpen={() => openFromHost(c.key || c.id)} hostStatus={hostStatuses[c.host]?.status} onKill={() => onKill(c.key || c.id)} onRename={onRename} dim gitInfo={gitStatus[c.key || c.id]} gitCommits={gitLog[c.key || c.id]} gitLogLoading={gitLogLoading[c.key || c.id]} onFetchGitLog={() => fetchGitLog(c.key || c.id)} incomingCommits={gitLogIncoming[c.key || c.id]} incomingLoading={gitLogIncomingLoading[c.key || c.id]} onFetchIncoming={() => fetchGitLogIncoming(c.key || c.id)} outgoingCommits={gitLogOutgoing[c.key || c.id]} outgoingLoading={gitLogOutgoingLoading[c.key || c.id]} onFetchOutgoing={() => fetchGitLogOutgoing(c.key || c.id)} onOpenDiff={(path) => setDiffTarget({ chatId: c.key || c.id, path })} showHostTags={showHostTags} showTypeBadges={showTypeBadges} showStatusIndicators={showStatusIndicators} showProjectBadges={showProjectBadges} isPinned={pinnedChatIds.has(c.id)} onTogglePin={() => togglePin(c.id)} selected={selectedIds.has(c.key || c.id)} onToggleSelect={() => toggleSelect(c.key || c.id)} selectionActive={selectedIds.size > 0} />)}
              </>
            )}
            <div className="mt-3 mb-1 border-t border-border/50" />
            {H !== THIS_MACHINE && loadingHost === H && !sessions.length && (
              <>
                <div className="px-2 pt-1 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground/40">scanning sessions</div>
                {[1, 2, 3, 4].map((i) => <SessionRowSkeleton key={i} />)}
              </>
            )}
            {info.claudeAvailable === false && (
              <div className="mx-1 my-2 px-2 py-2 text-[11px] text-yellow-400 bg-yellow-500/10 border border-yellow-500/30 rounded-md">
                ⚠ claude not found on {LABEL[H] || H} — install it to resume sessions here.
              </div>
            )}
            <div className="px-2 pt-1 pb-1 text-[10px] uppercase tracking-wider text-cyan-500/80 font-semibold">☁ sessions (history — click to resume)</div>
            {sessions.slice(0, 12).map((s) => {
              const running = hostChats.some((c) => c.key === `resume-${s.id.slice(0, 8)}`);
              const isLoading = resumingSessionId === s.id;
              return (
                <IconTooltip
                  key={s.id}
                  disabled={isLoading}
                  label={
                    <span className="flex flex-col text-left gap-0.5">
                      <span>resume <span className="font-mono">{s.id}</span></span>
                      <span className="opacity-70">{s.cwd}</span>
                    </span>
                  }
                >
                  <button
                    onClick={() => { handleResume(s.id, s.summary, s.cwd, H); setView({ kind: 'root' }); }}
                    disabled={isLoading}
                    className="flex flex-col gap-0.5 px-2 py-1.5 compact:py-1 rounded-md text-left text-xs hover:bg-accent active:bg-accent/80 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  >
                    <span className="truncate">
                      {isLoading ? (
                        <Skeleton className="h-3 w-3/4 inline-block" />
                      ) : (
                        s.summary || <span className="text-muted-foreground">(no summary)</span>
                      )}
                      {running && <span className="ml-1 text-green-400">● live</span>}
                    </span>
                    <span className="text-[10px] text-muted-foreground truncate">
                      {isLoading ? <Skeleton className="h-2.5 w-1/2 inline-block" /> : `${ago(s.mtime)} · ${basename(s.cwd)}`}
                    </span>
                  </button>
                </IconTooltip>
              );
            })}
            {sortedHostChats.length === 0 && sessions.length === 0 && loadingHost !== H && (
              <EmptyState type="nothing-here" message={hostChats.length === 0 ? undefined : 'no agents match the current filter'} />
            )}
          </div>
        </ScrollArea>
        {selectedIds.size > 0 && (
          <BroadcastActionBar
            count={selectedIds.size}
            onSelectAll={() => selectAll(sortedHostChats.map((c) => c.key || c.id))}
            onClear={clearSelection}
            onSend={() => setBroadcastOpen(true)}
          />
        )}
        <BroadcastDialog
          open={broadcastOpen}
          onOpenChange={setBroadcastOpen}
          targets={selectedChats}
          onSend={handleBroadcastSend}
        />
      </div>
    );
  }

  // ROOT VIEW — persistent active tabs + hosts
  const filteredTabs = activeTabs.filter((id) => {
    const c = findChat(chats, id);
    if (!c) return false;
    const query = tabSearchQuery.toLowerCase();
    const name = displayName(c).toLowerCase();
    const host = (c.host || '').toLowerCase();
    const type = chatType(c).toLowerCase();
    const matchesSearch = name.includes(query) || host.includes(query) || type.includes(query);
    return matchesSearch && matchesAgentFilter(c, agentFilter, hiddenTabs);
  });

  // Apply sorting — manual preserves the drag-to-reorder order.
  const sortedTabs = agentSort === 'manual'
    ? filteredTabs
    : [...filteredTabs]
        .map((id) => ({ id, c: findChat(chats, id)! }))
        .sort((a, b) => compareChats(a.c, b.c, agentSort))
        .map((x) => x.id);

  return (
    <div className="@container flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 compact:gap-1 px-3 py-2 compact:py-1.5 border-b shrink-0">
        <span className="text-xs text-muted-foreground @max-[20rem]:hidden">active</span>
        <Input
          placeholder="filter..."
          value={tabSearchQuery}
          onChange={(e) => setTabSearchQuery(e.target.value)}
          className="h-6 text-[10px] px-2 flex-1 max-w-[120px] min-w-20"
        />
        <AgentFilterSortControls
          agentFilter={agentFilter}
          agentSort={agentSort}
          onFilterChange={setAgentFilter}
          onSortChange={setAgentSort}
        />
        <Badge variant="secondary" className="text-xs @max-[18rem]:hidden">{sortedTabs.length}</Badge>
        <span className="@max-[20rem]:hidden"><UpdatedAgo at={lastRefreshAt} /></span>
        <button className="text-xs text-muted-foreground hover:text-foreground rounded px-1 active:scale-95 transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background hover:bg-accent/50" onClick={onRefresh} disabled={loading} title="refresh">
          {loading ? <Skeleton className="h-3 w-3" /> : '↻'}
        </button>
      </div>
      <NewChatForm onSpawned={handleSpawned} />
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-1.5 flex flex-col gap-0.5">
          {loading && activeTabs.length === 0 ? (
            <>
              <div className="px-2 pt-1 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground/40">loading tabs</div>
              {[1, 2, 3].map((i) => <ChatRowSkeleton key={i} />)}
            </>
          ) : null}
          {activeTabs.length > 0 && (
            <div className="px-2 pt-1 pb-1 text-[10px] uppercase tracking-wider text-green-500/80 font-semibold">tabs</div>
          )}
          {Object.keys(projectCounts).length > 1 && (
            <div className="flex flex-wrap gap-1 px-2 pb-1">
              <button
                onClick={() => setProjectFilter(null)}
                className={`text-xs px-2 py-1 rounded transition-all duration-150 ease-out active:scale-95 ${!projectFilter ? 'bg-accent' : 'hover:bg-accent/50'}`}
              >
                All Projects ({chats.filter(c => c.active).length})
                <GitStateBadges dirty={gitStateSummary.total.dirty} unpushed={gitStateSummary.total.unpushed} behind={gitStateSummary.total.behind} agents={gitStateSummary.total.agents} chats={chats} gitStatus={gitStatus} onOpenChat={onOpenChat} />
                <GitCollisionBadge collisions={fileCollisions.total.paths} chats={chats} gitStatus={gitStatus} onOpenChat={onOpenChat} showProject />
              </button>
              {Object.entries(projectCounts).map(([project, count]) => (
                <button
                  key={project}
                  onClick={() => setProjectFilter(project)}
                  className={`text-xs px-2 py-1 rounded transition-all duration-150 ease-out active:scale-95 ${projectFilter === project ? 'bg-accent' : 'hover:bg-accent/50'}`}
                >
                  {project} ({count})
                  <GitStateBadges dirty={gitStateSummary.perProject[project]?.dirty ?? 0} unpushed={gitStateSummary.perProject[project]?.unpushed ?? 0} behind={gitStateSummary.perProject[project]?.behind ?? 0} agents={gitStateSummary.perProject[project]?.agents ?? []} chats={chats} gitStatus={gitStatus} onOpenChat={onOpenChat} />
                  <GitCollisionBadge collisions={fileCollisions.perProject[project]?.paths ?? []} chats={chats} gitStatus={gitStatus} onOpenChat={onOpenChat} />
                </button>
              ))}
            </div>
          )}
          {sortedTabs
            .filter((id) => {
              if (!projectFilter) return true;
              const c = findChat(chats, id);
              return c && c.project === projectFilter;
            })
            .map((id) => {
            const c = findChat(chats, id);
            const originalIdx = activeTabs.indexOf(id);
            // WARDEN-91: drag-reorder is only meaningful in manual sort order; in any
            // sorted mode the list is derived from compareChats, so we disable drag.
            const canDrag = agentSort === 'manual';
            return (
              <OpenedChatRow
                key={id}
                id={id}
                c={c}
                isOpen={openPanes.has(id)}
                onOpen={() => onOpenChat(id)}
                onRemove={() => onRemoveActive(id)}
                onRename={onRename}
                onHide={() => onHideTab(id)}
                onKill={() => onKill(id)}
                canDrag={canDrag}
                showHostTags={showHostTags}
                showTypeBadges={showTypeBadges}
                showStatusIndicators={showStatusIndicators}
                showProjectBadges={showProjectBadges}
                gitInfo={gitStatus[id]}
                gitCommits={gitLog[id]}
                gitLogLoading={gitLogLoading[id]}
                onFetchGitLog={() => fetchGitLog(id)}
                incomingCommits={gitLogIncoming[id]}
                incomingLoading={gitLogIncomingLoading[id]}
                onFetchIncoming={() => fetchGitLogIncoming(id)}
                outgoingCommits={gitLogOutgoing[id]}
                outgoingLoading={gitLogOutgoingLoading[id]}
                onFetchOutgoing={() => fetchGitLogOutgoing(id)}
                onOpenDiff={(path) => setDiffTarget({ chatId: id, path })}
                originalIdx={originalIdx}
                dragIdx={dragIdx}
                dragOverIdx={dragOverIdx}
                setDragIdx={setDragIdx}
                setDragOverIdx={setDragOverIdx}
                onReorder={onReorder}
              />
            );
          })}
          {sortedTabs.length === 0 && activeTabs.length > 0 && (
            <div className="text-xs text-muted-foreground p-3 text-center">{tabSearchQuery ? `no tabs match "${tabSearchQuery}"` : 'no tabs match the current filter'}</div>
          )}
          {activeTabs.length === 0 && !loading && (
            <EmptyState type="no-tabs" />
          )}
          <div className="px-2 pt-2 pb-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={onOpenChatBrowser}
              className="w-full justify-start gap-1 text-xs text-blue-400 hover:text-blue-300"
            >
              <span>↗</span>
              <span>Open chat…</span>
            </Button>
          </div>
          <div className="mt-3 mb-1 border-t border-border/50" />
          <div className="px-2 pt-1 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground/60">hosts</div>
          <CollectionsSection
            chats={chats}
            onEnterCollection={enterCollection}
            onCreateCollection={handleCreateCollection}
          />
          {visibleHosts.map(renderHost)}
          {offlineHosts.length > 0 && (
            <>
              <SectionToggle
                expanded={offlineExpanded}
                onClick={() => setOfflineExpanded(!offlineExpanded)}
                label={`Offline (${offlineHosts.length})`}
                title="Offline hosts are collapsed — click to expand"
              />
              {offlineExpanded && offlineHosts.map(renderHost)}
            </>
          )}
        </div>
      </ScrollArea>
      <CreateCollectionDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onCreated={handleCollectionCreated}
        existingCollections={collections}
      />
      <DiffViewer
        chatId={diffTarget?.chatId ?? ''}
        filePath={diffTarget?.path ?? ''}
        open={!!diffTarget}
        onOpenChange={(o) => { if (!o) setDiffTarget(null); }}
      />
      <BroadcastDialog
        open={broadcastOpen}
        onOpenChange={setBroadcastOpen}
        targets={selectedChats}
        onSend={handleBroadcastSend}
      />
    </div>
  );
}

// Filter + sort popover shared by the root and host view headers. Collapsing
// both controls behind a single icon keeps the header from overflowing at the
// default sidebar width (220px) — two inline selects did not fit.
function AgentFilterSortControls({
  agentFilter,
  agentSort,
  onFilterChange,
  onSortChange,
  hideHostSort = false,
}: {
  agentFilter: AgentFilter;
  agentSort: AgentSort;
  onFilterChange: (v: AgentFilter) => void;
  onSortChange: (v: AgentSort) => void;
  hideHostSort?: boolean;
}) {
  const active = agentFilter !== 'all' || agentSort !== 'manual';
  const sortOptions = hideHostSort ? SORT_OPTIONS.filter((o) => o.value !== 'host') : SORT_OPTIONS;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          title="filter & sort"
          aria-label="filter & sort"
          className={active ? 'text-primary' : 'text-muted-foreground'}
        >
          <SlidersHorizontal />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-3">
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">filter</span>
            <Select value={agentFilter} onValueChange={(v) => onFilterChange(v as AgentFilter)}>
              <SelectTrigger className="h-7 w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FILTER_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">sort</span>
            <Select value={agentSort} onValueChange={(v) => onSortChange(v as AgentSort)}>
              <SelectTrigger className="h-7 w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sortOptions.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// The cyan branch badge (+ yellow ±). Made interactive: click opens a popover showing
// the last few commits (git log) for the chat's repo. Commits are lazily fetched on
// first open and cached by chatId; the ↻ affordance re-fetches. The popover is portaled
// to document.body via Radix Popover so it isn't clipped by the `truncate` name span
// this badge sits inside (in ChatRow). stopPropagation on clicks keeps it from also
// opening the chat pane (mirrors the other inline buttons in these rows).

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

function GitBranchBadge({ branch, clean, commits, loading, onFetch, ahead, behind, chatId, inProgress, stashCount, incomingCommits, incomingLoading, onFetchIncoming, outgoingCommits, outgoingLoading, onFetchOutgoing, detached, headSha, className }: {
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
  // WARDEN-225: the "behind" half — commits @{u} has that HEAD doesn't. Lazily
  // fetched on open when behindCount > 0, with its own cache/loader so it refreshes
  // independently of the local recent-commits list. Display-only (no pull/expand).
  incomingCommits?: GitCommit[];
  incomingLoading?: boolean;
  onFetchIncoming?: () => void;
  // WARDEN-252: the "ahead/unpushed" half — commits HEAD has that @{u} doesn't. The
  // symmetric counterpart to incomingCommits. Lazily fetched on open when aheadCount
  // > 0, with its own cache/loader. Explorable (WARDEN-303): these commits ARE local
  // (already in HEAD), so each row expands to its changed files + per-file diff via
  // /api/git-show — unlike incoming, which stays display-only.
  outgoingCommits?: GitCommit[];
  outgoingLoading?: boolean;
  onFetchOutgoing?: () => void;
  // WARDEN-239: HEAD is not on a branch (an agent checked out a specific commit).
  // Rendered as a distinct amber glyph + the short SHA instead of the misleading
  // literal "HEAD" branch label. ahead/behind are null on detached (no @{u}).
  detached?: boolean;
  headSha?: string | null;
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
  const titleParts = isDetached
    ? [`detached HEAD${sha ? ` @ ${sha}` : ''}`, 'commits not on a branch; at risk if reflog expires']
    : [branch];
  if (operation) titleParts.push(`${operation} in progress`);
  if (clean === false) titleParts.push('uncommitted changes');
  if (stashN > 0) titleParts.push(`${stashN} stashed`);
  if (!isDetached && aheadCount > 0) titleParts.push(`${aheadCount} unpushed`);
  if (!isDetached && behindCount > 0) titleParts.push(`${behindCount} behind remote`);

  // Per-commit expand state + the /api/git-show files cache (keyed by hash) so a
  // repeat expansion is instant. The popover owns the interaction, so this state
  // lives here rather than being prop-drilled through ChatRow/ChatSidebar.
  const [expandedHash, setExpandedHash] = useState<string | null>(null);
  const [showCache, setShowCache] = useState<Record<string, { files?: GitFile[]; error?: string | null }>>({});
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
      setShowCache((p) => ({ ...p, [hash]: { files: Array.isArray(j.files) ? j.files : [], error: j.error } }));
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
                    // Explorable (WARDEN-303): unlike the incoming list below, these
                    // commits ARE local (already in HEAD), so a per-commit /api/git-show
                    // expand is reliable. Mirrors the recent-commits row above, diverging
                    // only in the amber hash color to match this list's "unpushed" styling.
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
                    // Display-only: an incoming commit isn't pulled locally yet, so a
                    // per-commit /api/git-show would be unreliable — no expand in v1.
                    <li key={cm.hash} className="rounded">
                      <div className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left" title="incoming commit (not yet pulled)">
                        <span className="shrink-0 font-mono text-[10px] text-blue-400/80">{cm.hash}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[10px] text-foreground" title={cm.subject}>{cm.subject}</span>
                          <span className="block text-[10px] text-muted-foreground">{cm.date}{cm.author ? ` · ${cm.author}` : ''}</span>
                        </span>
                      </div>
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

function ChatRow({ c, open, onOpen, onKill, onRename, onHide, onUnhide, dim, hostStatus, gitInfo, gitCommits, gitLogLoading, onFetchGitLog, incomingCommits, incomingLoading, onFetchIncoming, outgoingCommits, outgoingLoading, onFetchOutgoing, onOpenDiff, showHostTags, showTypeBadges, showStatusIndicators, showProjectBadges, isPinned, onTogglePin, selected, onToggleSelect, selectionActive }: {
  c: Chat; open: boolean; onOpen: () => void; onKill: () => void;
  onRename: (session: string, kind: string, name: string, host?: string) => void;
  onHide?: () => void; onUnhide?: () => void; dim?: boolean;
  // WARDEN-198: per-host reachability from the 30s /api/hosts/status poll.
  // 'offline' → the row renders a distinct "unreachable" state.
  hostStatus?: 'online' | 'offline' | 'unknown';
  gitInfo?: { branch: string | null; detached?: boolean; headSha?: string | null; clean: boolean | null; files?: GitFile[]; ahead?: number | null; behind?: number | null; inProgress?: { operation: string | null }; stashCount?: number | null };
  gitCommits?: GitCommit[]; gitLogLoading?: boolean; onFetchGitLog?: () => void;
  // WARDEN-225: incoming (behind) commits + their own fetch/loader, threaded to
  // GitBranchBadge the same way the local gitLog trio is.
  incomingCommits?: GitCommit[]; incomingLoading?: boolean; onFetchIncoming?: () => void;
  // WARDEN-252: outgoing (ahead/unpushed) commits + their own fetch/loader.
  outgoingCommits?: GitCommit[]; outgoingLoading?: boolean; onFetchOutgoing?: () => void;
  onOpenDiff?: (path: string) => void;
  showHostTags?: boolean; showTypeBadges?: boolean; showStatusIndicators?: boolean; showProjectBadges?: boolean;
  isPinned?: boolean; onTogglePin?: () => void;
  // WARDEN-292: multi-select for broadcast. `selected` is this row's membership
  // in the sidebar's selection set; `onToggleSelect` flips it. `selectionActive`
  // (≥1 agent selected anywhere in the view) reveals every row's checkbox at full
  // opacity so the human can keep picking without per-row hover — otherwise the
  // checkbox is hover/focus-only (mirrors the pin/hide/kill hover-button pattern
  // at line ~1542) to keep the default fleet list uncluttered.
  selected?: boolean; onToggleSelect?: () => void; selectionActive?: boolean;
}) {
  const isUser = c.kind === 'tmux';
  const canRename = isUser;
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(c.name || c.key || c.id);
  const type = chatType(c);
  const typeColor = TYPE_COLOR[type] || 'text-violet-400';
  const hostTag = isUser ? (c.host === '(local)' ? 'local' : (c.host || '')) : null;
  // WARDEN-198: when this agent's managed host is offline, render a distinct
  // "unreachable" state instead of the ambiguous idle/undiscovered gray dot.
  // Driven by the shared 30s host-status poll, so it self-clears on recovery.
  const hostOffline = hostStatus === 'offline';
  const commit = () => {
    const v = val.trim();
    if (v && v !== (c.name || c.key)) {
      setEditing(false);
      onRename(c.key || c.id, c.kind || 'tmux', v, c.host);
    } else {
      setEditing(false);
    }
  };

  return (
    <div
      data-chat-key={c.key || c.id}
      role="button"
      tabIndex={0}
      aria-label={`open chat ${c.name || c.key || c.id}`}
      aria-current={open ? 'true' : undefined}
      onClick={onOpen}
      onKeyDown={(e) => { if (!editing && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen(); } }}
      className={`group flex items-center gap-2 px-2 py-1.5 compact:py-1 rounded-md text-left text-xs hover:bg-accent cursor-pointer transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background ${open ? 'bg-accent' : ''} ${dim || hostOffline ? 'opacity-60' : ''}`}
    >
      {onToggleSelect && (
        // The selection checkbox sits leftmost, before the status dot. Click +
        // keydown stop propagation (mirrors the pin/hide/kill hover buttons
        // below) so toggling selection never also opens the chat. Subtle
        // (hover/focus-revealed) until selection is active somewhere in the view
        // or this row is itself selected — keeps the default fleet list quiet
        // while staying keyboard-accessible (focus-within reveals it).
        <span
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          className={cn('flex shrink-0 items-center', selected || selectionActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100')}
        >
          <Checkbox
            checked={!!selected}
            onCheckedChange={() => onToggleSelect()}
            aria-label={`${selected ? 'deselect' : 'select'} ${c.name || c.key || c.id}`}
          />
        </span>
      )}
      {showStatusIndicators !== false && (
        // Four grayscale-legible states via shape, not hue:
        //   open         = solid filled circle (●)
        //   active       = half-filled glyph   (◐) — distinct from both open & idle
        //   idle         = hollow ring         (○)
        //   host offline = red square + WifiOff (▪ 📶̸) — unreachable (WARDEN-198).
        //                  Distinct from idle/undiscovered: shape + icon + tooltip +
        //                  dim, never the idle ring alone. Driven by the host-status
        //                  poll, so it self-clears when the host comes back online.
        hostOffline ? (
          <span className="inline-flex items-center gap-1" title="host offline — unreachable">
            <StatusDot tone="red" variant="square" label="host offline — unreachable" />
            <WifiOff className="size-3 text-red-500 shrink-0" aria-hidden="true" />
          </span>
        ) : open ? (
          <StatusDot tone="green" variant="solid" label="Open" />
        ) : c.active ? (
          <StatusDot tone="green" variant="glyph" glyph="◐" label="Active" />
        ) : (
          <StatusDot tone="muted" variant="ring" label="Idle" />
        )
      )}
      {editing ? (
        <Input autoFocus value={val} onClick={(e) => e.stopPropagation()} onChange={(e) => setVal(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setVal(c.name || c.key || c.id); setEditing(false); } }} className="h-5 text-[11px] px-1 flex-1" />
      ) : (
        <span className="truncate flex-1" onDoubleClick={(e) => { if (canRename) { e.stopPropagation(); setVal(c.name || c.key || c.id); setEditing(true); } }} title={canRename ? 'double-click to rename' : undefined}>
          {c.name || c.key || c.id}
          {(showTypeBadges !== false || showProjectBadges || gitInfo?.branch) && (
            <>
              {showTypeBadges !== false && <span className={`ml-1 text-[10px] ${typeColor}`}>{type}</span>}
              {c.role && !isUser && <span className="ml-1 text-[10px] text-muted-foreground">{c.role}</span>}
              {showProjectBadges && c.project && <span className="ml-1 text-[10px] text-muted-foreground">{c.project}</span>}
              {isUser && showHostTags !== false && hostTag && <span className="ml-1 text-[10px] text-muted-foreground">{hostTag}</span>}
              {(gitInfo?.branch || gitInfo?.detached) && (
                <GitBranchBadge
                  branch={gitInfo.branch ?? ''}
                  chatId={c.key || c.id}
                  clean={gitInfo.clean}
                  commits={gitCommits}
                  loading={gitLogLoading}
                  onFetch={onFetchGitLog}
                  ahead={gitInfo.ahead}
                  behind={gitInfo.behind}
                  inProgress={gitInfo.inProgress}
                  stashCount={gitInfo.stashCount}
                  detached={gitInfo.detached}
                  headSha={gitInfo.headSha}
                  incomingCommits={incomingCommits}
                  incomingLoading={incomingLoading}
                  onFetchIncoming={onFetchIncoming}
                  outgoingCommits={outgoingCommits}
                  outgoingLoading={outgoingLoading}
                  onFetchOutgoing={onFetchOutgoing}
                  className="ml-1"
                />
              )}
            </>
          )}
          {gitInfo?.clean === false && gitInfo.files && gitInfo.files.length > 0 && (
            <div className="ml-1 mt-0.5 flex flex-col gap-0.5">
              {gitInfo.files.map((file, i) => (
                <GitChangedFile key={file.path + '-' + i} file={file} onOpen={onOpenDiff} />
              ))}
            </div>
          )}
        </span>
      )}
      {!editing && onTogglePin && (
        <IconTooltip label={isPinned ? 'unpin' : 'pin'}>
          <button
            className={`px-0.5 ${isPinned ? 'text-yellow-500' : 'text-muted-foreground hover:text-foreground'} ${isUser ? 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100' : ''} active:scale-95 transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded`}
            onClick={(e) => { e.stopPropagation(); onTogglePin(); }}
          >
            📌
          </button>
        </IconTooltip>
      )}
      {isUser && !editing && (
        <>
          {onHide && <IconTooltip label="hide"><button className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-muted-foreground hover:text-foreground px-0.5 active:scale-95 transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded" onClick={(e) => { e.stopPropagation(); onHide(); }}>▾</button></IconTooltip>}
          {onUnhide && <IconTooltip label="unhide"><button className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-muted-foreground hover:text-foreground px-0.5 active:scale-95 transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded" onClick={(e) => { e.stopPropagation(); onUnhide(); }}>▴</button></IconTooltip>}
          <IconTooltip label="kill + forget">
            <button
              className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-muted-foreground hover:text-red-500 px-0.5 active:scale-95 transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded"
              onClick={(e) => { e.stopPropagation(); onKill(); }}
            >
              ×
            </button>
          </IconTooltip>
        </>
      )}
    </div>
  );
}

// Host tag for display: (local) → "local", else the host name.


// A row in the primary "opened chats" list (the user's activeTabs working set).
// Table-like columns: drag handle · status indicator · display name · last-activity time
// · type/host/project/git badges · rename · remove. Rename works directly on the row for
// manual/spawned chats via the ✎ affordance only (single-click the row opens/focuses it;
// gating rename off double-click avoids the two-fires-before-dblclick open-then-edit jank);
// yatfa agents are not renameable. Drag-reorder is preserved via the parent-owned
// dragIdx/dragOverIdx pair.
function OpenedChatRow({ id, c, isOpen, onOpen, onRemove, onRename, showHostTags, showTypeBadges, showStatusIndicators, showProjectBadges, gitInfo, gitCommits, gitLogLoading, onFetchGitLog, incomingCommits, incomingLoading, onFetchIncoming, outgoingCommits, outgoingLoading, onFetchOutgoing, onOpenDiff, canDrag, originalIdx, dragIdx, dragOverIdx, setDragIdx, setDragOverIdx, onReorder, onHide, onKill }: {
  id: string;
  c?: Chat;
  isOpen: boolean;
  onOpen: () => void;
  onRemove: () => void;
  onRename: (session: string, kind: string, name: string, host?: string) => void;
  showHostTags?: boolean; showTypeBadges?: boolean; showStatusIndicators?: boolean; showProjectBadges?: boolean;
  gitInfo?: { branch: string | null; detached?: boolean; headSha?: string | null; clean: boolean | null; files?: GitFile[]; ahead?: number | null; behind?: number | null; inProgress?: { operation: string | null }; stashCount?: number | null };
  gitCommits?: GitCommit[]; gitLogLoading?: boolean; onFetchGitLog?: () => void;
  // WARDEN-225: incoming (behind) commits + their own fetch/loader.
  incomingCommits?: GitCommit[]; incomingLoading?: boolean; onFetchIncoming?: () => void;
  // WARDEN-252: outgoing (ahead/unpushed) commits + their own fetch/loader.
  outgoingCommits?: GitCommit[]; outgoingLoading?: boolean; onFetchOutgoing?: () => void;
  onOpenDiff?: (path: string) => void;
  canDrag: boolean;
  originalIdx: number;
  dragIdx: number | null; dragOverIdx: number | null;
  setDragIdx: (n: number | null) => void; setDragOverIdx: (n: number | null) => void;
  onReorder: (from: number, to: number) => void;
  onHide?: () => void;
  onKill?: () => void;
}) {
  const type = c ? chatType(c) : '?';
  const hostTag = c ? hostTagOf(c.host) : '';
  const dead = !c || c.active === false;
  const canRename = !!c && c.kind === 'tmux';
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(() => (c ? displayName(c) : id));

  const startEdit = () => { setVal(c ? displayName(c) : id); setEditing(true); };
  const commit = () => {
    const v = val.trim();
    setEditing(false);
    if (c && v && v !== displayName(c)) onRename(c.key || c.id, c.kind || 'tmux', v, c.host);
  };

  const hasFiles = !dead && gitInfo?.clean === false && gitInfo.files && gitInfo.files.length > 0;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
      <div
      role="button"
      tabIndex={0}
      aria-label={`open tab ${c ? displayName(c) : id}`}
      aria-current={isOpen ? 'true' : undefined}
      draggable={canDrag}
      onDragStart={canDrag ? () => setDragIdx(originalIdx) : undefined}
      onDragOver={canDrag ? (e) => { e.preventDefault(); setDragOverIdx(originalIdx); } : undefined}
      onDragEnd={canDrag ? () => { if (dragIdx !== null && dragOverIdx !== null && dragIdx !== dragOverIdx) onReorder(dragIdx, dragOverIdx); setDragIdx(null); setDragOverIdx(null); } : undefined}
      onDrop={canDrag ? (e) => { e.preventDefault(); if (dragIdx !== null && originalIdx !== dragIdx) onReorder(dragIdx, originalIdx); setDragIdx(null); setDragOverIdx(null); } : undefined}
      onClick={() => { if (!editing) onOpen(); }}
      onKeyDown={(e) => { if (!editing && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen(); } }}
      className={`group flex flex-col gap-0.5 px-2 py-1.5 compact:py-1 rounded-md text-left text-xs hover:bg-accent ${canDrag ? 'cursor-pointer' : 'cursor-default'} transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background ${dead ? 'opacity-50' : ''} ${dragOverIdx === originalIdx && dragIdx !== null ? 'border-t-2 border-primary' : ''}`}
    >
      <div className="flex items-center gap-2">
        <span className={`text-muted-foreground/40 ${canDrag ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'} select-none`}>⠿</span>
        {showStatusIndicators !== false && (
          <StatusDot
            tone={dead ? 'red' : isOpen ? 'green' : 'muted'}
            variant={dead ? 'square' : isOpen ? 'solid' : 'ring'}
            label={dead ? 'Dead' : isOpen ? 'Open' : 'Idle'}
          />
        )}
        {editing ? (
          <Input autoFocus value={val} onClick={(e) => e.stopPropagation()} onChange={(e) => setVal(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setVal(c ? displayName(c) : id); setEditing(false); } }} className="h-5 text-[11px] px-1 flex-1" />
        ) : (
          <span className={`truncate flex-1 ${dead ? 'line-through text-muted-foreground' : ''}`}>
            {c ? displayName(c) : id}
          </span>
        )}
        {!dead && !editing && !!c?.lastActivity && (
          <span className="text-[10px] text-muted-foreground shrink-0" title={new Date(c.lastActivity).toLocaleString()}>{ago(c.lastActivity)}</span>
        )}
        {!dead && !editing && showTypeBadges !== false && <span className={`text-[10px] ${TYPE_COLOR[type] || ''}`}>{type}</span>}
        {!dead && !editing && showHostTags !== false && hostTag && <span className="text-[10px] text-muted-foreground">{hostTag}</span>}
        {!dead && !editing && showProjectBadges && c?.project && <span className="text-[10px] text-muted-foreground">{c.project}</span>}
        {!dead && !editing && (gitInfo?.branch || gitInfo?.detached) && (
          <GitBranchBadge branch={gitInfo.branch ?? ''} chatId={id} clean={gitInfo.clean} commits={gitCommits} loading={gitLogLoading} onFetch={onFetchGitLog} ahead={gitInfo.ahead} behind={gitInfo.behind} inProgress={gitInfo.inProgress} stashCount={gitInfo.stashCount} detached={gitInfo.detached} headSha={gitInfo.headSha} incomingCommits={incomingCommits} incomingLoading={incomingLoading} onFetchIncoming={onFetchIncoming} outgoingCommits={outgoingCommits} outgoingLoading={outgoingLoading} onFetchOutgoing={onFetchOutgoing} />
        )}
        {!editing && canRename && (
          <IconTooltip label="rename"><Button variant="ghost" size="xs" className="px-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-muted-foreground hover:text-foreground" onClick={(e) => { e.stopPropagation(); startEdit(); }} aria-label="rename">✎</Button></IconTooltip>
        )}
        <IconTooltip label={dead ? 'remove dead tab' : 'remove'}><button className={`px-1 text-sm active:scale-95 transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded ${dead ? 'text-red-500 font-bold' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-muted-foreground hover:text-red-500'}`} onClick={(e) => { e.stopPropagation(); onRemove(); }}>×</button></IconTooltip>
      </div>
      {hasFiles && gitInfo?.files && (
        <div className="ml-6 flex flex-col gap-0.5">
          {gitInfo.files.map((file, i) => (<GitChangedFile key={file.path + '-' + i} file={file} onOpen={onOpenDiff} />))}
        </div>
      )}
    </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onOpen()}>Open</ContextMenuItem>
        {!dead && onHide && <ContextMenuItem onSelect={() => onHide()}>Hide</ContextMenuItem>}
        {!dead && onKill && (
          <ContextMenuItem onSelect={() => onKill()}>
            Kill session
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={() => onRemove()}>Remove tab</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
