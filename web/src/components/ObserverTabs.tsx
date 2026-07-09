import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ObserverPanel } from './ObserverPanel';
import { ActivityTimeline } from './ActivityTimeline';
import { Button } from '@/components/ui/button';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { EmptyState } from './EmptyState';
import { loadObs, saveObs } from '@/lib/storage';
import { postJson } from '@/lib/api';
import { useNotificationPrefs } from '@/lib/useNotificationPrefs';
import type { Chat, SessionMeta } from '@/lib/types';

interface Props {
  externalViewMode?: 'sessions' | 'activity' | null;
  onFocusAgent?: (id: string) => void;
  // The currently-focused chat pane, used to bind a new observer session to
  // the agent the user is looking at ("observe this agent").
  focusedChat?: Chat | null;
  // Called when a resumed observer session should reconnect to its bound chat.
  onReconnectChat?: (chatKey: string, host?: string | null) => void;
}

// Manages persisted observer sessions as tabs. Every open tab keeps its own
// ObserverPanel (and WS) mounted; inactive ones are display:none so their
// conversations stay live. Open tabs + active tab persist in localStorage.
export function ObserverTabs({ externalViewMode, onFocusAgent, focusedChat, onReconnectChat }: Props = {}) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [openIds, setOpenIds] = useState<string[]>(() => loadObs().openIds);
  const [activeId, setActiveId] = useState<string | null>(() => loadObs().activeId);
  const [viewMode, setViewMode] = useState<'sessions' | 'activity'>(() => loadObs().viewMode || 'sessions');
  const [booted, setBooted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingTimeout, setLoadingTimeout] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { prefs } = useNotificationPrefs();
  // `refresh` is memoized with [] deps and drives the boot effect; reading
  // prefs directly there would retrigger boot on every preference change. The
  // ref always holds the latest prefs without changing callback identity.
  const prefsRef = useRef(prefs);
  useEffect(() => { prefsRef.current = prefs; }, [prefs]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setLoadingTimeout(false);

    // Set loading timeout (10 seconds)
    const timeoutId = setTimeout(() => {
      setLoadingTimeout(true);
    }, 10000);

    try {
      const r = await fetch('/api/sessions');
      if (!r.ok) {
        throw new Error(`HTTP ${r.status}: ${r.statusText}`);
      }
      const j = await r.json();
      const list: SessionMeta[] = j.sessions || [];
      setSessions(list);
      return list;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      setError(errorMsg);
      if (prefsRef.current.notifyErrors) toast.error(`Failed to fetch sessions: ${errorMsg}`);
      return [];
    } finally {
      clearTimeout(timeoutId);
      setLoading(false);
      setLoadingTimeout(false);
    }
  }, []);

  const createNew = useCallback(async (chat?: Chat | null) => {
    try {
      // Bind the new session to `chat` when provided — "observe this agent".
      // The chat context is persisted with the session and used on resume to
      // reconnect to the same agent across hosts.
      const body: { name: string | null; host?: string | null; container?: string | null; project?: string | null; role?: string | null; chatKey?: string | null } = { name: null };
      if (chat) {
        body.host = chat.host ?? null;
        body.container = chat.container ?? null;
        body.project = chat.project ?? null;
        body.role = chat.role ?? null;
        body.chatKey = chat.key || chat.id || null;
      }
      const r = await postJson<SessionMeta>('/api/sessions', body);
      if (!r.ok) {
        throw new Error(r.res ? `HTTP ${r.res.status}: Failed to create session` : (r.error || 'Failed to create session'));
      }
      const s: SessionMeta = r.data!;
      setSessions((p) => [s, ...p]);
      setOpenIds((p) => (p.includes(s.id) ? p : [...p, s.id]));
      setActiveId(s.id);
      if (prefsRef.current.notifySuccess) {
        toast.success(chat ? `Observing ${chat.name || chat.key || chat.id}` : 'New observer session created');
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      if (prefsRef.current.notifyErrors) toast.error(`Failed to create session: ${errorMsg}`);
    }
  }, []);

  // boot: load sessions, restore tabs, ensure at least one session exists & is open
  useEffect(() => {
    (async () => {
      const list = await refresh();
      const stored = loadObs();
      let open = stored.openIds.filter((id) => list.some((s) => s.id === id));
      let active = stored.activeId && open.includes(stored.activeId) ? stored.activeId : (open[0] || null);
      if (list.length === 0) {
        const r = await postJson<SessionMeta>('/api/sessions', { name: null });
        const s: SessionMeta = r.data!;
        setSessions([s]); open = [s.id]; active = s.id;
      } else if (open.length === 0) {
        open = [list[0].id]; active = list[0].id;
      }
      setOpenIds(open);
      setActiveId(active);
      setBooted(true);
    })();
  }, [refresh]);

  useEffect(() => { if (booted) saveObs({ openIds, activeId, viewMode }); }, [openIds, activeId, viewMode, booted]);

  // Seamless resume: when a session bound to an agent chat becomes active,
  // reconnect to that chat (open its pane on the right host) exactly once. This
  // is the cross-host resumption promised by the stored chat context — the user
  // no longer has to remember which host the agent was on.
  const reconnectedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!booted || !onReconnectChat || !activeId) return;
    if (reconnectedRef.current.has(activeId)) return;
    const session = sessions.find((s) => s.id === activeId);
    if (session?.chatKey) {
      reconnectedRef.current.add(activeId);
      onReconnectChat(session.chatKey, session.host);
    }
  }, [booted, activeId, sessions, onReconnectChat]);

  // Respond to external view mode changes
  useEffect(() => {
    if (externalViewMode && externalViewMode !== viewMode) {
      setViewMode(externalViewMode);
    }
  }, [externalViewMode, viewMode]);

  const closeTab = (id: string) => {
    setOpenIds((p) => p.filter((x) => x !== id));
    setActiveId((a) => (a === id ? (openIds.find((x) => x !== id) || null) : a));
  };
  const nameOf = (id: string) => sessions.find((s) => s.id === id)?.name || id.slice(0, 6);
  const hostLabel = (id: string) => {
    const session = sessions.find((s) => s.id === id);
    return session?.host ? `@${session.host}` : '';
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-2 py-1.5 compact:py-1 border-b shrink-0">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setViewMode('sessions')}
            className={`px-2.5 py-1 rounded-md text-xs whitespace-nowrap shrink-0 transition-all duration-150 ease-out active:scale-95 ${viewMode === 'sessions' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50'}`}
          >
            Sessions
          </button>
          <button
            onClick={() => setViewMode('activity')}
            className={`px-2.5 py-1 rounded-md text-xs whitespace-nowrap shrink-0 transition-all duration-150 ease-out active:scale-95 ${viewMode === 'activity' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50'}`}
          >
            Activity
          </button>
        </div>
        {viewMode === 'sessions' && (
          <div className="flex items-center gap-0.5">
            <IconTooltip label={focusedChat ? `observe ${focusedChat.name || focusedChat.key || focusedChat.id} (binds this session to the focused chat)` : 'focus a chat pane, then click to observe it'} disabled={!focusedChat}>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-sm shrink-0 disabled:opacity-40"
                onClick={() => createNew(focusedChat ?? null)}
                disabled={!focusedChat}
              >👁</Button>
            </IconTooltip>
            <IconTooltip label="new observer session"><Button size="sm" variant="ghost" className="h-7 px-2 text-base shrink-0" onClick={() => createNew(null)}>+</Button></IconTooltip>
          </div>
        )}
      </div>

      {/* Sessions view */}
      {viewMode === 'sessions' && (
        <>
          {error && (
            <div className="mx-2 my-2 px-2 py-2 text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md">
              ⚠ {error}
            </div>
          )}
          {loading && !booted && !error && (
            <div className="p-4">
              <EmptyState type="no-data" message={loadingTimeout ? 'Loading sessions (taking longer than expected)...' : 'Loading sessions...'} />
            </div>
          )}
          <div className="flex items-center gap-1 px-2 py-1.5 compact:py-1 border-b shrink-0 overflow-x-auto">
            {openIds.map((id) => {
              const session = sessions.find((s) => s.id === id);
              const hostLbl = hostLabel(id);
              return (
                <button
                  key={id}
                  onClick={() => setActiveId(id)}
                  className={`px-2.5 py-1 rounded-md text-xs whitespace-nowrap shrink-0 transition-all duration-150 ease-out active:scale-95 ${activeId === id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50'}`}
                  title={session ? `${session.container || 'Unknown'}${session.project ? ` (${session.project})` : ''} @ ${session.host || 'local'}` : ''}
                >
                  {nameOf(id)}{hostLbl && <span className="ml-1 opacity-70">{hostLbl}</span>}
                  <span
                    className="ml-1.5 opacity-50 hover:opacity-100"
                    onClick={(e) => { e.stopPropagation(); closeTab(id); }}
                  >×</span>
                </button>
              );
            })}
          </div>
          <div className="flex-1 min-h-0">
            {openIds.map((id) => (
              <div key={id} className={activeId === id ? 'h-full' : 'hidden'}>
                <ObserverPanel sessionId={id} onFocusAgent={onFocusAgent} />
              </div>
            ))}
          </div>
        </>
      )}

      {/* Activity view */}
      {viewMode === 'activity' && (
        <div className="flex-1 min-h-0">
          <ActivityTimeline />
        </div>
      )}
    </div>
  );
}
