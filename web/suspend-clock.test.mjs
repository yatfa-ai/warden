// Unit tests for the pure suspend-window tracker (WARDEN-1376).
//
// electron/suspend-clock.cjs is the piece that lets both stall detectors (the
// telemetry source's heartbeat and the main process's local loop monitor) tell
// a SUSPENDED machine from a BLOCKED one — the distinction the live telemetry
// could not make: 6 of 9 retained main-runtime stall events were 44
// minutes–12 hours of laptop sleep measured as "lag". main.cjs wires
// powerMonitor suspend/resume into this tracker; these tests verify the
// tracking + overlap decisions with an injected clock (no Electron, no real
// time), per the window-state.cjs pattern.
//
// Run: node suspend-clock.test.mjs   (from web/)
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { createSuspendClock, DEFAULT_MAX_WINDOWS } = require('../electron/suspend-clock.cjs');

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// A controllable wall clock.
function fakeClock(start = 1000) {
  let t = start;
  return {
    now: () => t,
    advance(ms) { t += ms; return t; },
  };
}

test('a suspend with no resume does not span a window that ended before it', () => {
  const clock = fakeClock();
  const sc = createSuspendClock({ now: clock.now });
  clock.advance(5000);
  sc.onSuspend(); // suspended at 6000, never resumed (or resume not delivered yet)
  assert.equal(sc.spansSuspend(0, 5999), false, 'window before the suspend is untouched');
  assert.equal(sc.spansSuspend(6001, 7000), true, 'a window after the suspend point spans the OPEN suspend');
  assert.equal(sc.stats().suspendedNow, true);
});

test('a suspend→resume window overlaps a lag window that straddles the wake', () => {
  const clock = fakeClock();
  const sc = createSuspendClock({ now: clock.now });
  clock.advance(1000);
  sc.onSuspend(); // suspend at 2000
  clock.advance(60000);
  sc.onResume(); // resume at 62000
  assert.equal(sc.stats().suspendedNow, false);
  // Wake tick: window from BEFORE the sleep to after the wake → spans.
  assert.equal(sc.spansSuspend(1500, 62500), true, 'wake tick spans the suspend window');
  // Quiet tick long after the wake → does not.
  assert.equal(sc.spansSuspend(62500, 63500), false, 'post-wake quiet window is not polluted');
  // Window entirely before the suspend → does not.
  assert.equal(sc.spansSuspend(0, 1999), false, 'pre-suspend window is clean');
});

test('a resume-storm window starting exactly at the resume instant DOES span (boundary counts)', () => {
  const clock = fakeClock();
  const sc = createSuspendClock({ now: clock.now });
  sc.onSuspend();            // suspended at 1000
  clock.advance(60000);
  sc.onResume();             // resumed at 61000 → window [1000, 61000]
  // The resume storm's block occupies roughly [61000, 63000] — it STARTS at
  // the wake, so its window (61000, 63000) touches the suspend window's END
  // boundary. Strict overlap (`w.to > from`) makes boundary-touching count:
  // contention from the wake is part of the storm.
  assert.equal(sc.spansSuspend(61000, 63000), true, 'storm window sharing the wake instant spans');
  assert.equal(sc.spansSuspend(61001, 63000), false, 'strictly after the resume does not span');
});

test('multiple suspend windows are tracked and any overlap answers true', () => {
  const clock = fakeClock();
  const sc = createSuspendClock({ now: clock.now });
  sc.onSuspend(); clock.advance(1000); sc.onResume(); // [1000, 2000]
  clock.advance(1000);
  sc.onSuspend(); clock.advance(5000); sc.onResume(); // [3000, 8000]
  assert.equal(sc.stats().closedWindows, 2);
  assert.equal(sc.spansSuspend(2500, 2600), false, 'gap between windows is clean');
  assert.equal(sc.spansSuspend(1000, 1500), true, 'first window spans');
  assert.equal(sc.spansSuspend(7500, 7600), true, 'second window spans');
});

test('a double suspend is idempotent — one open window, not two', () => {
  const clock = fakeClock();
  const sc = createSuspendClock({ now: clock.now });
  sc.onSuspend();
  clock.advance(1000);
  sc.onSuspend(); // OS repeating itself
  assert.equal(sc.stats().suspendedNow, true);
  clock.advance(1000);
  sc.onResume(); // closes ONE window, at the FIRST suspend's timestamp
  assert.equal(sc.stats().closedWindows, 1);
});

test('a resume with no suspend is ignored', () => {
  const clock = fakeClock();
  const sc = createSuspendClock({ now: clock.now });
  sc.onResume();
  assert.equal(sc.stats().closedWindows, 0);
  assert.equal(sc.stats().suspendedNow, false);
  assert.equal(sc.spansSuspend(0, 100), false);
});

test('degenerate queries are false, never throws', () => {
  const clock = fakeClock();
  const sc = createSuspendClock({ now: clock.now });
  sc.onSuspend(); clock.advance(10); sc.onResume();
  assert.equal(sc.spansSuspend(5, 5), false, 'empty range');
  assert.equal(sc.spansSuspend(10, 5), false, 'inverted range');
  assert.equal(sc.spansSuspend('a', 5), false, 'non-numeric from');
  assert.equal(sc.spansSuspend(0, null), false, 'non-numeric to');
  assert.equal(sc.spansSuspend(undefined, undefined), false);
});

test('history is bounded — oldest windows drop past the cap', () => {
  const clock = fakeClock();
  const sc = createSuspendClock({ now: clock.now, maxWindows: 3 });
  for (let i = 0; i < 10; i++) {
    sc.onSuspend();
    clock.advance(10);
    sc.onResume();
    clock.advance(10);
  }
  assert.equal(sc.stats().closedWindows, 3, 'only the newest windows are retained');
});

test('default window cap is generous (weeks of sleep cycles)', () => {
  assert.equal(DEFAULT_MAX_WINDOWS, 512);
});

test('the default clock is the wall clock (production wiring needs no now)', () => {
  const sc = createSuspendClock();
  sc.onSuspend();
  assert.equal(sc.stats().suspendedNow, true, 'tracks with real time');
  sc.onResume();
  assert.equal(sc.stats().closedWindows, 1);
});

console.log(`\n✓ SUSPEND-CLOCK TESTS PASS (${passed})`);
