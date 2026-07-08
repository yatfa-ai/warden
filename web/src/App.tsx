import { useEffect, useState, useCallback, useRef } from 'react';
import { streamApi } from '@/lib/stream';
import { loadUi, saveUi } from '@/lib/storage';
import type { Chat } from '@/lib/types';
import { ChatSidebar } from '@/components/ChatSidebar';
import { PaneGrid } from '@/components/PaneGrid';
import { ObserverTabs } from '@/components/ObserverTabs';
import { SettingsDialog } from '@/components/SettingsDialog';

function App() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [sshHosts, setSshHosts] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeTabs, setActiveTabs] = useState<string[]>(() => loadUi().activeTabs);
  const [hiddenTabs, setHiddenTabs] = useState<string[]>(() => loadUi().hiddenTabs);
  const [openPanes, setOpenPanes] = useState<string[]>(() => loadUi().openPanes);
  const [focused, setFocused] = useState<string | null>(() => loadUi().focused);
  const [maximized, setMaximized] = useState<string | null>(null);
  const [newActivity, setNewActivity] = useState<Set<string>>(new Set());
  const [streamConn, setStreamConn] = useState(false);
  const [activitySinceClose, setActivitySinceClose] = useState<any>(null);
  const [showActivityBanner, setShowActivityBanner] = useState(false);
  const [externalViewMode, setExternalViewMode] = useState<'sessions' | 'activity' | null>(null);
  const focusedRef = useRef(focused);
  focusedRef.current = focused;

  const uiState = loadUi();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(uiState.sidebarCollapsed);
  const [observerCollapsed, setObserverCollapsed] = useState(uiState.observerCollapsed);

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

  useEffect(() => { saveUi({ activeTabs, hiddenTabs, openPanes, focused, sidebarCollapsed, observerCollapsed }); }, [activeTabs, hiddenTabs, openPanes, focused, sidebarCollapsed, observerCollapsed]);

  const refresh = useCallback(async () => {
    setLoading(true);
    fetch('/api/ssh-hosts').then((r) => r.json()).then((j) => setSshHosts(j.hosts || [])).catch(() => {});
    try {
      const cr = await fetch('/api/chats');
      setChats((await cr.json()).chats || []);
    } catch (e) { console.error(e); }
    setLoading(false);
  }, []);

  // open chat: add to active tabs + open pane + focus
  const openChat = useCallback((id: string) => {
    setActiveTabs((p) => p.includes(id) ? p : [...p, id]);
    setOpenPanes((p) => p.includes(id) ? p : [...p, id]);
    setFocused(id);
  }, []);
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
    try { await fetch('/api/session-kill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) }); } catch { /* noop */ }
  }, []);

  const killChat = useCallback(async (id: string) => {
    if (!window.confirm('kill this chat and forget it?')) return;
    try { await fetch('/api/kill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) }); } catch { /* noop */ }
    removeActive(id);
    refresh();
  }, [refresh, removeActive]);

  const resumeSession = useCallback(async (id: string, description: string, cwd: string, host: string) => {
    try {
      const r = await fetch('/api/resume', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, cwd, host, name: description || undefined }) });
      const j = await r.json();
      if (!r.ok) { window.alert(j.error || 'resume failed'); return; }
      await refresh();
      openChat(j.chat.key);
    } catch (e) { window.alert(e instanceof Error ? e.message : String(e)); }
  }, [refresh, openChat]);

  const renameChat = useCallback(async (session: string, kind: string, name: string) => {
    try { await fetch('/api/rename', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session, kind, name }) }); } catch { /* noop */ }
    refresh();
  }, [refresh]);

  const openActivityTab = useCallback(() => {
    setObserverCollapsed(false);
    setExternalViewMode('activity');
  }, []);
  const openPaneSet = new Set(openPanes);
  const tiles = openPanes.map((id) => ({ id }));

  const [settingsOpen, setSettingsOpen] = useState(false);

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
        <button onClick={() => setSidebarCollapsed(!sidebarCollapsed)} className="text-muted-foreground hover:text-foreground" title="toggle sidebar">{sidebarCollapsed ? '▸' : '◂'}</button>
        <span className="font-semibold tracking-wide">Yatfa Warden</span>
        <span className="text-xs text-muted-foreground">{activeTabs.length} active · {openPanes.length} open</span>
        <span className="flex-1" />
        <span className={`size-2 rounded-full ${streamConn ? 'bg-green-500' : 'bg-red-500'}`} title={streamConn ? 'connected' : 'disconnected'} />
        <button onClick={() => setSettingsOpen(true)} className="text-muted-foreground hover:text-foreground" title="settings">⚙</button>
        <button onClick={() => setObserverCollapsed(!observerCollapsed)} className="text-muted-foreground hover:text-foreground" title="toggle observer">{observerCollapsed ? '◂' : '▸'}</button>
      </header>
      <main className="flex flex-1 min-h-0">
        {!sidebarCollapsed && (
          <section className="border-r min-h-0" style={{ width: 220, flexShrink: 0 }}>
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
              onKill={killChat}
              onRename={renameChat}
              onResume={resumeSession}
              onRefresh={refresh}
              loading={loading}
            />
          </section>
        )}
        <section className="flex-1 min-h-0 min-w-0">
          <PaneGrid
            tiles={tiles}
            focused={focused}
            maximized={maximized}
            newActivity={newActivity}
            chats={chats}
            onFocus={setFocused}
            onClose={closePane}
            onToggleMax={toggleMax}
            onClearNew={clearNew}
            onOpenChat={openChat}
            onForceKill={forceKill}
          />
        </section>
        {!observerCollapsed && (
          <section className="border-l min-h-0" style={{ width: 380, flexShrink: 0 }}>
            <ObserverTabs externalViewMode={externalViewMode} />
          </section>
        )}
      </main>
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onConfigChange={refresh}
      />
    </div>
  );
}

export default App;
