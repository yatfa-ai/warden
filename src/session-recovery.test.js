import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { probeSession } from './tmux.js';
import { runLocalTmux } from './ssh.js';
import { classifyProbe } from './sessionRecovery.js';

/**
 * Tests for the dead/unreachable session recovery path (WARDEN-231).
 *
 * Three layers, all against REAL production code:
 *
 *   1. classifyProbe — the pure classifier that decides which WS message the
 *      /api/stream attach handler emits: null (alive → attach), 'session_dead'
 *      (host up, tmux session absent), 'host_unreachable' (SSH couldn't deliver
 *      the probe / probe timed out). Synthetic probe shapes cover every branch
 *      of isTransportFailure's contract without spawning SSH.
 *
 *   2. probeSession — the bounded has-session probe, against REAL local tmux:
 *      an existing session probes ok, an absent session probes !ok (and
 *      classifies session_dead because the local host trivially answered).
 *
 *   3. /api/respawn — HTTP integration against the real Express app with a
 *      throwaway HOME: a dead catalog chat's tmux session is recreated under the
 *      same name by re-running its cmd; a cmd-less chat is rejected (400); an
 *      unknown id is 404.
 */

const LOCAL = '(local)';

describe('classifyProbe (pure classifier)', () => {
  it('ok probe → null (session alive; attach normally)', () => {
    assert.strictEqual(classifyProbe({ ok: true, code: 0, stdout: '', stderr: '' }), null);
    // ok even if there is incidental stderr
    assert.strictEqual(classifyProbe({ ok: true, code: 0, stdout: '', stderr: 'warning' }), null);
  });

  it('!ok + no stdout + non-zero exit (tmux reported absent session) → session_dead', () => {
    assert.strictEqual(
      classifyProbe({ ok: false, code: 1, stdout: '', stderr: 'no server running on /tmp/tmux-1000/default\n' }),
      'session_dead',
    );
    assert.strictEqual(
      classifyProbe({ ok: false, code: 1, stdout: '', stderr: "can't find session: agent\n" }),
      'session_dead',
    );
  });

  it('!ok + ssh: connection-refused line → host_unreachable', () => {
    assert.strictEqual(
      classifyProbe({ ok: false, code: 255, stdout: '', stderr: 'ssh: connect to host 10.0.0.5 port 22: Connection refused\n' }),
      'host_unreachable',
    );
  });

  it('!ok + code -1 (probe killed by timeout) → host_unreachable', () => {
    assert.strictEqual(classifyProbe({ ok: false, code: -1, stdout: '', stderr: '' }), 'host_unreachable');
  });

  it('!ok + wedged ControlMaster stderr → host_unreachable', () => {
    assert.strictEqual(
      classifyProbe({ ok: false, code: 255, stdout: '', stderr: 'Control socket connect(/tmp/ssh-ctrl-x): No such file\n' }),
      'host_unreachable',
    );
  });

  it('!ok + "Connection timed out" → host_unreachable', () => {
    assert.strictEqual(
      classifyProbe({ ok: false, code: 255, stdout: '', stderr: 'ssh: connect to host 10.0.0.5 port 22: Connection timed out\n' }),
      'host_unreachable',
    );
  });

  it('!ok + auth failure (NOT transport) → session_dead', () => {
    // Auth failures are intentionally not transport (not transient), so per the
    // contract they classify as session_dead. The recovery panel still gives a
    // Close escape instead of an infinite spinner.
    assert.strictEqual(
      classifyProbe({ ok: false, code: 255, stdout: '', stderr: 'user@host: Permission denied (publickey).\n' }),
      'session_dead',
    );
  });

  it('null/undefined probe → null (never blocks a live attach on a missing probe)', () => {
    assert.strictEqual(classifyProbe(null), null);
    assert.strictEqual(classifyProbe(undefined), null);
  });

  it('a truthy-but-empty probe object → session_dead (treated as a failed probe)', () => {
    // Per the WARDEN-231 contract: !ok && !transport → session_dead. An empty
    // {} is a degenerate failed probe (no ok field), so it classifies as dead —
    // only a genuinely missing probe (null/undefined) falls through to null.
    assert.strictEqual(classifyProbe({}), 'session_dead');
  });
});

// probeSession + runLocalTmux contract against REAL local tmux. Skipped
// automatically if tmux isn't installed (CI without tmux) so the suite stays green.
const tmuxPresent = (() => {
  try { execFileSync('tmux', ['-V'], { stdio: ['ignore', 'ignore', 'ignore'] }); return true; } catch { return false; }
})();

