import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { WebSocket } from 'ws';
import { runLocalTmux } from './ssh.js';

/**
 * WARDEN-1836 — /api/stream: a socket that closes while a monitor/attach frame is
 * awaiting `resolve` (or `probeSession`) must not leave state behind.
 *
 * The stream `close` handler runs once, synchronously. monitor registered its 2s capture
 * interval AFTER `await resolve`, and attach spawned its `tmux attach` PTY after
 * `await resolve` + `await probeSession`, so a close during either await was never cleaned
 * up (leaked setInterval capturing for the process lifetime / orphan tmux client).
 *
 * HOME is redirected BEFORE the dynamic import. The attach tests skip when tmux is absent.
 */

const LOCAL = '(local)';
const tmuxPresent = (() => {
  try { execFileSync('tmux', ['-V'], { stdio: ['ignore', 'ignore', 'ignore'] }); return true; } catch { return false; }
})();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RESOLVE_DELAY = 600;
const CLOSE_AT = 100;

describe('WARDEN-1836 — /api/stream closed-socket guard after awaits', () => {
  let httpServer, port, saved, tempHome, snapshotCalls, session, chat;
  const sessions = new Set();
  let resolveDelayMs = 0;

  const resolve = async (id) => {
    if (resolveDelayMs) await sleep(resolveDelayMs);
    if (chat && (id === chat.id || id === chat.key)) return { chat };
    return { error: `no chat matches "${id}"` };
  };
  const chatCatalog = {
    snapshot: () => { snapshotCalls++; return []; },
    has: () => true,
    refreshHost: async () => {},
  };

  const open = (route = '/api/stream') => new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${route}`);
    ws.once('error', rej);
    ws.once('open', () => res(ws));
  });

  async function clients() {
    const r = await runLocalTmux(['list-clients', '-t', session, '-F', '#{client_width}x#{client_height}']);
    if (!r.ok) return [];
    return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  async function newSession() {
    session = `wsl-closed-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const r = await runLocalTmux(['new-session', '-d', '-s', session, '-x', '100', '-y', '30', 'sh', '-c', 'cat']);
    assert.ok(r.ok, `tmux new-session failed: ${r.stderr}`);
    sessions.add(session);
    chat = { id: `${LOCAL}:${session}`, key: session, kind: 'tmux', host: LOCAL, container: null, session,
      project: 'local', role: 'claude', name: session, cwd: '', cmd: 'cat', active: true };
  }

  before(async () => {
    saved = { HOME: process.env.HOME, ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN };
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-ws-closed-'));
    process.env.HOME = tempHome;
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
    fs.mkdirSync(path.join(tempHome, '.yatfa-warden', 'sessions'), { recursive: true });
    const { setupWsLayer } = await import('./wsLayer.js');
    httpServer = http.createServer(() => {});
    setupWsLayer({ server: httpServer, cfg: { connectTimeout: 5, hosts: [] }, resolve, chatCatalog });
    await new Promise((res, rej) => { httpServer.once('error', rej); httpServer.listen(0, '127.0.0.1', res); });
    port = httpServer.address().port;
  });

  beforeEach(() => { resolveDelayMs = 0; snapshotCalls = 0; chat = null; });

  after(async () => {
    for (const s of sessions) { try { await runLocalTmux(['kill-session', '-t', s]); } catch { /* best effort */ } }
    httpServer.closeAllConnections?.();
    await new Promise((r) => httpServer.close(r));
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('monitor: a socket closed mid-resolve starts no capture interval (zero snapshot ticks)', async () => {
    resolveDelayMs = RESOLVE_DELAY;
    const ws = await open();
    ws.send(JSON.stringify({ type: 'monitor', id: 'gone' }));
    await sleep(CLOSE_AT);
    ws.close();
    await sleep(RESOLVE_DELAY + 300); // resolve settles; leaked tree would tick here
    assert.strictEqual(snapshotCalls, 0, 'no monitor tick may run for a connection that closed during resolve');
    await sleep(2300); // a leaked 2s interval would fire again
    assert.strictEqual(snapshotCalls, 0, 'no recurring capture interval may exist');
  });

  it('monitor positive control: socket left open -> monitor ticks', async () => {
    resolveDelayMs = RESOLVE_DELAY;
    const ws = await open();
    ws.send(JSON.stringify({ type: 'monitor', id: 'alive' }));
    await sleep(RESOLVE_DELAY + 300);
    assert.ok(snapshotCalls > 0, 'an open socket must still get monitor ticks');
    ws.send(JSON.stringify({ type: 'unmonitor', id: 'alive' }));
    await sleep(100);
    ws.close();
  });

  it('attach: a socket closed mid-resolve spawns no tmux attach client', { skip: !tmuxPresent && 'tmux not installed' }, async () => {
    await newSession();
    resolveDelayMs = RESOLVE_DELAY;
    const ws = await open();
    ws.send(JSON.stringify({ type: 'attach', id: chat.id, cols: 80, rows: 24 }));
    await sleep(CLOSE_AT);
    ws.close();
    await sleep(RESOLVE_DELAY + 1500); // resolve + probe settle, give a leaked PTY time to attach
    assert.deepStrictEqual(await clients(), [], 'no tmux client may be attached for a closed socket');
  });

  it('attach positive control: socket left open -> exactly one attached client', { skip: !tmuxPresent && 'tmux not installed' }, async () => {
    await newSession();
    resolveDelayMs = RESOLVE_DELAY;
    const ws = await open();
    ws.send(JSON.stringify({ type: 'attach', id: chat.id, cols: 80, rows: 24 }));
    await sleep(RESOLVE_DELAY + 1500);
    assert.strictEqual((await clients()).length, 1, 'an open socket must attach exactly one client');
    ws.close();
    for (let i = 0; i < 40 && (await clients()).length; i++) await sleep(50);
    assert.deepStrictEqual(await clients(), []);
  });
  // WARDEN-1846 — a per-pane `detach` (socket still OPEN) landing while `attach` is
  // awaiting resolve()/probeSession() must cancel that attach.
  const collect = (ws) => { const frames = []; ws.on('message', (d) => { try { frames.push(JSON.parse(String(d))); } catch { /* noop */ } }); return frames; };
  const attachFrame = () => JSON.stringify({ type: 'attach', id: chat.id, cols: 80, rows: 24 });
  const detachFrame = () => JSON.stringify({ type: 'detach', id: chat.id });
  const drain = async () => { for (let i = 0; i < 40 && (await clients()).length; i++) await sleep(50); };

  it('attach: a detach landing mid-resolve (socket open) spawns no client and sends no attached frame', { skip: !tmuxPresent && 'tmux not installed' }, async () => {
    await newSession();
    resolveDelayMs = RESOLVE_DELAY;
    const ws = await open();
    const frames = collect(ws);
    ws.send(attachFrame());
    await sleep(CLOSE_AT);
    ws.send(detachFrame());
    await sleep(RESOLVE_DELAY + 1500);
    assert.deepStrictEqual(await clients(), [], 'a detached pane must not get a tmux client while the socket is open');
    assert.deepStrictEqual(frames.filter((f) => ['attached', 'attach_error', 'host_unreachable', 'session_dead'].includes(f.type)), [],
      'a stale attach must not report on a pane the client already tore down');
    ws.close();
  });

  it('attach: attach -> detach -> attach (Retry) mid-resolve yields exactly one client, none after close', { skip: !tmuxPresent && 'tmux not installed' }, async () => {
    await newSession();
    resolveDelayMs = RESOLVE_DELAY;
    const ws = await open();
    const frames = collect(ws);
    ws.send(attachFrame());
    await sleep(CLOSE_AT);
    ws.send(detachFrame());
    ws.send(attachFrame());
    await sleep(RESOLVE_DELAY + 1500);
    assert.strictEqual((await clients()).length, 1, 'only the latest attach may spawn a client');
    assert.strictEqual(frames.filter((f) => f.type === 'attached').length, 1);
    ws.close();
    await drain();
    assert.deepStrictEqual(await clients(), [], 'no orphan client may survive the socket close');
  });

  it('attach positive control: attach -> detach after attached still tears the client down', { skip: !tmuxPresent && 'tmux not installed' }, async () => {
    await newSession();
    const ws = await open();
    ws.send(attachFrame());
    for (let i = 0; i < 60 && !(await clients()).length; i++) await sleep(50);
    assert.strictEqual((await clients()).length, 1);
    ws.send(detachFrame());
    await drain();
    assert.deepStrictEqual(await clients(), [], 'detach after attached must kill the client');
    ws.send(attachFrame()); // a fresh attach after detach still works
    for (let i = 0; i < 60 && !(await clients()).length; i++) await sleep(50);
    assert.strictEqual((await clients()).length, 1);
    ws.close();
    await drain();
  });
});
