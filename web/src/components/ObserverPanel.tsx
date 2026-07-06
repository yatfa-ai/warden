import { useEffect, useRef, useState } from 'react';
import type { ObserveMsg } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';

type Item =
  | { kind: 'user'; text: string }
  | { kind: 'obs'; text: string }
  | { kind: 'tool'; text: string }
  | { kind: 'card'; requestId: string; container: string; role?: string; directive: string; resolved?: boolean; result?: string };

interface Props { sessionId: string }

// One observer conversation, bound to a persisted session (?sid=). History is
// replayed on connect so a refresh/restore shows the prior conversation.
export function ObserverPanel({ sessionId }: Props) {
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [conn, setConn] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let disposed = false;
    let reconnect: ReturnType<typeof setTimeout>;
    const open = () => {
      if (disposed) return;
      const url = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/api/observe?sid=' + encodeURIComponent(sessionId);
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.onopen = () => { if (!disposed) { setConn(true); setItems((p) => p.length ? p : [{ kind: 'tool', text: 'observer connected (GLM)' }]); } };
      ws.onclose = () => { wsRef.current = null; setConn(false); if (!disposed) reconnect = setTimeout(open, 1500); };
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
        else if (m.type === 'error') setItems((p) => [...p, { kind: 'tool', text: 'error: ' + m.error }]);
      };
    };
    open();
    return () => { disposed = true; clearTimeout(reconnect); wsRef.current?.close(); };
  }, [sessionId]);

  const send = (text: string) => {
    if (!wsRef.current || wsRef.current.readyState !== 1) return;
    setItems((p) => [...p, { kind: 'user', text }]);
    setBusy(true);
    wsRef.current.send(JSON.stringify({ type: 'user', text }));
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
            return (
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
          })}
        </div>
      </ScrollArea>
      <form
        className="flex items-center gap-2 px-2 py-2 border-t shrink-0"
        onSubmit={(e) => { e.preventDefault(); const el = e.currentTarget.elements.namedItem('msg') as HTMLInputElement; if (el?.value.trim()) { send(el.value.trim()); el.value = ''; } }}
      >
        <Input name="msg" placeholder="ask the observer…" />
        <Button type="submit" size="sm">send</Button>
      </form>
    </div>
  );
}
