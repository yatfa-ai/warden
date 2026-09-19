import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  createLoopMonitor,
  instrumentSyncIo,
  isStall,
  attributeStall,
  buildStallRecord,
  formatStallLine,
  normalizeLabel,
  summarizeSyncTotals,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_STALL_THRESHOLD_MS,
  MAX_ATTRIBUTION_ENTRIES,
  MAX_LABEL_LENGTH,
  MAX_SYNC_AGGREGATE_LABELS,
  SYNC_AGGREGATE_OVERFLOW_LABEL,
  STALL_TYPE,
  STALL_SOURCE,
  STALL_RUNTIME,
} from './loop-monitor.js';

/**
 * Unit suite for the SERVER event-loop stall monitor (WARDEN-977).
 *
 * The whole point of this module is that a multi-second block of the forked
 * server child produces a durable, ATTRIBUTABLE signal — so the tests are
 * written around the two failure directions that would make it worthless:
 *
 *   FALSE NEGATIVE — a real stall produces nothing (the defect this ticket
 *     exists to fix; three passes failed because nothing observed the child).
 *   FALSE POSITIVE — normal operation produces stall noise, which would make the
 *     signal unreadable and the instrumentation a cost of its own.
 *
 * Both clocks are injected, so every decision here is verified WITHOUT waiting
 * on real time. The companion suite src/loop-monitor-live.test.js proves the same
 * behavior with REAL timers and a REAL block, which is the claim a fake clock
 * cannot make.
 */

// A controllable monotonic clock + a wall clock derived from it.
function fakeClock(start = 1000) {
  let t = start;
  return {
    now: () => t,
    wallClock: () => 1_700_000_000_000 + t,
    advance(ms) { t += ms; return t; },
  };
}

function makeMonitor(overrides = {}) {
  const clock = fakeClock();
  const stalls = [];
  const monitor = createLoopMonitor({
    heartbeatMs: 1000,
    thresholdMs: 1000,
    now: clock.now,
    wallClock: clock.wallClock,
    onStall: (r) => stalls.push(r),
    ...overrides,
  });
  return { monitor, clock, stalls };
}

describe('isStall — the shared threshold rule', () => {
  it('is a stall only when the overdue gap EXCEEDS the threshold', () => {
    assert.equal(isStall(1500, 1000), true);
    assert.equal(isStall(1000, 1000), false, 'exactly at the threshold is not a stall');
    assert.equal(isStall(999, 1000), false);
  });

  it('defaults to the same threshold as the main-process heartbeat', () => {
    assert.equal(DEFAULT_HEARTBEAT_INTERVAL_MS, 1000);
    assert.equal(DEFAULT_STALL_THRESHOLD_MS, 1000);
    assert.equal(isStall(1200), true);
    assert.equal(isStall(800), false);
  });

  it('rejects non-finite / non-numeric input rather than reporting a stall', () => {
    assert.equal(isStall(NaN, 1000), false);
    assert.equal(isStall(Infinity, 1000), false);
    assert.equal(isStall('4000', 1000), false);
    assert.equal(isStall(undefined, 1000), false);
  });
});

describe('attributeStall — naming the work that held the loop', () => {
  it('ranks overlapping spans by how much of the blocked window they cover', () => {
    // Blocked window: [1000, 4000].
    const spans = [
      { label: 'sweep:lifecycle', start: 900, end: 3900 },   // 2900ms of overlap
      { label: 'GET /api/config', start: 3000, end: 4100 },  // 1000ms of overlap
      { label: 'GET /api/health', start: 100, end: 500 },    // finished before: none
    ];
    const out = attributeStall(spans, 1000, 4000);
    assert.deepEqual(out.map((a) => a.label), ['sweep:lifecycle', 'GET /api/config']);
    assert.equal(out[0].overlapMs, 2900);
    assert.equal(out[1].overlapMs, 1000);
    assert.equal(out[0].durationMs, 3000);
  });

  it('treats a still-open span as running through the end of the window and flags it', () => {
    const out = attributeStall([{ label: 'GET /api/config', start: 2000, end: null }], 1000, 4000);
    assert.equal(out.length, 1);
    assert.equal(out[0].open, true);
    assert.equal(out[0].overlapMs, 2000);
  });

  it('returns an HONEST empty list when nothing instrumented was running', () => {
    // A stall with no overlapping span must not invent a culprit — the empty
    // attribution is itself the finding ("the blocker is somewhere we do not
    // instrument yet"), and formatStallLine says so in words.
    assert.deepEqual(attributeStall([{ label: 'old', start: 0, end: 100 }], 1000, 4000), []);
    assert.deepEqual(attributeStall([], 1000, 4000), []);
    assert.deepEqual(attributeStall(null, 1000, 4000), []);
  });

  it('ignores a zero-length or inverted window instead of dividing the blame', () => {
    const spans = [{ label: 'x', start: 0, end: null }];
    assert.deepEqual(attributeStall(spans, 4000, 4000), []);
    assert.deepEqual(attributeStall(spans, 4000, 1000), []);
  });

  it('caps the lead list so one busy window cannot produce an unreadable record', () => {
    const spans = Array.from({ length: MAX_ATTRIBUTION_ENTRIES + 5 }, (_, i) => ({
      label: `req-${i}`, start: 1000 + i, end: 4000,
    }));
    assert.equal(attributeStall(spans, 1000, 4000).length, MAX_ATTRIBUTION_ENTRIES);
  });

  it('skips malformed span entries (a hole in the ring is not a culprit)', () => {
    const spans = [null, undefined, { label: 'no-start' }, { label: 'real', start: 1000, end: 4000 }];
    const out = attributeStall(spans, 1000, 4000);
    assert.deepEqual(out.map((a) => a.label), ['real']);
  });
});

