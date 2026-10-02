// Tests for WARDEN-1508 — the `process-memory` window (schema v10):
//   • src/telemetry-process-memory.cjs   — the bounded aggregator + producer
//   • electron/telemetry-process-memory-event.cjs — the two builders
//   • electron/telemetry-process-memory-sources.cjs — the main/renderer sources
//
// Pinned here (main.cjs itself can't be required without Electron — the
// telemetry-shape-event.test.mjs pattern):
//   • BOUNDEDNESS — aggregator footprint is independent of sample count
//     (N = 10 vs N = 10,000 through the public snapshot() surface, the
//     telemetry-metrics.test.mjs invariant);
//   • CONSENT — with operational-metrics OFF a forced sample window records no
//     event: the producer takes no sample and drops the window, AND the receipt
//     (the real createWindowReceipt, consent off) builds/records nothing;
//   • RUNTIME/PRODUCER PAIRING — a `server` event cannot come from the main
//     path, nor a main/renderer event from the server path;
//   • END-TO-END — a REAL producer window builds into an event BOTH validators
//     (canonical schema.ts and the main-process copy) accept;
//   • CARRIER HYGIENE — extra keys, string/negative/float values, min>avg>max
//     all yield null at the builder;
//   • unref'd timers, per-runtime windows.
//
// Run: node --test telemetry-process-memory.test.mjs   (from web/)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformWithOxc } from 'vite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const {
  createMemoryAggregator,
  createProcessMemoryProducer,
  PROCESS_MEMORY_SAMPLE_MS,
  PROCESS_MEMORY_FLUSH_MS,
} = require('../src/telemetry-process-memory.cjs');
const { buildMainProcessMemoryEvent, buildServerProcessMemoryEvent } = require('../electron/telemetry-process-memory-event.cjs');
const { createMainSource, createRendererSource } = require('../electron/telemetry-process-memory-sources.cjs');
const { createWindowReceipt } = require('../electron/telemetry-receipt.cjs');
const { validateBaseEvent: validateMainCopy } = require('../electron/telemetry-source.cjs');

async function loadTs(absPath, tag) {
  const { code } = await transformWithOxc(readFileSync(absPath, 'utf8'), absPath, {});
  const tmpDir = mkdtempSync(join(tmpdir(), `warden-${tag}-`));
  const tmpFile = join(tmpDir, `${tag}.mjs`);
  writeFileSync(tmpFile, code);
  try { return await import(tmpFile); }
  finally { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ } }
}
const schema = await loadTs(join(__dirname, 'src', 'lib', 'telemetry', 'schema.ts'), 'tpm-schema');
const { SCHEMA_VERSION, validateEvent } = schema;

const fakeClock = (start = 1_000) => { let t = start; return () => (t += 1); };
const bothValidate = (e) => validateEvent(e) && validateMainCopy(e);

// ---- shape helpers (structure only, not values) ----------------------------
function shapeOf(value) {
  if (Array.isArray(value)) return value.map(shapeOf);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = shapeOf(value[k]);
    return out;
  }
  return typeof value;
}

// =========================================================================
// Criterion 4 — BOUNDEDNESS
// =========================================================================

function fill(n) {
  const agg = createMemoryAggregator({ now: fakeClock() });
  for (let i = 0; i < n; i += 1) {
    agg.record({ rssBytes: 100_000_000 + ((i * 7919) % 50_000_000), heapUsedBytes: 10_000_000 + (i % 1000), ageMs: i * 30_000 });
  }
  return agg.snapshot();
}

test('aggregator footprint is IDENTICAL in shape at N = 10 vs N = 10,000 (public snapshot surface)', () => {
  const small = fill(10);
  const large = fill(10_000);
  assert.equal(JSON.stringify(shapeOf(small)), JSON.stringify(shapeOf(large)), 'same keys, same leaf types');
  assert.equal(Object.keys(small).length, Object.keys(large).length, 'same number of retained fields');
  assert.equal(small.samples, 10);
  assert.equal(large.samples, 10_000, 'the count DID grow — the aggregator is not a no-op');
  // Nothing in the snapshot is an array: no per-sample row is retained.
  for (const v of Object.values(large)) assert.notEqual(typeof v, 'object');
});

