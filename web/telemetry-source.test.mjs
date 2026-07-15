// Unit tests for the telemetry SOURCE layer (WARDEN-463, slice 4 of the optional
// off-by-default telemetry client — roadmap WARDEN-446 / design WARDEN-443).
//
// electron/telemetry-source.cjs is the symmetric SOURCE path to slices 1–3's
// SINK path. It taps real Electron/Node failure + freeze signals and turns them
// into schema-valid base-tier events delivered to a consent-gated `record()`.
// Slices 1–3 are not yet shipped, so these tests inject signals + a stub
// `record()` against slice 1's documented event-type contract — the collector
// is fully testable now, independently of the sink path.
//
// Like web/window-state.test.mjs (the established pattern for "main-process
// decision logic extracted into a CJS module that main.cjs requires"), this
// loads the REAL CJS module via createRequire and exercises it with plain
// objects / fake emitters. Auto-discovered by `npm test` (`node --test` runs
// every *.test.mjs in web/).
//
// Run: node telemetry-source.test.mjs   (from web/)
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const {
  SCHEMA_VERSION,
  BASE_EVENT_TYPES,
  RUNTIME,
  UNCAUGHT_EVENT,
  REJECTION_EVENT,
  redactIdentifiers,
  parseStackFrames,
  buildErrorEvent,
  buildCrashEvent,
  buildStallEvent,
  isStall,
  validateBaseEvent,
  createTelemetrySource,
} = require('../electron/telemetry-source.cjs');

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// --- fakes ----------------------------------------------------------------

// A minimal process/webContents-like emitter with on/off/removeListener + a
// listenerCount, so we can assert the "no tap subscribed when off" invariant.
function fakeEmitter() {
  const listeners = Object.create(null);
  return {
    on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); },
    off(evt, fn) { this.removeListener(evt, fn); },
    removeListener(evt, fn) {
      if (listeners[evt]) listeners[evt] = listeners[evt].filter((f) => f !== fn);
    },
    listenerCount(evt) { return (listeners[evt] || []).length; },
    emit(evt, ...args) { for (const fn of (listeners[evt] || [])) fn(...args); },
  };
}

// A controllable clock + scheduler so the heartbeat lag is deterministic.
function fakeClock() {
  const state = { now: 1000, tickFn: null, handle: null, cleared: false, intervalMs: null };
  return {
    now: () => state.now,
    setInterval(fn, ms) {
      state.tickFn = fn;
      state.intervalMs = ms;
      state.cleared = false;
      state.handle = { id: 1 };
      return state.handle;
    },
    clearInterval() { state.tickFn = null; state.cleared = true; state.handle = null; },
    state,
  };
}

const recorder = () => {
  const calls = [];
  const fn = (event) => calls.push(event);
  fn.calls = calls;
  return fn;
};

// Build a source with FAKE timers + clock by default so no real setInterval is
// ever scheduled (a real 1000ms heartbeat would keep the Node process alive
// under the plain synchronous test runner below). Tests that exercise the
// heartbeat pass their own clock; tests that don't still get harmless fakes.
const noopTimer = () => ({ unref() {} });
function makeSource(overrides = {}) {
  return createTelemetrySource({
    now: () => 1,
    setInterval: noopTimer,
    clearInterval() {},
    ...overrides,
  });
}

// ==========================================================================
// (e) Schema conformance — contract shapes + shared schemaVersion
// ==========================================================================

test('base-tier contract: shared SCHEMA_VERSION + the three event types', () => {
  assert.equal(typeof SCHEMA_VERSION, 'number');
  assert.deepEqual(BASE_EVENT_TYPES, ['error', 'crash', 'performance-stall']);
  assert.equal(RUNTIME.MAIN, 'main');
  assert.equal(RUNTIME.RENDERER, 'renderer');
});

test('every builder event carries the shared schemaVersion and validates', () => {
  const err = buildErrorEvent(new Error('x'), { now: 5 });
  const crash = buildCrashEvent({ reason: 'oom' }, { now: 5 });
  const stall = buildStallEvent(100, { now: 5, runtime: RUNTIME.MAIN });
  for (const ev of [err, crash, stall]) {
    assert.equal(ev.schemaVersion, SCHEMA_VERSION);
    assert.ok(validateBaseEvent(ev), `event of type ${ev.type} should validate`);
  }
});

