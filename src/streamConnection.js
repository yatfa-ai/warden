// The per-connection /api/stream machinery of the warden dashboard — the
// attach/monitor/input/resize/detach frame handlers, the per-connection state
// machine (`attaches`, `monitors`, `subscribedKeys`, `pendingAttach`, `closed`,
// `monitorTimer`), tickMonitor/syncMonitorSubscription/onFrame and the
// WARDEN-1856 liveness-rule comment block, all behind
// `streamWss.on('connection', …)`. Extracted verbatim from src/wsLayer.js
// (WARDEN-1933) as the next slice of the sanctioned god-module decomposition —
// the same template wsLayer.js itself followed when it left server.js
// (WARDEN-1380/1381) and gitRoutes.js before it (WARDEN-734).
//
// Side-effect-free at module load: the only project imports are already-extracted
// leaf modules (chats.js, tmux.js, sessionRecovery.js, companion.js,
// loop-monitor.js), none of which boot anything, so importing this module does
// NOT read config or open sockets. The chat-scoped state (`cfg`, `resolve`,
// `chatCatalog`), the optional telemetry producer (`paneInputTelemetry`) and the
// two helpers the observe handler still owns (`appendEventSafe`, `LOCAL`) live in
// wsLayer.js and are INJECTED per connection via
// `wireStreamConnection({ ws, cfg, resolve, chatCatalog, paneInputTelemetry,
// appendEventSafe, LOCAL })` — this module never imports wsLayer.js, so the
// dependency stays one-directional (wsLayer.js -> streamConnection.js) and the
// observe side keeps its own byte-identical access to both.
//
// WARDEN-1385 — `PANE_OUT_FLUSH_MS` moves with its only consumer (the attach
// handler's onData coalescing window).

import { performance } from 'node:perf_hooks';
import { capturePanes } from './chats.js';
import { resize, attachStream, probeSession } from './tmux.js';
import { classifyProbe } from './sessionRecovery.js';
import { subscribePanes, unsubscribePanes, isCompanionTransportEnabled, isCompanionExcludedHost } from './companion.js';
import { loopMonitor } from './loop-monitor.js';

// WARDEN-1385 — the per-pane output coalescing window (ms). An 8ms batch floor
// collapses the per-chunk WS framing three streaming agents otherwise produce
// (~4,700 msgs/sec measured — one renderer main-thread wakeup each) while adding
// an order-of-magnitude-below-perception delay to every frame. See the attach
// handler's onData for the full mechanism note.
const PANE_OUT_FLUSH_MS = 8;

