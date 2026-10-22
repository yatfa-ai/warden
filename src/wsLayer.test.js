import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { WebSocket } from 'ws';
import { runLocalTmux } from './ssh.js';
import { pollUntil, sleep } from './testWait.js';

/**
 * Handler-contract tests for setupWsLayer (src/wsLayer.js) — the two WebSocket
 * servers behind every live terminal pane (/api/stream) and the Observer chat
 * (/api/observe).
 *
 * The sibling suites (wsLayer-sid, -malformed-frame, -activity-write-failure,
 * -session-create-failure, server-stream-reattach, …) pin sid validation, bad
 * frames, write-failure survival and the WARDEN-365 identity guard. This file
 * pins the remaining handler CONTRACTS, each by the observable wire / tmux /
 * activity-journal effect (never by source text):
 *
 *   /api/observe  the confirm gate: auto-safe + read-only-directive decision
 *                 (case / leading-space / anchoring), directive_proposed frame +
 *                 activity event, requestId numbering, reject/approve/edit
 *                 decisions and their directive_rejected / directive_sent
 *                 records, one-shot decisions, close = decline, thinking frame.
 *   /api/stream   unknown upgrade path, monitor snapshots (fields, id coercion,
 *                 re-entry, awaited resolve), attach (duplicate guard, resolve
 *                 error, geometry floors + defaults, session_dead, attached /
 *                 ended frames + events), resize, detach and ws-close killing
 *                 the PTYs.
 *
 * PTY geometry and liveness are asserted through the real tmux client list
 * (`tmux list-clients -F '#{client_width}x#{client_height}'`). HOME is redirected
 * BEFORE the dynamic imports so the activity journal / catalog / sessions are
 * throwaway. Skipped when tmux is absent (mirrors server-stream-reattach.test.js).
 */

const LOCAL = '(local)';

const tmuxPresent = (() => {
  try { execFileSync('tmux', ['-V'], { stdio: ['ignore', 'ignore', 'ignore'] }); return true; } catch { return false; }
})();

const uniq = () => Math.random().toString(36).slice(2, 8);

