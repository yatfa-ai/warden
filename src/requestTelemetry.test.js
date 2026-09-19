import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Tests for src/requestTelemetry.js (WARDEN-1292) — the operational-metrics
// producer that folds EVERY /api request's duration + ok/fail verdict into the
// channel, keyed by closed-set route-pattern keys.
//
// Pinned here:
//   • the consent gate — recording AND flushing are no-ops while the
//     `operational-metrics` category is off (nothing out-of-consent is even
//     retained in memory), and a mid-window consent flip DROPS the window;
//   • the ok/fail semantics — the wiring computes `res.statusCode < 500`
//     (a 4xx is a served answer; a 5xx is this server failing), so the
//     producer folds exactly the verdict it is handed;
//   • the CLOSED-SET key mapping — static kebab segments stay verbatim, a
//     `:param` folds to `id`, and a HOSTILE id-bearing path can never ride a
//     key (digit/uppercase/foreign-charset segments all fold to `id`);
//   • the HEAD alias — Express serves HEAD through the GET handler with
//     req.method staying 'HEAD', so it folds under the route's `get-` key;
//     an unaliased `head-*` twin per GET route would be a census-invisible
//     growth axis toward the unsendable `__other__` accumulator;
//   • the `unmatched` sink — un-routed requests and any key failing the
//     schema's operation-name shape fold under ONE regex-safe constant, and
//     ⛔ NO snapshot ever carries the aggregator's reserved `__other__` (that
//     key is unsendable by construction and would void the whole event);
//   • N-independence — 10 vs 10,000 observations retain the IDENTICAL
//     snapshot shape and size (the aggregator's constant-footprint contract,
//     asserted through this producer's public surface);
//   • standalone inertness — a missing `send` is a no-op, not a crash.
//
// Everything is injectable (consent toggle, captured send) — no timers, no
// IPC, no real waiting.

import {
  createRequestTelemetry,
  routeOperationKey,
  UNMATCHED_OPERATION,
  REQUEST_MAX_OPERATIONS,
} from './requestTelemetry.js';
import { createMetricAggregator, OVERFLOW_OPERATION } from './telemetry-metrics.cjs';

// The schema validator's operation-name pattern (mirrored from
// web/src/lib/telemetry/schema.ts OPERATION_NAME_RE) — used here to pin that
// every operation name this producer can emit is structurally valid.
const OP_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// The retained-state projection used by the N-independence assertion — same
// shape-only walk web/telemetry-metrics.test.mjs uses (values discarded, leaf
// types + array lengths kept), so a 1000x observation increase cannot grow
// any retained structure.
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
const counterCount = (snap) => snap.operations.reduce((n, r) => n + r.buckets.length, 0);

function makeHarness({ enabled = true } = {}) {
  const sent = [];
  let on = enabled;
  const tel = createRequestTelemetry({
    consent: () => on,
    send: (snapshot) => sent.push(snapshot),
    aggregator: createMetricAggregator({ now: () => 0, maxOperations: REQUEST_MAX_OPERATIONS }),
  });
  return { tel, sent, flip: (v) => { on = v; } };
}

describe('consent gating (off by default)', () => {
  it('records nothing while the category is off', () => {
    const { tel, sent } = makeHarness({ enabled: false });
    assert.equal(tel.recordRequest('GET', '/api/health', 5, true), false);
    assert.equal(tel.recordRequest('POST', '/api/file-exists', 500, false), false);
    assert.equal(tel.flushNow(), null);
    assert.deepEqual(sent, []);
  });

  it('DROPS the window when consent flips off mid-window (nothing out-of-consent is sent or retained)', () => {
    const { tel, sent, flip } = makeHarness({ enabled: true });
    tel.recordRequest('GET', '/api/health', 5, true);
    flip(false);
    assert.equal(tel.flushNow(), null);
    assert.deepEqual(sent, []);
    // Re-enable: the dropped window must NOT reappear in the next flush.
    flip(true);
    tel.recordRequest('GET', '/api/health', 6, true);
    const snap = tel.flushNow();
    assert.equal(sent.length, 1);
    const health = snap.operations.find((o) => o.operation === 'get-api-health');
    assert.equal(health.count, 1, 'only the post-flip observation survives');
  });

  it('does not send an empty window', () => {
    const { tel, sent } = makeHarness({ enabled: true });
    assert.equal(tel.flushNow(), null);
    assert.deepEqual(sent, []);
  });
});

describe('ok/fail verdict semantics', () => {
  it('folds an explicit false into failCount and everything else into okCount', () => {
    const { tel } = makeHarness();
    // The middleware hands `res.statusCode < 500`: a 4xx is ok (a served
    // answer about the caller's request), a 5xx is a fail (this server).
    tel.recordRequest('GET', '/api/health', 5, true);
    tel.recordRequest('GET', '/api/health', 6, true);
    tel.recordRequest('GET', '/api/health', 7, false); // the 5xx leg
    const snap = tel.flushNow();
    const health = snap.operations.find((o) => o.operation === 'get-api-health');
    assert.equal(health.count, 3);
    assert.equal(health.okCount, 2);
    assert.equal(health.failCount, 1);
    assert.equal(health.max, 7);
  });
});

