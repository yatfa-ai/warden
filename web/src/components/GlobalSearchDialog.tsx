import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { copyText } from '@/lib/clipboard';
import { formatTimestamp, type TimestampFormat } from '@/lib/formatTimestamp';
import { Loader2Icon, SearchIcon } from 'lucide-react';

// A pane grep hit from /api/search-pane (the default, instant leg). Renamed from
// the old `SearchResult` so the two legs read distinctly — the history leg
// (SessionSearchResult below) is a separate fetch + render path that never
// touches the pane data model.
interface PaneSearchResult {
  key: string;
  host: string;
  name: string;
  line: number;
  text: string;
  context: { before: string; after: string };
}

// A past-conversation match from /api/claude-sessions-search (the opt-in history
// leg, WARDEN-719). Shape mirrors the server response
// `{ host, sessionId, cwd, summary, snippet, mtime }` (server.js) — kept local
// (not imported from ChatSidebar) so this dialog stays self-contained against the
// endpoint contract.
interface SessionSearchResult {
  host: string;
  sessionId: string;
  cwd: string;
  summary: string;
  snippet: string;
  mtime: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
  openPanes: string[];
  onFocusPane: (id: string) => void;
  onJumpToMatch: (id: string, query: string) => void;
  // Open a past-conversation's read-only transcript (WARDEN-719). App lifts the
  // SessionTranscriptViewer to its OWN level because this dialog auto-closes on
  // result-click (handleResultClick calls onClose) — a viewer rendered inside the
  // dialog would unmount the instant the dialog closes. App's handler both sets
  // the viewing session and closes this dialog.
  onOpenSession: (id: string, host: string, label: string) => void;
  // Routes the past-conversation row's recency through the shared formatTimestamp
  // helper (WARDEN-213) so its times match the Open-Chat browser's session rows.
  timestampFormat: TimestampFormat;
}

// WARDEN-488: a NATIVE <button> (not a <div onClick>) is required so
// ContextMenuTrigger's `asChild` has a single child element to clone onto —
// Radix `asChild` rejects fragments/multiple children. The native button also
// gives the Enter/Space keyboard activation + screen-reader "button" role that
// the previous <div role="button" tabIndex={0} onKeyDown> hand-rolled, so the
// explicit onKeyDown handler is dropped (the browser activates the button on
// Enter/Space for free); the aria-label is carried over so the accessible name
// ("open search result in <name>") is preserved. Contained in its own component
// (not inlined in the results map) for the same reason the sibling
// WorkspaceSearchDialog's SearchResultRow is — the kit has no Command/cmdk list
// primitive to reach for instead.
function GlobalSearchResultRow({ result, onOpen }: { result: PaneSearchResult; onOpen: (r: PaneSearchResult) => void }) {
  // Copy via the Electron-safe helper + a sonner success/error toast — the same
  // pattern WorkspaceSearchDialog's SearchResultRow uses for its copy items.
  const handleCopy = async (text: string) => {
    const ok = await copyText(text);
    if (ok) toast.success('Copied');
    else toast.error('Copy failed');
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          aria-label={`open search result in ${result.name}`}
          onClick={() => onOpen(result)}
          className="w-full text-left mb-2 p-3 bg-muted rounded cursor-pointer hover:bg-muted/80 transition-colors"
        >
          <div className="flex justify-between items-center mb-1">
            <span className="font-medium text-sm">{result.name}</span>
            <span className="text-xs text-muted-foreground">{result.host}</span>
          </div>
          {result.context.before && <div className="text-xs text-muted-foreground mb-0.5">{result.context.before}</div>}
          <div className="text-sm font-mono">{result.text}</div>
          {result.context.after && <div className="text-xs text-muted-foreground mt-0.5">{result.context.after}</div>}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onOpen(result)}>Open</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => handleCopy(result.text)}>Copy matched line</ContextMenuItem>
        <ContextMenuItem onSelect={() => handleCopy(result.name)}>Copy pane name</ContextMenuItem>
        <ContextMenuItem onSelect={() => handleCopy(result.host)}>Copy host</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// Past-conversation result row (WARDEN-719). Reuses the pane row's
