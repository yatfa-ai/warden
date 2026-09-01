// Unit tests for the telemetry OPERATIONAL-METRICS aggregator (WARDEN-914,
// slice M1 of the latency/operational-metrics channel — roadmap WARDEN-446 /
// design WARDEN-443).
//
// src/telemetry-metrics.cjs is the bounded-aggregate primitive the metrics
// channel needs: it folds each (operation, durationMs, ok) observation into a
// fixed-size histogram + counters and RETAINS NO ROW, so its footprint is
// O(maxOperations × buckets) and independent of the observation count. The
// module is deliberately pure and UNWIRED (no schema bump, no consent change,
// no transport, no instrumentation — those are M2–M5), so everything it does is
// testable here in isolation.
//
// Like web/telemetry-source.test.mjs and web/window-state.test.mjs (the
// established pattern for "main-process logic living in a CJS module"), this
// loads the REAL CJS module via createRequire and exercises it with plain
// values. Auto-discovered by `npm test` (`node --test` runs every *.test.mjs in
// web/).
//
// Run: node --test web/telemetry-metrics.test.mjs   (or `node telemetry-metrics.test.mjs` from web/)
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  DEFAULT_BUCKET_BOUNDARIES_MS,
  DEFAULT_MAX_OPERATIONS,
  DEFAULT_MAX_NAME_LENGTH,
  OVERFLOW_OPERATION,
  createMetricAggregator,
} = require('../src/telemetry-metrics.cjs');

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// --- helpers --------------------------------------------------------------

// A monotonic fake clock, so window timestamps are assertable.
function fakeClock(start = 1_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; return t; };
  return now;
}

// Reduce a value to its STRUCTURE (keys + leaf types), discarding every numeric
// magnitude. Two snapshots with the same shape hold the same number of retained
// fields — which is exactly the "no per-observation data is retained" claim.
function shapeOf(value) {
  if (Array.isArray(value)) return value.map(shapeOf);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = shapeOf(value[k]);
    return out;
  }
  return typeof value;
}
const shapeJSON = (v) => JSON.stringify(shapeOf(v));

// Total number of retained counters across the whole window.
const counterCount = (snap) =>
  snap.operations.reduce((n, r) => n + r.buckets.length, 0);

const byName = (snap, name) => snap.operations.find((r) => r.operation === name);

// =========================================================================
// Criterion 1 — N observations of one operation yield exactly ONE aggregate
// record, and retained state is CONSTANT across N = 10 and N = 10,000.
// =========================================================================

function fillOne(agg, n) {
  for (let i = 0; i < n; i += 1) {
    // deterministic spread across every bucket incl. the overflow bucket
    agg.record('settings-open', (i * 37) % 12_000, { ok: i % 7 !== 0 });
  }
  return agg.snapshot();
}

test('N observations of one operation fold into exactly ONE aggregate record', () => {
  const snap = fillOne(createMetricAggregator({ now: fakeClock() }), 10_000);
  assert.equal(snap.operations.length, 1);
  assert.equal(snap.operations[0].operation, 'settings-open');
  assert.equal(snap.operations[0].count, 10_000);
});

test('retained state is IDENTICAL in shape and size at N = 10 vs N = 10,000', () => {
  const small = fillOne(createMetricAggregator({ now: fakeClock() }), 10);
  const large = fillOne(createMetricAggregator({ now: fakeClock() }), 10_000);

  // Same structure: same keys, same leaf types, same array lengths.
  assert.equal(shapeJSON(small), shapeJSON(large));
  // Same record count and same number of retained counters — 1000x the
  // observations costs zero extra retained fields.
  assert.equal(small.operations.length, large.operations.length);
  assert.equal(counterCount(small), counterCount(large));
  assert.equal(
    counterCount(large),
    DEFAULT_BUCKET_BOUNDARIES_MS.length + 1,
    'one operation retains exactly boundaries+1 counters, regardless of N',
  );
  // Sanity: the counts themselves DID grow (the aggregator is not a no-op).
  assert.equal(small.operations[0].count, 10);
  assert.equal(large.operations[0].count, 10_000);
});

test('adding operations grows state only with KEY count, never with observation count', () => {
  const agg = createMetricAggregator({ now: fakeClock() });
  for (let i = 0; i < 5_000; i += 1) agg.record('a', i % 900);
  const one = agg.snapshot();
  for (let i = 0; i < 5_000; i += 1) agg.record('b', i % 900);
  const two = agg.snapshot();
  assert.equal(counterCount(one), DEFAULT_BUCKET_BOUNDARIES_MS.length + 1);
  assert.equal(counterCount(two), 2 * (DEFAULT_BUCKET_BOUNDARIES_MS.length + 1));
});

