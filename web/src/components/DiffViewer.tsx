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
import { Loader2Icon, FileIcon, AlertCircleIcon } from 'lucide-react';
import { classifyDiffLine, DIFF_LINE_CLASS } from '@/lib/diff';

interface DiffViewerProps {
  chatId: string;
  filePath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DiffViewer({ chatId, filePath, open, onOpenChange }: DiffViewerProps) {
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
        const response = await fetch(`/api/git-diff?id=${encodeURIComponent(chatId)}&path=${encodeURIComponent(filePath)}`);

        if (!response.ok) {
          const data = await response.json();
          if (!cancelled) setError(data.error || `Failed to load diff: ${response.statusText}`);
          return;
        }

        const data = await response.json();
        if (cancelled) return;
        setDiff(data.diff ?? null);
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
  }, [chatId, filePath, open]);

  const empty = !loading && !error && diff !== null && diff.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileIcon className="w-4 h-4 shrink-0" />
            <span className="truncate">{filePath}</span>
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
                No changes — file matches HEAD.
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
