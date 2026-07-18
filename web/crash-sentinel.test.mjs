// Unit tests for the pure crash-sentinel decision logic (WARDEN-687).
//
// electron/crash-sentinel.cjs holds every decision that must be CORRECT for the
// "detect a main-process hard kill on next launch" feature, extracted out of
// main.cjs (which requires electron and so can't run under `node --test`, and
// can't be driven in the worker sandbox where browser/Electron QA is blocked).
// These tests prove the core behavior deterministically — main.cjs only wires
// live fs + process APIs (readdirSync/readFileSync/unlinkSync/writeFileSync,
// process.kill(pid, 0)) to these decisions.
//
// Like web/window-state.test.mjs (the established pattern for "main-process
// decision logic extracted into a CJS module that main.cjs requires"), this
// loads the REAL CJS module via createRequire and exercises it with plain
// objects / a fake liveness predicate. Auto-discovered by `npm test`
// (`node --test` runs every *.test.mjs in web/).
//
// Run: node crash-sentinel.test.mjs   (from web/)
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const {
  CRASH_SENTINEL_PREFIX,
  CRASH_SENTINEL_SUFFIX,
  parseMarker,
  markerFileName,
  pidFromFileName,
  isCrashSentinelFile,
  detectCrashes,
} = require('../electron/crash-sentinel.cjs');

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// A fake liveness predicate over a Set of currently-live pids. A marker whose pid
// is in the set → alive (survivor); otherwise → dead (crashed). This is the
// INJECTED seam main.cjs fills with process.kill(pid, 0).
const livePids = (set) => (marker) => set.has(marker.pid);

console.log('\nparseMarker — defensive parse (never throws)');
test('null/undefined input → null', () => {
  assert.equal(parseMarker(null), null);
  assert.equal(parseMarker(undefined), null);
});
test('malformed JSON string → null (no throw)', () => {
  assert.equal(parseMarker('{not valid json'), null);
});
test('non-object JSON → null', () => {
  assert.equal(parseMarker('42'), null);
  assert.equal(parseMarker('"hello"'), null);
  assert.equal(parseMarker('[]'), null);
});
test('missing required pid → null', () => {
  assert.equal(parseMarker(JSON.stringify({ nonce: 'abc' })), null);
  assert.equal(parseMarker(JSON.stringify({ pid: 'oops' })), null, 'string pid rejected');
});
test('a valid marker round-trips with pid + nonce', () => {
  const m = parseMarker(JSON.stringify({ pid: 1234, nonce: 'abc-123' }));
  assert.deepEqual(m, { pid: 1234, nonce: 'abc-123' });
});
test('nonce is optional (defaults to null) — an old/lean marker still parses', () => {
  const m = parseMarker(JSON.stringify({ pid: 99 }));
  assert.equal(m.pid, 99);
  assert.equal(m.nonce, null);
});
test('a non-string nonce is normalized to null (never a garbage identifier)', () => {
  assert.equal(parseMarker(JSON.stringify({ pid: 1, nonce: 42 })).nonce, null);
  assert.equal(parseMarker(JSON.stringify({ pid: 1, nonce: '' })).nonce, null, 'empty nonce → null');
});
test('accepts a pre-parsed object too', () => {
  assert.equal(parseMarker({ pid: 7, nonce: 'n' }).pid, 7);
});

console.log('\nmarkerFileName / pidFromFileName / isCrashSentinelFile — filename round-trip');
test('markerFileName(pid) is `crash-sentinel-<pid>.json`', () => {
  assert.equal(markerFileName(1234), 'crash-sentinel-1234.json');
  assert.equal(markerFileName(1), 'crash-sentinel-1.json');
});
test('pidFromFileName round-trips markerFileName for any pid', () => {
  for (const pid of [1, 99, 65000, 999999]) {
    assert.equal(pidFromFileName(markerFileName(pid)), pid);
  }
});
test('isCrashSentinelFile matches the marker shape ONLY', () => {
  assert.equal(isCrashSentinelFile('crash-sentinel-1234.json'), true);
  assert.equal(isCrashSentinelFile('crash-sentinel-1.json'), true);
  // not a marker: other userData files, a non-numeric middle, missing prefix/suffix
  assert.equal(isCrashSentinelFile('window-state.json'), false);
  assert.equal(isCrashSentinelFile('crash-sentinel-abc.json'), false, 'non-numeric pid');
  assert.equal(isCrashSentinelFile('crash-sentinel-.json'), false, 'empty pid');
  assert.equal(isCrashSentinelFile('crash-sentinel-1234.json.bak'), false, 'wrong suffix');
  assert.equal(isCrashSentinelFile('x-crash-sentinel-1234.json'), false, 'wrong prefix');
  assert.equal(isCrashSentinelFile(null), false);
  assert.equal(isCrashSentinelFile(42), false);
});

