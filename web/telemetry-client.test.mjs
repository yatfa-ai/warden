// Tests for the consent-gated TelemetryClient (WARDEN-457, slice 1 of roadmap
// WARDEN-446 / design WARDEN-443). Asserts the two invariants this slice ships:
//   1. OFF = NOTHING — record() is a guarded no-op while consent is off.
//   2. EXTENDED REQUIRES BASE — enforced at every setter (the UI + server clamp
//      are defense-in-depth; the client is the third layer).
//
// No front-end test runner in this repo, so (like web/storage.test.mjs) this
// loads the REAL web/src/lib/telemetry/client.ts (transpiled TS -> ESM via Vite's
// OXC transform). client.ts runtime-imports validateEvent from ./schema, so BOTH
// modules are transpiled into the same tmp dir and the relative specifier is
// rewritten to the .mjs path Node can resolve (the storage.test.mjs pattern).
//
// Auto-discovered by `npm run dev:test` (`node --test` in web/).
//
// Run: node telemetry-client.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Transpile client.ts + schema.ts into one tmp dir, rewrite the specifier ---
const clientPath = resolve(__dirname, 'src/lib/telemetry/client.ts');
const schemaPath = resolve(__dirname, 'src/lib/telemetry/schema.ts');
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-telemetry-client-test-'));
const { code: schemaCode } = await transformWithOxc(readFileSync(schemaPath, 'utf8'), schemaPath, {});
const { code: clientCode } = await transformWithOxc(readFileSync(clientPath, 'utf8'), clientPath, {});
writeFileSync(join(tmpDir, 'schema.mjs'), schemaCode);
// client.ts imports from './schema' — rewrite the specifier to the .mjs path Node
// resolves (OXC may emit either quote style, so match both).
writeFileSync(join(tmpDir, 'client.mjs'), clientCode.replace(/from\s+(['"])\.\/schema\1/g, 'from "./schema.mjs"'));
const { createTelemetryClient } = await import(join(tmpDir, 'client.mjs'));
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// A schema-valid base-tier event (matches slice 4's error-builder shape).
const errorEvent = {
  schemaVersion: 1,
  type: 'error',
  runtime: 'main',
  timestamp: 1,
  name: 'Error',
  message: 'boom',
  frames: [],
};

// ==========================================================================
// (1) OFF = NOTHING — consent defaults off; record() is a guarded no-op
// ==========================================================================

test('a fresh client defaults to off (both tiers false)', () => {
  const c = createTelemetryClient();
  assert.deepEqual(c.getConsent(), { base: false, extended: false });
  assert.equal(c.getTier(), 'off');
  assert.equal(c.isConsentOn(), false);
});

test('with consent OFF, record() records nothing (guarded no-op)', () => {
  const c = createTelemetryClient();
  assert.equal(c.record(errorEvent), false, 'returns false — nothing enqueued');
  assert.equal(c.size(), 0);
  assert.deepEqual(c.drain(), []);
});

test('record() does not throw on garbage while off and buffers nothing', () => {
  const c = createTelemetryClient();
  assert.doesNotThrow(() => c.record(null));
  assert.doesNotThrow(() => c.record({ bogus: true }));
  assert.equal(c.size(), 0);
});

// ==========================================================================
// (2) Records when base is on — validates + enqueues
// ==========================================================================

test('turning base on moves the tier to "base" and record() enqueues a valid event', () => {
  const c = createTelemetryClient();
  c.setBaseConsent(true);
  assert.equal(c.getTier(), 'base');
  assert.equal(c.isConsentOn(), true);
  assert.equal(c.record(errorEvent), true);
  assert.equal(c.size(), 1);
  assert.deepEqual(c.drain(), [errorEvent]);
});

test('record() drops an INVALID event even when consent is on', () => {
  const c = createTelemetryClient();
  c.setBaseConsent(true);
  assert.equal(c.record({ schemaVersion: 999, type: 'nope' }), false);
  assert.equal(c.record(null), false);
  assert.equal(c.size(), 0, 'only schema-valid events are buffered');
});

test('drain() empties the buffer (the send-path seam)', () => {
  const c = createTelemetryClient({ maxBuffer: 10 });
  c.setBaseConsent(true);
  c.record(errorEvent);
  c.record({ ...errorEvent, timestamp: 2 });
  assert.equal(c.size(), 2);
  const out = c.drain();
  assert.equal(out.length, 2);
  assert.equal(c.size(), 0, 'buffer cleared after drain');
});

test('the buffer is bounded — oldest events are dropped past maxBuffer', () => {
  const c = createTelemetryClient({ maxBuffer: 2 });
  c.setBaseConsent(true);
  c.record({ ...errorEvent, timestamp: 1 });
  c.record({ ...errorEvent, timestamp: 2 });
  c.record({ ...errorEvent, timestamp: 3 }); // over cap → oldest (ts 1) dropped
  assert.equal(c.size(), 2);
  const out = c.drain();
  assert.deepEqual(out.map((e) => e.timestamp), [2, 3], 'oldest dropped, newest kept');
});

// ==========================================================================
// (3) EXTENDED REQUIRES BASE — enforced at every setter
// ==========================================================================

test('setExtendedConsent(true) is ignored while base is off', () => {
  const c = createTelemetryClient();
  const applied = c.setExtendedConsent(true);
  assert.deepEqual(applied, { base: false, extended: false }, 'clamped to false');
  assert.equal(c.getTier(), 'off');
});

test('setConsent({ extended:true }) without base clamps extended to false', () => {
  const c = createTelemetryClient();
  const applied = c.setConsent({ extended: true });
  assert.deepEqual(applied, { base: false, extended: false });
  assert.equal(c.getTier(), 'off');
});

test('setConsent({ base:true, extended:true }) enables both → tier "extended"', () => {
  const c = createTelemetryClient();
  const applied = c.setConsent({ base: true, extended: true });
  assert.deepEqual(applied, { base: true, extended: true });
  assert.equal(c.getTier(), 'extended');
});

test('setBaseConsent(false) latches extended off (revoking base revokes the subordinate tier)', () => {
  const c = createTelemetryClient();
  c.setConsent({ base: true, extended: true });
  assert.equal(c.getTier(), 'extended');
  const applied = c.setBaseConsent(false);
  assert.deepEqual(applied, { base: false, extended: false });
  assert.equal(c.getTier(), 'off');
});

test('extended can be toggled independently only while base is on', () => {
  const c = createTelemetryClient();
  c.setBaseConsent(true);
  assert.equal(c.setExtendedConsent(true).extended, true);
  assert.equal(c.getTier(), 'extended');
  assert.equal(c.setExtendedConsent(false).extended, false);
  assert.equal(c.getTier(), 'base');
});

console.log(`\n✓ TELEMETRY-CLIENT TESTS PASS (${passed})`);
