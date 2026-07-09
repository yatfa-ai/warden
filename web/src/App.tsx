import { useEffect, useState, useCallback, useRef } from 'react';
import { streamApi } from '@/lib/stream';
import { loadUi, saveUi } from '@/lib/storage';
import { applyTheme, listenSystemThemeChange, type Theme } from '@/lib/theme';
import { applyDensity, type Density } from '@/lib/density';
import type { Chat } from '@/lib/types';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ChatSidebar } from '@/components/ChatSidebar';
import { PaneGrid } from '@/components/PaneGrid';
import { ObserverTabs } from '@/components/ObserverTabs';
import { SettingsDialog } from '@/components/SettingsDialog';
import { GlobalSearchDialog } from '@/components/GlobalSearchDialog';
import { HealthDashboard } from '@/components/HealthDashboard';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useNotificationPrefs } from '@/lib/useNotificationPrefs';
import { toast } from 'sonner';

function App() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [sshHosts, setSshHosts] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeTabs, setActiveTabs] = useState<string[]>(() => loadUi().activeTabs);
  const [hiddenTabs, setHiddenTabs] = useState<string[]>(() => loadUi().hiddenTabs);
  const [openPanes, setOpenPanes] = useState<string[]>(() => loadUi().openPanes);
  const [focused, setFocused] = useState<string | null>(() => loadUi().focused);
  const [paneHost, setPaneHost] = useState<Record<string, string>>(() => loadUi().paneHost ?? {});
  const chatsRef = useRef(chats);
  useEffect(() => { chatsRef.current = chats; }, [chats]);
  const [sidebarWidth, setSidebarWidth] = useState(() => loadUi().sidebarWidth ?? 220);
  const [observerWidth, setObserverWidth] = useState(() => loadUi().observerWidth ?? 380);
  const [maximized, setMaximized] = useState<string | null>(null);
  const [newActivity, setNewActivity] = useState<Set<string>>(new Set());
  const [streamConn, setStreamConn] = useState(false);
  const [activitySinceClose, setActivitySinceClose] = useState<any>(null);
  const [showActivityBanner, setShowActivityBanner] = useState(false);
  const [externalViewMode, setExternalViewMode] = useState<'sessions' | 'activity' | null>(null);
  const [showGlobalSearch, setShowGlobalSearch] = useState(false);
  const [externalSearchQuery, setExternalSearchQuery] = useState<{ paneId: string; query: string } | null>(null);
  const focusedRef = useRef(focused);
  focusedRef.current = focused;

  const uiState = loadUi();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(uiState.sidebarCollapsed);
  const [observerCollapsed, setObserverCollapsed] = useState(uiState.observerCollapsed);
  const [healthCollapsed, setHealthCollapsed] = useState(uiState.healthCollapsed ?? true);
  const [theme, setTheme] = useState<Theme>(() => uiState.theme ?? 'system');
  const [density, setDensity] = useState<Density>(() => uiState.density ?? 'comfortable');
  const { prefs, reload: reloadNotificationPrefs } = useNotificationPrefs();

  useEffect(() => {
    streamApi.onOpen = () => setStreamConn(true);
    streamApi.onClose = () => setStreamConn(false);
    streamApi.onAnyMessage = (m) => {
      if (m.type === 'pty' && m.id !== focusedRef.current) {
        setNewActivity((prev) => { if (prev.has(m.id)) return prev; const n = new Set(prev); n.add(m.id); return n; });
      }
    };
    streamApi.connect();
    refresh();

    // Load display settings on mount
    fetch('/api/config')
      .then((r) => r.json())
      .then((cfg) => {
        setDisplaySettings({
          showHostTags: cfg.showHostTags ?? true,
          showTypeBadges: cfg.showTypeBadges ?? true,
          showStatusIndicators: cfg.showStatusIndicators ?? true,
          showProjectBadges: cfg.showProjectBadges ?? false,
        });
      })
      .catch((err) => console.error('Failed to load display settings:', err));

    // Check for activity since last close
    const checkActivitySinceClose = async () => {
      const lastCloseStr = localStorage.getItem('warden:lastClose');
      if (lastCloseStr) {
        const lastClose = parseInt(lastCloseStr, 10);
        const now = Date.now();
        if (now - lastClose > 60000) { // Only show if closed for more than 1 minute
          try {
            const res = await fetch(`/api/activity/stats?after=${new Date(lastClose).toISOString()}`);
            const stats = await res.json();
            if (stats.total > 0) {
              setActivitySinceClose(stats);
              setShowActivityBanner(true);
            }
          } catch (e) {
            console.error('Failed to fetch activity stats:', e);
          }
        }
      }
    };
    checkActivitySinceClose();

    // Store close timestamp on unmount
    const handleBeforeUnload = () => {
      localStorage.setItem('warden:lastClose', String(Date.now()));
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      streamApi.onOpen = null;
      streamApi.onClose = null;
      streamApi.onAnyMessage = null;
      window.removeEventListener('beforeunload', handleBeforeUnload);
      handleBeforeUnload();
    };
  }, []);

  // clear "new" badge when a pane becomes focused
  useEffect(() => {
    if (focused) setNewActivity((prev) => { if (!prev.has(focused)) return prev; const n = new Set(prev); n.delete(focused); return n; });
  }, [focused]);

  // apply theme on mount and when theme changes
  useEffect(() => {
    // Apply theme immediately
    applyTheme(theme);
    saveUi({ ...loadUi(), theme });

    // If system mode, listen for system theme changes
    if (theme === 'system') {
      const cleanup = listenSystemThemeChange(() => {
        applyTheme('system');
      });
      return cleanup;
    }
  }, [theme]);

  // apply density on mount and when density changes (persisted via the saveUi effect below)
  useEffect(() => {
    applyDensity(density);
  }, [density]);

  useEffect(() => { saveUi({ activeTabs, hiddenTabs, openPanes, focused, sidebarCollapsed, observerCollapsed, healthCollapsed, sidebarWidth, observerWidth, theme, density, paneHost }); }, [activeTabs, hiddenTabs, openPanes, focused, sidebarCollapsed, observerCollapsed, healthCollapsed, sidebarWidth, observerWidth, theme, density, paneHost]);

  // keyboard shortcut for global search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'F') {
        e.preventDefault();
        setShowGlobalSearch(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    fetch('/api/ssh-hosts').then((r) => r.json()).then((j) => setSshHosts(j.hosts || [])).catch(() => {});
    try {
      const cr = await fetch('/api/chats');
      setChats((await cr.json()).chats || []);
    } catch (e) { console.error(e); }
    setLoading(false);
  }, []);

  // Refresh display customization settings from the backend (called on mount and
  // after Settings saves, so toggles take effect immediately without a reload).
  const refreshDisplaySettings = useCallback(async () => {
    try {
      const cfg = await fetch('/api/config').then((r) => r.json());
      setDisplaySettings({
        showHostTags: cfg.showHostTags ?? true,
        showTypeBadges: cfg.showTypeBadges ?? true,
        showStatusIndicators: cfg.showStatusIndicators ?? true,
        showProjectBadges: cfg.showProjectBadges ?? false,
      });
    } catch (e) {
      console.error('Failed to refresh display settings:', e);
    }
  }, []);

  // Called after Settings saves: reload chats/ssh-hosts, refresh notification prefs
  // everywhere (the shared hook broadcasts to all subscribers), and refresh display
  // settings — so all toggles take effect immediately without a page reload.
  const handleConfigChange = useCallback(() => {
    refresh();
    reloadNotificationPrefs();
    refreshDisplaySettings();
  }, [refresh, reloadNotificationPrefs, refreshDisplaySettings]);

  // Discover one host on demand (lazy mode): fetch live chats for that host and replace
  // its entries in the chats list so dots update to green/red.
  const discoverHost = useCallback(async (host: string) => {
    try {
      const r = await fetch(`/api/discover?host=${encodeURIComponent(host)}`);
      const j = await r.json();
      if (Array.isArray(j.chats)) {
        setChats((prev) => [...prev.filter((c) => c.host !== host), ...j.chats]);
      }
    } catch (e) { console.error('discoverHost failed:', e); }
  }, []);

  // open chat: add to active tabs + open pane + focus
  const openChat = useCallback((id: string) => {
    setActiveTabs((p) => p.includes(id) ? p : [...p, id]);
    setOpenPanes((p) => p.includes(id) ? p : [...p, id]);
    setFocused(id);
    // remember this pane's host so a restored remote pane knows which host to discover
    const c = chatsRef.current.find((x) => (x.key || x.id) === id);
    if (c?.host) setPaneHost((p) => (p[id] === c.host ? p : { ...p, [id]: c.host }));
  }, []);

  // handle focus-agent callback from Observer suggestion cards
  const handleFocusAgent = useCallback((id: string) => {
    openChat(id);
  }, [openChat]);

  // Seamless cross-host resume: when an observer session bound to an agent is
  // opened, reconnect to that agent's chat. We prime the pane's host hint and
  // (for remote hosts) discover the host so the pane can attach, then open the
  // chat — so the user never has to manually navigate to the right host.
  const handleReconnectChat = useCallback((chatKey: string, host?: string | null) => {
    if (host && host !== '(local)') {
      setPaneHost((p) => (p[chatKey] === host ? p : { ...p, [chatKey]: host }));
      void discoverHost(host);
    }
    openChat(chatKey);
  }, [openChat, discoverHost]);

  // close pane: pane gone, tab stays
  const closePane = useCallback((id: string) => {
    setOpenPanes((p) => p.filter((x) => x !== id));
    setFocused((f) => (f === id ? null : f));
  }, []);
  // remove from active: tab gone + pane gone
  const removeActive = useCallback((id: string) => {
    setActiveTabs((p) => p.filter((x) => x !== id));
    setHiddenTabs((p) => p.filter((x) => x !== id));
    setOpenPanes((p) => p.filter((x) => x !== id));
    setFocused((f) => (f === id ? null : f));
  }, []);
  const reorderTabs = useCallback((from: number, to: number) => {
    setActiveTabs((p) => {
      const n = [...p];
      const [item] = n.splice(from, 1);
      n.splice(to, 0, item);
      return n;
    });
  }, []);
  const hideTab = useCallback((id: string) => {
    setHiddenTabs((p) => p.includes(id) ? p : [...p, id]);
    setOpenPanes((p) => p.filter((x) => x !== id));
    setFocused((f) => (f === id ? null : f));
  }, []);
  const unhideTab = useCallback((id: string) => {
    setHiddenTabs((p) => p.filter((x) => x !== id));
  }, []);
  const toggleMax = useCallback((id: string) => setMaximized((m) => (m === id ? null : id)), []);
  const clearNew = useCallback((id: string) => setNewActivity((prev) => { if (!prev.has(id)) return prev; const n = new Set(prev); n.delete(id); return n; }), []);
  const forceKill = useCallback(async (id: string) => {
    try {
      const r = await fetch('/api/session-kill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
      if (!r.ok) {
        if (prefs.notifyChatOps) toast.error('Failed to force-kill session');
        return;
      }
      if (prefs.notifyChatOps) toast.success('Session force-killed');
    } catch (error) {
      if (prefs.notifyChatOps) toast.error(`Failed to force-kill: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [prefs.notifyChatOps]);

  // Kill-chat confirmation. The native `window.confirm` guard is replaced by a
  // controlled ConfirmDialog. `requestKill` opens the dialog and returns a
  // promise that resolves only once the flow finishes (confirm+fetch OR
  // cancel). ChatSidebar's `handleKill` wraps `await onKill(id)` in a
  // `killingChatId` loading/disabled state — keeping that promise pending
  // across the dialog and the fetch preserves the spinner + double-click guard
  // exactly as the old blocking confirm did.
  const [killTarget, setKillTarget] = useState<string | null>(null);
  const killResolveRef = useRef<(() => void) | null>(null);

  const performKill = useCallback(async (id: string) => {
    try {
      const r = await fetch('/api/kill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
      if (!r.ok) {
        if (prefs.notifyChatOps) toast.error('Failed to kill chat');
        return;
      }
      removeActive(id);
      refresh();
      if (prefs.notifyChatOps) toast.success('Chat killed');
    } catch (error) {
      if (prefs.notifyChatOps) toast.error(`Failed to kill chat: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [refresh, removeActive, prefs.notifyChatOps]);

  const requestKill = useCallback((id: string) => {
    setKillTarget(id);
    return new Promise<void>((resolve) => { killResolveRef.current = resolve; });
  }, []);

  const confirmKill = useCallback(() => {
    const id = killTarget;
    setKillTarget(null);
    if (id) {
      void performKill(id).finally(() => {
        killResolveRef.current?.();
        killResolveRef.current = null;
      });
    }
  }, [killTarget, performKill]);

  const cancelKill = useCallback(() => {
    setKillTarget(null);
    killResolveRef.current?.();
    killResolveRef.current = null;
  }, []);

  const resumeSession = useCallback(async (id: string, description: string, cwd: string, host: string) => {
    try {
      const r = await fetch('/api/resume', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, cwd, host, name: description || undefined }) });
      const j = await r.json();
      if (!r.ok) {
        if (prefs.notifyChatOps) toast.error(j.error || 'resume failed');
        return;
      }
      await refresh();
      openChat(j.chat.key);
      if (prefs.notifyChatOps) toast.success('Session resumed');
    } catch (e) {
      if (prefs.notifyChatOps) toast.error(e instanceof Error ? e.message : String(e));
    }
  }, [refresh, openChat, prefs.notifyChatOps]);

  const renameChat = useCallback(async (session: string, kind: string, name: string) => {
    try {
      const r = await fetch('/api/rename', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session, kind, name }) });
      if (!r.ok) {
        if (prefs.notifyChatOps) toast.error('Failed to rename chat');
        return;
      }
      refresh();
      if (prefs.notifyChatOps) toast.success('Chat renamed');
    } catch (error) {
      if (prefs.notifyChatOps) toast.error(`Failed to rename: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [refresh, prefs.notifyChatOps]);

  const openActivityTab = useCallback(() => {
    setObserverCollapsed(false);
    setExternalViewMode('activity');
  }, []);

  const handleFocusPane = useCallback((id: string) => {
    setFocused(id);
    setActiveTabs((p) => p.includes(id) ? p : [...p, id]);
    setOpenPanes((p) => p.includes(id) ? p : [...p, id]);
  }, []);

  const handleJumpToMatch = useCallback((id: string, query: string) => {
    setFocused(id);
    setActiveTabs((p) => p.includes(id) ? p : [...p, id]);
    setOpenPanes((p) => p.includes(id) ? p : [...p, id]);
    setExternalSearchQuery({ paneId: id, query });
  }, []);
  const openPaneSet = new Set(openPanes);
  const tiles = openPanes.map((id) => ({ id }));
  // The chat the observer should bind to when "observe focused" is clicked.
  const focusedChat = chats.find((c) => (c.key || c.id) === focused) || null;

  const [settingsOpen, setSettingsOpen] = useState(false);
  // Display customization settings
  const [displaySettings, setDisplaySettings] = useState({
    showHostTags: true,
    showTypeBadges: true,
    showStatusIndicators: true,
    showProjectBadges: false,
  });
  // Resize drag state
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [isResizingObserver, setIsResizingObserver] = useState(false);
  const dragStartX = useRef<number>(0);
  const dragStartSidebarWidth = useRef<number>(0);
  const dragStartObserverWidth = useRef<number>(0);

  const handleSidebarMouseDown = (e: React.MouseEvent) => {
    setIsResizingSidebar(true);
    dragStartX.current = e.clientX;
    dragStartSidebarWidth.current = sidebarWidth;
    e.preventDefault();
  };

  const handleObserverMouseDown = (e: React.MouseEvent) => {
    setIsResizingObserver(true);
    dragStartX.current = e.clientX;
    dragStartObserverWidth.current = observerWidth;
    e.preventDefault();
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isResizingSidebar) {
        const delta = e.clientX - dragStartX.current;
        const newWidth = dragStartSidebarWidth.current + delta;
        setSidebarWidth(Math.max(180, Math.min(400, newWidth)));
      }
      if (isResizingObserver) {
        const delta = dragStartX.current - e.clientX;
        const newWidth = dragStartObserverWidth.current + delta;
        setObserverWidth(Math.max(300, Math.min(600, newWidth)));
      }
    };

    const handleMouseUp = () => {
      setIsResizingSidebar(false);
      setIsResizingObserver(false);
    };

    if (isResizingSidebar || isResizingObserver) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isResizingSidebar, isResizingObserver]);

  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      {showActivityBanner && activitySinceClose && (
        <div className="flex items-center justify-between px-3 py-2 bg-blue-50 dark:bg-blue-950 border-b border-blue-200 dark:border-blue-800">
          <div className="flex items-center gap-3 text-sm">
            <span className="font-medium text-blue-900 dark:text-blue-100">While you were away:</span>
            <span className="text-blue-700 dark:text-blue-300">
              {activitySinceClose.directive_proposed > 0 && (
                <span className="mr-3">{activitySinceClose.directive_proposed} directive{activitySinceClose.directive_proposed !== 1 ? 's' : ''} sent</span>
              )}
              {activitySinceClose.attached > 0 && (
                <span className="mr-3">{activitySinceClose.attached} session{activitySinceClose.attached !== 1 ? 's' : ''} attached</span>
              )}
              {activitySinceClose.error > 0 && (
                <span className="mr-3 text-red-600 dark:text-red-400">{activitySinceClose.error} error{activitySinceClose.error !== 1 ? 's' : ''}</span>
              )}
              {activitySinceClose.total > 0 && (
                <span className="text-blue-600 dark:text-blue-400">{activitySinceClose.total} total event{activitySinceClose.total !== 1 ? 's' : ''}</span>
              )}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={openActivityTab}
              className="text-xs px-2 py-1 bg-blue-200 dark:bg-blue-800 text-blue-900 dark:text-blue-100 rounded hover:bg-blue-300 dark:hover:bg-blue-700 transition-colors"
            >
              View Activity
            </button>
            <button
              onClick={() => setShowActivityBanner(false)}
              className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-200"
            >
              ×
            </button>
          </div>
        </div>
      )}
      <header className="flex items-center gap-3 px-3 h-11 border-b shrink-0">
        <button onClick={() => setSidebarCollapsed(!sidebarCollapsed)} className="text-muted-foreground hover:text-foreground transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded px-1.5 py-0.5 hover:bg-accent/50" title="toggle sidebar">{sidebarCollapsed ? '▸' : '◂'}</button>
        <span className="font-semibold tracking-wide">Yatfa Warden</span>
        <span className="text-xs text-muted-foreground">{activeTabs.length} active · {openPanes.length} open</span>
        <span className="flex-1" />
        <span className={`size-2 rounded-full transition-colors duration-300 ease-in-out ${streamConn ? 'bg-green-500' : 'bg-red-500'}`} title={streamConn ? 'connected' : 'disconnected'} />
        <button onClick={() => setShowGlobalSearch(true)} className="text-muted-foreground hover:text-foreground transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded px-1.5 py-0.5 hover:bg-accent/50" title="global search (Ctrl+Shift+F)">⌕</button>
        <button onClick={() => setHealthCollapsed(!healthCollapsed)} className="text-muted-foreground hover:text-foreground transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded px-1.5 py-0.5 hover:bg-accent/50" title="toggle health panel">{healthCollapsed ? '◂' : '▸'} Health</button>
        <button onClick={() => setObserverCollapsed(!observerCollapsed)} className="text-muted-foreground hover:text-foreground transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded px-1.5 py-0.5 hover:bg-accent/50" title="toggle observer">{observerCollapsed ? '◂' : '▸'}</button>
        <button onClick={() => setSettingsOpen(true)} className="text-muted-foreground hover:text-foreground transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded px-1.5 py-0.5 hover:bg-accent/50" title="settings">⚙</button>
      </header>
      <main className="flex flex-1 min-h-0">
        <section className="border-r min-h-0 transition-all duration-200 ease-in-out overflow-hidden relative"
          style={{ width: sidebarCollapsed ? 0 : sidebarWidth, flexShrink: 0, opacity: sidebarCollapsed ? 0 : 1 }}>
          <div
            className="absolute top-0 right-0 bottom-0 w-1 hover:bg-accent hover:w-1.5 transition-all cursor-col-resize z-10"
            onMouseDown={handleSidebarMouseDown}
            title="Drag to resize sidebar"
          />
          <ErrorBoundary>
            <ChatSidebar
              chats={chats}
              sshHosts={sshHosts}
              activeTabs={activeTabs}
              hiddenTabs={hiddenTabs}
              openPanes={openPaneSet}
              onOpenChat={openChat}
              onClosePane={closePane}
              onRemoveActive={removeActive}
              onReorder={reorderTabs}
              onHideTab={hideTab}
              onUnhideTab={unhideTab}
              onKill={requestKill}
              onRename={renameChat}
              onResume={resumeSession}
              onRefresh={refresh}
              onDiscoverHost={discoverHost}
              loading={loading}
              showHostTags={displaySettings.showHostTags}
              showTypeBadges={displaySettings.showTypeBadges}
              showStatusIndicators={displaySettings.showStatusIndicators}
              showProjectBadges={displaySettings.showProjectBadges}
            />
          </ErrorBoundary>
        </section>
        <section className="flex-1 min-h-0 min-w-0">
          <PaneGrid
            tiles={tiles}
            focused={focused}
            maximized={maximized}
            newActivity={newActivity}
            chats={chats}
            paneHost={paneHost}
            onFocus={setFocused}
            onClose={closePane}
            onToggleMax={toggleMax}
            onClearNew={clearNew}
            onOpenChat={openChat}
            onForceKill={forceKill}
            externalSearchQuery={externalSearchQuery}
          />
        </section>
        <section className="border-l min-h-0 transition-all duration-200 ease-in-out overflow-hidden relative"
          style={{ width: observerCollapsed ? 0 : observerWidth, flexShrink: 0, opacity: observerCollapsed ? 0 : 1 }}>
          <div
            className="absolute top-0 left-0 bottom-0 w-1 hover:bg-accent hover:w-1.5 transition-all cursor-col-resize z-10"
            onMouseDown={handleObserverMouseDown}
            title="Drag to resize observer panel"
          />
          <ErrorBoundary>
            <ObserverTabs externalViewMode={externalViewMode} onFocusAgent={handleFocusAgent} focusedChat={focusedChat} onReconnectChat={handleReconnectChat} />
          </ErrorBoundary>
        </section>
        <section className="border-l min-h-0 transition-all duration-200 ease-in-out overflow-hidden"
          style={{ width: healthCollapsed ? 0 : 320, flexShrink: 0, opacity: healthCollapsed ? 0 : 1 }}>
          <HealthDashboard
            onOpenChat={openChat}
            onClose={() => setHealthCollapsed(true)}
          />
        </section>
      </main>
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onConfigChange={handleConfigChange}
        theme={theme}
        setTheme={setTheme}
        density={density}
        setDensity={setDensity}
      />
      <GlobalSearchDialog
        open={showGlobalSearch}
        onClose={() => setShowGlobalSearch(false)}
        openPanes={openPanes}
        onFocusPane={handleFocusPane}
        onJumpToMatch={handleJumpToMatch}
      />
      <ConfirmDialog
        open={killTarget !== null}
        onOpenChange={(o) => { if (!o) cancelKill(); }}
        title="Kill chat?"
        description="kill this chat and forget it?"
        confirmLabel="Kill"
        cancelLabel="Cancel"
        destructive
        onConfirm={confirmKill}
      />
    </div>
  );
}

export default App;
