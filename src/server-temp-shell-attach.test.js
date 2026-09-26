import { describe, it, before, afterEach, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import { runLocalTmux } from './ssh.js';

/**
 * WARDEN-1422 QA round 4 — the unnamed-shell "Couldn't attach" blocker,
 * reproduced and pinned at the protocol level (the exact surface the QA
 * report drove with a raw ws client).
 *
 * The repro: click the sidebar spawn control's "+ shell" (no name). The
 * server creates `shell-xxxxxx`, cataloged on disk with `temporary: true`.
 * The pane then attaches — and on the broken tree resolved to
 *   {"type":"error","error":"no chat matches \"shell-xxxxxx\"","context":"attach"}
 * on every attempt, recovering only on a page reload. Two halves:
 *
 *   CLIENT  (the root cause): App's spawnShell/handlePaneSpawned keyed
 *           paneHost by chat.id (composite "host:session") while the pane
 *           opens with chat.key (bare session), so the attach message went
 *           out HOST-LESS and the stream handler skipped its refreshHost
 *           seed. Fixed by keying both writes through paneIdOf (the pane
 *           id) — covered by web/paneAttach.test.mjs.
 *   SERVER  (this file): a bare-id attach with no host hint could never
 *           resolve a just-spawned shell — resolve()'s bare branch refreshed
 *           only cfg.hosts (usually empty), never the on-disk catalog the
 *           spawn just appended to. Fixed by re-reading the catalog there
 *           (refreshCatalog), so a host-less bare-id attach resolves even
 *           when the in-memory slot is stale — e.g. a restored temp pane
 *           with cleared localStorage.
 *
 * These tests drive the REAL server over a REAL WebSocket against REAL local
 * tmux, on a throwaway HOME with `hosts: []` — the QA's exact setup ("a bare
 * id with no configured remote hosts triggers no refresh"). The stale-slot
 * precondition is forced deterministically: a decoy catalog entry at boot +
 * one GET /api/chats populates the in-memory catalogue, so seedIfEmpty is a
 * no-op and only the fix's catalog re-read can find the temp.
 *
 * Without the fix, the no-host attach tests below fail with exactly the QA's
 * `attach_error no chat matches`. Skipped when tmux isn't installed (CI
 * without tmux), mirroring src/server-stream-reattach.test.js.
 */

const LOCAL = '(local)';

const tmuxPresent = (() => {
  try { execFileSync('tmux', ['-V'], { stdio: ['ignore', 'ignore', 'ignore'] }); return true; } catch { return false; }
})();

// Open a WS client to /api/stream and collect the message stream (fresh per
// test — each connection owns its own `attaches` Map on the server).
function connect(wsUrl, id) {
  const ws = new WebSocket(wsUrl);
  const msgs = [];
  ws.on('message', (raw) => { try { msgs.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
  const opened = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const send = (obj) => ws.send(JSON.stringify(obj));
  const ofType = (type) => msgs.filter((m) => m.type === type && m.id === id);
  const waitForN = async (type, n, timeoutMs = 5000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (ofType(type).length >= n) return ofType(type);
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for ${n}× ${type}; saw ${ofType(type).length}. all msgs: ${JSON.stringify(msgs)}`);
  };
  return { ws, msgs, opened, send, ofType, waitForN };
}

const postJson = (baseUrl, body) => fetch(`${baseUrl}/api/spawn`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('unnamed shell attach resolves without a host hint — WARDEN-1422 QA round 4', { skip: !tmuxPresent && 'tmux not installed' }, () => {
  let serverModule;
  let wsUrl;
  let baseUrl;
  let originalHome;
  let tempHome;
  const DECOY = `w1422-decoy-${process.pid}`;
  const spawnedKeys = [];

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-tempshell-'));
    process.env.HOME = tempHome;
    const wardenDir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wardenDir, { recursive: true });
    fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: [] }));
    // A decoy catalog entry at boot: it populates the in-memory catalogue via
    // the GET /api/chats below, which makes seedIfEmpty a no-op for the rest
    // of the run — the exact stale-cache precondition of the QA repro (a real
    // server has polled its catalog before any human clicks "+ shell").
    // `sleep 3600` never actually runs for the decoy (no tmux session is
    // created for it) — it is only ever a cache-warming entry.
    fs.writeFileSync(
      path.join(wardenDir, 'chats.json'),
      JSON.stringify([{ kind: 'tmux', host: LOCAL, session: DECOY, name: 'decoy', cwd: '', cmd: 'sleep 3600' }]),
    );

    // Dynamic import AFTER HOME is swapped; `server` is the http instance the
    // /api/stream WebSocketServer upgrades against (app.listen() would create
    // a different one). See src/server-stream-reattach.test.js.
    serverModule = await import('./server.js');
    await new Promise((resolve, reject) => {
      serverModule.server.once('listening', resolve);
      serverModule.server.once('error', reject);
      serverModule.server.listen(0, '127.0.0.1');
    });
    const port = serverModule.server.address().port;
    wsUrl = `ws://127.0.0.1:${port}/api/stream`;
    baseUrl = `http://127.0.0.1:${port}`;
    // Warm the in-memory catalogue from the disk catalog (decoy installed,
    // seedIfEmpty becomes a no-op — the QA's stale-cache precondition).
    const res = await fetch(`${baseUrl}/api/chats`);
    assert.equal(res.status, 200);
  });

  after(async () => {
    try { serverModule.server.closeAllConnections?.(); } catch { /* noop */ }
    if (serverModule?.server?.listening) await new Promise((r) => serverModule.server.close(r));
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  afterEach(async () => {
    // Kill every session this run spawned — by exact name (a tmux op), never
    // by command-line pattern.
    for (const s of [DECOY, ...spawnedKeys]) {
      try { await runLocalTmux(['kill-session', '-t', s]); } catch { /* best effort */ }
    }
    spawnedKeys.length = 0;
  });

  it('an unnamed spawn is temporary and its chat carries BOTH ids (composite id, bare key)', async () => {
    const res = await postJson(baseUrl, { host: LOCAL, cwd: '/tmp', cmd: 'sleep 3600' });
    assert.equal(res.status, 200);
    const { chat } = await res.json();
    spawnedKeys.push(chat.key);
    assert.equal(chat.temporary, true, 'a spawn with no session AND no name is temporary');
    assert.match(chat.key, /^shell-/, 'the generated temp key is shell-xxxxxx');
    assert.equal(chat.id, `${LOCAL}:${chat.key}`, 'the composite id is host:session — the invariant the client keying rides');
    assert.equal(chat.host, LOCAL);
  });

  it('THE QA BLOCKER: a just-spawned UNNAMED shell attaches by bare key with NO host hint', async () => {
    const res = await postJson(baseUrl, { host: LOCAL, cwd: '/tmp', cmd: 'sleep 3600' });
    assert.equal(res.status, 200);
    const { chat } = await res.json();
    spawnedKeys.push(chat.key);
    const c = connect(wsUrl, chat.key);
    await c.opened;
    try {
      // No `host` field — the shape the broken client sent after keying
      // paneHost by the composite id. resolve() must still find the temp.
      c.send({ type: 'attach', id: chat.key, cols: 80, rows: 24 });
      await c.waitForN('attached', 1);
      assert.equal(c.ofType('attach_error').length, 0,
        `no attach_error expected; got ${JSON.stringify(c.ofType('attach_error'))} — ` +
        'the bare-id resolve must re-read the on-disk catalog the spawn appended to');
    } finally {
      c.ws.close();
    }
  });

  it('a just-spawned NAMED session attaches by bare key with NO host hint (same resolution gap)', async () => {
    // The QA report: "Named spawns hit the same key mismatch, but pass in
    // practice because refresh() usually lands first." The server-side gap is
    // identical — pin it here so the named path is covered by the same fix.
    const res = await postJson(baseUrl, { host: LOCAL, cwd: '/tmp', cmd: 'sleep 3600', name: 'w1422 named ship' });
    assert.equal(res.status, 200);
    const { chat } = await res.json();
    spawnedKeys.push(chat.key);
    assert.equal(chat.temporary, undefined, 'a named spawn is persistent');
    assert.equal(chat.key, 'w1422-named-ship', 'the session id is derived from the name');
    const c = connect(wsUrl, chat.key);
    await c.opened;
    try {
      c.send({ type: 'attach', id: chat.key, cols: 80, rows: 24 });
      await c.waitForN('attached', 1);
      assert.equal(c.ofType('attach_error').length, 0);
    } finally {
      c.ws.close();
    }
  });

  it('control: the host-hinted attach still works (the path the client fix restores)', async () => {
    const res = await postJson(baseUrl, { host: LOCAL, cwd: '/tmp', cmd: 'sleep 3600' });
    assert.equal(res.status, 200);
    const { chat } = await res.json();
    spawnedKeys.push(chat.key);
    const c = connect(wsUrl, chat.key);
    await c.opened;
    try {
      c.send({ type: 'attach', id: chat.key, host: LOCAL, cols: 80, rows: 24 });
      await c.waitForN('attached', 1);
      assert.equal(c.ofType('attach_error').length, 0);
    } finally {
      c.ws.close();
    }
  });
});
