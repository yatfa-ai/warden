import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { run, setSshRunObserver, isTransportFailure } from './ssh.js';

// WARDEN-1578 — run()'s raw-ssh observer. Uses the opts.spawn seam (pattern:
// src/sshRun.test.js). ok === !isTransportFailure(result): "handshake completed",
// NOT "remote command succeeded".

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  c.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  c.kill = () => {};
  return c;
}

// Drive one run() to settlement via `drive(child)`; returns {result, calls}.
async function observe(host, drive, opts = {}) {
  const calls = [];
  setSshRunObserver((ms, ok) => calls.push({ ms, ok }));
  let child;
  const p = run(host, 'cmd', { spawn: () => { child = fakeChild(); return child; }, timeout: 60000, ...opts });
  drive(child);
  const result = await p;
  return { result, calls };
}

afterEach(() => setSshRunObserver(null));

describe('setSshRunObserver / run()', () => {
  it('(a) exit 0 → exactly one observation, ok:true, numeric duration', async () => {
    const { result, calls } = await observe('h', (c) => { c.stdout.emit('data', 'out'); c.emit('close', 0); });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].ok, true);
    assert.equal(typeof calls[0].ms, 'number');
    assert.ok(calls[0].ms >= 0);
  });

  it('(b) remote command exit 1 with empty stdout/stderr (has-session miss) → ok:true (command result is not transport)', async () => {
    const { result, calls } = await observe('h', (c) => { c.emit('close', 1); });
    assert.equal(result.ok, false);
    assert.equal(isTransportFailure(result), false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].ok, true, 'a non-zero remote exit is a command result, not a handshake failure');
  });

  it('(c1) connection refused on stderr with empty stdout → ok:false', async () => {
    const { calls } = await observe('h', (c) => {
      c.stderr.emit('data', 'ssh: connect to host h port 22: Connection refused\n');
      c.emit('close', 255);
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].ok, false);
  });

  it('(c2) SIGKILL timeout (null close code → -1) → ok:false', async () => {
    const { result, calls } = await observe('h', (c) => { c.emit('close', null); });
    assert.equal(result.code, -1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].ok, false);
  });

  it('(c3) spawn error → ok:false, exactly once even if close follows', async () => {
    const { result, calls } = await observe('h', (c) => { c.emit('error', new Error('ENOENT')); c.emit('close', -2); });
    assert.equal(result.code, -1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].ok, false);
  });

  it("never observes for host '(local)'", async () => {
    const { calls } = await observe('(local)', (c) => { c.emit('close', 0); });
    assert.equal(calls.length, 0);
  });

  it('a throwing observer cannot change the resolved value', async () => {
    const drive = (c) => { c.stdout.emit('data', 'x'); c.emit('close', 0); };
    const baseline = (await observe('h', drive)).result;
    setSshRunObserver(() => { throw new Error('boom'); });
    let child;
    const p = run('h', 'cmd', { spawn: () => { child = fakeChild(); return child; }, timeout: 60000 });
    drive(child);
    assert.deepEqual(await p, baseline);
  });

  it('a non-function observer resets to null (no observation, no throw)', async () => {
    setSshRunObserver('nope');
    let child;
    const p = run('h', 'cmd', { spawn: () => { child = fakeChild(); return child; }, timeout: 60000 });
    child.emit('close', 0);
    assert.equal((await p).ok, true);
  });
});