describe('label hygiene', () => {
  it('truncates a long label and defaults an empty one', () => {
    assert.equal(normalizeLabel('x'.repeat(200)).length, MAX_LABEL_LENGTH);
    assert.equal(normalizeLabel(''), 'unknown');
    assert.equal(normalizeLabel(undefined), 'unknown');
    assert.equal(normalizeLabel(42), 'unknown');
  });
});

describe('buildStallRecord / formatStallLine — one stall vocabulary', () => {
  it('reuses the main-process performance-stall shape and tags the server runtime', () => {
    const record = buildStallRecord({
      lagMs: 8432.7,
      attribution: [{ label: 'fs.readFileSync', overlapMs: 8300, open: false, durationMs: 8300 }],
      timestamp: 1_700_000_000_000,
      heartbeatMs: 1000,
      thresholdMs: 1000,
      uptimeMs: 61_000,
      pid: 4242,
    });
    // Same vocabulary as electron/telemetry-source.cjs: type + lagMs + source.
    assert.equal(record.type, STALL_TYPE);
    assert.equal(record.type, 'performance-stall');
    assert.equal(record.source, STALL_SOURCE);
    assert.equal(record.runtime, STALL_RUNTIME);
    assert.equal(record.runtime, 'server');
    assert.equal(record.lagMs, 8433, 'lag is rounded to a whole millisecond');
    assert.equal(record.timestamp, new Date(1_700_000_000_000).toISOString());
    assert.equal(record.pid, 4242);
    assert.equal(record.uptimeMs, 61_000);
    assert.equal(record.attribution[0].label, 'fs.readFileSync');
  });

  it('formats a one-line human summary naming the duration and the culprit', () => {
    const line = formatStallLine({
      lagMs: 8433,
      attribution: [
        { label: 'sweep:lifecycle', overlapMs: 8400, open: true },
        { label: 'fs.statSync', overlapMs: 8300, open: false },
      ],
    });
    assert.match(line, /\[warden:stall\]/);
    assert.match(line, /8433ms/);
    assert.match(line, /sweep:lifecycle \(8400ms, still open\)/);
    assert.match(line, /fs\.statSync \(8300ms\)/);
  });

  it('says so explicitly when nothing instrumented was running', () => {
    const line = formatStallLine({ lagMs: 3000, attribution: [] });
    assert.match(line, /nothing instrumented was running/);
  });
});

describe('createLoopMonitor — detection (the false-negative direction)', () => {
  it('emits a stall with a plausible lag and attribution when the loop is blocked', () => {
    const { monitor, clock, stalls } = makeMonitor();
    monitor.start();

    // One normal tick, then a labeled unit of work that blocks for 5s.
    clock.advance(1000);
    monitor.tick();
    const span = monitor.begin('GET /api/config');
    clock.advance(5000); // the loop is blocked here: no tick could run
    monitor.tick();      // the heartbeat fires late — this is the detection

    assert.equal(stalls.length, 1, 'a 5s block must produce exactly one stall record');
    const [record] = stalls;
    // 5000ms elapsed against a 1000ms cadence → 4000ms overdue.
    assert.equal(record.lagMs, 4000);
    assert.equal(record.type, 'performance-stall');
    assert.equal(record.runtime, 'server');
    assert.deepEqual(record.attribution.map((a) => a.label), ['GET /api/config']);
    assert.equal(record.attribution[0].open, true, 'the request was still open when the loop unblocked');
    monitor.end(span);
    monitor.stop();
  });

  it('attributes to a measured synchronous op that finished inside the window', () => {
    const { monitor, clock, stalls } = makeMonitor();
    monitor.start();
    clock.advance(1000);
    monitor.tick();

    // A sweep runs, and inside it a synchronous read blocks for 3s.
    const sweep = monitor.begin('sweep:lifecycle');
    clock.advance(3000);
    monitor.recordSyncOp('fs.readFileSync', 2900);
    monitor.end(sweep);
    clock.advance(50);
    monitor.tick();

    assert.equal(stalls.length, 1);
    const labels = stalls[0].attribution.map((a) => a.label);
    assert.ok(labels.includes('fs.readFileSync'), `expected the sync op in ${JSON.stringify(labels)}`);
    assert.ok(labels.includes('sweep:lifecycle'));
    // The reported overlap is the part of the op inside the BLOCKED WINDOW (the
    // overdue gap ending at the late tick), not the op's full duration — the
    // window is deliberately the tight one, since a synchronous block always ends
    // when the loop is released and therefore always overlaps it. Here: a 2050ms
    // gap, of which the 2900ms read covers 2000ms.
    const sync = stalls[0].attribution.find((a) => a.label === 'fs.readFileSync');
    assert.equal(stalls[0].lagMs, 2050);
    assert.equal(sync.overlapMs, 2000);
    assert.equal(sync.durationMs, 2900, 'the full measured duration is reported alongside the overlap');
    monitor.stop();
  });

  it('counts stalls and tracks the worst lag across several blocks', () => {
    const { monitor, clock } = makeMonitor();
    monitor.start();
    for (const block of [1000, 6000, 3000]) {
      clock.advance(block);
      monitor.tick();
    }
    const stats = monitor.stats();
    assert.equal(stats.stalls, 2, 'the 1000ms tick is on cadence; the 6s and 3s blocks are stalls');
    assert.equal(stats.worstLagMs, 5000);
    assert.equal(stats.ticks, 3);
    monitor.stop();
  });

  it('DOES report a block that lands between start() and the first tick (startup counts)', () => {
    // start() takes a baseline reading, so the very first interval is judged like
    // any other. That is deliberate: synchronous boot work — a config read, a
    // seeded sweep — is exactly the kind of blocker this ticket is hunting, and a
    // "grace period" would hide the one stall the owner is most likely to hit.
    const { monitor, clock, stalls } = makeMonitor();
    monitor.start();
    clock.advance(60_000);
    const record = monitor.tick();
    assert.ok(record, 'a 60s block right after start is still a stall');
    assert.equal(record.lagMs, 59_000);
    assert.equal(stalls.length, 1);
    monitor.stop();
  });

  it('keeps the recent-stall ring bounded', () => {
    const { monitor, clock } = makeMonitor({ stallRingSize: 3 });
    monitor.start();
    for (let i = 0; i < 6; i++) { clock.advance(5000); monitor.tick(); }
    assert.equal(monitor.stalls().length, 3);
    assert.equal(monitor.stats().stalls, 6, 'the counter still sees every stall');
    monitor.stop();
  });

  it('keeps the span ring bounded (an always-on monitor cannot grow memory)', () => {
    const { monitor } = makeMonitor({ spanRingSize: 4 });
    for (let i = 0; i < 50; i++) monitor.end(monitor.begin(`req-${i}`));
    assert.equal(monitor._spans().length, 4);
    assert.equal(monitor.stats().spansRecorded, 50);
  });
});

