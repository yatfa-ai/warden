// WARDEN-1468 — tests for electron/telemetry-receipt.cjs (createWindowReceipt),
// the ONE consent-gated "window receipt" the six main.cjs receipts collapse
// onto, PLUS the static source guard for main.cjs's half of the wiring.
//
// WHY THIS FILE EXISTS: `electron/main.cjs` hand-wrote the same consent-gate →
// build → record receipt five times, and main.cjs cannot be required under
// `node --test` — so nothing pinned WHICH consent category each receipt
// checked. A future paste that kept the wrong key (e.g. a names-bearing event
// gated on 'operational-metrics') shipped silently; the only "test" was a
// test-local model in web/workspaceShapeTelemetry.test.mjs that proved itself,
// not main.cjs. This file pins BOTH halves:
//   • the unit leg exercises the real receiver (createRequire, the
//     telemetry-*-event.test.mjs pattern): the strict `=== true` gate, the
//     mid-flip drop, per-call labels, the null-build skip, the recorded-event
//     passthrough;
//   • the source-assertion leg (the menu-template.test.mjs pattern) reads
//     main.cjs and asserts each of the five NAMED receipts routes through the
//     shared receiver with its CURRENT category → builder pair — the mutation
//     guard that turns a wrong-category paste RED.
//
// Run: node --test telemetry-receipt.test.mjs   (from web/)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { createWindowReceipt } = require('../electron/telemetry-receipt.cjs');

// ---------------------------------------------------------------------------
// Unit leg — the receiver's contract.
// ---------------------------------------------------------------------------

// One harness = one receiver wired to countable fakes. `state` is mutated by
// tests BETWEEN calls (consent flips, label changes) to prove the receiver
// reads its seams per call rather than capturing them at construction.
function harness({ initialConsent = { 'test-cat': true }, buildImpl } = {}) {
  const calls = { consent: 0, build: 0, record: 0, labels: 0 };
  const built = [];
  const recorded = [];
  const state = {
    consent: initialConsent,
    labels: { appVersion: '9.9.9', platform: 'testos' },
  };
  const now = () => 1234;
  const receive = createWindowReceipt({
    consent: () => { calls.consent++; return state.consent; },
    record: (e) => { calls.record++; recorded.push(e); },
    schemaVersion: 7,
    labels: () => { calls.labels++; return state.labels; },
    now,
  });
  const build = (args) => { calls.build++; built.push(args); return buildImpl ? buildImpl(args) : { type: 'ok' }; };
  return { receive, build, built, recorded, calls, state, now };
}

test('consent off: returns null, build is never called, record is never called', () => {
  const h = harness({ initialConsent: { 'test-cat': false } });
  assert.equal(h.receive('test-cat', h.build, { w: 1 }), null);
  assert.equal(h.calls.build, 0, 'a dropped window must not be built');
  assert.equal(h.calls.record, 0, 'a dropped window must not be recorded');
});

test('consent on: the same harness DOES build + record (the off-case above is not vacuous)', () => {
  const h = harness({ initialConsent: { 'test-cat': true } });
  const event = h.receive('test-cat', h.build, { w: 1 });
  assert.equal(h.calls.build, 1);
  assert.equal(h.calls.record, 1);
  assert.equal(event, h.recorded[0]);
});

test('a category missing from the consent map reads as off', () => {
  const h = harness({ initialConsent: { 'other-cat': true } });
  assert.equal(h.receive('test-cat', h.build, { w: 1 }), null);
  assert.equal(h.calls.build, 0);
  assert.equal(h.calls.record, 0);
});

test('consent revoked between two calls: the second window is dropped (the mid-flip gap)', () => {
  const h = harness({ initialConsent: { 'test-cat': true } });
  const first = h.receive('test-cat', h.build, { w: 1 });
  assert.ok(first, 'the first (consented) window is recorded');
  assert.equal(h.calls.record, 1);
  h.state.consent = { 'test-cat': false }; // the user revokes mid-flight
  const second = h.receive('test-cat', h.build, { w: 2 });
  assert.equal(second, null, 'the revoked window is dropped');
  assert.equal(h.calls.build, 1, 'the revoked window is not built');
  assert.equal(h.calls.record, 1, 'the revoked window is not recorded');
});