test('validateBaseEvent rejects malformed events (wrong version/type/runtime/timestamp)', () => {
  assert.equal(validateBaseEvent(null), false);
  assert.equal(validateBaseEvent({}), false);
  assert.equal(validateBaseEvent({ schemaVersion: 999, type: 'error', runtime: 'main', timestamp: 1, message: 'm', frames: [] }), false);
  assert.equal(validateBaseEvent({ schemaVersion: SCHEMA_VERSION, type: 'bogus', runtime: 'main', timestamp: 1 }), false);
  assert.equal(validateBaseEvent({ schemaVersion: SCHEMA_VERSION, type: 'error', runtime: 'worker', timestamp: 1, message: 'm', frames: [] }), false);
  assert.equal(validateBaseEvent({ schemaVersion: SCHEMA_VERSION, type: 'error', runtime: 'main', timestamp: 'oops', message: 'm', frames: [] }), false);
  // crash without reason / stall without lagMs
  assert.equal(validateBaseEvent({ schemaVersion: SCHEMA_VERSION, type: 'crash', runtime: 'renderer', timestamp: 1 }), false);
  assert.equal(validateBaseEvent({ schemaVersion: SCHEMA_VERSION, type: 'performance-stall', runtime: 'main', timestamp: 1, lagMs: 5, source: 'weird' }), false);
});

// ==========================================================================
// Collection-boundary redaction (WARDEN-443 hard exclusions: paths + hostnames)
// ==========================================================================

test('redactIdentifiers strips POSIX paths, Windows paths, UNC, ~ and hostnames/user@host', () => {
  const out = redactIdentifiers(
    'load /home/alicedoe/secrets/key.pem from C:\\Users\\bob\\app\\cfg.json then \\\\fileserver\\share\\x and ~/notes.txt; mail deploy@prod.internal; ping sync.prod.internal',
  );
  assert.ok(!out.includes('alicedoe'));
  assert.ok(!out.includes('secrets'));
  assert.ok(!out.includes('/home'));
  assert.ok(!out.includes('bob'));
  assert.ok(!out.includes('C:\\Users'));
  assert.ok(!out.includes('fileserver'));
  assert.ok(!out.includes('prod.internal'));
  assert.ok(!out.includes('deploy@'));
  assert.ok(out.includes('[path]'));
  assert.ok(out.includes('[host]'));
});

test('redactIdentifiers strips IP addresses (IPv4 + IPv6) and single-segment paths — host-equivalents are hard exclusions too', () => {
  // IPv4
  let out = redactIdentifiers('dial 10.0.0.5 and 127.0.0.1');
  assert.ok(!out.includes('10.0.0.5'));
  assert.ok(!out.includes('127.0.0.1'));
  assert.ok(out.includes('[host]'));
  // IPv6 (::1, fe80::1, 2001:db8::1)
  out = redactIdentifiers('bind fe80::1 and ::1 and 2001:db8::1');
  assert.ok(!out.includes('fe80::1'));
  assert.ok(!out.includes('::1'));
  assert.ok(!out.includes('2001:db8::1'));
  // single-segment absolute paths (the `*` not `+` form) — /etc, C:\Users
  out = redactIdentifiers('deny /etc/hosts and also /etc and C:\\Users');
  assert.ok(!out.includes('/etc/hosts'));
  assert.ok(!out.includes('/etc'));
  assert.ok(!out.includes('C:\\Users'));
});

test('redactIdentifiers leaves plain identifier-free text untouched', () => {
  assert.equal(redactIdentifiers('the agent stopped responding'), 'the agent stopped responding');
});

test('validateBaseEvent is stateless across repeated calls (no /g lastIndex leakage)', () => {
  // An event whose message would match a /g regex; validate many times in a row
  // and interleave with redaction. A stateful /g lastIndex would make later
  // calls return the wrong answer.
  const ev = buildErrorEvent(new Error('fail /home/alicedoe/x at db.prod.internal'), { now: 1 });
  for (let i = 0; i < 50; i++) {
    redactIdentifiers('mix /some/path and host.example.com'); // exercise the /g regexes
    assert.equal(validateBaseEvent(ev), true, `iteration ${i}`);
  }
});

// ==========================================================================
// (a) Main-process errors → base-tier error event, runtime main, redacted
// ==========================================================================

