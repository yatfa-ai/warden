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
 * WARDEN-1856 — /api/stream attach: the FINAL liveness window.
 *
 * The attach continuation ends `try { await resize(chat, cfg, cols, rows) } catch {}`
 * → `send({type:'attached'})`. resize is a real RPC (one ssh round-trip on remote
 * hosts), and the entry had ALREADY been committed to `attaches` before it — so a
 * per-pane `detach` (or a socket close) landing inside that await tears the PTY
 * down while the continuation is suspended. Emitting `attached` afterwards would
 * flip the client to "connected" (web/src/components/PaneTile.tsx maps the frame
 * to setPhase('connected')) with no pty frames ever coming — and the killed PTY's
 * late onExit is identity-suppressed, so no `ended` arrives either: the pane hangs
 * as connected until the user acts.
 *
 * WARDEN-1846/1836 pinned the EARLIER windows (mid-`resolve` / mid-`probeSession`,
 * guarded by the pendingAttach token via `stale()`). This suite pins the LAST
 * window, which lives AFTER `settle()` deleted the token — so it must be guarded by
 * ENTRY IDENTITY (`closed || attaches.get(m.id) !== entry`), the same predicate the
 * onData/onExit/flushOut gates already use. `stale()` is vacuously true post-settle
 * and can never guard this window.
 *
 * How the window is entered deterministically: `tmux` is resolved from PATH for
 * every local tmux spawn (runLocalTmux and node-pty both spawn the bare string
 * 'tmux'), so a shim earlier on PATH holds `tmux set-option` — exactly the resize
 * RPC — while a gate file exists. The test arms the gate, attaches, waits for the
 * real tmux client to appear (PTY spawned, continuation now suspended in the
 * gated resize), lands the detach/close, then releases the gate. Every other tmux
 * invocation passes straight through.
 *
 * HOME is redirected BEFORE the dynamic imports. Skipped when tmux is absent.
 */

const LOCAL = '(local)';
const tmuxPresent = (() => {
  try { execFileSync('tmux', ['-V'], { stdio: ['ignore', 'ignore', 'ignore'] }); return true; } catch { return false; }
})();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SETTLE = 1000; // gate release → resize RPC completes → continuation has run

async function waitFor(fn, { timeout = 5000, interval = 25, msg = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`timed out (${timeout}ms) waiting for ${msg}`);
    await sleep(interval);
  }
}