test('only === true passes: a truthy non-true consent value drops the window', () => {
  for (const truthyNonTrue of [1, 'yes', 'true', {}]) {
    const h = harness({ initialConsent: { 'test-cat': truthyNonTrue } });
    assert.equal(h.receive('test-cat', h.build, { w: 1 }), null, `consent value ${JSON.stringify(truthyNonTrue)} must drop`);
    assert.equal(h.calls.build, 0, `consent value ${JSON.stringify(truthyNonTrue)} must not build`);
    assert.equal(h.calls.record, 0, `consent value ${JSON.stringify(truthyNonTrue)} must not record`);
  }
});

test('consent on: build receives {snapshot, schemaVersion, appVersion, platform, now} plus any extra', () => {
  const h = harness({ initialConsent: { 'test-cat': true } });
  const snapshot = { w: 1 };
  h.receive('test-cat', h.build, snapshot, { runtime: 'renderer' });
  assert.deepEqual(
    h.built[0],
    {
      snapshot,
      schemaVersion: 7,
      appVersion: '9.9.9',
      platform: 'testos',
      now: h.now, // passed through as the FUNCTION reference — the builder invokes it
      runtime: 'renderer',
    },
  );
});

test('no extra: build sees no runtime key at all (the builder keeps its undefined → default behavior)', () => {
  const h = harness({ initialConsent: { 'test-cat': true } });
  h.receive('test-cat', h.build, { w: 1 });
  assert.equal('runtime' in h.built[0], false, 'a receipt with no extra must not invent a runtime key');
});

test('a null build records nothing and returns null', () => {
  const h = harness({ initialConsent: { 'test-cat': true }, buildImpl: () => null });
  assert.equal(h.receive('test-cat', h.build, { w: 1 }), null);
  assert.equal(h.calls.record, 0, 'a null event must not be recorded');
});

test('the return value is the recorded event (identity, not a copy)', () => {
  const h = harness({ initialConsent: { 'test-cat': true } });
  const event = { type: 'ok' };
  const ret = h.receive('test-cat', () => event, { w: 1 });
  assert.equal(ret, event);
  assert.equal(h.recorded[0], event);
  assert.equal(h.calls.record, 1);
});

test('labels are read PER CALL: a label change between calls is reflected immediately', () => {
  const h = harness({ initialConsent: { 'test-cat': true } });
  h.receive('test-cat', h.build, { w: 1 });
  assert.equal(h.built[0].appVersion, '9.9.9');
  h.state.labels = { appVersion: '10.0.0', platform: 'othertos' };
  h.receive('test-cat', h.build, { w: 2 });
  assert.deepEqual(
    { appVersion: h.built[1].appVersion, platform: h.built[1].platform },
    { appVersion: '10.0.0', platform: 'othertos' },
  );
  assert.equal(h.calls.labels, 2, 'labels() must fire once per receive call');
});

// ---------------------------------------------------------------------------
// Source-assertion leg — main.cjs's half of the wiring.
//
// main.cjs cannot be required under node --test, so its five named receipts
// are pinned by reading the source (the web/menu-template.test.mjs pattern).
// These assertions are the MUTATION GUARD for the collapse: swapping any
// receipt's category (e.g. the names receipt onto 'operational-metrics') or
// re-hand-copying a consent gate turns this leg RED.
// ---------------------------------------------------------------------------

const mainSrc = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');

// The CURRENT category → builder pair each named receipt must keep. The
// categories are load-bearing consent boundaries: `names` is the
// identifying-data category (its event goes nowhere without its own conscious
// opt-in and must NEVER ride a metrics category), `incidents` is the stall
// category, `operational-metrics` the aggregates-only one.
const RECEIPTS = [
  { fn: 'recordOperationalMetricsWindow', call: "receiveTelemetryWindow('operational-metrics', buildOperationalMetricsEvent, snapshot)" },
  { fn: 'recordRendererPaneMetrics', call: "receiveTelemetryWindow('operational-metrics', buildOperationalMetricsEvent, snapshot, { runtime: 'renderer' })" },
  { fn: 'recordWorkspaceShapeWindow', call: "receiveTelemetryWindow('operational-metrics', buildWorkspaceShapeEvent, snapshot)" },
  { fn: 'recordServerStallWindow', call: "receiveTelemetryWindow('incidents', buildServerStallEvent, snapshot)" },
  { fn: 'recordWorkspaceNamesWindow', call: "receiveTelemetryWindow('names', buildWorkspaceNamesEvent, snapshot)" },
  // WARDEN-1479 — the SIXTH receipt: the feature-adoption category's carrying
  // event. `feature-adoption` is its own consent boundary (never folded into
  // a metrics category); the builder is the usage-event module; the extra
  // `runtime: 'renderer'` states the origin runtime beside its sibling
  // renderer receipts (the builder pins the same value).
  { fn: 'recordFeatureUsageWindow', call: "receiveTelemetryWindow('feature-adoption', buildFeatureUsageEvent, snapshot, { runtime: 'renderer' })" },
];