test('parseStackFrames keeps function + line/col, reduces file to basename (path dropped)', () => {
  const frames = parseStackFrames([
    'Error: boom',
    '    at loadKey (/home/alicedoe/secrets/key.pem:42:7)',
    '    at Object.<anonymous> (\\\\fs\\share\\net.js:8:3)',
    '    at /home/alicedoe/index.js:5:1',
    'not a frame line',
  ].join('\n'));
  assert.equal(frames.length, 3);
  assert.equal(frames[0].function, 'loadKey');
  assert.equal(frames[0].file, 'key.pem'); // basename only — directory (user/host) dropped
  assert.equal(frames[0].line, 42);
  assert.equal(frames[0].column, 7);
  assert.equal(frames[1].file, 'net.js'); // UNC host 'fs' dropped
  assert.equal(frames[2].file, 'index.js');
  // No frame file may carry a path separator (no directory, no host leak).
  for (const f of frames) {
    if (f.file) assert.ok(!f.file.includes('/') && !f.file.includes('\\'), `frame file ${f.file} must be a bare basename`);
  }
});

test('buildErrorEvent produces a schema-valid, redacted, main-runtime error event', () => {
  const err = new Error('failed /home/alicedoe/secrets/key.pem while contacting sync.prod.internal (deploy@prod.internal)');
  err.stack = [
    'Error: failed',
    '    at loadKey (/home/alicedoe/secrets/key.pem:42:7)',
    '    at connect (\\\\fileserver\\share\\app\\net.js:8:3)',
  ].join('\n');
  const ev = buildErrorEvent(err, { now: 12345, runtime: RUNTIME.MAIN });
  assert.equal(ev.type, 'error');
  assert.equal(ev.runtime, 'main');
  assert.equal(ev.timestamp, 12345);
  assert.equal(ev.schemaVersion, SCHEMA_VERSION);
  assert.equal(ev.name, 'Error');
  // message is redacted — no path/hostname/user survives
  for (const needle of ['alicedoe', 'secrets', '/home', 'key.pem', 'sync.prod.internal', 'prod.internal', 'deploy', 'fileserver']) {
    assert.ok(!ev.message.includes(needle), `message must not leak "${needle}" (got: ${ev.message})`);
  }
  assert.ok(validateBaseEvent(ev));
});

test('buildErrorEvent runtime defaults to main; renderer opt-in', () => {
  assert.equal(buildErrorEvent(new Error('x'), { now: 1 }).runtime, 'main');
  assert.equal(buildErrorEvent(new Error('x'), { now: 1, runtime: RUNTIME.RENDERER }).runtime, 'renderer');
});

// ==========================================================================
// (b) Renderer crash → base-tier crash event
// ==========================================================================

test('buildCrashEvent maps render-process-gone details to a renderer crash event', () => {
  const ev = buildCrashEvent({ reason: 'oom', exitCode: 133 }, { now: 9 });
  assert.equal(ev.type, 'crash');
  assert.equal(ev.runtime, 'renderer'); // render-process-gone is the renderer by definition
  assert.equal(ev.reason, 'oom');
  assert.equal(ev.exitCode, 133);
  assert.equal(ev.schemaVersion, SCHEMA_VERSION);
  assert.ok(validateBaseEvent(ev));
});

test('buildCrashEvent tolerates missing/odd details', () => {
  const ev = buildCrashEvent(null, { now: 1 });
  assert.equal(ev.reason, 'unknown');
  assert.equal(ev.exitCode, undefined);
  assert.ok(validateBaseEvent(ev));
});

// ==========================================================================
// (c) Event-loop freeze heartbeat → performance-stall over threshold, else none
// ==========================================================================

test('isStall is true only when the overdue gap exceeds the threshold', () => {
  assert.equal(isStall(100, 100), false); // equal is NOT a stall (strictly greater)
  assert.equal(isStall(101, 100), true);
  assert.equal(isStall(99, 100), false);
});

test('buildStallEvent produces a schema-valid stall carrying lagMs + source', () => {
  const ev = buildStallEvent(750, { now: 3, runtime: RUNTIME.MAIN, source: 'event-loop' });
  assert.equal(ev.type, 'performance-stall');
  assert.equal(ev.runtime, 'main');
  assert.equal(ev.lagMs, 750);
  assert.equal(ev.source, 'event-loop');
  assert.ok(validateBaseEvent(ev));
  // unresponsive renderer hang → renderer runtime, unresponsive source, lag clamped to 0
  const hang = buildStallEvent(-5, { now: 4, runtime: RUNTIME.RENDERER, source: 'unresponsive' });
  assert.equal(hang.runtime, 'renderer');
  assert.equal(hang.source, 'unresponsive');
  assert.equal(hang.lagMs, 0);
  assert.ok(validateBaseEvent(hang));
});

