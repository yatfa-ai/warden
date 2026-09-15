// Unit tests for the MAIN-process stall attribution probe (WARDEN-1376).
//
// electron/stall-attribution.cjs gives the main-process event-loop heartbeat
// what the server child's monitor has had since WARDEN-977/1278: a sync-I/O
// probe over the fs/child_process module objects and an attribution fold over
// the blocked window. The main heartbeat previously reported HOW LONG the loop
// was blocked but never WHAT blocked it — which is why the win32
// `stall:event-loop` rows on the receiver could not be traced to a mechanism.
//
// The module is dependency-free with injectable targets + clock (the same
// discipline as window-state.cjs / telemetry-source.cjs), so these tests pin:
//   • the wrap observes calls made THROUGH the module object (the WARDEN-977
//     technique), preserves siblings, and survives throwing calls
//   • labels are closed-set kebab-case literals (fs-read-file-sync) — the
//     structural redaction proof the server-stall culprits carry
//   • attributeStall folds ONLY slow calls overlapping the window, longest
//     first, bounded, with the reserved overflow key
//   • an honest empty (nothing overlapped) ships NO culprit list
//
// Run: node stall-attribution.test.mjs   (from web/)
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const {
  installSyncIoProbe,
  kebabLabel,
  isValidAttributionEntry,
  SYNC_FS_METHODS,
  SYNC_CHILD_PROCESS_METHODS,
  CULPRIT_NAME_RE,
  ATTRIBUTION_OVERFLOW_KEY,
  MAX_CULPRITS_PER_EVENT,
} = require('../electron/stall-attribution.cjs');

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// A fake fs module object with a few members, including the `.native` sibling
// the WARDEN-977 descriptor gotcha is about.
function fakeFs() {
  return {
    readFileSync: function readFileSync() { return 'data'; },
    writeFileSync: function writeFileSync() {},
    renameSync: function renameSync() {},
    realpathSync: Object.assign(function realpathSync() {}, { native: function native() {} }),
  };
}

// A clock you drive by hand: each call returns (and then advances by) `step`.
function steppedClock(start, step) {
  let t = start;
  return () => {
    const now = t;
    t += step;
    return now;
  };
}

// ==========================================================================
// kebabLabel — the closed-set culprit vocabulary
// ==========================================================================

test('kebabLabel maps member names to fs-<kebab> literals', () => {
  assert.equal(kebabLabel('fs', 'readFileSync'), 'fs-read-file-sync');
  assert.equal(kebabLabel('fs', 'writeFileSync'), 'fs-write-file-sync');
  assert.equal(kebabLabel('fs', 'renameSync'), 'fs-rename-sync');
  assert.equal(kebabLabel('child-process', 'execSync'), 'child-process-exec-sync');
});

test('every label derived from the declared method lists matches the closed-set pattern', () => {
  for (const m of SYNC_FS_METHODS) {
    assert.match(kebabLabel('fs', m), CULPRIT_NAME_RE, `fs.${m} label must be kebab`);
  }
  for (const m of SYNC_CHILD_PROCESS_METHODS) {
    assert.match(kebabLabel('child-process', m), CULPRIT_NAME_RE, `cp.${m} label must be kebab`);
  }
});

test('no label the vocabulary can produce could ever carry a path or hostname', () => {
  // The WARDEN-443 structural proof: a kebab literal has no separator (path)
  // and no dot + TLD (hostname). Pin it against the worst case — a method name
  // full of hostile characters is still reduced to [a-z0-9-].
  assert.match(kebabLabel('fs', 'readFileSync'), /^[a-z0-9-]+$/);
  assert.doesNotMatch(kebabLabel('fs', 'readFileSync'), /[/\\]/);
  assert.doesNotMatch(kebabLabel('fs', 'readFileSync'), /\./);
});

test('isValidAttributionEntry enforces the wire shape (kebab culprit, finite overlapMs ≥ 0)', () => {
  assert.equal(isValidAttributionEntry({ culprit: 'fs-write-file-sync', overlapMs: 1500 }), true);
  assert.equal(isValidAttributionEntry({ culprit: 'fs-write-file-sync', overlapMs: 0 }), true);
  assert.equal(isValidAttributionEntry({ culprit: 'C:\\Users\\x', overlapMs: 1 }), false, 'a path cannot ride a culprit key');
  assert.equal(isValidAttributionEntry({ culprit: 'evil.example.com', overlapMs: 1 }), false, 'a hostname cannot ride a culprit key');
  assert.equal(isValidAttributionEntry({ culprit: 'fs-ok', overlapMs: -1 }), false);
  assert.equal(isValidAttributionEntry({ culprit: 'fs-ok', overlapMs: Number.NaN }), false);
  assert.equal(isValidAttributionEntry({ culprit: 'fs-ok' }), false);
  assert.equal(isValidAttributionEntry(null), false);
});