// Extract ONE named function's body: `function <name>(snapshot) {` through the
// first line that closes it. Non-greedy, anchored to the exact signature.
function fnBody(name) {
  const m = mainSrc.match(new RegExp(`function ${name}\\(snapshot\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(m, `main.cjs no longer defines ${name} — the receipt wiring moved without updating this guard`);
  return m[0];
}

test('anchors: the shared receiver, its require, and all six named receipts are present', () => {
  for (const anchor of [
    "require('./telemetry-receipt.cjs')",
    'const receiveTelemetryWindow = createWindowReceipt({',
    ...RECEIPTS.map((r) => `function ${r.fn}(snapshot) {`),
  ]) {
    assert.ok(mainSrc.includes(anchor), `anchor ${JSON.stringify(anchor)} is findable in electron/main.cjs`);
  }
});

test('the receiver is constructed exactly once (ONE receipt, never a re-hand-copied one)', () => {
  const count = mainSrc.split('createWindowReceipt(').length - 1;
  assert.equal(count, 1, `expected exactly one createWindowReceipt construction in main.cjs, found ${count}`);
});

test('the receiver wires the same seams the removed hand-copies used', () => {
  const start = mainSrc.indexOf('const receiveTelemetryWindow = createWindowReceipt({');
  assert.notEqual(start, -1, 'the receiver construction is present');
  const block = mainSrc.slice(start, mainSrc.indexOf('});', start) + 3);
  assert.ok(
    block.includes('consent: () => resolveTelemetryConsent(telemetryPrefs)'),
    'consent must read telemetryPrefs LIVE (the same resolver the pipeline uses)',
  );
  assert.ok(
    block.includes('record: (e) => telemetryPipeline.record(e)'),
    'record must be the pipeline entry point',
  );
  assert.ok(
    block.includes('labels: () => ({ appVersion: app.getVersion(), platform: process.platform })'),
    'labels must be read PER CALL from the appVersion + platform seams',
  );
  assert.ok(
    block.includes('now: Date.now'),
    'now must be the Date.now reference (the builders invoke it)',
  );
});

test('each of the six named receipts routes through the shared receiver with its CURRENT category → builder pair', () => {
  for (const { fn, call } of RECEIPTS) {
    const body = fnBody(fn);
    assert.ok(
      body.includes(call),
      `${fn} must route through the shared receiver as:\n  ${call}\n` +
      '— a changed category or builder is a CONSENT-BOUNDARY change and needs a recorded reason here and in the PR',
    );
    assert.ok(
      !body.includes('resolveTelemetryConsent'),
      `${fn} re-hand-copied the consent gate — route through receiveTelemetryWindow instead`,
    );
  }
});

test('the pane receipt persists culprit data ONLY after an accepted window, in record-before-persist order', () => {
  const body = fnBody('recordRendererPaneMetrics');
  const receiveIdx = body.indexOf('receiveTelemetryWindow(');
  const persistIdx = body.indexOf('persistLastPaneLatency(snapshot)');
  assert.ok(receiveIdx !== -1 && persistIdx !== -1, 'the pane receipt must both receive and persist');
  assert.ok(
    persistIdx > receiveIdx,
    'persistLastPaneLatency must run AFTER the receive — persist only when a window was actually accepted',
  );
  assert.match(
    body,
    /const e = receiveTelemetryWindow\(/,
    'the pane receipt must branch on the receive return value',
  );
  assert.match(
    body,
    /if \(e\) persistLastPaneLatency\(snapshot\)/,
    'persist must be gated on a truthy (accepted) event',
  );
});

test('no hand-copied per-category consent gate remains in main.cjs', () => {
  const strays = mainSrc.match(/resolveTelemetryConsent\(telemetryPrefs\)(\[|\.incidents|\.names)/g) || [];
  assert.deepEqual(strays, [], 'a hand-copied consent gate came back in main.cjs — use the shared receiver');
  // The only sanctioned uses are the pipeline's consent resolver, the shared
  // receiver's construction, and applyTelemetryConfig's setConsent. A fourth
  // needs a recorded reason here and in the PR.
  const uses = mainSrc.split('resolveTelemetryConsent(telemetryPrefs)').length - 1;
  assert.equal(uses, 3, `expected exactly 3 resolveTelemetryConsent(telemetryPrefs) uses (pipeline, receiver, applyTelemetryConfig), found ${uses}`);
});
