import { useState, useEffect, useCallback, useMemo } from 'react';
import { Popover as RadixPopover } from 'radix-ui';
import { toast } from 'sonner';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/EmptyState';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { SlidersHorizontal, WifiOff } from 'lucide-react';
import { NewChatForm } from './NewChatForm';
import { CollectionsSection } from './CollectionsSection';
import { CreateCollectionDialog } from './CreateCollectionDialog';
import { DiffViewer } from './DiffViewer';
import { useNotificationPrefs } from '@/lib/useNotificationPrefs';
import { cn } from '@/lib/utils';
import { classifyDiffLine, DIFF_LINE_CLASS } from '@/lib/diff';
import type { Chat, Collection } from '@/lib/types';
import { loadUi, saveUi } from '@/lib/storage';
import { StatusDot } from '@/components/StatusDot';

// One row from /api/git-log (a parsed %h|%s|%an|%ar git log line).
export type GitCommit = { hash: string; subject: string; author: string; date: string };

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
  onRename: (session: string, kind: string, name: string) => void;
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
}

const THIS_MACHINE = '(local)';
const LABEL: Record<string, string> = { '(local)': 'this machine' };
function ago(ms: number) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
function basename(p: string) { return (p || '').replace(/[\\/]+/g, '/').replace(/\/$/, '').split('/').pop() || p; }
function chatType(c?: Chat): string {
  if (!c) return '?';
  if (c.kind === 'yatfa') return 'yatfa';
  const bin = (c.cmd || '').split(/\s+/)[0].replace(/^.*[/\\]/, '');
  if (bin === 'claude' || bin === 'claude.exe') return (c.cmd || '').includes('--resume') ? 'resume' : 'claude';
  if (['bash', 'sh', 'zsh', 'fish', 'pwsh', 'powershell', 'cmd.exe'].includes(bin)) return 'shell';
  return bin || 'manual';
}

// Agent-list filter/sort controls (WARDEN-91). Shared across the root, host, and
// collection views so the option lists and matching logic can never drift.
export type AgentFilter = 'all' | 'yatfa' | 'claude' | 'manual' | 'active' | 'hidden';
export type AgentSort = 'manual' | 'name' | 'host' | 'status' | 'activity';

const FILTER_OPTIONS: { value: AgentFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'yatfa', label: 'Yatfa agents only' },
  { value: 'claude', label: 'Claude sessions only' },
  { value: 'manual', label: 'Manual/shell only' },
  { value: 'active', label: 'Active only' },
  { value: 'hidden', label: 'Hidden only' },
];

const SORT_OPTIONS: { value: AgentSort; label: string }[] = [
  { value: 'manual', label: 'Manual order' },
  { value: 'name', label: 'Name (A-Z)' },
  { value: 'host', label: 'Host' },
  { value: 'status', label: 'Status (active first)' },
  { value: 'activity', label: 'Last activity' },
];

// Does `c` pass the active agent filter? Hidden membership matches on the
// host-prefixed id (`key || id`) so it lines up with hideTab()/activeTabs.
function matchesAgentFilter(c: Chat, filter: AgentFilter, hiddenTabs: string[]): boolean {
  switch (filter) {
    case 'yatfa': return chatType(c) === 'yatfa';
    case 'claude': { const t = chatType(c); return t === 'claude' || t === 'resume'; }
    case 'manual': { const t = chatType(c); return t === 'shell' || t === 'manual'; }
    case 'active': return c.active === true;
    case 'hidden': return hiddenTabs.includes(c.key || c.id);
    case 'all':
    default: return true;
  }
}

// Comparator for non-manual sorts. `manual` is handled by the caller (it
// preserves drag order and must not touch the array).
function compareChats(a: Chat, b: Chat, sort: AgentSort): number {
  switch (sort) {
    case 'name': return (a.name || a.id).localeCompare(b.name || b.id);
    case 'host': return (a.host || '').localeCompare(b.host || '');
    case 'status': {
      const sa = a.active === true ? 1 : 0;
      const sb = b.active === true ? 1 : 0;
      return sa !== sb ? sb - sa : a.id.localeCompare(b.id);
    }
    case 'activity': return (b.lastActivity || 0) - (a.lastActivity || 0);
    case 'manual':
    default: return 0;
  }
}

// Sort a chat list by the selected criterion. Manual sort is a no-op that
// returns the input unchanged so drag-to-reorder order is preserved.
function sortChats(chats: Chat[], sort: AgentSort): Chat[] {
  return sort === 'manual' ? chats : [...chats].sort((a, b) => compareChats(a, b, sort));
}

const TYPE_COLOR: Record<string, string> = {
  resume: 'text-cyan-400', claude: 'text-green-400', shell: 'text-yellow-400',
  yatfa: 'text-blue-400', manual: 'text-violet-400', '?': 'text-muted-foreground',
};

// Process + cwd basename label, e.g. "claude · warden". This is the guaranteed fallback
// that ensures a spawned chat's meaningless random id (chat-xxxxx) is NEVER the label.
function processCwdLabel(c: Chat): string {
  const proc = chatType(c);
  const dir = basename(c.cwd || '');
  return dir ? `${proc} · ${dir}` : proc;
}

// Display-name precedence (WARDEN-163):
//   yatfa agents     → project-role (the container/key name; not user-renameable)
//   manual/spawned   → user rename > Claude description (carried as `name` on resume)
//                      > process+cwd basename > internal key
// The raw chat-xxxxx id is NEVER shown: a fresh spawn has name === key, so it falls
// through to processCwdLabel. A user rename or a resumed session sets name ≠ key.
function displayName(c?: Chat): string {
  if (!c) return '?';
  if (c.kind === 'yatfa') return c.key || c.id;
  if (c.name && c.name !== c.key) return c.name;
  return processCwdLabel(c);
}


