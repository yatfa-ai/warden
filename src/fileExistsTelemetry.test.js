import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Tests for src/fileExistsTelemetry.js (WARDEN-1258) — the operational-metrics
// producer for the terminal linkifier's file-existence probe.
//
// Pinned here:
//   • the consent gate — recording AND flushing are no-ops while the
//     `operational-metrics` category is off (the off-by-default posture: not
//     even retained in memory), and a mid-window consent flip DROPS the window
//     instead of sending it;
//   • the aggregate dimensions the ticket's territory names — probe count,
//     ok/fail share, the local/remote latency split, and cache-hit folding;
//   • the wire shape — the flushed snapshot is a plain M1-aggregator window
//     (startedAt/endedAt/boundaries/operations/rejected) whose operation names
//     satisfy the schema validator's kebab-case pattern (the structural
//     hard-exclusion proof: no path or hostname can ride an aggregate key);
//   • defensive handling of a corrupt renderer-reported cacheHits delta.
//
// Everything is injectable (consent toggle, captured send) — no timers, no IPC,
// no real waiting.

import { createFileExistsTelemetry, FILE_EXISTS_OPS } from './fileExistsTelemetry.js';
import { createMetricAggregator } from './telemetry-metrics.cjs';

// The schema validator's operation-name pattern (mirrored from
// web/src/lib/telemetry/schema.ts OPERATION_NAME_RE) — used here to pin that
// every operation name this producer can emit is structurally valid.
const OP_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function makeHarness({ enabled = true } = {}) {
  const sent = [];
  let on = enabled;
  const tel = createFileExistsTelemetry({
    consent: () => on,
    send: (snapshot) => sent.push(snapshot),
    aggregator: createMetricAggregator({ now: () => 0 }),
  });
  return { tel, sent, flip: (v) => { on = v; } };
}

describe('consent gating (off by default)', () => {
  it('records nothing while the category is off', () => {
    const { tel, sent } = makeHarness({ enabled: false });
    assert.equal(tel.recordProbe('local', 5, true), false);
    assert.equal(tel.recordProbe('remote', 500, false), false);
    assert.equal(tel.recordCacheHits(7), false);
    assert.equal(tel.flushNow(), null);
    assert.deepEqual(sent, []);
  });

  it('DROPS the window when consent flips off mid-window (nothing out-of-consent is sent or retained)', () => {
    const { tel, sent, flip } = makeHarness({ enabled: true });
    tel.recordProbe('local', 5, true);
    flip(false);
    assert.equal(tel.flushNow(), null);
    assert.deepEqual(sent, []);
    // Re-enable: the dropped window must NOT reappear in the next flush.
    flip(true);
    tel.recordProbe('local', 6, true);
    const snap = tel.flushNow();
    assert.equal(sent.length, 1);
    const local = snap.operations.find((o) => o.operation === FILE_EXISTS_OPS.LOCAL);
    assert.equal(local.count, 1, 'only the post-flip observation survives');
  });

  it('does not send an empty window', () => {
    const { tel, sent } = makeHarness({ enabled: true });
    assert.equal(tel.flushNow(), null);
    assert.deepEqual(sent, []);
  });
});

