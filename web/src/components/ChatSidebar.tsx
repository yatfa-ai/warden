import { useState, useEffect, useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/EmptyState';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { NewChatForm } from './NewChatForm';
import { CollectionsSection } from './CollectionsSection';
import { CreateCollectionDialog } from './CreateCollectionDialog';
import { BroadcastDialog } from './BroadcastDialog';
import { KillDialog } from './KillDialog';
import { KeySendDialog } from './KeySendDialog';
import { SnoozeDialog } from './SnoozeDialog';
import { summarizeBroadcast, formatBroadcastToast } from '@/lib/broadcast';
import { formatKillToast, runKillFanout } from '@/lib/kill';
import { formatKeySendToast, runKeySendFanout } from '@/lib/keysend';
import { copyText } from '@/lib/clipboard';
import { DiffViewer } from './DiffViewer';
import { ConflictView } from './ConflictView';
import { FileViewer } from './FileViewer';
import { useNotificationPrefs } from '@/lib/useNotificationPrefs';
import { RECENTLY_CLOSED_PREVIEW, type Snippet, type RecentlyClosedEntry } from '@/lib/storage';
import { THIS_MACHINE, basename, chatType, displayName, hostLabelFor } from '@/lib/chatDisplay';
import { useHostLabels } from '@/lib/hostLabels';
import { formatTimestamp, type TimestampFormat } from '@/lib/formatTimestamp';
import { formatTokens } from '@/lib/formatTokens';
import {
  matchesAgentFilter, sortChats, findChat,
  type AgentFilter, type AgentSort,
} from '@/lib/agentFilter';
import { chatMatchesCriteria } from '@/lib/collections';
import { getLastSeen, WHATS_NEW_FETCH_LIMIT } from '@/lib/whatsNew';
import type { SnoozeDuration } from '@/lib/snooze';
import type { Chat, Collection, AgentStateRow } from '@/lib/types';
import { StatusDot } from '@/components/StatusDot';
import type { GitCommit, GitFile, ClaudeSession, DiffStat } from './sidebar/types';
import { ChatRow, OpenPaneRow, ChatRowSkeleton, SessionRowSkeleton } from './sidebar/ChatRows';
import { AgentFilterSortControls } from './sidebar/AgentFilterSortControls';
import { FleetCommitSearch } from './sidebar/FleetCommitSearch';
// WARDEN-565: re-homes the orphaned WARDEN-288 cross-agent file-collision ⚠ badge
// into the fleet view headers (the surfaces that replaced the abolished project-
// chip row, WARDEN-372). The badge is fully built; it was simply never rendered.
// WARDEN-635: GitStateBadges (the ±N/↑N/↓N fleet WIP badges, orphaned by the same
// WARDEN-372 abolition) is re-homed alongside it here, now extended with a 4th ⚑N
// at-risk-repo-state axis — mounting it lights up all four axes at once.
// WARDEN-639: detectProjectOutgoingCollisions feeds a 3rd cross-agent collision
// sibling (committed×committed, both unpushed) alongside the live ⚠ and impending ⏱.
import { GitCollisionBadge, GitStateBadges, GitTriageCallout } from './sidebar/GitBadges';
import { detectProjectFileCollisions, detectProjectImpendingCollisions, detectProjectOutgoingCollisions, summarizeProjectGitState } from '@/lib/gitStateSummary';
import { UpdatedAgo, SectionToggle, SelectionActionBar } from './sidebar/SidebarBits';
import { SourceControlPanel } from './sidebar/SourceControlPanel';
import { SessionTagChips, SessionTagFilterRow } from './sidebar/SessionTags';
import { computeTagsInUse, filterSessionsByTags, addTag, removeTag } from '@/lib/sessionTags';

// Back-compat re-export: OpenChatBrowserPage.tsx imports these types from
// './ChatSidebar' — keep that path stable so it needs no change (WARDEN-315).
export type { ClaudeSession, SessionSearchResult, TokenUsage } from './sidebar/types';

interface Props {
  chats: Chat[];
  sshHosts: string[];
  // WARDEN-372: the sidebar root is panes-first. openPanes is the active
  // workspace's pane set (grid order); recentlyClosed is that workspace's
  // per-workspace recovery list. The tabs model (activeTabs/hiddenTabs) is gone.
  openPanes: Set<string>;
  recentlyClosed: RecentlyClosedEntry[];
  // WARDEN-431: the focused pane id (whichever pane is focused in the grid) —
  // the Source Control panel re-points to this pane's repo. null when nothing is
  // focused (the panel renders nothing).
  focused?: string | null;
  onOpenChat: (id: string) => void;
  onClosePane: (id: string) => void;
  onReopenClosed: (id: string) => void;
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
  // File Viewer markdown view mode (WARDEN-480): the per-file FileViewer opened
  // from a sidebar row (Ctrl/Cmd-click on a `path:line` token) shares the same
  // global App-owned 'rendered' | 'source' toggle as PaneGrid's FileViewer, so a
  // human's preference is consistent regardless of which surface opened the file.
  // Read-only here (App owns/persists it); forwarded straight to the FileViewer.
  fileViewerViewMode: 'rendered' | 'source';
  onFileViewerViewModeChange: (mode: 'rendered' | 'source') => void;
  // Saved instruction snippets (WARDEN-323): threaded straight through to the
  // BroadcastDialog as an insert-only picker. Pure client-side localStorage pref;
  // owned by App (persisted by its saveUi effect), so this is a read-only prop
  // here — ChatSidebar never mutates it.
  snippets: Snippet[];
  // WARDEN-378: per-chat "watch" set (pane keys) + the toggle handler. Owned by App
  // (persisted via its saveUi effect); read-only here except for the toggle, which
  // delegates to App. Threaded to every chat row so the watch affordance + its
  // active state render consistently across the fleet list and the open-panes list.
  watchedChats: Set<string>;
  // WARDEN-514: per-key CURRENT-state lookup for watched chats (row.key ?? row.id →
  // AgentStateRow). Threaded to each row so a watched chat that CURRENTLY needs the
  // human (waiting/erroring/stuck/blocked) shows a persistent, state-aware indicator
  // on its own row — even when its pane is closed (the header AttentionBadge is open-
  // gated, so a watched-but-CLOSED pane never reaches it). Built by App from the
  // rollup's already-fetched watchedStates exposure (zero extra SSH cost); read-only
  // here. A watched key absent from the map (before the first poll / on a transient
  // fetch blip) → the row degrades to the neutral watch glyph (the safe default).
  watchedStates: Record<string, AgentStateRow>;
  onToggleWatch: (key: string) => void;
  // WARDEN-581 — bulk attention controls for the multi-select action bar, the
  // group twins of setAlertMute / toggleWatch. Snooze: time-box every selected
  // key (no permanent-mute bulk path — out of scope). Watch: add/remove every
  // selected key in one state write. Both owned by App (single writer of the
  // `warden:ui` blob) and threaded down here as delegated handlers, mirroring
  // onToggleWatch. The bar's Watch/Unwatch LABEL is computed here from
  // watchedChats ∩ the selection (below), so these props stay pure callbacks.
  onSnoozeMany: (keys: string[], mode: SnoozeDuration) => void;
  onToggleWatchMany: (keys: string[], on: boolean) => void;
  // WARDEN-442: sidebar fleet Filter (all/yatfa/claude/manual) + Sort, shipped in
  // WARDEN-91. Owned by App and persisted by its saveUi effect (these were
  // previously ChatSidebar-local useState, which App's lossy saveUi spread then
  // wiped on every unrelated state change — the controls silently reset on
  // reload). Read-only here except for the two change handlers, which delegate to
  // App so it stays the single writer of the `warden:ui` blob. Threaded to the
  // AgentFilterSortControls in both the collapsed and expanded fleet views.
  agentFilter: AgentFilter;
  agentSort: AgentSort;
  onFilterChange: (filter: AgentFilter) => void;
  onSortChange: (sort: AgentSort) => void;
  // WARDEN-431: Source Control section collapse state + setter. Owned by App
  // (persisted via its saveUi effect, like sidebarCollapsed); the panel component
  // receives them as props so it stays self-contained for the sidebar redesign
  // (WARDEN-257).
  sourceControlCollapsed?: boolean;
  onSourceControlCollapsedChange?: (collapsed: boolean) => void;
}

const LABEL: Record<string, string> = { '(local)': 'this machine' };

// WARDEN-742: preview row count for the per-host past-session resume list. The
// backend caps the per-host payload at SESSION_SEARCH_PER_HOST (20), so this is
// strictly a preview ceiling — "show more" reveals the rest of what was fetched
// (at most 8 more rows). Kept separate from RECENTLY_CLOSED_PREVIEW so the two
// lists can evolve independently.
const SESSION_PREVIEW = 12;

// Query-string builders (module-level so the fetchers' useCallback deps stay stable).
// incoming/outgoing ignore the limit arg — their limit is hardcoded at 50.
const buildGitLogParams = (limit: number) => `limit=${limit}`;
const buildIncomingParams = () => `limit=50&range=incoming`;
const buildOutgoingParams = () => `limit=50&range=outgoing`;

// Shared skeleton for fetchGitLog / fetchGitLogIncoming / fetchGitLogOutgoing: GET
// /api/git-log?id=…&<buildParams(limit)>, cache commits per chatId (re-expand is
// instant), toggle a per-chatId loading flag, and cache [] on transient failure so
// a re-expand won't loop. Zero behavior change vs. the inline copies (WARDEN-620).
// Deps are all stable (useState setters, a string literal, module consts) so the
// callback keeps a stable identity, matching the original useCallback(fn, []).
function useGitLogFetcher({ setCommits, setLoading, errorLabel, buildParams }: {
  setCommits: (updater: (prev: Record<string, GitCommit[]>) => Record<string, GitCommit[]>) => void;
  setLoading: (updater: (prev: Record<string, boolean>) => Record<string, boolean>) => void;
  errorLabel: string;
  buildParams: (limit: number) => string;
}) {
  return useCallback(async (chatId: string, limit: number = WHATS_NEW_FETCH_LIMIT) => {
    setLoading((p) => ({ ...p, [chatId]: true }));
    try {
      const r = await fetch(`/api/git-log?id=${encodeURIComponent(chatId)}&${buildParams(limit)}`);
      const j = await r.json();
      setCommits((p) => ({ ...p, [chatId]: Array.isArray(j.commits) ? j.commits : [] }));
    } catch (error) {
      // Non-critical: cache an empty list so a transient failure doesn't loop on re-expand.
      console.error(errorLabel, error);
      setCommits((p) => ({ ...p, [chatId]: [] }));
    } finally {
      setLoading((p) => ({ ...p, [chatId]: false }));
    }
  }, [setCommits, setLoading, errorLabel, buildParams]);
}

export function ChatSidebar({ chats, sshHosts, openPanes, recentlyClosed, focused, onOpenChat, onClosePane, onReopenClosed, onKill, onRename, onResume, onRefresh, onDiscoverHost, loading, lastRefreshAt, showHostTags, showTypeBadges, showStatusIndicators, showProjectBadges, hideOfflineHosts, onOpenChatBrowser, hostStatuses, timestampFormat, fileViewerViewMode, onFileViewerViewModeChange, snippets, watchedChats, watchedStates, onToggleWatch, onSnoozeMany, onToggleWatchMany, agentFilter, agentSort, onFilterChange, onSortChange, sourceControlCollapsed, onSourceControlCollapsedChange }: Props) {
  const [view, setView] = useState<{ kind: 'root' } | { kind: 'host'; host: string } | { kind: 'collection'; collection: Collection }>({ kind: 'root' });
  const [offlineExpanded, setOfflineExpanded] = useState(false);
  const hostLabels = useHostLabels();
  // WARDEN-372: "show more" affordance for the per-workspace recently-closed list
  // (5 previewed → up to the 20-entry cap).
  const [showAllClosed, setShowAllClosed] = useState(false);
  // WARDEN-742: "show more" affordance for the per-host past-session resume list.
  // A top-level boolean is fine — the host drill-in shows one host's sessions at a
  // time, and navigating away resets `view`, unmounting the list (no stale
  // cross-host expansion state). Same shape as showAllClosed.
  const [showAllSessions, setShowAllSessions] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [tabSearchQuery, setTabSearchQuery] = useState('');
  const [resumingSessionId, setResumingSessionId] = useState<string | null>(null);
  const [pinnedChatIds, setPinnedChatIds] = useState<Set<string>>(new Set());
  // WARDEN-305: per-agent notes — id → short human annotation (mirrors pins).
  const [agentNotes, setAgentNotes] = useState<Record<string, string>>({});
  // WARDEN-342: per-past-session tags — claude-session id → short reusable labels
  // (local sidecar). activeTagFilters scopes the ☁ sessions list to sessions bearing
  // any of the selected tags (union semantics).
  const [sessionTags, setSessionTags] = useState<Record<string, string[]>>({});
  const [activeTagFilters, setActiveTagFilters] = useState<Set<string>>(new Set());
  const [hostSessions, setHostSessions] = useState<Record<string, { sessions: ClaudeSession[]; claudeAvailable?: boolean }>>({});
  const [loadingHost, setLoadingHost] = useState<string | null>(null);
  const [gitStatus, setGitStatus] = useState<Record<string, { branch: string | null; detached?: boolean; headSha?: string | null; headDate?: string | null; clean: boolean | null; cwd: string; files?: GitFile[]; ahead?: number | null; behind?: number | null; upstream?: string | null; inProgress?: { operation: string | null; detail?: string | null }; stashCount?: number | null; diffstat?: DiffStat | null; outgoingFiles?: string[] | null }>>({});
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
  // `staged` (WARDEN-369): when true the DiffViewer fetches `git diff --cached` (what
  // will be committed) instead of the combined worktree-vs-HEAD diff — set by clicking
  // a STAGED file in the dirty-file list.
  const [diffTarget, setDiffTarget] = useState<{ chatId: string; path: string; staged?: boolean } | null>(null);
  // Per-file conflict dialog (WARDEN-428): which chatId + path is shown in the
  // ConflictView. Set by clicking a CONFLICTED file (UU/AA/UD/…) in the dirty-file
  // list — opens the read-only ours-vs-theirs stage-blob view instead of the staged
  // diff, which is not a usable ours/theirs view for an unmerged path.
  const [conflictTarget, setConflictTarget] = useState<{ chatId: string; path: string } | null>(null);
  // Per-file read dialog (WARDEN-478): which chatId + path is shown in the FileViewer,
  // set by the per-agent git panel's "open file" affordance on a dirty/committed file
  // row. Mirrors diffTarget/conflictTarget: read-only fetch + render, no new backend
  // endpoint (FileViewer reads /api/read-file, /api/git-blame, /api/git-log internally).
  const [fileTarget, setFileTarget] = useState<{ chatId: string; path: string } | null>(null);
  const { prefs } = useNotificationPrefs();

  // Multi-select broadcast (WARDEN-292): the set of selected agent ids, held at
  // the ChatSidebar level so it can span the active/idle fleet lists in whichever
  // fleet view (host or collection) is open. Keyed by `c.key || c.id` — the same
  // identity openPanes/pinnedChatIds use — so a row stays selected across the
  // active→idle regrouping within one view. Selection is scoped to the current
  // fleet view: navigating away (back to root, into a host/collection, or opening
  // a chat) clears it, so the human's mental model is "the agents I picked in THIS
  // list," never a stale cross-view mix. v1 wires selection into ChatRow (the
  // fleet lists) only — the root open-pane rows (OpenPaneRow) are intentionally
  // excluded.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const [killOpen, setKillOpen] = useState(false);
  const [interruptOpen, setInterruptOpen] = useState(false);
  // WARDEN-581 — bulk-snooze duration dialog (sibling of broadcast/kill/interrupt).
  const [snoozeOpen, setSnoozeOpen] = useState(false);

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
        setGitStatus((p) => ({ ...p, [chatId]: { branch: j.branch, detached: j.detached, headSha: j.headSha, headDate: j.headDate, clean: j.clean, cwd: j.cwd, files: j.files, ahead: j.ahead, behind: j.behind, upstream: j.upstream, inProgress: j.inProgress, stashCount: j.stashCount, diffstat: j.diffstat, outgoingFiles: j.outgoingFiles } }));
      }
    } catch (error) {
      // Git status is non-critical, so just log it without showing a toast
      console.error('[git-status] Failed:', error);
    }
  }, []);

  // Recent commits. `limit` defaults to WHATS_NEW_FETCH_LIMIT (50) so the per-agent
  // "What's new since your last visit" marker counts every commit since the last
  // visit (a rare visitor can have dozens); showing up to 50 (vs the old 5) is a
  // benign superset, not a regression (WARDEN-356 review: "count capped at 5").
  const fetchGitLog = useGitLogFetcher({ setCommits: setGitLog, setLoading: setGitLogLoading, errorLabel: 'Failed to fetch git log:', buildParams: buildGitLogParams });
  // Incoming (behind, HEAD..@{u}) via range=incoming (WARDEN-225); limit hardcoded at 50.
  const fetchGitLogIncoming = useGitLogFetcher({ setCommits: setGitLogIncoming, setLoading: setGitLogIncomingLoading, errorLabel: 'Failed to fetch incoming git log:', buildParams: buildIncomingParams });
  // Outgoing (ahead/unpushed, @{u}..HEAD) via range=outgoing (WARDEN-252); limit hardcoded at 50.
  const fetchGitLogOutgoing = useGitLogFetcher({ setCommits: setGitLogOutgoing, setLoading: setGitLogOutgoingLoading, errorLabel: 'Failed to fetch outgoing git log:', buildParams: buildOutgoingParams });

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
    const fetchSessionTags = async () => {
      try {
        const r = await fetch('/api/session-tags');
        const j = await r.json();
        setSessionTags(j.sessionTags || {});
      } catch (error) {
        console.error('[session-tags] Failed:', error);
      }
    };
    fetchPins();
    fetchNotes();
    fetchSessionTags();
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

  // WARDEN-342: set a past session's tags and persist the whole list (local sidecar
  // keyed by claude-session id). The server cleans/dedupes/caps; on success we mirror
  // its returned list into local state (and drop the key when it's empty).
  const updateSessionTags = async (id: string, tags: string[]) => {
    try {
      const r = await fetch('/api/session-tags', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, tags }),
      });
      if (r.ok) {
        const j = await r.json();
        setSessionTags((prev) => {
          const next = { ...prev };
          if (Array.isArray(j.tags) && j.tags.length) next[id] = j.tags;
          else delete next[id];
          return next;
        });
      }
    } catch (error) {
      console.error('[session-tags-save] Failed:', error);
    }
  };
  const addSessionTag = (id: string, tag: string) => {
    updateSessionTags(id, addTag(sessionTags[id] || [], tag));
  };
  const removeSessionTag = (id: string, tag: string) => {
    updateSessionTags(id, removeTag(sessionTags[id] || [], tag));
  };
  const toggleTagFilter = (tag: string) => {
    setActiveTagFilters((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag); else next.add(tag);
      return next;
    });
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

  // WARDEN-581 — drives the action bar's Watch/Unwatch button label. The button
  // offers "Watch N" when ANY selected agent isn't currently watched (the action
  // then adds the whole group), else "Unwatch N" (every selected agent is already
  // watched, so the action removes the group). Recomputed each render from the
  // live selection + watchedChats; defaults to 'watch' for an empty selection
  // (the bar is hidden then anyway, so the value is unused).
  const watchMode: 'watch' | 'unwatch' = selectedChats.some((c) => !watchedChats.has(c.key || c.id))
    ? 'watch'
    : 'unwatch';

  // WARDEN-342: host-view tag surfaces. These memos MUST live at the top level (not
  // inside the `view.kind === 'host'` branch) — hooks can't be called conditionally,
  // and the host branch is a conditional return. Guard on view.kind inside the body.
  // The pure query/mutation logic lives in @/lib/sessionTags (unit-tested there):
  // computeTagsInUse hides orphans (a tag on a vanished session is never shown) and
  // filterSessionsByTags applies the active-filter union. Deps are all stable refs
  // (view/hostSessions only change on navigation/fetch), so the memos hold in-view.
  const tagsInUse = useMemo(() => {
    if (view.kind !== 'host') return [];
    return computeTagsInUse(hostSessions[view.host]?.sessions || [], sessionTags);
  }, [view, hostSessions, sessionTags]);
  const visibleSessions = useMemo(() => {
    if (view.kind !== 'host') return [];
    return filterSessionsByTags(hostSessions[view.host]?.sessions || [], sessionTags, activeTagFilters);
  }, [view, hostSessions, sessionTags, activeTagFilters]);
  // WARDEN-742: the per-host past-session resume list shows SESSION_PREVIEW rows,
  // with a "show more" that reveals the rest of the already-fetched (and tag-filtered)
  // set. The backend caps the payload at SESSION_SEARCH_PER_HOST (20), so this is a
  // client-side reveal only — no pagination/hasMore plumbing. Defined in the main
  // body (not inside renderHost) so the memo-derived visibleSessions stays the single
  // source of truth the closure reads.
  const sessionPreview = showAllSessions ? visibleSessions : visibleSessions.slice(0, SESSION_PREVIEW);
  const hasMoreSessions = visibleSessions.length > SESSION_PREVIEW;

  // WARDEN-565: cross-agent file-edit collision ⚠ badge for the fleet view headers.
  // Re-homes the orphaned WARDEN-288 detection (detectProjectFileCollisions) into the
  // surfaces that replaced the abolished project-chip row (WARDEN-372). The helper
  // reads the cached gitStatus map (no new fetch, no backend change) and keys by
  // project internally, so a per-view computation over that view's chats emits a
  // cross-project total.paths union that maps to a single ⚠N badge — and the badge's
  // showProject flag disambiguates the same path colliding in two projects.
  //
  // This memo MUST live at the top level (hooks can't be called conditionally — the
  // host/collection branches are early returns), so it guards on view.kind and
  // resolves the in-view population the same way each branch does: the host view's
  // hostChats (a single host can run several projects, so it can span them), and the
  // whole chats fleet for the root view (mirroring FleetCommitSearch, which reads the
  // full chats fleet from that same header). The colliding paths are empty when no two
  // active project agents share a dirty file, in which case the badge renders nothing.
  const fleetCollisionPaths = useMemo(() => {
    const viewChats = view.kind === 'host'
      ? chats.filter((c) => c.host === view.host)
      : chats;
    return detectProjectFileCollisions(viewChats, gitStatus).total.paths;
  }, [view, chats, gitStatus]);

  // WARDEN-601: the IMPENDING counterpart to fleetCollisionPaths — cross-joins each
  // agent's unpushed-commit file-set (outgoingFiles, now on /api/git-status) against
  // the OTHER agents' working-tree WIP, so the rollup can surface a collision the
  // working-tree×working-tree detector is blind to (one agent committed the file,
  // clean tree, while another has it dirty). Same view population + cached gitStatus
  // map as the live memo (no new fetch — outgoingFiles rides the existing per-tab
  // /api/git-status poll). Empty when no committed-outgoing × working-tree overlap
  // exists, in which case the ⏱ renders nothing (zero noise).
  const fleetImpendingPaths = useMemo(() => {
    const viewChats = view.kind === 'host'
      ? chats.filter((c) => c.host === view.host)
      : chats;
    return detectProjectImpendingCollisions(viewChats, gitStatus).total.paths;
  }, [view, chats, gitStatus]);

  // WARDEN-639: the OUTGOING×OUTGOING counterpart to fleetImpendingPaths — finds paths
  // ≥2 agents EACH have in their unpushed commits (outgoingFiles) with clean working
  // trees, the one matrix cell neither the live ⚠ nor the impending ⏱ covers (both
  // agents committed, neither dirty → invisible to the WIP join AND the impending
  // editor side → surfaces only at push/merge/CI). Same view population + cached
  // gitStatus map as the other two memos (no new fetch — outgoingFiles rides the
  // existing per-tab /api/git-status poll). Empty when no two clean committers share an
  // outgoing path, in which case the ⇄ renders nothing (zero noise).
  const fleetOutgoingPaths = useMemo(() => {
    const viewChats = view.kind === 'host'
      ? chats.filter((c) => c.host === view.host)
      : chats;
    return detectProjectOutgoingCollisions(viewChats, gitStatus).total.paths;
  }, [view, chats, gitStatus]);

  // WARDEN-635 (per WARDEN-565): the ±N/↑N/↓N/⚑N project git-state badges were
  // orphaned dead code — GitStateBadges was never imported (WARDEN-372 abolished the
  // project-chip row that hosted it; WARDEN-565 re-wired the sibling GitCollisionBadge
  // and explicitly deferred this one). This memo re-homes summarizeProjectGitState
  // (the cached-map aggregator — no new fetch, no backend change) the same way, so
  // mounting <GitStateBadges> below lights up all four axes at once: the existing ±N
  // (dirty) / ↑N (unpushed) / ↓N (behind) fleet WIP totals AND the new ⚑N at-risk-
  // repo-state chip rolling up detached HEAD / no-upstream / mid-merge agents — a
  // non-routine state that needs a human's eye but was previously invisible at the
  // fleet level. Same view population + cached gitStatus map as the collision memos
  // above; .total carries the four counts + the contributing agents (in chats order).
  const fleetGitState = useMemo(() => {
    const viewChats = view.kind === 'host'
      ? chats.filter((c) => c.host === view.host)
      : chats;
    return summarizeProjectGitState(viewChats, gitStatus).total;
  }, [view, chats, gitStatus]);

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

  // Fan a KILL out to every selected agent via the shared runKillFanout
  // (WARDEN-328; reused by Fleet Health WARDEN-371). The fan-out itself
  // (Promise.allSettled over /api/kill + summarize) lives in @/lib/kill so both
  // surfaces share one copy; this component supplies the surface-specific
  // reconciliation (onSettled: re-read the catalog + re-discover each distinct
  // host) and keeps the view concerns (toast, selection clear) here.
  //
  // runKillFanout never throws — partial failure (one host unreachable, one
  // session already dead) is encoded in the summary, not aborted — and returns
  // the summary so the result toast can surface it. Stale ids (an agent that
  // died between selecting and killing) are still killed-at and reported as a
  // per-agent failure rather than silently dropped.
  const handleKillSelected = async () => {
    const ids = Array.from(selectedIds);
    const nameOf = (id: string) => {
      const c = findChat(chats, id);
      return c ? displayName(c) : id;
    };
    const summary = await runKillFanout(ids, nameOf, async () => {
      // Reconcile rows after the fan-out: re-read the catalog (manual tmux chats
      // are forgotten server-side) AND re-discover each unique host so yatfa
      // (auto-discovered) agents reflect the dead tmux session immediately rather
      // than waiting for the 60s poll — mirroring performKill's refresh() +
      // discoverHost(host) per kill, deduped across the batch's hosts.
      onRefresh();
      const hosts = new Set<string>();
      selectedChats.forEach((c) => { if (c.host) hosts.add(c.host); });
      hosts.forEach((h) => onDiscoverHost(h));
    });
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
    // The kill's intent is discharged — clear the selection regardless of
    // outcome. Failed targets remain visible in the toast; the human can
    // re-select and retry if needed.
    setSelectedIds(new Set());
    return summary;
  };

  // Fan a CONTROL KEY (Ctrl-C / Esc) out to every selected agent via the shared
  // runKeySendFanout (@/lib/keysend; the non-destructive sibling of runKillFanout,
  // WARDEN-492). The fan-out itself (Promise.allSettled over /api/key +
  // summarize) lives in @/lib/keysend so both interrupt surfaces (sidebar +
  // Fleet Health) share one copy; this component keeps the view concerns (toast,
  // selection clear) here.
  //
  // runKeySendFanout never throws — partial failure (one host unreachable, one
  // session dead) is encoded in the summary, not aborted — and returns the
  // summary so the result toast can surface it. Interrupt is NON-DESTRUCTIVE: no
  // session is destroyed, so (unlike kill) there is nothing to reconcile — a
  // signaled agent reclassifies off stuck/erroring on the next classifyPane
  // tick. Stale ids are still signaled-at and reported as a per-agent failure.
  const handleInterruptSelected = async (key: string) => {
    const ids = Array.from(selectedIds);
    const nameOf = (id: string) => {
      const c = findChat(chats, id);
      return c ? displayName(c) : id;
    };
    const summary = await runKeySendFanout(ids, key, nameOf);
    const outcome = formatKeySendToast(summary, key);
    if (prefs.notifyChatOps) {
      if (outcome.variant === 'success') {
        toast.success(outcome.title);
      } else {
        // whitespace-pre-line so the per-agent failure list (joined with \n in
        // formatKeySendToast) renders one failure per line instead of collapsing.
        toast.error(outcome.title, { description: <span className="whitespace-pre-line">{outcome.description}</span> });
      }
    }
    // The interrupt's intent is discharged — clear the selection regardless of
    // outcome. Failed targets remain visible in the toast; the human can
    // re-select and retry if needed.
    setSelectedIds(new Set());
    return summary;
  };

  // WARDEN-581 — bulk snooze for the multi-select action bar. Snooze is pure
  // local state (UiState.snoozedAlertKeys) with no tmux fan-out and no per-agent
  // failure, so — unlike broadcast/kill/interrupt — there is no fan-out summary:
  // route the selected keys + the dialog's chosen duration to App's snoozeMany
  // (one state write for the whole set), surface a single confirmation toast, and
  // clear the selection. The toast is shown unconditionally: it is a bulk-action
  // CONFIRMATION (not a chat-op result), and the per-row bell it echoes shows no
  // toast of its own, so no notifyChatOps/notifySuccess pref cleanly applies.
  const handleSnoozeSelected = (mode: SnoozeDuration) => {
    const keys = Array.from(selectedIds);
    if (keys.length === 0) return;
    onSnoozeMany(keys, mode);
    toast.success(`Snoozed ${keys.length} agent${keys.length === 1 ? '' : 's'} ${mode === '1h' ? 'for 1 hour' : 'until tomorrow'}`);
    setSelectedIds(new Set());
  };

  // WARDEN-581 — bulk watch/unwatch for the multi-select action bar. Like snooze
  // this is pure local state (watchedChats) with no fan-out: route the selected
  // keys + the computed on/off to App's toggleWatchMany (one state write; the OS
  // permission request fires once inside it), surface a confirmation toast, and
  // clear the selection. The bar's label (watchMode below) decides on vs off.
  const handleWatchSelected = () => {
    const keys = Array.from(selectedIds);
    if (keys.length === 0) return;
    const on = watchMode === 'watch';
    onToggleWatchMany(keys, on);
    toast.success(`${on ? 'Watching' : 'Stopped watching'} ${keys.length} agent${keys.length === 1 ? '' : 's'}`);
    setSelectedIds(new Set());
  };

  const enterHost = (host: string) => {
    const status = hostStatuses[host];
    if (status?.status === 'offline') {
      // Show helpful error instead of navigating
      if (prefs.notifyErrors) toast.error(`Cannot reach ${host} — SSH connection failed. Please check:
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
  const fetchCollections = async (): Promise<Collection[]> => {
    try {
      const r = await fetch('/api/collections');
      const j = await r.json();
      const list = j.collections || [];
      setCollections(list);
      return list;
    } catch (error) {
      console.error('[collections] Failed:', error);
      if (prefs.notifyErrors) toast.error(`Failed to fetch collections: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return [];
    }
  };

  const enterCollection = (collection: Collection) => { setView({ kind: 'collection', collection }); };

  const handleCreateCollection = () => { setCreateDialogOpen(true); fetchCollections(); };

  const handleCollectionCreated = (collection: Collection) => {
    fetchCollections();
    enterCollection(collection);
  };

  // WARDEN-396: sync ChatSidebar's derived collection state when a card is
  // renamed or deleted from CollectionsSection's context menu (which owns its
  // own card list + refresh). On delete, leave the live view if the deleted
  // collection was the one open; always re-fetch so the CreateCollectionDialog
  // duplicate-name check stays accurate after a rename/delete.
  // WARDEN-553: on edit, the open view also holds the edited collection as a
  // SNAPSHOT in `view.collection` — fetchCollections refreshes the `collections`
  // array but NOT that snapshot, so the membership list would render stale
  // criteria while the card count updates. Refresh the snapshot from the
  // freshly-fetched list when the edited id is the open view (or reset to root
  // if the collection is gone — same sync-bug class as the delete case).
  const handleCollectionChange = async (change: { type: 'rename' | 'delete' | 'edit'; id: string }) => {
    if (change.type === 'delete' && view.kind === 'collection' && view.collection.id === change.id) {
      setView({ kind: 'root' });
    }
    const fresh = await fetchCollections();
    if (change.type === 'edit' && view.kind === 'collection' && view.collection.id === change.id) {
      const updated = fresh.find((c) => c.id === change.id);
      setView(updated ? { kind: 'collection', collection: updated } : { kind: 'root' });
    }
  };

  // Fetch collections on mount
  useEffect(() => {
    fetchCollections();
  }, []);

  // Fetch git status for open panes (lazy loading). WARDEN-372: this was keyed on
  // the abolished activeTabs; it now follows the active workspace's open panes.
  useEffect(() => {
    openPanes.forEach((id) => {
      const c = findChat(chats, id);
      if (c) fetchGitStatus(id);
    });
  }, [chats, openPanes, fetchGitStatus]);

  // WARDEN-431: keep the FOCUSED pane's git status fresh so the Source Control
  // panel (the single place working-tree changes now show) reflects the focused
  // repo immediately on focus switch, not just on the periodic catalog refresh.
  // The per-open-panes effect above still feeds every pane's GitBranchBadge; this
  // is a focused-only top-up so the panel is never stale right after switching
  // panes. Read-only GET, and setGitStatus merges by key (no flicker). fetchGitStatus
  // is stable, so this fires only when `focused` changes.
  useEffect(() => {
    if (focused) fetchGitStatus(focused);
  }, [focused, fetchGitStatus]);

  // WARDEN-356: keep recent git-log fresh for chats the human has VISITED so the
  // per-agent "What's new since your last visit" marker reflects commits landed
  // since the last open/focus. Bounded to visited chats only (getLastSeen !==
  // null) — the marker is irrelevant for a never-visited chat, so unvisited
  // agents pay no extra fetch (their git-log still loads lazily when the
  // GitBranchBadge popover opens, as before). Reuses the existing fetchGitLog +
  // /api/git-log endpoint (read-only) — no new endpoint. The fetch uses
  // WHATS_NEW_FETCH_LIMIT (50, fetchGitLog's default) so the marker's count is
  // accurate up to 50 and reports "✦50+" (truncated) beyond — the WARDEN-356
  // review's "count silently capped at 5" fix. The re-fetch cadence mirrors
  // fetchGitStatus (every catalog refresh) so the marker stays current; the
  // documented future optimization is a server `since` param if this client-side
  // filtering ever proves costly for large fleets.
  useEffect(() => {
    openPanes.forEach((id) => {
      if (getLastSeen(id) === null) return;
      const c = findChat(chats, id);
      if (c) fetchGitLog(id);
    });
  }, [chats, openPanes, fetchGitLog]);

  const handleSpawned = (chat: Chat) => { onRefresh(); onOpenChat(chat.key || chat.id); setView({ kind: 'root' }); };
  const hosts = [THIS_MACHINE, ...sshHosts];

  // "Hide offline hosts" display pref (WARDEN-164): when ON, SSH hosts whose last
  // polled status is 'offline' collapse out of the live host list into an
  // expandable "Offline (N)" summary row. THIS_MACHINE and online/unknown hosts
  // are never hidden — only explicitly 'offline' ones. Derived on every render,
  // so the 30s status poll drives it: a recovered host re-appears inline and a
  // dropped one collapses away, with no extra wiring. When OFF (default),
  // isOfflineHidden is always false → visibleHosts === hosts, no summary.
  const hideOffline = hideOfflineHosts === true;
  const isOfflineHidden = (h: string) =>
    hideOffline && h !== THIS_MACHINE && hostStatuses[h]?.status === 'offline';

  const offlineHosts = hosts.filter(isOfflineHidden);
  const visibleHosts = hosts.filter((h) => !isOfflineHidden(h));

  // Renders one host row. Shared by the live list and the expanded offline
  // summary so the two stay identical — expanding the summary reveals the exact
  // same rows (the WARDEN-178 colorblind-safe StatusDot, incl. offline=square,
  // + retry/inspect still works via enterHost).
  // WARDEN-419: clipboard helper for the host-row context menu. Mirrors the
  // handleCopy pattern shipped in CollectionsSection (WARDEN-396): the
  // Electron-safe copyText() (Clipboard API + execCommand fallback) + a toast
  // so the user sees the copy landed.
  const handleCopy = async (text: string) => {
    const ok = await copyText(text);
    if (ok) toast.success('Copied');
    else toast.error('Copy failed');
  };

  const renderHost = (h: string) => {
    const n = chats.filter((c) => c.host === h && c.active).length;
    const hostStatus = hostStatuses[h];
    // THIS_MACHINE ("this machine" / local) has no SSH address, so its menu
    // omits "Copy SSH address"; "Copy host name" copies the friendly label.
    const isLocal = h === THIS_MACHINE;
    return (
      <ContextMenu key={h}>
        <ContextMenuTrigger asChild>
          <button onClick={() => enterHost(h)} className="flex items-center gap-2 px-2 py-1.5 compact:py-1 rounded-md text-left text-xs hover:bg-accent active:bg-accent/80 w-full transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background">
            <StatusDot
              tone={n ? 'green' : 'muted'}
              variant={n ? 'solid' : 'ring'}
              label={n ? `${n} active chat${n !== 1 ? 's' : ''}` : 'No active chats'}
            />
            <span className="flex-1 truncate">{hostLabelFor(h, hostLabels) || LABEL[h] || h}</span>
            {isLocal && <span className="text-[10px] text-cyan-400">local</span>}
            {!isLocal && (
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
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => enterHost(h)}>Open</ContextMenuItem>
          <ContextMenuItem onSelect={() => onDiscoverHost(h)}>Discover</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleCopy(hostLabelFor(h, hostLabels) || LABEL[h] || h)}>Copy host name</ContextMenuItem>
          {!isLocal && (
            <ContextMenuItem onSelect={() => handleCopy(`ssh ${h}`)}>Copy SSH address</ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>
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
          // (web/src/lib/collections.ts — the single matcher shared with the card
          // count + the backend). No criteria → include every agent.
          if (!C.criteria) return true;
          return chatMatchesCriteria(chat, C.criteria);
        })
      : [];

    // Apply agent filter + sort to collection agents (WARDEN-372: no 'hidden' case).
    agents = sortChats(agents.filter((c) => matchesAgentFilter(c, agentFilter)), agentSort);

    const active = agents.filter((c) => c.active);
    const idle = agents.filter((c) => !c.active);
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
            {(active.length > 0 || idle.length > 0) && (
              <div className="px-2 pt-1 pb-1 text-[10px] uppercase tracking-wider text-green-500/80 font-semibold">● matching agents</div>
            )}
            {active.map((c) => <ChatRow key={c.id} c={c} open={openPanes.has(c.key || c.id)} onOpen={() => openFromCollection(c.key || c.id)} hostStatus={hostStatuses[c.host]?.status} onKill={() => onKill(c.key || c.id)} onRename={onRename} gitInfo={gitStatus[c.key || c.id]} gitCommits={gitLog[c.key || c.id]} gitLogLoading={gitLogLoading[c.key || c.id]} onFetchGitLog={() => fetchGitLog(c.key || c.id)} incomingCommits={gitLogIncoming[c.key || c.id]} incomingLoading={gitLogIncomingLoading[c.key || c.id]} onFetchIncoming={() => fetchGitLogIncoming(c.key || c.id)} outgoingCommits={gitLogOutgoing[c.key || c.id]} outgoingLoading={gitLogOutgoingLoading[c.key || c.id]} onFetchOutgoing={() => fetchGitLogOutgoing(c.key || c.id)} onOpenDiff={(path, staged) => setDiffTarget({ chatId: c.key || c.id, path, staged })} onOpenConflict={(path) => setConflictTarget({ chatId: c.key || c.id, path })} onOpenFile={(path) => setFileTarget({ chatId: c.key || c.id, path })} showHostTags={showHostTags} showTypeBadges={showTypeBadges} showStatusIndicators={showStatusIndicators} showProjectBadges={showProjectBadges} isPinned={pinnedChatIds.has(c.id)} onTogglePin={() => togglePin(c.id)} selected={selectedIds.has(c.key || c.id)} onToggleSelect={() => toggleSelect(c.key || c.id)} selectionActive={selectedIds.size > 0} note={agentNotes[c.id]} onSetNote={(text: string) => setNote(c.id, text)} isWatched={watchedChats.has(c.key || c.id)} watchState={watchedStates[c.key || c.id]} onToggleWatch={() => onToggleWatch(c.key || c.id)} />)}
            {idle.length > 0 && (
              <>
                <div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground/60">idle</div>
                {idle.map((c) => <ChatRow key={c.id} c={c} open={openPanes.has(c.key || c.id)} onOpen={() => openFromCollection(c.key || c.id)} hostStatus={hostStatuses[c.host]?.status} onKill={() => onKill(c.key || c.id)} onRename={onRename} dim gitInfo={gitStatus[c.key || c.id]} gitCommits={gitLog[c.key || c.id]} gitLogLoading={gitLogLoading[c.key || c.id]} onFetchGitLog={() => fetchGitLog(c.key || c.id)} incomingCommits={gitLogIncoming[c.key || c.id]} incomingLoading={gitLogIncomingLoading[c.key || c.id]} onFetchIncoming={() => fetchGitLogIncoming(c.key || c.id)} outgoingCommits={gitLogOutgoing[c.key || c.id]} outgoingLoading={gitLogOutgoingLoading[c.key || c.id]} onFetchOutgoing={() => fetchGitLogOutgoing(c.key || c.id)} onOpenDiff={(path, staged) => setDiffTarget({ chatId: c.key || c.id, path, staged })} onOpenConflict={(path) => setConflictTarget({ chatId: c.key || c.id, path })} onOpenFile={(path) => setFileTarget({ chatId: c.key || c.id, path })} showHostTags={showHostTags} showTypeBadges={showTypeBadges} showStatusIndicators={showStatusIndicators} showProjectBadges={showProjectBadges} isPinned={pinnedChatIds.has(c.id)} onTogglePin={() => togglePin(c.id)} selected={selectedIds.has(c.key || c.id)} onToggleSelect={() => toggleSelect(c.key || c.id)} selectionActive={selectedIds.size > 0} note={agentNotes[c.id]} onSetNote={(text: string) => setNote(c.id, text)} isWatched={watchedChats.has(c.key || c.id)} watchState={watchedStates[c.key || c.id]} onToggleWatch={() => onToggleWatch(c.key || c.id)} />)}
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
            onInterrupt={() => setInterruptOpen(true)}
            onSnooze={() => setSnoozeOpen(true)}
            onWatch={handleWatchSelected}
            watchMode={watchMode}
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
          snippets={snippets}
          onSend={handleBroadcastSend}
        />
        <KillDialog
          open={killOpen}
          onOpenChange={setKillOpen}
          targets={selectedChats}
          onKill={handleKillSelected}
        />
        <KeySendDialog
          open={interruptOpen}
          onOpenChange={setInterruptOpen}
          targets={selectedChats}
          onSend={handleInterruptSelected}
        />
        <SnoozeDialog
          open={snoozeOpen}
          onOpenChange={setSnoozeOpen}
          targets={selectedChats}
          onSnooze={handleSnoozeSelected}
        />
      </div>
    );
  }

  if (view.kind === 'host') {
    const H = view.host;
    const hostChats = chats.filter((c) => c.host === H);

    // Apply agent filter + sort to host chats (WARDEN-372: no 'hidden' case).
    const sortedHostChats = sortChats(
      hostChats.filter((c) => matchesAgentFilter(c, agentFilter)),
      agentSort,
    );

    const active = sortedHostChats.filter((c) => c.active);
    const idle = sortedHostChats.filter((c) => !c.active);
    const info = hostSessions[H] || {};
    const sessions = info.sessions || [];
    // Per-host token total over the LOADED sessions for this host (up to the
    // fetch limit). The single-host resume list has no cross-host "totals"
    // field (that lives on /api/claude-sessions-all), so this is summed from the
    // per-row tokenUsage the backend now attaches. Honest as this host's visible
    // window, not a fleet total. (WARDEN-367.)
    const hostTokenTotal = sessions.reduce((acc, s) => acc + (s.tokenUsage?.total || 0), 0);
    // WARDEN-342: tagsInUse + visibleSessions are computed at the top level (hooks
    // can't live in this conditional branch) and are already scoped to this host.
    const openFromHost = (key: string) => { onOpenChat(key); setView({ kind: 'root' }); };
    return (
      <div className="flex flex-col h-full min-h-0 animate-in slide-in-from-right-2 duration-150">
        <div className="flex items-center gap-2 compact:gap-1 px-2 py-2 compact:py-1.5 border-b shrink-0">
          <IconTooltip label="back"><button className="text-xs text-muted-foreground hover:text-foreground px-1 rounded active:scale-95 transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background hover:bg-accent/50" onClick={() => setView({ kind: 'root' })}>‹</button></IconTooltip>
          <span className="text-xs font-medium flex-1 truncate">{hostLabelFor(H, hostLabels) || LABEL[H] || H}</span>
          <AgentFilterSortControls
            agentFilter={agentFilter}
            agentSort={agentSort}
            onFilterChange={onFilterChange}
            onSortChange={onSortChange}
            hideHostSort
          />
          {/* WARDEN-565: cross-agent file-collision ⚠ badge, re-homed into the fleet
              header that replaced the abolished project-chip row (WARDEN-372). Computed
              over this host's chats (hostChats) — a host can run several projects, so
              showProject tags each colliding path with its project. Renders nothing when
              no two active project agents share a dirty file (silent-when-clean). The
              popover's jump rows + per-path "Compare edits" (WARDEN-321) live in the badge. */}
          <GitCollisionBadge
            collisions={fleetCollisionPaths}
            impending={fleetImpendingPaths}
            outgoing={fleetOutgoingPaths}
            chats={hostChats}
            gitStatus={gitStatus}
            onOpenChat={onOpenChat}
            showProject
          />
          {/* WARDEN-635 (per WARDEN-565): the ±N/↑N/↓N/⚑N/🗄N project git-state fleet
              badges, re-homed into this host header the same way GitCollisionBadge
              was. Computed over hostChats (== the memo's viewChats for this host — a
              host can run several projects). The ⚑N axis rolls up detached-HEAD /
              no-upstream / mid-merge agents — a non-routine repo state that needs a
              human's eye but was previously invisible at the fleet level. The 🗄N
              axis (WARDEN-667) rolls up agents with parked `git stash` WIP — the lone
              current-state git signal that had no fleet chip. Renders nothing when
              every axis is 0 (silent-when-clean); each popover lists the contributing
              agents and deep-links to them. */}
          <GitStateBadges
            dirty={fleetGitState.dirty}
            unpushed={fleetGitState.unpushed}
            behind={fleetGitState.behind}
            atRisk={fleetGitState.atRisk}
            stashed={fleetGitState.stashed}
            stalled={fleetGitState.stalled}
            agents={fleetGitState.agents}
            chats={hostChats}
            gitStatus={gitStatus}
            onOpenChat={onOpenChat}
          />
          <IconTooltip label="rescan" disabled={loadingHost === H}><button className="text-xs text-muted-foreground hover:text-foreground rounded px-1 active:scale-95 transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background hover:bg-accent/50" onClick={() => fetchHostSessions(H)} disabled={loadingHost === H}>
            {loadingHost === H ? <Skeleton className="h-3 w-3" /> : '↻'}
          </button></IconTooltip>
        </div>
        <ScrollArea className="flex-1 min-h-0">
          <div className="p-1.5 flex flex-col gap-0.5">
            {(active.length > 0 || idle.length > 0) && (
              <div className="px-2 pt-1 pb-1 text-[10px] uppercase tracking-wider text-green-500/80 font-semibold">● live (tmux)</div>
            )}
            {active.map((c) => <ChatRow key={c.id} c={c} open={openPanes.has(c.key || c.id)} onOpen={() => openFromHost(c.key || c.id)} hostStatus={hostStatuses[c.host]?.status} onKill={() => onKill(c.key || c.id)} onRename={onRename} gitInfo={gitStatus[c.key || c.id]} gitCommits={gitLog[c.key || c.id]} gitLogLoading={gitLogLoading[c.key || c.id]} onFetchGitLog={() => fetchGitLog(c.key || c.id)} incomingCommits={gitLogIncoming[c.key || c.id]} incomingLoading={gitLogIncomingLoading[c.key || c.id]} onFetchIncoming={() => fetchGitLogIncoming(c.key || c.id)} outgoingCommits={gitLogOutgoing[c.key || c.id]} outgoingLoading={gitLogOutgoingLoading[c.key || c.id]} onFetchOutgoing={() => fetchGitLogOutgoing(c.key || c.id)} onOpenDiff={(path, staged) => setDiffTarget({ chatId: c.key || c.id, path, staged })} onOpenConflict={(path) => setConflictTarget({ chatId: c.key || c.id, path })} onOpenFile={(path) => setFileTarget({ chatId: c.key || c.id, path })} showHostTags={showHostTags} showTypeBadges={showTypeBadges} showStatusIndicators={showStatusIndicators} showProjectBadges={showProjectBadges} isPinned={pinnedChatIds.has(c.id)} onTogglePin={() => togglePin(c.id)} selected={selectedIds.has(c.key || c.id)} onToggleSelect={() => toggleSelect(c.key || c.id)} selectionActive={selectedIds.size > 0} note={agentNotes[c.id]} onSetNote={(text: string) => setNote(c.id, text)} isWatched={watchedChats.has(c.key || c.id)} watchState={watchedStates[c.key || c.id]} onToggleWatch={() => onToggleWatch(c.key || c.id)} />)}
            {idle.length > 0 && (
              <>
                <div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground/60">idle</div>
                {idle.map((c) => <ChatRow key={c.id} c={c} open={openPanes.has(c.key || c.id)} onOpen={() => openFromHost(c.key || c.id)} hostStatus={hostStatuses[c.host]?.status} onKill={() => onKill(c.key || c.id)} onRename={onRename} dim gitInfo={gitStatus[c.key || c.id]} gitCommits={gitLog[c.key || c.id]} gitLogLoading={gitLogLoading[c.key || c.id]} onFetchGitLog={() => fetchGitLog(c.key || c.id)} incomingCommits={gitLogIncoming[c.key || c.id]} incomingLoading={gitLogIncomingLoading[c.key || c.id]} onFetchIncoming={() => fetchGitLogIncoming(c.key || c.id)} outgoingCommits={gitLogOutgoing[c.key || c.id]} outgoingLoading={gitLogOutgoingLoading[c.key || c.id]} onFetchOutgoing={() => fetchGitLogOutgoing(c.key || c.id)} onOpenDiff={(path, staged) => setDiffTarget({ chatId: c.key || c.id, path, staged })} onOpenConflict={(path) => setConflictTarget({ chatId: c.key || c.id, path })} onOpenFile={(path) => setFileTarget({ chatId: c.key || c.id, path })} showHostTags={showHostTags} showTypeBadges={showTypeBadges} showStatusIndicators={showStatusIndicators} showProjectBadges={showProjectBadges} isPinned={pinnedChatIds.has(c.id)} onTogglePin={() => togglePin(c.id)} selected={selectedIds.has(c.key || c.id)} onToggleSelect={() => toggleSelect(c.key || c.id)} selectionActive={selectedIds.size > 0} note={agentNotes[c.id]} onSetNote={(text: string) => setNote(c.id, text)} isWatched={watchedChats.has(c.key || c.id)} watchState={watchedStates[c.key || c.id]} onToggleWatch={() => onToggleWatch(c.key || c.id)} />)}
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
                ⚠ claude not found on {hostLabelFor(H, hostLabels) || LABEL[H] || H} — install it to resume sessions here.
              </div>
            )}
            <div className="px-2 pt-1 pb-1 flex items-baseline gap-2">
              <div className="text-[10px] uppercase tracking-wider text-cyan-500/80 font-semibold">☁ sessions (history — click to resume)</div>
              {hostTokenTotal > 0 && (
                <span className="text-[10px] text-muted-foreground/70 truncate" title="Total tokens across this host's loaded session history (model-agnostic).">
                  {formatTokens(hostTokenTotal)}
                </span>
              )}
            </div>
            <SessionTagFilterRow tagsInUse={tagsInUse} active={activeTagFilters} onToggle={toggleTagFilter} onClear={() => setActiveTagFilters(new Set())} />
            {sessionPreview.map((s) => {
              const running = hostChats.some((c) => c.key === `resume-${s.id.slice(0, 8)}`);
              const isLoading = resumingSessionId === s.id;
              const sTags = sessionTags[s.id] || [];
              return (
                <ContextMenu key={s.id}>
                  <ContextMenuTrigger asChild>
                    {/* Row container (group) holds the resume <button> + tag chips as
                        SIBLINGS, not nested — nested interactive elements are invalid
                        HTML. `group` reveals the "+ tag" affordance on hover. The row
                        itself is the ContextMenuTrigger, so right-clicking anywhere on
                        it opens the themed menu (Resume · Copy session ID/cwd/summary). */}
                    <div className={`group flex flex-col gap-0.5 px-2 py-1.5 compact:py-1 rounded-md text-left text-xs transition-all duration-150 ease-out hover:bg-accent ${isLoading ? 'opacity-50' : ''}`}>
                      {/* The themed hover tooltip sits on the resume <button>, not the row
                          div: a Radix Tooltip (asChild) and a Radix ContextMenu (asChild)
                          cannot share one DOM node — each needs its provider in scope, and
                          Slot only merges props one level deep, so nesting ContextMenu
                          inside IconTooltip would clone the tooltip's pointer handlers onto
                          the <ContextMenu> provider (which drops them) and silently kill the
                          tooltip. Putting the tooltip on the inner button gives it a real DOM
                          anchor; the non-loading path adds no wrapper element (asChild). */}
                      <IconTooltip
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
                          className="flex flex-col gap-0.5 text-left active:bg-accent/80 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-md"
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
                            {isLoading ? <Skeleton className="h-2.5 w-1/2 inline-block" /> : `${formatTimestamp(s.mtime, timestampFormat)} · ${basename(s.cwd)}${s.tokenUsage?.total ? ` · ${formatTokens(s.tokenUsage.total)}` : ''}`}
                          </span>
                        </button>
                      </IconTooltip>
                      <SessionTagChips tags={sTags} onAdd={(tag) => addSessionTag(s.id, tag)} onRemove={(tag) => removeSessionTag(s.id, tag)} />
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem onSelect={() => { handleResume(s.id, s.summary, s.cwd, H); setView({ kind: 'root' }); }}>
                      Resume
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem onSelect={() => handleCopy(s.id)}>Copy session ID</ContextMenuItem>
                    <ContextMenuItem onSelect={() => handleCopy(s.cwd)}>Copy working directory</ContextMenuItem>
                    <ContextMenuItem onSelect={() => handleCopy(s.summary)}>Copy summary</ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              );
            })}
            {hasMoreSessions && (
              <Button variant="ghost" size="xs" onClick={() => setShowAllSessions((v) => !v)} className="mx-2 mt-0.5 self-start text-xs text-muted-foreground hover:text-foreground">
                {showAllSessions ? 'show less' : `show ${visibleSessions.length - SESSION_PREVIEW} more`}
              </Button>
            )}
            {visibleSessions.length === 0 && activeTagFilters.size > 0 && (
              <div className="mx-1 my-1 px-2 py-1.5 text-[11px] text-muted-foreground">
                no sessions match the selected tag{activeTagFilters.size > 1 ? 's' : ''} — <button className="underline hover:text-foreground" onClick={() => setActiveTagFilters(new Set())}>clear filter</button>
              </div>
            )}
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
            onInterrupt={() => setInterruptOpen(true)}
            onSnooze={() => setSnoozeOpen(true)}
            onWatch={handleWatchSelected}
            watchMode={watchMode}
            onKill={() => setKillOpen(true)}
          />
        )}
        <BroadcastDialog
          open={broadcastOpen}
          onOpenChange={setBroadcastOpen}
          targets={selectedChats}
          snippets={snippets}
          onSend={handleBroadcastSend}
        />
        <KillDialog
          open={killOpen}
          onOpenChange={setKillOpen}
          targets={selectedChats}
          onKill={handleKillSelected}
        />
        <KeySendDialog
          open={interruptOpen}
          onOpenChange={setInterruptOpen}
          targets={selectedChats}
          onSend={handleInterruptSelected}
        />
        <SnoozeDialog
          open={snoozeOpen}
          onOpenChange={setSnoozeOpen}
          targets={selectedChats}
          onSnooze={handleSnoozeSelected}
        />
      </div>
    );
  }

  // ROOT VIEW — open panes + per-workspace recently-closed + hosts.
  // WARDEN-372: this was a "tabs" working set (activeTabs with hide/unhide, drag-
  // reorder, and a project-filter chip row). It is now the active workspace's
  // openPanes in grid order — the list MIRRORS the pane grid (no sidebar reorder,
  // no sort), narrowed only by the search box + agent filter. Closing a pane
  // records it in recentlyClosed (below) for one-click reopen.
  const filteredPanes = [...openPanes].filter((id) => {
    const c = findChat(chats, id);
    const query = tabSearchQuery.toLowerCase();
    // A pane whose chat has left the catalog (e.g. a dead pane pending close) still
    // shows so the user can close it; it just can't match a name/host/type filter.
    if (!c) return query === '';
    const name = displayName(c).toLowerCase();
    const host = (c.host || '').toLowerCase();
    const type = chatType(c).toLowerCase();
    const matchesSearch = name.includes(query) || host.includes(query) || type.includes(query);
    return matchesSearch && matchesAgentFilter(c, agentFilter);
  });

  // The recently-closed list shows a few entries with a "show more" affordance that
  // expands to the full (storage-capped) list. Already-open entries still render
  // (dimmed via the open dot) so the user sees the recovery state.
  const closedPreview = showAllClosed ? recentlyClosed : recentlyClosed.slice(0, RECENTLY_CLOSED_PREVIEW);
  const hasMoreClosed = recentlyClosed.length > RECENTLY_CLOSED_PREVIEW;

  return (
    <div className="@container flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 compact:gap-1 px-3 py-2 compact:py-1.5 border-b shrink-0">
        <span className="text-xs text-muted-foreground @max-[20rem]:hidden">open</span>
        <Input
          placeholder="filter..."
          value={tabSearchQuery}
          onChange={(e) => setTabSearchQuery(e.target.value)}
          className="h-6 text-[10px] px-2 flex-1 max-w-[120px] min-w-20"
        />
        <AgentFilterSortControls
          agentFilter={agentFilter}
          agentSort={agentSort}
          onFilterChange={onFilterChange}
          onSortChange={onSortChange}
        />
        {/* WARDEN-534: fleet-wide commit search. A sidebar-level affordance that
            fans the per-agent --grep (WARDEN-498) across EVERY active project
            agent from one box, grouped by agent (name · project · ↑unpushed), so
            one query finds where a change landed across the fleet. Root-header
            placement (alongside the filter/sort controls) per the ticket's
            placement note; the popover owns its own input + debounce + fan-out. */}
        <FleetCommitSearch chats={chats} onOpenChat={onOpenChat} />
        {/* WARDEN-565: cross-agent file-collision ⚠ badge, re-homed into the root
            fleet header alongside FleetCommitSearch (the surface that replaced the
            abolished project-chip row, WARDEN-372). Computed over the whole chats
            fleet — mirroring FleetCommitSearch, which also fans across the full fleet
            from this header — so the ⚠ surfaces a fleet-wide divergence risk. The
            fleet spans projects, so showProject tags each colliding path with its
            project. Renders nothing when no two active project agents share a dirty
            file (silent-when-clean). */}
        <GitCollisionBadge
          collisions={fleetCollisionPaths}
          impending={fleetImpendingPaths}
          outgoing={fleetOutgoingPaths}
          chats={chats}
          gitStatus={gitStatus}
          onOpenChat={onOpenChat}
          showProject
        />
        {/* WARDEN-635 (per WARDEN-565): the ±N/↑N/↓N/⚑N/🗄N project git-state fleet
            badges, re-homed into the root fleet header alongside GitCollisionBadge
            and FleetCommitSearch. Computed over the whole chats fleet (== the memo's
            viewChats), mirroring those siblings which also fan across the full fleet
            from this header. The ⚑N axis rolls up detached-HEAD / no-upstream /
            mid-merge agents across the fleet; the 🗄N axis (WARDEN-667) rolls up
            agents with parked `git stash` WIP across the fleet; renders nothing when
            every axis is 0. */}
        <GitStateBadges
          dirty={fleetGitState.dirty}
          unpushed={fleetGitState.unpushed}
          behind={fleetGitState.behind}
          atRisk={fleetGitState.atRisk}
          stashed={fleetGitState.stashed}
          stalled={fleetGitState.stalled}
          agents={fleetGitState.agents}
          chats={chats}
          gitStatus={gitStatus}
          onOpenChat={onOpenChat}
        />
        {/* WARDEN-745: the compositional capstone of the 6 git-state chips above.
            Where those chips are a flat count a human must rank by hand across N
            agents, this promotes the ONE composite-worst agent as "triage THIS
            first, because X" — a verbatim mirror of WARDEN-384's AttentionBadge
            callout (rankGitTriage + focus-excluded pickGitTriageTop + gitTriageReason
            in gitStateSummary.ts). Pure composition: it assigns each agent its
            highest-precedence present signal (atRisk > stalled > unpushed > behind >
            dirty > stash) and orders within-tier by that axis's already-shipped
            severity. The focused pane is NEVER promoted (WARDEN-482 guard via
            pickGitTriageTop). Renders nothing when <2 agents carry a git signal, or
            the whole fleet is clean/pushed/in-sync. Click → onOpenChat(top.key). */}
        <GitTriageCallout
          agents={fleetGitState.agents}
          chats={chats}
          focused={focused}
          onOpenChat={onOpenChat}
        />
        <Badge variant="secondary" className="text-xs @max-[18rem]:hidden">{filteredPanes.length}</Badge>
        <span className="@max-[20rem]:hidden"><UpdatedAgo at={lastRefreshAt} timestampFormat={timestampFormat} /></span>
        <button className="text-xs text-muted-foreground hover:text-foreground rounded px-1 active:scale-95 transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background hover:bg-accent/50" onClick={onRefresh} disabled={loading} title="refresh">
          {loading ? <Skeleton className="h-3 w-3" /> : '↻'}
        </button>
      </div>
      <NewChatForm onSpawned={handleSpawned} />
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-1.5 flex flex-col gap-0.5">
          {/* WARDEN-431: the Source Control panel — the single place a focused
              pane's repo working-tree changes show, grouped like VS Code. Re-points
              to whichever pane is focused; renders nothing when the focused pane
              has no git repo. The inline per-chat changed-file rows are gone. */}
          <SourceControlPanel
            gitInfo={focused ? gitStatus[focused] : undefined}
            onOpenDiff={(path, staged) => { if (focused) setDiffTarget({ chatId: focused, path, staged }); }}
            collapsed={!!sourceControlCollapsed}
            onCollapsedChange={onSourceControlCollapsedChange ?? (() => {})}
          />
          {loading && openPanes.size === 0 ? (
            <>
              <div className="px-2 pt-1 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground/40">loading panes</div>
              {[1, 2, 3].map((i) => <ChatRowSkeleton key={i} />)}
            </>
          ) : null}
          {openPanes.size > 0 && (
            <div className="px-2 pt-1 pb-1 text-[10px] uppercase tracking-wider text-green-500/80 font-semibold">open panes</div>
          )}
          {filteredPanes.map((id) => {
            const c = findChat(chats, id);
            return (
              <OpenPaneRow
                key={id}
                id={id}
                c={c}
                isOpen={openPanes.has(id)}
                onOpen={() => onOpenChat(id)}
                onClose={() => onClosePane(id)}
                onRename={onRename}
                onKill={() => onKill(id)}
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
                onOpenDiff={(path, staged) => setDiffTarget({ chatId: id, path, staged })}
                onOpenConflict={(path) => setConflictTarget({ chatId: id, path })}
                onOpenFile={(path) => setFileTarget({ chatId: id, path })}
                note={c ? agentNotes[c.id] : undefined}
                onSetNote={c ? (text: string) => setNote(c.id, text) : undefined}
                timestampFormat={timestampFormat}
                isWatched={watchedChats.has(id)}
                watchState={watchedStates[id]}
                onToggleWatch={() => onToggleWatch(id)}
              />
            );
          })}
          {filteredPanes.length === 0 && openPanes.size > 0 && (
            <div className="text-xs text-muted-foreground p-3 text-center">{tabSearchQuery ? `no panes match "${tabSearchQuery}"` : 'no panes match the current filter'}</div>
          )}
          {openPanes.size === 0 && !loading && (
            <EmptyState type="no-panes" />
          )}
          {recentlyClosed.length > 0 && (
            <>
              <div className="mt-3 mb-1 border-t border-border/50" />
              <div className="px-2 pt-1 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground/60">recently closed</div>
              {closedPreview.map((entry) => {
                const open = openPanes.has(entry.id);
                return (
                  <Button
                    key={entry.id}
                    variant="ghost"
                    size="sm"
                    onClick={() => onReopenClosed(entry.id)}
                    className="w-full justify-start gap-2 px-2 text-xs text-muted-foreground hover:text-foreground"
                    title={`reopen ${entry.name}`}
                  >
                    <StatusDot tone={open ? 'green' : 'muted'} variant={open ? 'solid' : 'ring'} label={open ? 'Open' : 'Reopen'} />
                    <span className="truncate flex-1 text-left">{entry.name || entry.id}</span>
                    {entry.host && entry.host !== '(local)' && <span className="text-[10px] text-muted-foreground/70 shrink-0">{hostLabelFor(entry.host, hostLabels) || entry.host}</span>}
                    <span className="text-[10px] text-muted-foreground/70 shrink-0">{formatTimestamp(entry.closedAt, timestampFormat)}</span>
                  </Button>
                );
              })}
              {hasMoreClosed && (
                <Button variant="ghost" size="xs" onClick={() => setShowAllClosed((v) => !v)} className="mx-2 mt-0.5 self-start text-xs text-muted-foreground hover:text-foreground">
                  {showAllClosed ? 'show less' : `show ${recentlyClosed.length - RECENTLY_CLOSED_PREVIEW} more`}
                </Button>
              )}
            </>
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
            onCollectionChange={handleCollectionChange}
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
        staged={diffTarget?.staged}
        open={!!diffTarget}
        onOpenChange={(o) => { if (!o) setDiffTarget(null); }}
      />
      <ConflictView
        chatId={conflictTarget?.chatId ?? ''}
        filePath={conflictTarget?.path ?? ''}
        open={!!conflictTarget}
        onOpenChange={(o) => { if (!o) setConflictTarget(null); }}
      />
      <FileViewer
        chatId={fileTarget?.chatId ?? ''}
        filePath={fileTarget?.path ?? ''}
        open={!!fileTarget}
        timestampFormat={timestampFormat}
        viewMode={fileViewerViewMode}
        onViewModeChange={onFileViewerViewModeChange}
        onNavigate={(p) => setFileTarget((prev) => (prev ? { ...prev, path: p } : prev))}
        onOpenChange={(o) => { if (!o) setFileTarget(null); }}
      />
      <BroadcastDialog
        open={broadcastOpen}
        onOpenChange={setBroadcastOpen}
        targets={selectedChats}
        snippets={snippets}
        onSend={handleBroadcastSend}
      />
      <KillDialog
        open={killOpen}
        onOpenChange={setKillOpen}
        targets={selectedChats}
        onKill={handleKillSelected}
      />
      <KeySendDialog
        open={interruptOpen}
        onOpenChange={setInterruptOpen}
        targets={selectedChats}
        onSend={handleInterruptSelected}
      />
      <SnoozeDialog
        open={snoozeOpen}
        onOpenChange={setSnoozeOpen}
        targets={selectedChats}
        onSnooze={handleSnoozeSelected}
      />
    </div>
  );
}
