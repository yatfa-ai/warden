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
// (WARDEN-637) Renderer-process JS errors → base-tier error event, runtime renderer
// A renderer error is forwarded across the contextBridge as a plain serializable
// { name, message, stack } (Error instances do not survive the clone), so
// buildErrorEvent must read that shape directly and the source exposes a
// consent-gated recordRendererError entry point for the IPC forward.
// ==========================================================================

test('buildErrorEvent reads a SERIALIZED { name, message, stack } shape directly (renderer forward, refinement B)', () => {
  // The exact shape preload.cjs forwards for a renderer error.
  const serialized = {
    name: 'TypeError',
    message: 'cannot read /home/alicedoe/secrets/key.pem of undefined at sync.prod.internal',
    stack: [
      'TypeError: cannot read of undefined',
      '    at renderRow (/home/alicedoe/app/Row.js:12:9)',
      '    at ChatSidebar (http://localhost:7421/src/ChatSidebar.tsx:88:15)',
    ].join('\n'),
  };
  const ev = buildErrorEvent(serialized, { now: 7, runtime: RUNTIME.RENDERER });
  assert.equal(ev.type, 'error');
  assert.equal(ev.runtime, 'renderer');
  assert.equal(ev.timestamp, 7);
  assert.equal(ev.schemaVersion, SCHEMA_VERSION);
  // The renderer's REAL name/message survive — NOT collapsed to '[object Object]'.
  assert.equal(ev.name, 'TypeError');
  assert.ok(ev.message.includes('cannot read'), `renderer message preserved (got: ${ev.message})`);
  assert.ok(!ev.message.includes('[object Object]'), 'must not collapse the object to [object Object]');
  // message is redacted — no path/host survives.
  for (const needle of ['alicedoe', 'secrets', '/home', 'key.pem', 'prod.internal', 'localhost']) {
    assert.ok(!ev.message.includes(needle), `message must not leak "${needle}"`);
  }
  // The renderer's frames survive, parsed from the FORWARDED stack (NOT a fresh
  // main-process stack where `new Error` would otherwise have run).
  assert.ok(ev.frames.length >= 2, `renderer frames parsed (got ${ev.frames.length})`);
  assert.equal(ev.frames[0].function, 'renderRow');
  assert.equal(ev.frames[0].file, 'Row.js'); // basename only — renderer path stripped
  assert.equal(ev.frames[0].line, 12);
  assert.equal(ev.frames[0].column, 9);
  // A renderer http:// URL is reduced to its basename too (no host leak).
  assert.equal(ev.frames[1].function, 'ChatSidebar');
  assert.equal(ev.frames[1].file, 'ChatSidebar.tsx');
  assert.ok(validateBaseEvent(ev));
});

test('buildErrorEvent serialized shape: missing name/stack degrade gracefully (still renderer-correct)', () => {
  const ev = buildErrorEvent({ message: 'just a message' }, { now: 1, runtime: RUNTIME.RENDERER });
  assert.equal(ev.name, 'Error'); // no name → 'Error'
  assert.equal(ev.message, 'just a message');
  assert.deepEqual(ev.frames, []); // no stack → no frames
  assert.ok(validateBaseEvent(ev));
});

test('buildErrorEvent serialized shape is NOT confused by a non-error object lacking a `message` field', () => {
  // A rejection reason like { code, msg } (no `message`) must NOT be read as a
  // serialized error — it falls through to the wrapping path (unchanged behavior),
  // so existing main-process callers are unaffected by the renderer-shape fix.
  const ev = buildErrorEvent({ code: 'EX', msg: 'boom /etc/secret' }, { now: 1 });
  assert.equal(ev.runtime, 'main');
  assert.equal(ev.name, 'Error');
  assert.equal(ev.message, '[object Object]'); // wrapped, as before WARDEN-637
  assert.ok(validateBaseEvent(ev));
});

test('recordRendererError: consent ON → a forwarded serialized error routes to a renderer error event', () => {
  const record = recorder();
  const src = makeSource({ record });
  src.setBaseConsent(true);
  // The exact payload the IPC handler forwards to this method.
  src.recordRendererError({
    name: 'TypeError',
    message: 'render /home/alicedoe/x threw',
    stack: '    at f (/home/alicedoe/app/x.js:1:1)',
  });
  assert.equal(record.calls.length, 1);
  const ev = record.calls[0];
  assert.equal(ev.type, 'error');
  assert.equal(ev.runtime, 'renderer'); // renderer, NOT main
  assert.equal(ev.schemaVersion, SCHEMA_VERSION);
  assert.equal(ev.name, 'TypeError');
  assert.ok(ev.message.includes('render'), `renderer message preserved (got: ${ev.message})`);
  assert.ok(!ev.message.includes('alicedoe'), 'renderer message redacted');
  assert.ok(ev.frames.length >= 1);
  assert.equal(ev.frames[0].file, 'x.js'); // renderer stack frame survives (basename)
  assert.ok(validateBaseEvent(ev));
});

