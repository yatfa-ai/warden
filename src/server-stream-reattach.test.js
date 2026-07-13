import { describe, it, before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import { runLocalTmux } from './ssh.js';

/**
 * Backend identity-guard regression test for the WARDEN-365 attach lifecycle.
 *
 * The /api/stream attach handler binds each PTY under a per-attach `entry` and
 * gates onData/onExit on identity (`attaches.get(id) === entry`). node-pty's
 * kill() returns BEFORE the child's onExit fires, so on a detach→attach (Retry)
 * the PRIOR PTY's onExit lands AFTER the new PTY is bound under the same id.
 * The guard must keep that late onExit fully silent — no `attaches.delete`, no
 * spurious `{type:'ended'}` — or a healthy just-re-attached pane gets clobbered
 * (orphans the new entry / pushes a false session_dead), reproducing the
 * intermittent, race-shaped rendering corruption the ticket fixes.
 *
 * These tests drive the REAL server (module-level `server`, which is the http
 * instance streamWss's upgrade handler is bound to) over a REAL WebSocket
 * against REAL local tmux + node-pty. They assert the message stream, which is
 * the exact surface the frontend consumes:
 *
 *   A. A natural PTY exit (the live entry) emits exactly ONE `ended`.
 *   B. A kill()-induced detach emits NO `ended` against a freshly-rebound PTY,
 *      and the rebound PTY remains the live entry (its own later natural exit
 *      is the sole `ended` for the whole attach→detach→attach sequence).
 *
 * Catching the bug is ordering-robust: the unpatched (asymmetric) guard runs
 * `send({type:'ended'})` UNCONDITIONALLY on every onExit, so PTY1's kill always
 * produces a spurious `ended` regardless of whether it fires before or after
 * PTY2 binds — doubling the `ended` count test B asserts is exactly 1.
 *
 * Skipped automatically when tmux isn't installed (CI without tmux), mirroring
 * src/session-recovery.test.js.
 */

const LOCAL = '(local)';

const tmuxPresent = (() => {
  try { execFileSync('tmux', ['-V'], { stdio: ['ignore', 'ignore', 'ignore'] }); return true; } catch { return false; }
})();

// Open a WS client to /api/stream and collect the message stream. Each test gets
// a fresh connection (each connection owns its own `attaches` Map on the server,
// so tests are isolated even if a prior test left an entry dangling).
function connect(wsUrl, id) {
  const ws = new WebSocket(wsUrl);
  const msgs = [];
  ws.on('message', (raw) => { try { msgs.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
  const opened = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const send = (obj) => ws.send(JSON.stringify(obj));
  const ofType = (type) => msgs.filter((m) => m.type === type && m.id === id);
  // Resolve once at least `n` messages of `type` (for this id) have arrived.
  const waitForN = async (type, n, timeoutMs = 4000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (ofType(type).length >= n) return ofType(type);
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for ${n}× ${type}; saw ${ofType(type).length}. all msgs: ${JSON.stringify(msgs)}`);
  };
  return { ws, msgs, opened, send, ofType, waitForN };
}

describe('stream attach lifecycle identity guard (real server + local PTY)', { skip: !tmuxPresent && 'tmux not installed' }, () => {
  let serverModule;
  let wsUrl;
  let originalHome;
  let tempHome;
  const session = `warden-test-reattach-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
  const id = `${LOCAL}:${session}`;

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-reattach-'));
    process.env.HOME = tempHome;
    const wardenDir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wardenDir, { recursive: true });
    fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: [] }));
    // A single local manual-tmux chat. The session is (re)created per-test below.
    fs.writeFileSync(
      path.join(wardenDir, 'chats.json'),
      JSON.stringify([{ kind: 'tmux', host: LOCAL, session, name: 'reattach test', cwd: '', cmd: 'sleep 3600' }]),
    );

    // Dynamic import AFTER HOME is swapped so server.js's module-load `load()`
    // + `loadCatalog()` read the throwaway config/catalog. `server` is the http
    // instance streamWss is wired to; app.listen() would make a different one.
    serverModule = await import('./server.js');
    await new Promise((resolve, reject) => {
      serverModule.server.once('listening', resolve);
      serverModule.server.once('error', reject);
      serverModule.server.listen(0, '127.0.0.1');
    });
    wsUrl = `ws://127.0.0.1:${serverModule.server.address().port}/api/stream`;
  });

  // Each test starts from a clean, alive tmux session regardless of what the
  // previous test did to it (test A kills it; test B must not inherit that).
  beforeEach(() => {
    try { runLocalTmux(['kill-session', '-t', session]); } catch { /* best effort */ }
    runLocalTmux(['new-session', '-d', '-s', session, 'sleep', '3600']);
  });
  afterEach(() => {
    try { runLocalTmux(['kill-session', '-t', session]); } catch { /* best effort */ }
  });

  after(async () => {
    try { serverModule.server.closeAllConnections?.(); } catch { /* noop */ }
    if (serverModule?.server?.listening) await new Promise((r) => serverModule.server.close(r));
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('emits exactly one ended for a natural PTY exit while it is the live entry', async () => {
    const c = connect(wsUrl, id);
    await c.opened;
    try {
      c.send({ type: 'attach', id, cols: 80, rows: 24 });
      await c.waitForN('attached', 1); // PTY is live + bound
      assert.strictEqual(c.ofType('ended').length, 0, 'no ended before the session ends');
      // Killing the tmux session makes the `tmux attach` viewer PTY exit cleanly
      // — a natural exit of the live entry (not a pty.kill()).
      runLocalTmux(['kill-session', '-t', session]);
      await c.waitForN('ended', 1);
      // Drain any trailing events, then assert the SINGLE natural exit produced
      // exactly one ended (no doubling from any path).
      await new Promise((r) => setTimeout(r, 500));
      assert.strictEqual(c.ofType('ended').length, 1, `expected exactly 1 ended, got ${c.ofType('ended').length}`);
    } finally {
      c.ws.close();
    }
  });

  it('a detach (pty.kill) of a prior PTY emits no ended against a freshly-rebound PTY (WARDEN-365)', async () => {
    const c = connect(wsUrl, id);
    await c.opened;
    try {
      // --- attach PTY1 ---
      c.send({ type: 'attach', id, cols: 80, rows: 24 });
      await c.waitForN('attached', 1);
      // --- detach: server pty.kill()s PTY1 (onExit fires async, later) + deletes ---
      c.send({ type: 'detach', id });
      // Tiny gap so the detach handler (sync, no await) has run before attach2.
      await new Promise((r) => setTimeout(r, 25));
      // --- reattach PTY2 under the SAME id (this is the Retry path) ---
      c.send({ type: 'attach', id, cols: 80, rows: 24 });
      await c.waitForN('attached', 2); // second attach bound a fresh PTY
      // Give PTY1's late kill()-induced onExit time to fire. On the unpatched
      // (asymmetric) guard this sends a spurious ended here; the fixed guard
      // (early return on identity mismatch) suppresses it entirely.
      await new Promise((r) => setTimeout(r, 800));
      assert.strictEqual(
        c.ofType('ended').length, 0,
        `detach/reattach must emit no ended (the client initiated the kill); got ${JSON.stringify(c.ofType('ended'))}`,
      );

      // PTY2 must still be the LIVE entry — proof PTY1's late onExit neither
      // sent an ended nor `delete`d PTY2's entry. Killing the tmux session makes
      // PTY2 exit naturally; that must be the ONLY ended for the whole sequence.
      runLocalTmux(['kill-session', '-t', session]);
      await c.waitForN('ended', 1);
      // Drain so any hypothetical orphaned/stale PTY onExit would land here too.
      await new Promise((r) => setTimeout(r, 800));
      assert.strictEqual(
        c.ofType('ended').length, 1,
        `expected exactly 1 ended total (PTY2's natural exit); got ${c.ofType('ended').length}. ` +
          `A spurious ended from the killed prior PTY doubles this on the unpatched guard.`,
      );
    } finally {
      c.ws.close();
    }
  });
});