describe('closed-set route-pattern key mapping', () => {
  it('keeps static kebab segments verbatim and maps :param to id', () => {
    const { tel } = makeHarness();
    tel.recordRequest('GET', '/api/health', 1, true);
    tel.recordRequest('GET', '/api/collections/:id/agents', 2, true);
    tel.recordRequest('POST', '/api/sessions/:id', 3, true);
    const snap = tel.flushNow();
    const names = snap.operations.map((o) => o.operation).sort();
    assert.deepEqual(names, ['get-api-collections-id-agents', 'get-api-health', 'post-api-sessions-id']);
  });

  it('a HOSTILE id-bearing concrete path folds to …-id and the literal never appears', () => {
    const { tel } = makeHarness();
    // A mis-wired caller that passes the concrete URL instead of the route
    // literal: the digit-bearing uuid segment MUST fold to `id`.
    const hostile = '/api/sessions/550e8400-e29b-41d4-a716-446655440000';
    tel.recordRequest('GET', hostile, 4, true);
    const snap = tel.flushNow();
    const names = snap.operations.map((o) => o.operation);
    assert.deepEqual(names, ['get-api-sessions-id']);
    assert.equal(JSON.stringify(snap).includes('550e8400'), false, 'no path variable can ride a key');
  });

  it('digit, uppercase and foreign-charset segments all fold to id', () => {
    const { tel } = makeHarness();
    tel.recordRequest('GET', '/api/v2/thing', 1, true);
    tel.recordRequest('GET', '/api/FooBar/thing', 1, true);
    tel.recordRequest('GET', '/api/日本語/thing', 1, true);
    const snap = tel.flushNow();
    // All three collapse onto the same loss-of-resolution key — never a key
    // derived from the odd segment text.
    assert.deepEqual(
      snap.operations.map((o) => o.operation),
      ['get-api-id-thing'],
    );
    const json = JSON.stringify(snap);
    assert.equal(json.includes('FooBar'), false);
    assert.equal(json.includes('v2'), false);
  });

  it('an over-long key folds to the unmatched sink (never truncated, never emitted raw)', () => {
    const { tel } = makeHarness();
    tel.recordRequest('GET', `/api/${'a'.repeat(100)}`, 1, true);
    const snap = tel.flushNow();
    assert.deepEqual(snap.operations.map((o) => o.operation), [UNMATCHED_OPERATION]);
  });

  it('a path deeper than the segment cap keeps its head (loss of resolution, never a leak)', () => {
    assert.equal(routeOperationKey('GET', '/api/a/b/c/d/e/f/g/h'), 'get-api-a-b-c-d-e');
  });

  it('un-routed requests (undefined route path) fold under the single unmatched constant', () => {
    const { tel } = makeHarness();
    tel.recordRequest('GET', undefined, 1, true); // bad path → no req.route
    tel.recordRequest('POST', undefined, 2, true); // JSON-body parse error
    tel.recordRequest('GET', '', 3, true); // degenerate empty literal
    const snap = tel.flushNow();
    // THREE un-routed observations fold into ONE operation row (the sink is a
    // single constant, not per-request text).
    const sink = snap.operations.find((o) => o.operation === UNMATCHED_OPERATION);
    assert.ok(sink, 'the unmatched sink folded');
    assert.equal(sink.count, 3);
    assert.equal(snap.operations.length, 1, 'nothing else in the window');
  });

  it('a verb that is not lowercase letters folds to the unmatched sink', () => {
    assert.equal(routeOperationKey('BAD_VERB!', '/api/health'), UNMATCHED_OPERATION);
    assert.equal(routeOperationKey(undefined, '/api/health'), UNMATCHED_OPERATION);
  });

  it('the verb is normalized to lowercase', () => {
    assert.equal(routeOperationKey('GET', '/api/health'), 'get-api-health');
    assert.equal(routeOperationKey('POST', '/api/health'), 'post-api-health');
  });

  it('HEAD folds under the GET route key — Express serves HEAD with the GET handler', () => {
    // Express (router v2) serves HEAD with req.method staying 'HEAD' — on a
    // GET route it runs the GET handler; on a route declaring no GET, the
    // router's HEAD exemption still sets req.route before 404ing. Left
    // unaliased, every addressable route would carry an uncounted `head-*`
    // twin: a runtime growth axis the route table's own route.methods census
    // never reports — enough of them would exhaust REQUEST_MAX_OPERATIONS
    // and reach the aggregator's unsendable `__other__` accumulator, voiding
    // the whole window. Aliased, HEAD contributes NO keys of its own — every
    // HEAD observation lands on the route's `get-` key — so the reachable
    // set is declared-method keys ∪ the `get-` twin of every pattern, which
    // the HTTP suite's sizing tripwire derives through this same mapper.
    assert.equal(routeOperationKey('HEAD', '/api/health'), 'get-api-health');
    assert.equal(routeOperationKey('head', '/api/collections/:id/agents'), 'get-api-collections-id-agents');
    // The HEAD-exemption twin: a POST-only route gets the same treatment —
    // router v2 sets req.route on it for HEAD traffic too (see the
    // HTTP suite's live pin).
    assert.equal(routeOperationKey('HEAD', '/api/file-exists'), 'get-api-file-exists');

    // Through the producer's public surface: a HEAD observation must land in
    // the GET key's row, and no `head-*` key may exist in the snapshot.
    const { tel } = makeHarness();
    assert.equal(tel.recordRequest('HEAD', '/api/health', 12, true), true);
    const snap = tel.flushNow();
    assert.ok(snap, 'the window must flush');
    assert.ok(snap.operations.find((o) => o.operation === 'get-api-health' && o.count >= 1),
      'the HEAD observation folded under get-api-health');
    assert.equal(snap.operations.some((o) => o.operation.startsWith('head-')), false,
      'no head-* key may ever be emitted');
    assert.equal(JSON.stringify(snap).includes('"head-'), false,
      'no head-* key may ever appear anywhere in the snapshot');
  });

  it('a root path maps to <verb>-root (unreachable under the /api/ scope, kept for safety)', () => {
    assert.equal(routeOperationKey('GET', '/'), 'get-root');
  });
});

