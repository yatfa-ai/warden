import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

/**
 * WARDEN-1406 — the server runtime's suspension discrimination, driven through
 * the REAL arming path src/server.js wires at module scope.
 *
 * The unit suites prove the two halves in isolation (web/suspend-clock.test.mjs
 * the tracker's boundary semantics; src/loop-monitor.test.js the monitor's
 * skip/skip/fail-open regimes). What can only be proven HERE is the seam
 * between them and the fork boundary this slice exists to cross:
 *
 *   • the standalone server arms NOTHING (the byte-for-byte contract — a
 *     standalone `node src/server.js` has no parent to send it windows);
 *   • the forked arming path (the same function production runs) registers the
 *     fork's IPC listener, feeds the tracker from the wire messages, and arms
 *     the REAL monitor policy;
 *   • the window-store boundary spec, mirroring web/suspend-clock.test.mjs's
 *     ten tests, over a store FED BY MESSAGES rather than by live events —
 *     replay + open + close, in the fork's role;
 *   • end to end: IPC message → tracker → predicate → a monitor whose
 *     heartbeat measures a "sleep" skips it, and a genuine post-wake block
 *     still records. No synthetic injection anywhere in the chain.
 *
 * HOME is redirected to a temp dir BEFORE importing server.js (server.js reads
 * config eagerly at module load), following src/server-stall-telemetry.test.js.
 * node --test runs each file in its own process, so registering the listener on
 * the real `process` never cross-talks with the other server-*.test.js files.
 */

const requireCjs = createRequire(import.meta.url);
const { createSuspendClock } = requireCjs('../electron/suspend-clock.cjs');

let server;
let loopMonitorMod;

