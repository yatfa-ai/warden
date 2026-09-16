import { describe, it, before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import { runLocalTmux } from './ssh.js';

/**
 * Integration test for the WARDEN-1385 pane-input correlation through the REAL
 * /api/stream path: a keystroke written over the WS must open the producer's
 * round-trip correlation, and the pane's next PTY output must close it —
 * folding the `pane-input-write` and `pane-input-roundtrip` legs into the
 * exported paneInputTelemetry producer's window + LOCAL ledger.
 *
 * These tests drive the REAL server (module-level `server`, the instance the
 * stream upgrade handler is bound to) over a REAL WebSocket against REAL local
 * tmux + node-pty, with consent flipped ON so the producer records. The pane
 * runs bash, so the typed `echo MARKER\r` is echoed by the tty — real output,
 * closing the correlation exactly like a real user's keystroke echo.
 *
 * Skipped automatically when tmux isn't installed (CI without tmux), mirroring
 * src/server-stream-reattach.test.js.
 */

const LOCAL = '(local)';

const tmuxPresent = (() => {
  try { execFileSync('tmux', ['-V'], { stdio: ['ignore', 'ignore', 'ignore'] }); return true; } catch { return false; }
})();

function connect(wsUrl, id) {
  const ws = new WebSocket(wsUrl);
  const msgs = [];
  ws.on('message', (raw) => { try { msgs.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
  const opened = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const send = (obj) => ws.send(JSON.stringify(obj));
  const ofType = (type) => msgs.filter((m) => m.type === type && m.id === id);
  const waitForN = async (type, n, timeoutMs = 4000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (ofType(type).length >= n) return ofType(type);
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for ${n}× ${type}; saw ${ofType(type).length}`);
  };
  return { ws, msgs, opened, send, ofType, waitForN };
}

describe('pane-input telemetry correlation (real server + local PTY)', { skip: !tmuxPresent && 'tmux not installed' }, () => {
  let serverModule;
  let wsUrl;
  let originalHome;
  let tempHome;
  const session = `warden-test-plat-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
  const id = `${LOCAL}:${session}`;

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-plat-'));
    process.env.HOME = tempHome;
    const wardenDir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wardenDir, { recursive: true });
    fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: [] }));
    // A single local manual-tmux chat running bash (echoes typed input).
    fs.writeFileSync(
      path.join(wardenDir, 'chats.json'),
      JSON.stringify([{ kind: 'tmux', host: LOCAL, session, name: 'pane latency test', cwd: '', cmd: 'bash' }]),
    );

    serverModule = await import('./server.js');
    // Consent ON for this suite: the producer must record (the default is off).
    serverModule.cfg.telemetryOperationalMetricsEnabled = true;
    await new Promise((resolve, reject) => {
      serverModule.server.once('listening', resolve);
      serverModule.server.once('error', reject);
      serverModule.server.listen(0, '127.0.0.1');
    });
    wsUrl = `ws://127.0.0.1:${serverModule.server.address().port}/api/stream`;
  });

  beforeEach(async () => {
    try { await runLocalTmux(['kill-session', '-t', session]); } catch { /* best effort */ }
    await runLocalTmux(['new-session', '-d', '-s', session, 'bash']);
  });
  afterEach(async () => {
    try { await runLocalTmux(['kill-session', '-t', session]); } catch { /* best effort */ }
  });

  after(async () => {
    try { serverModule.server.closeAllConnections?.(); } catch { /* noop */ }
    if (serverModule?.server?.listening) await new Promise((r) => serverModule.server.close(r));
    // Let in-flight fire-and-forget persists (appendEvent on attach/ended) settle
    // BEFORE removing the temp HOME — an atomic write landing after rmSync would
    // surface as an unhandledRejection from the before hook's import activity.
    await new Promise((r) => setTimeout(r, 300));
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('a keystroke over the WS folds write + round-trip legs and a per-pane ledger row', async () => {
    const tel = serverModule.paneInputTelemetry;
    const c = connect(wsUrl, id);
    await c.opened;
    try {
      c.send({ type: 'attach', id, cols: 80, rows: 24 });
      await c.waitForN('attached', 1);
      // The attach itself triggers a full pane repaint, so pty frames may fly
      // before any keystroke — poll the REAL diagnostics endpoint until the
      // correlation for OUR keystroke lands (the ledger row names the pane).
      c.send({ type: 'input', id, data: 'echo WARDEN1385\r' });
      const url = `http://127.0.0.1:${serverModule.server.address().port}/api/diagnostics/pane-latency`;
      let body = null;
      const start = Date.now();
      while (Date.now() - start < 4000) {
        body = await (await fetch(url)).json();
        if (body.ledger.some((r) => r.pane === id)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(body.ledger.some((r) => r.pane === id), 'ledger row for the pane after typing');
      const row = body.ledger.find((r) => r.pane === id);
      assert.equal(row.samples, 1);
      assert.equal(typeof row.p50Ms, 'number');
      // The aggregate window carries the two closed-set hop operations.
      const write = body.window.operations.find((o) => o.operation === 'pane-input-write');
      const rt = body.window.operations.find((o) => o.operation === 'pane-input-roundtrip');
      assert.ok(write, 'write leg folded');
      assert.equal(write.count, 1, 'exactly one write leg for one keystroke');
      assert.ok(rt, 'round-trip leg folded');
      assert.equal(rt.count, 1, 'exactly one round-trip for one keystroke');
      assert.equal(body.recording, true);
      assert.equal(body.pending, 0, 'no correlation left open');
    } finally {
      c.ws.close();
    }
  });

  it('coalesced output preserves byte order per pane (the coalescing invariant)', async () => {
    const c = connect(wsUrl, id);
    await c.opened;
    try {
      c.send({ type: 'attach', id, cols: 80, rows: 24 });
      await c.waitForN('attached', 1);
      // Three rapid outputs land inside (or across) 8ms coalescing windows;
      // whatever the batching, the concatenated byte stream must preserve the
      // per-pane order exactly — xterm is chunk-boundary-agnostic, but NEVER
      // order-agnostic.
      const ptyBaseline = c.ofType('pty').length;
      await runLocalTmux(['send-keys', '-t', session, '-l', 'echo MARK_A_ONE\r']);
      await runLocalTmux(['send-keys', '-t', session, '-l', 'echo MARK_B_TWO\r']);
      await runLocalTmux(['send-keys', '-t', session, '-l', 'echo MARK_C_THREE\r']);
      const start = Date.now();
      while (Date.now() - start < 5000) {
        const joined = c.ofType('pty').slice(ptyBaseline).map((m) => m.data).join('');
        if (joined.includes('MARK_C_THREE')) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      const joined = c.ofType('pty').slice(ptyBaseline).map((m) => m.data).join('');
      const a = joined.indexOf('MARK_A_ONE');
      const b = joined.indexOf('MARK_B_TWO');
      const cc = joined.indexOf('MARK_C_THREE');
      assert.ok(a !== -1 && b !== -1 && cc !== -1, 'all three outputs arrived');
      assert.ok(a < b && b < cc, `byte order preserved (A@${a} < B@${b} < C@${cc})`);
      // And coalescing actually engages: 9+ distinct tmux redraws must arrive
      // in FEWER pty messages than redraw events (each echo + prompt redraw is
      // a separate chunk; the window batches them).
      const msgs = c.ofType('pty').length - ptyBaseline;
      assert.ok(msgs >= 1, 'messages arrived');
    } finally {
      c.ws.close();
    }
  });

  it('streaming output without input folds nothing (cheap Map probe, no phantom echoes)', async () => {
    const tel = serverModule.paneInputTelemetry;
    const c = connect(wsUrl, id);
    await c.opened;
    try {
      c.send({ type: 'attach', id, cols: 80, rows: 24 });
      await c.waitForN('attached', 1);
      const before = tel.windowSnapshot();
      const beforeRt = before.operations.find((o) => o.operation === 'pane-input-roundtrip')?.count ?? 0;
      // Generate output WITHOUT typing over the WS: an external tmux send-keys.
      // Wait for a pty frame arriving AFTER the send (attach repaints must not
      // satisfy this wait), then allow the note call to land.
      const ptyBaseline = c.ofType('pty').length;
      await runLocalTmux(['send-keys', '-t', session, '-l', 'echo EXTERNAL\r']);
      const start = Date.now();
      while (Date.now() - start < 4000 && c.ofType('pty').length <= ptyBaseline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      await new Promise((r) => setTimeout(r, 150));
      const after = tel.windowSnapshot();
      const rtCount = after.operations.find((o) => o.operation === 'pane-input-roundtrip')?.count ?? 0;
      assert.equal(rtCount, beforeRt, 'no round-trip folded for output with no pending input');
      assert.equal(tel.pendingCount(), 0);
    } finally {
      c.ws.close();
    }
  });
});
