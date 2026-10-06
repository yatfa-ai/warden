import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * WARDEN-1577 — DELETE/PATCH /api/sessions/:id must reject traversal ids with 400
 * through the REAL Express app (Express 5 decodes %2F into req.params.id), and the
 * /api/observe?sid= WebSocket must answer an error frame and never reach an Observer.
 * Boots server.js ONCE against a temp HOME (HOME-freezing isolation, as in
 * file-exists-http.test.js).
 */

let httpServer;
let baseUrl;
let originalHome;
let originalToken;
let tempHome;
let wardenDir;
let sentinel;
const SENTINEL_BODY = '{"hosts":[],"webhook":"secret-token"}';

before(async () => {
  originalHome = process.env.HOME;
  originalToken = process.env.ANTHROPIC_AUTH_TOKEN;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-sesstrav-home-'));
  process.env.HOME = tempHome;
  process.env.ANTHROPIC_AUTH_TOKEN = 'test-token'; // so the ws handler gets past hasCredentials()
  wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(path.join(wardenDir, 'sessions'), { recursive: true });
  sentinel = path.join(wardenDir, 'config.json');
  fs.writeFileSync(sentinel, SENTINEL_BODY);

  const server = await import('./server.js');
  httpServer = server.app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    httpServer.once('listening', resolve);
    httpServer.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

after(async () => {
  if (httpServer) await new Promise((r) => httpServer.close(r));
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  if (originalToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = originalToken;
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
});

const sentinelIntact = () => fs.readFileSync(sentinel, 'utf8') === SENTINEL_BODY;

describe('/api/sessions/:id rejects traversal ids (WARDEN-1577)', () => {
  it('DELETE ..%2Fconfig → 400 and the sentinel config.json survives', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/..%2Fconfig`, { method: 'DELETE' });
    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(await res.json(), { error: 'invalid session id' });
    assert.ok(fs.existsSync(sentinel), 'config.json was not unlinked');
    assert.ok(sentinelIntact());
  });

  it('PATCH ..%2Fconfig → 400 and the sentinel config.json is byte-identical', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/..%2Fconfig`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'pwn' }),
    });
    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(await res.json(), { error: 'invalid session id' });
    assert.ok(sentinelIntact());
  });

  it('a well-formed unknown id still PATCHes to 404 and DELETEs to 200', async () => {
    const p = await fetch(`${baseUrl}/api/sessions/abcdef123456`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x' }),
    });
    assert.strictEqual(p.status, 404);
    const d = await fetch(`${baseUrl}/api/sessions/abcdef123456`, { method: 'DELETE' });
    assert.strictEqual(d.status, 200);
  });
});
