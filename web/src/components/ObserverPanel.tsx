import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertCircleIcon,
  ArrowDownIcon,
  CheckIcon,
  EyeIcon,
  Loader2Icon,
  PencilIcon,
  RefreshCwIcon,
  SendHorizontalIcon,
  SparklesIcon,
  SquareIcon,
  TargetIcon,
  UserIcon,
  XIcon,
} from 'lucide-react';
import type { ChatContextMeta, ObserveMsg } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useNotificationPrefs } from '@/lib/useNotificationPrefs';
import { useStickToBottom } from '@/lib/useStickToBottom';
import { ObserverMarkdown } from '@/components/ObserverMarkdown';

// One entry in the conversation timeline. Observer text is streamed: an observer
// item is created `streaming` while the assistant is emitting, then finalized on
// `done` (or when a tool/card interrupts). `ts` is the arrival time; replayed
// history has no timestamp (ts = 0) and simply omits the clock.
type Item =
  | { id: string; kind: 'user'; text: string; ts: number }
  | { id: string; kind: 'observer'; text: string; ts: number; streaming: boolean }
  | { id: string; kind: 'tool'; name: string; arg?: string; ts: number }
  | { id: string; kind: 'meta'; text: string; tone: 'info' | 'error'; ts: number }
  | {
      id: string;
      kind: 'card';
      requestId: string;
      container: string;
      role?: string;
      directive: string;
      resolved?: boolean;
      result?: string;
      ts: number;
    }
  | {
      id: string;
      kind: 'suggestion';
      agentId: string;
      agentName: string;
      role?: string;
      urgency: string;
      state: string;
      action: string;
      dismissed?: boolean;
      ts: number;
    };

interface Props {
  sessionId: string;
  onFocusAgent?: (id: string) => void;
}

const MAX_COMPOSER_HEIGHT = 160; // px — must match the `max-h-40` class (10rem)

