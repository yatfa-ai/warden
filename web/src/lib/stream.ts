import type { StreamMsg, StreamReq } from './types';

// Singleton pane-stream client: one WS to /api/stream for the whole app.
// Tiles register a handler keyed by container id; App calls connect() on mount.
class StreamApi {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<(m: StreamMsg) => void>>();
  private pending: StreamReq[] = [];
  private connecting = false;
  onOpen: (() => void) | null = null;
  onClose: (() => void) | null = null;
  onAnyMessage: ((m: StreamMsg) => void) | null = null;

  connect() {
    if (this.ws || this.connecting) return;
    this.connecting = true;
    const url = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/api/stream';
    const ws = new WebSocket(url);
    ws.onopen = () => {
      this.connecting = false;
      const p = this.pending.splice(0); for (const m of p) this._raw(m);
      this.onOpen?.();
    };
    ws.onclose = () => { this.ws = null; this.connecting = false; this.onClose?.(); setTimeout(() => this.connect(), 1500); };
    ws.onmessage = (e) => {
      let m: StreamMsg;
      try { m = JSON.parse(e.data); } catch { return; }
      this.onAnyMessage?.(m);
      const set = this.handlers.get(m.id);
      if (set) for (const fn of [...set]) fn(m);
    };
    this.ws = ws;
  }

  get ready() { return this.ws?.readyState === 1; }

  private _raw(m: StreamReq) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); }

  send(m: StreamReq) {
    if (this.ws && this.ws.readyState === 1) this._raw(m);
    else this.pending.push(m);
  }

  on(id: string, fn: (m: StreamMsg) => void): () => void {
    let set = this.handlers.get(id);
    if (!set) { set = new Set(); this.handlers.set(id, set); }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.handlers.delete(id);
    };
  }
}

export const streamApi = new StreamApi();