// =========================================================================
// Criterion 2 — count / ok / fail / min / avg / max / buckets are correct for a
// known fixture, INCLUDING boundary values landing in the documented bucket.
// =========================================================================

test('known fixture: counts, min/avg/max and bucket placement are exact', () => {
  const agg = createMetricAggregator({ now: fakeClock() });
  // boundaries: [50, 100, 250, 500, 1000, 2500, 5000, 10000] -> 9 buckets
  //   40    -> b0        50 -> b0 (inclusive upper bound)
  //   51    -> b1       100 -> b1 (inclusive)
  //  250    -> b2 (inclusive)
  // 10000   -> b7 (inclusive)   10001 -> b8 (overflow)
  const fixture = [
    ['ok', 40], ['ok', 50], ['fail', 51], ['ok', 100],
    ['ok', 250], ['fail', 10_000], ['ok', 10_001],
  ];
  for (const [outcome, ms] of fixture) agg.record('sync-refresh', ms, { ok: outcome === 'ok' });

  const rec = byName(agg.snapshot(), 'sync-refresh');
  assert.equal(rec.count, 7);
  assert.equal(rec.okCount, 5);
  assert.equal(rec.failCount, 2);
  assert.equal(rec.okCount + rec.failCount, rec.count);
  assert.equal(rec.min, 40);
  assert.equal(rec.max, 10_001);
  assert.equal(rec.avg, (40 + 50 + 51 + 100 + 250 + 10_000 + 10_001) / 7);
  assert.deepEqual(rec.buckets, [2, 2, 1, 0, 0, 0, 0, 1, 1]);
  assert.equal(
    rec.buckets.reduce((a, b) => a + b, 0),
    rec.count,
    'every observation lands in exactly one bucket',
  );
});

test('min and max track observations arriving in ANY order', () => {
  // Deliberately NOT ascending: the first observation must not be able to pin
  // min (nor the last to pin max). A fixture that happens to open with its own
  // minimum would let a broken min-update path pass unnoticed.
  const agg = createMetricAggregator({ now: fakeClock() });
  for (const ms of [500, 30, 900, 10, 640, 60]) agg.record('jumbled', ms);
  const rec = byName(agg.snapshot(), 'jumbled');
  assert.equal(rec.min, 10, 'a LATER, smaller observation lowers min');
  assert.equal(rec.max, 900, 'an EARLIER, larger observation is not displaced');
  assert.equal(rec.count, 6);
  assert.equal(rec.avg, (500 + 30 + 900 + 10 + 640 + 60) / 6);

  // strictly descending — every observation after the first must lower min
  const desc = createMetricAggregator({ now: fakeClock() });
  for (const ms of [400, 300, 200, 100]) desc.record('down', ms);
  assert.equal(byName(desc.snapshot(), 'down').min, 100);
  assert.equal(byName(desc.snapshot(), 'down').max, 400);

  // strictly ascending — every observation after the first must raise max
  const asc = createMetricAggregator({ now: fakeClock() });
  for (const ms of [100, 200, 300, 400]) asc.record('up', ms);
  assert.equal(byName(asc.snapshot(), 'up').min, 100);
  assert.equal(byName(asc.snapshot(), 'up').max, 400);
});

test('EVERY boundary value lands in the bucket it bounds (inclusive upper bound)', () => {
  const agg = createMetricAggregator({ now: fakeClock() });
  for (const b of DEFAULT_BUCKET_BOUNDARIES_MS) agg.record('edge', b);
  const rec = byName(agg.snapshot(), 'edge');
  // one observation per bucket 0..k-1, none in the overflow bucket
  assert.deepEqual(rec.buckets, [...DEFAULT_BUCKET_BOUNDARIES_MS.map(() => 1), 0]);
});

test('just-over-boundary values land in the NEXT bucket', () => {
  const agg = createMetricAggregator({ now: fakeClock() });
  for (const b of DEFAULT_BUCKET_BOUNDARIES_MS) agg.record('edge', b + 0.5);
  const rec = byName(agg.snapshot(), 'edge');
  assert.deepEqual(rec.buckets, [0, ...DEFAULT_BUCKET_BOUNDARIES_MS.map(() => 1)]);
});

