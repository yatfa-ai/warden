import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { WebSocket } from 'ws';
import {
  _primeChannelForTests,
  _resetChannelCacheForTests,
  _resetPaneDeltaStateForTests,
  _getPaneSubscriptionsForTests,
} from './companion.js';

/**
 * WARDEN-1860 — /api/stream monitor: an `unmonitor` landing while the same
 * connection's `monitor` for the same id is still inside `await resolve(id)`
 * must register neither the monitor timer nor the companion pane-push
 * subscription.
 *
 * Frames are NOT serialized (`ws.on('message')` starts one promise per frame),
 * so `unmonitor X` runs to completion (`monitors.delete(X)` + a no-op
 * stopMonitorIfEmpty) while `monitor X` sits in `await resolve(id)`. The
 * pre-await `isNew` is then stale and the post-await liveness re-check is
 * connection-scoped only (`closed`), so the resumed continuation:
 *   • `startMonitor()`s a 2s interval over the now-EMPTY monitors set (a no-op
 *     tick — tickMonitor early-returns before any snapshot, hence invisible to
 *     a snapshot spy — that lives until close), and
 *   • subscribes the pane anyway off the stale newness, whose WS ref
 *     `companion.js` can never release: `paneSubscriptions` has NO TTL (the
 *     TTL sweep ages only agentStateWatched), the unmonitor already ran, and
 *     the close handler unsubscribed only keys still in `monitors` — a
 *     permanent 1Hz companion capture for nobody.
 *
 * The monitor→unmonitor→monitor burst mid-resolve is the second-order arm:
 * both continuations compute stale newness and subscribe twice for one
 * watcher, stranding one ref after the final unmonitor.
 *
 * The observable contract asserted here is the ref-counted subscription state
 * (`_getPaneSubscriptionsForTests()`): refs move synchronously inside
 * subscribePanes/unsubscribePanes, before the async channel sync, so no
 * channel/ssh wait is needed to assert.
 *
 * HOME is redirected and WARDEN_COMPANION_TRANSPORT=1 is set BEFORE the
 * dynamic import (mirrors wsLayer-closed-socket.test.js). A fake channel is
 * primed into companion's channel cache so the fire-and-forget sync RPCs run
 * against a stub instead of spawning real SSH; the ref assertions never
 * depend on those syncs completing. The monitor tick (2s) calls capturePanes
 * on the fixture's remote host, so every test releases the monitor (or
 * closes) well inside the first 2s beat — the same timing discipline the
 * closed-socket suite's positive control uses.
 */