// ==========================================================================
// The wrap — module-object observation with descriptor preservation
// ==========================================================================

test('the wrap observes calls made THROUGH the module object and the call still works', () => {
  const fsObj = fakeFs();
  const probe = installSyncIoProbe({ targets: [{ obj: fsObj, prefix: 'fs', methods: ['readFileSync'] }], now: () => 1000 });
  const out = fsObj.readFileSync('/tmp/whatever'); // path NEVER recorded — only the label
  assert.equal(out, 'data', 'the original function ran');
  assert.deepEqual(Object.keys(probe.totals()), ['fs-read-file-sync']);
  probe.dispose();
});

test('a THROwING sync call is still attributed (duration recorded in finally)', () => {
  const fsObj = fakeFs();
  fsObj.writeFileSync = function writeFileSync() { throw new Error('disk gone'); };
  const probe = installSyncIoProbe({
    targets: [{ obj: fsObj, prefix: 'fs', methods: ['writeFileSync'] }],
    now: steppedClock(1000, 50),
  });
  assert.throws(() => fsObj.writeFileSync('/tmp/x', ''), Error, 'the error propagates unchanged');
  assert.equal(probe.totals()['fs-write-file-sync'].calls, 1, 'the failed call was counted');
  probe.dispose();
});

test('the wrap preserves SIBLINGS on the wrapped member (realpathSync.native survives)', () => {
  const fsObj = fakeFs();
  const probe = installSyncIoProbe({
    targets: [{ obj: fsObj, prefix: 'fs', methods: ['realpathSync'] }],
    now: () => 1000,
  });
  assert.equal(typeof fsObj.realpathSync.native, 'function', 'the .native sibling survived the wrap');
  probe.dispose();
});

test('dispose() restores the ORIGINAL function objects', () => {
  const fsObj = fakeFs();
  const original = fsObj.readFileSync;
  const probe = installSyncIoProbe({ targets: [{ obj: fsObj, prefix: 'fs', methods: ['readFileSync'] }], now: () => 1000 });
  assert.notEqual(fsObj.readFileSync, original, 'wrapped while installed');
  probe.dispose();
  assert.equal(fsObj.readFileSync, original, 'original restored');
});

test('an absent or read-only member is skipped without throwing', () => {
  const fsObj = { existsSync: function existsSync() {} };
  const frozen = Object.defineProperty({}, 'statSync', {
    value: function statSync() {},
    writable: false,
    configurable: false,
  });
  const probe = installSyncIoProbe({
    targets: [
      { obj: fsObj, prefix: 'fs', methods: ['missingMethod', 'existsSync'] },
      { obj: frozen, prefix: 'fs', methods: ['statSync'] },
    ],
    now: () => 1000,
  });
  fsObj.existsSync('/tmp/x');
  assert.equal(probe.totals()['fs-exists-sync'].calls, 1);
  assert.equal(probe.totals()['fs-stat-sync'], undefined, 'the non-writable member was not wrapped');
  probe.dispose();
});

// ==========================================================================
// attribution — the fold over the blocked window
// ==========================================================================

test('a slow call overlapping the window attributes to its label with the overlapped ms', () => {
  const fsObj = fakeFs();
  // The clock: the wrapped writeFileSync observes start=1000, end=3000 (a 2s block).
  const probe = installSyncIoProbe({
    targets: [{ obj: fsObj, prefix: 'fs', methods: ['writeFileSync'] }],
    now: steppedClock(1000, 2000),
  });
  fsObj.writeFileSync('/tmp/x', '');
  const attribution = probe.attributeStall({ windowStartMs: 1500, windowEndMs: 3200 });
  // The call spans [1000, 3000]; the window [1500, 3200] overlaps its tail: 3000 − 1500.
  assert.deepEqual(attribution, [{ culprit: 'fs-write-file-sync', overlapMs: 1500 }]);
  probe.dispose();
});

test('the attribution window is the OVERDUE gap: a call outside it is excluded, not guessed', () => {
  const fsObj = fakeFs();
  const probe = installSyncIoProbe({
    targets: [{ obj: fsObj, prefix: 'fs', methods: ['readFileSync'] }],
    now: steppedClock(1000, 50),
  });
  fsObj.readFileSync('/tmp/a'); // [1000, 1050) — long before the stall window
  const attribution = probe.attributeStall({ windowStartMs: 5000, windowEndMs: 8000 });
  assert.deepEqual(attribution, [], 'work that finished before the block is not a lead');
  probe.dispose();
});

