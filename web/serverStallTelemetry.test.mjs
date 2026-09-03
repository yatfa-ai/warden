// Tests for the SERVER-STALL telemetry PRODUCER (WARDEN-1278,
// src/serverStallTelemetry.js) — the consent gate, the window drop, and the IPC
// forward. The bounded fold itself is web/telemetry-stalls.test.mjs's subject;
// this suite is only the policy around it.
//
// The property under test is the one that makes an off-by-default promise real:
// with `incidents` off, NOTHING is recorded and NOTHING is retained — not just
// "nothing is sent". A producer that buffered while off and dropped at send
// would still be holding out-of-consent observations in memory, and a mid-window
// consent flip would then ship a window that was collected before the user said
// yes.
//
// Everything is injectable, so this runs with a fake clock, a captured `send`
// and a togglable consent — no timers, no IPC, no real waiting.
//
// Auto-discovered by `npm run dev:test` (`node --test` in web/).
//
// Run: node --test web/serverStallTelemetry.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServerStallTelemetry, routeSegmentsOf, SERVER_STALL_FLUSH_MS } from '../src/serverStallTelemetry.js';

const require = createRequire(import.meta.url);
const { createStallAggregator, OVERFLOW_CULPRIT } = require('../src/telemetry-stalls.cjs');

const stallRecord = (lagMs, attribution = []) => ({
  type: 'performance-stall',
  runtime: 'server',
  source: 'event-loop',
  timestamp: new Date(0).toISOString(),
  lagMs,
  heartbeatMs: 1000,
  thresholdMs: 1000,
  attribution,
  syncTotals: [],
});

// A producer with a captured `send`, a togglable consent, and a fake clock.
function harness({ enabled = true } = {}) {
  const sent = [];
  const state = { enabled };
  let t = 1000;
  const producer = createServerStallTelemetry({
    consent: () => state.enabled,
    send: (snapshot) => sent.push(snapshot),
    aggregator: createStallAggregator({ now: () => t }),
  });
  return {
    producer,
    sent,
    state,
    advance(ms) { t += ms; },
  };
}

// ==========================================================================
// The consent gate
// ==========================================================================

test('consent ON — stalls fold and the closed window is forwarded ONCE', () => {
  const { producer, sent } = harness();
  assert.equal(producer.recordStall(stallRecord(1500, [{ label: 'GET /api/health', overlapMs: 1400 }])), true);
  assert.equal(producer.recordStall(stallRecord(3200, [{ label: 'GET /api/health', overlapMs: 3100 }])), true);
  assert.equal(sent.length, 0, 'nothing is sent per stall — the window is the unit');

  const snapshot = producer.flushNow();
  assert.equal(sent.length, 1, 'ONE snapshot for the window');
  assert.equal(sent[0], snapshot);
  assert.equal(snapshot.count, 2, 'both stalls, ONE aggregate — not one row each');
  assert.equal(snapshot.totalMs, 4700);
  assert.equal(snapshot.maxMs, 3200);
  assert.equal(snapshot.culprits[0].culprit, 'get-api-health');
});

test('consent OFF — record() REFUSES, so nothing is even retained in memory', () => {
  const { producer, sent, state } = harness({ enabled: false });
  assert.equal(producer.recordStall(stallRecord(4000)), false, 'the record is refused, not buffered');
  assert.equal(producer.flushNow(), null, 'and the flush sends nothing');
  assert.equal(sent.length, 0);

  // The proof that nothing was retained: turn consent ON and flush again. A
  // producer that had buffered while off would ship those observations now.
  state.enabled = true;
  assert.equal(producer.flushNow(), null, 'the off-window left nothing behind');
  assert.equal(sent.length, 0);
});

test('MID-WINDOW REVOKE — a window collected under consent is DROPPED, not sent', () => {
  // The user said yes, we folded, the user said no before the window closed.
  // The honest answer is to discard: consent is resolved at the moment the data
  // would travel, not at the moment it was observed.
  const { producer, sent, state } = harness();
  producer.recordStall(stallRecord(2000, [{ label: 'sweep:budget', overlapMs: 1900 }]));
  state.enabled = false;
  assert.equal(producer.flushNow(), null, 'the in-flight window is dropped');
  assert.equal(sent.length, 0, 'and nothing reached the IPC channel');

  // And it is GONE — re-enabling does not resurrect it.
  state.enabled = true;
  assert.equal(producer.flushNow(), null, 'the dropped window was discarded, not parked');
  assert.equal(sent.length, 0);
});

test('a MID-WINDOW GRANT collects only from the moment consent was given', () => {
  const { producer, sent, state } = harness({ enabled: false });
  producer.recordStall(stallRecord(9000, [{ label: 'GET /api/health', overlapMs: 8000 }])); // refused
  state.enabled = true;
  producer.recordStall(stallRecord(1500, [{ label: 'GET /api/health', overlapMs: 1400 }]));
  const snapshot = producer.flushNow();
  assert.equal(sent.length, 1);
  assert.equal(snapshot.count, 1, 'only the post-consent stall is in the window');
  assert.equal(snapshot.maxMs, 1500, 'the pre-consent 9s freeze is nowhere in the aggregate');
});

