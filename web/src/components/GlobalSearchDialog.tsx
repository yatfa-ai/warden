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
import { copyText } from '@/lib/clipboard';
import { Loader2Icon, SearchIcon } from 'lucide-react';

interface SearchResult {
  key: string;
  host: string;
  name: string;
  line: number;
  text: string;
  context: { before: string; after: string };
}

interface Props {
  open: boolean;
  onClose: () => void;
  openPanes: string[];
  onFocusPane: (id: string) => void;
  onJumpToMatch: (id: string, query: string) => void;
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
function GlobalSearchResultRow({ result, onOpen }: { result: SearchResult; onOpen: (r: SearchResult) => void }) {
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

// Cross-pane global search (the ⌕ toolbar button / Ctrl+Shift+F). WARDEN-549:
// rebuilt from a hand-rolled `fixed inset-0` overlay onto the same shadcn
// Dialog/Input/Button/ScrollArea primitives its sibling WorkspaceSearchDialog
// uses, so the two search surfaces read as one system (WARDEN-68 "no raw HTML").
// The pane-result data model and the WARDEN-488 right-click row are unchanged —
// only the shell and the error handling were rebuilt.
//
// `onClose` (the existing prop wired at App.tsx) is mapped to the shadcn Dialog's
// `onOpenChange` internally so App.tsx needs no change.
export function GlobalSearchDialog({ open, onClose, openPanes, onFocusPane, onJumpToMatch }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset everything when the dialog closes — including `error`, so a stale
  // failure message from a previous open doesn't linger (mirrors the sibling).
  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
      setError(null);
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

  const handleResultClick = (result: SearchResult) => {
    onFocusPane(result.key);
    onJumpToMatch(result.key, query);
    onClose();
  };

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

        {error && <p className="text-xs text-destructive">{error}</p>}

        {/* vh-sized scroll region like the sibling WorkspaceSearchDialog, so the
            region flexes with the viewport instead of a fixed pixel height. */}
        <ScrollArea className="h-[40vh] w-full rounded-md border">
          <div className="p-2">
            {results.length === 0 && !searching && !error && (
              <div className="text-muted-foreground text-center py-8 text-sm">
                {query.trim() ? 'No results found' : 'Enter a query to search across open panes'}
              </div>
            )}
            {results.map((r, idx) => (
              <GlobalSearchResultRow key={`${r.key}-${idx}`} result={r} onOpen={handleResultClick} />
            ))}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