describe('createLoopMonitor — silence (the false-positive direction)', () => {
  it('emits NOTHING across normal operation, including sub-threshold jitter', () => {
    const { monitor, clock, stalls } = makeMonitor();
    monitor.start();
    // 30 ticks of ordinary cadence with realistic jitter (GC, scheduler noise),
    // every one of them under the threshold.
    for (const jitter of Array.from({ length: 30 }, (_, i) => [0, 15, 120, 400, 999][i % 5])) {
      clock.advance(1000 + jitter);
      monitor.tick();
    }
    assert.equal(stalls.length, 0, 'normal operation must produce no stall noise');
    assert.equal(monitor.stats().stalls, 0);
    monitor.stop();
  });

  it('is fully inert before start(): no record, no sink call, spans still recorded', () => {
    const { monitor, clock, stalls } = makeMonitor();
    monitor.end(monitor.begin('GET /api/config'));
    clock.advance(9000);
    assert.equal(monitor.tick(), null, 'without a start there is no previous tick to compare');
    assert.equal(stalls.length, 0);
    assert.equal(monitor.started, false);
    assert.ok(monitor._spans().length >= 1, 'spans are cheap and are kept, so an early stall is attributable');
  });

  it('stop() ends the interval and resets the baseline so a restart does not fire retroactively', () => {
    const { monitor, clock, stalls } = makeMonitor();
    monitor.start();
    clock.advance(1000);
    monitor.tick();
    monitor.stop();
    assert.equal(monitor.started, false);
    clock.advance(30_000); // long gap while stopped
    monitor.start();
    clock.advance(1000);
    monitor.tick();
    assert.equal(stalls.length, 0, 'the stopped gap must not be reported as a stall');
    monitor.stop();
  });

  it('drops sub-floor synchronous ops from the RING (the ring stays signal, not noise)', () => {
    const { monitor } = makeMonitor({ syncFloorMs: 100 });
    assert.equal(monitor.recordSyncOp('fs.existsSync', 0.2), null);
    assert.equal(monitor.recordSyncOp('fs.existsSync', 99), null);
    assert.ok(monitor.recordSyncOp('fs.readFileSync', 100), 'at the floor is recorded');
    assert.equal(monitor.stats().syncOpsRecorded, 1);
    // ...but it still SAW all three. `syncOpsRecorded: 0` must never be the only
    // number an owner has, or "nothing crossed the floor" reads as "no sync I/O".
    assert.equal(monitor.stats().syncOpsSeen, 3);
    assert.equal(monitor.stats().syncMsSeen, 199);
  });

  it('a sink that throws cannot take the server down', () => {
    const { monitor, clock } = makeMonitor({ onStall: () => { throw new Error('disk on fire'); } });
    monitor.start();
    clock.advance(1000); monitor.tick();
    clock.advance(5000);
    assert.doesNotThrow(() => monitor.tick());
    assert.equal(monitor.stats().stalls, 1, 'the stall is still counted and ringed');
    monitor.stop();
  });
});

