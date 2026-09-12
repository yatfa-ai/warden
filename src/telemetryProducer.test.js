// Direct unit suite for the shared consent-gated telemetry window scaffold
// (WARDEN-1352). The WARDEN-1074 move (test(retry): pin the shared bounded-retry
// policy directly) applied to the same class of leaf.
//
// src/telemetryProducer.js is the SINGLE home of the consent gate, the IPC
// forward, the flushNow control flow and the unref'd start() consumed by BOTH
// producers — src/fileExistsTelemetry.js (WARDEN-1258) and
// src/serverStallTelemetry.js (WARDEN-1278) — and by the third producer
// WARDEN-1292 specifies. Until this file existed the scaffold's only coverage
// was transitive through those two suites, which drive the producers only
// through their public surface; a mutation to the shared helper that happens to
// cancel out inside one producer's fixtures could slip past them. This file
// pins the CONTRACT, not the producers.
//
// What is deliberately NOT re-pinned here: the recorders, the cadence
// constants, the aggregator internals and the wire shapes — those are the
// producers' own identity and stay covered (unmodified) by their own suites.
// This suite uses a scripted fake aggregator because the scaffold's entire
// contract with an aggregator is `flush() → snapshot`.
//
// Mutation map (each leg names the mutation it detects):
//   • the strict `consent() === true` legs → detect a `!= null` loosening
//   • the discard legs (flush-call count + fresh-next-window) → detect dropping
//     the consent-off `aggregator.flush()` discard
//   • the idle-window legs → detect removing the `hasAnything` guard
//   • the start() legs assert `unref` DIRECTLY on the injectable timer →
//     detect dropping `t.unref()` without hanging the runner (the producer
//     suites detect the same mutation by the real runner HANGING — that hang
//     is detection, not a broken suite)
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createConsentGatedWindow } from './telemetryProducer.js';

// Scripted aggregator: `flush()` pops the queued snapshots in order, then
// serves an empty-by-both-shapes window forever. `calls` records every flush
// so the discard contract (consent-off flushNow STILL flushes, to drop the
// window) is observable directly.
function fakeAggregator(...queuedSnapshots) {
  const calls = [];
  const queue = [...queuedSnapshots];
  return {
    calls,
    flush() {
      calls.push('flush');
      return queue.length > 0 ? queue.shift() : { operations: [], rejected: 0, count: 0 };
    },
  };
}

// Injectable fake timer: captures what start() armed and counts unref calls.
function fakeTimer() {
  const state = { unrefCalls: 0, armed: null, ms: null };
  const timer = { unref() { state.unrefCalls += 1; return timer; } };
  return {
    state,
    timer,
    impl(fn, ms) { state.armed = fn; state.ms = ms; return timer; },
  };
}

// The two producer predicates, verbatim from the producers — the scaffold is
// exercised against BOTH window shapes so a future "simplification" of
// hasAnything into a falsiness test cannot pass here.
const operationsWindow = (deps) => createConsentGatedWindow({
  ...deps,
  intervalMs: 1000,
  hasAnything: (snapshot) => snapshot.operations.length > 0 || snapshot.rejected > 0,
});
const scalarCountWindow = (deps) => createConsentGatedWindow({
  ...deps,
  intervalMs: 1000,
  hasAnything: (snapshot) => snapshot.count > 0 || snapshot.rejected > 0,
});

describe('isEnabled — the live consent gate (fail closed)', () => {
  it('is false when no consent resolver is provided', () => {
    const w = createConsentGatedWindow({ intervalMs: 1000, aggregator: fakeAggregator(), hasAnything: () => true });
    assert.strictEqual(w.isEnabled(), false);
  });

  it('is false when consent() returns false', () => {
    const w = operationsWindow({ consent: () => false, aggregator: fakeAggregator() });
    assert.strictEqual(w.isEnabled(), false);
  });

  it('is true only when consent() returns exactly true', () => {
    const w = operationsWindow({ consent: () => true, aggregator: fakeAggregator() });
    assert.strictEqual(w.isEnabled(), true);
  });

  // THE strictness pin. Truthy-but-not-true must collect NOTHING: loosening
  // the gate to `!= null` (or truthiness) is the exact mutation this leg turns
  // red — a producer whose consent resolver returns a non-boolean must fail
  // closed, not silently start collecting.
  it('is false for truthy non-true consent values (strict === true, fail closed)', () => {
    for (const truthy of [1, 'yes', {}, []]) {
      const w = operationsWindow({ consent: () => truthy, aggregator: fakeAggregator() });
      assert.strictEqual(w.isEnabled(), false, `consent() → ${String(truthy)} must NOT enable`);
    }
  });

  it('consults consent LIVE on every call (a Settings flip gates the next record)', () => {
    let on = false;
    const w = operationsWindow({ consent: () => on, aggregator: fakeAggregator() });
    assert.strictEqual(w.isEnabled(), false);
    on = true;
    assert.strictEqual(w.isEnabled(), true);
    on = false;
    assert.strictEqual(w.isEnabled(), false);
  });
});