test('min / avg / max are exact over a known fixture; processAge is the last reported age', () => {
  const agg = createMemoryAggregator({ now: fakeClock() });
  for (const [rss, heap, age] of [[300, 50, 1000], [100, 70, 2000], [200, 60, 3000]]) {
    agg.record({ rssBytes: rss, heapUsedBytes: heap, ageMs: age });
  }
  const s = agg.snapshot();
  assert.equal(s.samples, 3);
  assert.equal(s.rssMinBytes, 100);
  assert.equal(s.rssMaxBytes, 300);
  assert.equal(s.rssAvgBytes, 200);
  assert.equal(s.heapUsedMaxBytes, 70);
  assert.equal(s.processAgeMs, 3000);
});

test('heapUsedMaxBytes is OMITTED (not 0/null) when no sample carried a heap; corrupt samples are dropped', () => {
  const agg = createMemoryAggregator({ now: fakeClock() });
  assert.equal(agg.record({ rssBytes: 100, ageMs: 5 }), true);
  assert.equal('heapUsedMaxBytes' in agg.snapshot(), false);
  for (const bad of [-1, 1.5, NaN, '10', null, undefined]) {
    assert.equal(agg.record({ rssBytes: bad, ageMs: 1 }), false, `rss ${bad} dropped`);
  }
  assert.equal(agg.record({ rssBytes: 1, heapUsedBytes: -3, ageMs: 1 }), false, 'a negative heap drops the sample');
  assert.equal(agg.snapshot().samples, 1, 'only the one good sample folded');
});

test('flush closes the window and starts a fresh one', () => {
  const agg = createMemoryAggregator({ now: fakeClock() });
  agg.record({ rssBytes: 500, ageMs: 10 });
  const closed = agg.flush();
  assert.equal(closed.samples, 1);
  const next = agg.snapshot();
  assert.equal(next.samples, 0);
  assert.ok(next.startedAt >= closed.endedAt, 'the next window opens where the last closed');
});

// =========================================================================
// Producer: cadence, per-runtime windows, unref
// =========================================================================

test('cadence: ~30s sampling, 5-minute window (≈10 samples per window)', () => {
  assert.equal(PROCESS_MEMORY_SAMPLE_MS, 30_000);
  assert.equal(PROCESS_MEMORY_FLUSH_MS, 300_000);
  assert.equal(PROCESS_MEMORY_FLUSH_MS / PROCESS_MEMORY_SAMPLE_MS, 10);
});

function harness({ consentOn = true } = {}) {
  const sent = [];
  const state = { consent: consentOn, reads: 0 };
  const sources = ['main', 'renderer', 'server'].map((runtime, i) => ({
    runtime,
    read: () => { state.reads += 1; return { rssBytes: (i + 1) * 100_000_000, heapUsedBytes: runtime === 'renderer' ? undefined : 1000 * (i + 1), ageMs: 60_000 * (i + 1) }; },
  }));
  const timers = [];
  const producer = createProcessMemoryProducer({
    sources,
    consent: () => state.consent,
    send: (runtime, snapshot) => sent.push({ runtime, snapshot }),
    now: fakeClock(),
    setIntervalImpl: (fn, ms) => { const t = { fn, ms, unrefd: false, unref() { this.unrefd = true; } }; timers.push(t); return t; },
  });
  return { producer, sent, state, timers };
}

test('consent ON: ten samples fold into ONE window per runtime — three events, one per runtime', () => {
  const h = harness();
  for (let i = 0; i < 10; i += 1) h.producer.sampleNow();
  const sent = h.producer.flushNow();
  assert.deepEqual(sent.map((s) => s.runtime).sort(), ['main', 'renderer', 'server']);
  assert.equal(h.sent.length, 3);
  for (const { snapshot } of h.sent) assert.equal(snapshot.samples, 10);
  // A second flush with no new samples sends nothing (an empty window is never sent).
  assert.equal(h.producer.flushNow().length, 0);
});

test('consent OFF: a forced sample window takes NO sample and records NO event', () => {
  const h = harness({ consentOn: false });
  assert.equal(h.producer.sampleNow(), 0, 'no sample folded');
  assert.equal(h.state.reads, 0, 'the sources were not even read while off');
  assert.deepEqual(h.producer.flushNow(), []);
  assert.equal(h.sent.length, 0);
});