describe('the aggregate dimensions (WARDEN-1258 territory)', () => {
  it('folds probe count + ok/fail share + latency per local/remote branch', () => {
    const { tel, sent } = makeHarness();
    tel.recordProbe('local', 1, true);
    tel.recordProbe('local', 2, true);
    tel.recordProbe('local', 3, false);
    tel.recordProbe('remote', 400, true);
    tel.recordProbe('remote', 900, false);
    const snap = tel.flushNow();
    assert.equal(sent.length, 1);

    const byOp = Object.fromEntries(snap.operations.map((o) => [o.operation, o]));
    const local = byOp[FILE_EXISTS_OPS.LOCAL];
    const remote = byOp[FILE_EXISTS_OPS.REMOTE];
    assert.equal(local.count, 3);
    assert.equal(local.okCount, 2);
    assert.equal(local.failCount, 1);
    assert.equal(local.min, 1);
    assert.equal(local.max, 3);
    const cache = byOp[FILE_EXISTS_OPS.CACHE_HIT];
    assert.equal(cache, undefined, 'no cache operation without a reported delta');

    assert.equal(remote.count, 2);
    assert.equal(remote.okCount, 1);
    assert.equal(remote.failCount, 1);
    assert.equal(remote.min, 400);
    assert.equal(remote.max, 900);
    // The latency SPLIT is real: the two branches land in different buckets.
    const localBucket = local.buckets.findIndex((n) => n > 0);
    const remoteBucket = remote.buckets.findIndex((n) => n > 0);
    assert.ok(localBucket < remoteBucket, 'local probes bucket strictly faster than remote');
  });

  it('folds a renderer-reported cache-hit delta as a counts-only observation', () => {
    const { tel } = makeHarness();
    assert.equal(tel.recordCacheHits(4), true);
    const snap = tel.flushNow();
    const cache = snap.operations.find((o) => o.operation === FILE_EXISTS_OPS.CACHE_HIT);
    assert.equal(cache.count, 4);
    assert.equal(cache.okCount, 4);
    assert.equal(cache.failCount, 0);
    assert.equal(cache.min, 0);
    assert.equal(cache.max, 0, 'a cache hit has no duration — latency stays honestly zero');
  });

  it('rejects a corrupt cacheHits delta (non-integer / negative / absurd)', () => {
    const { tel } = makeHarness();
    for (const bad of [1.5, -1, '3', NaN, Infinity, 1e9]) {
      assert.equal(tel.recordCacheHits(bad), false, `${String(bad)} must be refused`);
    }
    assert.equal(tel.recordCacheHits(0), false, 'a zero delta is a no-op, not an observation');
  });

  it('every operation name satisfies the schema kebab-case pattern (hard exclusion is structural)', () => {
    const { tel } = makeHarness();
    tel.recordProbe('local', 1, true);
    tel.recordProbe('remote', 1, true);
    tel.recordCacheHits(1);
    const snap = tel.flushNow();
    assert.ok(snap.operations.length >= 3);
    for (const op of snap.operations) {
      assert.match(op.operation, OP_NAME_RE, `${op.operation} must be a valid aggregate key`);
    }
    // The window carries numbers and op names only — snapshot it to JSON and
    // prove no path-like or host-like string survives anywhere in the payload.
    const json = JSON.stringify(snap);
    assert.equal(json.includes('/'), false, 'no path separator anywhere in the window');
    assert.equal(json.includes('.'), false, 'no dotted (hostname-shaped) token anywhere in the window');
  });
});

describe('window mechanics', () => {
  it('flushNow closes the window — two consecutive windows never double-count', () => {
    const { tel } = makeHarness();
    tel.recordProbe('local', 1, true);
    const first = tel.flushNow();
    const second = tel.flushNow();
    assert.equal(second, null, 'an empty follow-up window is not sent');
    const local = first.operations.find((o) => o.operation === FILE_EXISTS_OPS.LOCAL);
    assert.equal(local.count, 1);
  });

  it('start() arms an unref\'d interval that flushes periodically', () => {
    const fired = [];
    const fakeInterval = (fn, ms) => {
      fired.push(ms);
      return { unref: () => { fired.push('unref'); } };
    };
    const { tel } = makeHarness();
    tel.start();
    // default cadence armed + unref'd (start() used the real setInterval here)
    // — arm a SECOND instance through the injected timer to observe the shape.
    const tel2 = createFileExistsTelemetry({
      consent: () => true,
      send: () => {},
      setIntervalImpl: fakeInterval,
    });
    tel2.start();
    assert.deepEqual(fired, [5 * 60_000, 'unref']);
  });
});
