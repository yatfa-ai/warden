import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Loader2Icon, FileIcon, GitCompare, AlertCircleIcon } from 'lucide-react';
import { classifyDiffLine, DIFF_LINE_CLASS } from '@/lib/diff';

interface DiffViewerProps {
  chatId: string;
  filePath: string;
  // WARDEN-369: when true, fetch `git diff --cached` (index-vs-HEAD = exactly what
  // will be committed) instead of the combined worktree-vs-HEAD diff. Set when a
  // STAGED file in the dirty-file list is clicked. Single-file mode only.
  staged?: boolean;
  // WARDEN-398: aggregated range-diff mode. When set, fetch the net unified diff of
  // the agent's whole unpushed (outgoing) or incoming (incoming) set via
  // /api/git-range-diff instead of the single-file /api/git-diff. The modal is then
  // titled "Unpushed changes (↑N)" / "Incoming changes (↓N)" rather than a file path.
  // `filePath` is ignored in this mode. One renderer for both — same classifyDiffLine
  // coloring as every other committed diff (the "no second renderer" intent).
  range?: 'outgoing' | 'incoming';
  // The commit count for the title ("↑N"/"↓N") in range mode. Display-only.
  count?: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DiffViewer({ chatId, filePath, staged, range, count, open, onOpenChange }: DiffViewerProps) {
  // Range mode fetches /api/git-range-diff (net diff of the whole unpushed/incoming
  // set); single-file mode fetches /api/git-diff for one working-tree file.
  const isRange = range === 'outgoing' || range === 'incoming';
  const [diff, setDiff] = useState<string | null>(null);
  const [untracked, setUntracked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) {
      setDiff(null);
      setUntracked(false);
      setError(null);
      return;
    }

    let cancelled = false;
    const fetchDiff = async () => {
      setLoading(true);
      setError(null);
      setDiff(null);
      setUntracked(false);
      try {
        // range mode → /api/git-range-diff?id=&range= ; single-file → /api/git-diff?id=&path=
        const url = isRange
          ? `/api/git-range-diff?id=${encodeURIComponent(chatId)}&range=${range}`
          : `/api/git-diff?id=${encodeURIComponent(chatId)}&path=${encodeURIComponent(filePath)}${staged ? '&staged=1' : ''}`;
        const response = await fetch(url);

        if (!response.ok) {
          const data = await response.json();
          if (!cancelled) setError(data.error || `Failed to load diff: ${response.statusText}`);
          return;
        }

        const data = await response.json();
        if (cancelled) return;
        setDiff(data.diff ?? null);
        // untracked only applies to a single working-tree file; the range endpoint
        // returns no `untracked` field, so this is always false in range mode.
        setUntracked(!!data.untracked);
        if (data.error) setError(data.error);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load diff');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchDiff();
    return () => { cancelled = true; };
  }, [chatId, filePath, staged, range, isRange, open]);

  const empty = !loading && !error && diff !== null && diff.length === 0;
  // Range mode titles the modal by the change set; single-file mode by the path.
  const title = isRange
    ? (range === 'outgoing' ? `Unpushed changes (↑${count ?? 0})` : `Incoming changes (↓${count ?? 0})`)
    : filePath;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isRange ? <GitCompare className="w-4 h-4 shrink-0" /> : <FileIcon className="w-4 h-4 shrink-0" />}
            <span className="truncate">{title}</span>
            {staged && !isRange && (
              <span className="shrink-0 rounded bg-green-500/15 px-1.5 py-px text-[10px] font-medium text-green-400" title="staged-only diff — exactly what will be committed (git diff --cached)">
                staged
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <ScrollArea className="h-[60vh] w-full rounded-md border bg-muted/50">
          <div className="p-4">
            {loading && (
              <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
                <Loader2Icon className="w-5 h-5 animate-spin" />
                <span>Loading diff...</span>
              </div>
            )}

            {error && (
              <div className="flex items-center gap-2 py-8 text-red-400">
                <AlertCircleIcon className="w-5 h-5" />
                <span>{error}</span>
              </div>
            )}

            {!loading && !error && untracked && (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                Untracked file — no diff yet.
              </div>
            )}

            {!loading && !error && empty && (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                {isRange ? 'No net changes between the two tips.' : 'No changes — file matches HEAD.'}
              </div>
            )}

            {!loading && !error && diff !== null && diff.length > 0 && (
              <pre className="text-sm font-mono whitespace-pre">
                {diff.split('\n').map((line, i) => (
                  <span key={i} className={`block ${DIFF_LINE_CLASS[classifyDiffLine(line)]}`}>
                    {line || ' '}
                  </span>
                ))}
              </pre>
            )}
          </div>
        </ScrollArea>

        <DialogClose asChild>
          <Button variant="outline" className="w-full sm:w-auto">Close</Button>
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}
