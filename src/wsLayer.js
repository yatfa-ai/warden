// The WebSocket layer of the warden dashboard — the two `noServer` WebSocketServers
// (`wss`: /api/observe chat + observer traffic; `streamWss`: /api/stream live PTY
// attach + pane monitors) and the http `upgrade` router that dispatches between
// them. Extracted verbatim from src/server.js (WARDEN-1381) as the next slice of
// the sanctioned god-module decomposition, sibling to gitRoutes.js (WARDEN-734),
// claudeSessions.js (WARDEN-677) and the other extracted layers.
//
// Side-effect-free at module load: the only project imports are already-extracted
// leaf modules (observer.js, llm.js, sessions.js, activity.js, chats.js, tmux.js,
// sessionRecovery.js, companion.js, loop-monitor.js), none of which boot anything,
// so importing this module does NOT read config or open sockets (mirrors
// gitRoutes.js / claudeSessions.js). The http server instance and the chat-scoped
// state (`cfg`, `resolve`, `chatCatalog`) live in server.js and are passed into
// `setupWsLayer` so this module never imports server.js — the dependency stays
// one-directional (server.js -> wsLayer.js), avoiding a cycle.
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
import { performance } from 'node:perf_hooks';
import { Observer } from './observer.js';
import { hasCredentials, resolveModel } from './llm.js';
import { createSession } from './sessions.js';
import { appendEvent } from './activity.js';
import { capturePanes } from './chats.js';
import { resize, attachStream, probeSession } from './tmux.js';
import { classifyProbe } from './sessionRecovery.js';
import { subscribePanes, unsubscribePanes, isCompanionTransportEnabled } from './companion.js';
import { loopMonitor } from './loop-monitor.js';

// The host sentinel for "run on this machine, not over SSH" (mirrors server.js's
// LOCAL — duplicated rather than imported to keep this a leaf module; the test suites
// already hardcode this same string).
const LOCAL = '(local)';

// WARDEN-1385 — the per-pane output coalescing window (ms). An 8ms batch floor
// collapses the per-chunk WS framing three streaming agents otherwise produce
// (~4,700 msgs/sec measured — one renderer main-thread wakeup each) while adding
// an order-of-magnitude-below-perception delay to every frame. See the attach
// handler's onData for the full mechanism note.
const PANE_OUT_FLUSH_MS = 8;