describe('setupWsLayer handler contracts (real http server + real WebSocket + local tmux)', { skip: !tmuxPresent && 'tmux not installed' }, () => {
  let saved, tempHome, llmServer, readEvents;
  let confirmSrv, autoSrv; // { server, port }
  const llmQueue = [];
  let sessionSeq = 0;
  const sessions = new Set();
  const victim = `wsl-victim-${process.pid}-${uniq()}`;

  // ---- injected resolve / chatCatalog (no server.js import) ----
  const catalog = [];
  const known = new Map(); // id or bare key -> chat
  const resolveCalls = [];
  let resolveDelayMs = 0;
  const mkChat = (session, name) => ({
    id: `${LOCAL}:${session}`, key: session, kind: 'tmux', host: LOCAL, container: null, session,
    project: 'local', role: 'claude', name: name || `name-${session}`, cwd: '', cmd: 'cat', active: true,
  });
  const register = (chat) => { known.set(chat.id, chat); known.set(chat.key, chat); };
  const resolve = async (id) => {
    resolveCalls.push(id);
    if (resolveDelayMs) await sleep(resolveDelayMs);
    const chat = known.get(id);
    if (!chat) return { error: `no chat matches "${id}"` };
    if (!catalog.some((c) => c.id === chat.id)) catalog.push(chat);
    return { chat };
  };
  const chatCatalog = {
    snapshot: () => catalog.slice(),
    has: (id) => catalog.some((c) => c.id === id || c.key === id),
    refreshHost: async () => {},
  };

  async function newSession(cmd = 'cat') {
    const name = `wsl-${process.pid}-${++sessionSeq}-${uniq()}`;
    const r = await runLocalTmux(['new-session', '-d', '-s', name, '-x', '100', '-y', '30', 'sh', '-c', cmd]);
    assert.ok(r.ok, `tmux new-session failed: ${r.stderr}`);
    sessions.add(name);
    const chat = mkChat(name);
    register(chat);
    return chat;
  }

  async function clients(session) {
    const r = await runLocalTmux(['list-clients', '-t', session, '-F', '#{client_width}x#{client_height}']);
    if (!r.ok) return [];
    return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  }
  const waitClients = (session, pred, msg) => pollUntil(async () => { const c = await clients(session); return pred(c) ? c : null; }, { what: msg || 'tmux clients' });

  async function startWs(cfg) {
    const { setupWsLayer } = await import('./wsLayer.js');
    const server = http.createServer(() => {});
    setupWsLayer({ server, cfg, resolve, chatCatalog });
    // Upgraded / leaked sockets are not covered by closeAllConnections(); track every raw
    // socket so teardown can never hang on a connection a failing test left open.
    server.rawSockets = new Set();
    server.on('connection', (sock) => { server.rawSockets.add(sock); sock.once('close', () => server.rawSockets.delete(sock)); });
    await new Promise((resolveP, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveP); });
    return { server, port: server.address().port };
  }

  before(async () => {
    saved = {
      HOME: process.env.HOME,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    };
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-wslayer-'));
    process.env.HOME = tempHome;
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
    const wdir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(path.join(wdir, 'sessions'), { recursive: true });
    // The Observer resolves send_directive targets through the REAL catalog: a tmux
    // entry whose session name is the bare id it is given.
    fs.writeFileSync(path.join(wdir, 'chats.json'), JSON.stringify([
      { kind: 'tmux', host: LOCAL, session: victim, name: 'victim', cwd: '', cmd: 'cat' },
    ]));

    // Fake LLM: pops queued responses, else a plain text turn.
    llmServer = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const body = llmQueue.length ? llmQueue.shift() : { content: [{ type: 'text', text: 'ok' }] };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
      });
    });
    await new Promise((r) => llmServer.listen(0, '127.0.0.1', r));
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${llmServer.address().port}`;

    ({ readEvents } = await import('./activity.js'));
    confirmSrv = await startWs({ connectTimeout: 1, hosts: [] });
    autoSrv = await startWs({ connectTimeout: 1, hosts: [], observerConfirmMode: 'auto-safe' });
    const r = await runLocalTmux(['new-session', '-d', '-s', victim, 'cat']);
    assert.ok(r.ok, `victim session: ${r.stderr}`);
  });

  after(async () => {
    for (const s of [...sessions, victim]) { try { await runLocalTmux(['kill-session', '-t', s]); } catch { /* best effort */ } }
    for (const s of [confirmSrv, autoSrv]) {
      if (!s) continue;
      try { s.server.closeAllConnections?.(); } catch { /* noop */ }
      for (const sock of s.server.rawSockets) sock.destroy();
      await new Promise((r) => s.server.close(r));
    }
    if (llmServer) await new Promise((r) => llmServer.close(r));
    for (const [k, v] of Object.entries(saved || {})) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(() => { llmQueue.length = 0; resolveCalls.length = 0; resolveDelayMs = 0; catalog.length = 0; });

  const eventsOf = async (type, pred = () => true) => (await readEvents()).filter((e) => e.type === type && pred(e));

  // ======================= /api/observe =======================

  function openObserve(port, qs = '') {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/observe${qs}`);
    const frames = [];
    ws.on('message', (d) => { try { frames.push(JSON.parse(String(d))); } catch { /* ignore */ } });
    const opened = new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const api = {
      ws, frames, opened,
      send: (o) => ws.send(JSON.stringify(o)),
      find: (type, pred = () => true) => frames.find((f) => f.type === type && pred(f)),
      all: (type, pred = () => true) => frames.filter((f) => f.type === type && pred(f)),
      // open + wait for the Observer to be wired (history frame = handler registered)
      async ready() { await opened; await pollUntil(() => api.find('history'), { what: 'history frame' }); return api; },
    };
    return api;
  }
  const queueDirective = (directive) => llmQueue.push({
    content: [{ type: 'tool_use', id: `tu-${uniq()}`, name: 'send_directive', input: { id: victim, directive } }],
  });
  // Wait until the directive_proposed frame + activity event are out (the resolver is
  // registered BEFORE the frame is sent since WARDEN-1900; the pad is just settle time).
  async function awaitProposed(c, directive) {
    const f = await pollUntil(() => c.find('directive_proposed', (x) => x.directive === directive), { what: `directive_proposed ${directive}` });
    await pollUntil(async () => (await eventsOf('directive_proposed', (e) => e.directive === directive)).length > 0, { what: 'directive_proposed event' });
    await sleep(100);
    return f;
  }

  it('observe: a user turn is acknowledged with a thinking frame before the done frame', async () => {
    const c = await openObserve(confirmSrv.port).ready();
    try {
      c.send({ type: 'user', text: 'hello', panes: [] });
      await pollUntil(() => c.find('done'), { what: 'done' });
      const iThinking = c.frames.findIndex((f) => f.type === 'thinking');
      const iDone = c.frames.findIndex((f) => f.type === 'done');
      assert.ok(iThinking >= 0, `no thinking frame: ${JSON.stringify(c.frames.map((f) => f.type))}`);
      assert.ok(iThinking < iDone, 'thinking must precede done');
      assert.strictEqual(c.find('done').text, 'ok');
    } finally { c.ws.close(); }
  });

  it('observe: positive control — an invalid sid is refused with an error frame, no history', async () => {
    const c = openObserve(confirmSrv.port, '?sid=..%2Fevil');
    await c.opened;
    try {
      await pollUntil(() => c.find('error'), { what: 'error frame' });
      assert.strictEqual(c.find('error').error, 'invalid session id');
      assert.strictEqual(c.find('history'), undefined);
    } finally { c.ws.close(); }
  });

  it('observe: confirm mode gates a directive — the proposed frame and event carry role/host/container; the first requestId is "1"', async () => {
    const directive = `restart it ${uniq()}`;
    const c = await openObserve(confirmSrv.port).ready();
    try {
      queueDirective(directive);
      c.send({ type: 'user', text: 'tell victim', panes: [] });
      const f = await awaitProposed(c, directive);
      assert.strictEqual(f.requestId, '1', 'requestId counter must hand out "1" first');
      assert.strictEqual(f.role, 'claude');
      assert.strictEqual(f.host, LOCAL);
      assert.strictEqual(f.container, null);
      const [ev] = await eventsOf('directive_proposed', (e) => e.directive === directive);
      assert.ok(ev, 'directive_proposed activity event recorded');
      assert.strictEqual(ev.role, 'claude');
      assert.strictEqual(ev.host, LOCAL);
      c.send({ type: 'gate_decision', requestId: f.requestId, approved: false });
      await pollUntil(() => c.find('done'), { what: 'turn end' });
    } finally { c.ws.close(); }
  });

  it('observe: a rejection records exactly one directive_rejected (with the directive meta); a repeat decision for the same request is ignored', async () => {
    const directive = `drop it ${uniq()}`;
    const c = await openObserve(confirmSrv.port).ready();
    try {
      queueDirective(directive);
      c.send({ type: 'user', text: 'tell victim', panes: [] });
      const f = await awaitProposed(c, directive);
      c.send({ type: 'gate_decision', requestId: f.requestId, approved: false });
      await pollUntil(() => c.find('done'), { what: 'turn end' });
      c.send({ type: 'gate_decision', requestId: f.requestId, approved: false }); // replay of the same decision
      await sleep(400);
      const rej = await eventsOf('directive_rejected', (e) => e.directive === directive);
      assert.strictEqual(rej.length, 1, `expected ONE directive_rejected, got ${rej.length}`);
      assert.strictEqual(rej[0].role, 'claude');
      assert.strictEqual(rej[0].host, LOCAL);
      assert.ok('container' in rej[0], 'meta (container) carried onto the rejected event');
      assert.strictEqual((await eventsOf('directive_sent', (e) => e.directive === directive)).length, 0, 'a rejected directive is never sent');
    } finally { c.ws.close(); }
  });

  it('observe: an approval sends and records directive_sent, never directive_rejected', async () => {
    const directive = `ship it ${uniq()}`;
    const c = await openObserve(confirmSrv.port).ready();
    try {
      queueDirective(directive);
      c.send({ type: 'user', text: 'tell victim', panes: [] });
      const f = await awaitProposed(c, directive);
      c.send({ type: 'gate_decision', requestId: f.requestId, approved: true });
      await pollUntil(async () => (await eventsOf('directive_sent', (e) => e.directive === directive)).length, { what: 'directive_sent' });
      await pollUntil(() => c.find('done'), { what: 'turn end' });
      await sleep(200);
      assert.strictEqual((await eventsOf('directive_rejected', (e) => e.directive === directive)).length, 0, 'an approved directive must not log a rejection');
    } finally { c.ws.close(); }
  });

  it('observe: approve-with-edit sends the EDITED text', async () => {
    const original = `original ${uniq()}`;
    const edited = `edited-${uniq()}`;
    const c = await openObserve(confirmSrv.port).ready();
    try {
      queueDirective(original);
      c.send({ type: 'user', text: 'tell victim', panes: [] });
      const f = await awaitProposed(c, original);
      c.send({ type: 'gate_decision', requestId: f.requestId, approved: true, edited });
      await pollUntil(async () => (await eventsOf('directive_sent', (e) => e.directive === edited)).length, { what: 'directive_sent with edited text' });
      assert.strictEqual((await eventsOf('directive_sent', (e) => e.directive === original)).length, 0, 'the original text must not be what was sent');
    } finally { c.ws.close(); }
  });

  it('observe: WARDEN-1900 — a gate_decision sent synchronously on receipt of directive_proposed is honoured in 30/30 trials (approve sends, reject records directive_rejected)', async () => {
    const N = 30;
    for (let i = 0; i < N; i++) {
      const approve = i % 2 === 0;
      const directive = `race ${approve ? 'approve' : 'reject'} ${i} ${uniq()}`;
      const c = openObserve(confirmSrv.port);
      // Reply from inside the message handler, i.e. ~0ms after the frame arrives.
      c.ws.on('message', (d) => {
        let f; try { f = JSON.parse(String(d)); } catch { return; }
        if (f.type === 'directive_proposed' && f.directive === directive) {
          c.send({ type: 'gate_decision', requestId: f.requestId, approved: approve });
        }
      });
      await c.ready();
      try {
        queueDirective(directive);
        c.send({ type: 'user', text: 'tell victim', panes: [] });
        await pollUntil(() => c.find('done'), { what: `done (trial ${i}, ${approve ? 'approve' : 'reject'})` });
        if (approve) {
          await pollUntil(async () => (await eventsOf('directive_sent', (e) => e.directive === directive)).length, { what: `directive_sent (trial ${i})` });
          assert.strictEqual((await eventsOf('directive_rejected', (e) => e.directive === directive)).length, 0, `trial ${i}: approve must not log a rejection`);
        } else {
          await pollUntil(async () => (await eventsOf('directive_rejected', (e) => e.directive === directive)).length, { what: `directive_rejected (trial ${i})` });
          assert.strictEqual((await eventsOf('directive_sent', (e) => e.directive === directive)).length, 0, `trial ${i}: reject must not send`);
        }
      } finally { c.ws.close(); }
    }
  });

  it('observe: closing the socket declines a pending directive — it is never sent', async () => {
    const directive = `never sent ${uniq()}`;
    const c = await openObserve(confirmSrv.port).ready();
    queueDirective(directive);
    c.send({ type: 'user', text: 'tell victim', panes: [] });
    await awaitProposed(c, directive);
    c.ws.close();
    await sleep(800);
    assert.strictEqual((await eventsOf('directive_sent', (e) => e.directive === directive)).length, 0, 'closing the socket must never send the directive');
  });

  it('observe: auto-safe auto-sends read-only directives — case-insensitive and leading-space tolerant — with no gate', async () => {
    for (const directive of [`list the files ${uniq()}`, `LIST ALL ${uniq()}`, `  read it ${uniq()}`]) {
      const c = await openObserve(autoSrv.port).ready();
      try {
        queueDirective(directive);
        c.send({ type: 'user', text: 'tell victim', panes: [] });
        // directive_sent records the (untrimmed) directive text that reached the pane
        await pollUntil(async () => (await eventsOf('directive_sent', (e) => e.directive === directive)).length, { what: `auto-sent ${JSON.stringify(directive)}` });
        await pollUntil(() => c.find('done'), { what: 'turn end' });
        assert.strictEqual(c.find('directive_proposed'), undefined, `${JSON.stringify(directive)} must not be gated in auto-safe`);
        assert.strictEqual((await eventsOf('directive_proposed', (e) => e.directive === directive)).length, 0);
      } finally { c.ws.close(); }
    }
  });

  it('observe: auto-safe still gates a non-read-only directive, and one that merely CONTAINS a read verb', async () => {
    for (const directive of [`restart the build ${uniq()}`, `please list the files ${uniq()}`]) {
      const c = await openObserve(autoSrv.port).ready();
      try {
        queueDirective(directive);
        c.send({ type: 'user', text: 'tell victim', panes: [] });
        const f = await awaitProposed(c, directive);
        assert.strictEqual(f.directive, directive);
        assert.strictEqual((await eventsOf('directive_sent', (e) => e.directive === directive)).length, 0, 'gated, not auto-sent');
        c.send({ type: 'gate_decision', requestId: f.requestId, approved: false });
        await pollUntil(() => c.find('done'), { what: 'turn end' });
      } finally { c.ws.close(); }
    }
  });

  it('observe: confirm mode (not auto-safe) gates even a read-only directive', async () => {
    const directive = `list the files ${uniq()}`;
    const c = await openObserve(confirmSrv.port).ready();
    try {
      queueDirective(directive);
      c.send({ type: 'user', text: 'tell victim', panes: [] });
      const f = await awaitProposed(c, directive);
      c.send({ type: 'gate_decision', requestId: f.requestId, approved: false });
      await pollUntil(() => c.find('done'), { what: 'turn end' });
    } finally { c.ws.close(); }
  });

  // ======================= /api/stream =======================

  function connectStream(port) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/stream`);
    const msgs = [];
    ws.on('message', (raw) => { try { msgs.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
    const opened = new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const api = {
      ws, msgs, opened,
      send: (o) => ws.send(JSON.stringify(o)),
      ofType: (type, id) => msgs.filter((m) => m.type === type && (id === undefined || m.id === id)),
      waitN: (type, id, n = 1, timeout = 5000) => pollUntil(() => (api.ofType(type, id).length >= n ? api.ofType(type, id) : null), { timeout, what: `${n}× ${type} ${id ?? ''}` }),
    };
    return api;
  }

  it('stream: an unknown upgrade path has its socket destroyed (no hang)', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${confirmSrv.port}/api/nope`);
    let err = null;
    ws.on('error', (e) => { err = e; });
    try {
      await pollUntil(() => err, { timeout: 3000, what: 'upgrade refusal' });
    } finally { ws.terminate(); }
  });

  it('stream: a monitor snapshot carries the monitored id, pane text, host and chat name', async () => {
    const chat = await newSession('echo SNAPMARK-1; exec cat');
    const c = connectStream(confirmSrv.port);
    await c.opened;
    try {
      c.send({ type: 'monitor', id: chat.key });
      const [snap] = await c.waitN('snapshot', chat.key);
      assert.strictEqual(snap.host, LOCAL);
      assert.strictEqual(snap.name, chat.name);
      assert.strictEqual(typeof snap.pane, 'string');
      assert.ok(snap.pane.includes('SNAPMARK-1'), `pane: ${JSON.stringify(snap.pane)}`);
    } finally { c.ws.close(); }
  });

  it('stream: a numeric monitor id is coerced to a string before it reaches resolve', async () => {
    const c = connectStream(confirmSrv.port);
    await c.opened;
    try {
      c.send({ type: 'monitor', id: 12345 });
      await pollUntil(() => resolveCalls.length > 0, { what: 'resolve call' });
      assert.strictEqual(resolveCalls[0], '12345');
      assert.strictEqual(typeof resolveCalls[0], 'string');
    } finally { c.ws.close(); }
  });

  it('stream: monitor waits for resolve (catalogue seeded) before the first tick — the snapshot is immediate, not a poll later', async () => {
    const chat = await newSession('echo AWAIT-MARK; exec cat');
    resolveDelayMs = 400;
    const c = connectStream(confirmSrv.port);
    await c.opened;
    try {
      c.send({ type: 'monitor', id: chat.key });
      // resolve finishes at ~400ms and seeds the catalogue; the awaited resolve means the
      // first tick sees it. Without the await the first tick runs on an empty catalogue
      // and the snapshot only arrives with the next 2s timer beat.
      await c.waitN('snapshot', chat.key, 1, 1500);
    } finally { c.ws.close(); }
  });

  it('stream: a second monitor does not restart the timer — no extra immediate tick', async () => {
    const a = await newSession('echo MON-A; exec cat');
    const b = await newSession('echo MON-B; exec cat');
    const c = connectStream(confirmSrv.port);
    await c.opened;
    try {
      c.send({ type: 'monitor', id: a.key });
      await c.waitN('snapshot', a.key);
      c.send({ type: 'monitor', id: b.key });
      await pollUntil(() => resolveCalls.includes(b.key), { what: 'second resolve' });
      await sleep(700); // well inside the 2s beat: a re-entered startMonitor would tick NOW
      assert.strictEqual(c.ofType('snapshot', b.key).length, 0, 'second monitor must wait for the shared timer beat');
      await c.waitN('snapshot', b.key, 1, 4000); // …and then it is served by it
    } finally { c.ws.close(); }
  });

  it('stream: attach of an unresolvable id answers attach_error and records an error event', async () => {
    const id = `ghost-${uniq()}`;
    const c = connectStream(confirmSrv.port);
    await c.opened;
    try {
      c.send({ type: 'attach', id, cols: 80, rows: 24 });
      const [f] = await c.waitN('attach_error', id);
      assert.match(f.error, /no chat matches/);
      const ev = await pollUntil(async () => (await eventsOf('error', (e) => e.context === 'attach' && e.id === id))[0], { what: 'attach error event' });
      assert.match(ev.error, /no chat matches/);
    } finally { c.ws.close(); }
  });

  it('stream: attach announces attached (frame + activity event) and a second attach for a live id is a no-op', async () => {
    const chat = await newSession();
    const c = connectStream(confirmSrv.port);
    await c.opened;
    try {
      c.send({ type: 'attach', id: chat.id, cols: 80, rows: 24 });
      await c.waitN('attached', chat.id);
      const ev = await pollUntil(async () => (await eventsOf('attached', (e) => e.id === chat.id))[0], { what: 'attached event' });
      assert.strictEqual(ev.host, LOCAL);
      assert.ok('container' in ev);
      await waitClients(chat.session, (cl) => cl.length === 1, 'one client');
      c.send({ type: 'attach', id: chat.id, cols: 80, rows: 24 });
      await sleep(800);
      assert.strictEqual(c.ofType('attached', chat.id).length, 1, 'duplicate attach must not announce again');
      assert.strictEqual((await clients(chat.session)).length, 1, 'duplicate attach must not spawn a second PTY');
    } finally { c.ws.close(); }
  });

  it('stream: attach geometry is floored at 20x6 and defaults to 100x30', async () => {
    const small = await newSession();
    const dflt = await newSession();
    const c = connectStream(confirmSrv.port);
    await c.opened;
    try {
      c.send({ type: 'attach', id: small.id, cols: 5, rows: 2 });
      c.send({ type: 'attach', id: dflt.id });
      await c.waitN('attached', small.id);
      await c.waitN('attached', dflt.id);
      assert.deepStrictEqual(await waitClients(small.session, (cl) => cl.length === 1 && cl[0] === '20x6', '20x6 floor'), ['20x6']);
      assert.deepStrictEqual(await waitClients(dflt.session, (cl) => cl.length === 1 && cl[0] === '100x30', '100x30 default'), ['100x30']);
    } finally { c.ws.close(); }
  });

  it('stream: attach to a session that is gone answers session_dead and spawns no PTY', async () => {
    const chat = mkChat(`wsl-gone-${process.pid}-${uniq()}`);
    register(chat);
    const c = connectStream(confirmSrv.port);
    await c.opened;
    try {
      c.send({ type: 'attach', id: chat.id, cols: 80, rows: 24 });
      await c.waitN('session_dead', chat.id);
      const ev = await pollUntil(async () => (await eventsOf('error', (e) => e.context === 'attach' && e.id === chat.id))[0], { what: 'session dead event' });
      assert.strictEqual(ev.error, 'session dead');
      assert.strictEqual(ev.host, LOCAL);
      assert.ok('container' in ev);
      await sleep(800);
      assert.strictEqual(c.ofType('attached', chat.id).length, 0, 'a dead session must not proceed to attach');
      assert.strictEqual(c.ofType('ended', chat.id).length, 0, 'no PTY was spawned, so nothing can end');
    } finally { c.ws.close(); }
  });

  it('stream: input reaches the attached PTY and its echo comes back as pty frames', async () => {
    const chat = await newSession('cat');
    const c = connectStream(confirmSrv.port);
    await c.opened;
    try {
      c.send({ type: 'attach', id: chat.id, cols: 80, rows: 24 });
      await c.waitN('attached', chat.id);
      const token = `ECHO-${uniq()}`;
      c.send({ type: 'input', id: chat.id, data: `${token}\r` });
      await pollUntil(() => c.ofType('pty', chat.id).some((f) => f.data.includes(token)), { what: 'pty echo' });
    } finally { c.ws.close(); }
  });

  it('stream: resize applies floored geometry to the PTY (defaults 80x24, floor 20x6, fractions floored)', async () => {
    const chat = await newSession();
    const c = connectStream(confirmSrv.port);
    await c.opened;
    try {
      c.send({ type: 'attach', id: chat.id, cols: 100, rows: 30 });
      await c.waitN('attached', chat.id);
      await waitClients(chat.session, (cl) => cl[0] === '100x30', 'initial 100x30');
      c.send({ type: 'resize', id: chat.id });
      await waitClients(chat.session, (cl) => cl[0] === '80x24', 'default 80x24');
      c.send({ type: 'resize', id: chat.id, cols: 3, rows: 1 });
      await waitClients(chat.session, (cl) => cl[0] === '20x6', 'floor 20x6');
      c.send({ type: 'resize', id: chat.id, cols: 90.9, rows: 33.2 });
      await waitClients(chat.session, (cl) => cl[0] === '90x33', 'floored 90x33');
    } finally { c.ws.close(); }
  });

  it('stream: a natural session end emits ended with a numeric exit code and an ended event', async () => {
    const chat = await newSession();
    const c = connectStream(confirmSrv.port);
    await c.opened;
    try {
      c.send({ type: 'attach', id: chat.id, cols: 80, rows: 24 });
      await c.waitN('attached', chat.id);
      await runLocalTmux(['kill-session', '-t', chat.session]);
      const [f] = await c.waitN('ended', chat.id);
      assert.ok(Number.isInteger(f.code), `ended.code must be a number, got ${JSON.stringify(f.code)}`);
      const ev = await pollUntil(async () => (await eventsOf('ended', (e) => e.id === chat.id))[0], { what: 'ended event' });
      assert.strictEqual(ev.host, LOCAL);
      assert.ok(Number.isInteger(ev.code));
      assert.ok('container' in ev);
    } finally { c.ws.close(); }
  });

  it('stream: detach kills the attach PTY — the tmux client goes away and input is no longer forwarded', async () => {
    const chat = await newSession('cat');
    const c = connectStream(confirmSrv.port);
    await c.opened;
    try {
      c.send({ type: 'attach', id: chat.id, cols: 80, rows: 24 });
      await c.waitN('attached', chat.id);
      await waitClients(chat.session, (cl) => cl.length === 1, 'one client');
      c.send({ type: 'detach', id: chat.id });
      await waitClients(chat.session, (cl) => cl.length === 0, 'client gone after detach');
      const before = c.ofType('pty', chat.id).length;
      c.send({ type: 'input', id: chat.id, data: `AFTER-DETACH-${uniq()}\r` });
      await sleep(500);
      assert.strictEqual(c.ofType('pty', chat.id).length, before, 'no pty frames after detach');
    } finally { c.ws.close(); }
  });

  it('stream: closing the socket kills every attach PTY (the tmux session lives on)', async () => {
    const a = await newSession();
    const b = await newSession();
    const c = connectStream(confirmSrv.port);
    await c.opened;
    c.send({ type: 'attach', id: a.id, cols: 80, rows: 24 });
    c.send({ type: 'attach', id: b.id, cols: 80, rows: 24 });
    await c.waitN('attached', a.id);
    await c.waitN('attached', b.id);
    await waitClients(a.session, (cl) => cl.length === 1, 'a attached');
    await waitClients(b.session, (cl) => cl.length === 1, 'b attached');
    c.ws.close();
    await waitClients(a.session, (cl) => cl.length === 0, 'a client gone after close');
    await waitClients(b.session, (cl) => cl.length === 0, 'b client gone after close');
    assert.ok((await runLocalTmux(['has-session', '-t', a.session])).ok, 'the tmux session itself survives');
  });

  it('stream: a detach→attach rebind emits no ended for the killed prior PTY (identity guard control)', async () => {
    const chat = await newSession();
    const c = connectStream(confirmSrv.port);
    await c.opened;
    try {
      c.send({ type: 'attach', id: chat.id, cols: 80, rows: 24 });
      await c.waitN('attached', chat.id);
      c.send({ type: 'detach', id: chat.id });
      await sleep(25);
      c.send({ type: 'attach', id: chat.id, cols: 80, rows: 24 });
      await c.waitN('attached', chat.id, 2);
      await sleep(800);
      assert.strictEqual(c.ofType('ended', chat.id).length, 0, `got ${JSON.stringify(c.ofType('ended', chat.id))}`);
    } finally { c.ws.close(); }
  });
});
