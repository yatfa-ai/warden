import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { WebSocket } from 'ws';
import { pollUntil, sleep } from './testWait.js';

/**
 * Handler-contract tests for the two `attach` branches of wireStreamConnection
 * (src/streamConnection.js, the per-connection /api/stream machinery) that no
 * other suite drives:
 *
 *   1. the host_unreachable verdict — `classifyProbe(await probeSession(...))`
 *      answering 'host_unreachable' sends `{type:'host_unreachable', id}` and
 *      appends an activity event `{type:'error', error:'host unreachable',
 *      context:'attach', id, host, container}`. (The sibling session_dead branch
 *      is pinned in wsLayer.test.js; host_unreachable only appears elsewhere as a
 *      "must NOT be emitted" member.)
 *   2. the lazy one-host restore — `if (m.host && !chatCatalog.has(m.id))
 *      await chatCatalog.refreshHost(String(m.host), cfg)` inside a swallowing
 *      try/catch. Every wsLayer suite injects a no-op refreshHost; this one
 *      records its calls.
 *
 * The chat lives on `nohost.invalid` (RFC 6761: never resolves), so the real
 * probe fails as a TRANSPORT failure — a spawn error (code -1) when no ssh binary
 * is installed, or "Could not resolve hostname" when it is; isTransportFailure
 * recognises both — and the attach answers host_unreachable without any tmux.
 * Uses the real http server + setupWsLayer + real WebSocket with injected
 * resolve/chatCatalog (no server.js import). HOME is redirected BEFORE the
 * dynamic imports so the activity journal is throwaway.
 */

const REMOTE = 'nohost.invalid';
const uniq = () => Math.random().toString(36).slice(2, 8);

