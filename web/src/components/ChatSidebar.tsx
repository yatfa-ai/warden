import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/EmptyState';
import { NewChatForm } from './NewChatForm';
import { CollectionsSection } from './CollectionsSection';
import { CreateCollectionDialog } from './CreateCollectionDialog';
import { useNotificationPrefs } from '@/lib/useNotificationPrefs';
import type { Chat, Collection } from '@/lib/types';

export interface ClaudeSession { id: string; cwd: string; summary: string; mtime: number }

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
  // Display customization
  showHostTags?: boolean;
  showTypeBadges?: boolean;
  showStatusIndicators?: boolean;
  showProjectBadges?: boolean;
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
const TYPE_COLOR: Record<string, string> = {
  resume: 'text-cyan-400', claude: 'text-green-400', shell: 'text-yellow-400',
  yatfa: 'text-blue-400', manual: 'text-violet-400', '?': 'text-muted-foreground',
};

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

export function ChatSidebar({ chats, sshHosts, activeTabs, hiddenTabs, openPanes, onOpenChat, onRemoveActive, onReorder, onHideTab, onUnhideTab, onKill, onRename, onResume, onRefresh, onDiscoverHost, loading, showHostTags, showTypeBadges, showStatusIndicators, showProjectBadges }: Props) {
  const [view, setView] = useState<{ kind: 'root' } | { kind: 'host'; host: string } | { kind: 'collection'; collection: Collection }>({ kind: 'root' });
  const [hiddenExpanded, setHiddenExpanded] = useState(false);
  const [showAllChats, setShowAllChats] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [ctx, setCtx] = useState<{ id: string; x: number; y: number; dead: boolean } | null>(null);
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
  const [gitStatus, setGitStatus] = useState<Record<string, { branch: string | null; clean: boolean | null; cwd: string }>>({});
  const { prefs } = useNotificationPrefs();

  // Native context menu listener — only fires for tab rows, leaves everything else (xterm/tmux) alone.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const tab = (e.target as HTMLElement).closest('[data-tab-id]');
      if (!tab) return; // not a tab — let the default happen (xterm paste etc.)
      e.preventDefault();
      const id = tab.getAttribute('data-tab-id')!;
      const c = findChat(chats, id);
      setCtx({ id, x: e.clientX, y: e.clientY, dead: !c || c.active === false });
    };
    document.addEventListener('contextmenu', handler);
    return () => document.removeEventListener('contextmenu', handler);
  }, [chats]);

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
      if (prefs.notifyErrors) toast.error(`Failed to fetch sessions for ${host}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    setLoadingHost(null);
  };

  const fetchGitStatus = useCallback(async (chatId: string) => {
    try {
      const r = await fetch(`/api/git-status?id=${encodeURIComponent(chatId)}`);
      const j = await r.json();
      if (j.branch) {
        setGitStatus((p) => ({ ...p, [chatId]: { branch: j.branch, clean: j.clean, cwd: j.cwd } }));
      }
    } catch (error) {
      // Git status is non-critical, so just log it without showing a toast
      console.error('Failed to fetch git status:', error);
    }
  }, []);

  // Load pinned chat ids from the backend on mount
  useEffect(() => {
    const fetchPins = async () => {
      try {
        const r = await fetch('/api/pins');
        const j = await r.json();
        setPinnedChatIds(new Set(j.pins || []));
      } catch { /* noop */ }
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
    } catch { /* noop */ }
  };

  const fetchAllSessions = async () => {
    setLoadingAllSessions(true);
    try {
      const r = await fetch('/api/claude-sessions-all');
      const j = await r.json();
      setAllSessions(j.sessions || []);
    } catch { /* noop */ }
    setLoadingAllSessions(false);
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

  // Fetch git status for active chats (lazy loading)
  useEffect(() => {
    activeTabs.forEach((id) => {
      const c = findChat(chats, id);
      if (c) fetchGitStatus(id);
    });
  }, [chats, activeTabs, fetchGitStatus]);

  const handleSpawned = (chat: Chat) => { onRefresh(); onOpenChat(chat.key || chat.id); setView({ kind: 'root' }); };
  const hosts = [THIS_MACHINE, ...sshHosts];

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
    const agents = collections.length > 0
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

    const active = agents.filter((c) => c.active);
    const idle = agents.filter((c) => !c.active);
    const visibleActive = active.filter((c) => !hiddenTabs.includes(c.key || c.id));
    const hiddenActive = active.filter((c) => hiddenTabs.includes(c.key || c.id));
    const openFromCollection = (key: string) => { onOpenChat(key); setView({ kind: 'root' }); };

    return (
      <div className="flex flex-col h-full min-h-0 animate-in slide-in-from-right-2 duration-150">
        <div className="flex items-center gap-2 px-2 py-2 border-b shrink-0">
          <button className="text-xs text-muted-foreground hover:text-foreground px-1 active:scale-95 transition-all duration-150 ease-out" onClick={() => setView({ kind: 'root' })} title="back">‹</button>
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
            {visibleActive.map((c) => <ChatRow key={c.id} c={c} open={openPanes.has(c.key || c.id)} onOpen={() => openFromCollection(c.key || c.id)} onKill={() => handleKill(c.key || c.id)} onRename={(session, kind, name) => handleRename(session, kind, name)} onHide={() => onHideTab(c.key || c.id)} showHostTags={showHostTags} showTypeBadges={showTypeBadges} showStatusIndicators={showStatusIndicators} showProjectBadges={showProjectBadges} killingChatId={killingChatId} renamingChatId={renamingChatId} isPinned={pinnedChatIds.has(c.key || c.id)} onTogglePin={() => togglePin(c.key || c.id)} />)}
            {hiddenActive.length > 0 && (
              <>
                <button onClick={() => setHiddenExpanded(!hiddenExpanded)} className="flex items-center gap-1 px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground/60 hover:text-foreground w-full active:bg-accent/80 transition-colors">
                  <span>{hiddenExpanded ? '▾' : '▸'}</span>
                  <span>hidden ({hiddenActive.length})</span>
                </button>
                {hiddenExpanded && hiddenActive.map((c) => (
                  <ChatRow key={c.id} c={c} open={openPanes.has(c.key || c.id)} onOpen={() => openFromCollection(c.key || c.id)} onKill={() => handleKill(c.key || c.id)} onRename={(session, kind, name) => handleRename(session, kind, name)} onUnhide={() => onUnhideTab(c.key || c.id)} dim showHostTags={showHostTags} showTypeBadges={showTypeBadges} showStatusIndicators={showStatusIndicators} showProjectBadges={showProjectBadges} killingChatId={killingChatId} renamingChatId={renamingChatId} isPinned={pinnedChatIds.has(c.key || c.id)} onTogglePin={() => togglePin(c.key || c.id)} />
                ))}
              </>
            )}
            {idle.length > 0 && (
              <>
                <div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground/60">idle</div>
                {idle.map((c) => <ChatRow key={c.id} c={c} open={openPanes.has(c.key || c.id)} onOpen={() => openFromCollection(c.key || c.id)} onKill={() => handleKill(c.key || c.id)} onRename={(session, kind, name) => handleRename(session, kind, name)} dim showHostTags={showHostTags} showTypeBadges={showTypeBadges} showStatusIndicators={showStatusIndicators} showProjectBadges={showProjectBadges} killingChatId={killingChatId} renamingChatId={renamingChatId} isPinned={pinnedChatIds.has(c.key || c.id)} onTogglePin={() => togglePin(c.key || c.id)} />)}
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
    const active = hostChats.filter((c) => c.active);
    const idle = hostChats.filter((c) => !c.active);
    const visibleActive = active.filter((c) => !hiddenTabs.includes(c.key || c.id));
    const hiddenActive = active.filter((c) => hiddenTabs.includes(c.key || c.id));
    const info = hostSessions[H] || {};
    const sessions = info.sessions || [];
    const openFromHost = (key: string) => { onOpenChat(key); setView({ kind: 'root' }); };
    return (
      <div className="flex flex-col h-full min-h-0 animate-in slide-in-from-right-2 duration-150">
        <div className="flex items-center gap-2 px-2 py-2 border-b shrink-0">
          <button className="text-xs text-muted-foreground hover:text-foreground px-1 rounded active:scale-95 transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background hover:bg-accent/50" onClick={() => setView({ kind: 'root' })} title="back">‹</button>
          <span className="text-xs font-medium flex-1 truncate">{LABEL[H] || H}</span>
          <button className="text-xs text-muted-foreground hover:text-foreground rounded px-1 active:scale-95 transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background hover:bg-accent/50" onClick={() => fetchHostSessions(H)} disabled={loadingHost === H} title="rescan">
            {loadingHost === H ? <Skeleton className="h-3 w-3" /> : '↻'}
          </button>
        </div>
        <ScrollArea className="flex-1 min-h-0">
          <div className="p-1.5 flex flex-col gap-0.5">
            {(visibleActive.length > 0 || idle.length > 0 || hiddenActive.length > 0) && (
              <div className="px-2 pt-1 pb-1 text-[10px] uppercase tracking-wider text-green-500/80 font-semibold">● live (tmux)</div>
            )}
            {visibleActive.map((c) => <ChatRow key={c.id} c={c} open={openPanes.has(c.key || c.id)} onOpen={() => openFromHost(c.key || c.id)} onKill={() => handleKill(c.key || c.id)} onRename={(session, kind, name) => handleRename(session, kind, name)} onHide={() => onHideTab(c.key || c.id)} gitInfo={gitStatus[c.key || c.id]} showHostTags={showHostTags} showTypeBadges={showTypeBadges} showStatusIndicators={showStatusIndicators} showProjectBadges={showProjectBadges} killingChatId={killingChatId} renamingChatId={renamingChatId} isPinned={pinnedChatIds.has(c.key || c.id)} onTogglePin={() => togglePin(c.key || c.id)} />)}
            {hiddenActive.length > 0 && (
              <>
                <button onClick={() => setHiddenExpanded(!hiddenExpanded)} className="flex items-center gap-1 px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground/60 hover:text-foreground w-full active:bg-accent/80 transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded">
                  <span>{hiddenExpanded ? '▾' : '▸'}</span>
                  <span>hidden ({hiddenActive.length})</span>
                </button>
                {hiddenExpanded && hiddenActive.map((c) => (
                  <ChatRow key={c.id} c={c} open={openPanes.has(c.key || c.id)} onOpen={() => openFromHost(c.key || c.id)} onKill={() => handleKill(c.key || c.id)} onRename={(session, kind, name) => handleRename(session, kind, name)} onUnhide={() => onUnhideTab(c.key || c.id)} dim gitInfo={gitStatus[c.key || c.id]} showHostTags={showHostTags} showTypeBadges={showTypeBadges} showStatusIndicators={showStatusIndicators} showProjectBadges={showProjectBadges} killingChatId={killingChatId} renamingChatId={renamingChatId} isPinned={pinnedChatIds.has(c.key || c.id)} onTogglePin={() => togglePin(c.key || c.id)} />
                ))}
              </>
            )}
            {idle.length > 0 && (
              <>
                <div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground/60">idle</div>
                {idle.map((c) => <ChatRow key={c.id} c={c} open={openPanes.has(c.key || c.id)} onOpen={() => openFromHost(c.key || c.id)} onKill={() => handleKill(c.key || c.id)} onRename={(session, kind, name) => handleRename(session, kind, name)} dim gitInfo={gitStatus[c.key || c.id]} showHostTags={showHostTags} showTypeBadges={showTypeBadges} showStatusIndicators={showStatusIndicators} showProjectBadges={showProjectBadges} killingChatId={killingChatId} renamingChatId={renamingChatId} isPinned={pinnedChatIds.has(c.key || c.id)} onTogglePin={() => togglePin(c.key || c.id)} />)}
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
                <button
                  key={s.id}
                  onClick={() => { handleResume(s.id, s.summary, s.cwd, H); setView({ kind: 'root' }); }}
                  disabled={isLoading}
                  className="flex flex-col gap-0.5 px-2 py-1.5 rounded-md text-left text-xs hover:bg-accent active:bg-accent/80 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  title={`resume ${s.id}\n${s.cwd}`}
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
              );
            })}
            {hostChats.length === 0 && sessions.length === 0 && loadingHost !== H && (
              <EmptyState type="nothing-here" />
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
    const name = (c.name || id).toLowerCase();
    const host = (c.host || '').toLowerCase();
    const type = chatType(c).toLowerCase();
    return name.includes(query) || host.includes(query) || type.includes(query);
  });

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0">
        <span className="text-xs text-muted-foreground">active</span>
        <Input
          placeholder="filter..."
          value={tabSearchQuery}
          onChange={(e) => setTabSearchQuery(e.target.value)}
          className="h-6 text-[10px] px-2 flex-1 max-w-[120px]"
        />
        <Badge variant="secondary" className="text-xs">{filteredTabs.length}</Badge>
        <button className="text-xs text-muted-foreground hover:text-foreground rounded px-1 active:scale-95 transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background hover:bg-accent/50" onClick={onRefresh} disabled={loading}>
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
          {filteredTabs
            .filter((id) => {
              if (!projectFilter) return true;
              const c = findChat(chats, id);
              return c && c.project === projectFilter;
            })
            .map((id) => {
            const c = findChat(chats, id);
            const type = chatType(c);
            const isOpen = openPanes.has(id);
            const hostTag = c ? (c.host === THIS_MACHINE ? 'local' : c.host) : '';
            const dead = !c || c.active === false;
            const originalIdx = activeTabs.indexOf(id);
            const gitInfo = gitStatus[id];
            return (
              <div key={id} data-tab-id={id} draggable
                onDragStart={() => setDragIdx(originalIdx)}
                onDragOver={(e) => { e.preventDefault(); setDragOverIdx(originalIdx); }}
                onDragEnd={() => { if (dragIdx !== null && dragOverIdx !== null && dragIdx !== dragOverIdx) onReorder(dragIdx, dragOverIdx); setDragIdx(null); setDragOverIdx(null); }}
                onDrop={(e) => { e.preventDefault(); if (dragIdx !== null && originalIdx !== dragIdx) onReorder(dragIdx, originalIdx); setDragIdx(null); setDragOverIdx(null); }}
                onClick={() => onOpenChat(id)}
                className={`group flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-xs hover:bg-accent cursor-pointer transition-all duration-150 ease-out focus-within:ring-2 focus-within:ring-primary focus-within:ring-offset-2 focus-within:ring-offset-background ${dead ? 'opacity-50' : ''} ${dragOverIdx === originalIdx && dragIdx !== null ? 'border-t-2 border-primary' : ''}`}>
                <span className="text-muted-foreground/40 cursor-grab active:cursor-grabbing select-none">⠿</span>
                {showStatusIndicators !== false && <span className={`size-2 rounded-full shrink-0 ${dead ? 'bg-red-500' : isOpen ? 'bg-green-500' : 'bg-muted-foreground/40'}`} />}
                <span className={`truncate flex-1 ${dead ? 'line-through text-muted-foreground' : ''}`}>{c?.name || id}</span>
                {!dead && showTypeBadges !== false && <span className={`text-[10px] ${TYPE_COLOR[type] || ''}`}>{type}</span>}
                {!dead && showHostTags !== false && hostTag && <span className="text-[10px] text-muted-foreground">{hostTag}</span>}
                {!dead && showProjectBadges && c?.project && <span className="text-[10px] text-muted-foreground">{c.project}</span>}
                {!dead && gitInfo?.branch && (
                  <>
                    <span className="text-[10px] text-cyan-400">{gitInfo.branch}</span>
                    {gitInfo.clean === false && <span className="text-[10px] text-yellow-400">±</span>}
                  </>
                )}
                <button className={`px-1 text-sm active:scale-95 transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded ${dead ? 'text-red-500 font-bold' : 'opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-500'}`} title={dead ? 'remove dead tab' : 'remove'} onClick={(e) => { e.stopPropagation(); onRemoveActive(id); }}>×</button>
              </div>
            );
          })}
          {filteredTabs.length === 0 && tabSearchQuery && (
            <div className="text-xs text-muted-foreground p-3 text-center">no tabs match "{tabSearchQuery}"</div>
          )}
          {activeTabs.length === 0 && !loading && (
            <EmptyState type="no-tabs" />
          )}
          {!showAllChats && chats.filter(c => c.active).length > 0 && (
            <div className="px-2 pt-1 pb-1">
              <button
                onClick={() => setShowAllChats(true)}
                className="text-xs text-blue-400 hover:text-blue-300 active:scale-95 transition-all duration-150 ease-out"
              >
                show all active chats →
              </button>
            </div>
          )}
          {showAllChats && (
            <>
              <div className="px-2 pt-1 pb-1 flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-wider text-green-500/80 font-semibold">active chats</span>
                <span className="text-[10px] text-muted-foreground">all hosts</span>
                <button onClick={() => setShowAllChats(false)} className="text-xs text-muted-foreground hover:text-foreground ml-auto active:scale-95 transition-all duration-150 ease-out">✕</button>
              </div>
              <div className="flex flex-col gap-0.5">
                {chats
                  .filter(c => c.active)
                  .sort((a, b) => ((b.active ? 1 : 0) - (a.active ? 1 : 0)) || a.id.localeCompare(b.id))
                  .slice(0, 20)
                  .map((c) => {
                    const type = chatType(c);
                    const hostLabel = c.host === THIS_MACHINE ? 'local' : c.host;
                    return (
                      <button
                        key={c.id}
                        onClick={() => onOpenChat(c.key || c.id)}
                        className="flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-xs hover:bg-accent active:bg-accent/80 cursor-pointer transition-colors"
                        title={`${c.id}\n${c.project || '?'} ${c.role || '?'}\n${hostLabel}`}
                      >
                        <span className="truncate flex-1">{c.key || c.id}</span>
                        {showTypeBadges !== false && <span className={`text-[10px] ${TYPE_COLOR[type] || ''}`}>{type}</span>}
                        {showProjectBadges && c.project && <span className="text-[10px] text-muted-foreground">{c.project}</span>}
                        {showHostTags !== false && <span className="text-[10px] text-muted-foreground">{hostLabel}</span>}
                      </button>
                    );
                  })}
              </div>
            </>
          )}
          <div className="mt-3 mb-1 border-t border-border/50" />
          <div className="px-2 pt-1 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground/60">hosts</div>
          <CollectionsSection
            chats={chats}
            onEnterCollection={enterCollection}
            onCreateCollection={handleCreateCollection}
          />
          {hosts
            .filter((h) => {
              if (!projectFilter) return true;
              const n = chats.filter((c) => c.host === h && c.active && c.project === projectFilter).length;
              return n > 0;
            })
            .map((h) => {
              const n = chats.filter((c) => c.host === h && c.active && (!projectFilter || c.project === projectFilter)).length;
              const hostStatus = hostStatuses[h];
              return (
              <button key={h} onClick={() => enterHost(h)} className="flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-xs hover:bg-accent active:bg-accent/80 w-full transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background">
                <span className={`size-2 rounded-full ${n ? 'bg-green-500' : 'bg-muted-foreground/40'}`} />
                <span className="flex-1 truncate">{LABEL[h] || h}</span>
                {h === THIS_MACHINE && <span className="text-[10px] text-cyan-400">local</span>}
                {h !== THIS_MACHINE && (
                  <span
                    className={`size-2 rounded-full ${
                      hostStatus?.status === 'online' ? 'bg-green-500' :
                      hostStatus?.status === 'offline' ? 'bg-red-500' :
                      'bg-gray-400'
                    }`}
                    title={hostStatus?.status === 'online' && hostStatus?.latency_ms ?
                      `${hostStatus.status} (${hostStatus.latency_ms}ms)` :
                      hostStatus?.status || 'unknown'}
                  />
                )}
                {n > 0 && <span className="text-[10px] text-muted-foreground">{n}</span>}
                <span className="text-muted-foreground/60">›</span>
              </button>
            );
          })}
          {allSessions.length > 0 && (
            <>
              <div className="mt-3 mb-1 border-t border-border/50" />
              <div className="flex items-center gap-2 px-2 py-1">
                <div className="px-2 pt-1 pb-1 text-[10px] uppercase tracking-wider text-cyan-500/80 font-semibold">☁ sessions</div>
                <div className="flex-1" />
                <span className="text-[10px] text-muted-foreground">all hosts</span>
                <button className="text-xs text-muted-foreground hover:text-foreground active:scale-95 transition-all duration-150 ease-out" onClick={() => fetchAllSessions()} disabled={loadingAllSessions}>{loadingAllSessions ? '…' : '↻'}</button>
              </div>
              <div className="flex flex-col gap-0.5">
                {allSessions.slice(0, 15).map((s) => {
                  const hostLabel = s.host === THIS_MACHINE ? 'local' : s.host;
                  return (
                    <button key={s.id} onClick={() => { onResume(s.id, s.summary, s.cwd, s.host); setView({ kind: 'root' }); }} className="flex flex-col gap-0.5 px-2 py-1.5 rounded-md text-left text-xs hover:bg-accent active:bg-accent/80 transition-colors" title={`resume ${s.id}\n${s.cwd}\n${hostLabel}`}>
                      <span className="truncate">{s.summary || <span className="text-muted-foreground">(no summary)</span>}</span>
                      <span className="text-[10px] text-muted-foreground truncate">{ago(s.mtime)} · {hostLabel} · {basename(s.cwd)}</span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </ScrollArea>
      {ctx && createPortal(
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onClick={() => setCtx(null)} onContextMenu={(e) => { e.preventDefault(); setCtx(null); }} onKeyDown={(e) => { if (e.key === 'Escape') setCtx(null); }} tabIndex={0} />
          <div style={{
            position: 'fixed',
            left: Math.min(ctx.x, window.innerWidth - 180),
            top: Math.min(ctx.y, window.innerHeight - 160),
            zIndex: 9999,
            minWidth: '10rem',
            background: 'var(--popover, #1c232c)',
            border: '1px solid var(--border, #2a313a)',
            borderRadius: '6px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
            padding: '4px 0'
          }}>
            <CtxItem label="Open" onClick={() => { onOpenChat(ctx.id); setCtx(null); }} />
            {!ctx.dead && <CtxItem label="Hide" onClick={() => { onHideTab(ctx.id); setCtx(null); }} />}
            {!ctx.dead && <CtxItem label="Kill session" onClick={() => { handleKill(ctx.id); setCtx(null); }} isLoading={killingChatId === ctx.id} />}
            <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }} />
            <CtxItem label="Remove tab" danger onClick={() => { onRemoveActive(ctx.id); setCtx(null); }} />
          </div>
        </>, document.body)}
      <CreateCollectionDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onCreated={handleCollectionCreated}
        existingCollections={collections}
      />
    </div>
  );
}

function CtxItem({ label, onClick, danger, isLoading }: { label: string; onClick: () => void; danger?: boolean; isLoading?: boolean }) {
  return (
    <button onClick={onClick} disabled={isLoading} className={`flex w-full text-left px-3 py-1.5 hover:bg-accent active:bg-accent/80 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background ${danger ? 'text-red-500' : ''}`}>
      {isLoading ? <Skeleton className="h-3 w-16" /> : label}
    </button>
  );
}

function ChatRow({ c, open, onOpen, onKill, onRename, onHide, onUnhide, dim, gitInfo, showHostTags, showTypeBadges, showStatusIndicators, showProjectBadges, killingChatId, renamingChatId, isPinned, onTogglePin }: {
  c: Chat; open: boolean; onOpen: () => void; onKill: () => void;
  onRename: (session: string, kind: string, name: string) => void;
  onHide?: () => void; onUnhide?: () => void; dim?: boolean;
  gitInfo?: { branch: string | null; clean: boolean | null };
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
      onClick={onOpen}
      className={`group flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-xs hover:bg-accent cursor-pointer transition-all duration-150 ease-out focus-within:ring-2 focus-within:ring-primary focus-within:ring-offset-2 focus-within:ring-offset-background ${open ? 'bg-accent' : ''} ${dim ? 'opacity-60' : ''}`}
    >
      {showStatusIndicators !== false && <span className={`size-2 rounded-full shrink-0 ${open ? 'bg-green-500' : c.active ? 'bg-green-500/50' : 'bg-muted-foreground/40'}`} />}
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
                <>
                  <span className="ml-1 text-[10px] text-cyan-400">{gitInfo.branch}</span>
                  {gitInfo.clean === false && <span className="ml-0.5 text-[10px] text-yellow-400">±</span>}
                </>
              )}
            </>
          )}
        </span>
      )}
      {isUser && !editing && (
        <>
          {onTogglePin && <button className={`px-0.5 ${isPinned ? 'text-yellow-500' : 'text-muted-foreground hover:text-foreground'} opacity-0 group-hover:opacity-100 active:scale-95 transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded`} title={isPinned ? 'unpin' : 'pin'} onClick={(e) => { e.stopPropagation(); onTogglePin(); }}>📌</button>}
          {onHide && <button className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground px-0.5 active:scale-95 transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded" title="hide" onClick={(e) => { e.stopPropagation(); onHide(); }}>▾</button>}
          {onUnhide && <button className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground px-0.5 active:scale-95 transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded" title="unhide" onClick={(e) => { e.stopPropagation(); onUnhide(); }}>▴</button>}
          <button
            className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-500 px-0.5 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded"
            title="kill + forget"
            onClick={(e) => { e.stopPropagation(); onKill(); }}
            disabled={isKilling || isRenaming}
          >
            {isKilling ? <Skeleton className="h-3 w-3" /> : '×'}
          </button>
        </>
      )}
    </div>
  );
}
