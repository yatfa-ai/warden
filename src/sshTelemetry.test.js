import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSshTelemetry, SSH_RUN_OP } from './sshTelemetry.js';
import { createMetricAggregator } from './telemetry-metrics.cjs';
import { createRequire } from 'node:module';

// WARDEN-1578 — the ssh-run producer. Mirrors fileExistsTelemetry.test.js: fake
// consent / captured send / fake aggregator clock — no timers, no IPC.
const OP_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/; // web/src/lib/telemetry/schema.ts OPERATION_NAME_RE
const { SCHEMA_VERSION } = createRequire(import.meta.url)('../electron/telemetry-source.cjs');
const { TELEMETRY_CATEGORY_IDS } = createRequire(import.meta.url)('./telemetry-consent.cjs');

function makeHarness({ enabled = true } = {}) {
  const sent = [];
  let on = enabled;
  const tel = createSshTelemetry({
    consent: () => on,
    send: (snapshot) => sent.push(snapshot),
    aggregator: createMetricAggregator({ now: () => 0 }),
  });
  return { tel, sent, flip: (v) => { on = v; } };
}

describe('createSshTelemetry', () => {
  it('consent off: nothing retained, flush sends nothing and drops the window', () => {
    const { tel, sent, flip } = makeHarness({ enabled: false });
    assert.equal(tel.recordRun(12, true), false);
    assert.equal(tel.flushNow(), null);
    assert.deepEqual(sent, []);
    // Flip on afterwards: the earlier (refused) observation must not resurface.
    flip(true);
    assert.equal(tel.flushNow(), null);
    assert.deepEqual(sent, []);
  });

  it('a mid-window consent flip drops the window instead of sending it', () => {
    const { tel, sent, flip } = makeHarness({ enabled: true });
    assert.equal(tel.recordRun(5, true), true);
    flip(false);
    assert.equal(tel.flushNow(), null);
    assert.deepEqual(sent, []);
    flip(true);
    assert.equal(tel.flushNow(), null, 'the dropped window must not come back');
  });

  it('consent on: one window carrying exactly ssh-run with folded count/okCount/failCount', () => {
    const { tel, sent } = makeHarness();
    tel.recordRun(10, true);
    tel.recordRun(20, true);
    tel.recordRun(300, false);
    const snap = tel.flushNow();
    assert.ok(snap);
    assert.equal(sent.length, 1);
    assert.deepEqual(snap.operations.map((o) => o.operation), ['ssh-run']);
    const op = snap.operations[0];
    assert.equal(op.count, 3);
    assert.equal(op.okCount, 2);
    assert.equal(op.failCount, 1);
  });

  it('an idle window is not sent', () => {
    const { tel, sent } = makeHarness();
    assert.equal(tel.flushNow(), null);
    assert.deepEqual(sent, []);
  });

  it('the operation key is a frozen-const kebab name that passes OPERATION_NAME_RE', () => {
    assert.equal(SSH_RUN_OP, 'ssh-run');
    assert.match(SSH_RUN_OP, OP_NAME_RE);
  });

  it('no host/command/stderr string can appear in the serialized snapshot', () => {
    const { tel } = makeHarness();
    // The recorder's surface is (ms, ok) only; extra args are ignored.
    tel.recordRun(7, true, 'secret-host.example.com', 'git push --force', 'Permission denied');
    const json = JSON.stringify(tel.flushNow());
    for (const needle of ['secret-host', 'example.com', 'git push', 'Permission denied']) {
      assert.equal(json.includes(needle), false, needle);
    }
  });

  it('never throws on corrupt input', () => {
    const { tel } = makeHarness();
    assert.doesNotThrow(() => tel.recordRun(undefined, undefined));
    assert.doesNotThrow(() => tel.recordRun('x', null));
  });

  it('SCHEMA_VERSION and the consent categories are unchanged', () => {
    assert.equal(SCHEMA_VERSION, 11);
    assert.deepEqual([...TELEMETRY_CATEGORY_IDS], ['incidents', 'names', 'operational-metrics', 'feature-adoption']);
    assert.ok(TELEMETRY_CATEGORY_IDS.includes('operational-metrics'));
  });
});