describe('sync aggregate — the stall built from many cheap calls', () => {
  it('reports "N calls totalling Xms" for a stall no single op could explain', () => {
    // THE SHAPE THIS EXISTS FOR: server.js's archive scan does a statSync per
    // row and observer.js does a statSync per file, so on a machine with real
    // history an 8-second block is thousands of 2ms calls. Every one of them is
    // below the ring floor, so the ring shows zero sync spans and the record
    // would read as "synchronous I/O was not involved" — the same false
    // exoneration a missing method in SYNC_FS_METHODS produces.
    const { monitor, clock, stalls } = makeMonitor({ syncFloorMs: 100 });
    monitor.start();
    clock.advance(1000);
    monitor.tick();

    const sweep = monitor.begin('sweep:lifecycle');
    for (let i = 0; i < 4000; i++) monitor.recordSyncOp('fs.statSync', 2);
    monitor.recordSyncOp('fs.openSync', 3);
    clock.advance(8000);
    monitor.end(sweep);
    monitor.tick();

    assert.equal(stalls.length, 1);
    const [record] = stalls;
    assert.equal(record.attribution.length, 1, 'no sync op crossed the ring floor');
    assert.deepEqual(record.attribution.map((a) => a.label), ['sweep:lifecycle']);
    // ...and yet the synchronous cost is fully accounted for.
    assert.deepEqual(record.syncTotals, [
      { label: 'fs.statSync', calls: 4000, totalMs: 8000 },
      { label: 'fs.openSync', calls: 1, totalMs: 3 },
    ]);
    assert.equal(monitor.stats().syncOpsRecorded, 0, 'the ring is untouched — this is the aggregate half');
    monitor.stop();
  });

  it('covers the window it reports on: a tick resets the aggregate', () => {
    const { monitor, clock, stalls } = makeMonitor({ syncFloorMs: 100 });
    monitor.start();
    // Quiet window: real sync work, no stall. It must not be charged to a LATER
    // stall, or every record inherits the noise of the seconds before it.
    monitor.recordSyncOp('fs.readdirSync', 40);
    clock.advance(1000);
    monitor.tick();
    assert.equal(stalls.length, 0);

    monitor.recordSyncOp('fs.statSync', 12);
    clock.advance(5000);
    monitor.tick();

    assert.deepEqual(stalls[0].syncTotals, [{ label: 'fs.statSync', calls: 1, totalMs: 12 }]);
    monitor.stop();
  });

  it('emits an empty aggregate — not a fabricated one — when no sync op ran', () => {
    const { monitor, clock, stalls } = makeMonitor();
    monitor.start();
    clock.advance(1000); monitor.tick();
    clock.advance(5000); monitor.tick();
    assert.deepEqual(stalls[0].syncTotals, [], 'a CPU-bound block must not name a file operation');
    monitor.stop();
  });

  it('bounds the label count so a dynamic label cannot grow the map', () => {
    const { monitor } = makeMonitor({ syncFloorMs: 100 });
    for (let i = 0; i < MAX_SYNC_AGGREGATE_LABELS + 20; i++) monitor.recordSyncOp(`op-${i}`, 5);
    const totals = monitor._syncTotals();
    // The overflow is FOLDED, not dropped: the calls still add up.
    const seen = totals.reduce((n, t) => n + t.calls, 0);
    assert.ok(totals.some((t) => t.label === SYNC_AGGREGATE_OVERFLOW_LABEL), 'overflow bucket exists');
    assert.ok(seen <= MAX_SYNC_AGGREGATE_LABELS + 20);
    assert.equal(monitor.stats().syncOpsSeen, MAX_SYNC_AGGREGATE_LABELS + 20, 'every call is counted');
  });

  it('ignores a nonsense duration instead of poisoning the totals', () => {
    const { monitor } = makeMonitor({ syncFloorMs: 0 });
    assert.equal(monitor.recordSyncOp('fs.statSync', NaN), null);
    assert.equal(monitor.recordSyncOp('fs.statSync', -5), null);
    assert.equal(monitor.recordSyncOp('fs.statSync', '900'), null);
    assert.deepEqual(monitor._syncTotals(), []);
    assert.equal(monitor.stats().syncOpsSeen, 0);
  });

  it('summarizeSyncTotals ranks by total cost and caps the list', () => {
    const agg = new Map([
      ['fs.existsSync', { calls: 900, totalMs: 90 }],
      ['fs.statSync', { calls: 4000, totalMs: 7901.4 }],
      ['fs.readFileSync', { calls: 2, totalMs: 400 }],
      ['never-called', { calls: 0, totalMs: 0 }],
    ]);
    assert.deepEqual(summarizeSyncTotals(agg), [
      { label: 'fs.statSync', calls: 4000, totalMs: 7901 },
      { label: 'fs.readFileSync', calls: 2, totalMs: 400 },
      { label: 'fs.existsSync', calls: 900, totalMs: 90 },
    ]);
    assert.deepEqual(summarizeSyncTotals(null), []);
    const many = new Map(Array.from({ length: 20 }, (_, i) => [`op-${i}`, { calls: 1, totalMs: i }]));
    assert.equal(summarizeSyncTotals(many).length, MAX_ATTRIBUTION_ENTRIES);
  });

  it('puts the aggregate on the stderr line the owner actually reads', () => {
    const line = formatStallLine({
      lagMs: 7950,
      attribution: [{ label: 'GET /api/claude-sessions', overlapMs: 7900, open: true }],
      syncTotals: [{ label: 'fs.statSync', calls: 4000, totalMs: 7901 }],
    });
    assert.match(line, /sync: fs\.statSync ×4000 7901ms/);
    // A record without an aggregate keeps the original one-line shape.
    assert.equal(formatStallLine({ lagMs: 3000, attribution: [] }).includes('| sync:'), false);
  });
});

