import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServerTelemetry } from './serverTelemetry.js';
import { setInputAckObserver, setCompanionRpcObserver, CompanionChannel, CompanionAttachSession } from './companion.js';
import { setSshRunObserver, run as sshRun } from './ssh.js';

/**
 * Unit spec for createServerTelemetry (WARDEN-1920) — the server child's
 * telemetry wiring that WARDEN-1916 moved out of server.js. It is called
 * DIRECTLY with a fake app / live-mutated cfg / fake chat catalog, so the
 * pieces no real-server suite can reach are observable: the process-memory
 * source's read() lambda (rss / heapUsed / uptime-ms), the per-category consent
 * routing and IPC message types, and the three module-level observer hooks.
 */

const sent = [];
let hadSend;
let origSend;
let origMemoryUsage;
let origUptime;
let origSetInterval;
let timers;

beforeEach(() => {
  sent.length = 0;
  hadSend = Object.hasOwn(process, 'send');
  origSend = process.send;
  process.send = (msg) => { sent.push(msg); };
  origMemoryUsage = process.memoryUsage;
  origUptime = process.uptime;
  origSetInterval = globalThis.setInterval;
  timers = [];
});

afterEach(() => {
  if (hadSend) process.send = origSend; else delete process.send;
  process.memoryUsage = origMemoryUsage;
  process.uptime = origUptime;
  globalThis.setInterval = origSetInterval;
  for (const t of timers) clearInterval(t);
  setInputAckObserver(null);
  setSshRunObserver(null);
  setCompanionRpcObserver(null);
});

const fakeApp = (paths = []) => ({ router: { stack: paths.map((p) => ({ route: { path: p } })) } });
const fakeCatalog = (names = []) => ({ snapshot: () => names.map((name) => ({ name, host: 'h', cwd: '/x' })) });

function build({ cfg = {}, app = fakeApp(), catalog = fakeCatalog() } = {}) {
  return createServerTelemetry({ app, cfg, chatCatalog: catalog });
}

function stubProcess({ rss = 111_000_000, heapUsed = 22_000_000, heapTotal = 33_000_000, external = 44_000_000, uptime = 123.4567 } = {}) {
  process.memoryUsage = () => ({ rss, heapUsed, heapTotal, external, arrayBuffers: 5 });
  process.uptime = () => uptime;
}

const fakeTransport = (handler) => {
  let lineCB = null;
  return {
    write(line) {
      const resp = handler(JSON.parse(line));
      if (resp) setImmediate(() => lineCB(JSON.stringify(resp)));
    },
    onLine(cb) { lineCB = cb; }, onExit() {}, kill() {},
  };
};

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  c.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  c.kill = () => {};
  return c;
}