test('zero is a VALID duration and lands in the first bucket', () => {
  const agg = createMetricAggregator({ now: fakeClock() });
  assert.equal(agg.record('instant', 0), true);
  const rec = byName(agg.snapshot(), 'instant');
  assert.equal(rec.count, 1);
  assert.equal(rec.min, 0);
  assert.equal(rec.max, 0);
  assert.equal(rec.avg, 0);
  assert.equal(rec.buckets[0], 1);
});

test('ok defaults to true; ONLY an explicit ok:false counts as a failure', () => {
  const agg = createMetricAggregator({ now: fakeClock() });
  agg.record('op', 10);                 // no meta at all
  agg.record('op', 10, {});             // meta without ok
  agg.record('op', 10, { ok: true });
  agg.record('op', 10, { ok: false });
  const rec = byName(agg.snapshot(), 'op');
  assert.equal(rec.okCount, 3);
  assert.equal(rec.failCount, 1);
});

test('custom buckets are honoured and buckets.length === boundaries.length + 1', () => {
  const agg = createMetricAggregator({ buckets: [10, 20], now: fakeClock() });
  assert.deepEqual(agg.boundaries, [10, 20]);
  for (const ms of [5, 10, 15, 20, 25]) agg.record('custom', ms);
  const rec = byName(agg.snapshot(), 'custom');
  assert.equal(rec.buckets.length, 3);
  assert.deepEqual(rec.buckets, [2, 2, 1]);
});

// =========================================================================
// Criterion 3 — exceeding maxOperations keeps the key count bounded and folds
// the excess into the overflow key with a correct folded-name count.
// =========================================================================

test('distinct operation keys are capped; the excess folds into the overflow key', () => {
  const agg = createMetricAggregator({ maxOperations: 3, now: fakeClock() });
  for (const name of ['a', 'b', 'c']) agg.record(name, 10);
  // three NEW names beyond the cap, one of them recorded twice
  for (const name of ['d', 'e', 'f', 'd']) agg.record(name, 300, { ok: false });

  const snap = agg.snapshot();
  assert.equal(snap.operations.length, 4, 'exactly maxOperations + the reserved overflow key');
  assert.deepEqual(snap.operations.map((r) => r.operation), ['a', 'b', 'c', OVERFLOW_OPERATION]);

  const other = byName(snap, OVERFLOW_OPERATION);
  assert.equal(other.count, 4, 'every over-cap observation is still counted');
  assert.equal(other.failCount, 4);
  assert.equal(other.buckets[3], 4, '300ms folds into bucket 3, the 250 < x <= 500 band');
  assert.equal(snap.foldedOperations, 3, 'd, e and f — three DISTINCT folded names');
  assert.equal(snap.foldedOperationsExact, true);
});

test('an already-tracked operation is never folded, no matter how late it recurs', () => {
  const agg = createMetricAggregator({ maxOperations: 2, now: fakeClock() });
  agg.record('a', 10);
  agg.record('b', 10);
  for (let i = 0; i < 100; i += 1) agg.record('over', 10);
  agg.record('a', 20); // 'a' is already a key -> still tracked separately
  const snap = agg.snapshot();
  assert.equal(byName(snap, 'a').count, 2);
  assert.equal(byName(snap, OVERFLOW_OPERATION).count, 100);
  assert.equal(snap.foldedOperations, 1);
});

test('an unbounded caller cannot grow memory: 10,000 distinct names stay bounded', () => {
  const agg = createMetricAggregator({ maxOperations: 4, now: fakeClock() });
  for (let i = 0; i < 10_000; i += 1) agg.record(`op-${i}`, i % 900);
  const snap = agg.snapshot();
  assert.equal(snap.operations.length, 5, 'maxOperations + overflow, never more');
  assert.equal(counterCount(snap), 5 * (DEFAULT_BUCKET_BOUNDARIES_MS.length + 1));
  assert.equal(
    snap.operations.reduce((n, r) => n + r.count, 0),
    10_000,
    'no observation is lost — they are folded, not dropped',
  );
  // The folded-name registry is itself capped, so the count degrades to an
  // explicitly-flagged LOWER BOUND rather than growing without bound.
  assert.equal(snap.foldedOperations, 4);
  assert.equal(snap.foldedOperationsExact, false);
});