describe('trace — wrapping work without changing its behavior', () => {
  it('returns the resolved value and closes the span', async () => {
    const { monitor } = makeMonitor();
    const value = await monitor.trace('sweep:budget', async () => 'ok');
    assert.equal(value, 'ok');
    const span = monitor._spans().at(-1);
    assert.equal(span.label, 'sweep:budget');
    assert.notEqual(span.end, null);
  });

  it('preserves a rejection (identity and reason) and still closes the span', async () => {
    const { monitor } = makeMonitor();
    const boom = new Error('sweep failed');
    await assert.rejects(
      () => monitor.trace('sweep:lifecycle', async () => { throw boom; }),
      (err) => err === boom,
    );
    assert.notEqual(monitor._spans().at(-1).end, null);
  });

  it('propagates a synchronous throw and still closes the span', () => {
    const { monitor } = makeMonitor();
    assert.throws(() => monitor.trace('sync-work', () => { throw new Error('nope'); }), /nope/);
    assert.notEqual(monitor._spans().at(-1).end, null);
  });

  it('passes a non-promise return value straight through', () => {
    const { monitor } = makeMonitor();
    assert.equal(monitor.trace('sync-work', () => 7), 7);
  });
});

describe('instrumentSyncIo — attribution down to the blocking call', () => {
  // Fakes, not the real builtins: the wrapper's transparency is what is under
  // test, and patching real fs inside a test runner would leak across files.
  function fakeModules({ readCost = 0 } = {}) {
    const calls = [];
    const fs = {
      readFileSync(file, enc) {
        calls.push(['readFileSync', file, enc]);
        const until = performance.now() + readCost;
        while (performance.now() < until) { /* deliberate synchronous block */ }
        return `contents of ${file}`;
      },
      existsSync() { return true; },
      throwsSync() { throw new Error('ENOENT'); },
      notAFunction: 42,
    };
    const childProcess = {
      spawnSync(cmd) { return { cmd, status: 0 }; },
      thisSensitive() { return this === childProcess ? 'bound' : 'unbound'; },
    };
    return { fs, childProcess, calls };
  }

  it('records a slow call under a `module.method` label and leaves a fast one out', () => {
    const { monitor } = makeMonitor({ syncFloorMs: 25 });
    const { fs, childProcess } = fakeModules({ readCost: 60 });
    const restore = instrumentSyncIo(monitor, {
      fs,
      childProcess,
      fsMethods: ['readFileSync', 'existsSync', 'throwsSync', 'notAFunction'],
      childProcessMethods: ['spawnSync'],
    });

    assert.equal(fs.readFileSync('/tmp/x', 'utf8'), 'contents of /tmp/x', 'return value is passed through');
    fs.existsSync('/tmp/x'); // fast → below the floor

    const labels = monitor._spans().map((s) => s.label);
    assert.deepEqual(labels, ['fs.readFileSync'], `expected only the slow call, got ${JSON.stringify(labels)}`);
    const span = monitor._spans()[0];
    assert.ok(span.end - span.start >= 25, 'the recorded span carries the measured duration');
    restore();
  });

  it('records a call that THROWS (a failing sync op can still be the blocker)', () => {
    const { monitor } = makeMonitor({ syncFloorMs: 0 });
    const { fs } = fakeModules();
    const restore = instrumentSyncIo(monitor, { fs, fsMethods: ['throwsSync'] });
    assert.throws(() => fs.throwsSync(), /ENOENT/);
    assert.deepEqual(monitor._spans().map((s) => s.label), ['fs.throwsSync']);
    restore();
  });

  it('is transparent: `this`, arguments, return value, and the function name survive', () => {
    const { monitor } = makeMonitor({ syncFloorMs: 0 });
    const { fs, childProcess, calls } = fakeModules();
    const restore = instrumentSyncIo(monitor, {
      fs,
      childProcess,
      fsMethods: ['readFileSync'],
      childProcessMethods: ['spawnSync', 'thisSensitive'],
    });
    fs.readFileSync('/etc/hosts', 'utf8');
    assert.deepEqual(calls[0], ['readFileSync', '/etc/hosts', 'utf8'], 'arguments are forwarded verbatim');
    assert.deepEqual(childProcess.spawnSync('git'), { cmd: 'git', status: 0 });
    assert.equal(childProcess.thisSensitive(), 'bound', 'the receiver is preserved');
    assert.equal(fs.readFileSync.name, 'readFileSync', 'the wrapper keeps the original name');
    restore();
  });

  it('carries over a sibling property hung off the original function', () => {
    // `fs.realpathSync.native` is the real-world case: a builtin whose function
    // object owns another function. A wrapper that dropped it would break a
    // caller at runtime — with the sync probe on and only in production, which is
    // the worst possible place to find out.
    const { monitor } = makeMonitor({ syncFloorMs: 0 });
    const native = () => 'native result';
    const fs = { realpathSync: Object.assign(() => 'resolved', { native }) };
    const restore = instrumentSyncIo(monitor, { fs, fsMethods: ['realpathSync'] });
    assert.equal(fs.realpathSync('/tmp'), 'resolved');
    assert.equal(typeof fs.realpathSync.native, 'function', 'the sibling survived the patch');
    assert.equal(fs.realpathSync.native(), 'native result');
    restore();
    assert.equal(fs.realpathSync.native, native);
  });

  it('exposes the original for introspection (and proves a patch is in place)', () => {
    const { monitor } = makeMonitor({ syncFloorMs: 0 });
    const { fs } = fakeModules();
    const original = fs.readFileSync;
    const restore = instrumentSyncIo(monitor, { fs, fsMethods: ['readFileSync'] });
    assert.equal(fs.readFileSync.__loopMonitorOriginal, original);
    restore();
    assert.equal(fs.readFileSync.__loopMonitorOriginal, undefined);
  });

  it('restore() puts the originals back (no permanent patch)', () => {    const { monitor } = makeMonitor({ syncFloorMs: 0 });
    const { fs } = fakeModules();
    const original = fs.readFileSync;
    const restore = instrumentSyncIo(monitor, { fs, fsMethods: ['readFileSync'] });
    assert.notEqual(fs.readFileSync, original);
    restore();
    assert.equal(fs.readFileSync, original);
    fs.readFileSync('/tmp/y');
    assert.equal(monitor._spans().length, 0, 'a restored module records nothing');
  });

  it('skips absent / non-function members and a missing module object', () => {
    const { monitor } = makeMonitor({ syncFloorMs: 0 });
    const { fs } = fakeModules();
    assert.doesNotThrow(() => {
      const restore = instrumentSyncIo(monitor, { fs, fsMethods: ['nope', 'notAFunction'] });
      restore();
    });
    assert.doesNotThrow(() => instrumentSyncIo(monitor, {})());
    assert.equal(fs.notAFunction, 42);
  });

  it('never lets a recording failure break the call it measures', () => {
    const brokenMonitor = { recordSyncOp() { throw new Error('ring exploded'); } };
    const { fs } = fakeModules();
    const restore = instrumentSyncIo(brokenMonitor, { fs, fsMethods: ['readFileSync'] });
    assert.equal(fs.readFileSync('/tmp/z'), 'contents of /tmp/z');
    restore();
  });
});

