// Tests for the browser-side singleton wiring of web/src/lib/paneLatency.ts —
// getPaneLatencySampler (WARDEN-2088).
//
// web/pane-latency.test.mjs pins the pure core (createPaneLatencySampler) and
// its header states the browser-side singleton wiring is deliberately NOT
// exercised there (no DOM). This file pins that other half — the wiring the
// renderer exercises wherever a pane mounts, via
// `getPaneLatencySampler((snap) => forwardPaneMetrics(snap))` (two call sites
// in web/src/components/PaneTile.tsx):
//
//   • the build-once guard — a second call returns the SAME object and arms
//     exactly one interval and one longtask observer (a regression here
//     double-arms timers on every PaneTile mount and burns a browser tab's
//     timer budget);
//   • the transport gate — with a transport: one interval at
//     PANE_LATENCY_FLUSH_MS (5 min) + pagehide + the longtask observer;
//     without one (plain browser tab): pagehide + observer but NO interval,
//     and nothing is ever shipped;
//   • the flush contract — the interval tick ships the folded window and
//     resets it (a second tick ships nothing), pagehide flushes the in-flight
//     window, and an idle window (zero observations) is never sent on either;
//   • isolation — a throwing transport never escapes the interval or the
//     pagehide handler, and a throwing PerformanceObserver (Safari / old
//     engines) leaves the interval and pagehide armed;
//   • the facade — noteInput/frame drive the shared sampler the singleton
//     exposes;
//   • the no-window path — under node --test / SSR the singleton is a usable
//     facade and arms nothing.
//
// node --test has no DOM, so this file stubs window / setInterval /
// PerformanceObserver on globalThis around each call (the module reads them at
// CALL time, not import time). The module itself is loaded ONCE (the
// transformWithOxc loader below, same harness as pane-latency.test.mjs);
// __resetPaneLatencySingletonForTests — the module's own test seam — clears
// the singleton between tests.
//
// The stubbed PerformanceObserver.supportedEntryTypes deliberately omits
// 'long-animation-frame', so the LoAF registration (its own separately
// guarded contract, covered by pane-latency.test.mjs) stays inert here and
// observer counts stay at exactly one per build.
//
// Run: node --test paneLatencySingleton.test.mjs   (from web/)

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libPath = resolve(__dirname, 'src/lib/paneLatency.ts');

// --- Load the REAL paneLatency.ts once (TS -> ESM via the OXC transform Vite bundles)
const src = readFileSync(libPath, 'utf8');
const { code } = await transformWithOxc(src, libPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-panelatency-singleton-test-'));
const tmpFile = join(tmpDir, 'paneLatency.mjs');
writeFileSync(tmpFile, code);
const mod = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });
const {
  getPaneLatencySampler,
  __resetPaneLatencySingletonForTests,
  PANE_LATENCY_FLUSH_MS,
  PANE_LATENCY_OPS,
} = mod;

// --- Harness: per-test browser-ish globals -------------------------------
// paneLatency.ts reads window / setInterval / PerformanceObserver at CALL
// time, so stubbing globalThis per test is enough. The singleton itself is
// module state: reset it between tests via the module's own seam.

const REAL_SET_INTERVAL = globalThis.setInterval;

function stubGlobals({ transportThrows = false, observerThrows = false } = {}) {
  const pageListeners = {};
  const addEventListenerCalls = [];
  globalThis.window = {
    addEventListener(type, fn) {
      addEventListenerCalls.push(type);
      pageListeners[type] = fn;
    },
  };
  const intervals = [];
  globalThis.setInterval = (fn, ms) => {
    const handle = { fn, ms };
    intervals.push(handle);
    return handle;
  };
  const observers = [];
  class PerformanceObserver {
    constructor(cb) {
      if (observerThrows) throw new Error('PerformanceObserver unsupported');
      this.cb = cb;
      observers.push(this);
    }
    observe(opts) { this.observedType = opts?.type; }
    disconnect() {}
    takeRecords() { return []; }
  }
  // NOT including 'long-animation-frame' — see the header note.
  PerformanceObserver.supportedEntryTypes = ['longtask'];
  globalThis.PerformanceObserver = PerformanceObserver;
  const shipments = [];
  const transport = (snap) => {
    if (transportThrows) throw new Error('bridge exploded');
    shipments.push(snap);
  };
  const fire = (type) => pageListeners[type]?.();
  return { intervals, observers, shipments, transport, addEventListenerCalls, fire };
}

// Drive ONE real observation through the facade, so the pending window is
// non-idle (an e2e echo folds at frame arrival, a paint leg in the callback).
function noteOneEcho(singleton) {
  singleton.noteInput('p1');
  singleton.frame('p1')?.painted();
}

const opOf = (window, name) => window.operations.find((o) => o.operation === name);

afterEach(() => {
  __resetPaneLatencySingletonForTests();
  globalThis.setInterval = REAL_SET_INTERVAL;
  delete globalThis.window;
  delete globalThis.PerformanceObserver;
});

test('build-once: a second call returns the same singleton, arming exactly one interval and one longtask observer', () => {
  const h = stubGlobals();
  const first = getPaneLatencySampler(h.transport);
  const second = getPaneLatencySampler(() => {}); // PaneTile's other call site passes a transport again
  assert.strictEqual(second, first, 'the singleton is returned unchanged — the later transport is ignored');
  assert.equal(h.intervals.length, 1, 'exactly one flush interval across both calls');
  assert.equal(h.observers.length, 1, 'exactly one longtask observer across both calls');
  assert.deepEqual(h.addEventListenerCalls, ['pagehide'], 'exactly one pagehide listener');
});