describe('wireStreamConnection attach: host_unreachable verdict + lazy refreshHost restore', () => {
  let saved, tempHome, srv, readEvents;
  const cfg = { connectTimeout: 1, hosts: [] };
  const known = new Map(); // id -> chat
  const cataloged = new Set(); // ids chatCatalog.has() reports
  const refreshCalls = [];
  let refreshImpl;

  const mkChat = () => {
    const session = `su-${process.pid}-${uniq()}`;
    return {
      id: `${REMOTE}:${session}`, key: session, kind: 'tmux', host: REMOTE, container: null, session,
      project: 'p', role: 'claude', name: `name-${session}`, cwd: '', cmd: 'cat', active: true,
    };
  };
  const resolve = async (id) => {
    const chat = known.get(id);
    return chat ? { chat } : { error: `no chat matches "${id}"` };
  };
  const chatCatalog = {
    snapshot: () => [],
    has: (id) => cataloged.has(id),
    refreshHost: async (...args) => { refreshCalls.push(args); return refreshImpl(...args); },
  };

  before(async () => {
    saved = { HOME: process.env.HOME };
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-streamconn-'));
    process.env.HOME = tempHome;
    fs.mkdirSync(path.join(tempHome, '.yatfa-warden', 'sessions'), { recursive: true });
    ({ readEvents } = await import('./activity.js'));
    const { setupWsLayer } = await import('./wsLayer.js');
    const server = http.createServer(() => {});
    setupWsLayer({ server, cfg, resolve, chatCatalog });
    server.rawSockets = new Set();
    server.on('connection', (sock) => { server.rawSockets.add(sock); sock.once('close', () => server.rawSockets.delete(sock)); });
    await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
    srv = { server, port: server.address().port };
  });

  after(async () => {
    if (srv) {
      try { srv.server.closeAllConnections?.(); } catch { /* noop */ }
      for (const sock of srv.server.rawSockets) sock.destroy();
      await new Promise((r) => srv.server.close(r));
    }
    for (const [k, v] of Object.entries(saved || {})) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(() => { known.clear(); cataloged.clear(); refreshCalls.length = 0; refreshImpl = async () => {}; });

  function connect() {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/api/stream`);
    const msgs = [];
    ws.on('message', (raw) => { try { msgs.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
    const opened = new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const api = {
      ws, msgs, opened,
      send: (o) => ws.send(JSON.stringify(o)),
      ofType: (type, id) => msgs.filter((m) => m.type === type && (id === undefined || m.id === id)),
      waitFor: (type, id) => pollUntil(() => api.ofType(type, id)[0], { timeout: 15000, what: `${type} ${id}` }),
    };
    return api;
  }
  const attachEvents = async (id) => (await readEvents()).filter((e) => e.type === 'error' && e.context === 'attach' && e.id === id);

  it('an attach whose probe fails as a transport failure answers host_unreachable and records an activity error event', async () => {
    const chat = mkChat();
    known.set(chat.id, chat);
    cataloged.add(chat.id);
    const c = connect();
    await c.opened;
    try {
      c.send({ type: 'attach', id: chat.id, cols: 80, rows: 24 });
      const frame = await c.waitFor('host_unreachable', chat.id);
      assert.deepStrictEqual(frame, { type: 'host_unreachable', id: chat.id });
      const ev = await pollUntil(async () => (await attachEvents(chat.id))[0], { what: 'host unreachable event' });
      assert.strictEqual(ev.error, 'host unreachable');
      assert.strictEqual(ev.host, REMOTE);
      assert.ok('container' in ev, 'event carries the container key');
      assert.strictEqual(ev.container, null);
      await sleep(300);
      for (const bad of ['session_dead', 'attached', 'ended', 'attach_error']) {
        assert.strictEqual(c.ofType(bad, chat.id).length, 0, `unexpected ${bad} frame`);
      }
    } finally { c.ws.close(); }
  });

  it('an attach carrying a host for an uncatalogued id refreshes that one host with (host, cfg) before resolving', async () => {
    const chat = mkChat();
    known.set(chat.id, chat);
    const c = connect();
    await c.opened;
    try {
      c.send({ type: 'attach', id: chat.id, host: REMOTE, cols: 80, rows: 24 });
      await c.waitFor('host_unreachable', chat.id);
      assert.strictEqual(refreshCalls.length, 1);
      assert.strictEqual(refreshCalls[0][0], REMOTE);
      assert.strictEqual(refreshCalls[0][1], cfg, 'the connection cfg is forwarded');
    } finally { c.ws.close(); }
  });

  it('a numeric host is coerced to a string before refreshHost', async () => {
    const chat = mkChat();
    known.set(chat.id, chat);
    const c = connect();
    await c.opened;
    try {
      c.send({ type: 'attach', id: chat.id, host: 12345, cols: 80, rows: 24 });
      await c.waitFor('host_unreachable', chat.id);
      assert.strictEqual(refreshCalls.length, 1);
      assert.strictEqual(refreshCalls[0][0], '12345');
      assert.strictEqual(typeof refreshCalls[0][0], 'string');
    } finally { c.ws.close(); }
  });

  it('no refresh happens when the frame carries no host', async () => {
    const chat = mkChat();
    known.set(chat.id, chat);
    const c = connect();
    await c.opened;
    try {
      c.send({ type: 'attach', id: chat.id, cols: 80, rows: 24 });
      await c.waitFor('host_unreachable', chat.id);
      assert.strictEqual(refreshCalls.length, 0);
    } finally { c.ws.close(); }
  });

  it('no refresh happens when the catalogue already has the id', async () => {
    const chat = mkChat();
    known.set(chat.id, chat);
    cataloged.add(chat.id);
    const c = connect();
    await c.opened;
    try {
      c.send({ type: 'attach', id: chat.id, host: REMOTE, cols: 80, rows: 24 });
      await c.waitFor('host_unreachable', chat.id);
      assert.strictEqual(refreshCalls.length, 0);
    } finally { c.ws.close(); }
  });

  it('a throwing refreshHost is swallowed and the attach still reaches its verdict', async () => {
    const chat = mkChat();
    known.set(chat.id, chat);
    refreshImpl = async () => { throw new Error('discovery exploded'); };
    const c = connect();
    await c.opened;
    try {
      c.send({ type: 'attach', id: chat.id, host: REMOTE, cols: 80, rows: 24 });
      const frame = await c.waitFor('host_unreachable', chat.id);
      assert.strictEqual(frame.id, chat.id);
      assert.strictEqual(refreshCalls.length, 1);
      assert.strictEqual(c.ofType('attach_error', chat.id).length, 0);
    } finally { c.ws.close(); }
  });
});
