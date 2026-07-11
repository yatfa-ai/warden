import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { probeSession } from './tmux.js';
import { runLocalTmux, shellQuote } from './ssh.js';
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
  // A chat whose catalog cmd is bare `claude …` — the WARDEN-231 blocker case.
  // The fix must resolve bare `claude` to an absolute path before spawning
  // (resolveClaudeCmd); the test asserts the spawned argv carries that absolute
  // path, not the bare word. See the claude-cmd `before` setup below.
  const claudeSession = `warden-test-claude-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
  let fakeClaude;
  let marker;
  let originalExecPath;

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-respawn-'));
    process.env.HOME = tempHome;
    const wardenDir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wardenDir, { recursive: true });
    fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: [] }));
    // Two local catalog chats: one respawnable (cmd that stays alive), one
    // cmd-less (must be rejected — mirrors yatfa chats which have no cmd).
    // Plus a bare-`claude` chat: detectClaude('(local)') honors CLAUDE_CODE_EXECPATH,
    // so a fake binary placed OFF-PATH there is what resolveClaudeCmd must substitute.
    const claudeDir = path.join(tempHome, 'fake-claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fakeClaude = path.join(claudeDir, 'claude');
    marker = path.join(tempHome, 'respawn-argv.txt');
    // The fake `claude` records how it was invoked ($0) then idles. If respawn ran
    // the raw catalog cmd verbatim, bare `claude` is not on PATH (the fake dir
    // isn't) and the session dies → 500; the marker would never be written. Only
    // resolveClaudeCmd substituting the absolute CLAUDE_CODE_EXECPATH lands here.
    fs.writeFileSync(fakeClaude, `#!/bin/sh\necho "$0" > ${shellQuote(marker)}\nexec sleep 3600\n`);
    fs.chmodSync(fakeClaude, 0o755);
    originalExecPath = process.env.CLAUDE_CODE_EXECPATH;
    process.env.CLAUDE_CODE_EXECPATH = fakeClaude;
    fs.writeFileSync(
      path.join(wardenDir, 'chats.json'),
      JSON.stringify([
        { kind: 'tmux', host: LOCAL, session, name: 'respawn target', cwd: '', cmd: 'sleep 3600' },
        { kind: 'tmux', host: LOCAL, session: nocmdSession, name: 'no cmd', cwd: '', cmd: '' },
        { kind: 'tmux', host: LOCAL, session: claudeSession, name: 'claude chat', cwd: '', cmd: 'claude --dangerously-skip-permissions' },
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
    for (const s of [session, nocmdSession, claudeSession]) {
      try { runLocalTmux(['kill-session', '-t', s]); } catch { /* best effort */ }
    }
    if (originalExecPath === undefined) delete process.env.CLAUDE_CODE_EXECPATH;
    else process.env.CLAUDE_CODE_EXECPATH = originalExecPath;
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

  it('resolves a bare `claude` cmd to an absolute path before respawning (WARDEN-231 blocker)', async () => {
    // The catalog cmd is the bare word `claude`, but the only discoverable claude
    // (the fake binary) sits off-PATH and is reachable solely via
    // CLAUDE_CODE_EXECPATH. Without resolveClaudeCmd, tmux runs bare `claude`,
    // which isn't on PATH → the session dies → 500 and no marker is ever written.
    // With the fix, resolveClaudeCmd substitutes the absolute path, the fake
    // binary runs, and it records $0 == the absolute path. Asserting the marker
    // equals fakeClaude (an absolute path, not the bare word) proves the call.
    assert.strictEqual(runLocalTmux(['has-session', '-t', claudeSession]).ok, false);
    const res = await fetch(`${baseUrl}/api/respawn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: `${LOCAL}:${claudeSession}` }),
    });
    const body = await res.json();
    assert.ok(res.ok, `expected 2xx, got ${res.status}: ${JSON.stringify(body)}`);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(runLocalTmux(['has-session', '-t', claudeSession]).ok, true);
    // The fake claude writes its invocation ($0) to the marker once it starts.
    // Poll briefly — hasSession returning true slightly races the echo flushing.
    let invoked = '';
    for (let i = 0; i < 50 && !invoked; i++) {
      try { invoked = fs.readFileSync(marker, 'utf8').trim(); } catch { /* not written yet */ }
      if (!invoked) await new Promise((r) => setTimeout(r, 20));
    }
    assert.strictEqual(invoked, fakeClaude, `respawn must spawn the resolved absolute path, not bare \`claude\` (got ${JSON.stringify(invoked)})`);
    assert.ok(invoked.startsWith(path.dirname(fakeClaude)), 'spawned path is the resolved absolute fake-claude, not a bare word');
  });
});
