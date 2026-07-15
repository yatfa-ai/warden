import { useState, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { copyText } from '@/lib/clipboard';
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
  // WARDEN-334: the line is threaded through so the FileViewer can scroll to +
  // highlight the matching row (its existing WARDEN-227 `line` prop) instead of
  // opening the file at the top. Optional so non-grep callers keep the (file)-only shape.
  onSelectFile: (file: string, line?: number) => void;
}

// WARDEN-68 (UI std: don't add raw interactive elements): a NATIVE <button> is
// the correct primitive here, not shadcn's <Button>. A result row is a
// multi-line, block-layout list item; shadcn Button is styled for single-line
// actions and would fight that layout. The native button gives keyboard
// (Enter/Space) activation + the screen-reader "button" role for free — the
// accessible choice over GlobalSearchDialog's `<div onClick>`. The kit has no
// Command/cmdk list primitive to reach for instead, so the raw element is
// contained here in its own component rather than inlined in the results map.
function SearchResultRow({ result, onSelect }: { result: SearchResult; onSelect: (file: string, line?: number) => void }) {
  // Copy via the Electron-safe helper + a sonner success/error toast — the same
  // pattern CollectionsSection/ActivityTimeline use for their copy actions.
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
          onClick={() => onSelect(result.file, result.line)}
          className="flex flex-col w-full text-left mb-1 p-2 rounded hover:bg-accent transition-colors"
        >
          <span className="text-xs text-muted-foreground font-mono truncate">{result.file}:{result.line}</span>
          <span className="text-sm font-mono whitespace-pre-wrap break-words">{result.text}</span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onSelect(result.file, result.line)}>
          Open in file viewer
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => handleCopy(result.text)}>Copy matched line</ContextMenuItem>
        <ContextMenuItem onSelect={() => handleCopy(result.file)}>Copy file path</ContextMenuItem>
        <ContextMenuItem onSelect={() => handleCopy(`${result.file}:${result.line}`)}>Copy file:line</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
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

  const handleSelect = (file: string, line?: number) => {
    onSelectFile(file, line);
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

        {/* WARDEN-68: viewport-relative height matches the sibling FileViewer's own
            ScrollArea (h-[60vh]); these file dialogs size scroll regions in vh so the
            region flexes with the viewport instead of a fixed pixel. Search snippets
            are short, so 40vh (vs the file viewer's 60vh) stays compact without overflow. */}
        <ScrollArea className="h-[40vh] w-full rounded-md border">
          <div className="p-2">
            {results.length === 0 && !searching && !error && (
              <div className="text-muted-foreground text-center py-8 text-sm">
                {query.trim() ? 'No results found' : 'Enter a query to search tracked files'}
              </div>
            )}
            {results.map((r, idx) => (
              <SearchResultRow key={`${r.file}-${r.line}-${idx}`} result={r} onSelect={handleSelect} />
            ))}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
