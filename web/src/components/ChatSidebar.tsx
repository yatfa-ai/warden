// ChatSidebar — rebuilt around its four jobs (WARDEN-1422, "Ink · Saved"):
//
//   A) START a session — the spawn control: a plain shell (host ▾ + directory +
//      optional name + Start shell). SpawnControl owns it.
//   B) CONNECT to an agent — HOSTS are the primary navigation (top of root,
//      green accent, live counts). HostsSection owns it.
//   C) CONTINUE a session — the temporary/persistent lifecycle. A host view
//      lists ONLY that host's saved sessions, split working / stopped; the
//      recently-closed flyout is the only route back to a closed temp.
//   D) SEE git status — the Source Control panel, unchanged behavior, at the
//      bottom of root, collapsed by default.
//
// Superseded model (withdrawn by the owner): the sidebar is no longer an
// inventory of every capability. The open-panes list, the claude-history
// resume list, the "needs you" row indicators, token counts, the fleet
// filter/sort controls, and the Open-chat browser page are gone — unsaved
// sessions are never listed, and the sidebar's session list is short by
// construction because only named-and-saved sessions appear in it.

import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { Bookmark, History } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { CollectionsSection } from './CollectionsSection';
import { CreateCollectionDialog } from './CreateCollectionDialog';
import { DiffViewer } from './DiffViewer';
import { ConflictView } from './ConflictView';
import { FileViewer } from './FileViewer';
import { useNotificationPrefs } from '@/lib/useNotificationPrefs';
import type { RecentlyClosedEntry } from '@/lib/storage';
import { THIS_MACHINE, hostLabelFor } from '@/lib/chatDisplay';
import { useHostLabels } from '@/lib/uiStore';
import { chatMatchesCriteria } from '@/lib/collections';
import { WHATS_NEW_FETCH_LIMIT } from '@/lib/whatsNew';
import type { Chat, Collection } from '@/lib/types';
import type { GitCommit } from './sidebar/types';
import { SourceControlPanel } from './sidebar/SourceControlPanel';
import type { SourceControlGitInfo } from './sidebar/SourceControlPanel';
import { useGitStatus, useInvalidateGitStatus } from '@/lib/gitStatusHooks';
import { fetchBounded, readListBody, readListResponse } from '@/lib/api';
import { SpawnControl } from './sidebar/SpawnControl';
import { HostsSection } from './sidebar/HostsSection';
import { RecentlyClosedFlyout } from './sidebar/RecentlyClosedFlyout';
import { SavedSessionRow, SavedRowSkeleton, splitSaved, byRecencyDesc } from './sidebar/SavedSessionRows';

// Query-string builders (module-level so the fetchers' useCallback deps stay stable).
// incoming/outgoing ignore the limit arg — their limit is hardcoded at 50.
const buildGitLogParams = (limit: number) => `limit=${limit}`;
const buildIncomingParams = () => `limit=50&range=incoming`;
const buildOutgoingParams = () => `limit=50&range=outgoing`;

