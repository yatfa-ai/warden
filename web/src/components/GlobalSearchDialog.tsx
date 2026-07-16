import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { copyText } from '@/lib/clipboard';

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

export function GlobalSearchDialog({ open, onClose, openPanes, onFocusPane, onJumpToMatch }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!open) { setQuery(''); setResults([]); return; }
  }, [open]);

  const doSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    try {
      const res = await fetch(`/api/search-pane?query=${encodeURIComponent(query)}&panes=${openPanes.join(',')}`);
      const data = await res.json();
      setResults(data.results || []);
    } catch (e) {
      console.error(e);
    }
    setSearching(false);
  };

  const handleResultClick = (result: SearchResult) => {
    onFocusPane(result.key);
    onJumpToMatch(result.key, query);
    onClose();
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-background border rounded-lg shadow-lg w-[600px] max-h-[500px] flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b">
          <span className="text-lg">⌕</span>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') doSearch(); }}
            placeholder="Search across all panes..."
            className="flex-1 bg-background border rounded px-3 py-2"
          />
          <button
            onClick={doSearch}
            disabled={searching || !query.trim()}
            className="px-4 py-2 bg-primary text-primary-foreground rounded hover:bg-primary/90 active:scale-95 transition-all duration-150 ease-out disabled:opacity-50"
          >
            {searching ? 'Searching...' : 'Search'}
          </button>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground px-2 active:scale-95 transition-all duration-150 ease-out">×</button>
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {results.length === 0 && !searching && (
            <div className="text-muted-foreground text-center py-8">
              {query.trim() ? 'No results found' : 'Enter a query to search'}
            </div>
          )}
          {results.map((r, idx) => (
            <GlobalSearchResultRow key={`${r.key}-${idx}`} result={r} onOpen={handleResultClick} />
          ))}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t text-xs text-muted-foreground">
          {results.length} result{results.length !== 1 ? 's' : ''} · Click to jump to match
        </div>
      </div>
    </div>
  );
}
