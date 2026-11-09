import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { WebSocket } from 'ws';

/**
 * WARDEN-2204 — the /api/observe connect guard for an un-configured Observer.
 *
 * The first statement of the `connection` handler in wsLayer.js is
 * `if (!hasCredentials()) { send(error frame); return; }`. Every other wsLayer suite sets
 * ANTHROPIC_AUTH_TOKEN to get past it, so the refusal a person with no LLM credentials
 * actually sees was driven by nothing. Real setupWsLayer on a bare http server, real `ws`
 * client; HOME is redirected and both token env vars removed BEFORE the dynamic import.
 */

const CRED_ERROR = 'no LLM credentials (ANTHROPIC_AUTH_TOKEN missing in the server environment)';
const ENV_KEYS = ['HOME', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'];

function observeFrames(port, qs = '', waitMs = 400) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/observe${qs}`);
    const got = [];
    ws.on('message', (d) => got.push(JSON.parse(String(d))));
    ws.on('error', reject);
    ws.on('open', () => setTimeout(() => { ws.close(); resolve(got); }, waitMs));
  });
}

describe('WARDEN-2204 — /api/observe refuses a connection when no LLM credentials are configured', () => {
  let httpServer, port, saved, tempHome, sessionsDir, configPath;

  const clearSessions = () => {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
    fs.mkdirSync(sessionsDir, { recursive: true });
  };

  before(async () => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-ws-nocred-'));
    process.env.HOME = tempHome;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    sessionsDir = path.join(tempHome, '.yatfa-warden', 'sessions');
    configPath = path.join(tempHome, '.yatfa-warden', 'config.json');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const { setupWsLayer } = await import('./wsLayer.js');
    httpServer = http.createServer(() => {});
    setupWsLayer({
      server: httpServer,
      cfg: { connectTimeout: 1, hosts: [] },
      resolve: async () => ({ error: 'unused' }),
      chatCatalog: { snapshot: () => [], has: () => true },
    });
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', resolve);
    });
    port = httpServer.address().port;
  });

  beforeEach(() => {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    fs.rmSync(configPath, { force: true });
    clearSessions();
  });

  after(async () => {
    await new Promise((r) => httpServer.close(r));
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('positive control: with a token in the environment, a no-sid connect gets session_created and no error', async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
    const frames = await observeFrames(port);
    assert.ok(frames.some((f) => f.type === 'session_created' && f.sid), `frames: ${JSON.stringify(frames)}`);
    assert.ok(!frames.some((f) => f.type === 'error'), `frames: ${JSON.stringify(frames)}`);
    assert.ok(fs.readdirSync(sessionsDir).length >= 1, 'a session file was persisted');
  });

  it('no credentials: the client gets exactly the credentials error frame and nothing after it', async () => {
    const frames = await observeFrames(port);
    assert.deepStrictEqual(frames, [{ type: 'error', error: CRED_ERROR }]);
  });

  it('no credentials: the guard returns before createSession — no session file is written', async () => {
    const bare = await observeFrames(port);
    const withCtx = await observeFrames(port, '?host=h&project=p&role=worker&chatKey=k');
    assert.deepStrictEqual(bare, [{ type: 'error', error: CRED_ERROR }]);
    assert.deepStrictEqual(withCtx, [{ type: 'error', error: CRED_ERROR }]);
    assert.deepStrictEqual(fs.readdirSync(sessionsDir), []);
  });

  it('no credentials: the guard runs before the sid allow-list — a hostile sid still gets the credentials frame', async () => {
    const frames = await observeFrames(port, `?sid=${encodeURIComponent('../escape')}`);
    assert.deepStrictEqual(frames, [{ type: 'error', error: CRED_ERROR }]);
  });

  it('credentials are evaluated per connection from live config: config.json adds them, removing it refuses again', async () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ llm: { authToken: 'sk-live-config' } }));
    const accepted = await observeFrames(port);
    assert.ok(accepted.some((f) => f.type === 'session_created' && f.sid), `frames: ${JSON.stringify(accepted)}`);
    assert.ok(!accepted.some((f) => f.type === 'error'), `frames: ${JSON.stringify(accepted)}`);

    fs.rmSync(configPath);
    const refused = await observeFrames(port);
    assert.deepStrictEqual(refused, [{ type: 'error', error: CRED_ERROR }]);
  });
});