// Shared skeleton for fetchGitLog / fetchGitLogIncoming / fetchGitLogOutgoing: GET
// /api/git-log?id=…&<buildParams(limit)>, cache commits per chatId (re-expand is
// instant), toggle a per-chatId loading flag, and cache [] on failure so a re-expand
// won't loop (WARDEN-620). The response READING step is the shared
// `readListResponse` from lib/api.ts, so BOTH halves of the backend's error
// convention are honoured (WARDEN-1014). Carried over verbatim from the
// pre-rebuild sidebar — git behavior is unchanged in this redesign.
function useGitLogFetcher({ setCommits, setError, setLoading, errorLabel, label, buildParams }: {
  setCommits: (updater: (prev: Record<string, GitCommit[]>) => Record<string, GitCommit[]>) => void;
  setError: (updater: (prev: Record<string, string | null>) => Record<string, string | null>) => void;
  setLoading: (updater: (prev: Record<string, boolean>) => Record<string, boolean>) => void;
  errorLabel: string;
  /** Human-readable noun for the failure copy ('commits', 'incoming commits', …). */
  label: string;
  buildParams: (limit: number) => string;
}) {
  return useCallback(async (chatId: string, limit: number = WHATS_NEW_FETCH_LIMIT) => {
    setLoading((p) => ({ ...p, [chatId]: true }));
    setError((p) => ({ ...p, [chatId]: null }));
    try {
      // WARDEN-1144: bounded on the shared deadline. One-shot shape (fires on
      // expand, nothing ticks), so the primitive's defaults apply.
      const r = await fetchBounded(`/api/git-log?id=${encodeURIComponent(chatId)}&${buildParams(limit)}`);
      // Tolerant on !ok, STRICT on 2xx (WARDEN-1014 review).
      const j = await readListBody(r);
      const { items, error } = readListResponse<GitCommit>(r, j, 'commits', label);
      setCommits((p) => ({ ...p, [chatId]: items }));
      setError((p) => ({ ...p, [chatId]: error }));
    } catch (error) {
      // Cache an empty list so a transient failure doesn't loop on re-expand — but
      // record WHY, so the section renders a failure rather than a false empty.
      console.error(errorLabel, error);
      setCommits((p) => ({ ...p, [chatId]: [] }));
      setError((p) => ({ ...p, [chatId]: error instanceof Error ? error.message : `Failed to load ${label}` }));
    } finally {
      setLoading((p) => ({ ...p, [chatId]: false }));
    }
  }, [setCommits, setError, setLoading, errorLabel, label, buildParams]);
}

export interface ChatSidebarProps {
  /** SAVED sessions only (yatfa agents + catalog chats) — temporaries never ride this list. */
  chats: Chat[];
  /** Running UNSAVED shells per discovered host — the footer-line / empty-state count. Never rendered as rows. */
  tempChats: Chat[];
  /** Full host list: [THIS_MACHINE, ...sshHosts]. */
  hosts: string[];
  /** The active workspace's just-closed pane snapshots (accident-insurance flyout). */
  recentlyClosed: RecentlyClosedEntry[];
  /** The focused pane id — the Source Control panel re-points to this pane's repo. */
  focused?: string | null;
  onOpenChat: (id: string) => void;
  /** Start a shell: (host, cwd, name?) — name absent = temporary (never listed). */
  onSpawnShell: (host: string, cwd: string, name?: string) => Promise<boolean>;
  /** Promote a closed temporary session into its host's saved list. */
  onSaveSession: (id: string) => void;
  /** Reopen a closed temp as a pane — it stays temporary. */
  onReopenClosed: (id: string) => void;
  /** Recreate a stopped saved session: a fresh process, same name + directory. */
  onRespawn: (id: string) => void;
  /** Delete a saved session (kill + forget; confirm-gated in App). */
  onKill: (id: string) => void;
  onRename: (session: string, kind: string, name: string, host?: string) => void;
  onRefresh: () => void;
  onDiscoverHost: (host: string) => void;
  loading: boolean;
  /** Host connectivity (the shared /api/hosts/status poll): offline hosts are unknown, not empty. */
  hostStatuses: Record<string, { status: 'online' | 'offline' | 'unknown'; latency_ms: number | null }>;
  /** Per-host discovery failure reason (the unreachable state's "⟨reason⟩"). */
  discoverErrors: Record<string, string>;
  /** ids just saved from the closed-temp flyout — the one-shot "saved" pill. */
  recentlySavedIds: Set<string>;
  sourceControlCollapsed?: boolean;
  onSourceControlCollapsedChange?: (collapsed: boolean) => void;
  /** Forward poll cadence to the FileViewer (unchanged from the pre-rebuild sidebar). */
  pollIntervalMs: number;
}

type SidebarView = { kind: 'root' } | { kind: 'host'; host: string } | { kind: 'collection'; collection: Collection };