test('calls below the floor take totals but NO ring slot — cheap noise cannot crowd the blocker', () => {
  const fsObj = fakeFs();
  const probe = installSyncIoProbe({
    targets: [{ obj: fsObj, prefix: 'fs', methods: ['readFileSync'] }],
    now: steppedClock(1000, 5), // 5ms per call — far below the 100ms floor
    floorMs: 100,
  });
  for (let i = 0; i < 10; i++) fsObj.readFileSync('/tmp/a');
  const totals = probe.totals()['fs-read-file-sync'];
  assert.equal(totals.calls, 10, 'aggregates see every call');
  assert.deepEqual(probe.attributeStall({ windowStartMs: 0, windowEndMs: 1e12 }), [], 'nothing ring-worthy → honest empty');
  probe.dispose();
});

test('multiple overlapping culprits fold longest-overlap-first, bounded by the limit', () => {
  const fsObj = fakeFs();
  // A hand-driven clock: each wrapped call reads it twice (start, end).
  // writeFileSync [1000,1100)=100ms; renameSync [1100,1400)=300ms; readFileSync [1400,1560)=160ms.
  const times = [1000, 1100, 1100, 1400, 1400, 1560];
  let i = 0;
  const probe = installSyncIoProbe({
    targets: [{ obj: fsObj, prefix: 'fs', methods: ['writeFileSync', 'renameSync', 'readFileSync'] }],
    now: () => times[i++ % times.length],
  });
  fsObj.writeFileSync('/tmp/x', '');
  fsObj.renameSync('/tmp/x', '/tmp/y');
  fsObj.readFileSync('/tmp/y');
  const attribution = probe.attributeStall({ windowStartMs: 900, windowEndMs: 2000 });
  assert.equal(attribution[0].culprit, 'fs-rename-sync', 'longest overlap first');
  assert.equal(attribution[0].overlapMs, 300);
  assert.equal(attribution[1].culprit, 'fs-read-file-sync');
  assert.equal(attribution[1].overlapMs, 160);
  assert.equal(attribution[2].culprit, 'fs-write-file-sync');
  assert.equal(attribution[2].overlapMs, 100);
  probe.dispose();
});

test('the ring is bounded — oldest entries drop, memory cannot grow', () => {
  const fsObj = fakeFs();
  let t = 1000;
  const probe = installSyncIoProbe({
    targets: [{ obj: fsObj, prefix: 'fs', methods: ['readFileSync'] }],
    now: () => { t += 200; return t; }, // every call is slow (200ms) and distinct in time
    ringCap: 4,
  });
  for (let i = 0; i < 50; i++) fsObj.readFileSync('/tmp/a');
  // Window covering ONLY the first two calls: if the ring kept everything, the
  // fold would see them; with the bounded ring they have already dropped.
  const attribution = probe.attributeStall({ windowStartMs: 0, windowEndMs: 2000 });
  assert.deepEqual(attribution, [], 'the oldest slow calls dropped out of the bounded ring');
  probe.dispose();
});

test('the overflow key appends when culprits exceed the per-event limit', () => {
  const methods = [];
  for (let i = 0; i < 4; i++) methods.push(`method${i}Sync`);
  const obj = {};
  let t = 1000;
  for (const m of methods) obj[m] = new Function(`return function ${m}(){}`)();
  const probe = installSyncIoProbe({
    targets: [{ obj, prefix: 'fs', methods }],
    now: () => { t += 200; return t; },
  });
  for (const m of methods) obj[m]();
  // Below the limit: every culprit fits, NO overflow marker.
  const attribution = probe.attributeStall({ windowStartMs: 0, windowEndMs: 1e9 });
  assert.equal(attribution.length, 4, 'all four culprits fit under the default limit');
  assert.equal(attribution.some((c) => c.culprit === ATTRIBUTION_OVERFLOW_KEY), false);
  // Above the limit: the excess folds into the reserved overflow key.
  const limited = probe.attributeStall({ windowStartMs: 0, windowEndMs: 1e9, limit: 2 });
  assert.equal(limited.length, 3, '2 culprits + the overflow marker');
  assert.equal(limited[2].culprit, ATTRIBUTION_OVERFLOW_KEY);
  probe.dispose();
});

test('MAX_CULPRITS_PER_EVENT mirrors the server-stall bound (65)', () => {
  assert.equal(MAX_CULPRITS_PER_EVENT, 65);
});

test('the probe produces no aggregates before any call and clears on dispose', () => {
  const fsObj = fakeFs();
  const probe = installSyncIoProbe({ targets: [{ obj: fsObj, prefix: 'fs', methods: ['readFileSync'] }], now: () => 1000 });
  assert.deepEqual(probe.totals(), {});
  fsObj.readFileSync('/tmp/a');
  assert.ok(probe.totals()['fs-read-file-sync']);
  probe.dispose();
  assert.deepEqual(probe.totals(), {}, 'dispose clears the aggregates');
});

console.log(`\n✓ STALL ATTRIBUTION TESTS PASS (${passed})`);
