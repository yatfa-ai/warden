import { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { hostLabelFor } from '@/lib/chatDisplay';
import { useHostLabels } from '@/lib/hostLabels';
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
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { EyeIcon, AlertCircleIcon, Loader2Icon } from 'lucide-react';
import { ObserverMarkdown } from './ObserverMarkdown';
import { cn } from '@/lib/utils';
import { formatTimestamp, type TimestampFormat } from '@/lib/formatTimestamp';
import { formatTokens } from '@/lib/formatTokens';

// A single transcript message from GET /api/claude-session (one JSONL line mapped
// through the server's extractTranscriptMessage: role + human text + timestamp).
// `usage` is present only on assistant turns that spent tokens (WARDEN-474) — the
// per-turn drill-down beneath the session-list total badge (WARDEN-367).
export interface TranscriptMessage {
  role: string;
  text: string;
  ts?: string;
  usage?: { input: number; output: number; cacheCreation: number; cacheRead: number; total: number };
}

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
  const hostLabels = useHostLabels();
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [cwd, setCwd] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState('');
  // Backwards pagination (WARDEN-510). `hasMore`/`prevCursor` come from the server's
  // bounded byte-window read: hasMore means an older window still exists; prevCursor
  // is the byte-offset cursor to fetch it. `loadingEarlier` is DISTINCT from the main
  // loading state so a page fetch never replaces the visible list with skeletons.
  const [hasMore, setHasMore] = useState(false);
  const [prevCursor, setPrevCursor] = useState<number | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [earlierError, setEarlierError] = useState('');

  // The scrollable element is the Radix ScrollArea viewport (data-slot). We reach it
  // from the content wrapper via closest() so prepending older messages can preserve
  // the user's reading position instead of jumping to the top.
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevHeightRef = useRef(0);
  const prevTopRef = useRef(0);
  const restoreScrollRef = useRef(false);
  // Guards against a stale earlier-page fetch applying after the session changes.
  const activeSessionIdRef = useRef<string | null>(null);
  const getViewport = () => scrollRef.current?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null;

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
      setHasMore(false);
      setPrevCursor(null);
      setLoadingEarlier(false);
      setEarlierError('');
      activeSessionIdRef.current = null;
      return;
    }
    if (!session) return;
    let cancelled = false;
    activeSessionIdRef.current = session.id;
    setStatus('loading');
    setMessages([]);
    setCwd('');
    setTruncated(false);
    setError('');
    setHasMore(false);
    setPrevCursor(null);
    setLoadingEarlier(false);
    setEarlierError('');

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
        setHasMore(!!j.hasMore);
        setPrevCursor(typeof j.prevCursor === 'number' ? j.prevCursor : null);
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

  // Fetch the next-older bounded window and PREPEND it. Each window stays within the
  // server's caps; remote paging is one SSH call per page. The control is hidden once
  // hasMore is false (the true start of the transcript has been reached).
  const loadEarlier = async () => {
    if (loadingEarlier || !hasMore || prevCursor == null || !session) return;
    setEarlierError('');
    setLoadingEarlier(true);
    try {
      const r = await fetch(`/api/claude-session?id=${encodeURIComponent(session.id)}&host=${encodeURIComponent(session.host)}&before=${prevCursor}`);
      const j = await r.json();
      // Bail if the session changed/closed while the fetch was in flight.
      if (activeSessionIdRef.current !== session.id) return;
      if (j.error) {
        setEarlierError(j.error === 'host unreachable'
          ? `Host “${session.host}” is unreachable.`
          : j.error);
        return;
      }
      const msgs = Array.isArray(j.messages) ? j.messages : [];
      // Capture the viewport geometry RIGHT BEFORE the prepend so the layout effect
      // below can offset the added height and hold the reading position steady.
      const vp = getViewport();
      prevHeightRef.current = vp?.scrollHeight ?? 0;
      prevTopRef.current = vp?.scrollTop ?? 0;
      restoreScrollRef.current = true;
      setMessages((prev) => [...msgs, ...prev]);
      setHasMore(!!j.hasMore);
      setPrevCursor(typeof j.prevCursor === 'number' ? j.prevCursor : null);
    } catch (e) {
      setEarlierError(e instanceof Error ? e.message : 'Failed to load earlier messages');
    } finally {
      setLoadingEarlier(false);
    }
  };

  // After a prepend commits, restore the scroll offset so older messages load above
  // the current view without jumping. Runs on every messages change but only acts
  // when restoreScrollRef was armed by loadEarlier (not on the initial load/reset).
  useLayoutEffect(() => {
    if (!restoreScrollRef.current) return;
    restoreScrollRef.current = false;
    const vp = getViewport();
    if (!vp) return;
    const added = vp.scrollHeight - prevHeightRef.current;
    vp.scrollTop = prevTopRef.current + Math.max(0, added);
  }, [messages]);

  // WARDEN-490: a labeled host shows its friendly name; an unlabeled host keeps
  // the exact prior string ('this machine' for this host) — byte-identical to
  // today when there is no label.
  const hostLabel = hostLabelFor(session?.host ?? '', hostLabels) || (!session || session.host === '(local)' ? 'this machine' : session.host);

  // Per-turn attribution (WARDEN-474): sum the VISIBLE turns' totals + call out the
  // heaviest visible turn. Recomputed from `messages` via .reduce, so prepending
  // older windows (WARDEN-510) automatically WIDENS the summed badge — older JSONL
  // lines carry their own per-turn usage. The "(of the messages shown)" qualifier is
  // gated on `hasMore` (not `truncated`): it truthfully marks the sum as partial
  // WHILE older pages remain, and drops once every message is loaded — so it stays
  // correct across paginated loads (the session-wide total is the list badge's job).
  const visibleUsage = messages
    .map((m) => m.usage)
    .filter((u): u is NonNullable<TranscriptMessage['usage']> => !!u && u.total > 0);
  const visibleTotal = visibleUsage.reduce((s, u) => s + u.total, 0);
  const heaviest = visibleUsage.length
    ? visibleUsage.reduce((max, u) => (u.total > max.total ? u : max))
    : undefined;

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
          <div ref={scrollRef} className="flex flex-col gap-3 p-4">
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
                {/* Load earlier messages (WARDEN-510): pages BACKWARDS through the
                    transcript one bounded byte-window at a time, prepending older
                    messages. Shown only while hasMore is true (disappears at the true
                    start of the transcript). Uses a DISTINCT loading state so the list
                    is never replaced by skeletons mid-fetch; scroll position is held. */}
                {hasMore && (
                  <div className="flex flex-col items-center gap-1">
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={loadEarlier}
                      disabled={loadingEarlier}
                      className="text-[11px] text-blue-400 hover:text-blue-300"
                    >
                      {loadingEarlier ? (
                        <Loader2Icon className="size-3.5 animate-spin" />
                      ) : (
                        '↑ load earlier messages'
                      )}
                    </Button>
                    {earlierError && (
                      <span className="flex items-center gap-1 text-xs text-red-400">
                        <AlertCircleIcon className="size-3.5 shrink-0" />
                        {earlierError}
                      </span>
                    )}
                  </div>
                )}
                {visibleTotal > 0 && (
                  <div className="flex flex-wrap items-center gap-x-2 rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-1.5 text-xs text-amber-300/90">
                    <span className="font-medium tabular-nums">{formatTokens(visibleTotal)}</span>
                    <span>
                      across {visibleUsage.length} turn{visibleUsage.length === 1 ? '' : 's'}
                      {hasMore ? ' (of the messages shown)' : ''}
                    </span>
                    {heaviest ? (
                      <span className="text-amber-300/70">· heaviest turn {formatTokens(heaviest.total)}</span>
                    ) : null}
                  </div>
                )}
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
  const usage = message.usage;
  const usageLabel = usage ? formatTokens(usage.total) : '';
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div className={cn(
        'max-w-[85%] rounded-lg border px-3 py-2',
        isUser ? 'border-primary/30 bg-primary/10' : 'border-border bg-background',
      )}>
        <div className="mb-1 flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">{isUser ? 'You' : 'Assistant'}</span>
          {message.ts && <span className="text-xs text-muted-foreground/70">{formatTs(message.ts, timestampFormat)}</span>}
          {usage && usageLabel ? (
            <IconTooltip label={<UsageBreakdown usage={usage} />}>
              <span className="ml-auto text-[10px] text-amber-500/80 shrink-0 tabular-nums">{usageLabel}</span>
            </IconTooltip>
          ) : null}
        </div>
        <ObserverMarkdown>{message.text}</ObserverMarkdown>
      </div>
    </div>
  );
}

// Token breakdown shown on hover of a turn's token chip (WARDEN-474). Reuses the
// list badge's exact "model-agnostic — not dollar cost" wording (WARDEN-367) and
// shows the input/output/cache split that turns the chip's total into "where the
// tokens went" — the drill-down a human opens the transcript to find.
function UsageBreakdown({ usage }: { usage: NonNullable<TranscriptMessage['usage']> }) {
  const f = (n: number) => n.toLocaleString();
  return (
    <div className="space-y-0.5">
      <div>Tokens this turn (model-agnostic — not dollar cost):</div>
      <div className="text-muted-foreground">input {f(usage.input)} · output {f(usage.output)}</div>
      <div className="text-muted-foreground">cache write {f(usage.cacheCreation)} · cache read {f(usage.cacheRead)}</div>
      <div className="font-medium">{f(usage.total)} total</div>
    </div>
  );
}

// ISO-ish timestamp → formatted per the Timestamp format pref; fall back to the
// raw value if it isn't a real date so we never drop information.
function formatTs(ts: string, timestampFormat: TimestampFormat): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : formatTimestamp(d, timestampFormat);
}