// ==========================================================================
// WARDEN-1376 — main-process reuse + suspension discrimination.
// The Electron main process creates the SAME monitor with runtime:'main' and
// opts into the two suspension discriminators (magnitude ceiling +
// suspend-boundary predicate). Server defaults stay byte-for-byte: no ceiling,
// no predicate, runtime 'server'.
// ==========================================================================
describe('WARDEN-1376 — runtime tag + suspension discrimination', () => {
  it("defaults keep the server's identity and no suppression arms", () => {
    const { monitor } = makeMonitor();
    assert.equal(monitor.config.runtime, 'server');
    assert.equal(monitor.config.maxCredibleLagMs, null);
    assert.equal(monitor.config.suspendAware, false);
  });

  it("runtime:'main' stamps main into the record and the stderr line", () => {
    const { monitor, clock, stalls } = makeMonitor({ runtime: 'main' });
    monitor.start();
    clock.advance(1000);
    monitor.tick();
    clock.advance(3000);
    monitor.tick();
    monitor.stop();
    assert.equal(stalls.length, 1);
    assert.equal(stalls[0].runtime, 'main');
    const line = formatStallLine(stalls[0]);
    assert.match(line, /\[warden:stall\] main event loop blocked/);
  });

  it('formatStallLine keeps saying server for legacy/untagged records', () => {
    assert.match(formatStallLine({ lagMs: 1234, attribution: [], syncTotals: [] }), /server event loop blocked 1234ms/);
  });

  it('a lag above maxCredibleLagMs is a suspension — no record, skip counted', () => {
    const { monitor, clock, stalls } = makeMonitor({ runtime: 'main', maxCredibleLagMs: 60000 });
    monitor.start();
    clock.advance(1000);
    monitor.tick();
    clock.advance(1000 + 43474684); // the live dataset's 12-hour sleep, verbatim
    monitor.tick();
    monitor.stop();
    assert.equal(stalls.length, 0, 'a 12-hour "lag" is a sleep artifact, never a stall');
    assert.equal(monitor.stats().suspendedSkips, 1);
    assert.equal(monitor.stats().stalls, 0);
  });

  it('a lag inside the ceiling still records — only the absurd magnitudes are dropped', () => {
    const { monitor, clock, stalls } = makeMonitor({ runtime: 'main', maxCredibleLagMs: 60000 });
    monitor.start();
    clock.advance(1000);
    monitor.tick();
    clock.advance(1000 + 1954); // the mid-use 1954ms block from the live dataset
    monitor.tick();
    monitor.stop();
    assert.equal(stalls.length, 1, 'a real ~2s block must still be recorded');
    assert.equal(stalls[0].lagMs, 1954);
    assert.equal(monitor.stats().suspendedSkips, 0);
  });

  it('a lag window spanning a suspend→resume boundary is skipped (resume storm)', () => {
    const suspendWindows = [{ from: 5000, to: 61000 }];
    const isSuspendBoundary = (from, to) =>
      suspendWindows.some((w) => w.from < to && w.to >= from);
    const { monitor, clock, stalls } = makeMonitor({
      runtime: 'main',
      isSuspendBoundary,
      // no ceiling — isolate the boundary arm
    });
    monitor.start();
    clock.advance(1000);
    monitor.tick();               // lastTick = 2000
    // The machine suspends at 5000 and resumes at 61000 (clock jumped); the
    // wake tick lands at 61300 → window (2000, 61300) straddles the boundary.
    clock.advance(61300 - 2000);
    monitor.tick();
    monitor.stop();
    assert.equal(stalls.length, 0, 'the wake tick + its storm is the OS, not a loop block');
    assert.equal(monitor.stats().suspendedSkips, 1);
  });

  it('a quiet window after the wake still records normally', () => {
    const suspendWindows = [{ from: 5000, to: 61000 }];
    const isSuspendBoundary = (from, to) =>
      suspendWindows.some((w) => w.from < to && w.to >= from);
    const { monitor, clock, stalls } = makeMonitor({ runtime: 'main', isSuspendBoundary });
    monitor.start();
    clock.advance(1000);
    monitor.tick();
    clock.advance(61300 - 2000);
    monitor.tick();               // wake tick — skipped
    clock.advance(1000 + 1500);   // a genuine post-wake block
    monitor.tick();
    monitor.stop();
    assert.equal(stalls.length, 1, 'post-wake real blocks stay visible');
    assert.equal(monitor.stats().suspendedSkips, 1);
  });

  it('a THROWING suspend predicate degrades to recording the stall', () => {
    const { monitor, clock, stalls } = makeMonitor({
      runtime: 'main',
      isSuspendBoundary: () => { throw new Error('boom'); },
    });
    monitor.start();
    clock.advance(1000);
    monitor.tick();
    clock.advance(1000 + 2000);
    monitor.tick();
    monitor.stop();
    assert.equal(stalls.length, 1, 'a broken discriminator must not swallow real stalls');
  });

  it('buildStallRecord accepts an explicit runtime without disturbing the default', () => {
    assert.equal(buildStallRecord({ lagMs: 100, timestamp: 0 }).runtime, 'server');
    assert.equal(buildStallRecord({ lagMs: 100, timestamp: 0, runtime: 'main' }).runtime, 'main');
  });
});

