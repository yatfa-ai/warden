import { useState, useEffect, useRef } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Loader2Icon, SearchIcon } from 'lucide-react';

interface SearchResult {
  file: string;
  line: number;
  text: string;
}

interface Props {
  chatId: string;
  cwd?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectFile: (file: string) => void;
}

// Workspace content-search dialog (WARDEN-145). Modeled on GlobalSearchDialog's
// shape but built on the shadcn Dialog/Input/Button/ScrollArea primitives the
// FileViewer and PaneGrid path-entry dialogs use, so it reads as one system.
// Fetches POST /api/search-files (the grep endpoint), lists file:line:text
// snippets, and on click hands the chosen file path back to the parent so it
// can open the EXISTING FileViewer — no new editor, just the missing discovery
// step that feeds file reading.
export function WorkspaceSearchDialog({ chatId, cwd, open, onOpenChange, onSelectFile }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
      setError(null);
    }
  }, [open]);

  // Focus the query input when the dialog opens — React-controlled via ref, not a
  // DOM query, and Radix's own open-auto-focus is disabled so they don't race
  // (mirrors the WARDEN-68 file-path entry dialog in PaneGrid).
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const doSearch = async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setError(null);
    try {
      const res = await fetch('/api/search-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: chatId, query: q }),
      });
      const data = await res.json();
      // /api/search-files returns some errors at HTTP 200 with an `error` field
      // (no-cwd, remote transport failure — mirroring /api/git-status), not 4xx.
      // So check data.error too, not just res.ok: otherwise a real error renders
      // as "No results found" and the user misdiagnoses a config/runtime problem.
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

  const handleSelect = (file: string) => {
    onSelectFile(file);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl" onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SearchIcon className="w-4 h-4" />
            Search workspace files
          </DialogTitle>
          <DialogDescription>
            Content search in <span className="font-mono">{cwd || '.'}</span> — click a result to open it in the file viewer.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setError(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') doSearch(); }}
            placeholder="function name, class, error string…"
          />
          <Button onClick={doSearch} disabled={searching || !query.trim()}>
            {searching ? <Loader2Icon className="w-4 h-4 animate-spin" /> : 'Search'}
          </Button>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        <ScrollArea className="h-[40vh] w-full rounded-md border">
          <div className="p-2">
            {results.length === 0 && !searching && !error && (
              <div className="text-muted-foreground text-center py-8 text-sm">
                {query.trim() ? 'No results found' : 'Enter a query to search tracked files'}
              </div>
            )}
            {results.map((r, idx) => (
              <button
                key={`${r.file}-${r.line}-${idx}`}
                onClick={() => handleSelect(r.file)}
                className="flex flex-col w-full text-left mb-1 p-2 rounded hover:bg-accent transition-colors"
              >
                <span className="text-xs text-muted-foreground font-mono truncate">{r.file}:{r.line}</span>
                <span className="text-sm font-mono whitespace-pre-wrap break-words">{r.text}</span>
              </button>
            ))}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
