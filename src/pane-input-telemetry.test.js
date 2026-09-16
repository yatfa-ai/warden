import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Tests for src/paneInputTelemetry.js (WARDEN-1385) — the SERVER half of the
// pane-input latency measurement: the write leg + the tmux round-trip leg, the
// pending-input correlation, the bounded per-pane LOCAL ledger, and the consent
// gate.
//
// Pinned here:
//   • consent gating — recording AND flushing are no-ops while the
//     `operational-metrics` category is off; nothing out-of-consent is retained
//     (a keystroke noted while off opens NO pending correlation, so a later
//     output chunk cannot fold either), and a mid-window consent flip DROPS
//     the window;
//   • the correlation contract — noteInputWritten opens ONE pending entry per
//     pane (latest keystroke wins), notePaneOutput consumes it exactly once,
//     a stale pending input (> PENDING_INPUT_MAX_AGE_MS) is dropped, NOT folded
//     as a monster sample, and detach/exit drops the pending entry but KEEPS
//     the ledger evidence;
//   • the wire shape — the flushed snapshot is an M1-aggregator window whose
//     operation names are closed kebab-case literals (the structural proof a
//     pane key can never ride the telemetry channel);
//   • the local ledger — bounded panes + bounded ring, p50/p95/null-on-empty,
//     and percentile() honesty (null on empty, never 0).

import {
  createPaneInputTelemetry,
  PANE_INPUT_OPS,
  PENDING_INPUT_MAX_AGE_MS,
  percentile,
} from './paneInputTelemetry.js';
import { createMetricAggregator } from './telemetry-metrics.cjs';

// The schema validator's operation-name pattern (mirrored from
// web/src/lib/telemetry/schema.ts OPERATION_NAME_RE).
const OP_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Controllable fake clock for the correlation (durations only; window stamps
// use the aggregator's own epoch clock, which the harness pins to 0).
function makeClock() {
  let t = 0;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
  };
}

function makeHarness({ enabled = true } = {}) {
  const sent = [];
  let on = enabled;
  const clock = makeClock();
  const tel = createPaneInputTelemetry({
    consent: () => on,
    send: (snapshot) => sent.push(snapshot),
    aggregator: createMetricAggregator({ now: () => 0 }),
    now: clock.now,
  });
  return { tel, sent, clock, flip: (v) => { on = v; } };
}

describe('consent gating (off by default)', () => {
  it('records nothing while the category is off', () => {
    const { tel, sent } = makeHarness({ enabled: false });
    assert.equal(tel.noteInputWritten('p1', 0.5), false);
    assert.equal(tel.notePaneOutput('p1'), false);
    assert.equal(tel.flushNow(), null);
    assert.deepEqual(sent, []);
  });

  it('a keystroke noted while off opens NO pending correlation (nothing retained out-of-consent)', () => {
    const { tel, clock, flip } = makeHarness({ enabled: false });
    tel.noteInputWritten('p1', 0.5);
    clock.advance(40);
    flip(true); // consent comes back — the pre-consent keystroke must NOT fold now
    assert.equal(tel.notePaneOutput('p1'), false);
    // The window is EMPTY (the pre-consent keystroke folded nothing), so
    // flushNow refuses to send it — null, and nothing reached the wire.
    assert.equal(tel.flushNow(), null);
  });

  it('DROPS the window when consent flips off mid-window', () => {
    const { tel, sent, clock, flip } = makeHarness({ enabled: true });
    tel.noteInputWritten('p1', 0.5);
    clock.advance(30);
    tel.notePaneOutput('p1');
    flip(false);
    assert.equal(tel.flushNow(), null);
    assert.deepEqual(sent, []);
    flip(true);
    tel.noteInputWritten('p1', 0.4);
    clock.advance(20);
    tel.notePaneOutput('p1');
    const snap = tel.flushNow();
    // The dropped window's observation must NOT reappear: exactly this round's.
    const rt = snap.operations.find((o) => o.operation === PANE_INPUT_OPS.ROUNDTRIP);
    assert.equal(rt.count, 1);
  });
});