describe('probeSession (real local tmux)', { skip: !tmuxPresent && 'tmux not installed' }, () => {
  const session = `warden-test-probe-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
  const chat = { host: LOCAL, session };

  after(() => { try { runLocalTmux(['kill-session', '-t', session]); } catch { /* best effort */ } });

  it('an existing session probes ok → classifyProbe null (alive)', async () => {
    runLocalTmux(['new-session', '-d', '-s', session, 'sleep', '3600']);
    const probe = await probeSession(chat, {});
    assert.strictEqual(probe.ok, true);
    assert.strictEqual(classifyProbe(probe), null);
  });

  it('an absent session probes !ok → classifyProbe session_dead', async () => {
    runLocalTmux(['kill-session', '-t', session]); // now dead
    const probe = await probeSession(chat, {});
    assert.strictEqual(probe.ok, false);
    assert.strictEqual(classifyProbe(probe), 'session_dead');
  });

  it('honors a bounded timeout option without breaking a fast probe', async () => {
    runLocalTmux(['new-session', '-d', '-s', session, 'sleep', '3600']);
    const probe = await probeSession(chat, {}, { timeout: 5000 });
    assert.strictEqual(probe.ok, true);
    runLocalTmux(['kill-session', '-t', session]);
  });
});

describe('runLocalTmux threads the timeout option', () => {
  it('accepts {timeout} and still returns the raw result shape for a fast call', () => {
    const r = runLocalTmux(['has-session', '-t', `definitely-absent-${Math.random().toString(36).slice(2, 8)}`], { timeout: 5000 });
    assert.strictEqual(r.ok, false);
    assert.ok(typeof r.code === 'number');
    assert.ok('stdout' in r && 'stderr' in r);
  });
});

describe('/api/respawn HTTP endpoint (real Express app from server.js)', () => {
  let httpServer;
  let baseUrl;
  let originalHome;
  let tempHome;
  const session = `warden-test-respawn-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
  const nocmdSession = `warden-test-nocmd-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-respawn-'));
    process.env.HOME = tempHome;
    const wardenDir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wardenDir, { recursive: true });
    fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: [] }));
    // Two local catalog chats: one respawnable (cmd that stays alive), one
    // cmd-less (must be rejected — mirrors yatfa chats which have no cmd).
    fs.writeFileSync(
      path.join(wardenDir, 'chats.json'),
      JSON.stringify([
        { kind: 'tmux', host: LOCAL, session, name: 'respawn target', cwd: '', cmd: 'sleep 3600' },
        { kind: 'tmux', host: LOCAL, session: nocmdSession, name: 'no cmd', cwd: '', cmd: '' },
      ]),
    );

    const { app } = await import('./server.js');
    httpServer = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
      httpServer.once('listening', resolve);
      httpServer.once('error', reject);
    });
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  });

  after(async () => {
    if (httpServer) await new Promise((r) => httpServer.close(r));
    // Clean up any tmux session we created.
    for (const s of [session, nocmdSession]) {
      try { runLocalTmux(['kill-session', '-t', s]); } catch { /* best effort */ }
    }
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('recreates a dead chat session under the same name by re-running its cmd', async () => {
    // The catalog session does not exist yet (dead). Respawn must recreate it.
    assert.strictEqual(runLocalTmux(['has-session', '-t', session]).ok, false);
    const res = await fetch(`${baseUrl}/api/respawn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: `${LOCAL}:${session}` }),
    });
    const body = await res.json();
    assert.ok(res.ok, `expected 2xx, got ${res.status}: ${JSON.stringify(body)}`);
    assert.strictEqual(body.ok, true);
    // The session must now actually be alive.
    assert.strictEqual(runLocalTmux(['has-session', '-t', session]).ok, true);
  });

  it('is idempotent on a live session (kill + recreate leaves it alive)', async () => {
    const res = await fetch(`${baseUrl}/api/respawn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: `${LOCAL}:${session}` }),
    });
    assert.ok(res.ok, `expected 2xx, got ${res.status}`);
    assert.strictEqual(runLocalTmux(['has-session', '-t', session]).ok, true);
  });

  it('rejects a cmd-less chat with 400 (only cmd-carrying chats can re-spawn)', async () => {
    const res = await fetch(`${baseUrl}/api/respawn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: `${LOCAL}:${nocmdSession}` }),
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /no command to re-spawn/i);
  });

  it('404s for an unknown chat id', async () => {
    const res = await fetch(`${baseUrl}/api/respawn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: `${LOCAL}:does-not-exist-${Math.random().toString(36).slice(2, 6)}` }),
    });
    assert.strictEqual(res.status, 404);
  });
});
