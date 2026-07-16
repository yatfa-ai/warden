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
const {
  SCHEMA_VERSION,
  BASE_EVENT_TYPES,
  RUNTIME,
  resolveConsentTier,
  isBaseEventType,
  isRuntime,
  validateBaseEvent,
  validateEvent,
} = await import(tmpFile);
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

test('SCHEMA_VERSION is 1 (the version client + receiver agree on)', () => {
  assert.equal(typeof SCHEMA_VERSION, 'number');
  assert.equal(SCHEMA_VERSION, 1);
});

test('BASE_EVENT_TYPES is exactly the three anonymous base-tier kinds', () => {
  assert.deepEqual([...BASE_EVENT_TYPES], ['error', 'crash', 'performance-stall']);
});

test('RUNTIME is exactly { main, renderer }', () => {
  assert.equal(RUNTIME.MAIN, 'main');
  assert.equal(RUNTIME.RENDERER, 'renderer');
});

test('the contract constants are frozen (immutable shared contract)', () => {
  assert.equal(Object.isFrozen(BASE_EVENT_TYPES), true);
  assert.equal(Object.isFrozen(RUNTIME), true);
});

// ==========================================================================
// (b) Consent tier resolution — unknown/missing defaults to OFF (most-safe)
// ==========================================================================

test('resolveConsentTier passes base/extended through and defaults everything else to off', () => {
  assert.equal(resolveConsentTier('base'), 'base');
  assert.equal(resolveConsentTier('extended'), 'extended');
  assert.equal(resolveConsentTier('off'), 'off');
  assert.equal(resolveConsentTier(undefined), 'off', 'missing consent is OFF');
  assert.equal(resolveConsentTier('bogus'), 'off', 'corrupt consent is OFF');
  assert.equal(resolveConsentTier(true), 'off', 'non-string consent is OFF');
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

test('validateBaseEvent crash needs a string reason AND must be the renderer', () => {
  assert.equal(validateBaseEvent({ ...crashFixture, reason: 5 }), false, 'crash reason must be string');
  assert.equal(validateBaseEvent({ ...crashFixture, reason: undefined }), false, 'crash needs a reason');
  assert.equal(validateBaseEvent({ ...crashFixture, runtime: 'main' }), false, 'crash is renderer by definition');
});

test('validateBaseEvent stall needs a numeric lagMs and a known source', () => {
  assert.equal(validateBaseEvent({ ...stallFixture, lagMs: '700' }), false, 'lagMs must be number');
  assert.equal(validateBaseEvent({ ...stallFixture, source: 'gpu' }), false, 'unknown source');
  assert.equal(validateBaseEvent({ ...stallFixture, runtime: RUNTIME.RENDERER, source: 'unresponsive' }), true, 'renderer unresponsive hang validates');
});

// ==========================================================================
// (e) validateEvent — extended-tier fields (chat/session names)
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

test('validateEvent still rejects a malformed base event even with good extended fields', () => {
  assert.equal(validateEvent({ ...errorFixture, type: 'bogus', chatName: 'x' }), false);
});

console.log(`\n✓ TELEMETRY-SCHEMA TESTS PASS (${passed})`);
