import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { WebSocket } from 'ws';

/**
 * WARDEN-1804 — a protocol-violating frame (invalid UTF-8 text frame) makes the ws
 * receiver emit 'error' on the server-side socket BEFORE any message handler runs.
 * With no ws.on('error') listener that is an uncaught exception that kills the process.
 * Both /api/stream (unauthenticated) and /api/observe must log-and-continue.
 *
 * HOME is redirected BEFORE the dynamic import.
 */

const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

// Masked text frame, FIN set, 2-byte payload ff fe (invalid UTF-8), zero mask key.
const BAD_FRAME = Buffer.from([0x81, 0x82, 0, 0, 0, 0, 0xff, 0xfe]);

function rawUpgrade(port, route) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = '';
    sock.once('error', reject);
    sock.on('connect', () => {
      sock.write(
        `GET ${route} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\n` +
        'Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'
      );
    });
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n\r\n')) {
        sock.removeAllListeners('data');
        sock.on('data', () => {});
        sock.removeListener('error', reject);
        sock.on('error', () => {});
        assert.match(buf, /101/, `upgrade should succeed, got: ${buf.split('\r\n')[0]}`);
        resolve(sock);
      }
    });
  });
}

function open(port, route) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${route}`);
    ws.once('error', reject);
    ws.once('open', () => resolve(ws));
  });
}

describe('WARDEN-1804 — ws socket protocol errors never escape as uncaught exceptions', () => {
  let httpServer, port, saved, tempHome, snapshotCalls;
  const uncaught = [];
  const onUncaught = (e) => uncaught.push(e);
  let origWarn;

  before(async () => {
    saved = { HOME: process.env.HOME, ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN };
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-ws-sockerr-'));
    process.env.HOME = tempHome;
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
    fs.mkdirSync(path.join(tempHome, '.yatfa-warden', 'sessions'), { recursive: true });
    snapshotCalls = 0;
    origWarn = console.warn;
    console.warn = () => {};

    process.on('uncaughtException', onUncaught);

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

  beforeEach(() => { uncaught.length = 0; });

  after(async () => {
    process.removeListener('uncaughtException', onUncaught);
    console.warn = origWarn;
    await new Promise((r) => { httpServer.closeAllConnections?.(); httpServer.close(r); });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('positive control: a valid monitor frame on /api/stream is still handled', async () => {
    const ws = await open(port, '/api/stream');
    const before = snapshotCalls;
    ws.send(JSON.stringify({ type: 'monitor', id: 'ctl' }));
    await settle();
    assert.ok(snapshotCalls > before, 'valid frame should reach the handler');
    ws.send(JSON.stringify({ type: 'unmonitor', id: 'ctl' }));
    await settle();
    ws.close();
    assert.strictEqual(uncaught.length, 0);
  });

  for (const route of ['/api/stream', '/api/observe']) {
    it(`invalid-UTF-8 frame on ${route}: 0 uncaught exceptions and a fresh connection still works`, async () => {
      const sock = await rawUpgrade(port, route);
      sock.write(BAD_FRAME);
      await settle();
      sock.destroy();
      assert.strictEqual(
        uncaught.length, 0,
        `uncaught exceptions: ${uncaught.map((e) => e && (e.code || e.message))}`,
      );
      const ws = await open(port, '/api/stream');
      assert.strictEqual(ws.readyState, WebSocket.OPEN);
      const before = snapshotCalls;
      ws.send(JSON.stringify({ type: 'monitor', id: 'after-bad-frame' }));
      await settle();
      assert.ok(snapshotCalls > before, 'server still serves valid frames after the hostile one');
      ws.send(JSON.stringify({ type: 'unmonitor', id: 'after-bad-frame' }));
      await settle();
      ws.close();
      assert.strictEqual(uncaught.length, 0);
    });
  }
});
