import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * WARDEN-1754 — POST /api/key answers 400 (not 500) for a missing / misspelled /
 * non-allow-listed `key`. A 500 is counted as a server failure by the request
 * telemetry (ok = status < 500), so caller-input errors must not be 5xx.
 * ./server.js is dynamic-imported AFTER HOME is redirected (WARDEN-130).
 */
describe('POST /api/key — unsupported key is a 400 (WARDEN-1754)', () => {
  let httpServer, baseUrl, originalHome, tempHome;
  const SESSION = 'w1754key';
  const killSession = () => spawnSync('tmux', ['kill-session', '-t', SESSION], { stdio: 'ignore' });
  const hasTmux = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
  let chatId;

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-key-http-'));
    process.env.HOME = tempHome;
    const wdir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wdir, { recursive: true });
    fs.writeFileSync(path.join(wdir, 'config.json'), JSON.stringify({ hosts: [] }) + '\n');
    fs.writeFileSync(path.join(wdir, 'chats.json'), '[]\n');
    killSession();
    const { app } = await import('./server.js');
    httpServer = app.listen(0, '127.0.0.1');
    await new Promise((res, rej) => { httpServer.once('listening', res); httpServer.once('error', rej); });
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
    if (hasTmux) {
      const r = await fetch(`${baseUrl}/api/spawn`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host: '(local)', name: SESSION, session: SESSION, cmd: '' }),
      });
      const raw = await r.text();
      assert.strictEqual(r.status, 200, raw);
      chatId = JSON.parse(raw).chat.id;
    }
  });

  after(async () => {
    killSession();
    if (httpServer) await new Promise((res) => httpServer.close(res));
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  const postKey = (body) => fetch(`${baseUrl}/api/key`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  it('an unresolvable pane id is still a 404 (resolve runs before key validation)', async () => {
    assert.strictEqual((await postKey({ id: 'no-such-pane', key: 'Bogus' })).status, 404);
  });

  it('a non-allow-listed key is a 400 naming "unsupported key"', async (t) => {
    if (!hasTmux) return t.skip('tmux is not installed');
    const res = await postKey({ id: chatId, key: 'Bogus' });
    const raw = await res.text();
    assert.strictEqual(res.status, 400, raw);
    assert.match(JSON.parse(raw).error, /unsupported key "Bogus"/);
  });

  it('a missing key is a 400 naming "unsupported key"', async (t) => {
    if (!hasTmux) return t.skip('tmux is not installed');
    const res = await postKey({ id: chatId });
    const raw = await res.text();
    assert.strictEqual(res.status, 400, raw);
    assert.match(JSON.parse(raw).error, /unsupported key/);
  });

  it('an over-long bad key is echoed truncated to 40 chars', async (t) => {
    if (!hasTmux) return t.skip('tmux is not installed');
    const res = await postKey({ id: chatId, key: 'x'.repeat(500) });
    assert.strictEqual(res.status, 400);
    assert.ok((await res.json()).error.length < 80);
  });

  it('an allow-listed key (Enter) still succeeds with {ok:true}', async (t) => {
    if (!hasTmux) return t.skip('tmux is not installed');
    const res = await postKey({ id: chatId, key: 'Enter' });
    const raw = await res.text();
    assert.strictEqual(res.status, 200, raw);
    assert.deepStrictEqual(JSON.parse(raw), { ok: true });
  });
});
