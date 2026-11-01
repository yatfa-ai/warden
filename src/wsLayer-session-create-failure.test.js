import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { WebSocket } from 'ws';
import { bootWsLayer } from './wsLayerTestHarness.mjs';

/**
 * WARDEN-1693 — a FAILING createSession inside the async /api/observe connection handler
 * must not escape as an unhandledRejection (which terminates the process on Node >= 15).
 *
 * Every fresh Observer panel connects with no `sid`, so wsLayer calls createSession, whose
 * ensureDir()/atomic writes reject on a full disk / EACCES / broken data dir. The client
 * must get exactly one `{type:'error', error:'could not create session'}` frame instead.
 *
 * Positive control first (normal sessions/ dir -> session_created), then failure injection
 * (<HOME>/.yatfa-warden/sessions is a regular file -> mkdir EEXIST, also when run as root).
 * HOME is redirected BEFORE the dynamic imports.
 */

const settle = () => new Promise((r) => setTimeout(r, 150));

function observeFrames(port, waitMs = 500) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/observe`);
    const got = [];
    ws.on('message', (d) => got.push(JSON.parse(String(d))));
    ws.on('error', reject);
    ws.on('open', () => setTimeout(() => { ws.close(); resolve(got); }, waitMs));
  });
}

describe('WARDEN-1693 — failing createSession never escapes the observe connection handler', () => {
  let harness, port, sessionsDir;
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);

  before(async () => {
    process.on('unhandledRejection', onRejection);
    harness = await bootWsLayer({ prefix: 'warden-ws-sesscreate-' });
    ({ port, sessionsDir } = harness);
  });

  after(async () => {
    process.removeListener('unhandledRejection', onRejection);
    await harness.close();
  });

  it('positive control: with a normal sessions/ dir, no-sid connect gets session_created', async () => {
    const frames = await observeFrames(port);
    await settle();
    assert.ok(frames.some((f) => f.type === 'session_created' && f.sid), `frames: ${JSON.stringify(frames)}`);
    assert.strictEqual(rejections.length, 0, `unhandled rejections: ${rejections.map(String)}`);
  });

  it('createSession failure: client gets exactly the error frame, no unhandledRejection', async () => {
    // THE INJECTION: sessions/ becomes a regular file, so ensureDir's mkdir rejects.
    fs.rmSync(sessionsDir, { recursive: true, force: true });
    fs.writeFileSync(sessionsDir, 'not a directory');
    const { createSession } = await import('./sessions.js');
    await assert.rejects(() => createSession(null, {}), /EEXIST|ENOTDIR/); // control: failure is real

    const frames = await observeFrames(port);
    await settle();
    assert.deepStrictEqual(frames, [{ type: 'error', error: 'could not create session' }]);
    assert.strictEqual(rejections.length, 0, `unhandled rejections: ${rejections.map(String)}`);
  });
});
