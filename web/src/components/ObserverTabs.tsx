import { useCallback, useEffect, useRef, useState } from 'react';
import { hostLabelFor } from '@/lib/chatDisplay';
import type { IssueLinkEntry } from '@/lib/issue-links';
import { useHostLabels, useObserverViewMode, useSetObserverViewMode, useObserverActivityFilters, useSetObserverActivityFilters, useObserverDirectiveFilters, useSetObserverDirectiveFilters, useObserverAttentionFilters, useSetObserverAttentionFilters } from '@/lib/uiStore';
import { toast } from 'sonner';
import { ObserverPanel } from './ObserverPanel';
import { ActivityTimeline } from './ActivityTimeline';
import { DirectiveHistory } from './DirectiveHistory';
import { Button } from '@/components/ui/button';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { EmptyState } from './EmptyState';
import { loadObs, saveObs } from '@/lib/storage';
import type { ObsUi } from '@/lib/storage';
import { postJson } from '@/lib/api';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { copyWithToast } from '@/lib/clipboardToast';
import { useNotificationPrefs } from '@/lib/useNotificationPrefs';
import { fetchBounded } from '@/lib/api';
import { hasBoundSession, selectIdleTabs, IDLE_TICK_MS } from '@/lib/observerLifecycle';
import { AttentionView } from './AttentionView';
import type { AttentionListProps } from './AttentionList';
import type { Chat, SessionMeta } from '@/lib/types';

interface Props {
  // The currently-focused chat pane, used to bind a new observer session to
  // the agent the user is looking at ("observe this agent").
  focusedChat?: Chat | null;
  // Called when a resumed observer session should reconnect to its bound chat.
  onReconnectChat?: (chatKey: string, host?: string | null) => void;
  // WARDEN-332 — the two preference-driven observer lifecycle behaviors. Both
  // are persisted (server.js / config.js) and flow App → /api/config → here.
  // observerAutoStart: when true, focusing a chat spawns+opens a bound observer
  //   session with no manual "observe" click. Default false = today's manual
  //   behavior, unchanged.
  // observerSessionTimeout: auto-close an observer tab idle past N minutes. null
  //   disables auto-close. Default 30 (see config.js) — a genuine, intended
  //   behavior change for every fresh install, NOT a regression to "fix".
  observerAutoStart?: boolean;
  observerSessionTimeout?: number | null;
  // WARDEN-880 — the Attention view's data + handlers, threaded from App's lifted
  // attentionRollup (the SAME values the header AttentionBadge consumes). When
  // provided, a 4th "Attention" tab renders as a persistent peer to Activity/Directives
  // — the ranked "where am I needed, because X" answer that stays mounted while the
  // human opens/switches agent panes (the popover on the header badge dismisses on every
  // pane switch). Optional so the component degrades gracefully without it (no tab).
  attention?: AttentionListProps;
  // WARDEN-1394 — the fleet-scoped tracker entries for the markdown issue-key
  // linkifier, ambiguity-filtered upstream (App: unambiguousPrefixEntries over
  // the normalized config mapping, gated on issueLinksEnabled). Threaded to the
  // ObserverPanel (message bodies) and DirectiveHistory (directive text) mounts.
  // Optional/undefined (the default while the integration is off) renders both
  // surfaces byte-identically to before this prop existed.
  issueEntries?: IssueLinkEntry[];
}

