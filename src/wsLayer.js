// The WebSocket layer of the warden dashboard — the two `noServer` WebSocketServers
// (`wss`: /api/observe chat + observer traffic; `streamWss`: /api/stream live PTY
// attach + pane monitors) and the http `upgrade` router that dispatches between
// them. Extracted verbatim from src/server.js (WARDEN-1381) as the next slice of
// the sanctioned god-module decomposition, sibling to gitRoutes.js (WARDEN-734),
// claudeSessions.js (WARDEN-677) and the other extracted layers.
//
// Side-effect-free at module load: the only project imports are already-extracted
// leaf modules (observer.js, llm.js, sessions.js, activity.js, originGuard.js)
// plus streamConnection.js (the /api/stream per-connection machinery, moved there
// verbatim by WARDEN-1933), none of which boot anything, so importing this module
// does NOT read config or open sockets (mirrors gitRoutes.js / claudeSessions.js).
// The http server instance and the chat-scoped state (`cfg`, `resolve`,
// `chatCatalog`) live in server.js and are passed into `setupWsLayer` — and on
// into `wireStreamConnection` — so this module never imports server.js; the
// dependency stays one-directional (server.js -> wsLayer.js -> streamConnection.js),
// avoiding a cycle.
//
// WARDEN-1385 — `paneInputTelemetry` is an OPTIONAL injected producer (created
// in server.js; tests omit it and the correlation calls vanish). When present
// it sees the two server-side hops of a keystroke's journey: the WRITE leg
// (WS message → pty.write done) and the ROUND-TRIP leg (pty.write done → that
// pane's next output chunk — the tmux echo). It never alters the data path:
// both note* calls are fire-and-forget, and a throwing producer is caught so
// the observation of the path can never be the thing that breaks the path.
//
// The `server` the upgrade router binds to MUST be the same instance server.js
// exports as `server` (the test seam: the suites listen on the exported instance
// precisely so THIS module's upgrade handler answers them — app.listen() would
// create a different http server with no WS routing and the WS clients would never
// get an upgrade response). src/server-stream-reattach.test.js is the referee for
// exactly this property.

import { WebSocketServer } from 'ws';
import { Observer } from './observer.js';
import { hasCredentials, resolveModel } from './llm.js';
import { createSession, isValidSessionId } from './sessions.js';
import { appendEvent } from './activity.js';
import { isAllowedOrigin, isAllowedHost, boundHostOf } from './originGuard.js';
import { wireStreamConnection } from './streamConnection.js';

// The host sentinel for "run on this machine, not over SSH" (mirrors server.js's
// LOCAL — duplicated rather than imported to keep this a leaf module; the test suites
// already hardcode this same string).
const LOCAL = '(local)';

// WARDEN-1653 — an activity-log write failure (full disk, EACCES, bad HOME) must never
// escape a ws.on('message', async …) / pty.onExit(async …) callback: `ws` does not await
// listener promises, so a rejection is an unhandledRejection that terminates the process
// (Node >= 15). Mirrors server.js's appendLifecycleEvent. The await is kept so the event
// is on disk before the handler continues.
async function appendEventSafe(e) {
  try { await appendEvent(e); } catch { /* a single activity write failure must never kill the WS handler / process */ }
}

