import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { WebSocket } from 'ws';

/**
 * WARDEN-1796 — a frame whose fields throw on coercion (`id: {"toString":null}`,
 * `cols: {"toString":null}`) must not kill the server.
 *
 * The WARDEN-1699 guard only checks `m && typeof m === 'object'`; a later
 * `String(m.id)` / `Math.floor(m.cols)` still throws "Cannot convert object to primitive
 * value" inside the async ws listener -> unhandledRejection -> process exit on Node >= 15.
 * /api/stream must drop such frames and keep the socket usable.
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

// Raw JSON strings: these cannot be built with JSON.stringify of a throwing object.
const FRAMES = {
  'monitor id:{toString:null}': '{"type":"monitor","id":{"toString":null}}',
  'unmonitor id:{toString:null}': '{"type":"unmonitor","id":{"toString":null}}',
  'attach id:{toString:null}': '{"type":"attach","id":{"toString":null}}',
  'resize cols:{toString:null}': '{"type":"resize","id":"x","cols":{"toString":null},"rows":24}',
  'resize rows:{toString:null}': '{"type":"resize","id":"x","cols":80,"rows":{"toString":null}}',
  'monitor id:{toString:1}': '{"type":"monitor","id":{"toString":1}}',
};

describe('WARDEN-1796 — throwing-coercion frames never escape the /api/stream message handler', () => {
  let httpServer, port, saved, tempHome, snapshotCalls;
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);

  before(async () => {
    saved = { HOME: process.env.HOME, ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN };
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-ws-coercion-'));
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

  it('positive control: a valid monitor frame is handled, 0 rejections', async () => {
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

  for (const [name, raw] of Object.entries(FRAMES)) {
    it(`drops ${name} with 0 rejections and the socket still handles the next frame`, async () => {
      const ws = await open(port, '/api/stream');
      ws.send(raw);
      await settle();
      assert.strictEqual(rejections.length, 0, `unhandled rejections: ${rejections.map(String)}`);
      assert.strictEqual(ws.readyState, WebSocket.OPEN);
      const before = snapshotCalls;
      ws.send(JSON.stringify({ type: 'monitor', id: 'after-coercion' }));
      await settle();
      assert.ok(snapshotCalls > before, 'a valid monitor frame after the hostile one must still be handled');
      ws.send(JSON.stringify({ type: 'unmonitor', id: 'after-coercion' }));
      await settle();
      ws.close();
      assert.strictEqual(rejections.length, 0, `unhandled rejections: ${rejections.map(String)}`);
    });
  }
});