test('recordRendererError: consent OFF → nothing built or recorded (gate in main, refinement D)', () => {
  const record = recorder();
  const src = makeSource({ record });
  // consent stays OFF (the default) — the preload forward still arrives, but main
  // drops it before building anything.
  src.recordRendererError({ name: 'TypeError', message: 'x', stack: '' });
  assert.equal(record.calls.length, 0);
});

test('recordRendererError: a throwing record() sink is swallowed (telemetry must not crash main)', () => {
  const src = makeSource({ record: () => { throw new Error('sink down'); } });
  src.setBaseConsent(true);
  assert.doesNotThrow(() => src.recordRendererError({ name: 'Error', message: 'x', stack: '' }));
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

// ==========================================================================
// (WARDEN-538) Extended-tier producer — focused chat/session names attach ONLY
// when extended consent is on AND a context value is held; otherwise today's
// anonymous event. Mirrors the sink client's extended-requires-base clamp.
// ==========================================================================

test('builders are pure: they attach chatName/sessionName ONLY when threaded via opts', () => {
  // No names in opts → today's anonymous event (no name keys present at all).
  const plain = buildErrorEvent(new Error('x'), { now: 1 });
  assert.equal('chatName' in plain, false);
  assert.equal('sessionName' in plain, false);
  // Names in opts → attached verbatim (the consent gate is the caller's job).
  const named = buildErrorEvent(new Error('x'), { now: 1, chatName: 'plan-a', sessionName: 'sess-1' });
  assert.equal(named.chatName, 'plan-a');
  assert.equal(named.sessionName, 'sess-1');
  // All three event types honor the same opts threading.
  assert.equal(buildCrashEvent({ reason: 'oom' }, { now: 1, chatName: 'plan-a' }).chatName, 'plan-a');
  assert.equal(buildStallEvent(50, { now: 1, runtime: RUNTIME.MAIN, chatName: 'plan-a' }).chatName, 'plan-a');
  // Empty-string / non-string names are dropped (never an empty identifier).
  const empties = buildErrorEvent(new Error('x'), { now: 1, chatName: '', sessionName: 42 });
  assert.equal('chatName' in empties, false);
  assert.equal('sessionName' in empties, false);
  // A name-bearing event still validates as a base-tier event (names are additive).
  assert.ok(validateBaseEvent(named));
});

// ==========================================================================
// (WARDEN-665) appVersion — the non-identifying base-tier release label. The
// builders attach it ONLY when a non-empty string is threaded via opts; the live
// source threads it from the createTelemetrySource({ appVersion }) factory opt.
// Omitted otherwise → today's anonymous event shape is unchanged (the optional-
// field path: a v2 event without appVersion still validates).
// ==========================================================================

test('builders are pure: they attach appVersion ONLY when a non-empty string is threaded via opts', () => {
  // No appVersion in opts → today's event (no appVersion key present at all).
  const plain = buildErrorEvent(new Error('x'), { now: 1 });
  assert.equal('appVersion' in plain, false);
  // appVersion in opts → attached verbatim (the consent gate is the caller's job).
  const versioned = buildErrorEvent(new Error('x'), { now: 1, appVersion: '0.1.19' });
  assert.equal(versioned.appVersion, '0.1.19');
  // All three event types honor the same opts threading.
  assert.equal(buildCrashEvent({ reason: 'oom' }, { now: 1, appVersion: '0.1.19' }).appVersion, '0.1.19');
  assert.equal(buildStallEvent(50, { now: 1, runtime: RUNTIME.MAIN, appVersion: '0.1.19' }).appVersion, '0.1.19');
  // Empty-string / non-string appVersion is dropped (never an empty or garbage label).
  assert.equal('appVersion' in buildErrorEvent(new Error('x'), { now: 1, appVersion: '' }), false, 'empty string dropped');
  assert.equal('appVersion' in buildErrorEvent(new Error('x'), { now: 1, appVersion: 2 }), false, 'non-string dropped');
  // A versioned event still validates as a base-tier event (appVersion is additive).
  assert.ok(validateBaseEvent(versioned));
});

test('factory appVersion opt: emitted events carry the label when provided, omit it when not', () => {
  // With the factory opt → every emitted event carries appVersion.
  const recordOn = recorder();
  const srcOn = makeSource({ record: recordOn, appVersion: '0.1.19' });
  const procOn = fakeEmitter();
  srcOn.attachMain(procOn);
  srcOn.setBaseConsent(true);
  procOn.emit(UNCAUGHT_EVENT, new Error('boom'));
  assert.equal(recordOn.calls.length, 1);
  assert.equal(recordOn.calls[0].appVersion, '0.1.19', 'emitted event carries the factory appVersion');
  assert.ok(validateBaseEvent(recordOn.calls[0]));

  // Without the opt → today's event shape (no appVersion key) — the optional-field
  // path is proven: a source that cannot read the version emits nothing new.
  const recordOff = recorder();
  const srcOff = makeSource({ record: recordOff });
  const procOff = fakeEmitter();
  srcOff.attachMain(procOff);
  srcOff.setBaseConsent(true);
  procOff.emit(UNCAUGHT_EVENT, new Error('boom'));
  assert.equal(recordOff.calls.length, 1);
  assert.equal('appVersion' in recordOff.calls[0], false, 'no appVersion key when the opt is absent');
});

test('factory appVersion opt threads to every event family (error / crash / stall)', () => {
  const record = recorder();
  const src = makeSource({ record, appVersion: '0.2.0' });
  const proc = fakeEmitter();
  const wc = fakeEmitter();
  src.attachMain(proc);
  src.attachRenderer(wc);
  src.setBaseConsent(true);

  proc.emit(UNCAUGHT_EVENT, new Error('e1'));
  wc.emit('render-process-gone', {}, { reason: 'oom' });
  wc.emit('unresponsive');

  assert.equal(record.calls.length, 3);
  for (const ev of record.calls) {
    assert.equal(ev.appVersion, '0.2.0', `${ev.type} event carries the factory appVersion`);
    assert.ok(validateBaseEvent(ev), `${ev.type} still validates`);
  }
});

// ==========================================================================
// (WARDEN-684) platform — the non-identifying base-tier OS label (darwin/win32/
// linux). Same trust posture + threading shape as appVersion: the builders attach
// it ONLY when a non-empty string is threaded via opts; the live source threads
// it from the createTelemetrySource({ platform }) factory opt (main.cjs wires
// process.platform). Omitted otherwise → today's anonymous event shape is
// unchanged (the optional-field path: a v3 event without platform still validates).
// ==========================================================================

test('builders are pure: they attach platform ONLY when a non-empty string is threaded via opts', () => {
  // No platform in opts → today's event (no platform key present at all).
  const plain = buildErrorEvent(new Error('x'), { now: 1 });
  assert.equal('platform' in plain, false);
  // platform in opts → attached verbatim (the consent gate is the caller's job).
  const labeled = buildErrorEvent(new Error('x'), { now: 1, platform: 'darwin' });
  assert.equal(labeled.platform, 'darwin');
  // All three event types honor the same opts threading.
  assert.equal(buildCrashEvent({ reason: 'oom' }, { now: 1, platform: 'win32' }).platform, 'win32');
  assert.equal(buildStallEvent(50, { now: 1, runtime: RUNTIME.MAIN, platform: 'linux' }).platform, 'linux');
  // Empty-string / non-string platform is dropped (never an empty or garbage label).
  assert.equal('platform' in buildErrorEvent(new Error('x'), { now: 1, platform: '' }), false, 'empty string dropped');
  assert.equal('platform' in buildErrorEvent(new Error('x'), { now: 1, platform: 2 }), false, 'non-string dropped');
  // A labeled event still validates as a base-tier event (platform is additive).
  assert.ok(validateBaseEvent(labeled));
});

test('factory platform opt: emitted events carry the label when provided, omit it when not', () => {
  // With the factory opt → every emitted event carries platform.
  const recordOn = recorder();
  const srcOn = makeSource({ record: recordOn, platform: 'darwin' });
  const procOn = fakeEmitter();
  srcOn.attachMain(procOn);
  srcOn.setBaseConsent(true);
  procOn.emit(UNCAUGHT_EVENT, new Error('boom'));
  assert.equal(recordOn.calls.length, 1);
  assert.equal(recordOn.calls[0].platform, 'darwin', 'emitted event carries the factory platform');
  assert.ok(validateBaseEvent(recordOn.calls[0]));

  // Without the opt → today's event shape (no platform key) — the optional-field
  // path is proven: a source that cannot read process.platform emits nothing new.
  const recordOff = recorder();
  const srcOff = makeSource({ record: recordOff });
  const procOff = fakeEmitter();
  srcOff.attachMain(procOff);
  srcOff.setBaseConsent(true);
  procOff.emit(UNCAUGHT_EVENT, new Error('boom'));
  assert.equal(recordOff.calls.length, 1);
  assert.equal('platform' in recordOff.calls[0], false, 'no platform key when the opt is absent');
});

test('factory platform opt threads to every event family (error / crash / stall)', () => {
  const record = recorder();
  const src = makeSource({ record, platform: 'linux' });
  const proc = fakeEmitter();
  const wc = fakeEmitter();
  src.attachMain(proc);
  src.attachRenderer(wc);
  src.setBaseConsent(true);

  proc.emit(UNCAUGHT_EVENT, new Error('e1'));
  wc.emit('render-process-gone', {}, { reason: 'oom' });
  wc.emit('unresponsive');

  assert.equal(record.calls.length, 3);
  for (const ev of record.calls) {
    assert.equal(ev.platform, 'linux', `${ev.type} event carries the factory platform`);
    assert.ok(validateBaseEvent(ev), `${ev.type} still validates`);
  }
});

test('(a) extended consent OFF → names NEVER attached even when context is set', () => {
  const record = recorder();
  const src = makeSource({ record });
  const proc = fakeEmitter();
  src.attachMain(proc);
  src.setBaseConsent(true); // base on, extended never enabled (default off)
  src.setContext({ chatName: 'should-not-attach', sessionName: 'nor-this' });

  proc.emit(UNCAUGHT_EVENT, new Error('boom'));
  assert.equal(record.calls.length, 1);
  assert.equal(record.calls[0].chatName, undefined, 'no chatName when extended off');
  assert.equal(record.calls[0].sessionName, undefined, 'no sessionName when extended off');

  // Explicitly setting extended OFF while context is held must also stay anonymous.
  src.setExtendedConsent(false);
  proc.emit(UNCAUGHT_EVENT, new Error('boom2'));
  assert.equal(record.calls[1].chatName, undefined);
  assert.equal(record.calls[1].sessionName, undefined);
});

test('(b) extended consent ON + context held → focused chatName attaches to every event type', () => {
  const record = recorder();
  const src = makeSource({ record });
  const proc = fakeEmitter();
  const wc = fakeEmitter();
  src.attachMain(proc);
  src.attachRenderer(wc);
  src.setBaseConsent(true);
  src.setExtendedConsent(true);
  src.setContext({ chatName: 'refactor-auth' });

  // Each signal family attaches the focused chat name; sessionName stays absent
  // (the renderer sends only chatName for now — the holder still accepts it).
  proc.emit(UNCAUGHT_EVENT, new Error('e1'));
  proc.emit(REJECTION_EVENT, 'r1');
  wc.emit('render-process-gone', {}, { reason: 'oom', exitCode: 7 });
  wc.emit('unresponsive');

  assert.equal(record.calls.length, 4);
  for (const ev of record.calls) {
    assert.equal(ev.chatName, 'refactor-auth', `${ev.type} event must carry the focused chatName`);
    assert.equal(ev.sessionName, undefined);
    assert.ok(validateBaseEvent(ev), `${ev.type} must still validate as a base event`);
  }
});

test('heartbeat stall attaches the focused chatName when extended on + context held', () => {
  const clock = fakeClock();
  const record = recorder();
  const src = createTelemetrySource({
    record, now: clock.now, setInterval: clock.setInterval, clearInterval: clock.clearInterval,
    heartbeatMs: 500, thresholdMs: 100,
  });
  src.setBaseConsent(true); // lastTick = 1000
  src.setExtendedConsent(true);
  src.setContext({ chatName: 'heartbeat-chat' });

  // Tick arrives 250ms late → overdue 250 > 100 → stall carrying the focused name.
  clock.state.now = 1000 + 500 + 250;
  clock.state.tickFn();
  assert.equal(record.calls.length, 1);
  assert.equal(record.calls[0].type, 'performance-stall');
  assert.equal(record.calls[0].chatName, 'heartbeat-chat');
});

test('(c) extended consent ON but NO context held → anonymous event (graceful)', () => {
  const record = recorder();
  const src = makeSource({ record });
  const proc = fakeEmitter();
  src.attachMain(proc);
  src.setBaseConsent(true);
  src.setExtendedConsent(true);
  // No setContext call — nothing focused yet.

  proc.emit(UNCAUGHT_EVENT, new Error('no context'));
  assert.equal(record.calls.length, 1);
  assert.equal(record.calls[0].chatName, undefined, 'no name when no context held');
  assert.equal(record.calls[0].sessionName, undefined);
  // A later context push attaches on subsequent events (recovery).
  src.setContext({ chatName: 'now-focused' });
  proc.emit(UNCAUGHT_EVENT, new Error('with context'));
  assert.equal(record.calls[1].chatName, 'now-focused');
});

test('extended-requires-base: setExtendedConsent(true) while base OFF is clamped (no names)', () => {
  const record = recorder();
  const src = makeSource({ record });
  const proc = fakeEmitter();
  src.attachMain(proc);
  src.setContext({ chatName: 'clamped' });
  // Extended on BEFORE base — must be clamped to false.
  src.setExtendedConsent(true);
  src.setBaseConsent(true); // base flips on; extended stays false (not re-affirmed)

  proc.emit(UNCAUGHT_EVENT, new Error('x'));
  assert.equal(record.calls.length, 1);
  assert.equal(record.calls[0].chatName, undefined, 'extended enabled without base must not attach names');
});

test('turning base OFF after extended on clears extended → names stop attaching', () => {
  const record = recorder();
  const src = makeSource({ record });
  const proc = fakeEmitter();
  src.attachMain(proc);
  src.setBaseConsent(true);
  src.setExtendedConsent(true);
  src.setContext({ chatName: 'going-away' });
  proc.emit(UNCAUGHT_EVENT, new Error('named'));
  assert.equal(record.calls[0].chatName, 'going-away');

  // Base off → extended is dropped (mirror of the sink client clamp).
  src.setBaseConsent(false);
  // Re-enable base without re-affirming extended: names must NOT return.
  src.setBaseConsent(true);
  proc.emit(UNCAUGHT_EVENT, new Error('anonymous again'));
  assert.equal(record.calls[1].chatName, undefined, 'base off must clear extended consent');
});

test('setContext ignores garbage: non-strings / empty / non-object never inject an identifier', () => {
  const record = recorder();
  const src = makeSource({ record });
  const proc = fakeEmitter();
  src.attachMain(proc);
  src.setBaseConsent(true);
  src.setExtendedConsent(true);
  for (const garbage of [null, undefined, 'nope', 42, { chatName: 99 }, { chatName: '' }, { sessionName: { x: 1 } }]) {
    src.setContext(garbage);
  }
  proc.emit(UNCAUGHT_EVENT, new Error('x'));
  assert.equal(record.calls.length, 1);
  assert.equal(record.calls[0].chatName, undefined);
  assert.equal(record.calls[0].sessionName, undefined);
});

test('(d) base-consent path unchanged: a base-tier (extended-off) user gets byte-identical anonymous events', () => {
  // The pre-WARDEN-538 behavior: base on, extended off. Every emitted event must
  // carry NO name keys at all — the same shape the sink always saw.
  const record = recorder();
  const src = makeSource({ record });
  const proc = fakeEmitter();
  const wc = fakeEmitter();
  src.attachMain(proc);
  src.attachRenderer(wc);
  src.setBaseConsent(true);
  // Context pushed but extended never enabled — must be a complete no-op.
  src.setContext({ chatName: 'invisible' });

  proc.emit(UNCAUGHT_EVENT, new Error('bad /home/alicedoe/x'));
  wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });

  assert.equal(record.calls.length, 2);
  for (const ev of record.calls) {
    const keys = Object.keys(ev);
    assert.ok(!keys.includes('chatName'), 'base-tier event must not carry chatName');
    assert.ok(!keys.includes('sessionName'), 'base-tier event must not carry sessionName');
    assert.ok(validateBaseEvent(ev));
  }
  // Redaction still applies (WARDEN-538 changed nothing about the message path).
  assert.ok(!record.calls[0].message.includes('alicedoe'));
});

test('dispose resets extended consent + context so a reused source starts anonymous', () => {
  const record = recorder();
  const src = makeSource({ record });
  const proc = fakeEmitter();
  src.attachMain(proc);
  src.setBaseConsent(true);
  src.setExtendedConsent(true);
  src.setContext({ chatName: 'pre-dispose' });
  src.dispose();
  // After dispose the handle holds no consent and no context; re-arming base only
  // (not extended) must yield anonymous events.
  src.attachMain(proc);
  src.setBaseConsent(true);
  proc.emit(UNCAUGHT_EVENT, new Error('x'));
  assert.equal(record.calls.length, 1);
  assert.equal(record.calls[0].chatName, undefined);
});

console.log(`\n✓ TELEMETRY-SOURCE TESTS PASS (${passed})`);
