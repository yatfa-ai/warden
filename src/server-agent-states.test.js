// HTTP integration test for GET /api/agent-states (WARDEN-344) — the endpoint that
// feeds the proactive attention surfaces (header AttentionBadge + desktop alert) with
// per-pane classified states, so an agent stuck / erroring / waiting-on-you no longer
// reads "Healthy".
//
// The pure classifier is covered by agentState.test.js; this proves the WIRING:
// the client passes open pane KEYS as ?panes=, the server resolves them from the
// cache (zero ssh), captures each once via capturePanes, classifies with the SAME
// classifyPane, and returns each agent's state + signal + deep-link identity. A
// host whose capture fails is returned as capture_failed (flagged, not dropped).
//
// Uses REAL local tmux sessions with deterministic content (`yes` for a stuck loop,
// `printf` for a waiting prompt) so the end-to-end path is exercised, not mocked.
// HOME is pointed at a throwaway dir BEFORE importing server.js so the catalog file
// resolves under it (same pattern as server-catalog.test.js). tmux sessions are
// cleaned up by EXACT name in after() — never by command-line pattern.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

describe('GET /api/agent-states — pane-state classification over open panes (WARDEN-344)', () => {
  let httpServer, baseUrl;
  let originalHome, tempHome, catPath;

  const STUCK_SESSION = 'w344stuck';
  const WAIT_SESSION = 'w344wait';
  const DEAD_SESSION = 'w344dead'; // catalog entry but no live tmux session
  const STUCK_LINE = 'stuck loop repeating same output line over and over again';

  function seedCatalog(entries) {
    fs.writeFileSync(catPath, JSON.stringify(entries, null, 2) + '\n');
  }
  // Spawn a detached local tmux session running a given command.
  const newSession = (name, cmd) => spawnSync('tmux', ['new-session', '-d', '-s', name, cmd], { stdio: 'ignore' });
  const killSession = (name) => spawnSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' });

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-agent-states-'));
    process.env.HOME = tempHome;
    const wdir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wdir, { recursive: true });
    fs.writeFileSync(path.join(wdir, 'config.json'), JSON.stringify({ hosts: [] }) + '\n');
    catPath = path.join(wdir, 'chats.json');

    // Seed catalog entries for every session we reference (the endpoint resolves pane
    // keys from the cache, which /api/chats populates from this file).
    seedCatalog([
      { kind: 'tmux', host: '(local)', session: STUCK_SESSION, name: 'stuck-agent', cwd: '/tmp', cmd: 'yes' },
      { kind: 'tmux', host: '(local)', session: WAIT_SESSION, name: 'wait-agent', cwd: '/tmp', cmd: 'bash' },
      { kind: 'tmux', host: '(local)', session: DEAD_SESSION, name: 'dead-agent', cwd: '/tmp', cmd: 'bash' },
    ]);

    // Live sessions with deterministic content:
    //  - stuck: a script that prints the same line 6 times (so last 3 === prev 3)
    //    then sleeps — STABLE content. We avoid `yes` (which floods indefinitely and
    //    can race the pane state under the batched 3-pane capture).
    //  - wait: a bash prompt that has printed a human-input cue.
    const stuckScript = path.join(tempHome, 'stuck-pane.sh');
    fs.writeFileSync(stuckScript,
      `#!/bin/sh\nL='${STUCK_LINE}'\nprintf '%s\\n%s\\n%s\\n%s\\n%s\\n%s' "$L" "$L" "$L" "$L" "$L" "$L"\nsleep 300\n`);
    fs.chmodSync(stuckScript, 0o755);
    newSession(STUCK_SESSION, `sh ${stuckScript}`);
    newSession(WAIT_SESSION, 'bash');

    // Poll (rather than a fixed sleep) so the test is deterministic on a loaded box:
    // wait until the stuck pane holds the repeating block, and until bash has printed
    // its prompt so send-keys lands. A setup timeout THROWS with the actual capture so
    // a slow box reads as a clear setup failure, not a mysterious 'idle' assertion.
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const capture = (name) => {
      const r = spawnSync('tmux', ['capture-pane', '-t', name, '-p', '-S', '-10', '-E', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
      return String(r.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
    };
    const stuckReady = () => {
      const lines = capture(STUCK_SESSION).slice(-6);
      return lines.length >= 6 && lines.every((l) => l === STUCK_LINE);
    };
    const waitReady = () => capture(WAIT_SESSION).some((l) => l.includes('Press enter to continue'));
    const waitFor = async (pred, what, timeoutMs = 3000) => {
      for (const start = Date.now(); Date.now() - start < timeoutMs; await sleep(50)) {
        if (pred()) return true;
      }
      throw new Error(`${what} never stabilized; last capture: ${JSON.stringify(capture(STUCK_SESSION))} / ${JSON.stringify(capture(WAIT_SESSION))}`);
    };
    await waitFor(stuckReady, 'stuck pane');
    await waitFor(() => capture(WAIT_SESSION).some((l) => l.includes('$') || l.includes('#')), 'bash prompt');
    spawnSync('tmux', ['send-keys', '-t', WAIT_SESSION, 'printf "Press enter to continue\\n"', 'Enter'], { stdio: 'ignore' });
    await waitFor(waitReady, 'wait prompt');

    // Dynamic import AFTER HOME is set → catalog/config resolve under tempHome.
    const { app } = await import('./server.js');
    httpServer = app.listen(0, '127.0.0.1');
    await new Promise((res, rej) => { httpServer.once('listening', res); httpServer.once('error', rej); });
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;

    // Populate the in-memory cache from the seeded catalog (the endpoint reads cache).
    await fetch(`${baseUrl}/api/chats`);
  });

  after(async () => {
    // Clean up tmux sessions by EXACT name only (never a command-line pattern —
    // pattern kills can self-match this agent). spawnSync tmux ops are safe.
    for (const s of [STUCK_SESSION, WAIT_SESSION]) killSession(s);
    if (httpServer) await new Promise((r) => httpServer.close(r));
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  const states = async (panes) => {
    const url = `${baseUrl}/api/agent-states${panes ? `?panes=${encodeURIComponent(panes)}` : ''}`;
    const res = await fetch(url);
    assert.equal(res.status, 200);
    return res.json();
  };

  it('no open panes → empty result (zero capture cost)', async () => {
    const r = await states('');
    assert.equal(r.total, 0);
    assert.deepEqual(r.agents, []);
  });

  it('an unknown pane key (cache miss) → empty result, no 500', async () => {
    const r = await states('does-not-exist');
    assert.equal(r.total, 0);
    assert.deepEqual(r.agents, []);
  });

  it('a repeating-output loop (`yes`) is classified stuck, not healthy', async () => {
    const r = await states(STUCK_SESSION);
    assert.equal(r.total, 1);
    const a = r.agents[0];
    assert.equal(a.state, 'stuck');
    assert.equal(a.signal, STUCK_LINE, 'signal is the repeating line');
    // Deep-link identity the AttentionBadge row needs:
    assert.equal(a.key, STUCK_SESSION);
    assert.equal(a.host, '(local)');
    assert.equal(a.name, 'stuck-agent');
  });

  it('a "press enter" prompt is classified waiting (while still emitting output)', async () => {
    const r = await states(WAIT_SESSION);
    assert.equal(r.total, 1);
    const a = r.agents[0];
    assert.equal(a.state, 'waiting');
    assert.equal(a.signal, 'Press enter to continue');
  });

  it('a catalog chat whose tmux session is dead → capture_failed (flagged, not dropped)', async () => {
    const r = await states(DEAD_SESSION);
    assert.equal(r.total, 1);
    const a = r.agents[0];
    assert.equal(a.state, 'capture_failed');
    assert.equal(a.captureError, true);
    assert.equal(a.key, DEAD_SESSION, 'identity still surfaced so the badge can name it');
  });

  it('multiple panes in one call are all classified (batched capture, per-agent state)', async () => {
    const r = await states(`${STUCK_SESSION},${WAIT_SESSION},${DEAD_SESSION}`);
    assert.equal(r.total, 3);
    const byKey = Object.fromEntries(r.agents.map((a) => [a.key, a.state]));
    assert.equal(byKey[STUCK_SESSION], 'stuck');
    assert.equal(byKey[WAIT_SESSION], 'waiting');
    assert.equal(byKey[DEAD_SESSION], 'capture_failed');
  });

  // WARDEN-540: the matcher runs in pollAgentStates over the SAME capture
  // classifyPane read (zero new SSH cost) and attaches customMatch to a row whose
  // output matches a user pattern. This proves the end-to-end wiring — the pure
  // matcher is covered by agentState.test.js; this is the pipeline integration.
  it('a watched pattern match attaches customMatch (matcher rides the existing capture)', async () => {
    // 1. With no patterns, no row carries customMatch (identical to today).
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ watchPatterns: [] }),
    });
    let r = await states(STUCK_SESSION);
    assert.equal(r.agents[0].customMatch ?? null, null, 'no pattern → no customMatch');

    // 2. PUT a pattern matching the stuck pane's repeating line.
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ watchPatterns: [{ id: 's', name: 'Stuck loop', expression: 'stuck loop', mode: 'string', enabled: true }] }),
    });
    r = await states(STUCK_SESSION);
    const stuck = r.agents[0];
    assert.deepEqual(stuck.customMatch, { pattern: 'Stuck loop', line: STUCK_LINE }, 'customMatch carries pattern name + matching line');
    // The match is ADDITIVE — the classifyPane state is unaffected (still stuck).
    assert.equal(stuck.state, 'stuck');

    // 3. A pane whose output does NOT contain the expression gets no customMatch.
    r = await states(WAIT_SESSION);
    assert.equal(r.agents[0].customMatch ?? null, null, 'no match on the wait pane');

    // 4. Restore: clearing patterns removes customMatch (back to identical-to-today).
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ watchPatterns: [] }),
    });
    r = await states(STUCK_SESSION);
    assert.equal(r.agents[0].customMatch ?? null, null, 'cleared pattern → no customMatch');
  });
});
