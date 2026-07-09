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

interface FileViewerProps {
  chatId: string;
  filePath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function FileViewer({ chatId, filePath, open, onOpenChange }: FileViewerProps) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) {
      setContent(null);
      setError(null);
      return;
    }

    const fetchFile = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch('/api/read-file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: chatId, path: filePath }),
        });

        if (!response.ok) {
          const data = await response.json();
          setError(data.error || `Failed to read file: ${response.statusText}`);
          return;
        }

        const data = await response.json();
        setContent(data.content);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to read file');
      } finally {
        setLoading(false);
      }
    };

    fetchFile();
  }, [chatId, filePath, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileIcon className="w-4 h-4" />
            <span className="truncate">{filePath}</span>
          </DialogTitle>
        </DialogHeader>

        <ScrollArea className="h-[60vh] w-full rounded-md border bg-muted/50">
          <div className="p-4">
            {loading && (
              <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
                <Loader2Icon className="w-5 h-5 animate-spin" />
                <span>Loading file...</span>
              </div>
            )}

            {error && (
              <div className="flex items-center gap-2 py-8 text-red-400">
                <AlertCircleIcon className="w-5 h-5" />
                <span>{error}</span>
              </div>
            )}

            {!loading && !error && content !== null && (
              <pre className="text-sm font-mono whitespace-pre-wrap break-words">
                {content}
              </pre>
            )}

            {!loading && !error && content === null && (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                No content
              </div>
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