test('a producer with NO consent resolver collects nothing (fail closed)', () => {
  const sent = [];
  const producer = createServerStallTelemetry({ send: (s) => sent.push(s) });
  assert.equal(producer.recordStall(stallRecord(4000)), false);
  assert.equal(producer.flushNow(), null);
  assert.equal(sent.length, 0);
});

// ==========================================================================
// The window / the forward
// ==========================================================================

test('an IDLE window is not sent at all — a healthy session ships nothing', () => {
  const { producer, sent } = harness();
  assert.equal(producer.flushNow(), null, 'no stalls, no event');
  assert.equal(sent.length, 0);
});

test('a window carrying only REJECTED records is still reported (a health signal)', () => {
  const { producer, sent } = harness();
  producer.recordStall({ lagMs: 'lots' }); // degenerate → rejected, not folded
  const snapshot = producer.flushNow();
  assert.equal(sent.length, 1, 'a producer that is being fed garbage should be visible');
  assert.equal(snapshot.count, 0);
  assert.equal(snapshot.rejected, 1);
});

test('two consecutive windows never double-count', () => {
  const h = harness();
  h.producer.recordStall(stallRecord(1500));
  h.advance(300_000);
  const first = h.producer.flushNow();
  h.producer.recordStall(stallRecord(2500));
  h.advance(300_000);
  const second = h.producer.flushNow();
  assert.equal(first.count, 1);
  assert.equal(second.count, 1);
  assert.equal(second.startedAt, first.endedAt, 'the second window starts where the first ended');
});

test('a missing process.send (standalone `node src/server`) is inert, not a crash', () => {
  const producer = createServerStallTelemetry({ consent: () => true });
  producer.recordStall(stallRecord(1500));
  assert.doesNotThrow(() => producer.flushNow(), 'no transport wired → the flush is a no-op');
});

test('recordStall NEVER throws, whatever it is handed', () => {
  // It runs on the stall path of a process whose job is not to observe itself.
  const { producer } = harness();
  for (const bad of [null, undefined, 42, 'stall', {}, [], { lagMs: NaN }]) {
    assert.doesNotThrow(() => producer.recordStall(bad), `record(${JSON.stringify(bad)})`);
  }
});

test('start() arms an UNREF\'d interval on the 5-minute cadence', () => {
  // Unref\'d matters: every test that imports server.js would otherwise be held
  // open by this timer alone.
  let armed = null;
  let unrefd = false;
  const producer = createServerStallTelemetry({
    consent: () => true,
    setIntervalImpl: (fn, ms) => { armed = { fn, ms }; return { unref() { unrefd = true; } }; },
  });
  producer.start();
  assert.equal(armed.ms, SERVER_STALL_FLUSH_MS);
  assert.equal(SERVER_STALL_FLUSH_MS, 5 * 60_000, 'the same 5-minute window the metrics producer uses');
  assert.equal(unrefd, true, 'the flush timer never keeps the process alive');
});

// ==========================================================================
// routeSegmentsOf — the live route-segment set
// ==========================================================================

test('routeSegmentsOf reads the STATIC segments of a live express router', () => {
  const app = {
    router: {
      stack: [
        { route: { path: '/api/health' } },
        { route: { path: '/api/sessions/:id' } },
        { route: { path: '/api/collections/:id/agents' } },
        { name: 'middleware' }, // no route — skipped
      ],
    },
  };
  const segments = routeSegmentsOf(app);
  assert.ok(segments.has('api') && segments.has('health') && segments.has('sessions') && segments.has('agents'));
  // The `:param` position is EXACTLY where a session id / collection id lives,
  // and it must map to the `id` placeholder — never become a known literal.
  assert.ok(!segments.has(':id'), 'a param segment is never a known literal');
  assert.ok(!segments.has('id'), 'and it is not smuggled in unprefixed either');
});

test('routeSegmentsOf is defensive — an unreachable router yields an empty set', () => {
  // Losing the live set costs RESOLUTION (routes stop being distinguishable in
  // the aggregate), never SAFETY: the aggregator falls back to its own vendored
  // list and an unknown segment folds to `id` either way.
  for (const app of [undefined, null, {}, { router: {} }, { router: { stack: 'nope' } }]) {
    assert.equal(routeSegmentsOf(app).size, 0, `${JSON.stringify(app)} → empty set`);
  }
});

test('the live set flows through to the fold — an unknown segment folds', () => {
  const sent = [];
  const producer = createServerStallTelemetry({
    consent: () => true,
    send: (s) => sent.push(s),
    knownSegments: () => new Set(['api', 'health']),
  });
  producer.recordStall(stallRecord(1500, [{ label: 'GET /api/chats/myproject-researcher', overlapMs: 1 }]));
  const key = producer.flushNow().culprits[0].culprit;
  // Two unknown segments (`chats`, then the agent name) → two placeholders.
  assert.equal(key, 'get-api-id-id', 'chats is not in THIS set, so it folds to the placeholder too');
  assert.ok(!key.includes('myproject'), 'and the agent name is nowhere in it');
  assert.notEqual(key, OVERFLOW_CULPRIT);
});