test('the reserved overflow name is not claimable by a caller', () => {
  const agg = createMetricAggregator({ maxOperations: 8, now: fakeClock() });
  assert.equal(agg.record(OVERFLOW_OPERATION, 10), true);
  const snap = agg.snapshot();
  assert.equal(snap.operations.length, 1);
  assert.equal(snap.operations[0].operation, OVERFLOW_OPERATION);
  assert.equal(snap.foldedOperations, 1, 'it is treated as a folded name, not a tracked key');
});

// =========================================================================
// Criterion 4 — flush() returns the window and resets; consecutive windows do
// not double-count.
// =========================================================================

test('flush() returns the window and resets every counter', () => {
  const now = fakeClock(5_000);
  const agg = createMetricAggregator({ maxOperations: 1, now });
  agg.record('a', 10);
  agg.record('b', 10);         // over cap -> overflow
  agg.record('a', 'nope');     // rejected
  now.advance(60_000);

  const first = agg.flush();
  assert.equal(first.startedAt, 5_000);
  assert.equal(first.endedAt, 65_000);
  assert.equal(byName(first, 'a').count, 1);
  assert.equal(first.rejected, 1);
  assert.equal(first.foldedOperations, 1);

  const empty = agg.snapshot();
  assert.deepEqual(empty.operations, []);
  assert.equal(empty.rejected, 0);
  assert.equal(empty.foldedOperations, 0);
  assert.equal(empty.foldedOperationsExact, true);
  assert.equal(empty.startedAt, 65_000, 'the next window starts where the last one ended');
});

test('two consecutive windows do not double-count', () => {
  const now = fakeClock();
  const agg = createMetricAggregator({ now });
  agg.record('a', 10);
  agg.record('a', 20);
  const w1 = agg.flush();
  now.advance(1_000);
  agg.record('a', 400);
  const w2 = agg.flush();

  assert.equal(byName(w1, 'a').count, 2);
  assert.equal(byName(w1, 'a').max, 20);
  assert.equal(byName(w2, 'a').count, 1, 'window 2 holds ONLY its own observation');
  assert.equal(byName(w2, 'a').min, 400);
  assert.equal(byName(w2, 'a').max, 400);
  assert.deepEqual(byName(w2, 'a').buckets, [0, 0, 0, 1, 0, 0, 0, 0, 0]);
});

test('a flushed window is DETACHED — later records never mutate it', () => {
  const agg = createMetricAggregator({ now: fakeClock() });
  agg.record('a', 10);
  const w1 = agg.flush();
  const before = JSON.stringify(w1);
  for (let i = 0; i < 50; i += 1) agg.record('a', 999);
  assert.equal(JSON.stringify(w1), before);
});

test('flush() on an empty window is harmless and yields an empty window', () => {
  const agg = createMetricAggregator({ now: fakeClock() });
  const snap = agg.flush();
  assert.deepEqual(snap.operations, []);
  assert.equal(snap.rejected, 0);
  assert.deepEqual(snap.boundaries, [...DEFAULT_BUCKET_BOUNDARIES_MS]);
});

test('snapshot() does NOT mutate or reset, and cannot be used to corrupt state', () => {
  const agg = createMetricAggregator({ now: fakeClock() });
  agg.record('a', 10);
  const s1 = agg.snapshot();
  const s2 = agg.snapshot();
  assert.deepEqual(s1.operations, s2.operations, 'repeated snapshots are stable');

  // Mutating a returned snapshot must not reach internal state.
  s1.operations[0].buckets[0] = 999;
  s1.operations[0].count = 999;
  s1.boundaries[0] = 999;
  const s3 = agg.snapshot();
  assert.equal(s3.operations[0].count, 1);
  assert.equal(s3.operations[0].buckets[0], 1);
  assert.deepEqual(s3.boundaries, [...DEFAULT_BUCKET_BOUNDARIES_MS]);
});

// =========================================================================
// Criterion 5 — degenerate inputs are REJECTED without throwing.
// =========================================================================

test('degenerate durations are rejected without throwing', () => {
  const agg = createMetricAggregator({ now: fakeClock() });
  const bad = [
    NaN, Infinity, -Infinity, -1, -0.5,
    '100', null, undefined, {}, [], true, 100n,
  ];
  for (const v of bad) {
    assert.equal(agg.record('op', v), false, `duration ${String(v)} must be rejected`);
  }
  const snap = agg.snapshot();
  assert.deepEqual(snap.operations, [], 'a rejected observation creates no key');
  assert.equal(snap.rejected, bad.length);
});