test('source heartbeat: tick over threshold → stall; under threshold → nothing', () => {
  const clock = fakeClock();
  const record = recorder();
  const src = createTelemetrySource({
    record, now: clock.now, setInterval: clock.setInterval, clearInterval: clock.clearInterval,
    heartbeatMs: 500, thresholdMs: 100,
  });
  src.setBaseConsent(true); // starts the heartbeat; lastTick = now() = 1000
  assert.ok(clock.state.tickFn, 'heartbeat scheduled when consent turns on');
  assert.equal(clock.state.intervalMs, 500);

  // Tick 1: arrived 250ms late → overdue 250 > 100 → stall.
  clock.state.now = 1000 + 500 + 250; // 1750
  clock.state.tickFn();
  assert.equal(record.calls.length, 1);
  assert.equal(record.calls[0].type, 'performance-stall');
  assert.equal(record.calls[0].runtime, 'main');
  assert.equal(record.calls[0].source, 'event-loop');
  assert.ok(record.calls[0].lagMs > 100);

  // Tick 2: arrived 10ms late → overdue 10 < 100 → NO event.
  clock.state.now = 1750 + 500 + 10; // 2260
  clock.state.tickFn();
  assert.equal(record.calls.length, 1, 'under-threshold tick must not record');
});

// ==========================================================================
// (d) Consent gate — off = no tap subscribed, no event built (two layers)
// ==========================================================================

test('with consent OFF, no tap is subscribed and no event is built or recorded', () => {
  const clock = fakeClock();
  const record = recorder();
  const src = createTelemetrySource({ record, now: clock.now, setInterval: clock.setInterval, clearInterval: clock.clearInterval });
  const proc = fakeEmitter();
  const wc = fakeEmitter();
  src.attachMain(proc);
  src.attachRenderer(wc);
  assert.equal(src.isConsentOn(), false);

  // No listeners attached, no heartbeat started.
  assert.equal(proc.listenerCount(UNCAUGHT_EVENT), 0);
  assert.equal(proc.listenerCount(REJECTION_EVENT), 0);
  assert.equal(wc.listenerCount('render-process-gone'), 0);
  assert.equal(wc.listenerCount('unresponsive'), 0);
  assert.equal(clock.state.tickFn, null);

  // Emitting signals anyway must record nothing.
  proc.emit(UNCAUGHT_EVENT, new Error('nope'));
  proc.emit(REJECTION_EVENT, 'nope');
  wc.emit('render-process-gone', {}, { reason: 'crashed' });
  wc.emit('unresponsive');
  assert.equal(record.calls.length, 0);
});

test('consent ON subscribes taps; turning it back OFF detaches everything and stops the heartbeat', () => {
  const clock = fakeClock();
  const record = recorder();
  const src = createTelemetrySource({ record, now: clock.now, setInterval: clock.setInterval, clearInterval: clock.clearInterval });
  const proc = fakeEmitter();
  const wc = fakeEmitter();
  src.attachMain(proc);
  src.attachRenderer(wc);

  src.setBaseConsent(true);
  assert.equal(proc.listenerCount(UNCAUGHT_EVENT), 1);
  assert.equal(wc.listenerCount('render-process-gone'), 1);
  assert.ok(clock.state.tickFn, 'heartbeat running while consent on');

  src.setBaseConsent(false);
  assert.equal(proc.listenerCount(UNCAUGHT_EVENT), 0);
  assert.equal(proc.listenerCount(REJECTION_EVENT), 0);
  assert.equal(wc.listenerCount('render-process-gone'), 0);
  assert.equal(wc.listenerCount('unresponsive'), 0);
  assert.equal(clock.state.tickFn, null, 'heartbeat stopped on consent off');

  // Signals emitted after consent off must record nothing further.
  proc.emit(UNCAUGHT_EVENT, new Error('after off'));
  assert.equal(record.calls.length, 0);
});

// ==========================================================================
// End-to-end through the source: each signal family routes to record() (a/b/d)
// ==========================================================================