const HOST = 'prod';
const RESOLVE_DELAY = 600;
const SETTLE_AT = 100; // when the racing frames land, still inside the resolve await
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('WARDEN-1860 — /api/stream monitor: stale unmonitor during resolve', () => {
  let httpServer, port, saved, tempHome, chat;
  let resolveDelayMs = 0;
  // Every socket this suite opened. A failing assertion must not strand one:
  // on the UNFIXED code the bug this suite hunts keeps a leaked 2s interval (and
  // the open socket) alive past the test, which would hang the runner at exit.
  const sockets = new Set();

  const resolve = async (id) => {
    if (resolveDelayMs) await sleep(resolveDelayMs);
    if (chat && (id === chat.id || id === chat.key)) return { chat };
    return { error: `no chat matches "${id}"` };
  };
  const chatCatalog = {
    snapshot: () => (chat ? [chat] : []),
    has: () => !!chat,
    refreshHost: async () => {},
  };

  const open = () => new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/stream`);
    ws.once('error', rej);
    ws.once('open', () => { sockets.add(ws); res(ws); });
  });

  // Minimal live-channel stand-in: `_methods` short-circuits the ping
  // feature-detect, `call` resolves the sync RPC, `onEvent` absorbs the
  // paneDelta fan-out wiring, `kill` lets the test-only cache reset noop.
  const fakeChannel = () => ({
    _methods: ['ping', 'subscribePanes', 'unsubscribePanes'],
    call: async () => ({ ok: true }),
    onEvent: () => {},
    dead: false,
    kill: () => {},
  });

  before(async () => {
    saved = {
      HOME: process.env.HOME,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
      WARDEN_COMPANION_TRANSPORT: process.env.WARDEN_COMPANION_TRANSPORT,
    };
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-ws-1860-'));
    process.env.HOME = tempHome;
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
    process.env.WARDEN_COMPANION_TRANSPORT = '1';
    fs.mkdirSync(path.join(tempHome, '.yatfa-warden', 'sessions'), { recursive: true });
    const { setupWsLayer } = await import('./wsLayer.js');
    httpServer = http.createServer(() => {});
    setupWsLayer({ server: httpServer, cfg: { connectTimeout: 5, hosts: [] }, resolve, chatCatalog });
    await new Promise((res, rej) => { httpServer.once('error', rej); httpServer.listen(0, '127.0.0.1', res); });
    port = httpServer.address().port;
  });

  beforeEach(() => {
    resolveDelayMs = 0;
    _resetChannelCacheForTests();
    _resetPaneDeltaStateForTests();
    _primeChannelForTests(HOST, fakeChannel());
    const session = `sess-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    chat = { id: `${HOST}:${session}`, key: session, kind: 'tmux', host: HOST, container: null, session,
      project: 'local', role: 'claude', name: session, cwd: '', cmd: 'cat', active: true };
  });

  // A failing assertion must not strand its socket: on the UNFIXED code the bug
  // this suite hunts keeps the leaked 2s interval (and the open socket) alive
  // past the test, which would hang the runner at exit. Close leftovers here.
  afterEach(async () => {
    for (const ws of sockets) { try { ws.close(); } catch { /* best-effort */ } }
    sockets.clear();
    await sleep(50); // let the server-side close handlers run before the next test resets shared state
  });

  after(async () => {
    httpServer.closeAllConnections?.();
    await new Promise((r) => httpServer.close(r));
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('an unmonitor landing while monitor is inside resolve registers nothing (zero refs)', async () => {
    resolveDelayMs = RESOLVE_DELAY;
    const ws = await open();
    ws.send(JSON.stringify({ type: 'monitor', id: chat.key }));
    await sleep(SETTLE_AT);
    ws.send(JSON.stringify({ type: 'unmonitor', id: chat.key }));
    await sleep(RESOLVE_DELAY); // resolve settles; the stale continuation would run here
    assert.deepStrictEqual(_getPaneSubscriptionsForTests(), {},
      'a pane unmonitored during resolve must hold no companion subscription ref');
    ws.close();
    await sleep(50);
  });

  it('monitor→unmonitor→monitor mid-resolve yields exactly one ref while one watcher lives, zero after the final unmonitor', async () => {
    resolveDelayMs = RESOLVE_DELAY;
    const ws = await open();
    ws.send(JSON.stringify({ type: 'monitor', id: chat.key }));
    ws.send(JSON.stringify({ type: 'unmonitor', id: chat.key }));
    ws.send(JSON.stringify({ type: 'monitor', id: chat.key }));
    await sleep(RESOLVE_DELAY + 100); // both continuations resume; the double-subscribe arm fires here
    assert.deepStrictEqual(_getPaneSubscriptionsForTests()[HOST], { [chat.key]: 1 },
      'two stale-newness continuations must still produce exactly one ref while one watcher lives');
    ws.send(JSON.stringify({ type: 'unmonitor', id: chat.key }));
    await sleep(100);
    assert.deepStrictEqual(_getPaneSubscriptionsForTests(), {},
      'the final unmonitor must release the last ref');
    ws.close();
    await sleep(50);
  });

  it('control: a plain monitor holds exactly one ref, and its unmonitor releases it', async () => {
    resolveDelayMs = RESOLVE_DELAY;
    const ws = await open();
    ws.send(JSON.stringify({ type: 'monitor', id: chat.key }));
    await sleep(RESOLVE_DELAY + 100);
    assert.deepStrictEqual(_getPaneSubscriptionsForTests()[HOST], { [chat.key]: 1 },
      'a plain monitor subscribes exactly one ref');
    ws.send(JSON.stringify({ type: 'unmonitor', id: chat.key }));
    await sleep(100);
    assert.deepStrictEqual(_getPaneSubscriptionsForTests(), {},
      'the matching unmonitor releases it');
    ws.close();
    await sleep(50);
  });

  it('control: closing the socket releases the subscription', async () => {
    resolveDelayMs = RESOLVE_DELAY;
    const ws = await open();
    ws.send(JSON.stringify({ type: 'monitor', id: chat.key }));
    await sleep(RESOLVE_DELAY + 100);
    assert.deepStrictEqual(_getPaneSubscriptionsForTests()[HOST], { [chat.key]: 1 });
    ws.close();
    await sleep(150);
    assert.deepStrictEqual(_getPaneSubscriptionsForTests(), {},
      'the close handler releases every ref this connection registered');
  });
});