test('degenerate operation names are rejected without throwing', () => {
  const agg = createMetricAggregator({ maxNameLength: 8, now: fakeClock() });
  const bad = [
    '',                       // empty
    'x'.repeat(9),            // over maxNameLength
    123, null, undefined, {}, [], true, Symbol('op'),
  ];
  for (const v of bad) {
    assert.equal(agg.record(v, 10), false, `name ${String(v)} must be rejected`);
  }
  const snap = agg.snapshot();
  assert.deepEqual(snap.operations, []);
  assert.equal(snap.rejected, bad.length);
  // the cap itself is inclusive: exactly maxNameLength characters is fine
  assert.equal(agg.record('x'.repeat(8), 10), true);
});

test('rejections never disturb the aggregates around them', () => {
  const agg = createMetricAggregator({ now: fakeClock() });
  agg.record('a', 10);
  agg.record('a', NaN);
  agg.record(null, 10);
  agg.record('a', 20);
  const rec = byName(agg.snapshot(), 'a');
  assert.equal(rec.count, 2);
  assert.equal(rec.min, 10);
  assert.equal(rec.max, 20);
  assert.equal(rec.avg, 15);
  assert.equal(agg.snapshot().rejected, 2);
});

test('invalid FACTORY options throw at wire-up time (not at record time)', () => {
  assert.throws(() => createMetricAggregator({ buckets: [] }), TypeError);
  assert.throws(() => createMetricAggregator({ buckets: [100, 50] }), TypeError, 'descending');
  assert.throws(() => createMetricAggregator({ buckets: [50, 50] }), TypeError, 'non-strict');
  assert.throws(() => createMetricAggregator({ buckets: [0] }), TypeError);
  assert.throws(() => createMetricAggregator({ buckets: [NaN] }), TypeError);
  assert.throws(() => createMetricAggregator({ buckets: 'nope' }), TypeError);
  assert.throws(() => createMetricAggregator({ maxOperations: 0 }), TypeError);
  assert.throws(() => createMetricAggregator({ maxOperations: 1.5 }), TypeError);
  assert.throws(() => createMetricAggregator({ maxNameLength: -1 }), TypeError);
  assert.throws(() => createMetricAggregator({ now: 'clock' }), TypeError);
  // no options at all is valid and uses the documented defaults
  const agg = createMetricAggregator();
  assert.deepEqual(agg.boundaries, [...DEFAULT_BUCKET_BOUNDARIES_MS]);
  assert.equal(agg.maxOperations, DEFAULT_MAX_OPERATIONS);
  assert.equal(agg.maxNameLength, DEFAULT_MAX_NAME_LENGTH);
});

// =========================================================================
// Criterion 6 — the module is PURE: zero runtime imports, loads standalone.
// =========================================================================

test('the module has ZERO runtime imports (no require(), no import)', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../src/telemetry-metrics.cjs', import.meta.url)),
    'utf8',
  );
  assert.equal(src.startsWith("'use strict';"), true, "'use strict' is the first line");
  assert.equal(/require\s*\(\s*['"`]/.test(src), false, 'no require() of any module');
  assert.equal(/^\s*import\s/m.test(src), false, 'no ESM import');
  assert.equal(/^\s*export\s/m.test(src), false, 'no ESM export');
  assert.equal(/\bimport\s*\(/.test(src), false, 'no dynamic import()');
  assert.equal(/module\.exports\s*=/.test(src), true, 'plain module.exports at the bottom');
});

test('exported surface is exactly the documented API', () => {
  const agg = createMetricAggregator({ now: fakeClock() });
  for (const fn of ['record', 'snapshot', 'flush']) {
    assert.equal(typeof agg[fn], 'function', `${fn}() is exposed`);
  }
  assert.equal(typeof OVERFLOW_OPERATION, 'string');
  assert.equal(Array.isArray(DEFAULT_BUCKET_BOUNDARIES_MS), true);
  assert.equal(Object.isFrozen(DEFAULT_BUCKET_BOUNDARIES_MS), true);
});

test('two aggregators are fully independent (no shared module state)', () => {
  const a = createMetricAggregator({ now: fakeClock() });
  const b = createMetricAggregator({ now: fakeClock() });
  a.record('op', 10);
  assert.deepEqual(b.snapshot().operations, []);
  b.record('op', 20);
  assert.equal(byName(a.snapshot(), 'op').count, 1);
  assert.equal(byName(b.snapshot(), 'op').max, 20);
});

console.log(`\n✓ TELEMETRY-METRICS TESTS PASS (${passed})`);
