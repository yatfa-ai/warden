import { useEffect, useState, useCallback, useRef } from 'react';
import { streamApi } from '@/lib/stream';
import { postJson } from '@/lib/api';
import { loadUi, saveUi, persistUiState, initialWorkspace, type RestoreOnStartup, type PaneLayout } from '@/lib/storage';
import { applyTheme, listenSystemThemeChange, getEffectiveTheme, resolveTerminalTheme, type Theme, type TerminalColorScheme } from '@/lib/theme';
import { applyDensity, type Density } from '@/lib/density';
import type { Chat } from '@/lib/types';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ChatSidebar } from '@/components/ChatSidebar';
import { PaneGrid } from '@/components/PaneGrid';
import { ObserverTabs } from '@/components/ObserverTabs';
import { SettingsPage } from '@/components/SettingsPage';
import { GlobalSearchDialog } from '@/components/GlobalSearchDialog';
import { HealthDashboard } from '@/components/HealthDashboard';
import { AttentionBadge } from '@/components/AttentionBadge';
import { StatusDot } from '@/components/StatusDot';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { useNotificationPrefs } from '@/lib/useNotificationPrefs';
import { toast } from 'sonner';

// Canonical id of this machine's own tmux host (mirrors LOCAL in src/chats.js). Local agents
// are auto-discovered on mount so their dots are live without a click; remote SSH hosts stay
// on-demand per lazy mode.
const THIS_MACHINE = '(local)';

