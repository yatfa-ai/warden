// Tests for the canonical telemetry event schema (WARDEN-457, slice 1 of roadmap
// WARDEN-446 / design WARDEN-443). The schema is the versioned cross-repo
// contract shared with the separate warden-telemetry receiver repo; this test
// proves the contract holds AND that it reconciles with the schema shapes slices
// 2 (redact.ts) and 4 (telemetry-source.cjs) already shipped against.
//
// No front-end test runner in this repo, so (like web/telemetry-redact.test.mjs)
// this loads the REAL web/src/lib/telemetry/schema.ts (transpiled TS -> ESM via
// Vite's OXC transform) and exercises the PURE runtime shape with plain objects.
// The only imports in schema.ts are `import type` (erased at transpile), so the
// emitted module loads standalone.
//
// Auto-discovered by `npm run dev:test` (`node --test` in web/).
//
// Run: node telemetry-schema.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modPath = resolve(__dirname, 'src/lib/telemetry/schema.ts');

// --- Load the REAL schema.ts (TS -> ESM via the OXC transform Vite bundles) ---
const src = readFileSync(modPath, 'utf8');
const { code } = await transformWithOxc(src, modPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-telemetry-schema-test-'));
const tmpFile = join(tmpDir, 'schema.mjs');
writeFileSync(tmpFile, code);
const mod = await import(tmpFile);
const {
  SCHEMA_VERSION,
  BASE_EVENT_TYPES,
  RUNTIME,
  isBaseEventType,
  isRuntime,
  validateBaseEvent,
  validateEvent,
} = mod;
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// --- Fixtures matching slice 4's builder output EXACTLY (reconciliation proof) -
const errorFixture = {
  schemaVersion: SCHEMA_VERSION,
  type: 'error',
  runtime: RUNTIME.MAIN,
  timestamp: 12345,
  name: 'Error',
  message: 'failed to load module',
  frames: [{ function: 'loadKey', file: 'key.pem', line: 42, column: 7 }],
};
const crashFixture = {
  schemaVersion: SCHEMA_VERSION,
  type: 'crash',
  runtime: RUNTIME.RENDERER,
  timestamp: 9,
  reason: 'oom',
  exitCode: 133,
};
const stallFixture = {
  schemaVersion: SCHEMA_VERSION,
  type: 'performance-stall',
  runtime: RUNTIME.MAIN,
  timestamp: 3,
  lagMs: 750,
  source: 'event-loop',
};

// ==========================================================================
// (a) The shared contract constants
// ==========================================================================

test('SCHEMA_VERSION is 6 (the version client + receiver agree on)', () => {
  assert.equal(typeof SCHEMA_VERSION, 'number');
  assert.equal(SCHEMA_VERSION, 6);
});

test('BASE_EVENT_TYPES is exactly the five anonymous base-tier kinds', () => {
  assert.deepEqual([...BASE_EVENT_TYPES], ['error', 'crash', 'performance-stall', 'operational-metrics', 'server-stall']);
});

test('RUNTIME is exactly { main, renderer, server }', () => {
  assert.equal(RUNTIME.MAIN, 'main');
  assert.equal(RUNTIME.RENDERER, 'renderer');
  // WARDEN-1278 — the forked BACKEND child. A third real OS process warden has
  // always run and the wire could not name, so nothing it observed could ever be
  // reported under any consent.
  assert.equal(RUNTIME.SERVER, 'server');
});

test('the contract constants are frozen (immutable shared contract)', () => {
  assert.equal(Object.isFrozen(BASE_EVENT_TYPES), true);
  assert.equal(Object.isFrozen(RUNTIME), true);
});

// ==========================================================================
// (b) The schema carries NO consent model (WARDEN-1116)
// ==========================================================================

test('the schema declares NO consent model — the ONE authority is ./consent.ts (WARDEN-1116)', () => {
  // Consent was never part of the cross-repo WIRE contract (the receiver
  // validates event SHAPE, not who consented). Keeping a tier resolver here
  // would be a SECOND place a consent decision gets made, which is exactly what
  // the per-category model forbids. Its absence is the assertion.
  assert.equal(mod.ConsentTier, undefined, 'no ConsentTier export');
  assert.equal(mod.resolveConsentTier, undefined, 'no consent resolver in the schema');
  assert.ok(
    !Object.keys(mod).some((k) => /consent/i.test(k)),
    'nothing consent-shaped is exported from the schema module',
  );
});

// ==========================================================================
// (c) Type guards
// ==========================================================================

test('isBaseEventType / isRuntime recognize the known values and reject others', () => {
  for (const t of BASE_EVENT_TYPES) assert.equal(isBaseEventType(t), true);
  assert.equal(isBaseEventType('bogus'), false);
  assert.equal(isBaseEventType(undefined), false);
  assert.equal(isRuntime('main'), true);
  assert.equal(isRuntime('renderer'), true);
  assert.equal(isRuntime('server'), true);
  assert.equal(isRuntime('worker'), false);
});

// ==========================================================================
// (d) validateBaseEvent — accepts each slice-4 builder shape (reconciliation)
// ==========================================================================

test('validateBaseEvent accepts each slice-4 base-tier fixture (schema reconciles with slice 4)', () => {
  assert.equal(validateBaseEvent(errorFixture), true, 'error fixture validates');
  assert.equal(validateBaseEvent(crashFixture), true, 'crash fixture validates');
  assert.equal(validateBaseEvent(stallFixture), true, 'stall fixture validates');
});

test('validateBaseEvent rejects null / non-object / wrong version / unknown type', () => {
  assert.equal(validateBaseEvent(null), false);
  assert.equal(validateBaseEvent('nope'), false);
  assert.equal(validateBaseEvent({}), false);
  assert.equal(validateBaseEvent({ ...errorFixture, schemaVersion: 999 }), false, 'wrong version');
  assert.equal(validateBaseEvent({ ...errorFixture, type: 'bogus' }), false, 'unknown type');
});

test('validateBaseEvent rejects a bad runtime and a non-finite timestamp', () => {
  assert.equal(validateBaseEvent({ ...errorFixture, runtime: 'worker' }), false);
  assert.equal(validateBaseEvent({ ...errorFixture, timestamp: NaN }), false);
  assert.equal(validateBaseEvent({ ...errorFixture, timestamp: 'soon' }), false);
});

test('validateBaseEvent type-specific shape checks (error needs message+name+frames)', () => {
  assert.equal(validateBaseEvent({ ...errorFixture, message: 5 }), false, 'error message must be string');
  assert.equal(validateBaseEvent({ ...errorFixture, name: 5 }), false, 'error name must be string');
  assert.equal(validateBaseEvent({ ...errorFixture, frames: 'x' }), false, 'error frames must be array');
  // an empty frame array is still valid (best-effort parse may yield none)
  assert.equal(validateBaseEvent({ ...errorFixture, frames: [] }), true);
});

test('validateBaseEvent crash needs a string reason; runtime may be main OR renderer (WARDEN-687)', () => {
  assert.equal(validateBaseEvent({ ...crashFixture, reason: 5 }), false, 'crash reason must be string');
  assert.equal(validateBaseEvent({ ...crashFixture, reason: undefined }), false, 'crash needs a reason');
  // WARDEN-687: a main-runtime crash (a hard kill detected on next launch by the
  // crash sentinel) now validates — runtime was already a non-identifying enum, so
  // accepting `main` is a shape relaxation, not new data collection.
  assert.equal(
    validateBaseEvent({ ...crashFixture, runtime: RUNTIME.MAIN, reason: 'unexpected-termination' }),
    true,
    'a main-runtime crash (hard kill) validates post-v4',
  );
  assert.equal(validateBaseEvent(crashFixture), true, 'a renderer-runtime crash still validates');
  assert.equal(validateBaseEvent({ ...crashFixture, runtime: 'worker' }), false, 'an unknown runtime is still rejected');
});

test('validateBaseEvent stall needs a numeric lagMs and a known source', () => {
  assert.equal(validateBaseEvent({ ...stallFixture, lagMs: '700' }), false, 'lagMs must be number');
  assert.equal(validateBaseEvent({ ...stallFixture, source: 'gpu' }), false, 'unknown source');
  assert.equal(validateBaseEvent({ ...stallFixture, runtime: RUNTIME.RENDERER, source: 'unresponsive' }), true, 'renderer unresponsive hang validates');
});

// ==========================================================================
// (e) validateEvent — the optional identifier fields (chat/session names)
// ==========================================================================

test('validateEvent accepts base fixtures and base + extended name fields', () => {
  assert.equal(validateEvent(errorFixture), true);
  const extended = { ...errorFixture, chatName: 'Refactor auth', sessionName: 'claude-7b3a2f1' };
  assert.equal(validateEvent(extended), true, 'extended names are well-typed');
});

test('validateEvent rejects a base event with non-string extended fields', () => {
  assert.equal(validateEvent({ ...errorFixture, chatName: 42 }), false);
  assert.equal(validateEvent({ ...errorFixture, sessionName: { x: 1 } }), false);
});

// ==========================================================================
// (e2) appVersion (WARDEN-665) — an OPTIONAL base-tier release label. A v2 event
// WITH it validates; a v2 event WITHOUT it ALSO validates (a source that cannot
// read the version omits it); a non-string appVersion is rejected.
// ==========================================================================

test('validateEvent accepts a base event WITH an optional appVersion release label', () => {
  assert.equal(validateEvent({ ...errorFixture, appVersion: '0.1.19' }), true);
  assert.equal(validateEvent({ ...crashFixture, appVersion: '0.1.19' }), true);
  assert.equal(validateEvent({ ...stallFixture, appVersion: '0.1.19' }), true);
});

test('validateEvent accepts a base event WITHOUT appVersion (optional — version-unreadable source)', () => {
  // The canonical fixtures carry no appVersion; they must still validate.
  assert.equal(validateEvent(errorFixture), true);
  assert.equal(validateEvent(crashFixture), true);
  assert.equal(validateEvent(stallFixture), true);
});

test('validateEvent rejects a base event with a non-string appVersion', () => {
  assert.equal(validateEvent({ ...errorFixture, appVersion: 2 }), false, 'numeric appVersion rejected');
  assert.equal(validateEvent({ ...errorFixture, appVersion: { x: 1 } }), false, 'object appVersion rejected');
  assert.equal(validateEvent({ ...errorFixture, appVersion: null }), false, 'null appVersion rejected');
});

// ==========================================================================
// (e3) platform (WARDEN-684) — an OPTIONAL base-tier OS label (darwin/win32/linux).
// Same trust posture as appVersion. A v3 event WITH it validates; a v3 event
// WITHOUT it ALSO validates (a source that cannot read process.platform omits
// it); a non-string platform is rejected.
// ==========================================================================

test('validateEvent accepts a base event WITH an optional platform OS label', () => {
  assert.equal(validateEvent({ ...errorFixture, platform: 'darwin' }), true);
  assert.equal(validateEvent({ ...crashFixture, platform: 'win32' }), true);
  assert.equal(validateEvent({ ...stallFixture, platform: 'linux' }), true);
});

test('validateEvent accepts a base event WITHOUT platform (optional — OS-unreadable source)', () => {
  // The canonical fixtures carry no platform; they must still validate.
  assert.equal(validateEvent(errorFixture), true);
  assert.equal(validateEvent(crashFixture), true);
  assert.equal(validateEvent(stallFixture), true);
});

test('validateEvent rejects a base event with a non-string platform', () => {
  assert.equal(validateEvent({ ...errorFixture, platform: 2 }), false, 'numeric platform rejected');
  assert.equal(validateEvent({ ...errorFixture, platform: { x: 1 } }), false, 'object platform rejected');
  assert.equal(validateEvent({ ...errorFixture, platform: null }), false, 'null platform rejected');
});

test('validateEvent still rejects a malformed base event even with good extended fields', () => {
  assert.equal(validateEvent({ ...errorFixture, type: 'bogus', chatName: 'x' }), false);
});

// ==========================================================================
// (e) operational-metrics (WARDEN-1258) — the aggregate event shape
// ==========================================================================

const metricsFixture = {
  schemaVersion: SCHEMA_VERSION,
  type: 'operational-metrics',
  runtime: 'main',
  timestamp: 1735689600000,
  appVersion: '0.1.50',
  platform: 'linux',
  windowStartedAt: 1735689300000,
  windowEndedAt: 1735689600000,
  boundaries: [50, 100, 250, 500, 1000, 2500, 5000, 10000],
  operations: [
    {
      operation: 'file-exists-local',
      count: 12,
      okCount: 9,
      failCount: 3,
      min: 0.2,
      avg: 1.4,
      max: 6.1,
      buckets: [12, 0, 0, 0, 0, 0, 0, 0, 0],
    },
    {
      operation: 'file-exists-remote',
      count: 5,
      okCount: 5,
      failCount: 0,
      min: 210,
      avg: 480,
      max: 900,
      buckets: [0, 0, 2, 2, 1, 0, 0, 0, 0],
    },
  ],
  rejected: 0,
};

test('validateBaseEvent accepts the operational-metrics fixture', () => {
  assert.equal(validateBaseEvent(metricsFixture), true, 'metrics fixture validates');
  assert.equal(validateEvent(metricsFixture), true, 'validateEvent accepts it too');
});

test('operational-metrics rejects a non-kebab operation name (hard exclusion is structural)', () => {
  // A path, a hostname, or any free text riding the aggregate key must fail the
  // SHAPE check itself — the name is the only string this event type carries.
  for (const bad of ['/etc/passwd', 'ops host.internal', 'file_exists', 'A-B', '', 'x'.repeat(65)]) {
    const clone = JSON.parse(JSON.stringify(metricsFixture));
    clone.operations[0].operation = bad;
    assert.equal(validateBaseEvent(clone), false, `operation name ${JSON.stringify(bad)} must be rejected`);
  }
});

test('operational-metrics rejects malformed windows / boundaries / histograms', () => {
  for (const mutate of [
    (e) => { delete e.windowStartedAt; },
    (e) => { e.windowEndedAt = 'soon'; },
    (e) => { e.boundaries = []; },
    (e) => { e.boundaries = [100, 50]; }, // non-ascending — the aggregator emits strictly ascending
    (e) => { e.boundaries[0] = -1; },
    (e) => { e.operations[0].buckets = [1, 2, 3]; }, // wrong bucket count
    (e) => { e.operations[0].count = 1.5; }, // non-integer count
    (e) => { e.operations[0].min = -2; },
    (e) => { e.rejected = -1; },
    (e) => { e.operations = 'nope'; },
  ]) {
    const clone = JSON.parse(JSON.stringify(metricsFixture));
    mutate(clone);
    assert.equal(validateBaseEvent(clone), false, `mutation must invalidate: ${mutate.toString().slice(0, 60)}`);
  }
});

test('operational-metrics rejects more operations than the aggregator footprint bound', () => {
  const clone = JSON.parse(JSON.stringify(metricsFixture));
  clone.operations = Array.from({ length: 130 }, (_, i) => ({
    operation: `op-${i}`,
    count: 1, okCount: 1, failCount: 0,
    min: 1, avg: 1, max: 1,
    buckets: [1, ...clone.boundaries.map(() => 0)],
  }));
  assert.equal(clone.operations[0].buckets.length, clone.boundaries.length + 1, 'fixture sanity');
  assert.equal(validateBaseEvent(clone), false, '130 operations exceed the 129 cap');
});

// ==========================================================================
// (f) server-stall (WARDEN-1278) — the backend child's folded stall window
// ==========================================================================

const serverStallFixture = {
  schemaVersion: SCHEMA_VERSION,
  type: 'server-stall',
  runtime: RUNTIME.SERVER,
  timestamp: 1735689600000,
  appVersion: '0.1.50',
  platform: 'linux',
  windowStartedAt: 1735689300000,
  windowEndedAt: 1735689600000,
  count: 3,
  totalMs: 9400,
  maxMs: 5200,
  boundaries: [1000, 2000, 5000, 10000, 30000],
  buckets: [0, 1, 1, 1, 0, 0],
  culprits: [
    { culprit: 'get-api-claude-sessions', count: 3, totalOverlapMs: 8800 },
    { culprit: 'fs-read-file-sync', count: 2, totalOverlapMs: 4100 },
    { culprit: 'other', count: 1, totalOverlapMs: 12 },
  ],
};

test('validateBaseEvent accepts the server-stall fixture', () => {
  assert.equal(validateBaseEvent(serverStallFixture), true, 'server-stall fixture validates');
  assert.equal(validateEvent(serverStallFixture), true, 'validateEvent accepts it too');
});

test('server-stall is PINNED to the server runtime — main/renderer are rejected', () => {
  // The type exists precisely to report that the BACKEND CHILD froze. Accepting
  // `main` here would let a builder mislabel which process stalled, which is the
  // lie the new runtime was added to end.
  for (const runtime of ['main', 'renderer', 'worker', undefined]) {
    assert.equal(
      validateBaseEvent({ ...serverStallFixture, runtime }),
      false,
      `server-stall with runtime ${JSON.stringify(runtime)} must be rejected`,
    );
  }
});

test('server-stall rejects a non-kebab culprit key (hard exclusion is structural)', () => {
  // A route path, an agent name, a hostname, or any free text riding the
  // attribution key must fail the SHAPE check itself — the culprit key is the
  // only string this event type carries. The producer maps every span label onto
  // a closed set first; this is the independent second layer.
  for (const bad of [
    '/api/sessions/abc', 'GET /api/chats', 'myproject.internal', 'Refactor auth',
    'fs.readFileSync', 'A-B', '', 'x'.repeat(65),
  ]) {
    const clone = JSON.parse(JSON.stringify(serverStallFixture));
    clone.culprits[0].culprit = bad;
    assert.equal(validateBaseEvent(clone), false, `culprit key ${JSON.stringify(bad)} must be rejected`);
  }
});

test('server-stall rejects malformed windows / totals / boundaries / histograms', () => {
  for (const mutate of [
    (e) => { delete e.windowStartedAt; },
    (e) => { e.windowEndedAt = 'soon'; },
    (e) => { e.count = 1.5; }, // non-integer stall count
    (e) => { e.count = -1; },
    (e) => { e.totalMs = -1; },
    (e) => { e.maxMs = 'lots'; },
    (e) => { e.boundaries = []; },
    (e) => { e.boundaries = [2000, 1000]; }, // non-ascending
    (e) => { e.boundaries[0] = -1; },
    (e) => { e.buckets = [1, 2, 3]; }, // wrong bucket count for the boundaries
    (e) => { e.buckets[0] = 1.5; },
    (e) => { e.culprits = 'nope'; },
    (e) => { e.culprits[0].count = -1; },
    (e) => { e.culprits[0].totalOverlapMs = -1; },
    (e) => { delete e.culprits[0].culprit; },
  ]) {
    const clone = JSON.parse(JSON.stringify(serverStallFixture));
    mutate(clone);
    assert.equal(validateBaseEvent(clone), false, `mutation must invalidate: ${mutate.toString().slice(0, 60)}`);
  }
});

test('server-stall rejects more culprits than the producer footprint bound', () => {
  const clone = JSON.parse(JSON.stringify(serverStallFixture));
  clone.culprits = Array.from({ length: 66 }, (_, i) => ({
    culprit: `k-${i}`, count: 1, totalOverlapMs: 1,
  }));
  assert.equal(validateBaseEvent(clone), false, '66 culprits exceed the 65 cap');
});

test('server-stall carries NO free-text field — the whole shape is numbers + closed-set keys', () => {
  // The forcing function for "this type can never become a leak channel": every
  // string value in a valid event is either a fixed literal or a kebab-case key.
  const strings = [];
  const walk = (v) => {
    if (typeof v === 'string') { strings.push(v); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') { Object.values(v).forEach(walk); }
  };
  walk(serverStallFixture);
  const allowedLiterals = new Set(['server-stall', 'server', '0.1.50', 'linux']);
  for (const s of strings) {
    assert.ok(
      allowedLiterals.has(s) || /^[a-z0-9][a-z0-9-]{0,63}$/.test(s),
      `every string in a server-stall event is a literal or a kebab key: ${JSON.stringify(s)}`,
    );
  }
});

console.log(`\n✓ TELEMETRY-SCHEMA TESTS PASS (${passed})`);
