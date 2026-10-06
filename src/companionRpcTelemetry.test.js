import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createCompanionRpcTelemetry, COMPANION_RPC_OPS } from './companionRpcTelemetry.js';
import { createMetricAggregator } from './telemetry-metrics.cjs';
import { CompanionChannel, CompanionRpcError, CompanionTransportError, setCompanionRpcObserver } from './companion.js';

// WARDEN-1598 — per-RPC companion telemetry: the producer (closed table, consent)
// and the CompanionChannel.call() seam (ok/fail classification, exclusions).
const OP_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const { TELEMETRY_CATEGORY_IDS } = createRequire(import.meta.url)('./telemetry-consent.cjs');
void TELEMETRY_CATEGORY_IDS;

function makeHarness({ enabled = true } = {}) {
  const sent = [];
  let on = enabled;
  const tel = createCompanionRpcTelemetry({
    consent: () => on,
    send: (snapshot) => sent.push(snapshot),
    aggregator: createMetricAggregator({ now: () => 0 }),
  });
  return { tel, sent, flip: (v) => { on = v; } };
}

function fakeTransport(handler) {
  let lineCB = null; let exitCb = null;
  return {
    write(line) {
      let resp = null;
      try { resp = handler(JSON.parse(line)); } catch { /* swallow */ }
      if (resp) setImmediate(() => { if (lineCB) lineCB(JSON.stringify(resp)); });
    },
    onLine(cb) { lineCB = cb; },
    onExit(cb) { exitCb = cb; },
    kill() {},
    _die(err) { if (exitCb) exitCb(err); },
  };
}

describe('closed operation table', () => {
  it('has the 15 expected names, all kebab and distinct', () => {
    const names = Object.values(COMPANION_RPC_OPS);
    assert.equal(names.length, 15);
    assert.equal(new Set(names).size, 15);
    for (const n of names) assert.match(n, OP_NAME_RE);
    assert.ok(!('ping' in COMPANION_RPC_OPS));
    assert.ok(!('attachInput' in COMPANION_RPC_OPS));
  });
});

describe('createCompanionRpcTelemetry', () => {
  it('folds each closed method under its constant name with ok/fail counts', () => {
    const { tel, sent } = makeHarness();
    tel.recordRpc('discover', 10, true);
    tel.recordRpc('discover', 20, true);
    tel.recordRpc('discover', 30000, false);
    tel.recordRpc('capturePanes', 5, true);
    const snap = tel.flushNow();
    assert.ok(snap);
    assert.equal(sent.length, 1);
    const by = Object.fromEntries(snap.operations.map((o) => [o.operation, o]));
    assert.deepEqual(Object.keys(by).sort(), ['companion-rpc-capture-panes', 'companion-rpc-discover']);
    assert.equal(by['companion-rpc-discover'].count, 3);
    assert.equal(by['companion-rpc-discover'].okCount, 2);
    assert.equal(by['companion-rpc-discover'].failCount, 1);
  });

  it('every closed method folds under its table name', () => {
    const { tel } = makeHarness();
    for (const m of Object.keys(COMPANION_RPC_OPS)) assert.equal(tel.recordRpc(m, 1, true), true, m);
    const snap = tel.flushNow();
    assert.deepEqual(snap.operations.map((o) => o.operation).sort(), Object.values(COMPANION_RPC_OPS).sort());
  });

  it('a method outside the table is DROPPED, never folded under its raw string', () => {
    const { tel } = makeHarness();
    for (const m of ['ping', 'attachInput', 'secretMethod', '__proto__', 'toString', 'constructor', '', undefined, null, 42]) {
      assert.equal(tel.recordRpc(m, 5, true), false, String(m));
    }
    assert.equal(tel.flushNow(), null);
  });

  it('consent off: nothing retained; flip on does not resurface it', () => {
    const { tel, sent, flip } = makeHarness({ enabled: false });
    assert.equal(tel.recordRpc('discover', 5, true), false);
    assert.equal(tel.flushNow(), null);
    flip(true);
    assert.equal(tel.flushNow(), null);
    assert.deepEqual(sent, []);
  });

  it('a mid-window consent flip drops the window', () => {
    const { tel, sent, flip } = makeHarness();
    assert.equal(tel.recordRpc('exec', 5, true), true);
    flip(false);
    assert.equal(tel.flushNow(), null);
    flip(true);
    assert.equal(tel.flushNow(), null);
    assert.deepEqual(sent, []);
  });

  it('an idle window is not sent', () => {
    const { tel, sent } = makeHarness();
    assert.equal(tel.flushNow(), null);
    assert.deepEqual(sent, []);
  });

  it('extra args (host, payload, error text) never reach the serialized snapshot', () => {
    const { tel } = makeHarness();
    tel.recordRpc('exec', 7, true, 'secret-host.example.com', { cmd: 'git push --force' }, 'Permission denied');
    const json = JSON.stringify(tel.flushNow());
    for (const needle of ['secret-host', 'example.com', 'git push', 'Permission denied']) {
      assert.equal(json.includes(needle), false, needle);
    }
  });
});