describe('pending-input correlation', () => {
  it('correlates write→next-output once; a second output finds nothing pending', () => {
    const { tel, clock } = makeHarness();
    assert.equal(tel.noteInputWritten('p1', 0.25), true);
    clock.advance(42.5);
    assert.equal(tel.notePaneOutput('p1'), true);
    assert.equal(tel.notePaneOutput('p1'), false); // consumed — streaming output is not an echo
    const snap = tel.flushNow();
    const rt = snap.operations.find((o) => o.operation === PANE_INPUT_OPS.ROUNDTRIP);
    assert.equal(rt.count, 1);
    assert.ok(Math.abs(rt.avg - 42.5) < 1e-9);
    const write = snap.operations.find((o) => o.operation === PANE_INPUT_OPS.WRITE);
    assert.equal(write.count, 1);
    assert.ok(Math.abs(write.avg - 0.25) < 1e-9);
  });

  it('latest keystroke per pane wins (a typing burst coalesces)', () => {
    const { tel, clock } = makeHarness();
    tel.noteInputWritten('p1', 0.1);
    clock.advance(10);
    tel.noteInputWritten('p1', 0.1); // second keystroke overwrites the pending entry
    clock.advance(5);
    tel.notePaneOutput('p1');
    const snap = tel.flushNow();
    const rt = snap.operations.find((o) => o.operation === PANE_INPUT_OPS.ROUNDTRIP);
    assert.equal(rt.count, 1);
    assert.ok(Math.abs(rt.avg - 5) < 1e-9);
  });

  it('correlates per pane independently', () => {
    const { tel, clock } = makeHarness();
    tel.noteInputWritten('p1', 0.1);
    tel.noteInputWritten('p2', 0.1);
    clock.advance(100);
    tel.notePaneOutput('p2');
    clock.advance(3);
    tel.notePaneOutput('p1');
    const snap = tel.flushNow();
    const rt = snap.operations.find((o) => o.operation === PANE_INPUT_OPS.ROUNDTRIP);
    assert.equal(rt.count, 2);
    assert.equal(rt.max, 103);
    assert.equal(rt.min, 100);
  });

  it('a pending input older than the max age is dropped, NOT folded as a monster', () => {
    const { tel, clock } = makeHarness();
    tel.noteInputWritten('p1', 0.1);
    clock.advance(PENDING_INPUT_MAX_AGE_MS + 1);
    assert.equal(tel.notePaneOutput('p1'), false);
    const snap = tel.flushNow();
    const rt = snap.operations.find((o) => o.operation === PANE_INPUT_OPS.ROUNDTRIP);
    assert.equal(rt, undefined); // no round-trip folded at all
  });

  it('detach (dropPending) kills the pending correlation but KEEPS the ledger evidence', () => {
    const { tel, clock } = makeHarness();
    tel.noteInputWritten('p1', 0.1);
    clock.advance(50);
    tel.notePaneOutput('p1');
    tel.noteInputWritten('p1', 0.1); // in flight when the PTY dies
    tel.dropPending('p1');
    clock.advance(5000);
    assert.equal(tel.notePaneOutput('p1'), false);
    const rows = tel.ledgerSnapshot();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].pane, 'p1');
    assert.equal(rows[0].samples, 1); // the evidence survived the detach
    assert.equal(tel.pendingCount(), 0);
  });

  it('rejects degenerate keys and never throws', () => {
    const { tel } = makeHarness();
    assert.equal(tel.noteInputWritten('', 1), false);
    assert.equal(tel.notePaneOutput(''), false);
    assert.doesNotThrow(() => tel.notePaneOutput(undefined));
    assert.doesNotThrow(() => tel.noteInputWritten(null, 1));
  });
});