test('consent revoked MID-WINDOW: the window is DISCARDED at flush, never sent (and not leaked into the next)', () => {
  const h = harness();
  for (let i = 0; i < 5; i += 1) h.producer.sampleNow();
  h.state.consent = false;
  assert.deepEqual(h.producer.flushNow(), []);
  assert.equal(h.sent.length, 0);
  h.state.consent = true;
  h.producer.sampleNow();
  h.producer.flushNow();
  assert.equal(h.sent[0].snapshot.samples, 1, 'the next window holds only post-consent samples');
});

test('a throwing source is swallowed (instrumentation never takes the app down); null read folds nothing', () => {
  const producer = createProcessMemoryProducer({
    sources: [
      { runtime: 'main', read: () => { throw new Error('boom'); } },
      { runtime: 'renderer', read: () => null },
      { runtime: 'server', read: () => ({ rssBytes: 5, ageMs: 1 }) },
    ],
    consent: () => true,
    send: () => {},
  });
  assert.equal(producer.sampleNow(), 1, 'only the healthy source folded');
});

test('only an exact `true` consent samples (fail closed)', () => {
  for (const v of [1, 'yes', {}, undefined]) {
    const p = createProcessMemoryProducer({ sources: [{ runtime: 'main', read: () => ({ rssBytes: 1, ageMs: 1 }) }], consent: () => v, send: () => {} });
    assert.equal(p.sampleNow(), 0, `consent ${JSON.stringify(v)} must not sample`);
  }
});

test('start() arms TWO timers (sample + flush), BOTH unref\'d', () => {
  const h = harness();
  const t = h.producer.start();
  assert.equal(t.length, 2);
  assert.deepEqual(h.timers.map((x) => x.ms), [PROCESS_MEMORY_SAMPLE_MS, PROCESS_MEMORY_FLUSH_MS]);
  assert.ok(h.timers.every((x) => x.unrefd), 'a library import must never hang on these timers');
});

test('an unknown runtime / missing read() is refused at construction', () => {
  assert.throws(() => createProcessMemoryProducer({ sources: [{ runtime: 'gpu', read: () => null }] }), TypeError);
  assert.throws(() => createProcessMemoryProducer({ sources: [{ runtime: 'main' }] }), TypeError);
});

// =========================================================================
// Criterion 3 — receipt-side consent refusal (the REAL shared receiver)
// =========================================================================

function receiptHarness(consent) {
  const recorded = [];
  const receive = createWindowReceipt({
    consent: () => consent,
    record: (e) => recorded.push(e),
    schemaVersion: SCHEMA_VERSION,
    labels: () => ({ appVersion: '0.1.86', platform: 'linux' }),
    now: () => 42,
  });
  return { receive, recorded };
}

test('RECEIPT: operational-metrics OFF → a forced window (both paths) records no event', () => {
  const snap = { startedAt: 1, endedAt: 2, samples: 3, rssMinBytes: 1, rssAvgBytes: 2, rssMaxBytes: 3, processAgeMs: 9 };
  const off = receiptHarness({ 'operational-metrics': false });
  assert.equal(off.receive('operational-metrics', buildMainProcessMemoryEvent, snap, { runtime: 'main' }), null);
  assert.equal(off.receive('operational-metrics', buildServerProcessMemoryEvent, snap, { runtime: 'server' }), null);
  assert.deepEqual(off.recorded, []);
  // Non-vacuous: the same harness with consent ON records both.
  const on = receiptHarness({ 'operational-metrics': true });
  assert.ok(on.receive('operational-metrics', buildMainProcessMemoryEvent, snap, { runtime: 'main' }));
  assert.ok(on.receive('operational-metrics', buildServerProcessMemoryEvent, snap, { runtime: 'server' }));
  assert.equal(on.recorded.length, 2);
  assert.ok(on.recorded.every(bothValidate), 'what the receipt records validates under both validators');
});

// =========================================================================
// Criterion 2 — builder hygiene + runtime/producer pairing
// =========================================================================

