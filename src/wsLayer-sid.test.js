import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { WebSocket } from 'ws';

/**
 * WARDEN-1577 — /api/observe?sid=<traversal> must answer {type:'error',
 * error:'invalid session id'} and return before an Observer is constructed (an
 * Observer would persist messages/transcripts to the attacker-chosen path).
 * HOME is redirected BEFORE the dynamic imports (sessions.js freezes DIR at import).
 */

let httpServer;
let port;
let originalHome;
let originalToken;
let tempHome;
let escapeDir;

before(async () => {
  originalHome = process.env.HOME;
  originalToken = process.env.ANTHROPIC_AUTH_TOKEN;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-wssid-home-'));
  process.env.HOME = tempHome;
  process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
  escapeDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(path.join(escapeDir, 'sessions'), { recursive: true });

  const { setupWsLayer } = await import('./wsLayer.js');
  httpServer = http.createServer(() => {});
  setupWsLayer({ server: httpServer, cfg: { connectTimeout: 1 }, resolve: async () => {}, chatCatalog: { snapshot: () => [] } });
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  port = httpServer.address().port;
});

after(async () => {
  await new Promise((r) => httpServer.close(r));
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  if (originalToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = originalToken;
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function collect(sid, ms = 600) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/observe?sid=${encodeURIComponent(sid)}`);
    const frames = [];
    ws.on('message', (d) => frames.push(JSON.parse(String(d))));
    ws.on('error', reject);
    ws.on('open', () => setTimeout(() => { ws.close(); resolve(frames); }, ms));
  });
}

describe('/api/observe sid validation (WARDEN-1577)', () => {
  for (const sid of ['../x', 'a/b', '..', 'a.b', 'x'.repeat(65)]) {
    it(`sid=${sid.slice(0, 12)} → error frame, nothing persisted`, async () => {
      const before = fs.readdirSync(escapeDir).sort();
      const frames = await collect(sid);
      assert.deepStrictEqual(frames, [{ type: 'error', error: 'invalid session id' }]);
      assert.deepStrictEqual(fs.readdirSync(escapeDir).sort(), before, 'no file created outside sessions/');
      assert.deepStrictEqual(fs.readdirSync(path.join(escapeDir, 'sessions')), [], 'no file created in sessions/');
    });
  }

  it('no sid still creates a session (control)', async () => {
    const frames = await collect('', 800).catch(() => []);
    // sid='' is falsy → fresh session is minted, as before.
    assert.ok(frames.some((f) => f.type === 'session_created'));
  });
});