describe('the wire shape (aggregates only, closed set)', () => {
  it('every emitted key satisfies OPERATION_NAME_RE, and NO snapshot ever carries __other__', () => {
    const { tel } = makeHarness();
    // Every leg the mapping tests above exercise, replayed through one window:
    tel.recordRequest('GET', '/api/health', 1, true);
    tel.recordRequest('GET', '/api/collections/:id/agents', 1, true);
    tel.recordRequest('GET', '/api/sessions/550e8400-e29b-41d4-a716-446655440000', 1, true);
    tel.recordRequest('GET', '/api/FooBar', 1, true);
    tel.recordRequest('GET', `/api/${'a'.repeat(100)}`, 1, true);
    tel.recordRequest('GET', undefined, 1, true); // un-routed
    const snap = tel.flushNow();
    assert.ok(snap.operations.length > 0);
    for (const op of snap.operations) {
      assert.match(op.operation, OP_NAME_RE, `emitted key must satisfy the schema pattern: ${op.operation}`);
    }
    assert.equal(JSON.stringify(snap).includes(OVERFLOW_OPERATION), false,
      'the reserved overflow key is unsendable by construction — it must never appear');
  });

  it('every emittable key from routeOperationKey satisfies OPERATION_NAME_RE', () => {
    const paths = [
      '/', '/api/health', '/api/collections/:id/agents', '/api/git-log',
      '/api/claude-sessions-search', '/api/X', '/api/ok-then', '/:id',
    ];
    for (const p of paths) {
      for (const verb of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        assert.match(routeOperationKey(verb, p), OP_NAME_RE, `${verb} ${p}`);
      }
    }
  });

  it('the flushed snapshot is a plain M1-aggregator window', () => {
    const { tel } = makeHarness();
    tel.recordRequest('GET', '/api/health', 1, true);
    const snap = tel.flushNow();
    assert.deepEqual(
      Object.keys(snap).sort(),
      ['boundaries', 'endedAt', 'foldedOperations', 'foldedOperationsExact', 'operations', 'rejected', 'startedAt'],
    );
    assert.deepEqual(Object.keys(snap.operations[0]).sort(),
      ['avg', 'buckets', 'count', 'failCount', 'max', 'min', 'okCount', 'operation']);
    assert.equal(snap.rejected, 0);
  });
});

describe('constant footprint (N-independence through the producer surface)', () => {
  function fill(tel, n) {
    for (let i = 0; i < n; i += 1) {
      // deterministic spread across the route mix incl. both verdicts
      tel.recordRequest(i % 2 ? 'GET' : 'POST', '/api/health', (i * 37) % 12_000, i % 7 !== 0);
    }
    return tel.flushNow();
  }

  it('retained state is IDENTICAL in shape and size at N = 10 vs N = 10,000', () => {
    const smallHarness = makeHarness();
    const largeHarness = makeHarness();
    const small = fill(smallHarness.tel, 10);
    const large = fill(largeHarness.tel, 10_000);

    // Same structure: same keys, same leaf types, same array lengths.
    assert.equal(shapeJSON(small), shapeJSON(large));
    // Same record count and same number of retained counters — 1000x the
    // observations costs zero extra retained fields.
    assert.equal(small.operations.length, large.operations.length);
    assert.equal(counterCount(small), counterCount(large));
  });
});

describe('standalone inertness (no IPC forward)', () => {
  it('a missing send is a no-op, not a crash — the window still folds and flush returns it', () => {
    // server.js always wires `send` with a process.send guard, so the factory
    // never sees an undefined in production; pinning the scaffold's inert
    // default anyway, because a library import (every test that loads
    // server.js) must never depend on an IPC channel existing.
    const tel = createRequestTelemetry({
      consent: () => true,
      aggregator: createMetricAggregator({ now: () => 0 }),
    });
    tel.recordRequest('GET', '/api/health', 1, true);
    const snap = tel.flushNow();
    assert.ok(snap, 'flushNow completes without a forward');
    assert.equal(snap.operations[0].operation, 'get-api-health');
  });
});