export function ChatSidebar({
  chats, tempChats, hosts, recentlyClosed, focused, onOpenChat, onSpawnShell, onSaveSession,
  onReopenClosed, onRespawn, onKill, onRename, onRefresh, onDiscoverHost, loading,
  hostStatuses, discoverErrors, recentlySavedIds, sourceControlCollapsed, onSourceControlCollapsedChange, pollIntervalMs,
}: ChatSidebarProps) {
  const [view, setView] = useState<SidebarView>({ kind: 'root' });
  const [flyoutOpen, setFlyoutOpen] = useState(false);
  // ONE live search per the design: the header field IS the filter, on every
  // view (root = cross-host saved search; host/collection = scoped to the view).
  // No second box anywhere.
  const [searchQuery, setSearchQuery] = useState('');
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [collections, setCollections] = useState<Collection[]>([]);
  // The host whose discover is in flight after entering it — gates the
  // loading skeletons in the host view.
  const [enteringHost, setEnteringHost] = useState<string | null>(null);
  const hostLabels = useHostLabels();
  const { prefs } = useNotificationPrefs();

  // Per-agent notes (WARDEN-305): keyed by chat id; load on mount, write per-key.
  const [agentNotes, setAgentNotes] = useState<Record<string, string>>({});
  useEffect(() => {
    const fetchNotes = async () => {
      try {
        const r = await fetch('/api/agent-notes');
        const j = await r.json();
        setAgentNotes(j.notes || {});
      } catch (error) {
        console.error('[agent-notes] Failed:', error);
      }
    };
    void fetchNotes();
  }, []);
  const setNote = useCallback(async (chatId: string, text: string) => {
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
  }, []);

  // ---- git plumbing — behavior UNCHANGED by the redesign; the Source Control
  // panel still describes only the focused pane's repo, at the bottom of root. ----
  const [gitLog, setGitLog] = useState<Record<string, GitCommit[]>>({});
  const [gitLogLoading, setGitLogLoading] = useState<Record<string, boolean>>({});
  const [gitLogError, setGitLogError] = useState<Record<string, string | null>>({});
  const [gitLogIncoming, setGitLogIncoming] = useState<Record<string, GitCommit[]>>({});
  const [gitLogIncomingLoading, setGitLogIncomingLoading] = useState<Record<string, boolean>>({});
  const [gitLogIncomingError, setGitLogIncomingError] = useState<Record<string, string | null>>({});
  const [gitLogOutgoing, setGitLogOutgoing] = useState<Record<string, GitCommit[]>>({});
  const [gitLogOutgoingLoading, setGitLogOutgoingLoading] = useState<Record<string, boolean>>({});
  const [gitLogOutgoingError, setGitLogOutgoingError] = useState<Record<string, string | null>>({});
  const [diffTarget, setDiffTarget] = useState<{ chatId: string; path: string; staged?: boolean } | null>(null);
  const [conflictTarget, setConflictTarget] = useState<{ chatId: string; path: string } | null>(null);
  const [fileTarget, setFileTarget] = useState<{ chatId: string; path: string; line?: number } | null>(null);

  const gitStatusQuery = useGitStatus(focused);
  const invalidateGitStatus = useInvalidateGitStatus();
  useEffect(() => {
    if (gitStatusQuery.error) console.error('[git-status] Failed:', gitStatusQuery.error);
  }, [gitStatusQuery.error]);

  const fetchGitLog = useGitLogFetcher({ setCommits: setGitLog, setError: setGitLogError, setLoading: setGitLogLoading, errorLabel: 'Failed to fetch git log:', label: 'commits', buildParams: buildGitLogParams });
  const fetchGitLogIncoming = useGitLogFetcher({ setCommits: setGitLogIncoming, setError: setGitLogIncomingError, setLoading: setGitLogIncomingLoading, errorLabel: 'Failed to fetch incoming git log:', label: 'incoming commits', buildParams: buildIncomingParams });
  const fetchGitLogOutgoing = useGitLogFetcher({ setCommits: setGitLogOutgoing, setError: setGitLogOutgoingError, setLoading: setGitLogOutgoingLoading, errorLabel: 'Failed to fetch outgoing git log:', label: 'outgoing commits', buildParams: buildOutgoingParams });

  // Git status stays live while a pane stays focused: invalidate on catalog refresh.
  useEffect(() => {
    if (focused) invalidateGitStatus(focused);
  }, [focused, chats, invalidateGitStatus]);

  // ---- collections ----
  const fetchCollections = useCallback(async (): Promise<Collection[]> => {
    try {
      // WARDEN-1144: bounded. Awaited by CollectionsSection's refresh; its result
      // gates the collection view's contents.
      const r = await fetchBounded('/api/collections');
      const j = await r.json();
      const list = j.collections || [];
      setCollections(list);
      return list;
    } catch (error) {
      console.error('[collections] Failed:', error);
      if (prefs.notifyErrors) toast.error(`Failed to fetch collections: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return [];
    }
  }, [prefs.notifyErrors]);

  const enterCollection = (collection: Collection) => { setView({ kind: 'collection', collection }); setSearchQuery(''); };

  const handleCreateCollection = () => { setCreateDialogOpen(true); void fetchCollections(); };

  const handleCollectionCreated = (collection: Collection) => {
    void fetchCollections();
    enterCollection(collection);
  };

  // WARDEN-396/553 (carried over): sync derived collection state when a card
  // mutates from CollectionsSection's own menu; refresh the open view's
  // snapshot when the edited collection is the one open.
  const handleCollectionChange = useCallback(async (change: { type: 'rename' | 'delete' | 'edit'; id: string }) => {
    if (change.type === 'delete' && view.kind === 'collection' && view.collection.id === change.id) {
      setView({ kind: 'root' });
    }
    const fresh = await fetchCollections();
    if (change.type === 'edit' && view.kind === 'collection' && view.collection.id === change.id) {
      const updated = fresh.find((c) => c.id === change.id);
      setView(updated ? { kind: 'collection', collection: updated } : { kind: 'root' });
    }
  }, [view, fetchCollections]);

  useEffect(() => {
    void fetchCollections();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- navigation ----
  const enterHost = (host: string) => {
    setView({ kind: 'host', host });
    setSearchQuery('');
    // Opening a host is a visit: refresh its live working/stopped split.
    setEnteringHost(host);
    void Promise.resolve(onDiscoverHost(host)).catch(() => {}).finally(() => {
      setEnteringHost((h) => (h === host ? null : h));
    });
  };
  const goBack = () => { setView({ kind: 'root' }); setSearchQuery(''); };

  // ---- derived data ----
  // The recently-closed flyout lists CLOSED TEMPORARY sessions: a pane whose
  // saved session still exists has nothing a reopen could lose and nothing a
  // save could promote, so it never appears here (its row still lives in the
  // host view).
  const savedIdSet = new Set(chats.map((c) => c.key || c.id));
  const closedTemps = recentlyClosed.filter((e) => !savedIdSet.has(e.id));

  // The saved sessions a view lists, filtered by the ONE live search: name,
  // session id, cwd and host all match (the auto-generated names are gone, so
  // a directory fragment is a legitimate way to find a session).
  const matchesQuery = useCallback((c: Chat, q: string) => {
    const query = q.trim().toLowerCase();
    if (!query) return true;
    return (
      (c.name || '').toLowerCase().includes(query) ||
      (c.key || '').toLowerCase().includes(query) ||
      (c.session || '').toLowerCase().includes(query) ||
      (c.cwd || '').toLowerCase().includes(query) ||
      (c.host || '').toLowerCase().includes(query)
    );
  }, []);

  const hostLabel = (h: string) => hostLabelFor(h, hostLabels) || (h === THIS_MACHINE ? 'this machine' : h);

  // Shared row binder: one place wires a Chat to the row's actions so the
  // host / collection / search lists cannot drift.
  const bindRow = (c: Chat) => ({
    chat: c,
    focused: (c.key || c.id) === focused,
    justSaved: recentlySavedIds.has(c.key || c.id),
    note: agentNotes[c.id],
    onOpen: () => onOpenChat(c.key || c.id),
    onDelete: () => onKill(c.key || c.id),
    onRename: (name: string) => onRename(c.key || c.id, c.kind || 'tmux', name, c.host),
    onSetNote: (text: string) => { void setNote(c.id, text); },
    // Only warden-owned chats respawn (kind 'tmux'); an EMPTY cmd is still a
    // real command — the host's own login shell (WARDEN-223).
    onRespawn: c.kind === 'tmux' && c.cmd != null ? () => onRespawn(c.key || c.id) : undefined,
  });

  const renderRows = (list: Chat[], opts: { showHost?: boolean; query?: string } = {}) => (
    <>
      {list.map((c) => (
        <SavedSessionRow
          key={c.id}
          {...bindRow(c)}
          showHost={opts.showHost}
          hostLabel={opts.showHost ? hostLabel(c.host) : undefined}
          query={opts.query}
        />
      ))}
    </>
  );

  const renderNoMatch = (q: string, onClear: () => void) => (
    <div className="mx-2 my-2 wrap-anywhere rounded-lg border border-dashed border-border px-2.5 py-2 text-[11px] leading-snug text-muted-foreground" data-testid="no-match">
      No saved session matches &quot;{q}&quot; —{' '}
      <button className="text-foreground underline hover:bg-accent" onClick={onClear}>clear the search</button>.
      {' '}Running shells are not searched: they are not saved.
    </div>
  );

  const renderSearchCount = (matched: number, total: number, q: string) => (
    <div className="flex-none border-b border-border/50 px-2.5 py-1 text-[10px] text-muted-foreground" data-testid="search-count">
      {matched} of {total} saved sessions match &quot;{q}&quot;
    </div>
  );

  const renderSubnote = (children: React.ReactNode) => (
    <div className="wrap-anywhere px-2.5 pb-1 text-[10px] leading-snug text-muted-foreground">{children}</div>
  );

  // ---- view bodies ----

  const renderHostView = (H: string) => {
    const hostChats = chats.filter((c) => c.host === H);
    const offline = hostStatuses[H]?.status === 'offline';
    const unreachable = offline || !!discoverErrors[H];
    const discovering = enteringHost === H || (hostChats.length > 0 && hostChats.every((c) => c.active == null));
    // WARDEN-1422 round-2 review: only a temp the probe POSITIVELY answered
    // stopped (`active === false`) may not claim to be "running" in copy. An
    // unknown row (`active == null`, an unanswered probe) still counts — the
    // server GCs positively-stopped temps, this is the client-side race guard
    // for a poll that raced a death.
    const tempCount = tempChats.filter((c) => c.host === H && c.active !== false).length;
    const q = searchQuery.trim();
    const { working, stopped } = splitSaved(hostChats.filter((c) => matchesQuery(c, q)));
    const workingSorted = [...working].sort((a, b) => {
      // A just-saved session leads the working list (the one-shot "saved" pill
      // marks it), then most-recently-active first.
      const aj = recentlySavedIds.has(a.key || a.id) ? 1 : 0;
      const bj = recentlySavedIds.has(b.key || b.id) ? 1 : 0;
      if (aj !== bj) return bj - aj;
      return byRecencyDesc(a, b);
    });
    const stoppedSorted = [...stopped].sort(byRecencyDesc);

    return (
      <>
        {q && renderSearchCount(working.length + stopped.length, hostChats.length, q)}
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-0.5 pb-2">
            {unreachable ? (
              // UNKNOWN, NOT EMPTY: a host we cannot reach has no readable saved
              // list — showing nothing would claim its sessions are absent.
              <div className="mx-2 my-2 wrap-anywhere rounded-lg border border-red-500/40 bg-red-500/10 px-2.5 py-2 text-[11px] leading-snug text-red-400" data-testid="host-unreachable">
                Could not reach {hostLabel(H)} — {discoverErrors[H] || 'the host is not responding'}. Its saved sessions are unknown, not absent.{' '}
                <button className="underline hover:text-foreground" onClick={() => onDiscoverHost(H)}>retry</button>
              </div>
            ) : discovering ? (
              <>
                {renderSubnote('Loading saved sessions…')}
                {[1, 2, 3, 4].map((i) => <SavedRowSkeleton key={i} />)}
              </>
            ) : hostChats.length === 0 && !q ? (
              // EMPTY answers the question it will actually be asked: where did
              // my shells go? They are running, unnamed, as panes.
              <div className="flex flex-col items-center gap-1.5 px-4 py-8 text-center text-muted-foreground" data-testid="host-empty">
                <Bookmark aria-hidden="true" className="size-4.5" />
                <span className="text-xs text-foreground">Nothing saved on {hostLabel(H)}</span>
                <span className="wrap-anywhere text-[11px] leading-snug">
                  {tempCount === 1
                    ? '1 shell is running here as a pane. Name it and it will be listed here.'
                    : `${tempCount} shells are running here as panes. Name one and it will be listed here.`}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-1 h-6 gap-1 text-[10.5px]"
                  onClick={() => void onSpawnShell(H, '')}
                >
                  + Start a shell
                </Button>
              </div>
            ) : (
              <>
                {workingSorted.length > 0 && (
                  <>
                    <div className="flex items-baseline gap-1.5 px-2.5 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-green-500">
                      working<span className="ml-auto font-normal normal-case tracking-normal text-muted-foreground">{workingSorted.length}</span>
                    </div>
                    {renderSubnote('Click to reconnect to the running session.')}
                    {renderRows(workingSorted, { query: q })}
                  </>
                )}
                {stoppedSorted.length > 0 && (
                  <>
                    <div className="mx-2 mt-2.5 border-t border-border/50" />
                    <div className="flex items-baseline gap-1.5 px-2.5 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      stopped<span className="ml-auto font-normal normal-case tracking-normal text-muted-foreground">{stoppedSorted.length}</span>
                    </div>
                    {renderSubnote(<>Respawn starts a <strong className="font-semibold text-foreground">fresh</strong> process under the same name in the same directory — the stopped one cannot be resurrected.</>)}
                    {renderRows(stoppedSorted, { query: q })}
                  </>
                )}
                {/* The unsaved shells are accounted for here — the ONE place the
                    "where are my shells?" question has an answer. */}
                {tempCount > 0 && (
                  <>
                    <div className="mx-2 mt-2.5 border-t border-border/50" />
                    {renderSubnote(
                      tempCount === 1
                        ? '1 shell is running on this host as a pane. It is not saved, so it is not listed — name it to keep it.'
                        : `${tempCount} shells are running on this host as panes. They are not saved, so they are not listed — name one to keep it.`,
                    )}
                  </>
                )}
              </>
            )}
            {q && workingSorted.length + stoppedSorted.length === 0 && !unreachable && !discovering && renderNoMatch(q, () => setSearchQuery(''))}
          </div>
        </ScrollArea>
      </>
    );
  };

  const renderCollectionView = (C: Collection) => {
    let members = chats.filter((chat) => {
      if (!C.criteria) return true;
      return chatMatchesCriteria(chat, C.criteria);
    });
    const q = searchQuery.trim();
    members = members.filter((c) => matchesQuery(c, q));
    const { working, stopped } = splitSaved(members);
    const workingSorted = [...working].sort(byRecencyDesc);
    const stoppedSorted = [...stopped].sort(byRecencyDesc);

    return (
      <>
        {C.metadata?.description && !q && (
          <div className="wrap-anywhere flex-none px-2.5 pb-1 pt-2 text-[10px] leading-snug text-muted-foreground">{C.metadata.description}</div>
        )}
        {q && renderSearchCount(members.length, chats.filter((chat) => !C.criteria || chatMatchesCriteria(chat, C.criteria)).length, q)}
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-0.5 pb-2">
            {members.length === 0 ? (
              q ? renderNoMatch(q, () => setSearchQuery('')) : (
                <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">no saved sessions match this collection</div>
              )
            ) : (
              <>
                {workingSorted.length > 0 && (
                  <>
                    <div className="flex items-baseline gap-1.5 px-2.5 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-green-500">
                      working<span className="ml-auto font-normal normal-case tracking-normal text-muted-foreground">{workingSorted.length}</span>
                    </div>
                    {/* cross-host view: the host is the one extra piece of metadata */}
                    {renderRows(workingSorted, { showHost: true, query: q })}
                  </>
                )}
                {stoppedSorted.length > 0 && (
                  <>
                    <div className="mx-2 mt-2.5 border-t border-border/50" />
                    <div className="flex items-baseline gap-1.5 px-2.5 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      stopped<span className="ml-auto font-normal normal-case tracking-normal text-muted-foreground">{stoppedSorted.length}</span>
                    </div>
                    {renderRows(stoppedSorted, { showHost: true, query: q })}
                  </>
                )}
              </>
            )}
          </div>
        </ScrollArea>
      </>
    );
  };

  const renderRootView = () => {
    const q = searchQuery.trim();
    if (q) {
      // Cross-host saved search: the count line + grouped results (host in the
      // metadata), exactly one search field in the product.
      const matches = chats.filter((c) => matchesQuery(c, q));
      const { working, stopped } = splitSaved(matches);
      const workingSorted = [...working].sort(byRecencyDesc);
      const stoppedSorted = [...stopped].sort(byRecencyDesc);
      return (
        <>
          {renderSearchCount(matches.length, chats.length, q)}
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-0.5 pb-2">
              {matches.length === 0 ? (
                renderNoMatch(q, () => setSearchQuery(''))
              ) : (
                <>
                  {workingSorted.length > 0 && (
                    <>
                      <div className="flex items-baseline gap-1.5 px-2.5 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-green-500">
                        working<span className="ml-auto font-normal normal-case tracking-normal text-muted-foreground">{workingSorted.length}</span>
                      </div>
                      {renderRows(workingSorted, { showHost: true, query: q })}
                    </>
                  )}
                  {stoppedSorted.length > 0 && (
                    <>
                      <div className="mx-2 mt-2.5 border-t border-border/50" />
                      <div className="flex items-baseline gap-1.5 px-2.5 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        stopped<span className="ml-auto font-normal normal-case tracking-normal text-muted-foreground">{stoppedSorted.length}</span>
                      </div>
                      {renderRows(stoppedSorted, { showHost: true, query: q })}
                    </>
                  )}
                </>
              )}
            </div>
          </ScrollArea>
        </>
      );
    }
    return (
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col pb-2">
          {/* JOB B — hosts are the primary navigation */}
          <HostsSection
            hosts={hosts}
            chats={chats}
            tempChats={tempChats}
            hostStatuses={hostStatuses}
            onEnterHost={enterHost}
            onDiscoverHost={(h) => { void onDiscoverHost(h); }}
          />
          <div className="mx-2 mt-2.5 border-t border-border/50" />
          {/* collections demote to a muted secondary section beneath hosts */}
          <CollectionsSection
            chats={chats}
            onEnterCollection={enterCollection}
            onCreateCollection={handleCreateCollection}
            onCollectionChange={(c) => { void handleCollectionChange(c); }}
          />
          <div className="mx-2 mt-2.5 border-t border-border/50" />
          {/* JOB D — git status: an add-on at the bottom, collapsed by default */}
          <div className="mx-1.5 mt-1.5">
            <SourceControlPanel
              chatId={focused}
              gitInfo={(focused ? gitStatusQuery.data : undefined) as SourceControlGitInfo | undefined}
              onOpenDiff={(path, staged) => { if (focused) setDiffTarget({ chatId: focused, path, staged }); }}
              onOpenConflict={(path) => { if (focused) setConflictTarget({ chatId: focused, path }); }}
              onOpenFile={(path) => { if (focused) setFileTarget({ chatId: focused, path }); }}
              commits={focused ? gitLog[focused] : undefined}
              commitsLoading={focused ? gitLogLoading[focused] : undefined}
              commitsError={focused ? gitLogError[focused] : undefined}
              onFetchCommits={() => { if (focused) void fetchGitLog(focused); }}
              incomingCommits={focused ? gitLogIncoming[focused] : undefined}
              incomingLoading={focused ? gitLogIncomingLoading[focused] : undefined}
              incomingError={focused ? gitLogIncomingError[focused] : undefined}
              onFetchIncoming={() => { if (focused) void fetchGitLogIncoming(focused); }}
              outgoingCommits={focused ? gitLogOutgoing[focused] : undefined}
              outgoingLoading={focused ? gitLogOutgoingLoading[focused] : undefined}
              outgoingError={focused ? gitLogOutgoingError[focused] : undefined}
              onFetchOutgoing={() => { if (focused) void fetchGitLogOutgoing(focused); }}
              collapsed={!!sourceControlCollapsed}
              onCollapsedChange={onSourceControlCollapsedChange ?? (() => {})}
            />
          </div>
          <div className="h-2.5" />
        </div>
      </ScrollArea>
    );
  };

  const title = view.kind === 'host' ? hostLabel(view.host) : view.kind === 'collection' ? view.collection.name : '';
  const searchPlaceholder = view.kind === 'host' ? 'search this host…' : view.kind === 'collection' ? 'search this collection…' : 'search saved sessions…';

  return (
    <div className="@container relative flex h-full min-h-0 flex-col">
      {/* header — title (when not root) · THE search field · recently-closed · refresh.
          At the narrow tier the field wraps to its own full-width line instead of
          being squeezed out of existence (the exhibit's narrow header). */}
      <div className="flex flex-none flex-wrap items-center gap-[5px] border-b border-border/50 px-2 py-[7px]">
        {view.kind !== 'root' && (
          <IconTooltip label="back">
            <button
              className="rounded px-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              onClick={goBack}
              aria-label="back"
            >
              ‹
            </button>
          </IconTooltip>
        )}
        {title && <span className="max-w-[44%] flex-none wrap-anywhere text-[11.5px] text-foreground">{title}</span>}
        <Input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder.replace('…', '')}
          spellCheck={false}
          className="h-[22px] min-w-[7rem] flex-1 basis-[7rem] px-1.5 text-[10.5px] @max-[13rem]:order-last @max-[13rem]:basis-full"
        />
        <span className="ml-auto flex flex-none items-center gap-0.5 @max-[13rem]:order-2">
          <IconTooltip label={`recently closed — ${closedTemps.length} temporary session${closedTemps.length === 1 ? '' : 's'} you closed; they disappear on their own`}>
            <button
              className="relative inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              onClick={() => setFlyoutOpen(!flyoutOpen)}
              aria-label={`recently closed (${closedTemps.length})`}
              aria-expanded={flyoutOpen}
            >
              <History aria-hidden="true" className="size-3" />
              {closedTemps.length > 0 && <span className="text-[9.5px]">{closedTemps.length}</span>}
            </button>
          </IconTooltip>
          <IconTooltip label="refresh">
            <button
              className="rounded px-1 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
              onClick={onRefresh}
              disabled={loading}
              aria-label="refresh"
            >
              {loading ? '…' : '↻'}
            </button>
          </IconTooltip>
        </span>
      </div>

      {/* JOB A — spawn: a plain shell, honestly labelled */}
      <SpawnControl hosts={hosts} host={view.kind === 'host' ? view.host : undefined} onSpawn={onSpawnShell} />

      <RecentlyClosedFlyout
        open={flyoutOpen}
        onOpenChange={setFlyoutOpen}
        entries={closedTemps}
        onReopen={(id) => { setFlyoutOpen(false); onReopenClosed(id); }}
        onSave={(id) => { setFlyoutOpen(false); onSaveSession(id); }}
      />

      {view.kind === 'root' ? renderRootView() : view.kind === 'host' ? renderHostView(view.host) : renderCollectionView(view.collection)}

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
        line={fileTarget?.line}
        open={!!fileTarget}
        onNavigate={(p) => setFileTarget((prev) => (prev ? { ...prev, path: p, line: undefined } : prev))}
        pollIntervalMs={pollIntervalMs}
        onOpenChange={(o) => { if (!o) setFileTarget(null); }}
      />
    </div>
  );
}
