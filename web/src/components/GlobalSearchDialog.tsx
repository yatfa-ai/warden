import { useEffect, useState } from 'react';

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
            className="px-4 py-2 bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50"
          >
            {searching ? 'Searching...' : 'Search'}
          </button>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground px-2">×</button>
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {results.length === 0 && !searching && (
            <div className="text-muted-foreground text-center py-8">
              {query.trim() ? 'No results found' : 'Enter a query to search'}
            </div>
          )}
          {results.map((r, idx) => (
            <div
              key={`${r.key}-${idx}`}
              onClick={() => handleResultClick(r)}
              className="mb-2 p-3 bg-muted rounded cursor-pointer hover:bg-muted/80 transition-colors"
            >
              <div className="flex justify-between items-center mb-1">
                <span className="font-medium text-sm">{r.name}</span>
                <span className="text-xs text-muted-foreground">{r.host}</span>
              </div>
              {r.context.before && <div className="text-xs text-muted-foreground mb-0.5">{r.context.before}</div>}
              <div className="text-sm font-mono">{r.text}</div>
              {r.context.after && <div className="text-xs text-muted-foreground mt-0.5">{r.context.after}</div>}
            </div>
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