const SNAP = { startedAt: 1_000, endedAt: 301_000, samples: 10, rssMinBytes: 100, rssAvgBytes: 150, rssMaxBytes: 200, heapUsedMaxBytes: 50, processAgeMs: 123_456 };
const args = (extra = {}) => ({ snapshot: SNAP, schemaVersion: SCHEMA_VERSION, now: () => 7, ...extra });

test('END-TO-END: a REAL producer window builds into an event BOTH validators accept, for each runtime', () => {
  const h = harness();
  for (let i = 0; i < 10; i += 1) h.producer.sampleNow();
  h.producer.flushNow();
  for (const { runtime, snapshot } of h.sent) {
    const build = runtime === 'server' ? buildServerProcessMemoryEvent : buildMainProcessMemoryEvent;
    const e = build({ snapshot, runtime, schemaVersion: SCHEMA_VERSION, appVersion: '0.1.86', platform: 'linux', now: () => 9 });
    assert.ok(e, `${runtime} builds`);
    assert.equal(e.runtime, runtime);
    assert.equal(e.type, 'process-memory');
    assert.equal(validateEvent(e), true, `${runtime}: canonical schema accepts`);
    assert.equal(validateMainCopy(e), true, `${runtime}: main-process copy accepts`);
  }
});

test('the renderer window carries NO heapUsedMaxBytes key and still validates', () => {
  const h = harness();
  h.producer.sampleNow();
  h.producer.flushNow();
  const r = h.sent.find((s) => s.runtime === 'renderer');
  assert.equal('heapUsedMaxBytes' in r.snapshot, false);
  const e = buildMainProcessMemoryEvent({ snapshot: r.snapshot, runtime: 'renderer', schemaVersion: SCHEMA_VERSION, now: () => 1 });
  assert.equal('heapUsedMaxBytes' in e, false);
  assert.equal(bothValidate(e), true);
});

test('RUNTIME/PRODUCER MISMATCH: a `server` event cannot be built by the main path, nor main/renderer by the server path', () => {
  assert.equal(buildMainProcessMemoryEvent(args({ runtime: 'server' })), null, 'main path refuses server');
  for (const rt of ['main', 'renderer']) {
    assert.equal(buildServerProcessMemoryEvent(args({ runtime: rt })), null, `server path refuses ${rt}`);
  }
  for (const rt of ['gpu', undefined, '', 42]) {
    assert.equal(buildMainProcessMemoryEvent(args({ runtime: rt })), null, `unknown runtime ${rt}`);
    assert.equal(buildServerProcessMemoryEvent(args({ runtime: rt })), null, `unknown runtime ${rt}`);
  }
  assert.ok(buildMainProcessMemoryEvent(args({ runtime: 'main' })));
  assert.ok(buildMainProcessMemoryEvent(args({ runtime: 'renderer' })));
  assert.ok(buildServerProcessMemoryEvent(args({ runtime: 'server' })));
});

test('builder rejects: extra key, string field, negative / non-integer count, min>avg, avg>max, empty window', () => {
  const b = (patch) => buildMainProcessMemoryEvent(args({ runtime: 'main', snapshot: { ...SNAP, ...patch } }));
  for (const extra of [{ name: 'x' }, { path: '/p' }, { host: 'h.example.com' }, { pid: 1 }]) {
    assert.equal(b(extra), null, `extra ${Object.keys(extra)[0]}`);
  }
  assert.equal(b({ rssMaxBytes: '200' }), null, 'string field');
  assert.equal(b({ rssMinBytes: -1 }), null, 'negative');
  assert.equal(b({ rssAvgBytes: 150.5 }), null, 'non-integer');
  assert.equal(b({ heapUsedMaxBytes: 1.5 }), null, 'non-integer heap');
  assert.equal(b({ rssMinBytes: 160 }), null, 'min > avg');
  assert.equal(b({ rssAvgBytes: 250 }), null, 'avg > max');
  assert.equal(b({ samples: 0 }), null, 'empty window');
  assert.equal(b({ startedAt: 'now' }), null, 'bad stamp');
  for (const bad of [null, [], 'x', 5]) {
    assert.equal(buildMainProcessMemoryEvent(args({ runtime: 'main', snapshot: bad })), null);
  }
});

