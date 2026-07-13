import { useState, useEffect, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { ArrowLeft, EyeIcon } from 'lucide-react';
import { SessionTranscriptViewer } from './SessionTranscriptViewer';
import { StatusDot } from '@/components/StatusDot';
import type { Chat } from '@/lib/types';
// Shared pure display helpers live in @/lib/chatDisplay so the sidebar and this
// page render identical labels (no drift in chat names between the two surfaces).
import { THIS_MACHINE, basename, displayName, hostTagOf } from '@/lib/chatDisplay';
import { formatTimestamp, type TimestampFormat } from '@/lib/formatTimestamp';
import { formatTokens } from '@/lib/formatTokens';
import type { ClaudeSession, SessionSearchResult, TokenUsage } from './ChatSidebar';

// Loading placeholder for a session row (two skeleton bars). Local to this page —
// presentational and unlikely to drift from the sidebar's variant in a meaningful way.
function SessionRowSkeleton() {
  return (
    <div className="flex flex-col gap-0.5 px-2 py-1.5 rounded-md">
      <Skeleton className="h-3 w-3/4" />
      <Skeleton className="h-2.5 w-1/2" />
    </div>
  );
}

// Persisted host multiselect (the user's browsing scope). Stored under its own key
// so it can't race with App's centralized UiState save. Undefined = first run →
// default later. (WARDEN-109 Facet B: keep on `warden:discover-hosts:v1`.)
const DISCOVER_HOSTS_KEY = 'warden:discover-hosts:v1';
function loadDiscoverHosts(): string[] | undefined {
  try {
    const v = JSON.parse(localStorage.getItem(DISCOVER_HOSTS_KEY) || '');
    if (Array.isArray(v)) return v.filter((h) => typeof h === 'string');
  } catch { /* ignore */ }
  return undefined;
}
function saveDiscoverHosts(hosts: string[]) {
  try { localStorage.setItem(DISCOVER_HOSTS_KEY, JSON.stringify(hosts)); } catch { /* ignore */ }
}

// One normalized row in the merged discovery list.
interface DiscoverItem {
  id: string;            // unique list key
  kind: 'live' | 'history';
  label: string;         // display name
  hostTag: string;
  sub: string;           // secondary line: host · cwd · time
  time: number;          // recency, for sorting (0 = unknown)
  openId?: string;       // live: chat key/id to openChat
  resume?: { id: string; description: string; cwd: string; host: string }; // history: resume params
  snippet?: string;      // content-match snippet (full-content search only)
  tokenUsage?: TokenUsage | null; // history: per-session LLM token total (WARDEN-367)
}

function DiscoverItemRow({ it, resumingId, onOpen, onResume, onView, timestampFormat }: { it: DiscoverItem; resumingId: string | null; onOpen: () => void; onResume: () => void; onView: () => void; timestampFormat: TimestampFormat; }) {
  if (it.kind === 'live') {
    return (
      <Button variant="ghost" onClick={onOpen} className="w-full h-auto justify-start gap-2 px-2 py-1.5 text-xs font-normal hover:bg-accent">
        <StatusDot tone="green" variant="solid" label="Live session" />
        <span className="truncate flex-1">{it.label}</span>
        {it.time ? <span className="text-[10px] text-muted-foreground shrink-0">{formatTimestamp(it.time, timestampFormat)}</span> : null}
        <span className="text-[10px] text-muted-foreground shrink-0">{it.hostTag}</span>
        <span className="text-[10px] text-green-500/80 shrink-0">live</span>
      </Button>
    );
  }
  const isLoading = resumingId === it.id;
  return (
    <div className="group flex items-center gap-2 px-2 py-1.5 rounded-md text-xs hover:bg-accent transition-colors">
      <StatusDot tone="cyan" variant="ring" label="History session (resumable)" />
      <div className="flex-1 min-w-0">
        <Button variant="ghost" onClick={onResume} disabled={isLoading} className="h-auto w-full justify-start px-1 py-0 truncate text-xs font-normal">{it.label}</Button>
        {it.snippet ? <div className="px-1 truncate text-[10px] text-muted-foreground/80 italic" title={it.snippet}>{it.snippet}</div> : null}
      </div>
      {it.time ? <span className="text-[10px] text-muted-foreground shrink-0">{formatTimestamp(it.time, timestampFormat)}</span> : null}
      {it.tokenUsage?.total ? (
        <IconTooltip label="Total tokens this session consumed (input + output + cache). Model-agnostic — not dollar cost.">
          <span className="text-[10px] text-amber-500/80 shrink-0 tabular-nums">{formatTokens(it.tokenUsage.total)}</span>
        </IconTooltip>
      ) : null}
      <span className="text-[10px] text-muted-foreground shrink-0">{it.hostTag}</span>
      <IconTooltip label="view transcript (read-only)">
        <Button variant="ghost" size="icon-xs" onClick={onView} aria-label="View transcript" className="text-muted-foreground hover:text-foreground">
          <EyeIcon />
        </Button>
      </IconTooltip>
      <IconTooltip label="bump to live (resume)" disabled={isLoading}>
        <Button variant="ghost" size="xs" onClick={onResume} disabled={isLoading} className="text-[10px] text-cyan-400 hover:text-cyan-300 px-1 h-auto">
          {isLoading ? <Skeleton className="h-3 w-6 inline-block" /> : '↻ resume'}
        </Button>
      </IconTooltip>
    </div>
  );
}

interface Props {
  /** Return to the workspace (replaces the modal's onOpenChange(false)). */
  onClose: () => void;
  hosts: string[];
  chats: Chat[];
  onOpenChat: (id: string) => void;
  onResume: (id: string, description: string, cwd: string, host: string) => void;
  onDiscoverHost: (host: string) => void;
  hostStatuses: Record<string, { status: 'online' | 'offline' | 'unknown'; latency_ms: number | null }>;
  // Timestamp format pref (WARDEN-213): routes every row time + the transcript
  // viewer's message times through the shared formatTimestamp helper.
  timestampFormat: TimestampFormat;
}

// Full-page replacement for the former Open Chat browser modal. Mirrors the
// Settings full-page pattern: a header (back button + title + content pane)
// swapped in via an App-level boolean. The "Open chat…" button in the sidebar
// sets chatBrowserOpen; the back button / Escape clears it. Per WARDEN-68 Rule 7
// the browser is a real UI surface (unbounded list + search), so it must be a
// page, not a blocking Dialog.
export function OpenChatBrowserPage({ onClose, hosts, chats, onOpenChat, onResume, onDiscoverHost, hostStatuses, timestampFormat }: Props) {
  const [selected, setSelected] = useState<string[] | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [resumingId, setResumingId] = useState<string | null>(null);
  // The history session whose read-only transcript is open (null = viewer closed).
  // Lifted here (not per-row) so the viewer is a sibling dialog over the page.
  const [viewing, setViewing] = useState<{ id: string; host: string; label: string } | null>(null);
  const [contentResults, setContentResults] = useState<SessionSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  const [allSessions, setAllSessions] = useState<(ClaudeSession & { host: string })[]>([]);
  const [loadingAllSessions, setLoadingAllSessions] = useState(false);
  // Cross-host "All Sessions" pagination (WARDEN-176). `hasMoreSessions` mirrors
  // the server's `hasMore` so Load-more converges; `loadingMoreSessions` gates
  // the button.
  const [hasMoreSessions, setHasMoreSessions] = useState(false);
  const [loadingMoreSessions, setLoadingMoreSessions] = useState(false);
  // Sort the history list by token usage (heaviest first) so the sessions that
  // burned the most tokens surface to the top — the flagship "which session
  // spent the most?" question. Off by default (recency first). (WARDEN-367.)
  const [sortUsage, setSortUsage] = useState(false);

  // Load persisted host selection once.
  useEffect(() => { setSelected(loadDiscoverHosts()); }, []);

  // Page size for the cross-host "All Sessions" list. Matches the server default
  // (and the old hard global cap), so page 1 is identical to the pre-pagination UI.
  const ALL_SESSIONS_PAGE = 40;

  // Fetch page 1 of the cross-host session list (most-recent first), REPLACING the
  // loaded set. The page mounts fresh each time it's shown (App swaps it in via the
  // view-switch ternary), so this doubles as the "on open" refresh.
  const fetchAllSessions = async () => {
    setLoadingAllSessions(true);
    try {
      const r = await fetch(`/api/claude-sessions-all?offset=0&limit=${ALL_SESSIONS_PAGE}`);
      const j = await r.json();
      setAllSessions(j.sessions || []);
      setHasMoreSessions(!!j.hasMore);
    } catch (error) {
      console.error('[claude-sessions-all] Failed:', error);
    }
    setLoadingAllSessions(false);
  };

  // Fetch the NEXT page and APPEND it to the loaded set. Offset = the number
  // already loaded, since the server paginates over the global recency-sorted
  // timeline. Sessions are deduped by host:id so a shifting timeline (a host
  // becoming reachable between requests) can't produce visual duplicates.
  const loadMoreSessions = async () => {
    if (loadingMoreSessions || !hasMoreSessions) return;
    setLoadingMoreSessions(true);
    try {
      const r = await fetch(`/api/claude-sessions-all?offset=${allSessions.length}&limit=${ALL_SESSIONS_PAGE}`);
      const j = await r.json();
      const next = (j.sessions || []) as (ClaudeSession & { host: string })[];
      setHasMoreSessions(!!j.hasMore);
      setAllSessions((prev) => {
        const seen = new Set(prev.map((s) => `${s.host}:${s.id}`));
        return [...prev, ...next.filter((s) => !seen.has(`${s.host}:${s.id}`))];
      });
    } catch (error) {
      console.error('[claude-sessions-all load-more] Failed:', error);
    }
    setLoadingMoreSessions(false);
  };

  // "usual hosts" = hosts of the user's currently-active chats (their daily scope).
  const usualHosts = useMemo(() => {
    const set = new Set<string>();
    for (const c of chats) if (c.active && c.host) set.add(c.host);
    return Array.from(set);
  }, [chats]);

  // Fleet token usage over the LOADED window (everything fetched so far, growing
  // as the user clicks "load more"). Summed client-side from the per-row
  // tokenUsage the backend attaches, so it always reflects exactly what's on
  // screen — not just one page. The server's per-page `totals` mirrors page 1;
  // this memo is the honest "visible window" total the summary shows. Labeled
  // as the window (not all-history) because pagination means older sessions load
  // on demand. (WARDEN-367.)
  const fleetTotals = useMemo(() => {
    let total = 0;
    const byHost: Record<string, number> = {};
    for (const s of allSessions) {
      const t = s.tokenUsage?.total;
      if (!t) continue;
      total += t;
      byHost[s.host] = (byHost[s.host] || 0) + t;
    }
    const breakdown = Object.entries(byHost)
      .sort((a, b) => b[1] - a[1])
      .map(([h, t]) => `${h === THIS_MACHINE ? 'this machine' : h}: ${formatTokens(t)}`)
      .join('\n');
    return { total, hostCount: Object.keys(byHost).length, breakdown };
  }, [allSessions]);

  // Resolved selection: persisted → usual hosts → all hosts.
  const effective = useMemo(() => {
    if (selected && selected.length) return selected;
    return usualHosts.length ? usualHosts : hosts;
  }, [selected, usualHosts, hosts]);

  // On mount (≡ "on open"): refresh history sessions and discover selected remote
  // hosts so live items populate. Fire-and-forget — chats update flows back as each
  // host resolves.
  useEffect(() => {
    fetchAllSessions();
    effective.forEach((h) => { if (h !== THIS_MACHINE) onDiscoverHost(h); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Escape returns to the workspace (mirrors the modal's Escape-to-close). Gate
  // on the event, not on the `viewing` React state: when the nested transcript
  // viewer (a Radix Dialog) is open, its DismissableLayer handles Escape on
  // `document` in the CAPTURE phase and calls event.preventDefault(). This page
  // listener is on `window` (bubble phase), which runs AFTER capture — so by the
  // time it fires the transcript's setViewing(null) has already flushed and
  // `viewing` would read as null (closure state races the capture-phase mutation).
  // `defaultPrevented` is a flag on the event object itself, set in capture and
  // visible to every later listener, so it can't race: the first Escape (handled
  // by the transcript) is skipped here, a second Escape (no viewer open) closes
  // the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Full-content session search (WARDEN-161). When the query is non-empty, debounce
  // and hit /api/claude-sessions-search so matches INSIDE a session's body — not just
  // its summary — surface, including sessions outside the top-40 list. Empty query
  // clears results so the instant top-40 list is preserved (no regression).
  useEffect(() => {
    const q = query.trim();
    if (!q) { setContentResults([]); setSearchLoading(false); return; }
    setSearchLoading(true);
    // Clear the previous query's results immediately so stale matches (and their
    // snippets) are never rendered under the new query while the debounce waits.
    setContentResults([]);
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/claude-sessions-search?q=${encodeURIComponent(q)}`);
        if (!r.ok) throw new Error(`session search HTTP ${r.status}`);
        const j = await r.json();
        if (!cancelled) setContentResults(Array.isArray(j.results) ? j.results : []);
      } catch (error) {
        console.error('[claude-sessions-search] Failed:', error);
        if (!cancelled) setContentResults([]);
      } finally {
        if (!cancelled) setSearchLoading(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query]);

  const toggleHost = (h: string) => {
    setSelected((prev) => {
      const base = prev && prev.length ? prev : effective;
      const next = base.includes(h) ? base.filter((x) => x !== h) : [...base, h];
      saveDiscoverHosts(next);
      if (!base.includes(h) && h !== THIS_MACHINE) onDiscoverHost(h);
      return next;
    });
  };

  // Build the merged, deduped list. Live tmux sessions first (tracking resume- keys
  // to dedupe), then Claude history sessions minus those already shown live.
  const items = useMemo<DiscoverItem[]>(() => {
    const sel = new Set(effective);
    const out: DiscoverItem[] = [];
    const liveResumeSid8 = new Set<string>();
    for (const c of chats) {
      if (!sel.has(c.host) || c.active !== true) continue;
      const key = c.key || c.id;
      if (key && key.startsWith('resume-')) liveResumeSid8.add(key.slice(7));
      out.push({
        id: 'live:' + key, kind: 'live', label: displayName(c),
        hostTag: hostTagOf(c.host),
        sub: `${hostTagOf(c.host)}${c.cwd ? ' · ' + basename(c.cwd) : ''}`,
        time: c.lastActivity || 0, openId: key,
      });
    }
    // History source: full-content search results when a query is present
    // (reaches sessions OUTSIDE the top-40 by what was discussed), else the
    // instant top-40 list. Either way, dedupe against live resume sessions.
    // Per-session tokenUsage flows through only from the All Sessions list —
    // content-search results don't carry it (so a searched row shows no badge,
    // which is honest, not a regression). (WARDEN-367.)
    const q = query.trim();
    const history: { id: string; host: string; cwd: string; summary: string; mtime: number; snippet?: string; tokenUsage?: TokenUsage | null }[] = q
      ? contentResults.map((r) => ({ id: r.sessionId, host: r.host, cwd: r.cwd, summary: r.summary, mtime: r.mtime, snippet: r.snippet }))
      : allSessions.map((s) => ({ id: s.id, host: s.host, cwd: s.cwd, summary: s.summary, mtime: s.mtime, tokenUsage: s.tokenUsage }));
    for (const s of history) {
      if (!sel.has(s.host)) continue;
      if (liveResumeSid8.has(s.id.slice(0, 8))) continue; // already shown as live
      out.push({
        id: 'hist:' + s.host + ':' + s.id, kind: 'history',
        label: s.summary || `${basename(s.cwd) || 'session'} · ${hostTagOf(s.host)}`,
        hostTag: hostTagOf(s.host), sub: `${hostTagOf(s.host)} · ${basename(s.cwd)}`,
        time: s.mtime, snippet: s.snippet, tokenUsage: s.tokenUsage,
        resume: { id: s.id, description: s.summary, cwd: s.cwd, host: s.host },
      });
    }
    // Recency by default; when sortUsage is on, heavier token usage floats up
    // (rows without usage sink but keep recency order as the tiebreak). Live
    // sessions carry no tokenUsage, so under usage-sort they sit among the
    // zero-usage rows by recency — an explicit trade for "heaviest first".
    if (sortUsage) {
      out.sort((a, b) => {
        const d = (b.tokenUsage?.total || 0) - (a.tokenUsage?.total || 0);
        return d !== 0 ? d : b.time - a.time;
      });
    } else {
      out.sort((a, b) => b.time - a.time);
    }
    return out;
  }, [effective, chats, allSessions, contentResults, query, sortUsage]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    // History rows already matched via full-content search; only live rows get
    // the metadata filter so a running session is still findable by name/host.
    return items.filter((it) => {
      if (it.kind === 'history') return true;
      return it.label.toLowerCase().includes(q) || it.sub.toLowerCase().includes(q);
    });
  }, [items, query]);

  const handleResume = async (it: DiscoverItem) => {
    if (!it.resume || resumingId) return;
    setResumingId(it.id);
    try { await onResume(it.resume.id, it.resume.description, it.resume.cwd, it.resume.host); onClose(); }
    finally { setResumingId(null); }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <header className="flex items-center gap-2 px-3 h-11 border-b shrink-0">
        <IconTooltip label="Back to dashboard" side="bottom">
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Back to dashboard">
            <ArrowLeft />
          </Button>
        </IconTooltip>
        <h1 className="text-sm font-semibold tracking-wide">Open chat</h1>
        <span className="text-xs text-muted-foreground truncate">
          One merged list across your hosts — live tmux sessions and Claude history. Search finds sessions by what was discussed in them, not just their title.
        </span>
        {fleetTotals.total > 0 && (
          <IconTooltip side="bottom" label={
            <span className="whitespace-pre-line">
              {`Token usage across the loaded session window (model-agnostic — not dollar cost).\n\n${fleetTotals.breakdown || '(no per-host data)'}`}
            </span>
          }>
            <span className="ml-auto shrink-0 text-[11px] text-amber-500/90 tabular-nums font-medium">
              ☁ {formatTokens(fleetTotals.total)} tok · {fleetTotals.hostCount} host{fleetTotals.hostCount === 1 ? '' : 's'}
            </span>
          </IconTooltip>
        )}
      </header>

      {/* Pinned controls: host multiselect chips + search. The list scrolls
          beneath so the scope/filter stay visible while browsing. */}
      <div className="border-b shrink-0">
        <div className="mx-auto max-w-3xl w-full px-4 pt-4 pb-3 flex flex-col gap-3">
          <div className="flex flex-wrap gap-1.5">
            {hosts.map((h) => {
              const on = effective.includes(h);
              const st = hostStatuses[h];
              return (
                <Button key={h} size="xs" variant={on ? 'secondary' : 'outline'} onClick={() => toggleHost(h)} className="gap-1">
                  <StatusDot
                    size="size-1.5"
                    tone={st?.status === 'online' ? 'green' : st?.status === 'offline' ? 'red' : 'muted'}
                    variant={st?.status === 'online' ? 'solid' : st?.status === 'offline' ? 'square' : 'ring'}
                    label={st?.status ? st.status.charAt(0).toUpperCase() + st.status.slice(1) : 'Unknown'}
                  />
                  {h === THIS_MACHINE ? 'this machine' : h}
                </Button>
              );
            })}
          </div>
          <div className="flex gap-1.5 items-center">
            <Input placeholder="Search live + history sessions…" value={query} onChange={(e) => setQuery(e.target.value)} className="text-xs flex-1" />
            <Button
              size="xs"
              variant={sortUsage ? 'secondary' : 'outline'}
              onClick={() => setSortUsage((v) => !v)}
              title="Sort by token usage (heaviest first)"
              className="shrink-0"
            >
              usage
            </Button>
          </div>
        </div>
      </div>

      {/* Scrollable merged list. */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto max-w-3xl w-full px-4 py-2 flex flex-col gap-0.5">
          {loadingAllSessions && items.length === 0 ? (
            [1, 2, 3, 4].map((i) => <SessionRowSkeleton key={i} />)
          ) : searchLoading && filtered.length === 0 ? (
            [1, 2, 3].map((i) => <SessionRowSkeleton key={i} />)
          ) : filtered.length === 0 ? (
            <div className="text-xs text-muted-foreground p-4 text-center">
              {query ? 'No matches across selected hosts' : effective.length === 0 ? 'Select at least one host' : 'Nothing runnable on the selected hosts yet'}
            </div>
          ) : (
            filtered.map((it) => (
              <DiscoverItemRow
                key={it.id}
                it={it}
                resumingId={resumingId}
                onOpen={() => { if (it.openId) { onOpenChat(it.openId); onClose(); } }}
                onResume={() => handleResume(it)}
                onView={() => { if (it.resume) setViewing({ id: it.resume.id, host: it.resume.host, label: it.label }); }}
                timestampFormat={timestampFormat}
              />
            ))
          )}
          {searchLoading && filtered.length > 0 && (
            <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] text-muted-foreground">
              <Skeleton className="size-2 rounded-full" /> searching session content…
            </div>
          )}
          {/* Load more surfaces the long tail (sessions older than the newest
              page) without requiring a search. Only relevant when browsing the
              history list — a content query uses /api/claude-sessions-search,
              which has its own results, so hide this while searching. */}
          {!query.trim() && hasMoreSessions && filtered.length > 0 && (
            <Button
              variant="ghost"
              size="xs"
              onClick={loadMoreSessions}
              disabled={loadingMoreSessions}
              className="mt-1 mx-auto text-[11px] text-blue-400 hover:text-blue-300"
            >
              {loadingMoreSessions ? 'loading…' : '↓ load more'}
            </Button>
          )}
        </div>
      </div>

      <SessionTranscriptViewer
        open={!!viewing}
        onOpenChange={(o) => { if (!o) setViewing(null); }}
        session={viewing}
        timestampFormat={timestampFormat}
      />
    </div>
  );
}