// Apply in-flight optimistic mutations to a freshly-fetched/merged chat list so
// a background catalog refresh (/api/chats) or live discovery (/api/discover)
// can't resurrect a just-killed chat or revert a just-renamed name while that
// op's server round-trip is still pending (the disk file hasn't updated yet).
// A no-op when nothing is in flight. Pure/module-level so callers don't widen
// their useCallback dependency arrays.
function applyOptimisticGuard(list: Chat[], killed: Set<string>, renamed: Map<string, string>): Chat[] {
  if (!killed.size && !renamed.size) return list;
  return list
    .filter((c) => !killed.has(c.key || c.id))
    .map((c) => {
      const pendingName = renamed.get(c.key || c.id);
      return pendingName === undefined ? c : { ...c, name: pendingName };
    });
}

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
  // Mirrors of the active-tab/pane state, read synchronously inside optimistic
  // callbacks (e.g. performKill's rollback) to capture a pre-mutation snapshot
  // without widening those callbacks' dependency arrays.
  const activeTabsRef = useRef(activeTabs); activeTabsRef.current = activeTabs;
  const hiddenTabsRef = useRef(hiddenTabs); hiddenTabsRef.current = hiddenTabs;
  const openPanesRef = useRef(openPanes); openPanesRef.current = openPanes;
  // In-flight optimistic mutations. The catalog merge in applyCatalog() would
  // otherwise re-introduce a just-killed chat or revert a just-renamed name from
  // the on-disk catalog while that op's server round-trip is still pending (the
  // disk file hasn't updated yet) — a flash-back. These let the merge defer to
  // the local optimistic state during that window; cleared once the server
  // confirms (or rolls back).
  const killedChatIdsRef = useRef<Set<string>>(new Set());
  const pendingRenamesRef = useRef<Map<string, string>>(new Map());
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
  // The OS-resolved effective theme (light/dark). The `theme` state variable
  // stays 'system' on an OS flip, so chrome re-paints via a direct DOM class
  // mutation in the [theme] effect — no React re-render. But the terminal
  // surface re-themes imperatively inside PaneTile's effect, which only re-fires
  // when this prop changes. Tracking effectiveTheme as React state and feeding it
  // to resolveTerminalTheme is what makes "Match app theme" live-update on an OS
  // flip (nuance #1): listenSystemThemeChange calls setEffectiveTheme, the prop
  // propagates to PaneTile, and its [terminalTheme] effect re-paints open panes.
  const [effectiveTheme, setEffectiveTheme] = useState<'light' | 'dark'>(() => getEffectiveTheme(uiState.theme ?? 'system'));
  const [density, setDensity] = useState<Density>(() => uiState.density ?? 'comfortable');
  const [paneLayout, setPaneLayout] = useState<PaneLayout>(() => uiState.paneLayout ?? 'auto');
  const [terminalFontSize, setTerminalFontSize] = useState(() => uiState.terminalFontSize ?? 14);
  const [terminalScrollback, setTerminalScrollback] = useState(() => uiState.terminalScrollback ?? 10000);
  // Terminal color scheme: 'auto' follows the effective app theme (above);
  // 'dark'/'light' force the terminal surface. Pure client-side pref (like
  // terminalFontSize/scrollback): persisted by the saveUi effect below, never
  // sent to the backend.
  const [terminalColorScheme, setTerminalColorScheme] = useState<TerminalColorScheme>(() => uiState.terminalColorScheme ?? 'auto');
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
    // Keep the OS-resolved effective theme in sync so resolveTerminalTheme (and
    // thus open terminal panes) follow a manual Color Scheme change live.
    setEffectiveTheme(getEffectiveTheme(theme));
    saveUi({ ...loadUi(), theme });

    // If system mode, listen for system theme changes. The `theme` state stays
    // 'system' here (chrome re-paints via applyTheme's direct DOM class toggle),
    // but we ALSO push the resolved effective theme into React state so the
    // terminal surface — which re-themes imperatively in PaneTile — live-updates
    // on an OS flip (nuance #1).
    if (theme === 'system') {
      const cleanup = listenSystemThemeChange((t) => {
        applyTheme('system');
        setEffectiveTheme(t);
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
    saveUi(persistUiState({ activeTabs, hiddenTabs, openPanes, focused, sidebarCollapsed, observerCollapsed, healthCollapsed, sidebarWidth, observerWidth, terminalFontSize, terminalScrollback, terminalColorScheme, theme, density, paneLayout, paneHost, defaultNewChatPreset, defaultNewChatHost }, restoreOnStartup, loadUi(), startedEmpty));
  }, [activeTabs, hiddenTabs, openPanes, focused, sidebarCollapsed, observerCollapsed, healthCollapsed, sidebarWidth, observerWidth, terminalFontSize, terminalScrollback, terminalColorScheme, theme, density, paneLayout, paneHost, defaultNewChatPreset, defaultNewChatHost, restoreOnStartup, startedEmpty]);

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
        let base: Chat[];
        if (!discovered.size) {
          base = diskChats;
        } else {
          const liveById = new Map<string, Chat>();
          for (const c of prev) if (discovered.has(c.host)) liveById.set(c.id, c);
          const diskIds = new Set(diskChats.map((c) => c.id));
          const merged = diskChats.map((c) => {
            const live = liveById.get(c.id);
            return live ? { ...c, active: live.active, lastActivity: live.lastActivity, status: live.status } : c;
          });
          const extraLive = [...liveById.values()].filter((c) => !diskIds.has(c.id));
          base = [...merged, ...extraLive];
        }
        // Respect in-flight optimistic mutations so a background catalog refresh
        // can't resurrect a just-killed chat or revert a just-renamed one while
        // its server round-trip is still pending (the disk file hasn't updated).
        return applyOptimisticGuard(base, killedChatIdsRef.current, pendingRenamesRef.current);
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
        setChats((prev) => applyOptimisticGuard([...prev.filter((c) => c.host !== host), ...j.chats] as Chat[], killedChatIdsRef.current, pendingRenamesRef.current));
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

  // Kill-chat confirmation + optimistic UI. The native `window.confirm` guard is
  // replaced by a controlled ConfirmDialog: `requestKill` opens it (or, when the
  // "Confirm before destructive actions" preference is off, fires immediately).
  // `performKill` is OPTIMISTIC — it removes the row from local state in the same
  // frame as the click, before the cross-host SSH round-trip to /api/kill, and
  // rolls the row back (chats entry + tab + pane) on failure. Because the row
  // vanishes instantly there is no longer a blocking kill spinner, so requestKill
  // no longer returns an awaitable promise.
  const [killTarget, setKillTarget] = useState<string | null>(null);

  const performKill = useCallback(async (id: string) => {
    const existing = chatsRef.current.find((x) => (x.key || x.id) === id);
    const host = existing?.host;
    // Snapshot the row's tab/pane occupancy (read from refs so this callback's
    // deps stay stable) so a failed kill can restore the exact pre-click state.
    const wasActive = activeTabsRef.current.includes(id);
    const wasHidden = hiddenTabsRef.current.includes(id);
    const wasPane = openPanesRef.current.includes(id);
    const wasFocused = focusedRef.current === id;

    // Restore the row to its pre-click occupancy. Idempotent (guards on
    // presence) in case a concurrent refresh already re-added the entry.
    const rollback = () => {
      // Clear the optimistic guard first so a concurrent refresh stops hiding
      // the row before we restore it.
      killedChatIdsRef.current.delete(id);
      if (existing) setChats((prev) => prev.some((c) => (c.key || c.id) === id) ? prev : [...prev, existing]);
      if (wasActive) setActiveTabs((p) => p.includes(id) ? p : [...p, id]);
      if (wasHidden) setHiddenTabs((p) => p.includes(id) ? p : [...p, id]);
      if (wasPane) setOpenPanes((p) => p.includes(id) ? p : [...p, id]);
      if (wasFocused) setFocused(id);
    };

    // OPTIMISTIC: mutate local state immediately — before the await — so the
    // row disappears in the same frame as the click, not after the SSH
    // round-trip (hundreds of ms to seconds on a remote host). Guard the id so
    // a background catalog refresh can't resurrect it from disk mid-round-trip.
    killedChatIdsRef.current.add(id);
    removeActive(id);
    // Also drop the killed chat from the `chats` list itself (removeActive only
    // clears its tab/pane) so the row is gone from the sidebar's agent list in
    // this same frame. The killedChatIds guard above keeps the catalog merge /
    // live discovery from resurrecting it from disk while the round-trip is
    // pending; once it resolves the server no longer lists it either.
    setChats((prev) => prev.filter((c) => (c.key || c.id) !== id));

    try {
      const { ok, error, res } = await postJson('/api/kill', { id });
      if (!ok) {
        // ROLLBACK: the server rejected the kill, so restore the row.
        rollback();
        // Generic toast on a server error, reason appended on a network failure.
        if (prefs.notifyChatOps) toast.error(res ? 'Failed to kill chat' : `Failed to kill chat: ${error || ''}`);
        return;
      }
      // Success: the server confirmed the kill, so the disk catalog no longer
      // lists this chat — drop the optimistic guard and reconcile local state
      // with the server (the server remains the source of truth).
      killedChatIdsRef.current.delete(id);
      refresh();
      // discoverHost re-pulls that host's live list, confirming the kill and
      // refreshing the rest of the host's agents.
      if (host) void discoverHost(host);
      if (prefs.notifyChatOps) toast.success('Chat killed');
    } catch (error) {
      // ROLLBACK on a thrown error too (e.g. an unexpected exception).
      rollback();
      if (prefs.notifyChatOps) toast.error(`Failed to kill chat: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [refresh, discoverHost, removeActive, prefs.notifyChatOps]);

  const requestKill = useCallback((id: string) => {
    if (confirmDestructiveActions) {
      setKillTarget(id); // opens the ConfirmDialog; confirmKill/cancelKill close it
    } else {
      // preference off: honor the opt-out — skip the confirm and kill immediately.
      void performKill(id);
    }
  }, [confirmDestructiveActions, performKill]);

  const confirmKill = useCallback(() => {
    const id = killTarget;
    setKillTarget(null);
    if (id) void performKill(id);
  }, [killTarget, performKill]);

  const cancelKill = useCallback(() => {
    setKillTarget(null);
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
    const prevName = chatsRef.current.find((c) => (c.key || c.id) === session)?.name;
    // OPTIMISTIC: reflect the new name in the same frame as the commit, before
    // the cross-host round-trip to /api/rename resolves. Guard it so a
    // background catalog refresh can't revert it from the on-disk (pre-rename)
    // name mid-round-trip.
    pendingRenamesRef.current.set(session, name);
    setChats((prev) => prev.map((c) => (c.key || c.id) === session ? { ...c, name } : c));

    // Stop guarding and restore the prior name (undefined → falls back to key/id).
    const rollback = () => {
      pendingRenamesRef.current.delete(session);
      setChats((prev) => prev.map((c) => (c.key || c.id) === session ? { ...c, name: prevName } : c));
    };

    try {
      const { ok, error, res } = await postJson('/api/rename', { session, kind, name });
      if (!ok) {
        // ROLLBACK: the server rejected the rename.
        rollback();
        // Generic toast on a server error, reason appended on a network failure.
        if (prefs.notifyChatOps) toast.error(res ? 'Failed to rename chat' : `Failed to rename: ${error || ''}`);
        return;
      }
      // Success: the disk catalog now holds the new name — drop the guard.
      pendingRenamesRef.current.delete(session);
      refresh();
      if (prefs.notifyChatOps) toast.success('Chat renamed');
    } catch (error) {
      // ROLLBACK on a thrown error too.
      rollback();
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
  // Resolved terminal surface color. 'auto' defers to the OS-resolved effective
  // theme; 'dark'/'light' force it. Recomputed every render so a manual Color
  // Scheme change — and, critically, an OS theme flip while Color Scheme =
  // "System" (which updates effectiveTheme via listenSystemThemeChange) — changes
  // this prop and re-themes already-open panes live via PaneTile's effect.
  const terminalTheme = resolveTerminalTheme(terminalColorScheme, effectiveTheme);
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
          paneLayout={paneLayout}
          setPaneLayout={setPaneLayout}
          restoreOnStartup={restoreOnStartup}
          setRestoreOnStartup={setRestoreOnStartup}
          terminalFontSize={terminalFontSize}
          setTerminalFontSize={setTerminalFontSize}
          terminalScrollback={terminalScrollback}
          setTerminalScrollback={setTerminalScrollback}
          terminalColorScheme={terminalColorScheme}
          setTerminalColorScheme={setTerminalColorScheme}
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
        <AttentionBadge onOpenChat={openChat} onOpenActivity={openActivityTab} />
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
            paneLayout={paneLayout}
            terminalTheme={terminalTheme}
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