// Wire the WebSocket layer onto `server`. Creates both WebSocketServers, attaches
// the observe + stream connection handlers and the `server.on('upgrade')` path
// router (moved over verbatim), and returns the sockets. Nothing else in server.js
// references them, so callers are free to ignore the return value.
export function setupWsLayer({ server, cfg, resolve, chatCatalog, paneInputTelemetry }) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', async (ws, req) => {
    // WARDEN-1804: the ws receiver emits 'error' (invalid UTF-8, RSV1) before any message
    // handler runs; with no listener Node throws it as an uncaught exception and the
    // server dies. Log and continue — ws closes the socket itself, close handler tears down.
    ws.on('error', (e) => console.warn('[wsLayer] observe socket error:', e?.message || e));
    if (!hasCredentials()) {
      ws.send(JSON.stringify({ type: 'error', error: 'no LLM credentials (ANTHROPIC_AUTH_TOKEN missing in the server environment)' }));
      return;
    }
    const u = new URL(req.url || '', 'http://localhost');
    let sid = u.searchParams.get('sid');
    // NEW: extract chat context
    const chatHost = u.searchParams.get('host') || null;
    const chatContainer = u.searchParams.get('container') || null;
    const chatProject = u.searchParams.get('project') || null;
    const chatRole = u.searchParams.get('role') || null;
    const chatKey = u.searchParams.get('chatKey') || null;
    // A client-supplied sid names a file under sessions/ — reject anything outside
    // the id allow-list before an Observer can persist to it (WARDEN-1577).
    if (sid && !isValidSessionId(sid)) {
      ws.send(JSON.stringify({ type: 'error', error: 'invalid session id' }));
      return;
    }
    if (!sid) {
      // `ws` does not await listener promises, so a rejection here (full disk, EACCES,
      // broken data dir) would be an unhandledRejection that kills the whole server
      // (WARDEN-1693). Answer an error frame instead.
      let s;
      try {
        s = await createSession(null, { host: chatHost, container: chatContainer, project: chatProject, role: chatRole, chatKey: chatKey });
      } catch (err) {
        console.error('[wsLayer] createSession failed:', err?.message || err);
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', error: 'could not create session' }));
        return;
      }
      sid = s.id;
      ws.send(JSON.stringify({
        type: 'session_created', sid: s.id, name: s.name,
        chatContext: { host: s.host, container: s.container, project: s.project, role: s.role, chatKey: s.chatKey },
        model: resolveModel(),
      }));
    }

    let reqCounter = 0;
    const pending = new Map();
    // WARDEN-1893: set by the close handler. A turn is not cancelled when its socket
    // closes, so `gate` can still run afterwards; the close handler's one-shot sweep of
    // `pending` never sees a resolver registered after it, so `gate` re-checks this
    // flag itself (after its await) instead of parking on a socket that cannot approve.
    let obsClosed = false;
    const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };

    const obs = new Observer(cfg, {
      sid,
      // Pass chat context so a freshly-created session binds to its agent; on
      // resume the Observer re-reads it from the persisted session instead.
      chatContext: (chatHost || chatContainer || chatProject || chatRole || chatKey)
        ? { host: chatHost, container: chatContainer, project: chatProject, role: chatRole, chatKey: chatKey }
        : null,
      onTool: (name, input) => send({ type: 'tool', name, input: { ...input, id: input?.id } }),
      onText: (text) => send({ type: 'assistant', text }),
      gate: async (chat, directive) => {
        // Auto-send read-looking directives when in auto-safe mode
        const isReadOnlyDirective = /^(?:\?|list|read|show|get|find|search|check|status|info|display)/i.test(directive.trim());
        if (cfg.observerConfirmMode === 'auto-safe' && isReadOnlyDirective) {
          return { approved: true, edited: null };
        }

        // Otherwise, require confirmation
        const requestId = String(++reqCounter);
        // WARDEN-1900: the resolver is registered BEFORE directive_proposed is sent. A client
        // that answers straight away (scripted / loopback) would otherwise land its
        // gate_decision while we are still awaiting the activity append below, find no
        // `pending` entry, and be silently dropped — an approve then degrades to a decline.
        // Stash the directive meta alongside the resolver so the gate_decision handler can
        // append a `directive_rejected` event (approved sends are recorded in observer.js
        // at logDirective, which also covers auto-safe).
        const meta = { directive, container: chat.container, host: chat.host, role: chat.role };
        let settled = false;
        const decision = new Promise((resolveDecision) => pending.set(requestId, {
          resolve: (v) => { settled = true; resolveDecision(v); },
          meta,
        }));
        send({ type: 'directive_proposed', requestId, container: chat.container, host: chat.host, role: chat.role, directive });
        await appendEventSafe({ type: 'directive_proposed', container: chat.container, host: chat.host, role: chat.role, directive });
        // WARDEN-1893: a close can land during the append. The close handler's one-shot
        // sweep releases entries registered before it (ours is), but a socket that was
        // ALREADY closed when this gate started never sweeps again — so re-check here.
        // The directive_proposed event is already appended; the closed socket just never
        // gets to approve it, so the turn gets a decline, finishes, and releases the
        // shared per-sid chain. A decision that already arrived (settled) is honoured.
        if (obsClosed && !settled) {
          pending.delete(requestId);
          return { approved: false };
        }
        return decision;
      },
    });
    send({ type: 'history', name: obs.name, items: obs.serializeForUi(), chatContext: obs.getChatContext(), model: resolveModel() });

    ws.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'user') {
        send({ type: 'thinking' });
        obs.openTabs = Array.isArray(msg.panes) ? msg.panes : [];
        try { send({ type: 'done', text: await obs.step(String(msg.text || '')) }); }
        catch (e) {
          send({ type: 'error', error: e.message });
          await appendEventSafe({ type: 'error', error: e.message });
        }
      } else if (msg.type === 'gate_decision') {
        const entry = pending.get(msg.requestId);
        if (entry) {
          pending.delete(msg.requestId);
          entry.resolve({ approved: !!msg.approved, edited: msg.edited });
          // A human rejection is distinct from an approved send — record it so the
          // timeline can show rejected directives separately from sent ones.
          if (!msg.approved) await appendEventSafe({ type: 'directive_rejected', ...entry.meta });
        }
      }
    });
    ws.on('close', () => {
      obsClosed = true;
      for (const [, entry] of pending) entry.resolve({ approved: false });
    });
  });

  // Pane stream WS: live PTY attach (interactive) + monitor snapshots. tmux is the
  // durable holder everywhere, so attach PTYs are per-WS (killed on disconnect; the
  // tmux session lives on). Local chats attach to a local tmux, remotes over ssh.
  const streamWss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    // WARDEN-1896 — cross-site WebSocket hijack / DNS rebinding guard. Runs BEFORE
    // routing so a forged Origin or Host never reaches either connection handler.
    if (!isAllowedOrigin(req.headers.origin) || !isAllowedHost(req.headers.host, boundHostOf(server))) {
      try { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); } catch { /* socket already gone */ }
      socket.destroy();
      return;
    }
    const p = (req.url || '').split('?')[0];
    const route = (w) => w.handleUpgrade(req, socket, head, (ws) => w.emit('connection', ws, req));
    if (p === '/api/observe') route(wss);
    else if (p === '/api/stream') route(streamWss);
    else socket.destroy();
  });
  streamWss.on('connection', (ws) => {
    wireStreamConnection({ ws, cfg, resolve, chatCatalog, paneInputTelemetry, appendEventSafe, LOCAL });
  });

  return { wss, streamWss };
}