describe('CompanionChannel.call() → observer seam', () => {
  afterEach(() => setCompanionRpcObserver(null));

  function observe() {
    const seen = [];
    setCompanionRpcObserver((method, ms, ok) => seen.push({ method, ms, ok }));
    return seen;
  }

  it('host-side ok:true folds ok:true with a non-negative duration', async () => {
    const seen = observe();
    const ch = new CompanionChannel('h', fakeTransport((r) => ({ id: r.id, ok: true, result: 1 })));
    assert.equal(await ch.call('discover', {}, { timeout: 500 }), 1);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, 'discover');
    assert.equal(seen[0].ok, true);
    assert.ok(seen[0].ms >= 0);
  });

  it('a host-side ok:false (CompanionRpcError) is a COMMAND RESULT: folds ok:true, still rejects', async () => {
    const seen = observe();
    const ch = new CompanionChannel('h', fakeTransport((r) => ({ id: r.id, ok: false, error: 'no docker' })));
    await assert.rejects(() => ch.call('discover', {}, { timeout: 500 }), CompanionRpcError);
    assert.deepEqual(seen.map((s) => [s.method, s.ok]), [['discover', true]]);
  });

  it('timeout folds ok:false at ~its timeout value', async () => {
    const seen = observe();
    const ch = new CompanionChannel('h', fakeTransport(() => null));
    await assert.rejects(() => ch.call('capturePanes', {}, { timeout: 60 }), CompanionTransportError);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].ok, false);
    assert.ok(seen[0].ms >= 50, `duration ${seen[0].ms} should be about the timeout`);
  });

  it('dead channel folds ok:false', async () => {
    const seen = observe();
    const t = fakeTransport(() => null);
    const ch = new CompanionChannel('h', t);
    t._die(new Error('gone'));
    await assert.rejects(() => ch.call('hasSession', {}, { timeout: 500 }), CompanionTransportError);
    assert.deepEqual(seen.map((s) => [s.method, s.ok]), [['hasSession', false]]);
  });

  it('write throw folds ok:false', async () => {
    const seen = observe();
    const t = fakeTransport(() => null);
    t.write = () => { throw new Error('EPIPE'); };
    const ch = new CompanionChannel('h', t);
    await assert.rejects(() => ch.call('send', {}, { timeout: 500 }), CompanionTransportError);
    assert.deepEqual(seen.map((s) => [s.method, s.ok]), [['send', false]]);
  });

  it('ping and attachInput are never observed', async () => {
    const seen = observe();
    const ch = new CompanionChannel('h', fakeTransport((r) => ({ id: r.id, ok: true, result: 1 })));
    await ch.call('ping', {}, { timeout: 500 });
    await ch.call('attachInput', {}, { timeout: 500 });
    assert.deepEqual(seen, []);
  });

  it('an observer that throws never changes the result or the rejection', async () => {
    setCompanionRpcObserver(() => { throw new Error('observer bug'); });
    const okCh = new CompanionChannel('h', fakeTransport((r) => ({ id: r.id, ok: true, result: { a: 1 } })));
    assert.deepEqual(await okCh.call('discover', {}, { timeout: 500 }), { a: 1 });
    const badCh = new CompanionChannel('h', fakeTransport((r) => ({ id: r.id, ok: false, error: 'boom' })));
    await assert.rejects(() => badCh.call('discover', {}, { timeout: 500 }), CompanionRpcError);
    const timeoutCh = new CompanionChannel('h', fakeTransport(() => null));
    await assert.rejects(() => timeoutCh.call('discover', {}, { timeout: 30 }), CompanionTransportError);
  });

  it('a non-function observer resets to null (no throw)', async () => {
    setCompanionRpcObserver(() => assert.fail('must not be called'));
    setCompanionRpcObserver('nope');
    const ch = new CompanionChannel('h', fakeTransport((r) => ({ id: r.id, ok: true, result: 1 })));
    assert.equal(await ch.call('discover', {}, { timeout: 500 }), 1);
  });

  it('end-to-end: observer wired to the producer folds ok/fail per method', async () => {
    const { tel } = makeHarness();
    setCompanionRpcObserver((m, ms, ok) => tel.recordRpc(m, ms, ok));
    const okCh = new CompanionChannel('h', fakeTransport((r) => ({ id: r.id, ok: true, result: 1 })));
    await okCh.call('exec', {}, { timeout: 500 });
    await okCh.call('ping', {}, { timeout: 500 });
    const hostFail = new CompanionChannel('h', fakeTransport((r) => ({ id: r.id, ok: false, error: 'x' })));
    await assert.rejects(() => hostFail.call('exec', {}, { timeout: 500 }));
    const slow = new CompanionChannel('h', fakeTransport(() => null));
    await assert.rejects(() => slow.call('exec', {}, { timeout: 30 }));
    const snap = tel.flushNow();
    assert.deepEqual(snap.operations.map((o) => o.operation), ['companion-rpc-exec']);
    const op = snap.operations[0];
    assert.equal(op.count, 3);
    assert.equal(op.okCount, 2);
    assert.equal(op.failCount, 1);
  });
});
