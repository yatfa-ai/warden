import { useState, useEffect, useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/EmptyState';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { NewChatForm } from './NewChatForm';
import { CollectionsSection } from './CollectionsSection';
import { CreateCollectionDialog } from './CreateCollectionDialog';
import { BroadcastDialog } from './BroadcastDialog';
import { KillDialog } from './KillDialog';
import { summarizeBroadcast, formatBroadcastToast } from '@/lib/broadcast';
import { summarizeKill, formatKillToast } from '@/lib/kill';
import { DiffViewer } from './DiffViewer';
import { useNotificationPrefs } from '@/lib/useNotificationPrefs';
import { loadUi, saveUi } from '@/lib/storage';
import { THIS_MACHINE, basename, chatType, displayName } from '@/lib/chatDisplay';
import { formatTimestamp, type TimestampFormat } from '@/lib/formatTimestamp';
import {
  matchesAgentFilter, compareChats, sortChats, findChat,
  type AgentFilter, type AgentSort,
} from '@/lib/agentFilter';
import { summarizeProjectGitState, detectProjectFileCollisions } from '@/lib/gitStateSummary';
import type { Chat, Collection } from '@/lib/types';
import { StatusDot } from '@/components/StatusDot';
import type { GitCommit, GitFile, ClaudeSession } from './sidebar/types';
import { GitStateBadges, GitCollisionBadge } from './sidebar/GitBadges';
import { ChatRow, OpenedChatRow, ChatRowSkeleton, SessionRowSkeleton } from './sidebar/ChatRows';
import { AgentFilterSortControls } from './sidebar/AgentFilterSortControls';
import { UpdatedAgo, SectionToggle, SelectionActionBar } from './sidebar/SidebarBits';

// Back-compat re-export: OpenChatBrowserPage.tsx imports these types from
// './ChatSidebar' — keep that path stable so it needs no change (WARDEN-315).
export type { ClaudeSession, SessionSearchResult } from './sidebar/types';

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
  // Timestamp format pref (WARDEN-213): routes every sidebar time display through
  // the shared formatTimestamp helper. Pure client-side localStorage pref.
  timestampFormat: TimestampFormat;
}

const LABEL: Record<string, string> = { '(local)': 'this machine' };