test('labels are attached only when supplied', () => {
  const bare = buildMainProcessMemoryEvent(args({ runtime: 'main' }));
  assert.equal('appVersion' in bare, false);
  assert.equal('platform' in bare, false);
  const lab = buildMainProcessMemoryEvent(args({ runtime: 'main', appVersion: '1.2.3', platform: 'darwin' }));
  assert.equal(lab.appVersion, '1.2.3');
  assert.equal(lab.platform, 'darwin');
});

// =========================================================================
// Sources
// =========================================================================

test('main source: process.memoryUsage() rss + heapUsed, uptime in ms', () => {
  const src = createMainSource({ memoryUsage: () => ({ rss: 111, heapUsed: 22 }), uptimeSeconds: () => 12.5 });
  assert.equal(src.runtime, 'main');
  assert.deepEqual(src.read(), { rssBytes: 111, heapUsedBytes: 22, ageMs: 12_500 });
});

test('renderer source: SUMS Tab working sets (KB → bytes), ignores other process types, no heap, oldest Tab age', () => {
  const metrics = [
    { type: 'Browser', memory: { workingSetSize: 999_999 }, creationTime: 0 },
    { type: 'Tab', memory: { workingSetSize: 100 }, creationTime: 9_000 },
    { type: 'Tab', memory: { workingSetSize: 50 }, creationTime: 4_000 },
    { type: 'GPU', memory: { workingSetSize: 999_999 }, creationTime: 0 },
  ];
  const src = createRendererSource({ getAppMetrics: () => metrics, now: () => 10_000 });
  const r = src.read();
  assert.equal(src.runtime, 'renderer');
  assert.equal(r.rssBytes, 150 * 1024);
  assert.equal('heapUsedBytes' in r, false);
  assert.equal(r.ageMs, 6_000);
});

test('renderer source: no Tab process → null (nothing to sample)', () => {
  const src = createRendererSource({ getAppMetrics: () => [{ type: 'Browser', memory: { workingSetSize: 1 } }] });
  assert.equal(src.read(), null);
});

// =========================================================================
// processAgeMs increases within a session and resets across a restart
// =========================================================================

test('processAgeMs grows across windows and resets for a fresh process', () => {
  let uptime = 0;
  const producer = createProcessMemoryProducer({
    sources: [{ runtime: 'server', read: () => ({ rssBytes: 10, ageMs: uptime }) }],
    consent: () => true,
    send: () => {},
  });
  const ages = [];
  for (const u of [300_000, 600_000, 900_000, 5_000]) { // last = restart
    uptime = u;
    producer.sampleNow();
    ages.push(producer.flushNow()[0].snapshot.processAgeMs);
  }
  assert.deepEqual(ages, [300_000, 600_000, 900_000, 5_000]);
});

// =========================================================================
// Wiring guards (source assertions — main.cjs / server.js can't be required)
// =========================================================================

const mainSrc = readFileSync(join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
const serverSrc = readFileSync(join(__dirname, '..', 'src', 'server.js'), 'utf8');

test('wiring: main routes the server IPC message to the server-path receipt and arms the sampler', () => {
  assert.match(mainSrc, /msg\.type === 'telemetry-process-memory'[\s\S]{0,80}recordServerProcessMemoryWindow\(msg\.snapshot\)/);
  assert.match(mainSrc, /processMemoryProducer\.start\(\)/);
  assert.match(mainSrc, /function recordMainProcessMemoryWindow\(snapshot, runtime\) \{\s*receiveTelemetryWindow\('operational-metrics', buildMainProcessMemoryEvent, snapshot, \{ runtime \}\);/);
});

test('wiring: the server child samples ITSELF under operational-metrics and forwards over process.send', () => {
  assert.match(serverSrc, /runtime: 'server'/);
  assert.match(serverSrc, /type: 'telemetry-process-memory', snapshot/);
  assert.match(serverSrc, /serverProcessMemory\.start\(\)/);
  const block = serverSrc.slice(serverSrc.indexOf('const serverProcessMemory'), serverSrc.indexOf('serverProcessMemory.start()'));
  assert.ok(block.includes("resolveConsent(cfg)['operational-metrics'] === true"), 'gated live on operational-metrics');
});