describe('flushNow — consent OFF discards the window and sends nothing', () => {
  it('drops the window WITHOUT sending, and still flushes the aggregator (the discard)', () => {
    const agg = fakeAggregator({ operations: [{ op: 'file-exists-local' }], rejected: 0 });
    const sent = [];
    const w = operationsWindow({ consent: () => false, send: (s) => sent.push(s), aggregator: agg });
    assert.strictEqual(w.flushNow(), null);
    assert.deepStrictEqual(sent, []);
    assert.strictEqual(agg.calls.length, 1, 'consent-off flushNow must DISCARD via aggregator.flush()');
  });

  it('the discard keeps the next window fresh: nothing out-of-consent is retained', () => {
    // Queue one observation, close the window while consent is OFF, then grant
    // consent: the granted window must be EMPTY — the queued observation was
    // dropped by the discard, not carried into the next window.
    const agg = fakeAggregator({ operations: [{ op: 'file-exists-local' }], rejected: 0 });
    const sent = [];
    let on = false;
    const w = operationsWindow({ consent: () => on, send: (s) => sent.push(s), aggregator: agg });
    assert.strictEqual(w.flushNow(), null);
    on = true;
    assert.strictEqual(w.flushNow(), null, 'the queued observation was discarded, not retained');
    assert.deepStrictEqual(sent, []);
  });

  it('a mid-window consent revoke drops the window the same way', () => {
    // Consent ON while the window accumulates, flipped OFF before it closes:
    // whatever accumulated out-of-consent must be dropped, never transmitted.
    const agg = fakeAggregator({ operations: [{ op: 'file-exists-remote' }], rejected: 2 });
    const sent = [];
    let on = true;
    const w = operationsWindow({ consent: () => on, send: (s) => sent.push(s), aggregator: agg });
    on = false; // revoke mid-window
    assert.strictEqual(w.flushNow(), null);
    assert.deepStrictEqual(sent, []);
    on = true; // re-grant: still nothing retained from the revoked window
    assert.strictEqual(w.flushNow(), null);
    assert.deepStrictEqual(sent, []);
  });
});

describe('flushNow — an idle window is not sent (hasAnything honored per shape)', () => {
  it('operations[]-shaped idle window: not sent, returns null', () => {
    const agg = fakeAggregator({ operations: [], rejected: 0 });
    const sent = [];
    const w = operationsWindow({ consent: () => true, send: (s) => sent.push(s), aggregator: agg });
    assert.strictEqual(w.flushNow(), null);
    assert.deepStrictEqual(sent, []);
  });

  it('scalar-count-shaped idle window: not sent, returns null', () => {
    const agg = fakeAggregator({ count: 0, rejected: 0 });
    const sent = [];
    const w = scalarCountWindow({ consent: () => true, send: (s) => sent.push(s), aggregator: agg });
    assert.strictEqual(w.flushNow(), null);
    assert.deepStrictEqual(sent, []);
  });

  it('rejected>0 counts as non-idle in BOTH shapes (rejections are signal, not noise)', () => {
    const sentOps = [];
    const wOps = operationsWindow({
      consent: () => true,
      send: (s) => sentOps.push(s),
      aggregator: fakeAggregator({ operations: [], rejected: 3 }),
    });
    assert.notStrictEqual(wOps.flushNow(), null);
    assert.strictEqual(sentOps.length, 1);

    const sentCnt = [];
    const wCnt = scalarCountWindow({
      consent: () => true,
      send: (s) => sentCnt.push(s),
      aggregator: fakeAggregator({ count: 0, rejected: 1 }),
    });
    assert.notStrictEqual(wCnt.flushNow(), null);
    assert.strictEqual(sentCnt.length, 1);
  });
});