export function ChatSidebar({ chats, sshHosts, activeTabs, hiddenTabs, openPanes, onOpenChat, onRemoveActive, onReorder, onHideTab, onUnhideTab, onKill, onRename, onResume, onRefresh, onDiscoverHost, loading, lastRefreshAt, showHostTags, showTypeBadges, showStatusIndicators, showProjectBadges, hideOfflineHosts, onOpenChatBrowser, hostStatuses, timestampFormat }: Props) {
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
  // WARDEN-305: per-agent notes — id → short human annotation (mirrors pins).
  const [agentNotes, setAgentNotes] = useState<Record<string, string>>({});
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [hostSessions, setHostSessions] = useState<Record<string, { sessions: ClaudeSession[]; claudeAvailable?: boolean }>>({});
  const [loadingHost, setLoadingHost] = useState<string | null>(null);
  const [gitStatus, setGitStatus] = useState<Record<string, { branch: string | null; detached?: boolean; headSha?: string | null; clean: boolean | null; cwd: string; files?: GitFile[]; ahead?: number | null; behind?: number | null; upstream?: string | null; inProgress?: { operation: string | null }; stashCount?: number | null }>>({});
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
  const [killOpen, setKillOpen] = useState(false);

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
        setGitStatus((p) => ({ ...p, [chatId]: { branch: j.branch, detached: j.detached, headSha: j.headSha, clean: j.clean, cwd: j.cwd, files: j.files, ahead: j.ahead, behind: j.behind, upstream: j.upstream, inProgress: j.inProgress, stashCount: j.stashCount } }));
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

  // Load pinned chat ids + per-agent notes from the backend on mount
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
    const fetchNotes = async () => {
      try {
        const r = await fetch('/api/agent-notes');
        const j = await r.json();
        setAgentNotes(j.notes || {});
      } catch (error) {
        console.error('[agent-notes] Failed:', error);
      }
    };
    fetchPins();
    fetchNotes();
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

  // WARDEN-305: set or clear a per-agent note and persist it (mirrors togglePin).
  // Empty/blank text clears the note (server deletes the key).
  const setNote = async (chatId: string, text: string) => {
    try {
      const r = await fetch('/api/agent-notes', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: chatId, note: text }),
      });
      if (r.ok) {
        const j = await r.json();
        setAgentNotes(j.notes || {});
      }
    } catch (error) {
      console.error('[agent-notes-save] Failed:', error);
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

  // Fan a KILL out to every selected agent via the existing per-target /api/kill
  // path (server.js → killTmux + catalog forget), then summarize. This is the
  // batch analogue of handleBroadcastSend and of App.tsx's per-row performKill
  // — but deliberately its OWN fan-out (NOT N calls to the per-row onKill): the
  // per-row path drives a single killTarget confirm slot and an optimistic-per-
  // id UI built for one id, so batching it races the slot and clobbers the wrong
  // dialog. Here, Promise.allSettled (not Promise.all) means a partial failure —
  // one host unreachable, one session already dead — is reported per-agent and
  // does NOT abort the other kills. Never throws: failure is encoded in the
  // summary. Returns the summary so the KillDialog can close on completion.
  const handleKillSelected = async () => {
    const ids = Array.from(selectedIds);
    const results = await Promise.allSettled(
      ids.map((id) =>
        fetch('/api/kill', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
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
    const summary = summarizeKill(results, ids, nameOf);
    const outcome = formatKillToast(summary);
    if (prefs.notifyChatOps) {
      if (outcome.variant === 'success') {
        toast.success(outcome.title);
      } else {
        // whitespace-pre-line so the per-agent failure list (joined with \n in
        // formatKillToast) renders one failure per line instead of collapsing.
        toast.error(outcome.title, { description: <span className="whitespace-pre-line">{outcome.description}</span> });
      }
    }
    // Reconcile rows after the fan-out: re-read the catalog (manual tmux chats
    // are forgotten server-side) AND re-discover each unique host so yatfa
    // (auto-discovered) agents reflect the dead tmux session immediately rather
    // than waiting for the 60s poll — mirroring performKill's refresh() +
    // discoverHost(host) per kill, deduped across the batch's hosts. Stale ids
    // (an agent that died between selecting and killing) resolve to no host and
    // are simply absent here, but were still killed-at above and reported as a
    // per-agent failure rather than silently dropped.
    onRefresh();
    const hosts = new Set<string>();
    selectedChats.forEach((c) => { if (c.host) hosts.add(c.host); });
    hosts.forEach((h) => onDiscoverHost(h));
    // The kill's intent is discharged — clear the selection regardless of
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
          {/* WARDEN-338: one-click broadcast to the whole collection. Resolves the
              collection's live membership (the same `agents` array the list renders,
              so the target set is byte-for-byte what the action bar's "All" button
              selects) and opens BroadcastDialog pre-targeted at exactly those agents.
              Nothing sends until the dialog's Confirm (the safety gate). Disabled when
              the collection has no matching agents — no zero-target confirm dialog. */}
          <Button
            type="button"
            size="xs"
            variant="secondary"
            disabled={agents.length === 0}
            onClick={() => {
              selectAll(agents.map((c) => c.key || c.id));
              setBroadcastOpen(true);
            }}
            title={
              agents.length === 0
                ? 'no agents in this collection to broadcast to'
                : `Broadcast to all ${agents.length} agent${agents.length === 1 ? '' : 's'}`
            }
          >
            Broadcast {agents.length}
          </Button>
        </div>
        <ScrollArea className="flex-1 min-h-0">
          <div className="p-1.5 flex flex-col gap-0.5">
            {C.metadata?.description && (
              <div className="px-2 pt-1 pb-2 text-[10px] text-muted-foreground">{C.metadata.description}</div>
            )}
            {(visibleActive.length > 0 || idle.length > 0 || hiddenActive.length > 0) && (
              <div className="px-2 pt-1 pb-1 text-[10px] uppercase tracking-wider text-green-500/80 font-semibold">● matching agents</div>
            )}
            {visibleActive.map((c) => <ChatRow key={c.id} c={c} open={openPanes.has(c.key || c.id)} onOpen={() => openFromCollection(c.key || c.id)} hostStatus={hostStatuses[c.host]?.status} onKill={() => onKill(c.key || c.id)} onRename={onRename} onHide={() => onHideTab(c.key || c.id)} showHostTags={showHostTags} showTypeBadges={showTypeBadges} showStatusIndicators={showStatusIndicators} showProjectBadges={showProjectBadges} isPinned={pinnedChatIds.has(c.id)} onTogglePin={() => togglePin(c.id)} selected={selectedIds.has(c.key || c.id)} onToggleSelect={() => toggleSelect(c.key || c.id)} selectionActive={selectedIds.size > 0} note={agentNotes[c.id]} onSetNote={(text: string) => setNote(c.id, text)} />)}
            {hiddenActive.length > 0 && (
              <>
                <SectionToggle expanded={hiddenExpanded} onClick={() => setHiddenExpanded(!hiddenExpanded)} label={`hidden (${hiddenActive.length})`} />
                {hiddenExpanded && hiddenActive.map((c) => (
                  <ChatRow key={c.id} c={c} open={openPanes.has(c.key || c.id)} onOpen={() => openFromCollection(c.key || c.id)} hostStatus={hostStatuses[c.host]?.status} onKill={() => onKill(c.key || c.id)} onRename={onRename} onUnhide={() => onUnhideTab(c.key || c.id)} dim showHostTags={showHostTags} showTypeBadges={showTypeBadges} showStatusIndicators={showStatusIndicators} showProjectBadges={showProjectBadges} isPinned={pinnedChatIds.has(c.id)} onTogglePin={() => togglePin(c.id)} selected={selectedIds.has(c.key || c.id)} onToggleSelect={() => toggleSelect(c.key || c.id)} selectionActive={selectedIds.size > 0} note={agentNotes[c.id]} onSetNote={(text: string) => setNote(c.id, text)} />
                ))}
              </>
            )}
            {idle.length > 0 && (
              <>
                <div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground/60">idle</div>
                {idle.map((c) => <ChatRow key={c.id} c={c} open={openPanes.has(c.key || c.id)} onOpen={() => openFromCollection(c.key || c.id)} hostStatus={hostStatuses[c.host]?.status} onKill={() => onKill(c.key || c.id)} onRename={onRename} dim showHostTags={showHostTags} showTypeBadges={showTypeBadges} showStatusIndicators={showStatusIndicators} showProjectBadges={showProjectBadges} isPinned={pinnedChatIds.has(c.id)} onTogglePin={() => togglePin(c.id)} selected={selectedIds.has(c.key || c.id)} onToggleSelect={() => toggleSelect(c.key || c.id)} selectionActive={selectedIds.size > 0} note={agentNotes[c.id]} onSetNote={(text: string) => setNote(c.id, text)} />)}
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
          <SelectionActionBar
            count={selectedIds.size}
            onSelectAll={() => selectAll(agents.map((c) => c.key || c.id))}
            onClear={clearSelection}
            onSend={() => setBroadcastOpen(true)}
            onKill={() => setKillOpen(true)}
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
        <KillDialog
          open={killOpen}
          onOpenChange={setKillOpen}
          targets={selectedChats}
          onKill={handleKillSelected}
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
            {visibleActive.map((c) => <ChatRow key={c.id} c={c} open={openPanes.has(c.key || c.id)} onOpen={() => openFromHost(c.key || c.id)} hostStatus={hostStatuses[c.host]?.status} onKill={() => onKill(c.key || c.id)} onRename={onRename} onHide={() => onHideTab(c.key || c.id)} gitInfo={gitStatus[c.key || c.id]} gitCommits={gitLog[c.key || c.id]} gitLogLoading={gitLogLoading[c.key || c.id]} onFetchGitLog={() => fetchGitLog(c.key || c.id)} incomingCommits={gitLogIncoming[c.key || c.id]} incomingLoading={gitLogIncomingLoading[c.key || c.id]} onFetchIncoming={() => fetchGitLogIncoming(c.key || c.id)} outgoingCommits={gitLogOutgoing[c.key || c.id]} outgoingLoading={gitLogOutgoingLoading[c.key || c.id]} onFetchOutgoing={() => fetchGitLogOutgoing(c.key || c.id)} onOpenDiff={(path) => setDiffTarget({ chatId: c.key || c.id, path })} showHostTags={showHostTags} showTypeBadges={showTypeBadges} showStatusIndicators={showStatusIndicators} showProjectBadges={showProjectBadges} isPinned={pinnedChatIds.has(c.id)} onTogglePin={() => togglePin(c.id)} selected={selectedIds.has(c.key || c.id)} onToggleSelect={() => toggleSelect(c.key || c.id)} selectionActive={selectedIds.size > 0} note={agentNotes[c.id]} onSetNote={(text: string) => setNote(c.id, text)} />)}
            {hiddenActive.length > 0 && (
              <>
                <SectionToggle expanded={hiddenExpanded} onClick={() => setHiddenExpanded(!hiddenExpanded)} label={`hidden (${hiddenActive.length})`} />
                {hiddenExpanded && hiddenActive.map((c) => (
                  <ChatRow key={c.id} c={c} open={openPanes.has(c.key || c.id)} onOpen={() => openFromHost(c.key || c.id)} hostStatus={hostStatuses[c.host]?.status} onKill={() => onKill(c.key || c.id)} onRename={onRename} onUnhide={() => onUnhideTab(c.key || c.id)} dim gitInfo={gitStatus[c.key || c.id]} gitCommits={gitLog[c.key || c.id]} gitLogLoading={gitLogLoading[c.key || c.id]} onFetchGitLog={() => fetchGitLog(c.key || c.id)} incomingCommits={gitLogIncoming[c.key || c.id]} incomingLoading={gitLogIncomingLoading[c.key || c.id]} onFetchIncoming={() => fetchGitLogIncoming(c.key || c.id)} outgoingCommits={gitLogOutgoing[c.key || c.id]} outgoingLoading={gitLogOutgoingLoading[c.key || c.id]} onFetchOutgoing={() => fetchGitLogOutgoing(c.key || c.id)} onOpenDiff={(path) => setDiffTarget({ chatId: c.key || c.id, path })} showHostTags={showHostTags} showTypeBadges={showTypeBadges} showStatusIndicators={showStatusIndicators} showProjectBadges={showProjectBadges} isPinned={pinnedChatIds.has(c.id)} onTogglePin={() => togglePin(c.id)} selected={selectedIds.has(c.key || c.id)} onToggleSelect={() => toggleSelect(c.key || c.id)} selectionActive={selectedIds.size > 0} note={agentNotes[c.id]} onSetNote={(text: string) => setNote(c.id, text)} />
                ))}
              </>
            )}
            {idle.length > 0 && (
              <>
                <div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground/60">idle</div>
                {idle.map((c) => <ChatRow key={c.id} c={c} open={openPanes.has(c.key || c.id)} onOpen={() => openFromHost(c.key || c.id)} hostStatus={hostStatuses[c.host]?.status} onKill={() => onKill(c.key || c.id)} onRename={onRename} dim gitInfo={gitStatus[c.key || c.id]} gitCommits={gitLog[c.key || c.id]} gitLogLoading={gitLogLoading[c.key || c.id]} onFetchGitLog={() => fetchGitLog(c.key || c.id)} incomingCommits={gitLogIncoming[c.key || c.id]} incomingLoading={gitLogIncomingLoading[c.key || c.id]} onFetchIncoming={() => fetchGitLogIncoming(c.key || c.id)} outgoingCommits={gitLogOutgoing[c.key || c.id]} outgoingLoading={gitLogOutgoingLoading[c.key || c.id]} onFetchOutgoing={() => fetchGitLogOutgoing(c.key || c.id)} onOpenDiff={(path) => setDiffTarget({ chatId: c.key || c.id, path })} showHostTags={showHostTags} showTypeBadges={showTypeBadges} showStatusIndicators={showStatusIndicators} showProjectBadges={showProjectBadges} isPinned={pinnedChatIds.has(c.id)} onTogglePin={() => togglePin(c.id)} selected={selectedIds.has(c.key || c.id)} onToggleSelect={() => toggleSelect(c.key || c.id)} selectionActive={selectedIds.size > 0} note={agentNotes[c.id]} onSetNote={(text: string) => setNote(c.id, text)} />)}
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
                      {isLoading ? <Skeleton className="h-2.5 w-1/2 inline-block" /> : `${formatTimestamp(s.mtime, timestampFormat)} · ${basename(s.cwd)}`}
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
          <SelectionActionBar
            count={selectedIds.size}
            onSelectAll={() => selectAll(sortedHostChats.map((c) => c.key || c.id))}
            onClear={clearSelection}
            onSend={() => setBroadcastOpen(true)}
            onKill={() => setKillOpen(true)}
          />
        )}
        <BroadcastDialog
          open={broadcastOpen}
          onOpenChange={setBroadcastOpen}
          targets={selectedChats}
          onSend={handleBroadcastSend}
        />
        <KillDialog
          open={killOpen}
          onOpenChange={setKillOpen}
          targets={selectedChats}
          onKill={handleKillSelected}
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
        <span className="@max-[20rem]:hidden"><UpdatedAgo at={lastRefreshAt} timestampFormat={timestampFormat} /></span>
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
                note={c ? agentNotes[c.id] : undefined}
                onSetNote={c ? (text: string) => setNote(c.id, text) : undefined}
                timestampFormat={timestampFormat}
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
      <KillDialog
        open={killOpen}
        onOpenChange={setKillOpen}
        targets={selectedChats}
        onKill={handleKillSelected}
      />
    </div>
  );
}