test('injected uncaughtException + unhandledRejection route to error events when consent on', () => {
  const record = recorder();
  const src = makeSource({ record });
  const proc = fakeEmitter();
  src.attachMain(proc);
  src.setBaseConsent(true);

  // uncaught with a real Error carrying an identifying path → redacted error event.
  proc.emit(UNCAUGHT_EVENT, new Error('bad /home/alicedoe/x'));
  // unhandledRejection with a NON-Error reason is still wrapped into an error event.
  proc.emit(REJECTION_EVENT, { code: 'EWHATEVER', msg: 'rejection /etc/secret' });

  assert.equal(record.calls.length, 2);
  for (const ev of record.calls) {
    assert.equal(ev.type, 'error');
    assert.equal(ev.runtime, 'main');
    assert.equal(ev.schemaVersion, SCHEMA_VERSION);
    assert.ok(validateBaseEvent(ev));
  }
  assert.ok(!record.calls[0].message.includes('alicedoe'));
  assert.ok(!record.calls[1].message.includes('/etc/secret'));
});

test('injected render-process-gone routes to a crash event; unresponsive to a renderer stall', () => {
  const record = recorder();
  const src = makeSource({ record });
  const wc = fakeEmitter();
  src.attachRenderer(wc);
  src.setBaseConsent(true);

  // Electron calls render-process-gone handlers as (event, details).
  wc.emit('render-process-gone', {}, { reason: 'oom', exitCode: 7 });
  wc.emit('unresponsive');

  assert.equal(record.calls.length, 2);
  assert.equal(record.calls[0].type, 'crash');
  assert.equal(record.calls[0].runtime, 'renderer');
  assert.equal(record.calls[0].reason, 'oom');
  assert.equal(record.calls[0].exitCode, 7);
  assert.equal(record.calls[1].type, 'performance-stall');
  assert.equal(record.calls[1].runtime, 'renderer');
  assert.equal(record.calls[1].source, 'unresponsive');
  for (const ev of record.calls) assert.ok(validateBaseEvent(ev), `${ev.type} must validate`);
});

// ==========================================================================
// Robustness — a telemetry sink must never throw the host into a worse state
// ==========================================================================

test('a throwing record() sink is swallowed (telemetry must not crash the app)', () => {
  const src = makeSource({ record: () => { throw new Error('sink down'); } });
  const proc = fakeEmitter();
  src.attachMain(proc);
  src.setBaseConsent(true);
  assert.doesNotThrow(() => proc.emit(UNCAUGHT_EVENT, new Error('x')));
});

test('setRecord hot-swaps the sink (slice 1 wiring seam); default no-sink records nothing', () => {
  const src = makeSource(); // no record provided
  const proc = fakeEmitter();
  src.attachMain(proc);
  src.setBaseConsent(true);
  proc.emit(UNCAUGHT_EVENT, new Error('x'));
  // no sink wired yet → nothing recorded, no throw
  const record = recorder();
  src.setRecord(record);
  proc.emit(UNCAUGHT_EVENT, new Error('y'));
  assert.equal(record.calls.length, 1);
  assert.equal(record.calls[0].message, 'y');
});

test('attachMain/attachRenderer re-attach cleanly when the window emitter is replaced', () => {
  const record = recorder();
  const src = makeSource({ record });
  const wc1 = fakeEmitter();
  const wc2 = fakeEmitter();
  src.attachRenderer(wc1);
  src.setBaseConsent(true);
  assert.equal(wc1.listenerCount('render-process-gone'), 1);
  // A new BrowserWindow replaces webContents — re-attach must not double-bind.
  src.attachRenderer(wc2);
  assert.equal(wc1.listenerCount('render-process-gone'), 0);
  assert.equal(wc2.listenerCount('render-process-gone'), 1);
  wc2.emit('render-process-gone', {}, { reason: 'killed' });
  assert.equal(record.calls.length, 1);
});

test('dispose detaches all taps + stops the heartbeat', () => {
  const clock = fakeClock();
  const src = createTelemetrySource({ record: () => {}, now: clock.now, setInterval: clock.setInterval, clearInterval: clock.clearInterval });
  const proc = fakeEmitter();
  const wc = fakeEmitter();
  src.attachMain(proc);
  src.attachRenderer(wc);
  src.setBaseConsent(true);
  assert.ok(clock.state.tickFn);
  src.dispose();
  assert.equal(proc.listenerCount(UNCAUGHT_EVENT), 0);
  assert.equal(wc.listenerCount('render-process-gone'), 0);
  assert.equal(clock.state.tickFn, null);
  assert.equal(src.isConsentOn(), false);
});

console.log(`\n✓ TELEMETRY-SOURCE TESTS PASS (${passed})`);