test('with a transport: one flush interval at the 5-minute beat, a pagehide listener, and the longtask observer', () => {
  const h = stubGlobals();
  getPaneLatencySampler(h.transport);
  assert.equal(PANE_LATENCY_FLUSH_MS, 300_000, 'the constant is the 5-minute beat');
  assert.equal(h.intervals.length, 1, 'one flush interval armed');
  assert.equal(h.intervals[0].ms, PANE_LATENCY_FLUSH_MS, 'the interval flushes on that shared beat');
  assert.deepEqual(h.addEventListenerCalls, ['pagehide'], 'the mid-window pagehide flush is armed');
  assert.equal(h.observers.length, 1, 'one longtask observer armed');
  assert.equal(h.observers[0].observedType, 'longtask', 'the observer watches longtask entries');
});

test('without a transport: pagehide and the observer arm, no interval — nothing ships even on teardown', () => {
  const h = stubGlobals();
  const singleton = getPaneLatencySampler(); // plain browser tab: no bridge
  noteOneEcho(singleton);
  assert.equal(h.intervals.length, 0, 'no timer is burned without a transport');
  assert.deepEqual(h.addEventListenerCalls, ['pagehide']);
  assert.equal(h.observers.length, 1);
  h.fire('pagehide');
  assert.equal(h.shipments.length, 0, 'there is no transport, so nothing is shipped');
  const snap = singleton.sampler.snapshot();
  assert.equal(opOf(snap, PANE_LATENCY_OPS.E2E).count, 0, 'pagehide still closed and reset the window');
});

test('the interval tick ships the folded window and resets it; the next tick ships nothing', () => {
  const h = stubGlobals();
  const singleton = getPaneLatencySampler(h.transport);
  noteOneEcho(singleton);
  h.intervals[0].fn();
  assert.equal(h.shipments.length, 1, 'the first tick ships one window');
  assert.equal(opOf(h.shipments[0], PANE_LATENCY_OPS.E2E).count, 1, 'the folded echo rides the shipped window');
  h.intervals[0].fn();
  assert.equal(h.shipments.length, 1, 'the idle second tick ships nothing — flush reset the window');
});

test('an idle window (zero observations) is never shipped, on the interval or on pagehide', () => {
  const h = stubGlobals();
  getPaneLatencySampler(h.transport);
  h.intervals[0].fn();
  assert.equal(h.shipments.length, 0, 'a zero-count window is not worth a tick shipment');
  h.fire('pagehide');
  assert.equal(h.shipments.length, 0, 'a zero-count window is not worth a teardown shipment');
});

test('pagehide flushes the in-flight window and resets the sampler', () => {
  const h = stubGlobals();
  const singleton = getPaneLatencySampler(h.transport);
  noteOneEcho(singleton);
  h.fire('pagehide');
  assert.equal(h.shipments.length, 1, 'teardown ships the in-flight window');
  assert.equal(opOf(h.shipments[0], PANE_LATENCY_OPS.E2E).count, 1, 'the lag evidence survives the close');
  const snap = singleton.sampler.snapshot();
  assert.equal(opOf(snap, PANE_LATENCY_OPS.E2E).count, 0, 'the flush also reset the sampler');
});

test('a throwing transport never escapes the interval or the pagehide handler', () => {
  const h = stubGlobals({ transportThrows: true });
  const singleton = getPaneLatencySampler(h.transport);
  noteOneEcho(singleton);
  assert.doesNotThrow(() => h.intervals[0].fn(), 'a bridge failure must not kill the flush tick');
  assert.doesNotThrow(() => h.fire('pagehide'), 'a bridge failure must not break teardown');
  assert.equal(h.intervals.length, 1, 'the interval survives to flush again later');
});

test('the singleton facade noteInput/frame drive the shared sampler it exposes', () => {
  const h = stubGlobals();
  const singleton = getPaneLatencySampler(h.transport);
  singleton.noteInput('p1');
  const f = singleton.frame('p1');
  assert.ok(f, 'a pending input yields a frame handle');
  f.painted();
  assert.equal(singleton.frame('p1'), null, 'the pending entry was consumed');
  const snap = singleton.sampler.snapshot();
  assert.equal(opOf(snap, PANE_LATENCY_OPS.E2E).count, 1, 'facade calls folded into the shared sampler');
  assert.equal(opOf(snap, PANE_LATENCY_OPS.PAINT).count, 1, 'painted() folded the paint leg');
});

test('no window (node --test / SSR): a usable sampler, nothing armed, nothing shipped', () => {
  delete globalThis.window;
  delete globalThis.PerformanceObserver;
  const intervals = [];
  globalThis.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
  const shipments = [];
  const singleton = getPaneLatencySampler((snap) => shipments.push(snap));
  noteOneEcho(singleton);
  assert.equal(intervals.length, 0, 'no timer armed without a window');
  assert.equal(shipments.length, 0, 'no window means no flush trigger, so nothing ships');
  const snap = singleton.sampler.snapshot();
  assert.equal(opOf(snap, PANE_LATENCY_OPS.E2E).count, 1, 'the facade still measures');
});

test('a throwing PerformanceObserver (Safari / old engines) leaves the interval and pagehide armed', () => {
  const h = stubGlobals({ observerThrows: true });
  let singleton;
  assert.doesNotThrow(() => { singleton = getPaneLatencySampler(h.transport); }, 'observer absence must not break the wiring');
  assert.equal(h.intervals.length, 1, 'the flush interval still stands');
  assert.deepEqual(h.addEventListenerCalls, ['pagehide'], 'the pagehide flush still stands');
  noteOneEcho(singleton);
  h.intervals[0].fn();
  assert.equal(h.shipments.length, 1, 'the surviving interval still flushes end to end');
});
