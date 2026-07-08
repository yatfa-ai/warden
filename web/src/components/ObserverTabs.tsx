import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ObserverPanel } from './ObserverPanel';
import { ActivityTimeline } from './ActivityTimeline';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/EmptyState';
import { loadObs, saveObs } from '@/lib/storage';
import { useNotificationPrefs } from '@/lib/useNotificationPrefs';
import type { SessionMeta } from '@/lib/types';

interface Props {
  externalViewMode?: 'sessions' | 'activity' | null;
  onFocusAgent?: (id: string) => void;
}

// Manages persisted observer sessions as tabs. Every open tab keeps its own
// ObserverPanel (and WS) mounted; inactive ones are display:none so their
// conversations stay live. Open tabs + active tab persist in localStorage.
export function ObserverTabs({ externalViewMode, onFocusAgent }: Props = {}) {
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

  const createNew = useCallback(async () => {
    try {
      const r = await fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: null }) });
      if (!r.ok) {
        throw new Error(`HTTP ${r.status}: Failed to create session`);
      }
      const s: SessionMeta = await r.json();
      setSessions((p) => [s, ...p]);
      setOpenIds((p) => (p.includes(s.id) ? p : [...p, s.id]));
      setActiveId(s.id);
      if (prefsRef.current.notifySuccess) toast.success('New observer session created');
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
        const r = await fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: null }) });
        const s: SessionMeta = await r.json();
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

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-2 py-1.5 border-b shrink-0">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setViewMode('sessions')}
            className={`px-2.5 py-1 rounded-md text-xs whitespace-nowrap shrink-0 ${viewMode === 'sessions' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50'}`}
          >
            Sessions
          </button>
          <button
            onClick={() => setViewMode('activity')}
            className={`px-2.5 py-1 rounded-md text-xs whitespace-nowrap shrink-0 ${viewMode === 'activity' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50'}`}
          >
            Activity
          </button>
        </div>
        {viewMode === 'sessions' && (
          <Button size="sm" variant="ghost" className="h-7 px-2 text-base shrink-0" onClick={createNew} title="new observer session">+</Button>
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
          <div className="flex items-center gap-1 px-2 py-1.5 border-b shrink-0 overflow-x-auto">
            {openIds.map((id) => (
              <button
                key={id}
                onClick={() => setActiveId(id)}
                className={`px-2.5 py-1 rounded-md text-xs whitespace-nowrap shrink-0 ${activeId === id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50'}`}
              >
                {nameOf(id)}
                <span
                  className="ml-1.5 opacity-50 hover:opacity-100"
                  onClick={(e) => { e.stopPropagation(); closeTab(id); }}
                >×</span>
              </button>
            ))}
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
