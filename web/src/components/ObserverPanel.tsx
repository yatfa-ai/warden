import { useEffect, useRef, useState, useCallback } from 'react';
import type { ObserveMsg } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';

type Item =
  | { kind: 'user'; text: string }
  | { kind: 'obs'; text: string }
  | { kind: 'tool'; text: string }
  | { kind: 'card'; requestId: string; container: string; role?: string; directive: string; resolved?: boolean; result?: string }
  | { kind: 'suggestion'; agentId: string; agentName: string; role?: string; urgency: string; state: string; action: string; dismissed?: boolean };

interface Props {
  sessionId: string;
  onFocusAgent?: (id: string) => void;
}

// One observer conversation, bound to a persisted session (?sid=). History is
// replayed on connect so a refresh/restore shows the prior conversation.
export function ObserverPanel({ sessionId, onFocusAgent }: Props) {
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [conn, setConn] = useState(false);
  const [userStopped, setUserStopped] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
    }
    setUserStopped(false);
    const url = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/api/observe?sid=' + encodeURIComponent(sessionId);
    const ws = new WebSocket(url);
    wsRef.current = ws;
    ws.onopen = () => { setConn(true); setItems((p) => p.length ? p : [{ kind: 'tool', text: 'observer connected (GLM)' }]); };
    ws.onclose = () => { wsRef.current = null; setConn(false); if (!userStopped) reconnectTimeoutRef.current = setTimeout(connect, 1500); };
    ws.onmessage = (e) => {
      const m: ObserveMsg = JSON.parse(e.data);
      if (m.type === 'history') {
        setItems(m.items.map((i) => i.role === 'user'
          ? { kind: 'user', text: i.text || '' }
          : i.role === 'assistant' ? { kind: 'obs', text: i.text || '' }
          : { kind: 'tool', text: `➐ ${i.name}(${i.id || ''})` }));
        return;
      }
      if (m.type === 'thinking') { setBusy(true); return; }
      setBusy(false);
      if (m.type === 'tool') setItems((p) => [...p, { kind: 'tool', text: `➐ ${m.name}(${m.input?.id || ''})` }]);
      else if (m.type === 'assistant') setItems((p) => [...p, { kind: 'obs', text: m.text }]);
      else if (m.type === 'done') { if (m.text?.trim()) setItems((p) => [...p, { kind: 'obs', text: m.text }]); }
      else if (m.type === 'directive_proposed') setItems((p) => [...p, { kind: 'card', requestId: m.requestId, container: m.container, role: m.role, directive: m.directive }]);
      else if (m.type === 'suggestion_card') setItems((p) => [...p, { kind: 'suggestion', agentId: m.agentId, agentName: m.agentName, role: m.role, urgency: m.urgency, state: m.state, action: m.action }]);
      else if (m.type === 'error') setItems((p) => [...p, { kind: 'tool', text: 'error: ' + m.error }]);
    };
  }, [sessionId]);

  const urgencyColors = {
    urgent: 'bg-red-900/40 border-red-600/50 text-red-300',
    important: 'bg-yellow-900/40 border-yellow-600/50 text-yellow-300',
    informational: 'bg-gray-800/40 border-gray-600/50 text-gray-300'
  };

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const send = (text: string) => {
    if (!wsRef.current || wsRef.current.readyState !== 1) return;
    setItems((p) => [...p, { kind: 'user', text }]);
    setBusy(true);
    const panes = Array.from(document.querySelectorAll('[data-pane-id]')).map((el) => el.getAttribute('data-pane-id')).filter(Boolean);
    wsRef.current.send(JSON.stringify({ type: 'user', text, panes }));
  };
  const stop = () => {
    setUserStopped(true);
    if (wsRef.current) { wsRef.current.close(); setBusy(false); setItems((p) => [...p, { kind: 'tool', text: '(stopped)' }]); }
  };
  const reconnect = () => {
    connect();
    setItems((p) => [...p, { kind: 'tool', text: '(reconnecting…)' }]);
  };
  const onTextareaInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const ta = e.target as HTMLTextAreaElement;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  };
  const decide = (requestId: string, approved: boolean, edited?: string) => {
    wsRef.current?.send(JSON.stringify({ type: 'gate_decision', requestId, approved, edited }));
    setItems((p) => p.map((it) => it.kind === 'card' && it.requestId === requestId ? { ...it, resolved: true, result: approved ? 'sent' : 'declined' } : it));
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b text-xs text-muted-foreground shrink-0">
        <span className={`size-2 rounded-full ${conn ? 'bg-green-500' : 'bg-red-500'}`} title={conn ? 'connected' : 'reconnecting…'} />
        <span className="flex-1">drafts directives you approve</span>
        {busy && <span className="italic">thinking…</span>}
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <div className="flex flex-col gap-2 p-3">
          {items.map((it, i) => {
            if (it.kind === 'user') return <div key={i} className="self-end max-w-full bg-primary/15 border border-primary/30 rounded-2xl px-3 py-1.5 text-sm whitespace-pre-wrap break-words">{it.text}</div>;
            if (it.kind === 'obs') return <div key={i} className="self-start max-w-full bg-secondary border rounded-2xl px-3 py-1.5 text-sm whitespace-pre-wrap break-words">{it.text}</div>;
            if (it.kind === 'tool') return <div key={i} className="self-start text-xs italic text-muted-foreground">{it.text}</div>;
            if (it.kind === 'card') return (
              <div key={i} className={`self-start max-w-full bg-green-900/30 border border-green-600/40 rounded-2xl p-2.5 text-sm ${it.resolved ? 'opacity-60' : ''}`}>
                <div className="text-xs text-green-400 mb-1">→ proposed directive: {it.container}{it.role ? ` · ${it.role}` : ''}</div>
                <div className="bg-black/60 border rounded-md p-2 whitespace-pre-wrap break-words">{it.directive}</div>
                {it.resolved ? (
                  <div className="text-xs text-muted-foreground mt-1.5">{it.result === 'sent' ? '✓ sent' : '✗ declined'}</div>
                ) : (
                  <div className="flex gap-1.5 mt-2">
                    <Button size="sm" className="h-7" onClick={() => decide(it.requestId, true)}>approve &amp; send</Button>
                    <Button size="sm" variant="outline" className="h-7" onClick={() => { const v = prompt('edit directive:', it.directive); if (v != null) decide(it.requestId, true, v); }}>edit</Button>
                    <Button size="sm" variant="ghost" className="h-7" onClick={() => decide(it.requestId, false)}>decline</Button>
                  </div>
                )}
              </div>
            );
            if (it.kind === 'suggestion' && !it.dismissed) return (
              <div key={i} className={`self-start max-w-full bg-secondary/40 border rounded-2xl p-2.5 text-sm ${urgencyColors[it.urgency as keyof typeof urgencyColors] || urgencyColors.informational}`}>
                <div className="text-xs mb-1 font-medium">{it.agentName}{it.role ? ` · ${it.role}` : ''}</div>
                <div className="text-xs opacity-80 mb-1">{it.state}</div>
                <div className="bg-black/60 border rounded-md p-2 whitespace-pre-wrap break-words text-xs">{it.action}</div>
                <div className="flex gap-1.5 mt-2">
                  <Button size="sm" className="h-7" onClick={() => {
                    onFocusAgent?.(it.agentId);
                    setItems((p) => p.map((item, idx) => idx === i ? { ...item, dismissed: true } : item));
                  }}>Focus</Button>
                  <Button size="sm" variant="ghost" className="h-7" onClick={() => {
                    setItems((p) => p.map((item, idx) => idx === i ? { ...item, dismissed: true } : item));
                  }}>Dismiss</Button>
                </div>
              </div>
            );
            return <div key={i} className="self-start text-xs italic text-muted-foreground">(unknown item kind)</div>;
          })}
        </div>
      </ScrollArea>
      <div className="flex items-end gap-2 px-3 py-3 border-t shrink-0">
        <Textarea
          name="msg"
          placeholder="ask the observer… (Shift+Enter for newline)"
          rows={1}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const el = e.target as HTMLTextAreaElement; if (el.value.trim()) { send(el.value.trim()); el.value = ''; } } }}
          onInput={onTextareaInput}
          disabled={!conn}
          className="flex-1 resize-y min-h-[80px] max-h-[200px] overflow-y-auto disabled:opacity-50"
        />
        {busy && <Button type="button" size="sm" variant="destructive" onClick={stop} className="shrink-0">stop</Button>}
        {!conn && !busy && <Button type="button" size="sm" variant="outline" onClick={reconnect} className="shrink-0">reconnect</Button>}
        <Button type="button" size="sm" variant="outline" disabled={busy || !conn} className="shrink-0"
          onClick={() => {
            send("summarize what everyone is working on");
          }}
          title="Ask the Observer to read all open tabs and summarize"
        >summarize</Button>
        <Button type="button" size="sm" disabled={busy || !conn} className="shrink-0"
          onClick={() => {
            const el = document.querySelector('textarea[name="msg"]') as HTMLTextAreaElement;
            if (el?.value.trim()) {
              send(el.value.trim());
              el.value = '';
              el.style.height = 'auto';
            }
          }}
        >send</Button>
      </div>
    </div>
  );
}