describe('WARDEN-1856 — /api/stream attach liveness in the final-resize window', { skip: !tmuxPresent && 'tmux not installed' }, () => {
  let httpServer, port, saved, tempHome, shimDir, realTmux, readEvents, session, chat, uniq;
  const sessions = new Set();
  const GATE = () => path.join(shimDir, 'gate');

  // The chat a client attaches to. resolve() is INSTANT here on purpose: the window
  // under test is the FINAL resize await, not the resolve/probe windows 1846 pinned.
  const resolve = async (id) => {
    if (chat && (id === chat.id || id === chat.key)) return { chat };
    return { error: `no chat matches "${id}"` };
  };
  const chatCatalog = {
    snapshot: () => [],
    has: () => true,
    refreshHost: async () => {},
  };

  const open = () => new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/stream`);
    ws.once('error', rej);
    ws.once('open', () => res(ws));
  });
  const collect = (ws) => { const frames = []; ws.on('message', (d) => { try { frames.push(JSON.parse(String(d))); } catch { /* noop */ } }); return frames; };
  const attachFrame = () => JSON.stringify({ type: 'attach', id: chat.id, cols: 80, rows: 24 });
  const detachFrame = () => JSON.stringify({ type: 'detach', id: chat.id });
  const BAD_TYPES = ['attached', 'attach_error', 'host_unreachable', 'session_dead'];

  async function clients() {
    const r = await runLocalTmux(['list-clients', '-t', session, '-F', '#{client_width}x#{client_height}']);
    if (!r.ok) return [];
    return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  }
  const waitClient = (n, msg) => waitFor(async () => (await clients()).length === n, { msg });

  const eventsOf = async (type, pred = () => true) => (await readEvents()).filter((e) => e.type === type && pred(e));
  const armGate = () => fs.writeFileSync(GATE(), '');
  const releaseGate = () => fs.rmSync(GATE(), { force: true });

  before(async () => {
    uniq = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    // Resolve the REAL tmux BEFORE the shim shadows PATH.
    realTmux = execFileSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).trim();
    saved = { HOME: process.env.HOME, ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN, PATH: process.env.PATH };
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-ws-liveness-'));
    process.env.HOME = tempHome;
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
    fs.mkdirSync(path.join(tempHome, '.yatfa-warden', 'sessions'), { recursive: true });
    // The gate shim: `tmux set-option` (the attach flow's final resize RPC) blocks
    // while the gate file exists; every other invocation execs the real tmux.
    shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-ws-liveness-shim-'));
    const gatePath = GATE();
    fs.writeFileSync(path.join(shimDir, 'tmux'), [
      '#!/bin/sh',
      '# WARDEN-1856 test gate: hold `tmux set-option` (the attach flow\'s final resize',
      '# RPC) while the gate file exists so a detach/close frame can be delivered INTO',
      '# that await window. Everything else passes through to the real tmux.',
      `if [ "$1" = "set-option" ] && [ -f "${gatePath}" ]; then`,
      `  while [ -f "${gatePath}" ]; do sleep 0.01; done`,
      'fi',
      `exec "${realTmux}" "$@"`,
      '',
    ].join('\n'), { mode: 0o755 });
    process.env.PATH = `${shimDir}${path.delimiter}${process.env.PATH}`;

    ({ readEvents } = await import('./activity.js'));
    const { setupWsLayer } = await import('./wsLayer.js');
    httpServer = http.createServer(() => {});
    setupWsLayer({ server: httpServer, cfg: { connectTimeout: 5, hosts: [] }, resolve, chatCatalog });
    await new Promise((res, rej) => { httpServer.once('error', rej); httpServer.listen(0, '127.0.0.1', res); });
    port = httpServer.address().port;
  });

  beforeEach(() => {
    releaseGate();
    chat = null;
  });

  after(async () => {
    releaseGate();
    for (const s of sessions) { try { await runLocalTmux(['kill-session', '-t', s]); } catch { /* best effort */ } }
    httpServer.closeAllConnections?.();
    await new Promise((r) => httpServer.close(r));
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { fs.rmSync(shimDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  async function newSession() {
    session = `wsl-liveness-${uniq}-${sessions.size}`;
    const r = await runLocalTmux(['new-session', '-d', '-s', session, '-x', '100', '-y', '30', 'sh', '-c', 'cat']);
    assert.ok(r.ok, `tmux new-session failed: ${r.stderr}`);
    sessions.add(session);
    chat = { id: `${LOCAL}:${session}`, key: session, kind: 'tmux', host: LOCAL, container: null, session,
      project: 'local', role: 'claude', name: session, cwd: '', cmd: 'cat', active: true };
  }

  it('attach: a detach landing in the final-resize window (socket open) emits no frame and leaves no orphan client', async () => {
    await newSession();
    armGate(); // the attach continuation suspends inside the gated resize RPC
    const ws = await open();
    const frames = collect(ws);
    try {
      ws.send(attachFrame());
      await waitClient(1, 'the attach PTY client (continuation now suspended in the gated resize)');
      ws.send(detachFrame()); // lands while the continuation is still awaiting resize
      releaseGate(); // let the resize RPC finish so the suspended continuation runs
      await sleep(SETTLE);
      assert.deepStrictEqual(await clients(), [], 'a detached pane must not keep a tmux client');
      assert.deepStrictEqual(frames.filter((f) => BAD_TYPES.includes(f.type)), [],
        'a stale attach must not announce after its entry was torn down mid-resize');
      assert.deepStrictEqual(await eventsOf('attached', (e) => e.id === chat.id), [],
        'a stale attach must not write the attached activity event either');
    } finally { releaseGate(); ws.close(); }
    await waitClient(0, 'no client survives the socket close');
  });

  it('attach: a socket close landing in the final-resize window writes no attached activity event', async () => {
    await newSession();
    armGate();
    const ws = await open();
    ws.send(attachFrame());
    await waitClient(1, 'the attach PTY client');
    ws.close(); // lands while the continuation is still awaiting resize
    await sleep(SETTLE);
    releaseGate();
    await waitClient(0, 'the close handler must have killed the attach PTY');
    await sleep(SETTLE); // the released continuation now runs to its end
    assert.deepStrictEqual(await eventsOf('attached', (e) => e.id === chat.id), [],
      'a close-killed attach must not record an attached activity event after the fact');
  });

  it('attach: detach→attach Retry across the final-resize window yields exactly one live client and one attached', async () => {
    await newSession();
    armGate();
    const ws = await open();
    const frames = collect(ws);
    try {
      ws.send(attachFrame());
      await waitClient(1, 'first attach client (its continuation is suspended in the gated resize)');
      ws.send(detachFrame());
      ws.send(attachFrame()); // Retry: kills the prior PTY, binds a fresh one under the same id
      await waitClient(1, 'the Retry rebinds exactly one client');
      releaseGate();
      await sleep(SETTLE);
      assert.strictEqual(frames.filter((f) => f.type === 'attached' && f.id === chat.id).length, 1,
        `exactly one attached may be announced, got ${JSON.stringify(frames.filter((f) => f.type === 'attached'))}`);
      assert.strictEqual((await clients()).length, 1, 'only the Retry attach may hold a client');
      assert.deepStrictEqual(await eventsOf('attached', (e) => e.id === chat.id).then((a) => a.length), 1,
        'exactly one attached activity event may be written');
    } finally { releaseGate(); ws.close(); }
    for (let i = 0; i < 40 && (await clients()).length; i++) await sleep(50);
    assert.deepStrictEqual(await clients(), [], 'no orphan client may survive the socket close');
  });

  it('attach positive control: the same gated window with no detach still announces exactly one attached (settle-trap guard)', async () => {
    await newSession();
    armGate(); // armed-and-released WITHOUT any detach: the guard must not over-suppress
    const ws = await open();
    const frames = collect(ws);
    try {
      ws.send(attachFrame());
      await waitClient(1, 'the attach PTY client');
      releaseGate();
      await waitFor(() => frames.some((f) => f.type === 'attached' && f.id === chat.id), { msg: 'attached frame' });
      assert.strictEqual(frames.filter((f) => f.type === 'attached' && f.id === chat.id).length, 1,
        'a live attach must still announce exactly once through the gated window');
      const ev = await waitFor(async () => (await eventsOf('attached', (e) => e.id === chat.id))[0], { msg: 'attached event' });
      assert.strictEqual(ev.host, LOCAL);
      assert.ok('container' in ev);
    } finally { releaseGate(); ws.close(); }
    await waitClient(0, 'client gone after close');
  });
});
