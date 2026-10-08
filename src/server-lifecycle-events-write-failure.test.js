import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * WARDEN-1661 — the post-action activity-log append in /api/spawn, /api/resume and
 * /api/kill is bookkeeping: when it fails (full disk, EACCES, EISDIR) the route must
 * still report the already-completed action as a success (200), not a 500 (which made
 * a retried spawn 409 "already exists").
 *
 * Failure injection (as wsLayer-activity-write-failure.test.js): activity.jsonl is a
 * DIRECTORY, so appendFile → EISDIR deterministically (also as root). Case (d) is the
 * positive control proving the injection is real, so (a)-(c) cannot pass vacuously.
 * Harness mirrors server-lifecycle-events.test.js (real app, ephemeral port, HOME
 * redirected BEFORE the dynamic import, claude shim for resume).
 */
describe('WARDEN-1661 — failing activity append never fails a lifecycle route', () => {
  let httpServer, baseUrl, originalHome, tempHome, savedPath, savedExec, shimDir, appendEvent;
  const SPAWN = 'w1661spawn';
  const KILL = 'w1661kill';
  const RESUME_SID = 'w1661abc';
  const RESUME_SESSION = `resume-${RESUME_SID}`;
  const catPath = () => path.join(tempHome, '.yatfa-warden', 'chats.json');
  const readCatalog = () => JSON.parse(fs.readFileSync(catPath(), 'utf8'));
  const hasTmux = (s) => spawnSync('tmux', ['has-session', '-t', s], { stdio: 'ignore' }).status === 0;
  const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-life-writefail-'));
    process.env.HOME = tempHome;
    const wdir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wdir, { recursive: true });
    fs.writeFileSync(path.join(wdir, 'config.json'), JSON.stringify({ hosts: [] }) + '\n');
    fs.writeFileSync(catPath(), '[]\n');
    fs.mkdirSync(path.join(wdir, 'activity.jsonl'), { recursive: true }); // THE INJECTION

    shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-shim-'));
    const shim = path.join(shimDir, 'claude');
    fs.writeFileSync(shim, '#!/bin/sh\n[ "$1" = "--version" ] && { echo 1.0.0; exit 0; }\nsleep 300\n');
    fs.chmodSync(shim, 0o755);
    savedPath = process.env.PATH;
    savedExec = process.env.CLAUDE_CODE_EXECPATH;
    delete process.env.CLAUDE_CODE_EXECPATH;
    process.env.PATH = `${shimDir}:${process.env.PATH || ''}`;

    ({ appendEvent } = await import('./activity.js'));
    const { app } = await import('./server.js');
    httpServer = app.listen(0, '127.0.0.1');
    await new Promise((res, rej) => { httpServer.once('listening', res); httpServer.once('error', rej); });
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  });

  after(async () => {
    for (const s of [SPAWN, KILL, RESUME_SESSION]) spawnSync('tmux', ['kill-session', '-t', s], { stdio: 'ignore' });
    if (httpServer) await new Promise((r) => httpServer.close(r));
    process.env.PATH = savedPath;
    if (savedExec === undefined) delete process.env.CLAUDE_CODE_EXECPATH;
    else process.env.CLAUDE_CODE_EXECPATH = savedExec;
    try { fs.rmSync(shimDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('(d) positive control: appendEvent against the broken path really rejects', async () => {
    await assert.rejects(appendEvent({ type: 'spawned', id: 'x', host: '(local)' }));
  });

  it('(a) /api/spawn → 200 + chat, tmux session exists, catalog entry present', async () => {
    const res = await fetch(`${baseUrl}/api/spawn`, json({ host: '(local)', session: SPAWN, name: 'wf-spawn', cwd: '/tmp', cmd: 'sleep 300' }));
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.chat.id, `(local):${SPAWN}`);
    assert.ok(hasTmux(SPAWN), 'tmux session exists');
    assert.ok(readCatalog().some((c) => c.session === SPAWN), 'catalog entry present');
  });

  it('(b) /api/resume → 200, tmux session exists, catalog entry present', async () => {
    const res = await fetch(`${baseUrl}/api/resume`, json({ id: RESUME_SID, host: '(local)', cwd: '/tmp', name: 'wf-resume' }));
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).ok, true);
    assert.ok(hasTmux(RESUME_SESSION), 'tmux session exists');
    assert.ok(readCatalog().some((c) => c.session === RESUME_SESSION), 'catalog entry present');
  });

  it('(c) /api/kill → 200, session gone, catalog entry removed', async () => {
    assert.ok(hasTmux(SPAWN), 'precondition: spawned session alive');
    const res = await fetch(`${baseUrl}/api/kill`, json({ id: `(local):${SPAWN}` }));
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).ok, true);
    assert.ok(!hasTmux(SPAWN), 'tmux session gone');
    assert.ok(!readCatalog().some((c) => c.session === SPAWN), 'catalog entry removed');
  });
});
