import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';

/**
 * WARDEN-1578 wiring test: a REAL ssh.js run() observation reaches
 * process.send as `telemetry-metrics` under operational-metrics consent, and
 * does NOT without it. server.js evaluates its config at import, so each
 * posture boots in its own process: this file = consent ON; the OFF twin is
 * src/ssh-run-telemetry-http-off.test.js.
 */

const CONSENT = false;
let originalHome; let tempHome; let mod; let ssh;
const sent = [];

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  c.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  c.kill = () => {};
  return c;
}

before(async () => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-sshtel-home-'));
  process.env.HOME = tempHome;
  const dir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(
    CONSENT ? { hosts: [], telemetryOperationalMetricsEnabled: true } : { hosts: [] },
  ));
  process.send = (msg) => sent.push(msg);
  mod = await import('./server.js');
  ssh = await import('./ssh.js');
});

after(() => {
  delete process.send;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
});

async function oneRun() {
  let child;
  const p = ssh.run('secret-host.example.com', 'git push', { spawn: () => { child = fakeChild(); return child; }, timeout: 60000 });
  child.emit('close', 0);
  await p;
}

describe(`ssh-run telemetry wiring (consent ${CONSENT ? 'ON' : 'OFF'})`, () => {
  it(CONSENT ? 'a run() observation is forwarded as telemetry-metrics with ssh-run' : 'a run() observation is dropped: nothing retained, nothing forwarded', async () => {
    await oneRun();
    const snap = mod.sshTelemetry.flushNow();
    if (!CONSENT) {
      assert.equal(snap, null);
      assert.deepEqual(sent, []);
      return;
    }
    assert.ok(snap);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'telemetry-metrics');
    assert.deepEqual(sent[0].snapshot.operations.map((o) => o.operation), ['ssh-run']);
    assert.equal(sent[0].snapshot.operations[0].count, 1);
    assert.equal(sent[0].snapshot.operations[0].okCount, 1);
    assert.equal(JSON.stringify(sent[0]).includes('secret-host'), false);
  });
});
