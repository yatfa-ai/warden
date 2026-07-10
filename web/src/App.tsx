import { useEffect, useState, useCallback, useRef } from 'react';
import { streamApi } from '@/lib/stream';
import { postJson } from '@/lib/api';
import { loadUi, saveUi, persistUiState, initialWorkspace, type RestoreOnStartup } from '@/lib/storage';
import { applyTheme, listenSystemThemeChange, type Theme } from '@/lib/theme';
import { applyDensity, type Density } from '@/lib/density';
import type { Chat } from '@/lib/types';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ChatSidebar } from '@/components/ChatSidebar';
import { PaneGrid } from '@/components/PaneGrid';
import { ObserverTabs } from '@/components/ObserverTabs';
import { SettingsPage } from '@/components/SettingsPage';
import { GlobalSearchDialog } from '@/components/GlobalSearchDialog';
import { HealthDashboard } from '@/components/HealthDashboard';
import { StatusDot } from '@/components/StatusDot';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { useNotificationPrefs } from '@/lib/useNotificationPrefs';
import { toast } from 'sonner';

// Canonical id of this machine's own tmux host (mirrors LOCAL in src/chats.js). Local agents
// are auto-discovered on mount so their dots are live without a click; remote SSH hosts stay
// on-demand per lazy mode.
const THIS_MACHINE = '(local)';