// Wire ONE /api/stream websocket connection: register the frame handlers and the
// per-connection state machine, and tear every per-connection resource down on
// close. Called from wsLayer.js's `streamWss.on('connection', (ws) => …)`.
export function wireStreamConnection({ ws, cfg, resolve, chatCatalog, paneInputTelemetry, appendEventSafe, LOCAL }) {
  // WARDEN-1804: see the observe handler — a protocol-violating frame must not kill the process.
  ws.on('error', (e) => console.warn('[wsLayer] stream socket error:', e?.message || e));
  const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };
  const attaches = new Map(); // id -> { pty, chat }
  const monitors = new Set(); // chat keys
  // WARDEN-1860: the ids this connection has REGISTERED a pane-push subscription
  // for (the monitor handler's post-await subscribe) — the release half of the
  // subscription pair. Subscription newness is computed against THIS set after
  // the resolve await (the pre-await `monitors.has` read is stale across the
  // await: frames are not serialized, so an unmonitor for the same id can
  // complete — or a second monitor land — before this continuation resumes),
  // and unmonitor/close drop through it, so add and remove stay paired even
  // when the frames race. Healthy path: the same keys as `monitors`.
  const subscribedKeys = new Set();
  // WARDEN-1846: attach awaits refreshHost/resolve/probeSession before it registers in
  // `attaches`, so a per-pane `detach` (or a re-attach) landing in that window found
  // nothing to kill. id -> token of the attach currently in flight; `detach` clears it
  // and a newer attach replaces it, which makes the older attach stale.
  const pendingAttach = new Map();
  // The close handler below runs once, synchronously. Frame paths that register state
  // AFTER an await (monitor timer/subscription, attach PTY) must bail when the socket
  // closed meanwhile, or that state is never cleaned up.
  let closed = false;
  let monitorTimer = null;
  // WARDEN-1856 — THE LIVENESS RULE for the /api/stream frame handlers: after every
  // await, re-check the applicable liveness predicate before further state mutation or
  // frame emission. The predicate has TWO SCOPES, and the attach scope MIGRATES at the
  // commit boundary (settle()):
  //   • connection scope — `closed`. The close handler runs once, synchronously, so
  //     any state registered after an await must bail (WARDEN-1836).
  //   • attach scope, PRE-settle (the resolve/probeSession awaits) — token staleness
  //     via the `stale()` closure below: a newer attach or a detach invalidated this
  //     one (WARDEN-1846). `closed` is folded into the same closure.
  //   • attach scope, POST-settle — ENTRY IDENTITY, `attaches.get(m.id) !== entry`,
  //     the same predicate that guards onData/onExit/flushOut (WARDEN-365). NEVER
  //     reuse `stale()` post-settle: settle() DELETES the token, which makes stale()
  //     VACUOUSLY TRUE — a re-check through it would suppress every successful attach.
  //     Once committed, only entry identity or connection death can invalidate.
  // On the attach ERROR paths nothing is committed (no entry exists), so post-settle
  // the connection scope is the only evaluable predicate — the activity writes there
  // (and onExit's) are gated on `closed` alone. The guards stay call-site-scoped
  // (asymmetric guards, WARDEN-110): connection and attach are different domains with
  // different lifetimes; only the RULE is uniform.

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
    // WARDEN-1390: an excluded host never gets pane-push subscriptions —
    // subscribe/unsubscribe ARE channel RPCs, so the per-host exclusion is
    // part of this gate exactly as the LOCAL + flag-off arms are. Its panes
    // keep the plain poll path.
    if (!chat || !isCompanionTransportEnabled() || chat.host === LOCAL || isCompanionExcludedHost(chat.host)) return;
    try {
      if (subscribe) await subscribePanes(chat.host, [chat], cfg);
      else await unsubscribePanes(chat.host, [chat.key], cfg);
    } catch { /* subscriptions are a pure optimization; the poll path still works */ }
  };

  const onFrame = async (data) => {
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.type === 'monitor') {
      const id = String(m.id);
      monitors.add(id);
      await resolve(id);
      // WARDEN-1856 idiom, connection scope: re-check after the await, before the
      // timer/subscription registration below.
      if (closed) return;
      // WARDEN-1860, monitor scope (the third call-site-scoped liveness predicate,
      // alongside connection `closed` above and the attach path's token staleness):
      // frames are NOT serialized — an `unmonitor` for this id can run to completion
      // (monitors.delete + a no-op stopMonitorIfEmpty) while this continuation sits
      // in `await resolve(id)`. Registering anything for a pane whose watcher left
      // during that await leaks it: `startMonitor()` would run a 2s interval over a
      // set that no longer holds the id (a no-op tick — tickMonitor early-returns
      // before any snapshot — alive until close), and a subscription taken here has
      // no releaser until the socket closes — the unmonitor already ran and refs in
      // companion.js have no TTL, so the remote companion would capture and push
      // that pane at 1Hz for nobody in the meantime. A pane unmonitored during
      // resolve registers nothing, symmetric to the attach path's `stale()`
      // (WARDEN-1846).
      if (!monitors.has(id)) return;
      startMonitor();
      if (!subscribedKeys.has(id)) {
        // Subscribe only on a NEWLY-registered pane so monitor/unmonitor stay
        // balanced per connection: a duplicate monitor must not double-count the
        // ref, and a monitor→unmonitor→monitor burst mid-resolve (both
        // continuations stale) must not either — newness is computed HERE, after
        // the await, against the live registration set. resolve() seeded the
        // catalogue, so the chat is findable by key here. Fire-and-forget: until
        // the delta arrives, capturePanes keeps polling (graceful bootstrap).
        const chat = chatCatalog.snapshot().find((c) => c.key === id || c.id === id);
        subscribedKeys.add(id);
        syncMonitorSubscription(chat, true);
      }
    }
    else if (m.type === 'unmonitor') {
      const id = String(m.id);
      monitors.delete(id);
      stopMonitorIfEmpty();
      if (subscribedKeys.delete(id)) {
        // Release exactly the subscriptions this connection registered
        // (WARDEN-1860): a pane whose monitor never got past `await resolve` has
        // no entry here, so no release is sent for a subscription that was never
        // taken — the mirror of the monitor side's post-await newness check. In
        // the healthy path this is the same condition the pre-await `wasPresent`
        // read served.
        const chat = chatCatalog.snapshot().find((c) => c.key === id || c.id === id);
        syncMonitorSubscription(chat, false);
      }
    }
    else if (m.type === 'attach') {
      if (attaches.has(m.id)) return;
      const token = Symbol('attach');
      pendingAttach.set(m.id, token);
      const stale = () => closed || pendingAttach.get(m.id) !== token;
      const settle = () => { if (pendingAttach.get(m.id) === token) pendingAttach.delete(m.id); };
      // Lazy restore: if the client knows the host (stored when the pane was first
      // opened), discover just that one host so resolve() hits the catalogue — no
      // all-hosts scan.
      if (m.host && !chatCatalog.has(m.id)) {
        try {
          await chatCatalog.refreshHost(String(m.host), cfg);
        } catch { /* fall through; resolve() still has a locate fallback */ }
      }
      const r = await resolve(String(m.id));
      if (stale()) return; // WARDEN-1856: pre-settle re-check (token staleness + closed — WARDEN-1846)
      if (r.error) {
        settle();
        send({ type: 'attach_error', id: m.id, error: r.error });
        // WARDEN-1856: the frame is already out; only the activity write can land
        // stale. Post-settle nothing is committed (no entry exists), so the idiom's
        // applicable predicate here is the connection scope alone.
        if (!closed) await appendEventSafe({ type: 'error', error: r.error, context: 'attach', id: m.id });
        return;
      }
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
      if (stale()) return; // WARDEN-1856: pre-settle re-check (token staleness + closed — WARDEN-1846)
      if (reason === 'host_unreachable') {
        settle();
        send({ type: 'host_unreachable', id: m.id });
        if (!closed) await appendEventSafe({ type: 'error', error: 'host unreachable', context: 'attach', id: m.id, host: chat.host, container: chat.container }); // WARDEN-1856: gated append
        return;
      }
      if (reason === 'session_dead') {
        settle();
        send({ type: 'session_dead', id: m.id });
        if (!closed) await appendEventSafe({ type: 'error', error: 'session dead', context: 'attach', id: m.id, host: chat.host, container: chat.container }); // WARDEN-1856: gated append
        return;
      }

      settle();
      let pty;
      try { pty = attachStream(chat, cfg, { cols, rows }); }
      catch (e) {
        send({ type: 'attach_error', id: m.id, error: String((e && e.message) || e) });
        if (!closed) await appendEventSafe({ type: 'error', error: String((e && e.message) || e), context: 'attach', id: m.id, host: chat.host, container: chat.container }); // WARDEN-1856: gated append
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
        // WARDEN-1856: the delete above consumed this entry's identity (a re-check
        // against the map would be vacuously true), so the append is gated on the
        // connection scope — the only liveness left that can make it stale.
        if (!closed) await appendEventSafe({ type: 'ended', id: m.id, code: exitCode, host: chat.host, container: chat.container });
      });
      try { await resize(chat, cfg, cols, rows); } catch { /* noop */ }
      // WARDEN-1856 — post-settle re-check (attach scope: ENTRY IDENTITY — never
      // stale(), which is vacuously true once settle() deleted the token). resize()
      // is a real RPC (one ssh round-trip on remote hosts); a detach or a close
      // landing inside it tears the entry down, and announcing `attached` for the
      // killed PTY would land the pane on "connected" with no frames ever coming
      // (its late onExit is identity-suppressed, so no `ended` arrives either).
      // NO frame of any kind and no orphan tmux client escape this window — the
      // same contract WARDEN-1846 pinned for the earlier ones.
      if (closed || attaches.get(m.id) !== entry) return;
      send({ type: 'attached', id: m.id });
      // WARDEN-1856: the activity write carries the same pre-write liveness
      // re-check as every other append in the handler (the five error/ended
      // appends above) — post-settle scope: ENTRY IDENTITY + connection. An
      // entry torn down while the continuation was suspended in the resize
      // await must not land a false `attached` activity event for a pane
      // that no longer exists.
      if (!closed && attaches.get(m.id) === entry) await appendEventSafe({ type: 'attached', id: m.id, host: chat.host, container: chat.container });
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
        // WARDEN-1856: no liveness re-check after this await — nothing follows it
        // (no state mutation, no frame emission), so there is nothing to guard.
        try { await resize(a.chat, cfg, c, r); } catch { /* noop */ }
      }
    } else if (m.type === 'detach') {
      pendingAttach.delete(m.id);
      const a = attaches.get(m.id);
      if (a) {
        try { a.pty.kill(); } catch { /* noop */ }
        attaches.delete(m.id);
        // WARDEN-1385: same reasoning as the exit path — a killed PTY cannot echo.
        try { paneInputTelemetry?.dropPending(String(m.id)); } catch { /* noop */ }
      }
    }
  };
  // ws does not await listener promises: a throw in onFrame (e.g. a hostile
  // coercion like id:{toString:null}) would be an unhandledRejection that kills
  // the process, so drop the frame instead.
  ws.on('message', (data) => {
    onFrame(data).catch((e) => console.warn('[wsLayer] stream frame failed:', e?.message || e));
  });

  ws.on('close', () => {
    closed = true;
    for (const [, a] of attaches) { try { a.pty.kill(); } catch { /* noop */ } }
    if (monitorTimer) clearInterval(monitorTimer);
    // WARDEN-413: drop this connection's monitored pane refs so a shared
    // subscription is released only when its LAST watcher closes (ref-counted in
    // companion.js). Best-effort + fire-and-forget: a transport hiccup here must
    // not block teardown, and capturePanes falls back to polling either way.
    if (isCompanionTransportEnabled()) {
      const known = chatCatalog.snapshot();
      const byHost = {};
      for (const k of subscribedKeys) {
        // Match the monitor handler's key||id lookup so a host-prefixed monitor id
        // (chat.id) still resolves, and drop the ref by chat.KEY — subscribePanes
        // keys refs by chat.key (describePanes), so the add/drop stay balanced
        // whatever id form the client sent. (WARDEN-413 reviewer minor finding.)
        // WARDEN-1860: the release walks the REGISTERED set, not `monitors` — the
        // two differ exactly on this ticket's raced paths (a pane subscribed after
        // its unmonitor ran: registered but no longer monitored; a monitor still
        // inside its resolve await: monitored but nothing registered yet), so
        // dropping exactly what this connection took is both necessary (a
        // monitors-only walk would strand the raced ref — the ref map has no TTL)
        // and precise (it never releases a subscription that was never taken).
        // WARDEN-1390: excluded hosts are dropped from the grouping — no
        // teardown unsubscribe is ever sent to them (zero channel RPCs).
        const chat = known.find((c) => c.key === k || c.id === k);
        if (chat && chat.host !== LOCAL && !isCompanionExcludedHost(chat.host)) (byHost[chat.host] ||= []).push(chat.key);
      }
      for (const [host, keys] of Object.entries(byHost)) {
        unsubscribePanes(host, keys, cfg).catch(() => {});
      }
    }
  });
}