describe('flushNow — a non-idle window forwards exactly its snapshot', () => {
  it('operations[] shape: forwards the snapshot, returns the SAME object', () => {
    const snapshot = { operations: [{ op: 'file-exists-local' }, { op: 'file-exists-cache-hit' }], rejected: 0 };
    const sent = [];
    const w = operationsWindow({ consent: () => true, send: (s) => sent.push(s), aggregator: fakeAggregator(snapshot) });
    assert.strictEqual(w.flushNow(), snapshot);
    assert.deepStrictEqual(sent, [snapshot]);
    assert.strictEqual(sent[0], snapshot, 'the IPC payload is the snapshot itself, not a copy');
  });

  it('scalar-count shape: forwards the snapshot, returns the SAME object', () => {
    const snapshot = { count: 7, rejected: 0 };
    const sent = [];
    const w = scalarCountWindow({ consent: () => true, send: (s) => sent.push(s), aggregator: fakeAggregator(snapshot) });
    assert.strictEqual(w.flushNow(), snapshot);
    assert.deepStrictEqual(sent, [snapshot]);
  });
});

describe('flushNow — a missing send is inert, not a crash', () => {
  it('no send at all: the snapshot is still "forwarded" (returned), nothing throws', () => {
    const snapshot = { operations: [{ op: 'file-exists-local' }], rejected: 0 };
    const w = operationsWindow({ consent: () => true, aggregator: fakeAggregator(snapshot) });
    assert.strictEqual(w.flushNow(), snapshot);
  });

  it('a non-function send (e.g. null) is treated the same as absent', () => {
    const snapshot = { count: 2, rejected: 0 };
    const w = scalarCountWindow({ consent: () => true, send: null, aggregator: fakeAggregator(snapshot) });
    assert.strictEqual(w.flushNow(), snapshot);
  });
});

describe('start() — arms an UNREF\u2019d interval on the flush cadence', () => {
  it('arms flushNow on intervalMs and unrefs it exactly once', () => {
    const snapshot = { operations: [{ op: 'file-exists-local' }], rejected: 0 };
    const sent = [];
    const agg = fakeAggregator(snapshot);
    const { timer, state, impl } = fakeTimer();
    const w = operationsWindow({ consent: () => true, send: (s) => sent.push(s), aggregator: agg, setIntervalImpl: impl });
    const armed = w.start();
    assert.strictEqual(armed, timer, 'start() returns the armed timer');
    assert.strictEqual(state.ms, 1000, 'the timer is armed on the producer\u2019s cadence');
    assert.strictEqual(state.unrefCalls, 1, 'the interval is unref\u2019d — load-bearing: an un-unref\u2019d timer hangs every suite that loads server.js');
  });

  it('the armed callback IS the flush (firing it closes and forwards the window)', () => {
    const snapshot = { count: 4, rejected: 0 };
    const sent = [];
    const { state, impl } = fakeTimer();
    const w = scalarCountWindow({
      consent: () => true,
      send: (s) => sent.push(s),
      aggregator: fakeAggregator(snapshot),
      setIntervalImpl: impl,
    });
    w.start();
    state.armed(); // simulate the interval firing
    assert.deepStrictEqual(sent, [snapshot]);
  });

  it('a timer without unref (legacy shape) does not crash start()', () => {
    const w = operationsWindow({
      consent: () => true,
      aggregator: fakeAggregator(),
      setIntervalImpl: () => ({ /* no unref method */ }),
    });
    assert.doesNotThrow(() => w.start());
  });

  it('a falsy timer does not crash start() and is returned as-is', () => {
    const w = operationsWindow({
      consent: () => true,
      aggregator: fakeAggregator(),
      setIntervalImpl: () => null,
    });
    assert.strictEqual(w.start(), null);
  });

  it('the DEFAULT timer impl arms a real interval that can be unref\u2019d and cleared', () => {
    const w = operationsWindow({ consent: () => true, aggregator: fakeAggregator() });
    const t = w.start();
    assert.strictEqual(typeof t.unref, 'function', 'the production default arms a real unref-able timer');
    clearInterval(t);
  });
});