// Manages persisted observer sessions as tabs. Every open tab keeps its own
// ObserverPanel (and WS) mounted; inactive ones are display:none so their
// conversations stay live. Open tabs + active tab persist in localStorage.
export function ObserverTabs({ focusedChat, onReconnectChat, observerAutoStart, observerSessionTimeout, attention, issueEntries }: Props = {}) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const hostLabels = useHostLabels();
  // WARDEN-1397 (client-state slice 10): ONE seed read of the ObsUi document.
  // loadObs is pure — a JSON.parse of the versioned warden:observer:v1 key — and
  // between this mount and the boot effect's re-read below nothing else writes
  // that key (this component's saveObs effect is booted-gated; App's only other
  // write is the Settings-page reset, which unmounts the full-page dashboard so
  // the panel re-seeds on remount — see App's reset comment). Slice 15 moved the
  // four view prefs' seeding into the uiStore's module-level seed, so `obsSeed`
  // now initializes exactly the two workspace facts that stayed component-local:
  // openIds/activeId. (The 10 per-field lazy useState seeds slice 10 replaced
  // each cost their own JSON.parse.) The seed rides as a BARE function reference
  // — React's lazy initializer calls it exactly once, no arguments.
  const [obsSeed] = useState(loadObs);
  const [openIds, setOpenIds] = useState<string[]>(obsSeed.openIds);
  const [activeId, setActiveId] = useState<string | null>(obsSeed.activeId);
  // WARDEN-1441 (client-state slice 15): the four view prefs — viewMode + the
  // three per-tab filter shapes — moved onto the shared uiStore (the
  // observerViewMode / observerActivityFilters / observerDirectiveFilters /
  // observerAttentionFilters facts). App's "View Activity" deep-links and the
  // Settings → Reset action now write the store DIRECTLY, so the retired
  // one-shot `externalViewMode` prop + `resetToken` nonce command channels are
  // deleted (they existed precisely because App cannot call a child's useState
  // setter; their comments document the WARDEN-880 yank/dead-link pair and the
  // WARDEN-981 nonce). Same local names, so the obsBag save effect below is
  // untouched; seeding and the ??-only defaults moved to createUiStore, which
  // reads them from storage.ts (loadObs + resetObsPrefDefaults) at module seed.
  const viewMode = useObserverViewMode();
  const setViewMode = useSetObserverViewMode();
  const activityFilters = useObserverActivityFilters();
  const setActivityFilters = useSetObserverActivityFilters();
  const directiveFilters = useObserverDirectiveFilters();
  const setDirectiveFilters = useSetObserverDirectiveFilters();
  const attentionFilters = useObserverAttentionFilters();
  const setAttentionFilters = useSetObserverAttentionFilters();
  // The children keep their exact controlled-prop contract — scalar value plus a
  // `(v: string) => void` setter — through these spread-updater adapters, so the
  // three tab components are untouched. Each spreads the STORE's current shape —
  // captured fresh per render, since this component re-renders whenever any of
  // the four store values it subscribes to changes — and replaces the parent
  // object on every scalar write, which is precisely the per-key change signal
  // the saveObs effect's Object.values dep array reads. No useCallback: the
  // three tab children are unmemoized function components and no effect keys on
  // these identities, so per-render closures cost nothing (the former
  // useState-setter stability guarantee became a zustand-action guarantee one
  // hop down, inside the store setters themselves).
  const setActTypeFilter = (v: string) => setActivityFilters({ ...activityFilters, type: v });
  const setActAgentFilter = (v: string) => setActivityFilters({ ...activityFilters, agent: v });
  const setActHostFilter = (v: string) => setActivityFilters({ ...activityFilters, host: v });
  const setDirAgentFilter = (v: string) => setDirectiveFilters({ ...directiveFilters, agent: v });
  const setDirHostFilter = (v: string) => setDirectiveFilters({ ...directiveFilters, host: v });
  const setAttnAgentFilter = (v: string) => setAttentionFilters({ ...attentionFilters, agent: v });
  const setAttnHostFilter = (v: string) => setAttentionFilters({ ...attentionFilters, host: v });
  const [booted, setBooted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingTimeout, setLoadingTimeout] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Inline rename state (mirrors the shipped WorkspaceTabs twin, WARDEN-424/432):
  // `editingId` is the session being renamed; `draft` is the in-flight name
  // (committed on Enter/blur, reverted on Escape).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  // WARDEN-1327 — the tab under a pending menu-Close confirm. The menu item is
  // only the REQUEST; the destructive ConfirmDialog at the root is where
  // closeTab (close = DELETE the {id}.json/{id}.md transcripts, WARDEN-792)
  // actually fires — a transcript-destroying click buried in a 5-item menu is
  // exactly the misclick profile the shared dialog exists for (the
  // CollectionsSection delete-card shape). The × affordance and the idle-close
  // tick are deliberately NOT routed through this; their instant behavior is
  // unchanged.
  const [pendingCloseId, setPendingCloseId] = useState<string | null>(null);
  const { prefs } = useNotificationPrefs();
  // `refresh` is memoized with [] deps and drives the boot effect; reading
  // prefs directly there would retrigger boot on every preference change. The
  // ref always holds the latest prefs without changing callback identity.
  const prefsRef = useRef(prefs);
  useEffect(() => { prefsRef.current = prefs; }, [prefs]);

  // WARDEN-332 — latest snapshots read inside memoized callbacks / minimal-dep
  // effects, mirroring the prefsRef idiom (adding these to a callback's deps
  // would either retrigger boot/refresh or reschedule the idle interval on every
  // state/preference change). Each ref tracks the freshest value only.
  const sessionsRef = useRef(sessions);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);
  const openIdsRef = useRef(openIds);
  useEffect(() => { openIdsRef.current = openIds; }, [openIds]);
  const sessionTimeoutRef = useRef(observerSessionTimeout);
  useEffect(() => { sessionTimeoutRef.current = observerSessionTimeout; }, [observerSessionTimeout]);

  // Last-activity timestamp (ms) per open session id. The activity signal is
  // INCOMING OBSERVER WS EVENTS — bumped from ObserverPanel's ws.onmessage (a
  // session the agent is actively writing to is never idle), plus seeded once
  // when a tab is opened. See lib/observerLifecycle.ts for the idle selection.
  const lastActivityRef = useRef<Record<string, number>>({});
  const bumpActivity = useCallback((id: string) => {
    lastActivityRef.current[id] = Date.now();
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setLoadingTimeout(false);

    // Set loading timeout (10 seconds)
    const timeoutId = setTimeout(() => {
      setLoadingTimeout(true);
    }, 10000);

    try {
      // WARDEN-1144: bounded on the shared deadline. This surface already had a
      // hand-rolled 10s `loadingTimeout` timer — but that only changes the COPY
      // ("taking longer than expected"); it never ends the wait, so the spinner
      // still ran forever. The deadline is what ends it; the timer is kept as the
      // in-between affordance it always was. One-shot/manual → the defaults.
      const r = await fetchBounded('/api/sessions');
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

  // Close = delete: removing an observer tab (× or idle-timeout) must also remove
  // the session from disk via the existing DELETE /api/sessions/:id endpoint —
  // otherwise the {id}.json/{id}.md transcripts linger forever, with no UI to see
  // or remove them. Fire-and-forget so the UI closes instantly; the local-state
  // removal is already correct and there is no server list to re-fetch, so we
  // only need the files gone (unlike CollectionsSection, which re-lists on delete).
  // Toast on failure only when error notifications are on (mirrors refresh/createNew).
  // Both close paths — closeTab below and the idle-close tick above — call this.
  const deleteSessionServer = useCallback((id: string) => {
    fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
      .then((r) => {
        if (!r.ok && prefsRef.current.notifyErrors) {
          toast.error(`Failed to delete session: HTTP ${r.status}`);
        }
      })
      .catch((err) => {
        if (prefsRef.current.notifyErrors) {
          toast.error(`Failed to delete session: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
      });
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
        if (!r.ok || !r.data) {
          // boot can't proceed without a session; surface the failure rather
          // than crash reading s.id off an undefined body
          console.error('boot session create failed:', r.error || `HTTP ${r.res?.status}`);
          return;
        }
        const s: SessionMeta = r.data;
        setSessions([s]); open = [s.id]; active = s.id;
      } else if (open.length === 0) {
        open = [list[0].id]; active = list[0].id;
      }
      setOpenIds(open);
      setActiveId(active);
      setBooted(true);
    })();
  }, [refresh]);

  // WARDEN-1397 (slice 10): the ObsUi SAVE BAG — the second namespace's twin of
  // useConfigPersistence's PersistedPrefSnapshot lock. `satisfies Required<ObsUi>`
  // turns a field added to ObsUi but missing from this bag into a missing-property
  // COMPILE error — the dropped-key failure class (WARDEN-442/468/500 for UiState)
  // cannot recur here: every ObsUi field except openIds/activeId is optional in
  // storage.ts, so a field dropped from the old hand-assembled payload literal was
  // type-valid and silently never persisted again, and a dep dropped from the old
  // 11-entry hand-list silently stopped the effect from firing. No key-list
  // constant is needed (unlike PersistedPrefSnapshot): ObsUi is ALL persisted —
  // OBS_PRESERVED_KEYS / OBS_RESET_KEYS already partition it exhaustively for the
  // reset axis — so the bag IS the payload, and enumerating its keys again would
  // only mint a third hand-list to keep in sync. Assembled in render scope (like
  // the snapshot in useConfigPersistence) so the effect body and its dep array
  // read the SAME object.
  const obsBag = {
    openIds, activeId, viewMode,
    activityFilters, directiveFilters, attentionFilters,
  } satisfies Required<ObsUi>;
  useEffect(() => {
    if (booted) saveObs(obsBag);
    // The dependency is every VALUE of obsBag — derived from the same compile-
    // locked object as the payload, not a second hand-list — plus booted (the
    // write gate). Object.values yields a per-key Object.is comparison, so the
    // effect re-fires only when a persisted field actually changes. Firing-set
    // equivalence with the prior 11-scalar hand-list, field by field: openIds/
    // activeId/viewMode compare exactly as before; each of the seven filter
    // scalars lives in exactly one of the three filter objects and is written
    // ONLY through a spread-updater (or the reset's whole-object snap), so a
    // scalar changed ⇔ its parent object was replaced ⇔ its Object.values slot
    // changed — identical firing set (11 scalar deps → 6 bag values + booted).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- non-literal by design: the dep set is every value of the ObsUi save bag (one per ObsUi key), derived from the same type-checked source as the payload. Completeness is compile-enforced (a field in ObsUi but missing from obsBag is a TS error), not literal-enumerable — so a forgotten field can no longer silently drop out of the dep array (the WARDEN-442/468/500 class, ObsUi twin).
  }, [booted, ...Object.values(obsBag)]);

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

  // WARDEN-332 — Behavior 1: auto-start an observer session for the focused chat.
  // When observerAutoStart is on and a chat becomes focused, spawn+open a bound
  // observer session with no manual "observe" click. Guards, in order:
  //  - booted (sessions loaded so dedup is meaningful);
  //  - observerAutoStart (off ⇒ today's fully-manual behavior, unchanged);
  //  - a focused chat with a usable key;
  //  - autoStartedRef: each chatKey is attempted AT MOST ONCE per mount, so this
  //    never re-fires on re-renders or when the pref is toggled back on;
  //  - hasBoundSession: skip (still mark attempted) if a session is already bound
  //    to this chatKey — covers a manual binding made before auto-start.
  // The effect keys on `focusedKey` identity (not the chat object, which is
  // recreated on every poll) so it only fires when the focused chat actually
  // changes; observerAutoStart is a dep so flipping it on while a chat is focused
  // spawns for it. focusedChat is read through a ref to avoid stale closures.
  const autoStartedRef = useRef<Set<string>>(new Set());
  const focusedChatRef = useRef(focusedChat);
  useEffect(() => { focusedChatRef.current = focusedChat; }, [focusedChat]);
  const focusedKey = focusedChat?.key || focusedChat?.id || null;
  useEffect(() => {
    if (!booted || !observerAutoStart || !focusedKey) return;
    if (autoStartedRef.current.has(focusedKey)) return;
    autoStartedRef.current.add(focusedKey);
    if (hasBoundSession(sessionsRef.current, focusedKey)) return;
    void createNew(focusedChatRef.current);
  }, [booted, observerAutoStart, focusedKey, createNew]);

  // WARDEN-332 — Behavior 2a: seed every open tab with a last-activity timestamp
  // so the idle selector always has a signal. A tab with no timestamp is treated
  // as active and never reaped (fail-safe); newly-opened and boot-restored tabs
  // both get "now" (a fresh lease on restore, rather than reaping stale tabs the
  // instant warden reopens). The ref is mutated in place — no re-render needed.
  useEffect(() => {
    const now = Date.now();
    for (const id of openIds) {
      if (lastActivityRef.current[id] == null) lastActivityRef.current[id] = now;
    }
  }, [openIds]);

  // WARDEN-332 — Behavior 2b: periodic idle-close tick. Every IDLE_TICK_MS (~60s),
  // close any open tab whose last activity exceeds observerSessionTimeout minutes.
  // selectIdleTabs returns [] for null/<=0 timeout, so a disabled pref makes this
  // a no-op. The latest timeout/openIds/activity are read through refs so the
  // interval is scheduled once and is not torn down on every state/pref change.
  // Closes are batched inline rather than calling closeTab(id) in a loop: closeTab
  // assumes single-id semantics and would mis-pick the next active tab when
  // several ids go idle in the same tick (its activeId repair reads a stale
  // openIds snapshot across batched calls).
  useEffect(() => {
    if (!booted) return;
    const tick = () => {
      const idle = selectIdleTabs(openIdsRef.current, lastActivityRef.current, sessionTimeoutRef.current, Date.now());
      if (idle.length === 0) return;
      const idleSet = new Set(idle);
      // Fire the server-side delete for each idle id (close=delete). The tick still
      // does its OWN batched openIds/activeId repair inline per the comment above —
      // this just additionally removes the transcripts from disk so they don't leak.
      idle.forEach((id) => deleteSessionServer(id));
      setOpenIds((p) => p.filter((x) => !idleSet.has(x)));
      setActiveId((a) => (a && idleSet.has(a) ? (openIdsRef.current.find((x) => !idleSet.has(x)) || null) : a));
    };
    const handle = setInterval(tick, IDLE_TICK_MS);
    return () => clearInterval(handle);
  }, [booted, deleteSessionServer]);

  const closeTab = (id: string) => {
    deleteSessionServer(id);
    setOpenIds((p) => p.filter((x) => x !== id));
    setActiveId((a) => (a === id ? (openIds.find((x) => x !== id) || null) : a));
  };
  const nameOf = (id: string) => sessions.find((s) => s.id === id)?.name || id.slice(0, 6);
  const hostLabel = (id: string) => {
    const session = sessions.find((s) => s.id === id);
    if (!session?.host) return '';
    // WARDEN-490: a labeled host shows its friendly name; an unlabeled host keeps
    // the exact raw string (including '@(local)') — byte-identical to today.
    const label = hostLabelFor(session.host, hostLabels);
    return label ? `@${label}` : `@${session.host}`;
  };

  // WARDEN-1327 — the composed `container (project) @ host` string the tab's
  // title tooltip builds. Composed ONCE here and consumed by BOTH the tooltip
  // and the menu's "Copy agent@host" item so the two can never drift (the
  // identical hover-only-and-therefore-uncopyable pain WARDEN-517 closed for
  // DirectiveHistory).
  const descriptor = (id: string) => {
    const session = sessions.find((s) => s.id === id);
    if (!session) return '';
    return `${session.container || 'Unknown'}${session.project ? ` (${session.project})` : ''} @ ${hostLabelFor(session.host ?? '', hostLabels) || session.host || 'local'}`;
  };

  // Inline rename (mirrors WorkspaceTabs.tsx:53-60). The draft seeds from the
  // RAW stored name — not nameOf's 6-hex fallback — so a rename always starts
  // from what the server actually has.
  const startRename = (id: string) => {
    setEditingId(id);
    setDraft(sessions.find((s) => s.id === id)?.name || '');
  };
  const cancelRename = () => setEditingId(null);
  const commitRename = () => {
    const id = editingId;
    setEditingId(null);
    if (id === null) return;
    // An empty/whitespace-only draft is a CANCEL, never a commit: the PATCH
    // endpoint does no validation (server.js:901 passes the string straight to
    // renameSession, which writes it verbatim), so committing empty would
    // destroy the stored name on disk and nameOf would silently fall back to
    // the 6-hex id.
    if (draft.trim() === '') return;
    void renameSessionRemote(id, draft);
  };

  // PATCH /api/sessions/:id — the backend-complete, fully unit-tested endpoint
  // no UI has ever called before this menu. Deliberately a plain fetch (there
  // is no patchJson in lib/api.ts and adding one is out of scope), in the
  // shape of CollectionsSection's collection rename. NON-optimistic: local
  // state only moves on the server-confirmed body, so a rejected rename leaves
  // the previous name in place and the error toast is the only feedback.
  const renameSessionRemote = async (id: string, name: string) => {
    if (name === sessions.find((s) => s.id === id)?.name) return; // unchanged — skip the pointless disk rewrite
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const s: SessionMeta = await r.json();
      setSessions((p) => p.map((x) => (x.id === id ? { ...x, name: s.name } : x)));
    } catch (err) {
      toast.error(`Failed to rename session: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  // Focus the rename input when it appears (controlled via ref, not a DOM
  // query — WARDEN-68 Rule 4) and select-all so a fresh name is one keystroke
  // away. Mirrors WorkspaceTabs.tsx:46-51.
  useEffect(() => {
    if (editingId) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editingId]);

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
          <button
            onClick={() => setViewMode('directives')}
            className={`px-2.5 py-1 rounded-md text-xs whitespace-nowrap shrink-0 transition-all duration-150 ease-out active:scale-95 ${viewMode === 'directives' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50'}`}
          >
            Directives
          </button>
          {attention && (
            <button
              onClick={() => setViewMode('attention')}
              className={`px-2.5 py-1 rounded-md text-xs whitespace-nowrap shrink-0 transition-all duration-150 ease-out active:scale-95 ${viewMode === 'attention' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50'}`}
            >
              Attention
            </button>
          )}
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
              const hostLbl = hostLabel(id);
              const editing = editingId === id;
              return (
                // The React key MUST sit on the outermost rendered element. The
                // ContextMenu root renders no DOM, so a key left on the inner
                // <button> is lost across renders (WARDEN-926 Principle 3; the
                // WorkspaceTabs.tsx:102 precedent).
                <ContextMenu key={id}>
                  <ContextMenuTrigger asChild disabled={editing}>
                    {/*
                      Stable shell carries the trigger; the interactive children
                      live INSIDE it. While renaming, the shell holds the <Input>
                      and `disabled={editing}` lets a right-click inside the input
                      fall through to the NATIVE text-edit menu instead of this
                      themed one (radix honors disabled on the trigger without
                      disabling pointer events). No stopPropagation/preventDefault
                      anywhere on the trigger — per WARDEN-926 that would kill the
                      menu entirely; radix's innermost-trigger-wins needs no guard,
                      and the × span is not a trigger.
                    */}
                    <span className="inline-flex items-center shrink-0 whitespace-nowrap">
                      {editing ? (
                        <Input
                          ref={inputRef}
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onBlur={commitRename}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                            else if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
                          }}
                          className="h-6 w-28 text-xs px-1.5"
                          aria-label="Session name"
                        />
                      ) : (
                        <button
                          onClick={() => setActiveId(id)}
                          className={`px-2.5 py-1 rounded-md text-xs whitespace-nowrap shrink-0 transition-all duration-150 ease-out active:scale-95 ${activeId === id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50'}`}
                          title={descriptor(id)}
                        >
                          {nameOf(id)}{hostLbl && <span className="ml-1 opacity-70">{hostLbl}</span>}
                          <span
                            className="ml-1.5 opacity-50 hover:opacity-100"
                            onClick={(e) => { e.stopPropagation(); closeTab(id); }}
                          >×</span>
                        </button>
                      )}
                    </span>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    {/* Surfaces rename for the first time: PATCH /api/sessions/:id
                        was backend-complete and unit-tested but never wired to any UI. */}
                    <ContextMenuItem onSelect={() => startRename(id)}>Rename</ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem onSelect={() => void copyWithToast(nameOf(id))}>Copy session name</ContextMenuItem>
                    {/* The full id is visible nowhere else in the UI (only as a 6-char
                        truncation when unnamed), yet it addresses {id}.json/{id}.md
                        on disk and every /api/sessions/:id call. */}
                    <ContextMenuItem onSelect={() => void copyWithToast(id)}>Copy session id</ContextMenuItem>
                    <ContextMenuItem onSelect={() => void copyWithToast(descriptor(id))}>Copy agent@host</ContextMenuItem>
                    <ContextMenuSeparator />
                    {/* Close = DELETE (WARDEN-792): this item only raises the
                        destructive ConfirmDialog; closeTab fires on confirm. The ×
                        keeps its instant behavior — the asymmetry is deliberate. */}
                    <ContextMenuItem variant="destructive" onSelect={() => setPendingCloseId(id)}>Close</ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              );
            })}
          </div>
          <div className="flex-1 min-h-0">
            {openIds.map((id) => (
              <div key={id} className={activeId === id ? 'h-full' : 'hidden'}>
                <ObserverPanel sessionId={id} onActivity={() => bumpActivity(id)} issueEntries={issueEntries} />
              </div>
            ))}
          </div>
        </>
      )}

      {/* Activity view */}
      {viewMode === 'activity' && (
        <div className="flex-1 min-h-0">
          <ActivityTimeline
            typeFilter={activityFilters.type} setTypeFilter={setActTypeFilter}
            agentFilter={activityFilters.agent} setAgentFilter={setActAgentFilter}
            hostFilter={activityFilters.host} setHostFilter={setActHostFilter}
          />
        </div>
      )}

      {/* Directives view — read-only history of every directive that reached an agent */}
      {viewMode === 'directives' && (
        <div className="flex-1 min-h-0">
          <DirectiveHistory
            agentFilter={directiveFilters.agent} setAgentFilter={setDirAgentFilter}
            hostFilter={directiveFilters.host} setHostFilter={setDirHostFilter}
            issueEntries={issueEntries}
          />
        </div>
      )}

      {/* Attention view (WARDEN-880) — the PERSISTENT ranked "where am I needed, because
          X" rundown, a peer to Activity/Directives. Unlike the header badge's transient
          popover (which dismisses on every pane switch), this stays mounted while the
          human opens/switches agent panes — the core Job #2 triage workflow. Consumes
          App's lifted attentionRollup via the shared AttentionList, so it is bit-for-bit
          identical to the badge. WARDEN-971: plus the host/agent filters its Activity and
          Directives peers already had — owned here and persisted, so a reload reopens the
          triage list scoped exactly as the human left it. */}
      {viewMode === 'attention' && attention && (
        <div className="flex-1 min-h-0">
          <AttentionView
            {...attention}
            agentFilter={attentionFilters.agent} setAgentFilter={setAttnAgentFilter}
            hostFilter={attentionFilters.host} setHostFilter={setAttnHostFilter}
          />
        </div>
      )}

      {/* WARDEN-1327 — the destructive half of the tab menu's Close. Close =
          delete (WARDEN-792): closeTab removes the session AND its
          {id}.json/{id}.md transcripts from disk, so the menu item must not act
          as a plain reversible "close". Mirrors the CollectionsSection
          delete-card dialog: Cancel/Escape/overlay-click dismiss untouched;
          only the destructive confirm destroys. Renders once at the root,
          driven by pendingCloseId. */}
      <ConfirmDialog
        open={pendingCloseId !== null}
        onOpenChange={(o) => { if (!o) setPendingCloseId(null); }}
        title={pendingCloseId ? `Delete observer session "${nameOf(pendingCloseId)}"?` : ''}
        description="Closing an observer tab deletes the session and its saved transcript from disk. This cannot be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={() => { if (pendingCloseId) closeTab(pendingCloseId); setPendingCloseId(null); }}
      />
    </div>
  );
}
