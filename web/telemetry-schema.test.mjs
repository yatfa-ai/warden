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

test('SCHEMA_VERSION is 11 (the version client + receiver agree on)', () => {
  assert.equal(typeof SCHEMA_VERSION, 'number');
  assert.equal(SCHEMA_VERSION, 11);
});

test('BASE_EVENT_TYPES is exactly the nine anonymous-or-consented base-tier kinds', () => {
  // WARDEN-1424 — v8 adds `workspace-shape`, the renderer's counts-only shape
  // snapshot riding the operational-metrics category.
  assert.deepEqual([...BASE_EVENT_TYPES], ['error', 'crash', 'performance-stall', 'operational-metrics', 'server-stall', 'workspace-names', 'workspace-shape', 'feature-usage', 'process-memory']);
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

test('operational-metrics rejectedStale/rejectedInvalid are OPTIONAL non-negative integers (WARDEN-1528)', () => {
  // Backward-compat gate: the unsplit (v9/v10-shaped) fixture validates UNMODIFIED.
  assert.equal('rejectedStale' in metricsFixture, false, 'fixture sanity: no split fields');
  assert.equal(validateBaseEvent(metricsFixture), true, 'absent split fields stay valid');
  const split = { ...metricsFixture, rejected: 7, rejectedStale: 5, rejectedInvalid: 2 };
  assert.equal(validateBaseEvent(split), true, 'present split fields validate');
  assert.equal(validateBaseEvent({ ...split, rejectedStale: 0, rejectedInvalid: 0 }), true, 'zero is valid');
  for (const k of ['rejectedStale', 'rejectedInvalid']) {
    for (const bad of [-1, 1.5, '3', null, NaN]) {
      assert.equal(validateBaseEvent({ ...split, [k]: bad }), false, `${k}=${String(bad)} must be rejected`);
    }
  }
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

// ==========================================================================
// (f) workspace-names (WARDEN-1416) — the `names` category's carrying event
// ==========================================================================

const workspaceNamesFixture = {
  schemaVersion: SCHEMA_VERSION,
  type: 'workspace-names',
  runtime: 'server',
  timestamp: 1735689600000,
  appVersion: '0.1.75',
  platform: 'linux',
  windowStartedAt: 1735689300000,
  windowEndedAt: 1735689600000,
  chats: ['demo', 'Refactor auth', 'chat-4nh15o'],
  chatCount: 3,
  truncated: false,
};

test('validateBaseEvent accepts the workspace-names fixture', () => {
  assert.equal(validateBaseEvent(workspaceNamesFixture), true, 'workspace-names fixture validates');
  assert.equal(validateEvent(workspaceNamesFixture), true, 'validateEvent accepts it too');
});

test('workspace-names is PINNED to the server runtime — main/renderer are rejected', () => {
  // The chat catalog lives in the forked backend child; stamping any other
  // runtime would misattribute where the workspace is observed.
  for (const runtime of ['main', 'renderer', 'worker', undefined]) {
    assert.equal(
      validateBaseEvent({ ...workspaceNamesFixture, runtime }),
      false,
      `workspace-names with runtime ${JSON.stringify(runtime)} must be rejected`,
    );
  }
});

test('workspace-names ACCEPTS arbitrary name text — names are the permitted payload', () => {
  // The inverse of the operation/culprit key rule. THIS type's strings are the
  // user's own chat names, behind the names category's own opt-in: a name with
  // spaces, punctuation, unicode or mixed case MUST validate, or the category
  // could not carry the data it exists for. (Hard exclusions in a name — a path,
  // a host — are the REDACTOR's job, not the schema's: it scrubs every retained
  // string before the wire.)
  for (const name of [
    'Refactor auth', 'chat-4nh15o', 'AAA BBB', 'ünïcode ✨', 'x'.repeat(300),
    'a.b.c', '', 'GET /api/chats',
  ]) {
    assert.equal(
      validateBaseEvent({ ...workspaceNamesFixture, chats: [name], chatCount: 1 }),
      true,
      `name ${JSON.stringify(name.slice(0, 20))} must validate`,
    );
  }
});

test('workspace-names enforces the HONEST-CAP invariant (count ≥ list length)', () => {
  // The cap is loud or it is a lie: a chatCount SMALLER than the list it bounds
  // would claim a catalog smaller than what was sent.
  assert.equal(
    validateBaseEvent({ ...workspaceNamesFixture, chatCount: 2 }),
    false,
    'a count below the list length is rejected',
  );
  assert.equal(
    validateBaseEvent({ ...workspaceNamesFixture, chatCount: 500, truncated: true }),
    true,
    'a count ABOVE the list length is the truncated case and is accepted',
  );
});

test('workspace-names rejects malformed windows / lists / counts / flags', () => {
  for (const mutate of [
    (e) => { delete e.windowStartedAt; },
    (e) => { e.windowEndedAt = 'soon'; },
    (e) => { e.chats = 'nope'; },
    (e) => { e.chats = ['ok', 42]; },
    (e) => { e.chats = ['ok', null]; },
    (e) => { delete e.chatCount; },
    (e) => { e.chatCount = 1.5; },
    (e) => { e.chatCount = -1; },
    (e) => { e.truncated = 'yes'; },
    (e) => { delete e.truncated; },
  ]) {
    const clone = JSON.parse(JSON.stringify(workspaceNamesFixture));
    mutate(clone);
    assert.equal(validateBaseEvent(clone), false, `mutation must invalidate: ${mutate.toString().slice(0, 60)}`);
  }
});

test('workspace-names rejects more names than the schema footprint bound', () => {
  const clone = JSON.parse(JSON.stringify(workspaceNamesFixture));
  clone.chats = Array.from({ length: 401 }, (_, i) => `chat-${i}`);
  clone.chatCount = 401;
  assert.equal(validateBaseEvent(clone), false, '401 names exceed the 400 cap');
});

test('workspace-names carries NO field beyond the disclosed shape', () => {
  // The forcing function for "this type collects exactly what the consent
  // summary says": the fixture's own key set IS the disclosed field list.
  assert.deepEqual(
    Object.keys(workspaceNamesFixture).sort(),
    ['appVersion', 'chatCount', 'chats', 'platform', 'runtime', 'schemaVersion', 'timestamp', 'truncated', 'type', 'windowEndedAt', 'windowStartedAt'],
  );
});


// ==========================================================================
// (g) feature-usage (WARDEN-1479) — the `feature-adoption` category's
//     carrying event
// ==========================================================================

const featureUsageFixture = {
  schemaVersion: SCHEMA_VERSION,
  type: 'feature-usage',
  runtime: 'renderer',
  timestamp: 1735689600000,
  appVersion: '0.1.83',
  platform: 'linux',
  windowStartedAt: 1735689300000,
  windowEndedAt: 1735689600000,
  features: [
    { name: 'global-search', count: 3 },
    { name: 'settings', count: 1 },
  ],
};

test('validateBaseEvent accepts the feature-usage fixture (v10 round trip)', () => {
  assert.equal(validateBaseEvent(featureUsageFixture), true, 'feature-usage fixture validates');
  assert.equal(validateEvent(featureUsageFixture), true, 'validateEvent accepts it too');
});

test('feature-usage is PINNED to the renderer runtime', () => {
  // The capability seams live in the renderer's own UI handlers; any other
  // runtime would be a lie about where the use was observed.
  for (const runtime of ['main', 'server', 'worker', undefined]) {
    assert.equal(
      validateBaseEvent({ ...featureUsageFixture, runtime }),
      false,
      `feature-usage with runtime ${JSON.stringify(runtime)} must be rejected`,
    );
  }
});

test('feature-usage carries a CLOSED-SET name map — hostile names are rejected', () => {
  for (const name of ['Global-Search', 'global_search', 'a'.repeat(65), '../etc/passwd', 'prod.internal', 'refactor auth', '', 42]) {
    assert.equal(
      validateBaseEvent({ ...featureUsageFixture, features: [{ name, count: 1 }] }),
      false,
      `name ${JSON.stringify(String(name).slice(0, 20))} must be rejected`,
    );
  }
});

test('feature-usage counts are POSITIVE integers — zero/negative/float/string are rejected', () => {
  for (const count of [0, -1, 1.5, 'two', NaN, null]) {
    assert.equal(
      validateBaseEvent({ ...featureUsageFixture, features: [{ name: 'global-search', count }] }),
      false,
      `count ${JSON.stringify(count)} must be rejected`,
    );
  }
});

test('feature-usage is a FOLDED MAP — duplicate names are rejected; counts never a row-per-use', () => {
  assert.equal(
    validateBaseEvent({ ...featureUsageFixture, features: [{ name: 'global-search', count: 1 }, { name: 'global-search', count: 2 }] }),
    false,
    'two rows for one capability is rejected',
  );
});

test('feature-usage rejects an EMPTY window (count-driven silence is structural)', () => {
  assert.equal(
    validateBaseEvent({ ...featureUsageFixture, features: [] }),
    false,
    'an empty features array is a shape violation — an idle window sends nothing at all',
  );
});

test('feature-usage rejects more rows than the schema footprint bound', () => {
  const clone = JSON.parse(JSON.stringify(featureUsageFixture));
  clone.features = Array.from({ length: 65 }, (_, i) => ({ name: `cap-${i}`, count: 1 }));
  assert.equal(validateBaseEvent(clone), false, '65 rows exceed the 64 cap');
});

test('feature-usage carries NO field beyond the disclosed shape (closed key set)', () => {
  // The forcing function for "this type collects exactly what the consent
  // summary says": any injected key — including an identifier field from
  // another category — rejects the event.
  assert.deepEqual(
    Object.keys(featureUsageFixture).sort(),
    ['appVersion', 'features', 'platform', 'runtime', 'schemaVersion', 'timestamp', 'type', 'windowEndedAt', 'windowStartedAt'],
  );
  for (const extra of [
    { chatName: 'Refactor auth' },
    { sessionName: 'claude-7b3a2f1' },
    { path: '/home/alice/secret' },
    { host: 'deploy@prod.internal' },
  ]) {
    assert.equal(
      validateBaseEvent({ ...featureUsageFixture, ...extra }),
      false,
      `an injected ${Object.keys(extra)[0]} key must be rejected`,
    );
  }
});

test('feature-usage rejects malformed windows / rows', () => {
  for (const mutate of [
    (e) => { delete e.windowStartedAt; },
    (e) => { e.windowEndedAt = 'soon'; },
    (e) => { e.features = 'nope'; },
    (e) => { e.features = [{ name: 'global-search' }]; },
    (e) => { e.features = [{ count: 1 }]; },
    (e) => { e.features = ['global-search']; },
    (e) => { delete e.features; },
  ]) {
    const clone = JSON.parse(JSON.stringify(featureUsageFixture));
    mutate(clone);
    assert.equal(validateBaseEvent(clone), false, `mutation must invalidate: ${mutate.toString().slice(0, 60)}`);
  }
});


// ==========================================================================
// (h) process-memory (WARDEN-1508) — the memory vantage, riding the existing
//     operational-metrics category; numbers only over a closed key set.
// ==========================================================================

const processMemoryFixture = {
  schemaVersion: SCHEMA_VERSION,
  type: 'process-memory',
  runtime: 'main',
  timestamp: 1735689600000,
  appVersion: '0.1.86',
  platform: 'linux',
  windowStartedAt: 1735689300000,
  windowEndedAt: 1735689600000,
  samples: 10,
  rssMinBytes: 200_000_000,
  rssAvgBytes: 210_000_000,
  rssMaxBytes: 230_000_000,
  heapUsedMaxBytes: 90_000_000,
  processAgeMs: 3_600_000,
};

test('validateBaseEvent accepts the process-memory fixture for ALL THREE runtimes (v10 round trip)', () => {
  for (const runtime of ['main', 'renderer', 'server']) {
    assert.equal(validateBaseEvent({ ...processMemoryFixture, runtime }), true, `${runtime} validates`);
    assert.equal(validateEvent({ ...processMemoryFixture, runtime }), true, `${runtime} validateEvent`);
  }
});

test('process-memory: heapUsedMaxBytes is OPTIONAL (a runtime that exposes no heap omits it)', () => {
  const { heapUsedMaxBytes: _omit, ...noHeap } = processMemoryFixture;
  assert.equal(validateBaseEvent({ ...noHeap, runtime: 'renderer' }), true);
  assert.equal(validateBaseEvent({ ...processMemoryFixture, heapUsedMaxBytes: null }), false, 'null is not an omission');
  assert.equal(validateBaseEvent({ ...processMemoryFixture, heapUsedMaxBytes: -1 }), false);
  assert.equal(validateBaseEvent({ ...processMemoryFixture, heapUsedMaxBytes: '90' }), false);
});

test('process-memory rejects an EXTRA key (closed key set — no identifier can ride it)', () => {
  for (const extra of [{ name: 'x' }, { path: '/home/u' }, { host: 'a.example.com' }, { chatName: 'c' }, { pid: 123 }]) {
    assert.equal(validateBaseEvent({ ...processMemoryFixture, ...extra }), false, `${Object.keys(extra)[0]} must reject`);
  }
});

test('process-memory rejects STRING-valued fields', () => {
  for (const k of ['samples', 'rssMinBytes', 'rssAvgBytes', 'rssMaxBytes', 'heapUsedMaxBytes', 'processAgeMs', 'windowStartedAt', 'windowEndedAt']) {
    assert.equal(validateBaseEvent({ ...processMemoryFixture, [k]: '1' }), false, `string ${k} must reject`);
  }
});

test('process-memory rejects negative / non-integer / non-finite byte counts and ages', () => {
  for (const k of ['rssMinBytes', 'rssAvgBytes', 'rssMaxBytes', 'heapUsedMaxBytes', 'processAgeMs']) {
    for (const bad of [-1, 1.5, NaN, Infinity]) {
      // keep the min<=avg<=max order satisfiable so the count itself is the cause
      const ev = { ...processMemoryFixture, [k]: bad };
      assert.equal(validateBaseEvent(ev), false, `${k}=${bad} must reject`);
    }
  }
  for (const bad of [0, -1, 1.5, NaN]) {
    assert.equal(validateBaseEvent({ ...processMemoryFixture, samples: bad }), false, `samples=${bad} must reject`);
  }
});

test('process-memory honest-order invariant: rssMin > rssAvg or rssMin/rssAvg > rssMax rejects', () => {
  assert.equal(validateBaseEvent({ ...processMemoryFixture, rssMinBytes: 215_000_000 }), false, 'min > avg');
  assert.equal(validateBaseEvent({ ...processMemoryFixture, rssMinBytes: 240_000_000, rssAvgBytes: 250_000_000 }), false, 'min > max');
  assert.equal(validateBaseEvent({ ...processMemoryFixture, rssAvgBytes: 231_000_000 }), false, 'avg > max');
  assert.equal(validateBaseEvent({ ...processMemoryFixture, rssMinBytes: 5, rssAvgBytes: 5, rssMaxBytes: 5 }), true, 'equal is fine');
});

test('process-memory rejects a missing field and malformed window stamps', () => {
  for (const k of ['samples', 'rssMinBytes', 'rssAvgBytes', 'rssMaxBytes', 'processAgeMs', 'windowStartedAt', 'windowEndedAt']) {
    const ev = { ...processMemoryFixture };
    delete ev[k];
    assert.equal(validateBaseEvent(ev), false, `missing ${k} must reject`);
  }
  assert.equal(validateBaseEvent({ ...processMemoryFixture, windowEndedAt: NaN }), false);
});

test('process-memory carries NO field beyond the disclosed shape (closed key set census)', () => {
  assert.deepEqual(
    Object.keys(processMemoryFixture).sort(),
    ['appVersion', 'heapUsedMaxBytes', 'platform', 'processAgeMs', 'rssAvgBytes', 'rssMaxBytes', 'rssMinBytes', 'runtime', 'samples', 'schemaVersion', 'timestamp', 'type', 'windowEndedAt', 'windowStartedAt'],
  );
});

console.log(`\n✓ TELEMETRY-SCHEMA TESTS PASS (${passed})`);
