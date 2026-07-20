import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * Human lifecycle actions — kill / spawn / resume — must each record ONE event in
 * the "while you were away" activity timeline (WARDEN-484). Today these three
 * endpoints are silent in the log; this pins the new `killed` / `spawned` /
 * `resumed` events so a returning human can tell an agent THEY stopped apart from
 * one that crashed, and see the agents they themselves brought up / resumed.
 *
 * Boots the REAL Express app from src/server.js on an ephemeral port with HOME
 * isolated to a temp dir, drives each endpoint over HTTP, and reads activity.jsonl
 * back via `readEvents` to assert exactly one event of the right type with the
 * expected id/host/container/name. Mirrors src/server-catalog.test.js.
 *
 * Why the event count is exact: startLifecyclePoll() / startMonitor() only run
 * under startServer() (guarded by `invokedDirectly` at the bottom of server.js).
 * This test imports `app` and listens itself, so NO background poll emits events
 * — the only rows written are the ones these endpoints append.
 */

describe('human lifecycle actions recorded in the activity timeline — WARDEN-484', () => {
  let httpServer, baseUrl;
  let originalHome, tempHome;
  let clearEvents, readEvents;
  let savedPath, savedExec, shimDir;

  const KILL_SESSION = 'w484kill';
  const SPAWN_SESSION = 'w484spawn';
  const RESUME_SID = 'w484abcd';
  const RESUME_SESSION = `resume-${RESUME_SID}`; // the session name /api/resume derives from the sid

  const catPath = () => path.join(tempHome, '.yatfa-warden', 'chats.json');
  const seedCatalog = (entries) => fs.writeFileSync(catPath(), JSON.stringify(entries, null, 2) + '\n');
  const json = (body) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-life-events-'));
    process.env.HOME = tempHome;
    const wdir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wdir, { recursive: true });
    fs.writeFileSync(path.join(wdir, 'config.json'), JSON.stringify({ hosts: [] }) + '\n');
    seedCatalog([]);

    // claude shim that stays alive so /api/resume's post-spawn hasSession check
    // passes (mirrors src/server-catalog.test.js). Scoped to this process and
    // restored in after(). detectClaude('(local)') honors CLAUDE_CODE_EXECPATH
    // first, so clear it to force the PATH lookup to find the shim.
    shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-shim-'));
    const shim = path.join(shimDir, 'claude');
    fs.writeFileSync(shim, '#!/bin/sh\n[ "$1" = "--version" ] && { echo 1.0.0; exit 0; }\nsleep 300\n');
    fs.chmodSync(shim, 0o755);
    savedPath = process.env.PATH;
    savedExec = process.env.CLAUDE_CODE_EXECPATH;
    delete process.env.CLAUDE_CODE_EXECPATH;
    process.env.PATH = `${shimDir}:${process.env.PATH || ''}`;

    // Dynamic import AFTER HOME + PATH are set → activity.js / config.js resolve
    // under tempHome and detectClaude finds the shim. clearEvents before boot so
    // we start from a clean log.
    const activity = await import('./activity.js');
    clearEvents = activity.clearEvents;
    readEvents = activity.readEvents;
    clearEvents();

    const { app } = await import('./server.js');
    httpServer = app.listen(0, '127.0.0.1');
    await new Promise((res, rej) => { httpServer.once('listening', res); httpServer.once('error', rej); });
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  });

  after(async () => {
    // Kill any tmux sessions these tests spawned — by EXACT session name (a tmux
    // op), NEVER by command-line pattern (which can kill this agent process).
    for (const s of [KILL_SESSION, SPAWN_SESSION, RESUME_SESSION, 'w484tl']) {
      spawnSync('tmux', ['kill-session', '-t', s], { stdio: 'ignore' });
    }
    if (httpServer) await new Promise((r) => httpServer.close(r));
    process.env.PATH = savedPath;
    if (savedExec === undefined) delete process.env.CLAUDE_CODE_EXECPATH;
    else process.env.CLAUDE_CODE_EXECPATH = savedExec;
    try { fs.rmSync(shimDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  // Read events of a single type since the last clearEvents(). Each endpoint
  // under test appends exactly one event of its type; nothing else writes here.
  // readEvents is async (WARDEN-828 — non-blocking JSONL read), so this awaits.
  const eventsOfType = async (type) => (await readEvents()).filter((e) => e.type === type);

  it('/api/spawn records one "spawned" event with id/host/container/name', async () => {
    clearEvents();
    // cmd `sleep 300` keeps the session alive (resolveClaudeCmd only rewrites cmds
    // starting with `claude`, so this flows straight to tmux untouched) so
    // buildAndSpawn's hasSession check passes and the spawned event is reached.
    const res = await fetch(`${baseUrl}/api/spawn`, json({ host: '(local)', session: SPAWN_SESSION, name: 'my-spawn', cwd: '/tmp', cmd: 'sleep 300' }));
    assert.strictEqual(res.status, 200, `spawn should succeed via the sleeping cmd, got ${res.status}`);
    try {
      const body = await res.json();
      const of = await eventsOfType('spawned');
      assert.strictEqual(of.length, 1, 'exactly one spawned event');
      assert.strictEqual(of[0].id, body.chat.id, 'id matches the returned chat id');
      assert.strictEqual(of[0].host, '(local)');
      assert.strictEqual(of[0].container, null, 'manual/tmux chats group under their host (container null)');
      assert.strictEqual(of[0].name, 'my-spawn');
      assert.strictEqual(of[0].role, 'claude');
    } finally {
      spawnSync('tmux', ['kill-session', '-t', SPAWN_SESSION], { stdio: 'ignore' });
    }
  });

  it('/api/resume records one "resumed" event with id/host/container/name', async () => {
    clearEvents();
    const res = await fetch(`${baseUrl}/api/resume`, json({ id: RESUME_SID, host: '(local)', cwd: '/tmp', name: 'my-resume' }));
    assert.strictEqual(res.status, 200, `resume should succeed via the shim, got ${res.status}`);
    try {
      const of = await eventsOfType('resumed');
      assert.strictEqual(of.length, 1, 'exactly one resumed event');
      assert.strictEqual(of[0].id, `(local):${RESUME_SESSION}`);
      assert.strictEqual(of[0].host, '(local)');
      assert.strictEqual(of[0].container, null);
      assert.strictEqual(of[0].name, 'my-resume');
      assert.strictEqual(of[0].role, 'claude');
    } finally {
      spawnSync('tmux', ['kill-session', '-t', RESUME_SESSION], { stdio: 'ignore' });
    }
  });

  it('/api/kill records one "killed" event with id/host/container/name', async () => {
    // Seed a tmux catalog entry so resolve('(local):w484kill') finds a named chat.
    // killTmux no-ops on the absent session; the catalog filter drops the entry;
    // the killed event is the authoritative human-action signal regardless.
    seedCatalog([{ kind: 'tmux', host: '(local)', session: KILL_SESSION, name: 'local-kill', cwd: '/tmp', cmd: 'claude' }]);
    clearEvents();
    const res = await fetch(`${baseUrl}/api/kill`, json({ id: `(local):${KILL_SESSION}` }));
    assert.strictEqual(res.status, 200);
    try {
      const of = await eventsOfType('killed');
      assert.strictEqual(of.length, 1, 'exactly one killed event');
      assert.strictEqual(of[0].id, `(local):${KILL_SESSION}`);
      assert.strictEqual(of[0].host, '(local)');
      assert.strictEqual(of[0].container, null);
      assert.strictEqual(of[0].name, 'local-kill');
      assert.strictEqual(of[0].role, 'claude');
    } finally {
      seedCatalog([]);
    }
  });

  it('the new event types surface in the /api/activity timeline', async () => {
    // The timeline endpoint reads the same activity.jsonl the endpoints wrote, so a
    // spawned row must appear among the returned events (the UI joins per-agent by
    // container/host and lists each type in its dynamic filter dropdown).
    clearEvents();
    const spawnRes = await fetch(`${baseUrl}/api/spawn`, json({ host: '(local)', session: 'w484tl', name: 'tl-spawn', cwd: '/tmp', cmd: 'sleep 300' }));
    assert.strictEqual(spawnRes.status, 200);
    spawnSync('tmux', ['kill-session', '-t', 'w484tl'], { stdio: 'ignore' });

    const res = await fetch(`${baseUrl}/api/activity`);
    assert.strictEqual(res.status, 200);
    const { events } = await res.json();
    const spawned = events.filter((e) => e.type === 'spawned');
    assert.strictEqual(spawned.length, 1, 'spawned event reachable via /api/activity');
    assert.strictEqual(spawned[0].name, 'tl-spawn');
  });
});
