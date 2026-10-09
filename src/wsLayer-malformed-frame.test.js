import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { WebSocket } from 'ws';

/**
 * WARDEN-1699 — a well-formed-JSON-but-non-object frame (`null`) must not kill the server.
 *
 * `JSON.parse('null')` succeeds, so the malformed-JSON catch never fires and the following
 * `msg.type` / `m.type` dereference throws inside an async ws listener -> unhandledRejection
 * -> process exit on Node >= 15. Both /api/observe and /api/stream must silently drop such
 * frames (matching the malformed-JSON branch) and keep the socket usable.
 *
 * HOME is redirected BEFORE the dynamic import.
 */

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

function open(port, route) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${route}`);
    ws.once('error', reject);
    ws.once('open', () => resolve(ws));
  });
}

describe('WARDEN-1699 — non-object frames never escape the ws message handlers', () => {
  let httpServer, port, saved, tempHome, snapshotCalls;
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);

  before(async () => {
    saved = { HOME: process.env.HOME, ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN };
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-ws-malformed-'));
    process.env.HOME = tempHome;
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
    fs.mkdirSync(path.join(tempHome, '.yatfa-warden', 'sessions'), { recursive: true });
    snapshotCalls = 0;

    process.on('unhandledRejection', onRejection);

    const { setupWsLayer } = await import('./wsLayer.js');
    httpServer = http.createServer(() => {});
    setupWsLayer({
      server: httpServer,
      cfg: { connectTimeout: 1, hosts: [] },
      resolve: async () => ({ error: 'unused' }),
      chatCatalog: { snapshot: () => { snapshotCalls++; return []; }, has: () => true },
    });
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', resolve);
    });
    port = httpServer.address().port;
  });

  beforeEach(() => { rejections.length = 0; });

  after(async () => {
    process.removeListener('unhandledRejection', onRejection);
    await new Promise((r) => httpServer.close(r));
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('/api/stream positive control: a valid monitor frame is handled, 0 rejections', async () => {
    const ws = await open(port, '/api/stream');
    const before = snapshotCalls;
    ws.send(JSON.stringify({ type: 'monitor', id: 'ctl' }));
    await settle();
    assert.ok(snapshotCalls > before, 'monitor frame should reach the handler (tick reads the catalogue)');
    ws.send(JSON.stringify({ type: 'unmonitor', id: 'ctl' }));
    await settle();
    ws.close();
    assert.strictEqual(rejections.length, 0, `unhandled rejections: ${rejections.map(String)}`);
  });

  it('/api/stream: a `null` frame is dropped silently and the socket still handles the next frame', async () => {
    const ws = await open(port, '/api/stream');
    ws.send('null');
    await settle();
    assert.strictEqual(rejections.length, 0, `unhandled rejections: ${rejections.map(String)}`);
    assert.strictEqual(ws.readyState, WebSocket.OPEN);
    const before = snapshotCalls;
    ws.send(JSON.stringify({ type: 'monitor', id: 'after-null' }));
    await settle();
    assert.ok(snapshotCalls > before, 'a valid frame after `null` must still be handled');
    ws.send(JSON.stringify({ type: 'unmonitor', id: 'after-null' }));
    await settle();
    ws.close();
    assert.strictEqual(rejections.length, 0, `unhandled rejections: ${rejections.map(String)}`);
  });

  it('/api/observe: a `null` frame is dropped silently and the socket stays usable', async () => {
    const ws = await open(port, '/api/observe');
    const got = [];
    ws.on('message', (d) => got.push(JSON.parse(String(d))));
    await settle();
    // positive control: a valid (unknown-request) gate_decision frame is accepted, 0 rejections
    ws.send(JSON.stringify({ type: 'gate_decision', requestId: 'nope', approved: true }));
    await settle();
    assert.strictEqual(rejections.length, 0, `unhandled rejections: ${rejections.map(String)}`);

    ws.send('null');
    await settle();
    assert.strictEqual(rejections.length, 0, `unhandled rejections: ${rejections.map(String)}`);
    assert.strictEqual(ws.readyState, WebSocket.OPEN);
    // follow-up valid frame still accepted without error
    ws.send(JSON.stringify({ type: 'gate_decision', requestId: 'nope', approved: false }));
    await settle();
    assert.strictEqual(ws.readyState, WebSocket.OPEN);
    assert.ok(!got.some((f) => f.type === 'error'), `frames: ${JSON.stringify(got)}`);
    ws.close();
    assert.strictEqual(rejections.length, 0, `unhandled rejections: ${rejections.map(String)}`);
  });
});