// Wire the WebSocket layer onto `server`. Creates both WebSocketServers, attaches
// the observe + stream connection handlers and the `server.on('upgrade')` path
// router (moved over verbatim), and returns the sockets. Nothing else in server.js
// references them, so callers are free to ignore the return value.
export function setupWsLayer({ server, cfg, resolve, chatCatalog, paneInputTelemetry }) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', async (ws, req) => {
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
    if (!sid) {
      const s = await createSession(null, { host: chatHost, container: chatContainer, project: chatProject, role: chatRole, chatKey: chatKey });
      sid = s.id;
      ws.send(JSON.stringify({
        type: 'session_created', sid: s.id, name: s.name,
        chatContext: { host: s.host, container: s.container, project: s.project, role: s.role, chatKey: s.chatKey },
        model: resolveModel(),
      }));
    }

    let reqCounter = 0;
    const pending = new Map();
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
        send({ type: 'directive_proposed', requestId, container: chat.container, host: chat.host, role: chat.role, directive });
        await appendEvent({ type: 'directive_proposed', container: chat.container, host: chat.host, role: chat.role, directive });
        // Stash the directive meta alongside the resolver so the gate_decision
        // handler can append a `directive_rejected` event (approved sends are
        // recorded in observer.js at logDirective, which also covers auto-safe).
        const meta = { directive, container: chat.container, host: chat.host, role: chat.role };
        return new Promise((resolveDecision) => pending.set(requestId, { resolve: resolveDecision, meta }));
      },
    });
    send({ type: 'history', name: obs.name, items: obs.serializeForUi(), chatContext: obs.getChatContext(), model: resolveModel() });

    ws.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'user') {
        send({ type: 'thinking' });
        obs.openTabs = Array.isArray(msg.panes) ? msg.panes : [];
        try { send({ type: 'done', text: await obs.step(String(msg.text || '')) }); }
        catch (e) {
          send({ type: 'error', error: e.message });
          await appendEvent({ type: 'error', error: e.message });
        }
      } else if (msg.type === 'gate_decision') {
        const entry = pending.get(msg.requestId);
        if (entry) {
          pending.delete(msg.requestId);
          entry.resolve({ approved: !!msg.approved, edited: msg.edited });
          // A human rejection is distinct from an approved send — record it so the
          // timeline can show rejected directives separately from sent ones.
          if (!msg.approved) await appendEvent({ type: 'directive_rejected', ...entry.meta });
        }
      }
    });
    ws.on('close', () => { for (const [, entry] of pending) entry.resolve({ approved: false }); });
  });

  // Pane stream WS: live PTY attach (interactive) + monitor snapshots. tmux is the
  // durable holder everywhere, so attach PTYs are per-WS (killed on disconnect; the
  // tmux session lives on). Local chats attach to a local tmux, remotes over ssh.
  const streamWss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const p = (req.url || '').split('?')[0];
    const route = (w) => w.handleUpgrade(req, socket, head, (ws) => w.emit('connection', ws, req));
    if (p === '/api/observe') route(wss);
    else if (p === '/api/stream') route(streamWss);
    else socket.destroy();
  });
  streamWss.on('connection', (ws) => {
    const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };
    const attaches = new Map(); // id -> { pty, chat }
    const monitors = new Set(); // chat keys
    let monitorTimer = null;

    const tickMonitor = async () => {
      if (!monitors.size) return;
      const known = chatCatalog.snapshot();
      // WARDEN-1223: a bare monitor id can name a session on more than one host —
      // resolve EVERY catalogue match (key or id), deduped by the host-qualified
      // id, so each host's pane is captured from its own terminal instead of the
      // first same-named catalogue entry winning.
      const chats = [];
      const seenIds = new Set();
      for (const k of monitors) {
        for (const c of known) {
          if (c.key !== k && c.id !== k) continue;
          if (!seenIds.has(c.id)) { seenIds.add(c.id); chats.push(c); }
        }
      }
      if (!chats.length) return;
      let out;
      try { out = await capturePanes(chats, cfg); } catch { return; }
      // capturePanes is keyed by the host-qualified id. The CLIENT registered its
      // snapshot handler under the id IT sent (bare key or qualified id), so each
      // capture is echoed back under every monitor id that names that chat — the
      // wire contract is unchanged, while the CONTENT now comes from the right
      // host's terminal (WARDEN-1223).
      for (const [capId, pane] of Object.entries(out)) {
        const chat = chats.find((c) => c.id === capId);
        if (!chat) continue;
        for (const m of monitors) {
          if (m === chat.key || m === chat.id) {
            send({ type: 'snapshot', id: m, pane, host: chat.host, name: chat.name });
          }
        }
        // Snapshot logging disabled due to performance: 2s intervals create 300K+ events/pane/7 days
        // appendEvent({ type: 'snapshot', id: k, host: chats.find(c => c.key === k)?.host, container: chats.find(c => c.key === k)?.container });
      }
    };
    // Traced for the stall monitor (WARDEN-977): the 2s pane-capture beat is the
    // busiest always-on timer in the process, so a stall that lands inside it must
    // say so rather than being attributed to whichever request it froze.
    const tracedTickMonitor = () => loopMonitor.trace('ws:pane-monitor', tickMonitor);
    const startMonitor = () => { if (!monitorTimer) { monitorTimer = setInterval(tracedTickMonitor, 2000); tracedTickMonitor(); } };
    const stopMonitorIfEmpty = () => { if (monitorTimer && !monitors.size) { clearInterval(monitorTimer); monitorTimer = null; } };

    // WARDEN-413: keep companion pane-push subscriptions in sync with the monitored
    // set. capturePanes (chats.js) renders a companion host from the pushed delta
    // cache and SKIPS the per-tick RPC when the subscription is live, so an idle
    // companion host receives ZERO capturePanes RPCs per monitor tick. Subscriptions
    // are ref-counted across connections in companion.js: each connection subscribes
    // its own panes on monitor and drops them on unmonitor/close, so two tabs
    // watching the same host share one subscription whose pane set is the union.
    // LOCAL + flag-off hosts are excluded (their poll path is unchanged).
    const syncMonitorSubscription = async (chat, subscribe) => {
      if (!chat || !isCompanionTransportEnabled() || chat.host === LOCAL) return;
      try {
        if (subscribe) await subscribePanes(chat.host, [chat], cfg);
        else await unsubscribePanes(chat.host, [chat.key], cfg);
      } catch { /* subscriptions are a pure optimization; the poll path still works */ }
    };

    ws.on('message', async (data) => {
      let m;
      try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type === 'monitor') {
        const id = String(m.id);
        // Subscribe only on a NEWLY-added pane so monitor/unmonitor stay balanced
        // per connection (a duplicate monitor must not double-count the ref, or a
        // later single unmonitor/close would leak the subscription). monitors is a
        // Set, so has()-before-add tells us whether this is the first watch.
        const isNew = !monitors.has(id);
        monitors.add(id);
        await resolve(id);
        startMonitor();
        if (isNew) {
          // Subscribe this pane's host to pushed deltas (skip-on-tick gate). resolve()
          // seeded the catalogue, so the chat is findable by key here. Fire-and-forget:
          // until the delta arrives, capturePanes keeps polling (graceful bootstrap).
          const chat = chatCatalog.snapshot().find((c) => c.key === id || c.id === id);
          syncMonitorSubscription(chat, true);
        }
      }
      else if (m.type === 'unmonitor') {
        const id = String(m.id);
        const wasPresent = monitors.has(id);
        monitors.delete(id);
        stopMonitorIfEmpty();
        if (wasPresent) {
          const chat = chatCatalog.snapshot().find((c) => c.key === id || c.id === id);
          syncMonitorSubscription(chat, false);
        }
      }
      else if (m.type === 'attach') {
        if (attaches.has(m.id)) return;
        // Lazy restore: if the client knows the host (stored when the pane was first
        // opened), discover just that one host so resolve() hits the catalogue — no
        // all-hosts scan.
        if (m.host && !chatCatalog.has(m.id)) {
          try {
            await chatCatalog.refreshHost(String(m.host), cfg);
          } catch { /* fall through; resolve() still has a locate fallback */ }
        }
        const r = await resolve(String(m.id));
        if (r.error) { send({ type: 'attach_error', id: m.id, error: r.error }); await appendEvent({ type: 'error', error: r.error, context: 'attach', id: m.id }); return; }
        const chat = r.chat;
        const cols = Math.max(20, Math.floor(m.cols || 100));
        const rows = Math.max(6, Math.floor(m.rows || 30));
        // Bounded liveness probe BEFORE spawning the live PTY (WARDEN-231). A dead
        // session previously made the attach PTY exit immediately → the server
        // emitted {type:'ended'} → the pane spun an infinite "connecting" spinner
        // with no escape. Probing first lets us tell session-dead (host up, session
        // absent) from host-unreachable (SSH can't deliver) and emit a distinct
        // message the frontend branches on instead of hanging. A null reason means
        // the session is alive (or the probe was inconclusive) → fall through to a
        // normal attach; the frontend's immediate-end backstop still catches any
        // race the probe missed.
        let reason = null;
        try { reason = classifyProbe(await probeSession(chat, cfg)); }
        catch { /* probe threw → leave reason null and attempt a normal attach */ }
        if (reason === 'host_unreachable') {
          send({ type: 'host_unreachable', id: m.id });
          await appendEvent({ type: 'error', error: 'host unreachable', context: 'attach', id: m.id, host: chat.host, container: chat.container });
          return;
        }
        if (reason === 'session_dead') {
          send({ type: 'session_dead', id: m.id });
          await appendEvent({ type: 'error', error: 'session dead', context: 'attach', id: m.id, host: chat.host, container: chat.container });
          return;
        }

        let pty;
        try { pty = attachStream(chat, cfg, { cols, rows }); }
        catch (e) {
          send({ type: 'attach_error', id: m.id, error: String((e && e.message) || e) });
          await appendEvent({ type: 'error', error: String((e && e.message) || e), context: 'attach', id: m.id, host: chat.host, container: chat.container });
          return;
        }
        // WARDEN-365 (defense-in-depth): bind a per-attach `entry` object and gate
        // the ENTIRE onData/onExit body on identity (`attaches.get(m.id) === entry`)
        // so a killed prior PTY can never clobber or pollute a freshly-bound one. A
        // detach→attach (legitimate Retry, or the client's attach-lifecycle) kills
        // the prior PTY and binds a new one under the SAME id; node-pty's kill() is
        // async, so the prior PTY's onExit (and any trailing onData) can fire AFTER
        // the new PTY is bound. If that late onExit were allowed through it would
        // BOTH `attaches.delete(m.id)` the NEW entry (orphaning it: input/resize
        // dropped, a later detach can't kill it) AND send a spurious 'ended' —
        // landing a healthy, just-re-attached pane on the session_dead recovery
        // panel, reproducing the intermittent race-shaped corruption this ticket
        // fixes. The early `return` on identity mismatch suppresses the whole body,
        // so a killed PTY's late exit is fully silent (no delete, no 'ended', no
        // event) whether or not a new PTY has rebound the id — the client initiated
        // that kill, so it is not a "session ended" the client needs to hear about.
        // This also contains the rare concurrent-attach race (two attaches passing
        // the `attaches.has` guard before either sets): the second set wins, the
        // first PTY's data is dropped and its onExit can't touch the live entry.
        const entry = { pty, chat };
        attaches.set(m.id, entry);
        // WARDEN-1385 — PER-PANE OUTPUT COALESCING (the convicted mechanism's
        // root fix). node-pty delivers tmux output in small chunks, and the
        // naive path forwarded ONE WS message PER CHUNK. Measured on the
        // probe (scripts/pane-latency-probe.mjs): three streaming agents
        // produce ~4,700 messages/sec INTO the renderer — each one a
        // main-thread wakeup (JSON.parse + handler + term.write) on the very
        // thread that must process the user's keystroke and paint its echo.
        // A plain ssh client ships the SAME bytes as one continuous stream;
        // the per-chunk framing is warden's own invention, and it multiplies
        // the renderer's felt-path load by an order of magnitude.
        //
        // The fix batches the chunks that arrive within one 8ms window into
        // ONE message per pane. 8ms is an order of magnitude below the ~50ms
        // perception floor the ticket pins (and the same internal-batching
        // class every terminal emulator applies to its own writes), while the
        // message-rate collapse is what removes the main-thread pressure.
        // Byte order per pane is preserved exactly; xterm is chunk-boundary-
        // agnostic and prefers fewer/larger writes; tmux redraws identically.
        let outChunks = [];
        let outTimer = null;
        const flushOut = () => {
          if (outTimer) { clearTimeout(outTimer); outTimer = null; }
          if (attaches.get(m.id) !== entry) { outChunks = []; return; }
          if (!outChunks.length) return;
          const data = outChunks.join('');
          outChunks = [];
          send({ type: 'pty', id: m.id, data });
        };
        pty.onData((d) => {
          if (attaches.get(m.id) !== entry) return;
          // WARDEN-1385: the pane produced output while a keystroke may be in
          // flight — the producer correlates write→output for the round-trip
          // histogram. Must not shift the data path: fire-and-forget, caught.
          try { paneInputTelemetry?.notePaneOutput(String(m.id)); } catch { /* observing must never break the path */ }
          outChunks.push(d);
          if (outChunks.length >= 64) { flushOut(); return; } // pathological-turn bound
          if (!outTimer) outTimer = setTimeout(flushOut, PANE_OUT_FLUSH_MS);
        });
        pty.onExit(async ({ exitCode }) => {
          if (attaches.get(m.id) !== entry) return; // stale — killed prior PTY; this exit is not the live session ending
          attaches.delete(m.id);
          outChunks = []; // any unflushed output of a dead PTY is dead with it
          // WARDEN-1385: the echo of any in-flight keystroke died with the PTY —
          // drop the pending correlation (the ledger row is kept; it IS the
          // evidence about the pane that just ended).
          try { paneInputTelemetry?.dropPending(String(m.id)); } catch { /* noop */ }
          send({ type: 'ended', id: m.id, code: exitCode });
          await appendEvent({ type: 'ended', id: m.id, code: exitCode, host: chat.host, container: chat.container });
        });
        try { await resize(chat, cfg, cols, rows); } catch { /* noop */ }
        send({ type: 'attached', id: m.id });
        await appendEvent({ type: 'attached', id: m.id, host: chat.host, container: chat.container });
      } else if (m.type === 'input') {
        const a = attaches.get(m.id);
        if (a) {
          // WARDEN-1385: measure the WRITE leg (WS message → pty.write done) and
          // open the pane's round-trip correlation. Fire-and-forget + caught:
          // observing the path must never be the thing that breaks the path.
          const t0 = performance.now();
          try { a.pty.write(String(m.data || '')); } catch { /* noop */ }
          try { paneInputTelemetry?.noteInputWritten(String(m.id), performance.now() - t0); } catch { /* noop */ }
        }
      } else if (m.type === 'resize') {
        const c = Math.max(20, Math.floor(m.cols || 80));
        const r = Math.max(6, Math.floor(m.rows || 24));
        const a = attaches.get(m.id);
        if (a) {
          try { a.pty.resize(c, r); } catch { /* noop */ }
          try { await resize(a.chat, cfg, c, r); } catch { /* noop */ }
        }
      } else if (m.type === 'detach') {
        const a = attaches.get(m.id);
        if (a) {
          try { a.pty.kill(); } catch { /* noop */ }
          attaches.delete(m.id);
          // WARDEN-1385: same reasoning as the exit path — a killed PTY cannot echo.
          try { paneInputTelemetry?.dropPending(String(m.id)); } catch { /* noop */ }
        }
      }
    });

    ws.on('close', () => {
      for (const [, a] of attaches) { try { a.pty.kill(); } catch { /* noop */ } }
      if (monitorTimer) clearInterval(monitorTimer);
      // WARDEN-413: drop this connection's monitored pane refs so a shared
      // subscription is released only when its LAST watcher closes (ref-counted in
      // companion.js). Best-effort + fire-and-forget: a transport hiccup here must
      // not block teardown, and capturePanes falls back to polling either way.
      if (isCompanionTransportEnabled()) {
        const known = chatCatalog.snapshot();
        const byHost = {};
        for (const k of monitors) {
          // Match the monitor handler's key||id lookup so a host-prefixed monitor id
          // (chat.id) still resolves, and drop the ref by chat.KEY — subscribePanes
          // keys refs by chat.key (describePanes), so the add/drop stay balanced
          // whatever id form the client sent. (WARDEN-413 reviewer minor finding.)
          const chat = known.find((c) => c.key === k || c.id === k);
          if (chat && chat.host !== LOCAL) (byHost[chat.host] ||= []).push(chat.key);
        }
        for (const [host, keys] of Object.entries(byHost)) {
          unsubscribePanes(host, keys, cfg).catch(() => {});
        }
      }
    });
  });

  return { wss, streamWss };
}