// One observer conversation, bound to a persisted session (?sid=). History is
// replayed on connect so a refresh/restore shows the prior conversation.
export function ObserverPanel({ sessionId, onFocusAgent }: Props) {
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [conn, setConn] = useState(false);
  const [draft, setDraft] = useState('');
  const [userStopped, setUserStopped] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [loadingTimeout, setLoadingTimeout] = useState(false);
  const [chatContext, setChatContext] = useState<ChatContextMeta | null>(null);
  // Styled replacement for the native directive-edit prompt. The value/requestId
  // persist while `open` toggles so the textarea doesn't flash empty during the
  // dialog's close animation. Cancel (close) must NOT call `decide`; only the
  // submit button does — matching the old OK-with-empty-sent-decide(...,true,'').
  const [editState, setEditState] = useState<{ open: boolean; requestId: string; value: string }>({
    open: false,
    requestId: '',
    value: '',
  });

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectionTimeoutShownRef = useRef(false);
  const mountedRef = useRef(true);
  // `connect` is memoized without `conn` in its deps (including it would tear
  // down + reopen the socket every time connection state flipped). The 15s
  // timeout closure reads the live connection state through this ref instead.
  const connRef = useRef(false);
  useEffect(() => {
    connRef.current = conn;
  }, [conn]);
  const idCounter = useRef(0);
  const forceBottomRef = useRef(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const { prefs } = useNotificationPrefs();
  // `connect` is memoized on [sessionId] only (adding prefs would reconnect the
  // WebSocket on every preference change), so the 15s timeout closure captures a
  // stale notifyObserver value. Read the latest value from a ref.
  const notifyObserverRef = useRef(prefs.notifyObserver);
  useEffect(() => {
    notifyObserverRef.current = prefs.notifyObserver;
  }, [prefs.notifyObserver]);

  const nextId = useCallback(() => `m${++idCounter.current}`, []);
  const { rootRef, atBottom, scrollToBottom, stickIfPinned } = useStickToBottom();

  // Append streamed assistant text. While the last item is a streaming observer
  // message, keep growing it; otherwise start a new turn. `finalize` closes the
  // stream (the `done` event).
  const appendObserverText = useCallback(
    (text: string, finalize: boolean) => {
      setItems((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.kind === 'observer' && last.streaming) {
          const updated: Item = { ...last, text: last.text + text, streaming: !finalize };
          return [...prev.slice(0, -1), updated];
        }
        const created: Item = {
          id: nextId(),
          kind: 'observer',
          text,
          ts: Date.now(),
          streaming: !finalize,
        };
        return [...prev, created];
      });
    },
    [nextId],
  );

  // Mark the current streaming observer message complete (no text change). Used
  // when a tool/card/error interrupts, or `done` arrives empty.
  const finalizeStreaming = useCallback(() => {
    setItems((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.kind === 'observer' && last.streaming) {
        return [...prev.slice(0, -1), { ...last, streaming: false }];
      }
      return prev;
    });
  }, []);

  const pushItem = useCallback(
    (item: Item) => {
      finalizeStreaming();
      setItems((prev) => [...prev, item]);
    },
    [finalizeStreaming],
  );

  const connect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (loadingTimeoutRef.current) {
      clearTimeout(loadingTimeoutRef.current);
      loadingTimeoutRef.current = null;
    }
    if (connectionTimeoutRef.current) {
      clearTimeout(connectionTimeoutRef.current);
      connectionTimeoutRef.current = null;
    }
    if (wsRef.current) wsRef.current.close();
    setUserStopped(false);
    setConnectionError(null);
    setLoadingTimeout(false);
    setChatContext(null);
    setBusy(false);
    connectionTimeoutShownRef.current = false;

    // Loading hint (10s) and hard connection-failure error (15s).
    loadingTimeoutRef.current = setTimeout(() => {
      if (mountedRef.current) setLoadingTimeout(true);
    }, 10000);
    connectionTimeoutRef.current = setTimeout(() => {
      if (!connRef.current && !connectionTimeoutShownRef.current && mountedRef.current) {
        connectionTimeoutShownRef.current = true;
        setConnectionError('Connection timeout. Unable to establish WebSocket connection.');
        if (notifyObserverRef.current)
          toast.error('Observer connection timeout. Please try reconnecting.');
      }
    }, 15000);

    const url =
      (location.protocol === 'https:' ? 'wss' : 'ws') +
      '://' +
      location.host +
      '/api/observe?sid=' +
      encodeURIComponent(sessionId);
    const ws = new WebSocket(url);
    wsRef.current = ws;
    ws.onopen = () => {
      if (!mountedRef.current) return;
      setConn(true);
      setConnectionError(null);
      setLoadingTimeout(false);
      connectionTimeoutShownRef.current = false;
      if (loadingTimeoutRef.current) clearTimeout(loadingTimeoutRef.current);
      if (connectionTimeoutRef.current) clearTimeout(connectionTimeoutRef.current);
      setItems((p) =>
        p.length ? p : [{ id: nextId(), kind: 'meta', text: 'Observer connected', tone: 'info', ts: Date.now() }],
      );
    };
    ws.onclose = () => {
      if (!mountedRef.current) return;
      wsRef.current = null;
      setConn(false);
      setBusy(false);
      if (!userStopped)
        reconnectTimeoutRef.current = setTimeout(() => {
          if (mountedRef.current) connect();
        }, 1500);
    };
    ws.onerror = (e) => {
      if (!mountedRef.current) return;
      setConnectionError('WebSocket connection error. Will attempt to reconnect...');
      console.error('WebSocket error:', e);
    };
    ws.onmessage = (e) => {
      if (!mountedRef.current) return;
      const m: ObserveMsg = JSON.parse(e.data);
      switch (m.type) {
        case 'history':
          setChatContext(m.chatContext ?? null);
          setItems(
            m.items.map((i): Item => {
              if (i.role === 'user')
                return { id: nextId(), kind: 'user', text: i.text || '', ts: 0 };
              if (i.role === 'assistant')
                return { id: nextId(), kind: 'observer', text: i.text || '', ts: 0, streaming: false };
              return { id: nextId(), kind: 'tool', name: i.name || 'tool', arg: i.id || undefined, ts: 0 };
            }),
          );
          return;
        case 'session_created':
          setChatContext(m.chatContext ?? null);
          return;
        case 'thinking':
          setBusy(true);
          return;
        case 'assistant':
          appendObserverText(m.text, false);
          return;
        case 'done':
          if (m.text?.trim()) appendObserverText(m.text, true);
          else finalizeStreaming();
          setBusy(false);
          return;
        case 'error':
          pushItem({ id: nextId(), kind: 'meta', text: m.error, tone: 'error', ts: Date.now() });
          setBusy(false);
          return;
        case 'tool':
          pushItem({ id: nextId(), kind: 'tool', name: m.name, arg: m.input?.id, ts: Date.now() });
          return;
        case 'directive_proposed':
          pushItem({
            id: nextId(),
            kind: 'card',
            requestId: m.requestId,
            container: m.container,
            role: m.role,
            directive: m.directive,
            ts: Date.now(),
          });
          return;
        case 'suggestion_card':
          pushItem({
            id: nextId(),
            kind: 'suggestion',
            agentId: m.agentId,
            agentName: m.agentName,
            role: m.role,
            urgency: m.urgency,
            state: m.state,
            action: m.action,
            ts: Date.now(),
          });
          return;
        default:
          return;
      }
    };
  }, [sessionId, appendObserverText, finalizeStreaming, pushItem, nextId]);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (loadingTimeoutRef.current) clearTimeout(loadingTimeoutRef.current);
      if (connectionTimeoutRef.current) clearTimeout(connectionTimeoutRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  // Auto-grow the composer to fit its content, capped to match the CSS max. The
  // JS cap (MAX_COMPOSER_HEIGHT) and the `max-h-40` class MUST agree — see the
  // inline-style/CSS maxima gotcha — so the cap is a named constant, not magic.
  const autoGrow = useCallback(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_COMPOSER_HEIGHT)}px`;
  }, []);
  useLayoutEffect(() => {
    autoGrow();
  }, [draft, autoGrow]);

  // Keep the view pinned to the latest message as content streams in (unless the
  // user has scrolled up to read history). A send forces a jump to the bottom.
  useLayoutEffect(() => {
    if (forceBottomRef.current) {
      forceBottomRef.current = false;
      scrollToBottom();
    } else {
      stickIfPinned();
    }
  }, [items, busy, scrollToBottom, stickIfPinned]);

  const send = (text: string) => {
    if (!wsRef.current || wsRef.current.readyState !== wsRef.current.OPEN) return;
    setItems((p) => [...p, { id: nextId(), kind: 'user', text, ts: Date.now() }]);
    setBusy(true);
    forceBottomRef.current = true;
    // Open panes are surfaced to the observer as the chats worth watching. This
    // reads sibling pane elements (not this component's own state) and is part of
    // the preserved functional core — it is not the composer-value DOM hack.
    const panes = Array.from(document.querySelectorAll('[data-pane-id]'))
      .map((el) => el.getAttribute('data-pane-id'))
      .filter(Boolean) as string[];
    wsRef.current.send(JSON.stringify({ type: 'user', text, panes }));
  };

  const submit = () => {
    const text = draft.trim();
    if (!text || busy || !conn) return;
    setDraft('');
    send(text);
  };

  const stop = () => {
    setUserStopped(true);
    if (wsRef.current) {
      wsRef.current.close();
      setBusy(false);
      pushItem({ id: nextId(), kind: 'meta', text: 'Stopped', tone: 'info', ts: Date.now() });
    }
  };

  const reconnect = () => {
    pushItem({ id: nextId(), kind: 'meta', text: 'Reconnecting…', tone: 'info', ts: Date.now() });
    connect();
  };

  const decide = (requestId: string, approved: boolean, edited?: string) => {
    wsRef.current?.send(JSON.stringify({ type: 'gate_decision', requestId, approved, edited }));
    setItems((p) =>
      p.map((it) =>
        it.kind === 'card' && it.requestId === requestId
          ? { ...it, resolved: true, result: approved ? 'sent' : 'declined' }
          : it,
      ),
    );
  };

  const dismissSuggestion = (id: string) =>
    setItems((p) => p.map((it) => (it.id === id && it.kind === 'suggestion' ? { ...it, dismissed: true } : it)));

  const pendingGate = items.some((it) => it.kind === 'card' && !it.resolved);
  const last = items[items.length - 1];
  const lastStreamingObs = !!last && last.kind === 'observer' && last.streaming;
  // While the assistant works (but isn't paused on a directive gate, and hasn't
  // started emitting text yet), show a thinking turn.
  const showThinking = busy && !pendingGate && !lastStreamingObs;
  const showJump = !atBottom && items.length > 0;
  const canSend = conn && !busy && draft.trim().length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Status / context bar */}
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
        <span
          className={`size-2 shrink-0 rounded-full ${conn ? 'bg-green-500' : 'bg-red-500'}`}
          title={conn ? 'connected' : connectionError || 'reconnecting…'}
        />
        {chatContext?.chatKey ? (
          <span
            className="flex-1 truncate"
            title={`bound to ${chatContext.container || chatContext.chatKey}${chatContext.role ? ` (${chatContext.role})` : ''} @ ${chatContext.host || 'local'}`}
          >
            <EyeIcon className="mr-1 inline size-3 align-middle" />
            <span className="text-foreground/80">{chatContext.container || chatContext.chatKey}</span>
            {chatContext.host && chatContext.host !== '(local)' ? ` @${chatContext.host}` : ''}
          </span>
        ) : (
          <span className="flex-1">drafts directives you approve</span>
        )}
        {loadingTimeout && !conn && <span className="italic text-yellow-500">taking longer than expected…</span>}
      </div>

      {/* Conversation */}
      <div ref={rootRef} className="relative min-h-0 flex-1">
        <ScrollArea className="h-full">
          <div className="flex flex-col gap-3 p-3">
            {!conn && !connectionError && (
              <div className="flex flex-col items-center justify-center gap-2 py-10 text-muted-foreground">
                <Loader2Icon className="size-5 animate-spin" />
                <span className="text-xs">
                  {loadingTimeout ? 'Taking longer than expected…' : 'Connecting to observer…'}
                </span>
              </div>
            )}
            {connectionError && !conn && (
              <div className="flex flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                <div className="flex items-center gap-2">
                  <AlertCircleIcon className="size-4 shrink-0" />
                  <span>{connectionError}</span>
                </div>
                <Button size="sm" variant="outline" onClick={reconnect} className="self-start">
                  <RefreshCwIcon /> Reconnect
                </Button>
              </div>
            )}
            {conn && items.length === 0 && !busy && (
              <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
                <div className="rounded-full bg-muted/60 p-2.5">
                  <EyeIcon className="size-5 text-muted-foreground/50" />
                </div>
                <div className="text-sm text-muted-foreground">Observer is ready</div>
                <div className="text-xs text-muted-foreground/60">
                  Ask what your agents are working on, or request a summary.
                </div>
              </div>
            )}

            {items.map((it) => {
              if (it.kind === 'user') return <UserRow key={it.id} text={it.text} ts={it.ts} />;
              if (it.kind === 'observer')
                return <ObserverRow key={it.id} text={it.text} ts={it.ts} streaming={it.streaming} />;
              if (it.kind === 'tool') return <ToolChip key={it.id} name={it.name} arg={it.arg} />;
              if (it.kind === 'meta') return <MetaLine key={it.id} text={it.text} tone={it.tone} />;
              if (it.kind === 'card')
                return <DirectiveCard key={it.id} card={it} onApprove={decide} onEdit={setEditState} onDecline={decide} />;
              if (it.kind === 'suggestion' && !it.dismissed)
                return (
                  <SuggestionCard
                    key={it.id}
                    suggestion={it}
                    onFocus={(agentId) => {
                      onFocusAgent?.(agentId);
                      dismissSuggestion(it.id);
                    }}
                    onDismiss={() => dismissSuggestion(it.id)}
                  />
                );
              return null;
            })}

            {showThinking && <ThinkingRow />}
          </div>
        </ScrollArea>

        {showJump && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => scrollToBottom('smooth')}
            className="absolute bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-full shadow-md"
          >
            <ArrowDownIcon /> Jump to latest
          </Button>
        )}
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t p-3">
        <div className="flex flex-col gap-2 rounded-xl border bg-background p-2 focus-within:ring-2 focus-within:ring-ring/40">
          <Textarea
            ref={taRef}
            data-observer-composer
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={conn ? 'Ask the observer…  (Enter to send, Shift+Enter for newline)' : 'Connecting…'}
            rows={1}
            disabled={!conn}
            className="min-h-9 max-h-40 resize-none border-0 bg-transparent p-0 shadow-none focus-visible:ring-0"
          />
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || !conn}
                onClick={() => send('summarize what everyone is working on')}
                title="Ask the Observer to read all open tabs and summarize"
              >
                <SparklesIcon /> Summarize
              </Button>
            </div>
            <div className="flex items-center gap-1">
              {busy && (
                <Button size="sm" variant="destructive" onClick={stop}>
                  <SquareIcon /> Stop
                </Button>
              )}
              {!conn && !busy && (
                <Button size="sm" variant="outline" onClick={reconnect}>
                  <RefreshCwIcon /> Reconnect
                </Button>
              )}
              <Button size="sm" onClick={submit} disabled={!canSend}>
                <SendHorizontalIcon /> Send
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Directive edit dialog */}
      <Dialog open={editState.open} onOpenChange={(o) => setEditState((s) => ({ ...s, open: o }))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit directive</DialogTitle>
            <DialogDescription>Edit the proposed directive before approving and sending.</DialogDescription>
          </DialogHeader>
          <Textarea
            value={editState.value}
            onChange={(e) => setEditState((s) => ({ ...s, value: e.target.value }))}
            rows={6}
            className="resize-y"
            autoFocus
          />
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              onClick={() => {
                decide(editState.requestId, true, editState.value);
                setEditState((s) => ({ ...s, open: false }));
              }}
            >
              Approve &amp; send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* --------------------------------- rows ---------------------------------- */

function Avatar({ kind }: { kind: 'user' | 'observer' }) {
  return (
    <div
      className={`flex size-7 shrink-0 items-center justify-center rounded-full ${
        kind === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground/70'
      }`}
    >
      {kind === 'user' ? <UserIcon className="size-4" /> : <EyeIcon className="size-4" />}
    </div>
  );
}

function Clock({ ts }: { ts: number }) {
  if (!ts) return null;
  const time = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return <span className="tabular-nums">{time}</span>;
}

function UserRow({ text, ts }: { text: string; ts: number }) {
  return (
    <div className="flex flex-row-reverse items-start gap-2">
      <Avatar kind="user" />
      <div className="flex min-w-0 max-w-[85%] flex-col items-end gap-1">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/70">You</span>
          <Clock ts={ts} />
        </div>
        <div className="whitespace-pre-wrap break-words rounded-2xl rounded-tr-sm border border-primary/20 bg-primary/10 px-3 py-2 text-sm">
          {text}
        </div>
      </div>
    </div>
  );
}

function ObserverRow({ text, ts, streaming }: { text: string; ts: number; streaming: boolean }) {
  return (
    <div className="flex items-start gap-2">
      <Avatar kind="observer" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/70">Observer</span>
          <Clock ts={ts} />
        </div>
        <div className="rounded-2xl rounded-tl-sm border bg-muted/40 px-3 py-2">
          <ObserverMarkdown>{text}</ObserverMarkdown>
          {streaming && <span className="ml-0.5 inline-block h-3 w-0.5 animate-pulse bg-foreground/60 align-middle" />}
        </div>
      </div>
    </div>
  );
}

function ThinkingRow() {
  return (
    <div className="flex items-start gap-2">
      <Avatar kind="observer" />
      <div className="flex items-center gap-2 rounded-2xl rounded-tl-sm border bg-muted/40 px-3 py-2 text-muted-foreground">
        <Loader2Icon className="size-3.5 animate-spin" />
        <span className="text-xs">Thinking…</span>
      </div>
    </div>
  );
}

function ToolChip({ name, arg }: { name: string; arg?: string }) {
  return (
    <div className="flex items-center gap-1.5 pl-9 text-xs text-muted-foreground">
      <span className="size-1 rounded-full bg-current opacity-50" />
      <span className="font-mono">{toolLabel(name)}</span>
      {arg && <span className="opacity-70">· {arg}</span>}
    </div>
  );
}

function MetaLine({ text, tone }: { text: string; tone: 'info' | 'error' }) {
  return (
    <div className="flex justify-center">
      <span
        className={`rounded-full px-2.5 py-0.5 text-xs ${
          tone === 'error' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'
        }`}
      >
        {text}
      </span>
    </div>
  );
}

function DirectiveCard({
  card,
  onApprove,
  onEdit,
  onDecline,
}: {
  card: Extract<Item, { kind: 'card' }>;
  onApprove: (requestId: string, approved: boolean) => void;
  onEdit: (s: { open: boolean; requestId: string; value: string }) => void;
  onDecline: (requestId: string, approved: boolean) => void;
}) {
  return (
    <div className="pl-9">
      <div className={`flex flex-col gap-2 rounded-xl border bg-card p-3 ${card.resolved ? 'opacity-70' : ''}`}>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="secondary" className="gap-1">
            <SendHorizontalIcon className="size-3" /> proposed directive
          </Badge>
          <span className="text-muted-foreground">
            {card.container}
            {card.role ? ` · ${card.role}` : ''}
          </span>
        </div>
        <div className="whitespace-pre-wrap break-words rounded-lg border bg-muted/40 p-2 text-sm">{card.directive}</div>
        {card.resolved ? (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {card.result === 'sent' ? (
              <>
                <CheckIcon className="size-3.5 text-green-500" /> Sent
              </>
            ) : (
              <>
                <XIcon className="size-3.5 text-destructive" /> Declined
              </>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" onClick={() => onApprove(card.requestId, true)}>
              Approve &amp; send
            </Button>
            <Button size="sm" variant="outline" onClick={() => onEdit({ open: true, requestId: card.requestId, value: card.directive })}>
              <PencilIcon /> Edit
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onDecline(card.requestId, false)}>
              Decline
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function SuggestionCard({
  suggestion: s,
  onFocus,
  onDismiss,
}: {
  suggestion: Extract<Item, { kind: 'suggestion' }>;
  onFocus: (agentId: string) => void;
  onDismiss: () => void;
}) {
  return (
    <div className="pl-9">
      <div className="flex flex-col gap-2 rounded-xl border bg-card p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={urgencyVariant(s.urgency)} className="capitalize">
            {s.urgency}
          </Badge>
          <span className="text-xs font-medium">
            {s.agentName}
            {s.role ? ` · ${s.role}` : ''}
          </span>
          <span className="text-xs text-muted-foreground">{s.state}</span>
        </div>
        <div className="whitespace-pre-wrap break-words text-sm">{s.action}</div>
        <div className="flex gap-1.5">
          <Button size="sm" onClick={() => onFocus(s.agentId)}>
            <TargetIcon /> Focus
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------- helpers -------------------------------- */

const TOOL_LABELS: Record<string, string> = {
  list_chats: 'list chats',
  read_chat: 'read chat',
  read_chats: 'read chats',
  send_directive: 'compose directive',
  summarize_chats: 'summarize chats',
  analyze_agents: 'analyze agents',
  suggest_next_actions: 'suggest actions',
};

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name.replace(/_/g, ' ');
}

function urgencyVariant(urgency: string): 'destructive' | 'default' | 'secondary' {
  if (urgency === 'urgent') return 'destructive';
  if (urgency === 'important') return 'default';
  return 'secondary';
}