// ==========================================================================
// WARDEN-1406 — post-creation arming seam + wall-domain predicate args.
// The shared singleton is created with NO options, so the server fork arms the
// two discriminators through setSuspendPolicy instead of create-time opts. The
// tick also hands the predicate the WALL-CLOCK bounds of the tick gap as extra
// arguments — the load-bearing clock-domain conversion (suspend windows are
// wall stamps; the lag math is monotonic) that main's two-argument predicate
// ignores and the server's compares wall vs wall.
// ==========================================================================
describe('WARDEN-1406 — setSuspendPolicy (post-creation arming) + wall bounds', () => {
  it('created-with-no-opts stays unarmed, and config reflects arming through the seam', () => {
    const { monitor } = makeMonitor({});
    assert.equal(monitor.config.maxCredibleLagMs, null, 'the server default is byte-for-byte');
    assert.equal(monitor.config.suspendAware, false);
    monitor.setSuspendPolicy({ maxCredibleLagMs: 60000, isSuspendBoundary: () => false });
    assert.equal(monitor.config.maxCredibleLagMs, 60000, 'config is a getter — it tracks the seam');
    assert.equal(monitor.config.suspendAware, true);
  });

  it('arms the ceiling post-creation: a 12-hour lag skips with suspendedSkips counted', () => {
    const { monitor, clock, stalls } = makeMonitor({});
    monitor.setSuspendPolicy({ maxCredibleLagMs: 60000 });
    monitor.start();
    clock.advance(1000);
    monitor.tick();
    clock.advance(1000 + 43474684); // the live dataset's 12-hour sleep, verbatim
    monitor.tick();
    monitor.stop();
    assert.equal(stalls.length, 0, 'the sleep artifact must not become a server stall');
    assert.equal(monitor.stats().suspendedSkips, 1);
    assert.equal(monitor.stats().stalls, 0);
  });

  it('hands the predicate the WALL bounds of the tick gap as extra arguments', () => {
    let seen = null;
    const { monitor, clock, stalls } = makeMonitor({});
    monitor.setSuspendPolicy({
      isSuspendBoundary: (from, to, wallFrom, wallTo) => {
        seen = { from, to, wallFrom, wallTo };
        return false; // report — the point is the arguments, not the verdict
      },
    });
    monitor.start(); // lastTick=1000, lastWall = base + 1000
    clock.advance(1000);
    monitor.tick();
    clock.advance(3000); // overdue = 5000 - 2000 - 1000 = 2000 → a stall
    monitor.tick();
    monitor.stop();
    assert.equal(stalls.length, 1, 'a false predicate reports the stall');
    // Monotonic pair exactly as before; wall pair is the PREVIOUS tick's wall
    // stamp and this tick's — the wall image of the gap the block occupied.
    // Wider than the lag window by at most one heartbeat at the start edge,
    // never narrower.
    assert.deepEqual(seen, {
      from: 3000,
      to: 5000,
      wallFrom: 1_700_000_000_000 + 2000,
      wallTo: 1_700_000_000_000 + 5000,
    });
  });

  it('a wall-domain predicate (the server-side shape) skips a lag whose wall gap spans a suspend', () => {
    // The exact shape src/server.js arms: suspend windows in WALL time, the
    // predicate compares the wall pair only.
    const suspendWindows = [{ from: 1_700_000_000_000 + 5000, to: 1_700_000_000_000 + 61000 }];
    const isSuspendBoundary = (from, to, wallFrom, wallTo) =>
      suspendWindows.some((w) => w.from < wallTo && w.to >= wallFrom);
    const { monitor, clock, stalls } = makeMonitor({});
    monitor.setSuspendPolicy({ isSuspendBoundary });
    monitor.start();
    clock.advance(1000);
    monitor.tick(); // tick at 2000 — wall 1.7e12+2000
    clock.advance(61300 - 2000);
    monitor.tick(); // wake tick — wall 1.7e12+61300, wall gap (…+2000, …+61300) spans the window
    monitor.stop();
    assert.equal(stalls.length, 0, 'the sleep measured in the wall domain is skipped');
    assert.equal(monitor.stats().suspendedSkips, 1);
  });

  it('a wall-domain predicate reports a genuine post-wake block (resume-instant touching counts, later does not)', () => {
    const resumeAt = 1_700_000_000_000 + 61000;
    const suspendWindows = [{ from: 1_700_000_000_000 + 5000, to: resumeAt }];
    const isSuspendBoundary = (from, to, wallFrom, wallTo) =>
      suspendWindows.some((w) => w.from < wallTo && w.to >= wallFrom);
    const { monitor, clock, stalls } = makeMonitor({});
    monitor.setSuspendPolicy({ isSuspendBoundary });
    monitor.start();
    clock.advance(1000);
    monitor.tick();
    clock.advance(61300 - 2000);
    monitor.tick(); // wake tick — skipped (its wall gap touches the resume instant)
    clock.advance(1000 + 1500);
    monitor.tick(); // a genuine post-wake block — wall gap starts strictly after the resume
    monitor.stop();
    assert.equal(stalls.length, 1, 'post-wake real blocks stay visible');
    assert.equal(stalls[0].lagMs, 1500);
    assert.equal(monitor.stats().suspendedSkips, 1);
  });

  it('a THROWING predicate armed through the seam degrades to recording the stall', () => {
    const { monitor, clock, stalls } = makeMonitor({});
    monitor.setSuspendPolicy({ isSuspendBoundary: () => { throw new Error('boom'); } });
    monitor.start();
    clock.advance(1000);
    monitor.tick();
    clock.advance(1000 + 2000);
    monitor.tick();
    monitor.stop();
    assert.equal(stalls.length, 1, 'a broken discriminator must not swallow real stalls');
  });

  it("main's two-argument predicate signature keeps working through the seam (extra args ignored)", () => {
    const suspendWindows = [{ from: 5000, to: 61000 }];
    const isSuspendBoundary = (from, to) =>
      suspendWindows.some((w) => w.from < to && w.to >= from); // exactly main.cjs's arrow
    const { monitor, clock, stalls } = makeMonitor({});
    monitor.setSuspendPolicy({ isSuspendBoundary });
    monitor.start();
    clock.advance(1000);
    monitor.tick();
    clock.advance(61300 - 2000);
    monitor.tick();
    monitor.stop();
    assert.equal(stalls.length, 0, 'the 2-arg predicate is called with the same monotonic pair as before');
    assert.equal(monitor.stats().suspendedSkips, 1);
  });

  it('invalid values disarm the matching knob instead of half-arming it', () => {
    const { monitor } = makeMonitor({});
    monitor.setSuspendPolicy({ maxCredibleLagMs: 60000, isSuspendBoundary: () => true });
    assert.equal(monitor.config.maxCredibleLagMs, 60000);
    assert.equal(monitor.config.suspendAware, true);
    monitor.setSuspendPolicy({ maxCredibleLagMs: 0, isSuspendBoundary: 'nope' });
    assert.equal(monitor.config.maxCredibleLagMs, null, 'a non-positive ceiling disarms');
    assert.equal(monitor.config.suspendAware, false, 'a non-function predicate disarms');
    // Keys left absent keep their current value; a non-object argument is a no-op.
    monitor.setSuspendPolicy({ maxCredibleLagMs: 1000 });
    assert.equal(monitor.config.maxCredibleLagMs, 1000);
    monitor.setSuspendPolicy(null);
    monitor.setSuspendPolicy('nope');
    assert.equal(monitor.config.maxCredibleLagMs, 1000, 'a malformed call changes nothing');
  });

  it('arming through the seam while started takes effect on the next tick', () => {
    // The seam exists because the singleton is LONG-LIVED: the policy can land
    // after start() and must be read per tick, not captured once.
    const { monitor, clock, stalls } = makeMonitor({});
    monitor.start();
    clock.advance(1000);
    monitor.tick();
    clock.advance(1000 + 43474684);
    monitor.tick(); // unarmed yet — today's behavior: a record
    monitor.setSuspendPolicy({ maxCredibleLagMs: 60000 });
    clock.advance(1000 + 43474684);
    monitor.tick(); // armed now — a skip
    monitor.stop();
    assert.equal(stalls.length, 1, 'the pre-arm tick reported as always');
    assert.equal(monitor.stats().suspendedSkips, 1, 'the post-arm tick skipped');
    assert.equal(monitor.stats().stalls, 1);
  });
});