function App() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [sshHosts, setSshHosts] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null);
  // Read persisted UI state ONCE on mount (lazy initializer runs only the first
  // render) and reuse it for every useState seed below — consolidates the prior
  // per-state loadUi() calls into a single read.
  const [uiState] = useState(() => loadUi());
  // Stable for the session: true when THIS launch started in "Start empty" mode.
  // The live workspace is then a gated clean slate, not a legitimate workspace to
  // persist — so for the whole session persistUiState carries the on-disk workspace
  // forward (even after flipping back to "Reopen previous"), never the live arrays.
  const startedEmpty = uiState.restoreOnStartup === 'empty';
  const [restoreOnStartup, setRestoreOnStartup] = useState<RestoreOnStartup>(() => uiState.restoreOnStartup ?? 'previous');
  const initWs = initialWorkspace(uiState, uiState.restoreOnStartup ?? 'previous');
  const [activeTabs, setActiveTabs] = useState<string[]>(() => initWs.activeTabs);
  const [hiddenTabs, setHiddenTabs] = useState<string[]>(() => initWs.hiddenTabs);
  const [openPanes, setOpenPanes] = useState<string[]>(() => initWs.openPanes);
  const [focused, setFocused] = useState<string | null>(() => initWs.focused);
  const [paneHost, setPaneHost] = useState<Record<string, string>>(() => initWs.paneHost);
  const chatsRef = useRef(chats);
  useEffect(() => { chatsRef.current = chats; }, [chats]);
  // Hosts the user has engaged with (sidebar host-click / observer reconnect / resume). In
  // lazy mode only these get live SSH discovery; the auto-refresh re-discovers them so their
  // active/idle dot + last-activity advance without a manual click. /api/chats alone is
  // disk-only (active=null), so this set is what bounds the live-refresh SSH cost to visited
  // hosts rather than the whole fleet.
  const discoveredHostsRef = useRef<Set<string>>(new Set());
  const [sidebarWidth, setSidebarWidth] = useState(() => uiState.sidebarWidth ?? 220);
  const [observerWidth, setObserverWidth] = useState(() => uiState.observerWidth ?? 380);
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

  const [sidebarCollapsed, setSidebarCollapsed] = useState(uiState.sidebarCollapsed);
  const [observerCollapsed, setObserverCollapsed] = useState(uiState.observerCollapsed);
  const [healthCollapsed, setHealthCollapsed] = useState(uiState.healthCollapsed ?? true);
  const [theme, setTheme] = useState<Theme>(() => uiState.theme ?? 'system');
  const [density, setDensity] = useState<Density>(() => uiState.density ?? 'comfortable');
  const [terminalFontSize, setTerminalFontSize] = useState(() => uiState.terminalFontSize ?? 14);
  const [terminalScrollback, setTerminalScrollback] = useState(() => uiState.terminalScrollback ?? 10000);
  // Default agent type + host pre-filled in the ＋ new chat form. Pure client-side
  // prefs (like density/terminalFontSize): persisted by the saveUi effect below,
  // never sent to the backend.
  const [defaultNewChatPreset, setDefaultNewChatPreset] = useState<'claude' | 'shell'>(() => uiState.defaultNewChatPreset ?? 'claude');
  const [defaultNewChatHost, setDefaultNewChatHost] = useState(() => uiState.defaultNewChatHost ?? THIS_MACHINE);
  const { prefs, reload: reloadNotificationPrefs } = useNotificationPrefs();
  // "Confirm before destructive actions" preference (default on). Gates both
  // destructive kill paths — force-kill (tmux session) and kill chat. Loaded
  // from /api/config on mount and refreshed after Settings saves. Declared up
  // here because the forceKill/requestKill callbacks below read it eagerly via
  // their dependency arrays.
  const [confirmDestructiveActions, setConfirmDestructiveActions] = useState(true);

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
    refreshConfigPrefs();

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

  // Persist live UI state, honoring the "Restore workspace on startup" pref.
  // persistUiState carries the on-disk workspace forward (instead of the live
  // arrays) whenever the pref is 'empty' OR this launch started empty — otherwise
  // a clean/'empty' launch, or flipping back to "Reopen previous" from one, would
  // overwrite and destroy the last saved workspace.
  useEffect(() => {
    saveUi(persistUiState({ activeTabs, hiddenTabs, openPanes, focused, sidebarCollapsed, observerCollapsed, healthCollapsed, sidebarWidth, observerWidth, terminalFontSize, terminalScrollback, theme, density, paneHost, defaultNewChatPreset, defaultNewChatHost }, restoreOnStartup, loadUi(), startedEmpty));
  }, [activeTabs, hiddenTabs, openPanes, focused, sidebarCollapsed, observerCollapsed, healthCollapsed, sidebarWidth, observerWidth, terminalFontSize, terminalScrollback, theme, density, paneHost, defaultNewChatPreset, defaultNewChatHost, restoreOnStartup, startedEmpty]);

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

  // Refresh the chat list from the disk catalog (/api/chats, zero SSH in lazy mode). `silent`
  // skips the loading toggle so background auto-refresh ticks don't flash the ↻ button. In
  // lazy mode /api/chats returns disk-only chats (active=null), so we MERGE instead of
  // replacing: for hosts already discovered live we restore their last-known
  // active/lastActivity/status (and keep live-only chats — yatfa containers / external
  // spawns — that aren't in the catalog). A catalog refresh therefore never wipes green/red
  // dots back to "unknown". Live data itself is advanced by refreshDiscoveredHosts().
  const applyCatalog = useCallback(async (silent: boolean) => {
    if (!silent) setLoading(true);
    fetch('/api/ssh-hosts').then((r) => r.json()).then((j) => setSshHosts(j.hosts || [])).catch((error) => console.error('[ssh-hosts] Failed:', error));
    try {
      const cr = await fetch('/api/chats');
      const diskChats: Chat[] = (await cr.json()).chats || [];
      setChats((prev) => {
        const discovered = discoveredHostsRef.current;
        if (!discovered.size) return diskChats;
        const liveById = new Map<string, Chat>();
        for (const c of prev) if (discovered.has(c.host)) liveById.set(c.id, c);
        const diskIds = new Set(diskChats.map((c) => c.id));
        const merged = diskChats.map((c) => {
          const live = liveById.get(c.id);
          return live ? { ...c, active: live.active, lastActivity: live.lastActivity, status: live.status } : c;
        });
        const extraLive = [...liveById.values()].filter((c) => !diskIds.has(c.id));
        return [...merged, ...extraLive];
      });
      setLastRefreshAt(Date.now());
    } catch (e) { console.error(e); }
    if (!silent) setLoading(false);
  }, []);

  const refresh = useCallback(async () => { await applyCatalog(false); }, [applyCatalog]);

  // Refresh backend-backed preferences from /api/config (display customization
  // + the "Confirm before destructive actions" safety toggle). Called on mount
  // and after Settings saves, so toggles take effect immediately without a reload.
  const refreshConfigPrefs = useCallback(async () => {
    try {
      const cfg = await fetch('/api/config').then((r) => r.json());
      setDisplaySettings({
        showHostTags: cfg.showHostTags ?? true,
        showTypeBadges: cfg.showTypeBadges ?? true,
        showStatusIndicators: cfg.showStatusIndicators ?? true,
        showProjectBadges: cfg.showProjectBadges ?? false,
        hideOfflineHosts: cfg.hideOfflineHosts ?? false,
      });
      setConfirmDestructiveActions(cfg.confirmDestructiveActions ?? true);
    } catch (e) {
      console.error('Failed to refresh config preferences:', e);
    }
  }, []);

  // Called after Settings saves: reload chats/ssh-hosts, refresh notification prefs
  // everywhere (the shared hook broadcasts to all subscribers), and refresh config
  // preferences — so all toggles take effect immediately without a page reload.
  const handleConfigChange = useCallback(() => {
    refresh();
    reloadNotificationPrefs();
    refreshConfigPrefs();
  }, [refresh, reloadNotificationPrefs, refreshConfigPrefs]);

  // Discover one host on demand (lazy mode): fetch live chats for that host and replace
  // its entries in the chats list so dots update to green/red.
  const discoverHost = useCallback(async (host: string) => {
    discoveredHostsRef.current.add(host);
    try {
      const r = await fetch(`/api/discover?host=${encodeURIComponent(host)}`);
      const j = await r.json();
      if (Array.isArray(j.chats)) {
        setChats((prev) => [...prev.filter((c) => c.host !== host), ...j.chats]);
      }
    } catch (e) { console.error('discoverHost failed:', e); }
  }, []);

  // Re-discover every host the user has engaged with, concurrently. This is what keeps
  // active/idle dots + last-activity live: /api/discover is the only source of live status in
  // lazy mode (/api/chats is disk-only). Bounded to visited hosts — not the whole fleet — so
  // SSH cost tracks user engagement, and only invoked while the tab is visible (see the
  // auto-refresh effect below).
  const refreshDiscoveredHosts = useCallback(async () => {
    const hosts = [...discoveredHostsRef.current];
    if (!hosts.length) return;
    await Promise.all(hosts.map((h) => discoverHost(h)));
  }, [discoverHost]);

  // Auto-refresh the agent list so active/idle dots + last-activity stay live in the sidebar
  // without a manual refresh. Lazy mode serves /api/chats from disk only (active=null); live
  // status comes from /api/discover, which the client normally runs just on host-click. So
  // each visible tick silently re-pulls the catalog AND re-discovers every host the user has
  // already engaged with — that is what advances dots/timestamps and surfaces external spawns.
  // Ticks are gated on Page Visibility so a backgrounded tab never burns SSH; on regaining
  // focus we refresh immediately because state may be stale while hidden.
  useEffect(() => {
    const REFRESH_MS = 60_000;
    const poll = async () => {
      if (document.visibilityState !== 'visible') return;
      await applyCatalog(true);
      void refreshDiscoveredHosts();
    };
    const onVisibilityChange = async () => {
      if (document.visibilityState !== 'visible') return;
      await applyCatalog(true);
      void refreshDiscoveredHosts();
    };
    const intervalId = window.setInterval(poll, REFRESH_MS);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [applyCatalog, refreshDiscoveredHosts]);

  // Discover this machine's own agents once on mount. Local discovery is cheap (no SSH) and is
  // the common case, so local agents show live immediately and the auto-refresh above keeps
  // them live — no host-click required. Remote hosts remain on-demand per lazy mode.
  useEffect(() => {
    void discoverHost(THIS_MACHINE);
  }, [discoverHost]);

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
  // Stable toggles for keyboard shortcuts: useCallback with functional updates gives
  // them empty deps and a stable identity, so PaneGrid's keydown effect doesn't
  // tear down/re-subscribe on every App render (matching every other PaneGrid handler).
  const toggleSidebar = useCallback(() => setSidebarCollapsed((c) => !c), []);
  const toggleObserver = useCallback(() => setObserverCollapsed((c) => !c), []);
  const clearNew = useCallback((id: string) => setNewActivity((prev) => { if (!prev.has(id)) return prev; const n = new Set(prev); n.delete(id); return n; }), []);

  // Force-kill confirmation. The ⏹ force-kill button sits directly beside
  // clear/download/close in the pane toolbar — a single misclick otherwise
  // kills a possibly-running agent's tmux session with no guard. When "Confirm
  // before destructive actions" is on (default), open a ConfirmDialog first;
  // when off (power-user opt-out), kill immediately with no friction.
  const [forceKillTarget, setForceKillTarget] = useState<string | null>(null);

  const performForceKill = useCallback(async (id: string) => {
    const { ok, error, res } = await postJson('/api/session-kill', { id });
    if (!ok) {
      // Match the prior split: a generic toast on a server error, the reason
      // appended on a network failure.
      if (prefs.notifyChatOps) toast.error(res ? 'Failed to force-kill session' : `Failed to force-kill: ${error || ''}`);
      return;
    }
    if (prefs.notifyChatOps) toast.success('Session force-killed');
  }, [prefs.notifyChatOps]);

  const forceKill = useCallback((id: string) => {
    if (confirmDestructiveActions) setForceKillTarget(id);
    else void performForceKill(id);
  }, [confirmDestructiveActions, performForceKill]);

  const confirmForceKill = useCallback(() => {
    const id = forceKillTarget;
    setForceKillTarget(null);
    if (id) void performForceKill(id);
  }, [forceKillTarget, performForceKill]);

  const cancelForceKill = useCallback(() => {
    setForceKillTarget(null);
  }, []);

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
    const host = chatsRef.current.find((x) => (x.key || x.id) === id)?.host;
    try {
      const { ok, error, res } = await postJson('/api/kill', { id });
      if (!ok) {
        // Generic toast on a server error, reason appended on a network failure.
        if (prefs.notifyChatOps) toast.error(res ? 'Failed to kill chat' : `Failed to kill chat: ${error || ''}`);
        return;
      }
      removeActive(id);
      // Drop the killed chat from `chats` synchronously so the catalog merge in
      // refresh() can't re-append it: a discovered host's live-only entries are
      // preserved by that merge, so without this the killed chat would briefly
      // resurrect with its last-known status until discoverHost(host) resolves
      // (1-3s for a remote host) — easily misread as "the kill failed".
      setChats((prev) => prev.filter((c) => (c.key || c.id) !== id));
      refresh();
      // discoverHost re-pulls that host's live list, confirming the kill and
      // refreshing the rest of the host's agents.
      if (host) void discoverHost(host);
      if (prefs.notifyChatOps) toast.success('Chat killed');
    } catch (error) {
      if (prefs.notifyChatOps) toast.error(`Failed to kill chat: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [refresh, discoverHost, removeActive, prefs.notifyChatOps]);

  const requestKill = useCallback((id: string) => {
    // Returns a promise that resolves when the kill flow finishes (confirm+fetch,
    // direct fetch, OR cancel). ChatSidebar awaits this to drive its spinner /
    // disabled state, so it must stay pending across both branches below — that
    // is what preserves the loading state exactly as the old blocking confirm did.
    return new Promise<void>((resolve) => {
      killResolveRef.current = resolve;
      if (confirmDestructiveActions) {
        setKillTarget(id); // opens the ConfirmDialog; confirmKill/cancelKill resolve
      } else {
        // preference off: honor the opt-out — skip the confirm, kill immediately,
        // then resolve so the sidebar's spinner clears.
        void performKill(id).finally(() => {
          killResolveRef.current?.();
          killResolveRef.current = null;
        });
      }
    });
  }, [confirmDestructiveActions, performKill]);

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
      const result = await postJson<{ chat: { key: string; id: string } }>('/api/resume', { id, cwd, host, name: description || undefined });
      if (!result.ok) {
        if (prefs.notifyChatOps) toast.error(result.error || 'resume failed');
        return;
      }
      const chat = result.data!.chat;
      // Drop any stale entry for this resumed chat before refresh() so the catalog
      // merge can't carry forward its pre-resume status. Re-resuming the same Claude
      // session reuses the `resume-<sid>` tmux session, so the existing live entry
      // would otherwise briefly flash its old (e.g. idle) status until discoverHost
      // re-marks it active. (chat's key/id — not the bare Claude session id passed
      // in — is what matches a chat already in the list.)
      const resumedId = chat.key || chat.id;
      setChats((prev) => prev.filter((c) => (c.key || c.id) !== resumedId));
      await refresh();
      // Resuming activates the chat; re-discover the host so it shows green immediately
      // instead of waiting for the next auto-refresh tick.
      if (host) void discoverHost(host);
      openChat(chat.key);
      if (prefs.notifyChatOps) toast.success('Session resumed');
    } catch (e) {
      if (prefs.notifyChatOps) toast.error(e instanceof Error ? e.message : String(e));
    }
  }, [refresh, discoverHost, openChat, prefs.notifyChatOps]);

  const renameChat = useCallback(async (session: string, kind: string, name: string) => {
    try {
      const { ok, error, res } = await postJson('/api/rename', { session, kind, name });
      if (!ok) {
        // Generic toast on a server error, reason appended on a network failure.
        if (prefs.notifyChatOps) toast.error(res ? 'Failed to rename chat' : `Failed to rename: ${error || ''}`);
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
    hideOfflineHosts: false,
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
      {settingsOpen ? (
        <SettingsPage
          onClose={() => setSettingsOpen(false)}
          onConfigChange={handleConfigChange}
          theme={theme}
          setTheme={setTheme}
          density={density}
          setDensity={setDensity}
          restoreOnStartup={restoreOnStartup}
          setRestoreOnStartup={setRestoreOnStartup}
          terminalFontSize={terminalFontSize}
          setTerminalFontSize={setTerminalFontSize}
          terminalScrollback={terminalScrollback}
          setTerminalScrollback={setTerminalScrollback}
          defaultNewChatPreset={defaultNewChatPreset}
          setDefaultNewChatPreset={setDefaultNewChatPreset}
          defaultNewChatHost={defaultNewChatHost}
          setDefaultNewChatHost={setDefaultNewChatHost}
        />
      ) : (
        <>
      <header className="flex items-center gap-3 px-3 h-11 border-b shrink-0">
        <IconTooltip label="toggle sidebar" side="bottom"><button onClick={() => setSidebarCollapsed(!sidebarCollapsed)} className="text-muted-foreground hover:text-foreground transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded px-1.5 py-0.5 hover:bg-accent/50">{sidebarCollapsed ? '▸' : '◂'}</button></IconTooltip>
        <span className="font-semibold tracking-wide">Yatfa Warden</span>
        <span className="text-xs text-muted-foreground">{activeTabs.length} active · {openPanes.length} open</span>
        <span className="flex-1" />
        <StatusDot
          tone={streamConn ? 'green' : 'red'}
          variant={streamConn ? 'solid' : 'ring'}
          label={streamConn ? 'Connected' : 'Disconnected'}
          className="transition-colors duration-300 ease-in-out"
        />
        <IconTooltip label="global search (Ctrl+Shift+F)" side="bottom"><button onClick={() => setShowGlobalSearch(true)} className="text-muted-foreground hover:text-foreground transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded px-1.5 py-0.5 hover:bg-accent/50">⌕</button></IconTooltip>
        <IconTooltip label="toggle health panel" side="bottom"><button onClick={() => setHealthCollapsed(!healthCollapsed)} className="text-muted-foreground hover:text-foreground transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded px-1.5 py-0.5 hover:bg-accent/50">{healthCollapsed ? '◂' : '▸'} Health</button></IconTooltip>
        <IconTooltip label="toggle observer" side="bottom"><button onClick={() => setObserverCollapsed(!observerCollapsed)} className="text-muted-foreground hover:text-foreground transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded px-1.5 py-0.5 hover:bg-accent/50">{observerCollapsed ? '◂' : '▸'}</button></IconTooltip>
        <IconTooltip label="settings" side="bottom"><button onClick={() => setSettingsOpen(true)} className="text-muted-foreground hover:text-foreground transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded px-1.5 py-0.5 hover:bg-accent/50">⚙</button></IconTooltip>
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
              lastRefreshAt={lastRefreshAt}
              showHostTags={displaySettings.showHostTags}
              showTypeBadges={displaySettings.showTypeBadges}
              showStatusIndicators={displaySettings.showStatusIndicators}
              showProjectBadges={displaySettings.showProjectBadges}
              hideOfflineHosts={displaySettings.hideOfflineHosts}
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
            onToggleSidebar={toggleSidebar}
            onToggleObserver={toggleObserver}
            fontSize={terminalFontSize}
            onFontSizeChange={setTerminalFontSize}
            scrollback={terminalScrollback}
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
        </>
      )}
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
      <ConfirmDialog
        open={forceKillTarget !== null}
        onOpenChange={(o) => { if (!o) cancelForceKill(); }}
        title="Force-kill session?"
        description="Force-kill this session? This kills the tmux session for a possibly-running agent and cannot be undone."
        confirmLabel="Force-kill"
        cancelLabel="Cancel"
        destructive
        onConfirm={confirmForceKill}
      />
    </div>
  );
}

export default App;