// WARDEN-488 shape (native <button> under ContextMenuTrigger asChild + a
// right-click Copy menu) but renders {summary} + {snippet} (italic, muted) +
// {host} + recency instead of {name} + {text/context}. The Copy items are
// adapted to what a session row carries ("Copy snippet" / "Copy host") — the
// pane-only "Copy matched line" / "Copy pane name" items don't apply and are
// dropped. Its own component (not inlined) for the same single-child/asChild
// reason the pane row is.
function GlobalSearchSessionRow({ result, onOpen, timestampFormat }: { result: SessionSearchResult; onOpen: (r: SessionSearchResult) => void; timestampFormat: TimestampFormat }) {
  const handleCopy = async (text: string) => {
    const ok = await copyText(text);
    if (ok) toast.success('Copied');
    else toast.error('Copy failed');
  };
  // Mirror OpenChatBrowserPage's history-row label fallback: summary, else
  // "cwd · host", else a generic "session" so a row is never blank.
  const label = result.summary || result.cwd || 'session';
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          aria-label={`open past conversation ${label}`}
          onClick={() => onOpen(result)}
          className="w-full text-left mb-2 p-3 bg-muted rounded cursor-pointer hover:bg-muted/80 transition-colors"
        >
          <div className="flex justify-between items-center mb-1">
            <span className="font-medium text-sm truncate">{label}</span>
            <span className="text-xs text-muted-foreground shrink-0 ml-2">{result.host}</span>
          </div>
          {result.snippet && <div className="text-xs text-muted-foreground italic">{result.snippet}</div>}
          {result.mtime ? (
            <div className="text-[10px] text-muted-foreground mt-0.5">{formatTimestamp(result.mtime, timestampFormat)}</div>
          ) : null}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onOpen(result)}>Open transcript</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => handleCopy(result.snippet)}>Copy snippet</ContextMenuItem>
        <ContextMenuItem onSelect={() => handleCopy(result.host)}>Copy host</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// Cross-pane global search (the ⌕ toolbar button / Ctrl+Shift+F). WARDEN-549:
// rebuilt from a hand-rolled `fixed inset-0` overlay onto the same shadcn
// Dialog/Input/Button/ScrollArea primitives its sibling WorkspaceSearchDialog
// uses, so the two search surfaces read as one system (WARDEN-68 "no raw HTML").
// The pane-result data model and the WARDEN-488 right-click row are unchanged —
// only the shell and the error handling were rebuilt.
//
// `onClose` (the existing prop wired at App.tsx) is mapped to the shadcn Dialog's
// `onOpenChange` internally so App.tsx needs no change.
export function GlobalSearchDialog({ open, onClose, openPanes, onFocusPane, onJumpToMatch, onOpenSession, timestampFormat }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PaneSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Opt-in "Past conversations" leg (WARDEN-719). Dialog-local React state — NOT
  // persisted via /api/config (the WARDEN-115 config-driven-feature trap: a pref
  // must be wired DEFAULTS→GET→frontend→PUT→guard end-to-end or it silently
  // no-ops; dialog-local state is the trap-free default). Defaults OFF so the
  // history fetch never fires and behavior is byte-for-byte identical to today.
  const [includeSessions, setIncludeSessions] = useState(false);
  const [sessionResults, setSessionResults] = useState<SessionSearchResult[]>([]);
  const [sessionSearching, setSessionSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset everything when the dialog closes — including `error`, so a stale
  // failure message from a previous open doesn't linger (mirrors the sibling).
  // The opt-in history leg resets here too: the toggle returns to OFF (its
  // default) and any in-flight/stale session results drop, so each open is a
  // clean slate identical to the toggle-OFF baseline.
  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
      setError(null);
      setIncludeSessions(false);
      setSessionResults([]);
      setSessionSearching(false);
    }
  }, [open]);

  // Focus the query input when the dialog opens — React-controlled via ref, not
  // a DOM query, and Radix's own open-auto-focus is disabled so they don't race
  // (mirrors the sibling and the WARDEN-68 file-path entry dialog pattern).
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const doSearch = async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setError(null);
    try {
      const res = await fetch(`/api/search-pane?query=${encodeURIComponent(q)}&panes=${openPanes.join(',')}`);
      const data = await res.json();
      // /api/search-pane returns 500 { error: e.message } when capturePanes
      // fails (e.g. a pane's host is unreachable). fetch resolves on HTTP
      // errors, so check res.ok AND data.error — otherwise a real failure
      // collapses into a fake "No results found" (the WARDEN-89 silent-error
      // trap). Mirrors WorkspaceSearchDialog's doSearch exactly.
      if (!res.ok || data.error) {
        setError(data.error || 'Search failed');
        setResults([]);
      } else {
        setResults(Array.isArray(data.results) ? data.results : []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Search failed');
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  // Opt-in "Past conversations" leg (WARDEN-719) — a SECOND, independent fetch
  // over /api/claude-sessions-search (the fleet-wide content search shipped in
  // WARDEN-161, otherwise reachable only from the Open-Chat browser). Mirrors
  // OpenChatBrowserPage's debounced session-search effect: 300ms debounce, a
  // `cancelled` flag so a stale fetch can't write into a newer query, and stale
  // results cleared immediately so old snippets never render under the new query.
  // The two legs are independent fetches with independent state — pane results
  // (from doSearch, fired on Enter) are never blocked by this slower SSH fan-out.
  //
  // WARDEN-89 (silent-error discipline): unlike OpenChatBrowserPage (which
  // swallows failures into a console.error), this dialog already has an error
  // banner, so a total failure (all hosts down / a server 500) surfaces via
  // setError rather than collapsing into a fake "No results found". The server's
  // own Promise.allSettled still absorbs a per-host outage into partial results,
  // so this banner only fires on a true request-level failure.
  useEffect(() => {
    // When opted out (the default) or the query is empty, never hit the endpoint
    // — behavior identical to today (no extra requests, no regression).
    if (!includeSessions) { setSessionResults([]); setSessionSearching(false); return; }
    const q = query.trim();
    if (!q) { setSessionResults([]); setSessionSearching(false); return; }
    setSessionSearching(true);
    setSessionResults([]);
    let cancelled = false;
    const t = setTimeout(async () => {
      setError(null); // fresh attempt — clear any prior banner (mirrors doSearch)
      try {
        const res = await fetch(`/api/claude-sessions-search?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        if (!res.ok || data.error) {
          if (!cancelled) { setError(data.error || 'Session search failed'); setSessionResults([]); }
        } else {
          if (!cancelled) setSessionResults(Array.isArray(data.results) ? data.results : []);
        }
      } catch (e) {
        if (!cancelled) { setError(e instanceof Error ? e.message : 'Session search failed'); setSessionResults([]); }
      } finally {
        if (!cancelled) setSessionSearching(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, includeSessions]);

  const handleResultClick = (result: PaneSearchResult) => {
    onFocusPane(result.key);
    onJumpToMatch(result.key, query);
    onClose();
  };

  // A past-conversation click opens the read-only transcript. Unlike a pane click
  // this does NOT call onClose() itself: App's onOpenSession handler both sets
  // the (App-level) viewing session and closes this dialog, so the transcript
  // viewer — rendered at App level, not in here — survives the dialog closing.
  const handleSessionClick = (result: SessionSearchResult) => {
    onOpenSession(result.host, result.sessionId, result.summary || result.cwd || 'session');
  };

  // Derived visibility for the session group. `showSessionGroup` hides the empty
  // "Past conversations" header until there's a query to search for (the checkbox
  // label already signals the leg is armed). `sessionsShowing` suppresses the pane
  // "No results found" line when the session leg has matches or is still loading,
  // so a populated/loading session group isn't contradicted by a stale "No results
  // found" above it. When the toggle is OFF both are false → pane path unchanged.
  const hasQuery = !!query.trim();
  const showSessionGroup = includeSessions && hasQuery;
  const sessionsShowing = showSessionGroup && (sessionResults.length > 0 || sessionSearching);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-2xl" onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SearchIcon className="w-4 h-4" />
            Search across panes
          </DialogTitle>
          <DialogDescription>
            Search text in every open pane — click a result to focus its pane and jump to the match.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setError(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') doSearch(); }}
            placeholder="Search across all panes..."
          />
          <Button onClick={doSearch} disabled={searching || !query.trim()}>
            {searching ? <Loader2Icon className="w-4 h-4 animate-spin" /> : 'Search'}
          </Button>
        </div>

        {/* Opt-in "Past conversations" leg (WARDEN-719). The shadcn Checkbox +
            Label primitives (WARDEN-68 — no raw <input type=checkbox>). Defaults
            OFF; dialog-local state, reset on close — never persisted (WARDEN-115). */}
        <div className="flex items-center gap-2">
          <Checkbox
            id="global-search-include-sessions"
            checked={includeSessions}
            onCheckedChange={(checked) => setIncludeSessions(checked === true)}
          />
          <Label htmlFor="global-search-include-sessions" className="text-xs text-muted-foreground cursor-pointer">
            Also search past conversations — fleet-wide, slower
          </Label>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        {/* vh-sized scroll region like the sibling WorkspaceSearchDialog, so the
            region flexes with the viewport instead of a fixed pixel height. */}
        <ScrollArea className="h-[40vh] w-full rounded-md border">
          <div className="p-2">
            {results.length === 0 && !searching && !error && !sessionsShowing && (
              <div className="text-muted-foreground text-center py-8 text-sm">
                {query.trim() ? 'No results found' : 'Enter a query to search across open panes'}
              </div>
            )}
            {results.map((r, idx) => (
              <GlobalSearchResultRow key={`${r.key}-${idx}`} result={r} onOpen={handleResultClick} />
            ))}

            {/* "Past conversations" group (WARDEN-719). Only rendered when opted in
                AND there's a query — when the toggle is OFF (or the query empty)
                this whole block is absent and the dialog is byte-for-byte today's
                pane-only search. Its own header + spinner (mirrors
                OpenChatBrowserPage's "searching session content…" row) so partial
                history results stream in without blocking pane results. */}
            {showSessionGroup && (
              <div className="mt-3 border-t pt-2">
                <div className="flex items-center gap-1.5 px-1 pb-1 text-[11px] font-medium text-muted-foreground">
                  {sessionSearching ? (
                    <Loader2Icon className="w-3 h-3 animate-spin" />
                  ) : (
                    <SearchIcon className="w-3 h-3" />
                  )}
                  <span>Past conversations</span>
                  {sessionSearching && (
                    <span className="font-normal text-muted-foreground/70">searching session content…</span>
                  )}
                </div>
                {!sessionSearching && sessionResults.length === 0 && !error && query.trim() && (
                  <div className="text-xs text-muted-foreground px-1 py-1">No past conversations matched</div>
                )}
                {sessionResults.map((s, idx) => (
                  <GlobalSearchSessionRow
                    key={`${s.host}:${s.sessionId}-${idx}`}
                    result={s}
                    onOpen={handleSessionClick}
                    timestampFormat={timestampFormat}
                  />
                ))}
              </div>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