before(async () => {
  const originalHome = process.env.HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-suspend-arm-'));
  fs.mkdirSync(path.join(tempHome, '.yatfa-warden'), { recursive: true });
  fs.writeFileSync(path.join(tempHome, '.yatfa-warden', 'config.json'), JSON.stringify({ hosts: [] }));
  process.env.HOME = tempHome;

  server = await import('./server.js');
  loopMonitorMod = await import('./loop-monitor.js');
  await loopMonitorMod; // imported for createLoopMonitor below
  // Restore HOME — the eager config read is done; later tests must see the real env.
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

after(() => {
  // If any test left the real singleton armed / the real process listening,
  // take it down so the file's own later tests see pristine state.
  server.__setupSuspensionDiscriminationForTest({ forked: true })?.dispose?.();
});

const WALL_BASE = 1_700_000_000_000;

/** A monotonic + wall fake clock in ONE shared timeline (wall = base + mono). */
function fakeClock(start = 1000) {
  let t = start;
  return {
    now: () => t,
    wallClock: () => WALL_BASE + t,
    advance(ms) { t += ms; return t; },
  };
}

describe('WARDEN-1406 — the standalone server arms NOTHING (byte-for-byte contract)', () => {
  it('module scope, run without a fork IPC channel, left the singleton unarmed', () => {
    // The test runner gives this process no process.send, so the module-scope
    // setupSuspensionDiscrimination() call took the standalone branch — the
    // same branch a bare `node src/server.js` takes.
    assert.equal(typeof process.send, 'undefined', 'precondition: the runner is not a fork');
    assert.equal(loopMonitorMod.loopMonitor.config.maxCredibleLagMs, null, 'no ceiling armed');
    assert.equal(loopMonitorMod.loopMonitor.config.suspendAware, false, 'no predicate armed');
    assert.equal(process.listenerCount('message'), 0, 'no IPC listener registered');
  });

  it('an explicit forked:false is a no-op returning null and touching nothing', () => {
    const before = loopMonitorMod.loopMonitor.config;
    const out = server.__setupSuspensionDiscriminationForTest({ forked: false });
    assert.equal(out, null);
    assert.deepEqual(loopMonitorMod.loopMonitor.config, before);
    assert.equal(process.listenerCount('message'), 0);
  });
});

describe('WARDEN-1406 — the forked arming path, driven over the REAL process IPC event', () => {
  let setup;

  after(() => { if (setup) { setup.dispose(); setup = null; } });

  it('arms the REAL singleton: ceiling + wall-domain predicate + the message listener', () => {
    setup = server.__setupSuspensionDiscriminationForTest({ forked: true });
    assert.ok(setup, 'the forked branch ran');
    assert.equal(loopMonitorMod.loopMonitor.config.maxCredibleLagMs, 60000);
    assert.equal(loopMonitorMod.loopMonitor.config.suspendAware, true);
    assert.equal(process.listenerCount('message'), 1, 'the fork\u2019s first (and only) message listener');
  });

  it('a malformed or foreign message is ignored without corrupting the store', () => {
    const probes = [
      null,
      'a raw string from a careless sender',
      42,
      { type: 'telemetry-metrics', snapshot: {} }, // another producer\u2019s message on the same channel
      { type: 'telemetry-suspend-open' },          // missing at
      { type: 'telemetry-suspend-open', at: 'not-a-number' },
      { type: 'telemetry-suspend-close', from: 1 }, // missing to
      { type: 'telemetry-suspend-close', to: 'x' },
      { type: 'telemetry-suspend-replay', windows: 'nope' },
      { type: 'telemetry-suspend-replay', windows: [{ from: 'a', to: 5 }, null, { from: 9, to: 4 }] },
    ];
    for (const msg of probes) {
      assert.doesNotThrow(() => process.emit('message', msg));
    }
    assert.deepEqual(setup.clock.snapshot(), { closed: [], openFrom: null }, 'nothing ingested');
  });

  it('replay feeds closed windows verbatim; a post-replay quiet window is clean', () => {
    process.emit('message', {
      type: 'telemetry-suspend-replay',
      windows: [{ from: WALL_BASE + 5000, to: WALL_BASE + 61000 }],
      openAt: null,
    });
    assert.equal(setup.clock.stats().closedWindows, 1);
    // Boundary spec (mirrors web/suspend-clock.test.mjs), wall domain:
    assert.equal(setup.clock.spansSuspend(WALL_BASE + 5500, WALL_BASE + 62000), true, 'wake tick spans');
    assert.equal(setup.clock.spansSuspend(WALL_BASE + 61000, WALL_BASE + 63000), true, 'resume-instant touching counts');
    assert.equal(setup.clock.spansSuspend(WALL_BASE + 61001, WALL_BASE + 63000), false, 'strictly after the resume is clean');
    assert.equal(setup.clock.spansSuspend(WALL_BASE + 0, WALL_BASE + 4999), false, 'pre-suspend is clean');
  });

  it('live open/close messages track the same lifecycle main\u2019s own tracker does', () => {
    process.emit('message', { type: 'telemetry-suspend-open', at: WALL_BASE + 100000 });
    assert.equal(setup.clock.stats().suspendedNow, true, 'the open window is tracked');
    assert.equal(setup.clock.spansSuspend(WALL_BASE + 100500, WALL_BASE + 101000), true, 'a still-open suspend spans');
    assert.equal(setup.clock.spansSuspend(WALL_BASE + 99000, WALL_BASE + 99999), false, 'before it does not');

    // Idempotent double open — the OS repeating itself is not a second sleep.
    process.emit('message', { type: 'telemetry-suspend-open', at: WALL_BASE + 100001 });
    assert.equal(setup.clock.stats().suspendedNow, true);

    process.emit('message', { type: 'telemetry-suspend-close', from: WALL_BASE + 100000, to: WALL_BASE + 161000 });
    assert.equal(setup.clock.stats().suspendedNow, false, 'the close cleared the in-flight state');
    assert.equal(setup.clock.stats().closedWindows, 2, 'replayed window + this one');
    assert.equal(setup.clock.spansSuspend(WALL_BASE + 161000, WALL_BASE + 162000), true, 'resume-instant touching counts');
    assert.equal(setup.clock.spansSuspend(WALL_BASE + 161001, WALL_BASE + 162000), false, 'strictly after is clean');

    // A close with no open on record is dropped (the tracker\u2019s own resume semantics).
    process.emit('message', { type: 'telemetry-suspend-close', from: WALL_BASE + 5, to: WALL_BASE + 6 });
    assert.equal(setup.clock.stats().closedWindows, 2, 'no phantom window');
  });

  it('a replay carrying an in-flight suspend (fork spawned mid-sleep) tracks and then closes', () => {
    // Fresh store: a dispose + re-setup gives this test its own tracker on the
    // same real singleton wiring.
    setup.dispose();
    setup = server.__setupSuspensionDiscriminationForTest({ forked: true });
    process.emit('message', {
      type: 'telemetry-suspend-replay',
      windows: [{ from: WALL_BASE + 1000, to: WALL_BASE + 2000 }],
      openAt: WALL_BASE + 3000,
    });
    assert.equal(setup.clock.snapshot().openFrom, WALL_BASE + 3000);
    assert.equal(setup.clock.spansSuspend(WALL_BASE + 2500, WALL_BASE + 4000), true, 'the open replayed suspend spans');
    process.emit('message', { type: 'telemetry-suspend-close', from: WALL_BASE + 3000, to: WALL_BASE + 12000 });
    assert.equal(setup.clock.snapshot().openFrom, null, 'closed');
    assert.equal(setup.clock.stats().closedWindows, 2);
  });

  it('dispose disarms the REAL singleton and removes the listener', () => {
    setup.dispose();
    setup = null;
    assert.equal(loopMonitorMod.loopMonitor.config.maxCredibleLagMs, null);
    assert.equal(loopMonitorMod.loopMonitor.config.suspendAware, false);
    assert.equal(process.listenerCount('message'), 0);
    // A message after dispose is simply unheard.
    assert.doesNotThrow(() => process.emit('message', { type: 'telemetry-suspend-open', at: 1 }));
  });
});

describe('WARDEN-1406 — end to end: IPC message → tracker → predicate → monitor tick', () => {
  it('a fed sleep skips as suspendedSkips; a genuine post-wake block still records', () => {
    const clock = fakeClock();
    const stalls = [];
    // A THROWAWAY monitor with the same create-time shape the shared singleton
    // has (no opts) — arming goes through the SAME production seam, with fake
    // clocks so the "sleep" is drivable in microseconds.
    const monitor = loopMonitorMod.createLoopMonitor({
      heartbeatMs: 1000,
      thresholdMs: 1000,
      now: clock.now,
      wallClock: clock.wallClock,
      onStall: (r) => stalls.push(r),
    });
    assert.equal(monitor.config.suspendAware, false, 'precondition: created bare');
    const setup = server.__setupSuspensionDiscriminationForTest({ forked: true, monitor });
    try {
      // The fork is born; main replays an OLD suspend and then a live one.
      process.emit('message', {
        type: 'telemetry-suspend-replay',
        windows: [{ from: WALL_BASE + 500, to: WALL_BASE + 900 }],
        openAt: null,
      });
      process.emit('message', { type: 'telemetry-suspend-open', at: WALL_BASE + 5000 });
      process.emit('message', { type: 'telemetry-suspend-close', from: WALL_BASE + 5000, to: WALL_BASE + 61000 });

      monitor.start(); // lastTick = 1000, lastWall = base + 1000
      clock.advance(1000);
      monitor.tick(); // quiet tick at 2000
      // The machine slept 5000→61000 (wall) and wakes; the first tick lands at
      // 61300 — overdue by 58300ms, inside the magnitude ceiling, and its wall
      // gap (base+2000, base+61300) SPANS the suspend window.
      clock.advance(61300 - 2000);
      const skipped = monitor.tick();
      assert.equal(skipped, null, 'the wake tick produces no record');
      assert.equal(monitor.stats().suspendedSkips, 1);
      assert.equal(stalls.length, 0);

      // A genuine post-wake block: its wall gap starts strictly after the resume.
      clock.advance(1000 + 1500);
      const recorded = monitor.tick();
      assert.ok(recorded, 'a real post-wake block records');
      assert.equal(recorded.lagMs, 1500);
      assert.equal(stalls.length, 1);
      assert.equal(monitor.stats().suspendedSkips, 1);
    } finally {
      setup.dispose();
      monitor.stop();
    }
  });

  it('a sleep above the magnitude ceiling skips even with an EMPTY window store', () => {
    const clock = fakeClock();
    const stalls = [];
    const monitor = loopMonitorMod.createLoopMonitor({
      heartbeatMs: 1000,
      thresholdMs: 1000,
      now: clock.now,
      wallClock: clock.wallClock,
      onStall: (r) => stalls.push(r),
    });
    const setup = server.__setupSuspensionDiscriminationForTest({ forked: true, monitor });
    try {
      // No replay, no open/close — the store is empty, as a fork\u2019s is before
      // its first forwarded window. The ceiling still holds the 12-hour line.
      monitor.start();
      clock.advance(1000);
      monitor.tick();
      clock.advance(1000 + 43474684); // the live dataset\u2019s 12-hour sleep, verbatim
      monitor.tick();
      monitor.stop();
      assert.equal(stalls.length, 0);
      assert.equal(monitor.stats().suspendedSkips, 1);
    } finally {
      setup.dispose();
      monitor.stop();
    }
  });

  it('fail-open: an empty store plus a sub-ceiling block records the stall (never swallows)', () => {
    const clock = fakeClock();
    const stalls = [];
    const monitor = loopMonitorMod.createLoopMonitor({
      heartbeatMs: 1000,
      thresholdMs: 1000,
      now: clock.now,
      wallClock: clock.wallClock,
      onStall: (r) => stalls.push(r),
    });
    const setup = server.__setupSuspensionDiscriminationForTest({ forked: true, monitor });
    try {
      monitor.start();
      clock.advance(1000);
      monitor.tick();
      clock.advance(1000 + 1954); // a human-scale block — nothing about a suspend in sight
      monitor.tick();
      monitor.stop();
      assert.equal(stalls.length, 1, 'the discrimination must not eat genuine stalls');
      assert.equal(stalls[0].lagMs, 1954);
      assert.equal(monitor.stats().suspendedSkips, 0);
    } finally {
      setup.dispose();
      monitor.stop();
    }
  });
});
