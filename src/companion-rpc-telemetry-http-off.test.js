import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * WARDEN-1598 wiring test: a REAL CompanionChannel.call() observation reaches
 * process.send as `telemetry-metrics` under operational-metrics consent, and
 * does NOT without it. server.js evaluates its config at import, so each
 * posture boots in its own process: this file = consent ON; the OFF twin is
 * src/companion-rpc-telemetry-http-off.test.js.
 */

const CONSENT = false;
let originalHome; let tempHome; let mod; let companion;
const sent = [];

before(async () => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-companionrpctel-home-'));
  process.env.HOME = tempHome;
  const dir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(
    CONSENT ? { hosts: [], telemetryOperationalMetricsEnabled: true } : { hosts: [] },
  ));
  process.send = (msg) => sent.push(msg);
  mod = await import('./server.js');
  companion = await import('./companion.js');
});

after(() => {
  delete process.send;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function fakeTransport(handler) {
  let lineCB = null;
  return {
    write(line) { const resp = handler(JSON.parse(line)); setImmediate(() => lineCB(JSON.stringify(resp))); },
    onLine(cb) { lineCB = cb; }, onExit() {}, kill() {},
  };
}

async function oneCall() {
  const ch = new companion.CompanionChannel('secret-host.example.com',
    fakeTransport((r) => ({ id: r.id, ok: true, result: { ok: 1 } })));
  await ch.call('exec', { cmd: 'git push --force' }, { timeout: 500 });
  await ch.call('ping', {}, { timeout: 500 });
}

describe(`companion-rpc telemetry wiring (consent ${CONSENT ? 'ON' : 'OFF'})`, () => {
  it(CONSENT ? 'a run() observation is forwarded as telemetry-metrics with companion-rpc-exec' : 'a run() observation is dropped: nothing retained, nothing forwarded', async () => {
    await oneCall();
    const snap = mod.companionRpcTelemetry.flushNow();
    if (!CONSENT) {
      assert.equal(snap, null);
      assert.deepEqual(sent, []);
      return;
    }
    assert.ok(snap);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'telemetry-metrics');
    assert.deepEqual(sent[0].snapshot.operations.map((o) => o.operation), ['companion-rpc-exec']);
    assert.equal(sent[0].snapshot.operations[0].count, 1);
    assert.equal(sent[0].snapshot.operations[0].okCount, 1);
    assert.equal(JSON.stringify(sent[0]).includes('secret-host'), false);
    assert.equal(JSON.stringify(sent[0]).includes('git push'), false);
  });
});