console.log('\ndetectCrashes — the core partition over (markers, isAlive)');
test('an empty marker list → nothing crashed, nothing surviving', () => {
  const r = detectCrashes([], livePids(new Set()));
  assert.deepEqual(r.crashed, []);
  assert.deepEqual(r.survivors, []);
});
test('a non-array input → safe empty partition (never throws)', () => {
  const r = detectCrashes(null, livePids(new Set()));
  assert.deepEqual(r.crashed, []);
  assert.deepEqual(r.survivors, []);
});
test('DONE #1: a single dead-pid marker (prior instance was kill -9) → crashed', () => {
  const markers = [{ pid: 100, nonce: 'a' }];
  // pid 100 is NOT in the live set → it died hard.
  const r = detectCrashes(markers, livePids(new Set()));
  assert.equal(r.crashed.length, 1);
  assert.equal(r.crashed[0].pid, 100);
  assert.equal(r.survivors.length, 0);
});
test('a single LIVE-pid marker (this instance still running) → survivor, left untouched', () => {
  const markers = [{ pid: 200, nonce: 'b' }];
  const r = detectCrashes(markers, livePids(new Set([200])));
  assert.equal(r.survivors.length, 1);
  assert.equal(r.survivors[0].pid, 200);
  assert.equal(r.crashed.length, 0);
});
test('DONE #6: TWO markers — one dead, one alive — partition independently', () => {
  // Instance A (pid 100) was kill -9'd; instance B (pid 200) is still running.
  const markers = [
    { pid: 100, nonce: 'a' },
    { pid: 200, nonce: 'b' },
  ];
  const r = detectCrashes(markers, livePids(new Set([200])));
  assert.equal(r.crashed.length, 1);
  assert.equal(r.crashed[0].pid, 100, 'A (dead) is the crash');
  assert.equal(r.survivors.length, 1);
  assert.equal(r.survivors[0].pid, 200, 'B (alive) is left untouched');
});
test('multiple dead markers (several prior instances died) → one crash EACH', () => {
  const markers = [
    { pid: 100, nonce: 'a' },
    { pid: 101, nonce: 'b' },
    { pid: 102, nonce: 'c' },
  ];
  const r = detectCrashes(markers, livePids(new Set()));
  assert.equal(r.crashed.length, 3, 'one crash event per crashed instance');
});
test('malformed markers (no numeric pid) are skipped — neither crash nor survivor', () => {
  const markers = [null, {}, { pid: 'x' }, { pid: 100, nonce: 'a' }, { nonce: 'z' }];
  const r = detectCrashes(markers, livePids(new Set()));
  assert.equal(r.crashed.length, 1);
  assert.equal(r.survivors.length, 0);
});
test('a THROWING isAlive predicate is treated as dead (conservative → report the crash)', () => {
  // main.cjs's isPidAlive catches process.kill internally, but a predicate that
  // nonetheless throws must not crash detection — dead is the safe direction.
  const markers = [{ pid: 100, nonce: 'a' }];
  const r = detectCrashes(markers, () => { throw new Error('boom'); });
  assert.equal(r.crashed.length, 1);
});
test('a non-function isAlive → every marker is crashed (fails safe toward reporting)', () => {
  const markers = [{ pid: 100, nonce: 'a' }, { pid: 200, nonce: 'b' }];
  const r = detectCrashes(markers, undefined);
  assert.equal(r.crashed.length, 2);
});

console.log('\nlifecycle simulation — detect → emit-per-crashed → delete crashed → re-detect (no re-emit)');
test('DONE #4: after crashed markers are cleared, a second detect pass emits NOTHING', () => {
  // Simulate main.cjs's flow with a fake fs keyed by filename.
  const fs = new Map([
    ['crash-sentinel-100.json', { pid: 100, nonce: 'a' }],
    ['crash-sentinel-200.json', { pid: 200, nonce: 'b' }],
  ]);
  let live = new Set([200]); // pid 200 still running; pid 100 died hard
  const emitted = [];

  // Pass 1 (the next launch's startup): read markers, detect, emit per crashed,
  // then delete the crashed marker files (the survivor is left).
  const markers1 = [...fs.values()].map(parseMarkerVia).filter(Boolean);
  const { crashed } = detectCrashes(markers1, livePids(live));
  for (const m of crashed) {
    emitted.push(m.pid); // one recordMainCrash() per crashed instance
    fs.delete(markerFileName(m.pid));
  }
  assert.deepEqual(emitted, [100], 'exactly one emit for the dead instance');
  assert.equal(fs.has('crash-sentinel-100.json'), false, 'crashed marker deleted');
  assert.equal(fs.has('crash-sentinel-200.json'), true, 'survivor marker untouched');

  // Pass 2 (a SECOND consecutive relaunch, after the first detected+cleared):
  // the crashed marker is gone, so nothing re-emits.
  const markers2 = [...fs.values()].map(parseMarkerVia).filter(Boolean);
  const { crashed: crashed2 } = detectCrashes(markers2, livePids(live));
  assert.equal(crashed2.length, 0, 'a further relaunch does NOT re-emit (marker was deleted)');
});
test('DONE #2 + #6 combined: a clean quit removes only the quitter; the killed instance still detected', () => {
  // Instance A (pid 100) + B (pid 200) both running. A is kill -9'd (its marker
  // stays — before-quit never ran). B quits CLEANLY → before-quit deletes only
  // pid 200's marker. On the NEXT launch, A's crash is detected; B is gone too.
  const fs = new Map([
    ['crash-sentinel-100.json', { pid: 100, nonce: 'a' }],
    ['crash-sentinel-200.json', { pid: 200, nonce: 'b' }],
  ]);
  // A died (not in live set); B then quits → before-quit deletes B's file.
  fs.delete(markerFileName(200));
  assert.equal(fs.has('crash-sentinel-200.json'), false, 'B cleared its own marker on clean quit');

  // Next launch: detect over the remaining files.
  const markers = [...fs.values()].map(parseMarkerVia).filter(Boolean);
  const { crashed } = detectCrashes(markers, livePids(new Set()));
  assert.equal(crashed.length, 1);
  assert.equal(crashed[0].pid, 100, "A's crash is detected; B's clean quit did NOT clear A");
});

// parse a marker value that is already an object (parseMarker accepts objects).
function parseMarkerVia(v) {
  return parseMarker(v);
}

console.log(`\n✓ CRASH-SENTINEL TESTS PASS (${passed})`);