function findChat(chats: Chat[], id: string) { return chats.find((c) => (c.key || c.id) === id); }

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

export function ChatSidebar({ chats, sshHosts, activeTabs, hiddenTabs, openPanes, onOpenChat, onRemoveActive, onReorder, onHideTab, onUnhideTab, onKill, onRename, onResume, onRefresh, onDiscoverHost, loading, lastRefreshAt, showHostTags, showTypeBadges, showStatusIndicators, showProjectBadges, hideOfflineHosts }: Props) {
  const [view, setView] = useState<{ kind: 'root' } | { kind: 'host'; host: string } | { kind: 'collection'; collection: Collection }>({ kind: 'root' });
  const [hiddenExpanded, setHiddenExpanded] = useState(false);
  const [offlineExpanded, setOfflineExpanded] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [tabSearchQuery, setTabSearchQuery] = useState('');
  const [killingChatId, setKillingChatId] = useState<string | null>(null);
  const [resumingSessionId, setResumingSessionId] = useState<string | null>(null);
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
  const [pinnedChatIds, setPinnedChatIds] = useState<Set<string>>(new Set());
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [hostSessions, setHostSessions] = useState<Record<string, { sessions: ClaudeSession[]; claudeAvailable?: boolean }>>({});
  const [loadingHost, setLoadingHost] = useState<string | null>(null);
  const [allSessions, setAllSessions] = useState<(ClaudeSession & { host: string })[]>([]);
  const [loadingAllSessions, setLoadingAllSessions] = useState(false);
  // Cross-host "All Sessions" pagination (WARDEN-176). `hasMoreSessions` mirrors the
  // server's `hasMore` so Load-more converges; `loadingMoreSessions` gates the button.
  const [hasMoreSessions, setHasMoreSessions] = useState(false);
  const [loadingMoreSessions, setLoadingMoreSessions] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [gitStatus, setGitStatus] = useState<Record<string, { branch: string | null; clean: boolean | null; cwd: string; files?: GitFile[]; ahead?: number | null; behind?: number | null; inProgress?: { operation: string | null } }>>({});
  // recent commit history (git log) per chatId — cached so re-expanding the badge is instant
  const [gitLog, setGitLog] = useState<Record<string, GitCommit[]>>({});
  const [gitLogLoading, setGitLogLoading] = useState<Record<string, boolean>>({});
  // Per-file diff dialog (WARDEN-151): which chatId + path is shown in the DiffViewer.
  const [diffTarget, setDiffTarget] = useState<{ chatId: string; path: string } | null>(null);
  const { prefs } = useNotificationPrefs();
  const [agentFilter, setAgentFilter] = useState<AgentFilter>('all');
  const [agentSort, setAgentSort] = useState<AgentSort>('manual');

  // Extract project counts from active agents
  const projectCounts = chats.reduce((acc, c) => {
    if (c.active && c.project) {
      acc[c.project] = (acc[c.project] || 0) + 1;
    }
    return acc;
  }, {} as Record<string, number>);

  const [hostStatuses, setHostStatuses] = useState<Record<string, { status: 'online' | 'offline' | 'unknown'; latency_ms: number | null }>>({});

  // Fetch all sessions on mount
  useEffect(() => { fetchAllSessions(); }, []);

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
        setGitStatus((p) => ({ ...p, [chatId]: { branch: j.branch, clean: j.clean, cwd: j.cwd, files: j.files, ahead: j.ahead, behind: j.behind, inProgress: j.inProgress } }));
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

  // Page size for the cross-host "All Sessions" list. Matches the server default
  // (and the old hard global cap), so page 1 is identical to the pre-pagination UI.
  const ALL_SESSIONS_PAGE = 40;

  // Fetch page 1 of the cross-host session list (most-recent first), REPLACING the
  // loaded set. Used on mount, on browser open, and as the manual refresh — every
  // call resets to the newest page so the long tail is reached via Load-more, not
  // by scrolling a stale list.
  const fetchAllSessions = async () => {
    setLoadingAllSessions(true);
    try {
      const r = await fetch(`/api/claude-sessions-all?offset=0&limit=${ALL_SESSIONS_PAGE}`);
      const j = await r.json();
      setAllSessions(j.sessions || []);
      setHasMoreSessions(!!j.hasMore);
    } catch (error) {
      console.error('[claude-sessions-all] Failed:', error);
    }
    setLoadingAllSessions(false);
  };

  // Fetch the NEXT page and APPEND it to the loaded set. Offset = the number already
  // loaded, since the server paginates over the global recency-sorted timeline.
  // Sessions are deduped by host:id so a shifting timeline (a host becoming
  // reachable between requests) can't produce visual duplicates.
  const loadMoreSessions = async () => {
    if (loadingMoreSessions || !hasMoreSessions) return;
    setLoadingMoreSessions(true);
    try {
      const r = await fetch(`/api/claude-sessions-all?offset=${allSessions.length}&limit=${ALL_SESSIONS_PAGE}`);
      const j = await r.json();
      const next = (j.sessions || []) as (ClaudeSession & { host: string })[];
      setHasMoreSessions(!!j.hasMore);
      setAllSessions((prev) => {
        const seen = new Set(prev.map((s) => `${s.host}:${s.id}`));
        return [...prev, ...next.filter((s) => !seen.has(`${s.host}:${s.id}`))];
      });
    } catch (error) {
      console.error('[claude-sessions-all load-more] Failed:', error);
    }
    setLoadingMoreSessions(false);
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

  // Fetch host connectivity statuses every 30 seconds
  useEffect(() => {
    const fetchHostStatuses = async () => {
      try {
        const r = await fetch('/api/hosts/status');
        const j = await r.json();
        const statuses: Record<string, { status: 'online' | 'offline' | 'unknown'; latency_ms: number | null }> = {};
        j.hosts.forEach((h: { host: string; status: string; latency_ms: number | null }) => {
          statuses[h.host] = {
            status: h.status as 'online' | 'offline' | 'unknown',
            latency_ms: h.latency_ms
          };
        });
        setHostStatuses(statuses);
      } catch {
        // Graceful degradation - show unknown status
      }
    };

    fetchHostStatuses();
    const interval = setInterval(fetchHostStatuses, 30000);
    return () => clearInterval(interval);
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

  const handleKill = async (id: string) => {
    if (killingChatId) return;
    setKillingChatId(id);
    try {
      await onKill(id);
    } finally {
      setKillingChatId(null);
    }
  };

  const handleRename = async (session: string, kind: string, name: string) => {
    if (renamingChatId) return;
    setRenamingChatId(session);
    try {
      await onRename(session, kind, name);
    } finally {
      setRenamingChatId(null);
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
            {visibleActive.map((c) => <ChatRow key={c.id} c={c} open={openPanes.has(c.key || c.id)} onOpen={() => openFromCollection(c.key || c.id)} hostStatus={hostStatuses[c.host]?.status} onKill={() => handleKill(c.key || c.id)} onRename={(session, kind, name) => handleRename(session, kind, name)} onHide={() => onHideTab(c.key || c.id)} showHostTags={showHostTags} showTypeBadges={showTypeBadges} showStatusIndicators={showStatusIndicators} showProjectBadges={showProjectBadges} killingChatId={killingChatId} renamingChatId={renamingChatId} isPinned={pinnedChatIds.has(c.id)} onTogglePin={() => togglePin(c.id)} />)}
            {hiddenActive.length > 0 && (
              <>
                <SectionToggle expanded={hiddenExpanded} onClick={() => setHiddenExpanded(!hiddenExpanded)} label={`hidden (${hiddenActive.length})`} />
                {hiddenExpanded && hiddenActive.map((c) => (
                  <ChatRow key={c.id} c={c} open={openPanes.has(c.key || c.id)} onOpen={() => openFromCollection(c.key || c.id)} hostStatus={hostStatuses[c.host]?.status} onKill={() => handleKill(c.key || c.id)} onRename={(session, kind, name) => handleRename(session, kind, name)} onUnhide={() => onUnhideTab(c.key || c.id)} dim showHostTags={showHostTags} showTypeBadges={showTypeBadges} showStatusIndicators={showStatusIndicators} showProjectBadges={showProjectBadges} killingChatId={killingChatId} renamingChatId={renamingChatId} isPinned={pinnedChatIds.has(c.id)} onTogglePin={() => togglePin(c.id)} />
                ))}
              </>
            )}
            {idle.length > 0 && (
              <>
                <div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground/60">idle</div>
                {idle.map((c) => <ChatRow key={c.id} c={c} open={openPanes.has(c.key || c.id)} onOpen={() => openFromCollection(c.key || c.id)} hostStatus={hostStatuses[c.host]?.status} onKill={() => handleKill(c.key || c.id)} onRename={(session, kind, name) => handleRename(session, kind, name)} dim showHostTags={showHostTags} showTypeBadges={showTypeBadges} showStatusIndicators={showStatusIndicators} showProjectBadges={showProjectBadges} killingChatId={killingChatId} renamingChatId={renamingChatId} isPinned={pinnedChatIds.has(c.id)} onTogglePin={() => togglePin(c.id)} />)}
              </>
            )}
            {agents.length === 0 && (
              <div className="p-3">
                <EmptyState type="no-results" message="no agents match this collection" />
              </div>
            )}
          </div>
        </ScrollArea>
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
            {visibleActive.map((c) => <ChatRow key={c.id} c={c} open={openPanes.has(c.key || c.id)} onOpen={() => openFromHost(c.key || c.id)} hostStatus={hostStatuses[c.host]?.status} onKill={() => handleKill(c.key || c.id)} onRename={(session, kind, name) => handleRename(session, kind, name)} onHide={() => onHideTab(c.key || c.id)} gitInfo={gitStatus[c.key || c.id]} gitCommits={gitLog[c.key || c.id]} gitLogLoading={gitLogLoading[c.key || c.id]} onFetchGitLog={() => fetchGitLog(c.key || c.id)} onOpenDiff={(path) => setDiffTarget({ chatId: c.key || c.id, path })} showHostTags={showHostTags} showTypeBadges={showTypeBadges} showStatusIndicators={showStatusIndicators} showProjectBadges={showProjectBadges} killingChatId={killingChatId} renamingChatId={renamingChatId} isPinned={pinnedChatIds.has(c.id)} onTogglePin={() => togglePin(c.id)} />)}
            {hiddenActive.length > 0 && (
              <>
                <SectionToggle expanded={hiddenExpanded} onClick={() => setHiddenExpanded(!hiddenExpanded)} label={`hidden (${hiddenActive.length})`} />
                {hiddenExpanded && hiddenActive.map((c) => (
                  <ChatRow key={c.id} c={c} open={openPanes.has(c.key || c.id)} onOpen={() => openFromHost(c.key || c.id)} hostStatus={hostStatuses[c.host]?.status} onKill={() => handleKill(c.key || c.id)} onRename={(session, kind, name) => handleRename(session, kind, name)} onUnhide={() => onUnhideTab(c.key || c.id)} dim gitInfo={gitStatus[c.key || c.id]} gitCommits={gitLog[c.key || c.id]} gitLogLoading={gitLogLoading[c.key || c.id]} onFetchGitLog={() => fetchGitLog(c.key || c.id)} onOpenDiff={(path) => setDiffTarget({ chatId: c.key || c.id, path })} showHostTags={showHostTags} showTypeBadges={showTypeBadges} showStatusIndicators={showStatusIndicators} showProjectBadges={showProjectBadges} killingChatId={killingChatId} renamingChatId={renamingChatId} isPinned={pinnedChatIds.has(c.id)} onTogglePin={() => togglePin(c.id)} />
                ))}
              </>
            )}
            {idle.length > 0 && (
              <>
                <div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground/60">idle</div>
                {idle.map((c) => <ChatRow key={c.id} c={c} open={openPanes.has(c.key || c.id)} onOpen={() => openFromHost(c.key || c.id)} hostStatus={hostStatuses[c.host]?.status} onKill={() => handleKill(c.key || c.id)} onRename={(session, kind, name) => handleRename(session, kind, name)} dim gitInfo={gitStatus[c.key || c.id]} gitCommits={gitLog[c.key || c.id]} gitLogLoading={gitLogLoading[c.key || c.id]} onFetchGitLog={() => fetchGitLog(c.key || c.id)} onOpenDiff={(path) => setDiffTarget({ chatId: c.key || c.id, path })} showHostTags={showHostTags} showTypeBadges={showTypeBadges} showStatusIndicators={showStatusIndicators} showProjectBadges={showProjectBadges} killingChatId={killingChatId} renamingChatId={renamingChatId} isPinned={pinnedChatIds.has(c.id)} onTogglePin={() => togglePin(c.id)} />)}
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
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 compact:gap-1 px-3 py-2 compact:py-1.5 border-b shrink-0">
        <span className="text-xs text-muted-foreground">active</span>
        <Input
          placeholder="filter..."
          value={tabSearchQuery}
          onChange={(e) => setTabSearchQuery(e.target.value)}
          className="h-6 text-[10px] px-2 flex-1 max-w-[120px]"
        />
        <AgentFilterSortControls
          agentFilter={agentFilter}
          agentSort={agentSort}
          onFilterChange={setAgentFilter}
          onSortChange={setAgentSort}
        />
        <Badge variant="secondary" className="text-xs">{sortedTabs.length}</Badge>
        <UpdatedAgo at={lastRefreshAt} />
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
              </button>
              {Object.entries(projectCounts).map(([project, count]) => (
                <button
                  key={project}
                  onClick={() => setProjectFilter(project)}
                  className={`text-xs px-2 py-1 rounded transition-all duration-150 ease-out active:scale-95 ${projectFilter === project ? 'bg-accent' : 'hover:bg-accent/50'}`}
                >
                  {project} ({count})
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
                onRename={(session, kind, name) => handleRename(session, kind, name)}
                renamingChatId={renamingChatId}
                onHide={() => onHideTab(id)}
                onKill={() => handleKill(id)}
                killingChatId={killingChatId}
                canDrag={canDrag}
                showHostTags={showHostTags}
                showTypeBadges={showTypeBadges}
                showStatusIndicators={showStatusIndicators}
                showProjectBadges={showProjectBadges}
                gitInfo={gitStatus[id]}
                gitCommits={gitLog[id]}
                gitLogLoading={gitLogLoading[id]}
                onFetchGitLog={() => fetchGitLog(id)}
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
              onClick={() => setBrowserOpen(true)}
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
      <OpenChatBrowser
        open={browserOpen}
        onOpenChange={setBrowserOpen}
        hosts={hosts}
        chats={chats}
        allSessions={allSessions}
        loadingAllSessions={loadingAllSessions}
        hasMoreSessions={hasMoreSessions}
        loadingMoreSessions={loadingMoreSessions}
        onRefreshSessions={fetchAllSessions}
        onLoadMoreSessions={loadMoreSessions}
        onOpenChat={onOpenChat}
        onResume={onResume}
        onDiscoverHost={onDiscoverHost}
        hostStatuses={hostStatuses}
      />
      <DiffViewer
        chatId={diffTarget?.chatId ?? ''}
        filePath={diffTarget?.path ?? ''}
        open={!!diffTarget}
        onOpenChange={(o) => { if (!o) setDiffTarget(null); }}
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
/** Render a committed diff as a scrollable, colorized monospace block, reusing the
 *  shared line classifier + palette (classifyDiffLine / DIFF_LINE_CLASS in
 *  @/lib/diff) so a commit's file diff renders identically to the modal working-tree
 *  DiffViewer (WARDEN-151) — same green/red/muted coloring, no second classifier. */
function DiffBlock({ diff }: { diff: string }) {
  return (
    <pre className="mt-0.5 max-h-64 overflow-auto rounded bg-muted/40 p-1 font-mono text-[10px] leading-tight whitespace-pre">
      {diff.split('\n').map((ln, i) => (
        <div key={i} className={DIFF_LINE_CLASS[classifyDiffLine(ln)]}>{ln || ' '}</div>
      ))}
    </pre>
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

function GitBranchBadge({ branch, clean, commits, loading, onFetch, ahead, behind, chatId, inProgress, className }: {
  branch: string;
  clean: boolean | null;
  commits?: GitCommit[];
  loading?: boolean;
  onFetch?: () => void;
  ahead?: number | null;
  behind?: number | null;
  chatId: string;
  inProgress?: { operation: string | null };
  className?: string;
}) {
  const aheadCount = typeof ahead === 'number' ? ahead : 0;
  const behindCount = typeof behind === 'number' ? behind : 0;
  // The operation an agent is blocked mid-way through (merge/rebase/cherry-pick/
  // revert/bisect), or null when none is in progress. This is the highest-value
  // signal in the badge: a blocked agent produces nothing until noticed (WARDEN-186).
  const operation = inProgress?.operation || null;
  const titleParts = [branch];
  if (operation) titleParts.push(`${operation} in progress`);
  if (clean === false) titleParts.push('uncommitted changes');
  if (aheadCount > 0) titleParts.push(`${aheadCount} unpushed`);
  if (behindCount > 0) titleParts.push(`${behindCount} behind remote`);

  // Per-commit expand state + the /api/git-show files cache (keyed by hash) so a
  // repeat expansion is instant. The popover owns the interaction, so this state
  // lives here rather than being prop-drilled through ChatRow/ChatSidebar.
  const [expandedHash, setExpandedHash] = useState<string | null>(null);
  const [showCache, setShowCache] = useState<Record<string, { files?: GitFile[]; error?: string | null }>>({});
  const [showLoading, setShowLoading] = useState<Record<string, boolean>>({});

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

  const toggleCommit = (hash: string) => {
    if (expandedHash === hash) {
      setExpandedHash(null);
    } else {
      setExpandedHash(hash);
      if (!showCache[hash]) fetchShow(hash);
    }
  };

  return (
    <RadixPopover.Root onOpenChange={(open) => { if (open && commits === undefined && !loading) onFetch?.(); }}>
      <RadixPopover.Trigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className={cn('inline-flex items-center gap-0.5 text-[10px] text-cyan-400 hover:text-cyan-300 cursor-pointer', className)}
          title={`${titleParts.join(' · ')} — click for recent commits`}
        >
          {operation && <span className="text-red-400 font-medium" title={`${operation} in progress`}>⚠ {operation}</span>}
          {branch}
          {clean === false && <span className="text-yellow-400">±</span>}
          {aheadCount > 0 && <span className="text-amber-400">↑{aheadCount}</span>}
          {behindCount > 0 && <span className="text-blue-400">↓{behindCount}</span>}
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
              recent commits · {branch}
              {aheadCount > 0 && <span className="text-amber-400"> · ↑ {aheadCount} unpushed</span>}
            </span>
            <IconTooltip label="refresh" disabled={loading}>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onFetch?.(); }}
                className="shrink-0 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                disabled={loading}
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
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}

function ChatRow({ c, open, onOpen, onKill, onRename, onHide, onUnhide, dim, hostStatus, gitInfo, gitCommits, gitLogLoading, onFetchGitLog, onOpenDiff, showHostTags, showTypeBadges, showStatusIndicators, showProjectBadges, killingChatId, renamingChatId, isPinned, onTogglePin }: {
  c: Chat; open: boolean; onOpen: () => void; onKill: () => void;
  onRename: (session: string, kind: string, name: string) => void;
  onHide?: () => void; onUnhide?: () => void; dim?: boolean;
  // WARDEN-198: per-host reachability from the 30s /api/hosts/status poll.
  // 'offline' → the row renders a distinct "unreachable" state.
  hostStatus?: 'online' | 'offline' | 'unknown';
  gitInfo?: { branch: string | null; clean: boolean | null; files?: GitFile[]; ahead?: number | null; behind?: number | null; inProgress?: { operation: string | null } };
  gitCommits?: GitCommit[]; gitLogLoading?: boolean; onFetchGitLog?: () => void;
  onOpenDiff?: (path: string) => void;
  showHostTags?: boolean; showTypeBadges?: boolean; showStatusIndicators?: boolean; showProjectBadges?: boolean;
  killingChatId?: string | null; renamingChatId?: string | null;
  isPinned?: boolean; onTogglePin?: () => void;
}) {
  const isUser = c.kind === 'tmux';
  const canRename = isUser;
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(c.name || c.key || c.id);
  const type = chatType(c);
  const typeColor = TYPE_COLOR[type] || 'text-violet-400';
  const hostTag = isUser ? (c.host === '(local)' ? 'local' : (c.host || '')) : null;
  const chatId = c.key || c.id;
  const isKilling = killingChatId === chatId;
  const isRenaming = renamingChatId === chatId;
  // WARDEN-198: when this agent's managed host is offline, render a distinct
  // "unreachable" state instead of the ambiguous idle/undiscovered gray dot.
  // Driven by the shared 30s host-status poll, so it self-clears on recovery.
  const hostOffline = hostStatus === 'offline';
  const commit = () => {
    const v = val.trim();
    if (v && v !== (c.name || c.key)) {
      setEditing(false);
      onRename(c.key || c.id, c.kind || 'tmux', v);
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
              {gitInfo?.branch && (
                <GitBranchBadge
                  branch={gitInfo.branch}
                  chatId={c.key || c.id}
                  clean={gitInfo.clean}
                  commits={gitCommits}
                  loading={gitLogLoading}
                  onFetch={onFetchGitLog}
                  ahead={gitInfo.ahead}
                  behind={gitInfo.behind}
                  inProgress={gitInfo.inProgress}
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
          <IconTooltip label="kill + forget" disabled={isKilling || isRenaming}>
            <button
              className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-muted-foreground hover:text-red-500 px-0.5 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded"
              onClick={(e) => { e.stopPropagation(); onKill(); }}
              disabled={isKilling || isRenaming}
            >
              {isKilling ? <Skeleton className="h-3 w-3" /> : '×'}
            </button>
          </IconTooltip>
        </>
      )}
    </div>
  );
}

// Host tag for display: (local) → "local", else the host name.
function hostTagOf(host: string) { return host === THIS_MACHINE ? 'local' : host; }

// A row in the primary "opened chats" list (the user's activeTabs working set).
// Table-like columns: drag handle · status indicator · display name · last-activity time
// · type/host/project/git badges · rename · remove. Rename works directly on the row for
// manual/spawned chats via the ✎ affordance only (single-click the row opens/focuses it;
// gating rename off double-click avoids the two-fires-before-dblclick open-then-edit jank);
// yatfa agents are not renameable. Drag-reorder is preserved via the parent-owned
// dragIdx/dragOverIdx pair.
function OpenedChatRow({ id, c, isOpen, onOpen, onRemove, onRename, renamingChatId, showHostTags, showTypeBadges, showStatusIndicators, showProjectBadges, gitInfo, gitCommits, gitLogLoading, onFetchGitLog, onOpenDiff, canDrag, originalIdx, dragIdx, dragOverIdx, setDragIdx, setDragOverIdx, onReorder, onHide, onKill, killingChatId }: {
  id: string;
  c?: Chat;
  isOpen: boolean;
  onOpen: () => void;
  onRemove: () => void;
  onRename: (session: string, kind: string, name: string) => void;
  renamingChatId?: string | null;
  showHostTags?: boolean; showTypeBadges?: boolean; showStatusIndicators?: boolean; showProjectBadges?: boolean;
  gitInfo?: { branch: string | null; clean: boolean | null; files?: GitFile[]; ahead?: number | null; behind?: number | null; inProgress?: { operation: string | null } };
  gitCommits?: GitCommit[]; gitLogLoading?: boolean; onFetchGitLog?: () => void;
  onOpenDiff?: (path: string) => void;
  canDrag: boolean;
  originalIdx: number;
  dragIdx: number | null; dragOverIdx: number | null;
  setDragIdx: (n: number | null) => void; setDragOverIdx: (n: number | null) => void;
  onReorder: (from: number, to: number) => void;
  onHide?: () => void;
  onKill?: () => void;
  killingChatId?: string | null;
}) {
  const type = c ? chatType(c) : '?';
  const hostTag = c ? hostTagOf(c.host) : '';
  const dead = !c || c.active === false;
  const canRename = !!c && c.kind === 'tmux';
  const chatKey = c?.key || c?.id || id;
  const isRenaming = renamingChatId === chatKey;
  const isKilling = killingChatId === chatKey;
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(() => (c ? displayName(c) : id));

  const startEdit = () => { setVal(c ? displayName(c) : id); setEditing(true); };
  const commit = () => {
    const v = val.trim();
    setEditing(false);
    if (c && v && v !== displayName(c)) onRename(c.key || c.id, c.kind || 'tmux', v);
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
        {!dead && !editing && gitInfo?.branch && (
          <GitBranchBadge branch={gitInfo.branch} chatId={id} clean={gitInfo.clean} commits={gitCommits} loading={gitLogLoading} onFetch={onFetchGitLog} ahead={gitInfo.ahead} behind={gitInfo.behind} inProgress={gitInfo.inProgress} />
        )}
        {!editing && canRename && (
          <IconTooltip label="rename"><Button variant="ghost" size="xs" className="px-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-muted-foreground hover:text-foreground" onClick={(e) => { e.stopPropagation(); startEdit(); }} disabled={isRenaming} aria-label="rename">{isRenaming ? <Skeleton className="h-3 w-3" /> : '✎'}</Button></IconTooltip>
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
          <ContextMenuItem disabled={isKilling} onSelect={() => onKill()}>
            {isKilling ? <Skeleton className="h-3 w-16" /> : 'Kill session'}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={() => onRemove()}>Remove tab</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ---- "Open chat" discovery browser ----
// Persisted host multiselect (the user's browsing scope). Stored under its own key so it
// can't race with App's centralized UiState save. Undefined = first run → default later.
const DISCOVER_HOSTS_KEY = 'warden:discover-hosts:v1';
function loadDiscoverHosts(): string[] | undefined {
  try {
    const v = JSON.parse(localStorage.getItem(DISCOVER_HOSTS_KEY) || '');
    if (Array.isArray(v)) return v.filter((h) => typeof h === 'string');
  } catch { /* ignore */ }
  return undefined;
}
function saveDiscoverHosts(hosts: string[]) {
  try { localStorage.setItem(DISCOVER_HOSTS_KEY, JSON.stringify(hosts)); } catch { /* ignore */ }
}

// One normalized row in the merged discovery list.
interface DiscoverItem {
  id: string;            // unique list key
  kind: 'live' | 'history';
  label: string;         // display name
  hostTag: string;
  sub: string;           // secondary line: host · cwd · time
  time: number;          // recency, for sorting (0 = unknown)
  openId?: string;       // live: chat key/id to openChat
  resume?: { id: string; description: string; cwd: string; host: string }; // history: resume params
  snippet?: string;      // content-match snippet (full-content search only)
}

function DiscoverItemRow({ it, resumingId, onOpen, onResume }: { it: DiscoverItem; resumingId: string | null; onOpen: () => void; onResume: () => void; }) {
  if (it.kind === 'live') {
    return (
      <Button variant="ghost" onClick={onOpen} className="w-full h-auto justify-start gap-2 px-2 py-1.5 text-xs font-normal hover:bg-accent">
        <StatusDot tone="green" variant="solid" label="Live session" />
        <span className="truncate flex-1">{it.label}</span>
        {it.time ? <span className="text-[10px] text-muted-foreground shrink-0">{ago(it.time)}</span> : null}
        <span className="text-[10px] text-muted-foreground shrink-0">{it.hostTag}</span>
        <span className="text-[10px] text-green-500/80 shrink-0">live</span>
      </Button>
    );
  }
  const isLoading = resumingId === it.id;
  return (
    <div className="group flex items-center gap-2 px-2 py-1.5 rounded-md text-xs hover:bg-accent transition-colors">
      <StatusDot tone="cyan" variant="ring" label="History session (resumable)" />
      <div className="flex-1 min-w-0">
        <Button variant="ghost" onClick={onResume} disabled={isLoading} className="h-auto w-full justify-start px-1 py-0 truncate text-xs font-normal">{it.label}</Button>
        {it.snippet ? <div className="px-1 truncate text-[10px] text-muted-foreground/80 italic" title={it.snippet}>{it.snippet}</div> : null}
      </div>
      {it.time ? <span className="text-[10px] text-muted-foreground shrink-0">{ago(it.time)}</span> : null}
      <span className="text-[10px] text-muted-foreground shrink-0">{it.hostTag}</span>
      <IconTooltip label="bump to live (resume)" disabled={isLoading}>
        <Button variant="ghost" size="xs" onClick={onResume} disabled={isLoading} className="text-[10px] text-cyan-400 hover:text-cyan-300 px-1 h-auto">
          {isLoading ? <Skeleton className="h-3 w-6 inline-block" /> : '↻ resume'}
        </Button>
      </IconTooltip>
    </div>
  );
}

// Single merged, host-scoped picker. Hosts are multiselect chips (persisted, defaulting to
// the user's usual hosts). The list dedupes: a Claude history session already running as a
// live resume-tmux appears once (as a live item), not in both live and history.
function OpenChatBrowser({ open, onOpenChange, hosts, chats, allSessions, loadingAllSessions, hasMoreSessions, loadingMoreSessions, onRefreshSessions, onLoadMoreSessions, onOpenChat, onResume, onDiscoverHost, hostStatuses }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  hosts: string[];
  chats: Chat[];
  allSessions: (ClaudeSession & { host: string })[];
  loadingAllSessions: boolean;
  hasMoreSessions: boolean;
  loadingMoreSessions: boolean;
  onRefreshSessions: () => void;
  onLoadMoreSessions: () => void;
  onOpenChat: (id: string) => void;
  onResume: (id: string, description: string, cwd: string, host: string) => void;
  onDiscoverHost: (host: string) => void;
  hostStatuses: Record<string, { status: 'online' | 'offline' | 'unknown'; latency_ms: number | null }>;
}) {
  const [selected, setSelected] = useState<string[] | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [resumingId, setResumingId] = useState<string | null>(null);
  const [contentResults, setContentResults] = useState<SessionSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  // Load persisted host selection once.
  useEffect(() => { setSelected(loadDiscoverHosts()); }, []);

  // "usual hosts" = hosts of the user's currently-active chats (their daily scope).
  const usualHosts = useMemo(() => {
    const set = new Set<string>();
    for (const c of chats) if (c.active && c.host) set.add(c.host);
    return Array.from(set);
  }, [chats]);

  // Resolved selection: persisted → usual hosts → all hosts.
  const effective = useMemo(() => {
    if (selected && selected.length) return selected;
    return usualHosts.length ? usualHosts : hosts;
  }, [selected, usualHosts, hosts]);

  // On open: refresh history sessions and discover selected remote hosts so live items
  // populate. Fire-and-forget — chats update flows back as each host resolves.
  useEffect(() => {
    if (!open) return;
    onRefreshSessions();
    effective.forEach((h) => { if (h !== THIS_MACHINE) onDiscoverHost(h); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Full-content session search (WARDEN-161). When the query is non-empty, debounce
  // and hit /api/claude-sessions-search so matches INSIDE a session's body — not just
  // its summary — surface, including sessions outside the top-40 list. Empty query
  // clears results so the instant top-40 list is preserved (no regression).
  useEffect(() => {
    const q = query.trim();
    if (!q) { setContentResults([]); setSearchLoading(false); return; }
    setSearchLoading(true);
    // Clear the previous query's results immediately so stale matches (and their
    // snippets) are never rendered under the new query while the debounce waits.
    setContentResults([]);
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/claude-sessions-search?q=${encodeURIComponent(q)}`);
        if (!r.ok) throw new Error(`session search HTTP ${r.status}`);
        const j = await r.json();
        if (!cancelled) setContentResults(Array.isArray(j.results) ? j.results : []);
      } catch (error) {
        console.error('[claude-sessions-search] Failed:', error);
        if (!cancelled) setContentResults([]);
      } finally {
        if (!cancelled) setSearchLoading(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query]);

  const toggleHost = (h: string) => {
    setSelected((prev) => {
      const base = prev && prev.length ? prev : effective;
      const next = base.includes(h) ? base.filter((x) => x !== h) : [...base, h];
      saveDiscoverHosts(next);
      if (!base.includes(h) && h !== THIS_MACHINE) onDiscoverHost(h);
      return next;
    });
  };

  // Build the merged, deduped list. Live tmux sessions first (tracking resume- keys to
  // dedupe), then Claude history sessions minus those already shown live.
  const items = useMemo<DiscoverItem[]>(() => {
    const sel = new Set(effective);
    const out: DiscoverItem[] = [];
    const liveResumeSid8 = new Set<string>();
    for (const c of chats) {
      if (!sel.has(c.host) || c.active !== true) continue;
      const key = c.key || c.id;
      if (key && key.startsWith('resume-')) liveResumeSid8.add(key.slice(7));
      out.push({
        id: 'live:' + key, kind: 'live', label: displayName(c),
        hostTag: hostTagOf(c.host),
        sub: `${hostTagOf(c.host)}${c.cwd ? ' · ' + basename(c.cwd) : ''}`,
        time: c.lastActivity || 0, openId: key,
      });
    }
    // History source: full-content search results when a query is present
    // (reaches sessions OUTSIDE the top-40 by what was discussed), else the
    // instant top-40 list. Either way, dedupe against live resume sessions.
    const q = query.trim();
    const history: { id: string; host: string; cwd: string; summary: string; mtime: number; snippet?: string }[] = q
      ? contentResults.map((r) => ({ id: r.sessionId, host: r.host, cwd: r.cwd, summary: r.summary, mtime: r.mtime, snippet: r.snippet }))
      : allSessions.map((s) => ({ id: s.id, host: s.host, cwd: s.cwd, summary: s.summary, mtime: s.mtime }));
    for (const s of history) {
      if (!sel.has(s.host)) continue;
      if (liveResumeSid8.has(s.id.slice(0, 8))) continue; // already shown as live
      out.push({
        id: 'hist:' + s.host + ':' + s.id, kind: 'history',
        label: s.summary || `${basename(s.cwd) || 'session'} · ${hostTagOf(s.host)}`,
        hostTag: hostTagOf(s.host), sub: `${hostTagOf(s.host)} · ${basename(s.cwd)}`,
        time: s.mtime, snippet: s.snippet,
        resume: { id: s.id, description: s.summary, cwd: s.cwd, host: s.host },
      });
    }
    out.sort((a, b) => b.time - a.time);
    return out;
  }, [effective, chats, allSessions, contentResults, query]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    // History rows already matched via full-content search; only live rows get
    // the metadata filter so a running session is still findable by name/host.
    return items.filter((it) => {
      if (it.kind === 'history') return true;
      return it.label.toLowerCase().includes(q) || it.sub.toLowerCase().includes(q);
    });
  }, [items, query]);

  const handleResume = async (it: DiscoverItem) => {
    if (!it.resume || resumingId) return;
    setResumingId(it.id);
    try { await onResume(it.resume.id, it.resume.description, it.resume.cwd, it.resume.host); onOpenChange(false); }
    finally { setResumingId(null); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Open chat</DialogTitle>
          <DialogDescription>
            One merged list across your hosts — live tmux sessions and Claude history. Search finds sessions by what was discussed in them, not just their title — across every host.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-1.5">
            {hosts.map((h) => {
              const on = effective.includes(h);
              const st = hostStatuses[h];
              return (
                <Button key={h} size="xs" variant={on ? 'secondary' : 'outline'} onClick={() => toggleHost(h)} className="gap-1">
                  <StatusDot
                    size="size-1.5"
                    tone={st?.status === 'online' ? 'green' : st?.status === 'offline' ? 'red' : 'muted'}
                    variant={st?.status === 'online' ? 'solid' : st?.status === 'offline' ? 'square' : 'ring'}
                    label={st?.status ? st.status.charAt(0).toUpperCase() + st.status.slice(1) : 'Unknown'}
                  />
                  {h === THIS_MACHINE ? 'this machine' : h}
                </Button>
              );
            })}
          </div>
          <Input placeholder="Search live + history sessions…" value={query} onChange={(e) => setQuery(e.target.value)} className="text-xs" />
          <ScrollArea className="max-h-80">
            <div className="flex flex-col gap-0.5 pr-1">
              {loadingAllSessions && items.length === 0 ? (
                [1, 2, 3, 4].map((i) => <SessionRowSkeleton key={i} />)
              ) : searchLoading && filtered.length === 0 ? (
                [1, 2, 3].map((i) => <SessionRowSkeleton key={i} />)
              ) : filtered.length === 0 ? (
                <div className="text-xs text-muted-foreground p-4 text-center">
                  {query ? 'No matches across selected hosts' : effective.length === 0 ? 'Select at least one host' : 'Nothing runnable on the selected hosts yet'}
                </div>
              ) : (
                filtered.map((it) => (
                  <DiscoverItemRow
                    key={it.id}
                    it={it}
                    resumingId={resumingId}
                    onOpen={() => { if (it.openId) { onOpenChat(it.openId); onOpenChange(false); } }}
                    onResume={() => handleResume(it)}
                  />
                ))
              )}
              {searchLoading && filtered.length > 0 && (
                <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] text-muted-foreground">
                  <Skeleton className="size-2 rounded-full" /> searching session content…
                </div>
              )}
              {/* Load more surfaces the long tail (sessions older than the newest
                  page) without requiring a search. Only relevant when browsing the
                  history list — a content query uses /api/claude-sessions-search,
                  which has its own results, so hide this while searching. */}
              {!query.trim() && hasMoreSessions && filtered.length > 0 && (
                <button
                  onClick={onLoadMoreSessions}
                  disabled={loadingMoreSessions}
                  className="mt-1 mx-auto text-[11px] text-blue-400 hover:text-blue-300 disabled:text-muted-foreground/50 disabled:cursor-default rounded px-2 py-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  {loadingMoreSessions ? 'loading…' : '↓ load more'}
                </button>
              )}
            </div>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}