describe('wire shape + local ledger bounds', () => {
  it('flushNow forwards a non-empty window and returns it', () => {
    const { tel, sent, clock } = makeHarness();
    tel.noteInputWritten('agent-a', 0.3);
    clock.advance(120);
    tel.notePaneOutput('agent-a');
    const snap = tel.flushNow();
    assert.ok(snap);
    assert.equal(sent.length, 1);
    assert.ok(Array.isArray(snap.boundaries));
    for (const op of snap.operations) {
      assert.match(op.operation, OP_NAME_RE);
      assert.equal(typeof op.count, 'number');
      assert.ok(Array.isArray(op.buckets));
    }
  });

  it('windowSnapshot is read-only (curling the endpoint never splits the window)', () => {
    const { tel, clock } = makeHarness();
    tel.noteInputWritten('p1', 0.2);
    clock.advance(10);
    tel.notePaneOutput('p1');
    const a = tel.windowSnapshot();
    const b = tel.windowSnapshot();
    assert.equal(a.operations.length, b.operations.length);
    const total = (s) => s.operations.reduce((n, o) => n + o.count, 0);
    assert.equal(total(a), total(b));
    // And the window SURVIVES the snapshot: flushNow still forwards it.
    assert.ok(tel.flushNow());
  });

  it('the ledger is bounded (panes rotate oldest-out; rings cap per pane)', () => {
    const sent = [];
    let on = true;
    const clock = makeClock();
    const tel = createPaneInputTelemetry({
      consent: () => on,
      send: (s) => sent.push(s),
      aggregator: createMetricAggregator({ now: () => 0 }),
      now: clock.now,
      ledgerMaxPanes: 2,
      ledgerRing: 3,
    });
    for (const key of ['p1', 'p2', 'p3']) {
      tel.noteInputWritten(key, 0.1);
      clock.advance(10);
      tel.notePaneOutput(key);
    }
    const rows = tel.ledgerSnapshot();
    assert.equal(rows.length, 2); // p1 rotated out
    assert.deepEqual(rows.map((r) => r.pane).sort(), ['p2', 'p3']);
    for (let i = 0; i < 5; i += 1) {
      tel.noteInputWritten('p3', 0.1);
      clock.advance(2);
      tel.notePaneOutput('p3');
    }
    const p3 = tel.ledgerSnapshot().find((r) => r.pane === 'p3');
    assert.equal(p3.samples, 3); // ring cap
  });

  it('ledger rows are honest: p50/p95 null on no samples, values on real ones', () => {
    const { tel, clock } = makeHarness();
    assert.deepEqual(tel.ledgerSnapshot(), []);
    tel.noteInputWritten('p1', 0.1);
    clock.advance(10);
    tel.notePaneOutput('p1');
    tel.noteInputWritten('p1', 0.1);
    clock.advance(30);
    tel.notePaneOutput('p1');
    const row = tel.ledgerSnapshot()[0];
    assert.equal(row.samples, 2);
    assert.equal(row.p50Ms, 10); // ceil(0.5*2)-1 = 0 → smallest
    assert.equal(row.p95Ms, 30); // ceil(0.95*2)-1 = 1 → largest
    assert.equal(row.maxMs, 30);
    assert.equal(typeof row.lastAt, 'number');
  });
});

describe('percentile()', () => {
  it('null on empty / non-array (an honest absence, never 0)', () => {
    assert.equal(percentile([], 50), null);
    assert.equal(percentile(null, 50), null);
    assert.equal(percentile(undefined, 95), null);
  });

  it('single sample and ordered statistics', () => {
    assert.equal(percentile([42], 50), 42);
    assert.equal(percentile([42], 95), 42);
    assert.equal(percentile([30, 10, 20], 50), 20);
    assert.equal(percentile([30, 10, 20], 95), 30);
    assert.equal(percentile([1, 2, 3, 4], 75), 3);
  });
});
