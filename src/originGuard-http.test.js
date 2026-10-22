import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

/**
 * WARDEN-1902 — HTTP Origin guard for state-changing routes.
 *
 * Browsers send CORS-simple requests (body-less / text/plain cross-site POSTs)
 * with NO preflight, and the server executes them even though the response is
 * unreadable. The Host guard cannot stop that (the attacker posts to an allowed
 * loopback Host), so every non-safe method must carry an allowed or absent Origin.
 * Pins: the middleware's method matrix (unit), and the real server.js mount
 * (forged Origin on /api/config/reset -> 403 with settings UNCHANGED; loopback /
 * Vite-dev / absent Origin -> handler reached; GET never blocked).
 * HOME is redirected BEFORE the dynamic import.
 */

const { originGuardMiddleware } = await import('./originGuard.js');

function run(method, origin) {
  const mw = originGuardMiddleware();
  const out = { nexted: false, status: null, type: null, body: null };
  const res = {
    status(s) { out.status = s; return this; },
    type(t) { out.type = t; return this; },
    send(b) { out.body = b; return this; },
  };
  const headers = origin === undefined ? {} : { origin };
  mw({ method, headers }, res, () => { out.nexted = true; });
  return out;
}

describe('originGuardMiddleware — method matrix (unit)', () => {
  it('GET / HEAD / OPTIONS pass through even with a forged Origin', () => {
    for (const m of ['GET', 'HEAD', 'OPTIONS', 'get']) {
      const r = run(m, 'http://evil.example');
      assert.strictEqual(r.nexted, true, m);
      assert.strictEqual(r.status, null, m);
    }
  });
  it('POST / PUT / PATCH / DELETE with a forged or null Origin -> 403 text/plain, next not called', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const o of ['http://evil.example', 'null', 'http://localhost.evil.example']) {
        const r = run(m, o);
        assert.strictEqual(r.nexted, false, `${m} ${o}`);
        assert.strictEqual(r.status, 403, `${m} ${o}`);
        assert.strictEqual(r.type, 'text/plain');
        assert.match(r.body, /unexpected Origin/);
      }
    }
  });
  it('POST / PUT / PATCH / DELETE with absent or loopback Origin -> next', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const o of [undefined, 'http://127.0.0.1:7421', 'http://localhost:5173', 'http://[::1]:7421']) {
        const r = run(m, o);
        assert.strictEqual(r.nexted, true, `${m} ${o}`);
        assert.strictEqual(r.status, null, `${m} ${o}`);
      }
    }
  });
});

describe('WARDEN-1902 HTTP Origin guard (real server.js middleware)', () => {
  let serverModule, port, saved, tempHome;
  const MARKER = 'https://hooks.example/origin-guard-marker';

  before(async () => {
    saved = { HOME: process.env.HOME };
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-origin-http-'));
    process.env.HOME = tempHome;
    const wardenDir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wardenDir, { recursive: true });
    fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: [], webhookUrl: MARKER }));
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

  const req = (method, p, headers = {}) => new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers, agent: false }, (resp) => {
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => res({ status: resp.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', rej);
    r.end();
  });
  const webhookUrl = async () => JSON.parse((await req('GET', '/api/config')).body).webhookUrl;

  it('control: the marker is present before any reset', async () => {
    assert.strictEqual(await webhookUrl(), MARKER);
  });

  it('body-less text/plain POST /api/config/reset with a forged Origin -> 403 and settings UNCHANGED', async () => {
    for (const origin of ['http://evil.example', 'null']) {
      const r = await req('POST', '/api/config/reset', { Origin: origin, 'Content-Type': 'text/plain' });
      assert.strictEqual(r.status, 403, origin);
      assert.match(r.body, /unexpected Origin/);
      assert.strictEqual(await webhookUrl(), MARKER, `settings must be untouched after ${origin}`);
    }
  });

  it('forged-Origin POST /api/spawn -> 403 (no shell spawned)', async () => {
    const r = await req('POST', '/api/spawn', { Origin: 'http://evil.example', 'Content-Type': 'text/plain' });
    assert.strictEqual(r.status, 403);
  });

  it('forged-Origin POST /api/paste-image -> 403', async () => {
    const r = await req('POST', '/api/paste-image', { Origin: 'http://evil.example', 'Content-Type': 'text/plain' });
    assert.strictEqual(r.status, 403);
  });

  it('GET with a forged Origin is not blocked', async () => {
    const r = await req('GET', '/api/this-session', { Origin: 'http://evil.example' });
    assert.strictEqual(r.status, 200);
  });

  it('positive controls: loopback / Vite-dev Origin reaches the handler (a non-403 on a mutating route)', async () => {
    for (const origin of ['http://127.0.0.1:7421', 'http://localhost:5173']) {
      const r = await req('POST', '/api/paste-image', { Origin: origin });
      assert.notStrictEqual(r.status, 403, origin);
    }
  });

  it('positive control (last — it wipes settings): absent Origin reaches /api/config/reset and the reset happens', async () => {
    const r = await req('POST', '/api/config/reset');
    assert.strictEqual(r.status, 200);
    assert.notStrictEqual(await webhookUrl(), MARKER);
  });
});