describe('createServerTelemetry (WARDEN-1920)', () => {
  it('returns exactly the eight producers', () => {
    const t = build();
    assert.deepEqual(Object.keys(t).sort(), [
      'companionRpcTelemetry', 'fileExistsTelemetry', 'paneInputTelemetry', 'requestTelemetry',
      'serverProcessMemory', 'serverStallTelemetry', 'sshTelemetry', 'workspaceNamesTelemetry',
    ]);
  });

  it('process-memory: samples THIS process (rss, heapUsed, uptime in ms) and forwards telemetry-process-memory for runtime server', () => {
    stubProcess();
    const t = build({ cfg: { telemetryOperationalMetricsEnabled: true } });
    assert.equal(t.serverProcessMemory.sampleNow(), 1);
    t.serverProcessMemory.flushNow();
    const msgs = sent.filter((m) => m.type === 'telemetry-process-memory');
    assert.equal(msgs.length, 1);
    assert.equal(sent.length, 1, 'nothing else rides the wire');
    const s = msgs[0].snapshot;
    assert.equal(s.rssMinBytes, 111_000_000);
    assert.equal(s.rssMaxBytes, 111_000_000);
    assert.equal(s.heapUsedMaxBytes, 22_000_000, 'heapUsed, not heapTotal/external');
    assert.equal(s.processAgeMs, 123_457, 'uptime seconds converted to ms');
    assert.equal(s.samples, 1);
  });

  it('process-memory: consent is read LIVE from cfg — off stops sampling and discards the window, on resumes', () => {
    stubProcess();
    const cfg = { telemetryOperationalMetricsEnabled: true };
    const t = build({ cfg });
    assert.equal(t.serverProcessMemory.sampleNow(), 1);
    cfg.telemetryOperationalMetricsEnabled = false;
    assert.equal(t.serverProcessMemory.sampleNow(), 0);
    t.serverProcessMemory.flushNow();
    assert.deepEqual(sent, [], 'window closed out-of-consent is discarded, never sent');
    cfg.telemetryOperationalMetricsEnabled = true;
    assert.equal(t.serverProcessMemory.sampleNow(), 1);
    t.serverProcessMemory.flushNow();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].snapshot.samples, 1, 'only the post-resume sample is in the window');
  });

  it('process-memory: off by default; names or incidents consent alone does not enable it', () => {
    stubProcess();
    for (const cfg of [{}, { telemetryNamesEnabled: true }, { telemetryIncidentsEnabled: true }]) {
      const t = build({ cfg });
      assert.equal(t.serverProcessMemory.sampleNow(), 0, JSON.stringify(cfg));
      t.serverProcessMemory.flushNow();
    }
    assert.equal(sent.filter((m) => m.type === 'telemetry-process-memory').length, 0);
  });

  it('standalone (no process.send): flushNow does not throw', () => {
    stubProcess();
    delete process.send;
    const t = build({ cfg: { telemetryOperationalMetricsEnabled: true } });
    t.serverProcessMemory.sampleNow();
    assert.doesNotThrow(() => t.serverProcessMemory.flushNow());
  });

  it('arms nine unref-able timers at construction (eight at 5 min, one 30 s sampler)', () => {
    const armed = [];
    globalThis.setInterval = (fn, ms, ...rest) => {
      const t = origSetInterval(fn, ms, ...rest);
      timers.push(t);
      armed.push(ms);
      return t;
    };
    build();
    assert.equal(armed.length, 9);
    assert.equal(armed.filter((ms) => ms === 5 * 60_000).length, 8);
    assert.equal(armed.filter((ms) => ms === 30_000).length, 1);
  });

  it('input-ack hook: real CompanionAttachSession.write() acks fold into companion-input-ack (ok and failed)', async () => {
    const t = build({ cfg: { telemetryOperationalMetricsEnabled: true } });
    let n = 0;
    const channel = new CompanionChannel('h', fakeTransport((r) => {
      n += 1;
      return n === 1 ? { id: r.id, ok: true, result: {} } : { id: r.id, ok: false, error: 'nope' };
    }));
    const session = new CompanionAttachSession('h', null);
    session._channel = channel;
    session.sid = 's1';
    session.write('a');
    session.write('b');
    await new Promise((r) => setTimeout(r, 30));
    t.paneInputTelemetry.flushNow();
    const msg = sent.find((m) => m.type === 'telemetry-metrics');
    assert.ok(msg, 'forwarded as telemetry-metrics');
    const op = msg.snapshot.operations.find((o) => o.operation === 'companion-input-ack');
    assert.ok(op);
    assert.equal(op.count, 2);
    assert.equal(op.okCount, 1);
    assert.equal(op.failCount, 1);
  });

  it('input-ack hook: nothing folds while consent is off', async () => {
    const t = build({ cfg: {} });
    const channel = new CompanionChannel('h', fakeTransport((r) => ({ id: r.id, ok: true, result: {} })));
    const session = new CompanionAttachSession('h', null);
    session._channel = channel;
    session.sid = 's1';
    session.write('a');
    await new Promise((r) => setTimeout(r, 20));
    t.paneInputTelemetry.flushNow();
    assert.deepEqual(sent, []);
  });

  it('names producer: gated on the names category alone, reads chatCatalog.snapshot(), forwards telemetry-names', () => {
    const catalog = fakeCatalog(['alpha', 'beta']);
    const cfg = { telemetryOperationalMetricsEnabled: true, telemetryIncidentsEnabled: true };
    const t = build({ cfg, catalog });
    t.workspaceNamesTelemetry.flushNow();
    assert.deepEqual(sent, [], 'other categories do not enable names');
    cfg.telemetryNamesEnabled = true;
    t.workspaceNamesTelemetry.flushNow();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'telemetry-names');
    assert.deepEqual(sent[0].snapshot.chats, ['alpha', 'beta']);
    assert.equal(sent[0].snapshot.chatCount, 2);
  });

  it('stall producer: gated on incidents alone, forwards telemetry-stalls, culprit key from the LIVE route table', () => {
    const app = fakeApp(['/api']);
    const cfg = { telemetryOperationalMetricsEnabled: true, telemetryNamesEnabled: true };
    const t = build({ cfg, app });
    const stall = () => ({
      type: 'performance-stall', runtime: 'server', source: 'event-loop',
      timestamp: new Date().toISOString(), lagMs: 4200, heartbeatMs: 1000, thresholdMs: 1000,
      attribution: [{ label: 'GET /api/zebra-probe', overlapMs: 4100, open: true, durationMs: 4300 }],
      syncTotals: [],
    });
    assert.equal(t.serverStallTelemetry.recordStall(stall()), false, 'incidents off → refused');
    cfg.telemetryIncidentsEnabled = true;
    // The route table is mutated AFTER construction: knownSegments is a live thunk.
    app.router.stack.push({ route: { path: '/api/zebra-probe' } });
    assert.notEqual(t.serverStallTelemetry.recordStall(stall()), false);
    t.serverStallTelemetry.flushNow();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'telemetry-stalls');
    assert.deepEqual(sent[0].snapshot.culprits.map((c) => c.culprit), ['get-api-zebra-probe']);
  });

  it('ssh-run hook: a real ssh.run() settle folds ssh-run ok; a connect-refused run folds failCount', async () => {
    const t = build({ cfg: { telemetryOperationalMetricsEnabled: true } });
    let child;
    let p = sshRun('some-host', 'true', { spawn: () => { child = fakeChild(); return child; }, timeout: 60000 });
    child.emit('close', 0);
    await p;
    p = sshRun('some-host', 'true', { spawn: () => { child = fakeChild(); return child; }, timeout: 60000 });
    child.stderr.emit('data', 'ssh: connect to host some-host port 22: Connection refused');
    child.emit('close', 255);
    await p;
    t.sshTelemetry.flushNow();
    const op = sent.find((m) => m.type === 'telemetry-metrics').snapshot.operations.find((o) => o.operation === 'ssh-run');
    assert.ok(op);
    assert.equal(op.count, 2);
    assert.equal(op.okCount, 1);
    assert.equal(op.failCount, 1);
  });

  it('companion-rpc hook: a real CompanionChannel.call folds companion-rpc-exec ok; a timeout folds failCount', async () => {
    const t = build({ cfg: { telemetryOperationalMetricsEnabled: true } });
    const ok = new CompanionChannel('h', fakeTransport((r) => ({ id: r.id, ok: true, result: {} })));
    await ok.call('exec', { cmd: 'x' }, { timeout: 500 });
    const silent = new CompanionChannel('h', fakeTransport(() => null));
    await assert.rejects(silent.call('exec', { cmd: 'x' }, { timeout: 20 }));
    t.companionRpcTelemetry.flushNow();
    const op = sent.find((m) => m.type === 'telemetry-metrics').snapshot.operations.find((o) => o.operation === 'companion-rpc-exec');
    assert.ok(op);
    assert.equal(op.count, 2);
    assert.equal(op.okCount, 1);
    assert.equal(op.failCount, 1);
  });
});
