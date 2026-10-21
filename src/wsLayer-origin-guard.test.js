import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { WebSocket } from 'ws';

/**
 * WARDEN-1896 — Origin/Host guard on the /api/observe + /api/stream WebSocket
 * upgrades and an HTTP Host guard (cross-site WS hijack / DNS rebinding).
 *
 * Browsers apply no same-origin policy to WebSocket handshakes and warden has no
 * auth, so a forged page Origin could attach a tmux pane and write to its PTY.
 * Pins: pure predicates; the real setupWsLayer upgrade (403 on forged Origin/Host,
 * accepted for loopback Origins incl. the Vite dev port and for NO Origin); and the
 * real server.js Express middleware (forged Host -> 403, loopback Host -> 200).
 * HOME is redirected BEFORE the dynamic imports.
 */

const { isAllowedOrigin, isAllowedHost, hostnameOfHostHeader } = await import('./originGuard.js');

describe('isAllowedOrigin', () => {
  it('allows an absent Origin (CLI / companion / ws clients never send one)', () => {
    assert.strictEqual(isAllowedOrigin(undefined), true);
  });
  it('allows loopback origins on any port, incl. IPv6', () => {
    for (const o of ['http://127.0.0.1:7421', 'http://localhost:5173', 'http://localhost', 'https://localhost:8443', 'http://[::1]:7421']) {
      assert.strictEqual(isAllowedOrigin(o), true, o);
    }
  });
  it('rejects foreign, null, unparsable, non-http and lookalike origins', () => {
    for (const o of ['http://evil.example', 'null', '', 'garbage', 'file:///x', 'chrome-extension://abc',
      'http://localhost.evil.example', 'http://127.0.0.1.evil.example', 'http://evil.example:7421',
      'http://localhost@evil.example', 'http://127.0.0.2:7421']) {
      assert.strictEqual(isAllowedOrigin(o), false, JSON.stringify(o));
    }
  });
});

describe('isAllowedHost', () => {
  it('allows loopback hosts with and without ports, incl. bracketed IPv6', () => {
    for (const h of ['127.0.0.1:7421', 'localhost:7421', 'localhost', '127.0.0.1', '[::1]:7421', '[::1]', 'LOCALHOST:1']) {
      assert.strictEqual(isAllowedHost(h, '127.0.0.1'), true, h);
    }
  });
  it('rejects foreign and lookalike hosts', () => {
    for (const h of ['attacker.example:7791', 'attacker.example', 'localhost.evil.example', '127.0.0.1.evil.example:7421',
      '', 'a:b:c', 'localhost:abc', '[::1', '10.0.0.5:7421']) {
      assert.strictEqual(isAllowedHost(h, '127.0.0.1'), false, JSON.stringify(h));
    }
  });
  it('allows the address the server is actually bound to (deliberate non-loopback bind)', () => {
    assert.strictEqual(isAllowedHost('10.0.0.5:7421', '10.0.0.5'), true);
    assert.strictEqual(isAllowedHost('10.0.0.6:7421', '10.0.0.5'), false);
  });
  it('allows a missing Host (HTTP/1.0); rebinding browsers always send one', () => {
    assert.strictEqual(isAllowedHost(undefined, '127.0.0.1'), true);
  });
  it('hostnameOfHostHeader strips ports and brackets', () => {
    assert.strictEqual(hostnameOfHostHeader('[::1]:80'), '::1');
    assert.strictEqual(hostnameOfHostHeader('Foo.Example:80'), 'foo.example');
  });
});

describe('WARDEN-1896 upgrade guard (real setupWsLayer + real ws client)', () => {
  let httpServer, port, saved, tempHome;
  const resolve = async () => ({ error: 'none' });
  const chatCatalog = { snapshot: () => [], has: () => true, refreshHost: async () => {} };

  before(async () => {
    saved = { HOME: process.env.HOME, ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN };
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-origin-'));
    process.env.HOME = tempHome;
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
    fs.mkdirSync(path.join(tempHome, '.yatfa-warden', 'sessions'), { recursive: true });
    const { setupWsLayer } = await import('./wsLayer.js');
    httpServer = http.createServer(() => {});
    setupWsLayer({ server: httpServer, cfg: { connectTimeout: 5, hosts: [] }, resolve, chatCatalog });
    await new Promise((res, rej) => { httpServer.once('error', rej); httpServer.listen(0, '127.0.0.1', res); });
    port = httpServer.address().port;
  });

  after(async () => {
    httpServer.closeAllConnections?.();
    await new Promise((r) => httpServer.close(r));
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  // Resolves { opened:true } or { status } when the handshake was refused.
  const handshake = (route, headers) => new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${route}`, { headers });
    ws.once('open', () => { ws.close(); res({ opened: true }); });
    ws.once('unexpected-response', (_req, r) => { r.resume(); res({ opened: false, status: r.statusCode }); });
    ws.once('error', (e) => rej(e));
  });

  for (const route of ['/api/stream', '/api/observe']) {
    it(`${route}: forged Origin is rejected with 403`, async () => {
      assert.deepStrictEqual(await handshake(route, { Origin: 'http://evil.example' }), { opened: false, status: 403 });
    });
    it(`${route}: 'null' Origin is rejected with 403`, async () => {
      assert.deepStrictEqual(await handshake(route, { Origin: 'null' }), { opened: false, status: 403 });
    });
    it(`${route}: forged Host (DNS rebinding) is rejected with 403`, async () => {
      assert.deepStrictEqual(await handshake(route, { Host: 'attacker.example:7791' }), { opened: false, status: 403 });
    });
    for (const origin of [`http://127.0.0.1:7421`, 'http://localhost:5173', undefined]) {
      it(`${route}: positive control — Origin ${origin ?? '(none)'} is accepted`, async () => {
        const r = await handshake(route, origin ? { Origin: origin } : {});
        assert.strictEqual(r.opened, true, JSON.stringify(r));
      });
    }
  }
});

describe('WARDEN-1896 HTTP Host guard (real server.js middleware)', () => {
  let serverModule, port, saved, tempHome;

  before(async () => {
    saved = { HOME: process.env.HOME };
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-hostguard-'));
    process.env.HOME = tempHome;
    const wardenDir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wardenDir, { recursive: true });
    fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: [] }));
    serverModule = await import('./server.js');
    await new Promise((resolve, reject) => {
      serverModule.server.once('listening', resolve);
      serverModule.server.once('error', reject);
      serverModule.server.listen(0, '127.0.0.1');
    });
    port = serverModule.server.address().port;
  });

  after(async () => {
    try { serverModule.server.closeAllConnections?.(); } catch { /* noop */ }
    if (serverModule?.server?.listening) await new Promise((r) => serverModule.server.close(r));
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  const get = (headers) => new Promise((res, rej) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/this-session', headers, agent: false }, (r) => {
      r.resume(); r.on('end', () => res(r.statusCode));
    });
    req.on('error', rej);
  });

  it('forged Host -> 403', async () => {
    assert.strictEqual(await get({ Host: 'attacker.example:7791' }), 403);
  });
  it('lookalike Host -> 403', async () => {
    assert.strictEqual(await get({ Host: 'localhost.evil.example' }), 403);
  });
  it('loopback Host -> 200 (unchanged)', async () => {
    assert.strictEqual(await get({}), 200);
    assert.strictEqual(await get({ Host: `localhost:${port}` }), 200);
  });
});
