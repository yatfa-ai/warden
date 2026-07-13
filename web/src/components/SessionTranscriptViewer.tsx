import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EyeIcon, AlertCircleIcon } from 'lucide-react';
import { ObserverMarkdown } from './ObserverMarkdown';
import { cn } from '@/lib/utils';
import { formatTimestamp, type TimestampFormat } from '@/lib/formatTimestamp';

// A single transcript message from GET /api/claude-session (one JSONL line mapped
// through the server's extractTranscriptMessage: role + human text + timestamp).
export interface TranscriptMessage { role: string; text: string; ts?: string }

interface SessionTranscriptViewerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // The session to read. null keeps the dialog closed without firing a fetch.
  session: { id: string; host: string; label: string } | null;
  // Timestamp format pref (WARDEN-213): routes each message's time through the
  // shared formatTimestamp helper.
  timestampFormat: TimestampFormat;
}

// Read-only transcript viewer for any past Claude session (WARDEN-233). Opens from
// a history row's eye affordance and renders the fetched messages as a bubble list
// (text via ObserverMarkdown) — a plain fetch, no process is spawned. Mirrors the
// DiffViewer/FileViewer shape (Dialog + ScrollArea + loading/error/empty/ready),
// since a capped transcript is bounded read-only content, not an unbounded surface.
export function SessionTranscriptViewer({ open, onOpenChange, session, timestampFormat }: SessionTranscriptViewerProps) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error' | 'empty'>('loading');
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [cwd, setCwd] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    // Reset on close so reopening — possibly a DIFFERENT session — never paints the
    // previous session's messages for a frame before the new fetch lands (DiffViewer
    // does the same reset in its !open branch).
    if (!open) {
      setStatus('loading');
      setMessages([]);
      setCwd('');
      setTruncated(false);
      setError('');
      return;
    }
    if (!session) return;
    let cancelled = false;
    setStatus('loading');
    setMessages([]);
    setCwd('');
    setTruncated(false);
    setError('');

    (async () => {
      try {
        const r = await fetch(`/api/claude-session?id=${encodeURIComponent(session.id)}&host=${encodeURIComponent(session.host)}`);
        const j = await r.json();
        if (cancelled) return;
        // Unreachable host → a graceful error body (never a hang), not an HTTP error.
        if (j.error) {
          setStatus('error');
          setError(j.error === 'host unreachable'
            ? `Host “${session.host}” is unreachable — can't read this session remotely.`
            : j.error);
          return;
        }
        const msgs = Array.isArray(j.messages) ? j.messages : [];
        setCwd(typeof j.cwd === 'string' ? j.cwd : '');
        setTruncated(!!j.truncated);
        if (msgs.length === 0) { setStatus('empty'); return; }
        setMessages(msgs);
        setStatus('ready');
      } catch (e) {
        if (cancelled) return;
        setStatus('error');
        setError(e instanceof Error ? e.message : 'Failed to load transcript');
      }
    })();

    return () => { cancelled = true; };
  }, [open, session]);

  const hostLabel = !session || session.host === '(local)' ? 'this machine' : session.host;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <EyeIcon className="size-4 shrink-0" />
            <span className="truncate">{session?.label || 'Session transcript'}</span>
          </DialogTitle>
          <DialogDescription className="truncate">
            Read-only transcript — no process is started · {hostLabel}{cwd ? ` · ${cwd}` : ''}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="h-[60vh] w-full rounded-md border bg-muted/30">
          <div className="flex flex-col gap-3 p-4">
            {status === 'loading' && (
              <div className="flex flex-col gap-4">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="space-y-2">
                    <Skeleton className="h-3 w-16" />
                    <Skeleton className="h-10 w-3/4" />
                  </div>
                ))}
              </div>
            )}

            {status === 'error' && (
              <div className="flex items-center gap-2 py-8 text-red-400">
                <AlertCircleIcon className="size-5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {status === 'empty' && (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                No readable messages in this session.
              </div>
            )}

            {status === 'ready' && (
              <>
                {truncated && (
                  <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-1.5 text-xs text-yellow-300">
                    Showing the most recent messages — the full transcript was too large to load at once.
                  </div>
                )}
                {messages.map((m, i) => (
                  <MessageBubble key={i} message={m} timestampFormat={timestampFormat} />
                ))}
              </>
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

function MessageBubble({ message, timestampFormat }: { message: TranscriptMessage; timestampFormat: TimestampFormat }) {
  const isUser = message.role === 'user';
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div className={cn(
        'max-w-[85%] rounded-lg border px-3 py-2',
        isUser ? 'border-primary/30 bg-primary/10' : 'border-border bg-background',
      )}>
        <div className="mb-1 flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">{isUser ? 'You' : 'Assistant'}</span>
          {message.ts && <span className="text-xs text-muted-foreground/70">{formatTs(message.ts, timestampFormat)}</span>}
        </div>
        <ObserverMarkdown>{message.text}</ObserverMarkdown>
      </div>
    </div>
  );
}

// ISO-ish timestamp → formatted per the Timestamp format pref; fall back to the
// raw value if it isn't a real date so we never drop information.
function formatTs(ts: string, timestampFormat: TimestampFormat): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : formatTimestamp(d, timestampFormat);
}
