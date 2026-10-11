import { describe, it, before, after, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLocalTmux } from './ssh.js';
import { isNativeLocal } from './winsession.js';

/**
 * Locks runLocalTmux's default timeout (WARDEN-1743). Callers that pass no
 * `timeout` (chats.js capturePanes local leg, localAliveSessions, discover
 * display-message, server.js preflightTmux) used to arm NO timer, so a wedged
 * local tmux child made them await forever. An absent timeout now takes a 30s
 * default (matching the remote run()); an explicit finite 0/negative value
 * still arms no timer.
 *
 * The fake `tmux` is a shell script first on PATH (TMUX_BIN is the bare name
 * 'tmux' off win32, resolved by spawn through process.env.PATH at call time —
 * LOCAL_ENV is process.env itself). It records its pid and `exec`s sleep, so
 * the recorded pid IS the sleeping process and SIGTERM ends it.
 *
 * Run: node --test src/runLocalTmuxTimeout.test.js
 */

const skip = process.platform === 'win32' || isNativeLocal();

describe('runLocalTmux default timeout (WARDEN-1743)', { skip }, () => {
  let dir;
  let origPath;
  const pidFile = () => join(dir, 'pid');

  function installFake(body) {
    const p = join(dir, 'tmux');
    writeFileSync(p, `#!/bin/sh\necho $$ > "${pidFile()}"\n${body}\n`);
    chmodSync(p, 0o755);
  }
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const fakePid = () => (existsSync(pidFile()) ? Number(readFileSync(pidFile(), 'utf8').trim()) : null);
  // Real (un-mocked) wait: setImmediate is not touched by mock.timers.
  async function realWait(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) await new Promise((r) => setImmediate(r));
  }
  async function settled(promise, ms) {
    let done = false; let value;
    promise.then((v) => { done = true; value = v; });
    const end = Date.now() + ms;
    while (!done && Date.now() < end) await new Promise((r) => setImmediate(r));
    return { done, value };
  }

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'warden-fake-tmux-'));
    origPath = process.env.PATH;
    process.env.PATH = `${dir}:${origPath}`;
  });
  after(() => {
    process.env.PATH = origPath;
    rmSync(dir, { recursive: true, force: true });
  });
  afterEach(() => {
    mock.timers.reset();
    const pid = fakePid();
    if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    rmSync(pidFile(), { force: true });
  });

  it('(a) with no timeout, a hung tmux child settles {ok:false, code:-1} once the 30s default elapses and is killed', async () => {
    installFake('exec sleep 300');
    mock.timers.enable({ apis: ['setTimeout'] });
    const p = runLocalTmux(['-V']);
    // Let the child actually spawn (pid file written) before firing the timer.
    const spawnEnd = Date.now() + 3000;
    while (!fakePid() && Date.now() < spawnEnd) await new Promise((r) => setImmediate(r));
    const pid = fakePid();
    assert.ok(pid, 'fake tmux was spawned (PATH resolution works)');
    mock.timers.tick(29999);
    assert.strictEqual((await settled(p, 200)).done, false, 'not settled before the 30s default');
    mock.timers.tick(1);
    const r = await settled(p, 3000);
    assert.strictEqual(r.done, true, 'settles once the 30s default elapses');
    assert.deepStrictEqual(r.value, { ok: false, code: -1, stdout: '', stderr: '' });
    await realWait(100);
    assert.strictEqual(alive(pid), false, 'hung child was killed (no leaked sleep)');
  });

  it('(b) explicit { timeout: 50 } still settles in ~50ms', async () => {
    installFake('exec sleep 300');
    const t0 = Date.now();
    const r = await runLocalTmux(['-V'], { timeout: 50 });
    const dt = Date.now() - t0;
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, -1);
    assert.ok(dt < 5000, `settled promptly (${dt}ms)`);
  });

  it('(c) explicit { timeout: 0 } arms no timer — opt-out unchanged', async () => {
    installFake('sleep 0.5; echo hi');
    mock.timers.enable({ apis: ['setTimeout'] });
    const p = runLocalTmux(['-V'], { timeout: 0 });
    mock.timers.tick(60000); // would fire any armed timer (default or otherwise)
    const r = await settled(p, 5000);
    assert.strictEqual(r.done, true);
    assert.strictEqual(r.value.ok, true, 'child ran to completion, not killed');
    assert.strictEqual(r.value.code, 0);
    assert.strictEqual(r.value.stdout.trim(), 'hi');
  });
});
