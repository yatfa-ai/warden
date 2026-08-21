// Tests for the consent-gated TelemetryClient (WARDEN-446 / WARDEN-443, reworked
// onto per-category consent by WARDEN-1116). Asserts the two invariants:
//   1. NOTHING COLLECTED = NOTHING RECORDED — record() is a guarded no-op unless
//      a COLLECTING category is on.
//   2. CATEGORIES ARE INDEPENDENT — setting one never changes another, and none
//      is subordinate to another. The old extended-requires-base clamp is gone;
//      a decorating category is safe on its own because it is INERT, which these
//      tests demonstrate rather than assume.
//
// No front-end test runner in this repo, so (like web/storage.test.mjs) this
// loads the REAL web/src/lib/telemetry/client.ts (transpiled TS -> ESM via Vite's
// OXC transform). client.ts runtime-imports ./schema and ./consent, so all three
// modules are transpiled into the same tmp dir and the relative specifiers are
// rewritten to the .mjs paths Node can resolve (the storage.test.mjs pattern).
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

// --- Transpile client.ts + its runtime siblings into one tmp dir -------------
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-telemetry-client-test-'));
for (const name of ['schema', 'consent', 'client']) {
  const modPath = resolve(__dirname, `src/lib/telemetry/${name}.ts`);
  let { code } = await transformWithOxc(readFileSync(modPath, 'utf8'), modPath, {});
  // Node ESM needs an explicit extension on a relative specifier (OXC may emit
  // either quote style, so match both).
  code = code
    .replace(/from\s+(['"])\.\/schema\1/g, 'from "./schema.mjs"')
    .replace(/from\s+(['"])\.\/consent\1/g, 'from "./consent.mjs"');
  writeFileSync(join(tmpDir, `${name}.mjs`), code);
}
const { createTelemetryClient } = await import(join(tmpDir, 'client.mjs'));
const { SCHEMA_VERSION } = await import(join(tmpDir, 'schema.mjs'));
rmSync(tmpDir, { recursive: true, force: true });

const ALL_OFF = { incidents: false, names: false };

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// A schema-valid base-tier event (matches slice 4's error-builder shape).
const errorEvent = {
  schemaVersion: SCHEMA_VERSION,
  type: 'error',
  runtime: 'main',
  timestamp: 1,
  name: 'Error',
  message: 'boom',
  frames: [],
};

// ==========================================================================
// (1) NOTHING COLLECTED = NOTHING RECORDED — everything off by default
// ==========================================================================

test('a fresh client defaults to every category off', () => {
  const c = createTelemetryClient();
  assert.deepEqual({ ...c.getConsent() }, ALL_OFF);
  assert.equal(c.isCollecting(), false);
  assert.equal(c.isCategoryOn('incidents'), false);
  assert.equal(c.isCategoryOn('names'), false);
});

test('with nothing collecting, record() records nothing (guarded no-op)', () => {
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
// (2) Records when a COLLECTING category is on — validates + enqueues
// ==========================================================================

test('turning `incidents` on makes the client collect, and record() enqueues a valid event', () => {
  const c = createTelemetryClient();
  c.setCategory('incidents', true);
  assert.equal(c.isCollecting(), true);
  assert.equal(c.record(errorEvent), true);
  assert.equal(c.size(), 1);
  assert.deepEqual(c.drain(), [errorEvent]);
});

test('record() drops an INVALID event even when a category is on', () => {
  const c = createTelemetryClient();
  c.setCategory('incidents', true);
  assert.equal(c.record({ schemaVersion: 999, type: 'nope' }), false);
  assert.equal(c.record(null), false);
  assert.equal(c.size(), 0, 'only schema-valid events are buffered');
});

test('drain() empties the buffer (the send-path seam)', () => {
  const c = createTelemetryClient({ maxBuffer: 10 });
  c.setCategory('incidents', true);
  c.record(errorEvent);
  c.record({ ...errorEvent, timestamp: 2 });
  assert.equal(c.size(), 2);
  const out = c.drain();
  assert.equal(out.length, 2);
  assert.equal(c.size(), 0, 'buffer cleared after drain');
});

test('the buffer is bounded — oldest events are dropped past maxBuffer', () => {
  const c = createTelemetryClient({ maxBuffer: 2 });
  c.setCategory('incidents', true);
  c.record({ ...errorEvent, timestamp: 1 });
  c.record({ ...errorEvent, timestamp: 2 });
  c.record({ ...errorEvent, timestamp: 3 }); // over cap → oldest (ts 1) dropped
  assert.equal(c.size(), 2);
  const out = c.drain();
  assert.deepEqual(out.map((e) => e.timestamp), [2, 3], 'oldest dropped, newest kept');
});

// ==========================================================================
// (3) INDEPENDENCE — no category implies, clamps, or revokes another
// ==========================================================================

test('enabling `names` alone does NOT enable collection — the decorating category is INERT', () => {
  // The property that makes the old "extended requires base" clamp unnecessary:
  // with nothing collecting there is no event for a name to ride on, so the
  // client records nothing. Demonstrated, not assumed.
  const c = createTelemetryClient();
  const applied = c.setCategory('names', true);
  assert.deepEqual({ ...applied }, { incidents: false, names: true },
    'the user\'s choice is stored VERBATIM — not silently clamped back off');
  assert.equal(c.isCollecting(), false, 'names alone collects nothing');
  assert.equal(c.record(errorEvent), false, 'and therefore records nothing');
  assert.equal(c.size(), 0);
});

test('setConsent({ names:true }) leaves every other category exactly as it was', () => {
  const c = createTelemetryClient();
  c.setConsent({ names: true });
  assert.deepEqual({ ...c.getConsent() }, { incidents: false, names: true },
    'turning one category on never turns another on');
});

test('setConsent({ incidents:true, names:true }) enables both', () => {
  const c = createTelemetryClient();
  const applied = c.setConsent({ incidents: true, names: true });
  assert.deepEqual({ ...applied }, { incidents: true, names: true });
  assert.equal(c.isCollecting(), true);
});

test('revoking `incidents` does NOT revoke `names` (no subordination)', () => {
  const c = createTelemetryClient();
  c.setConsent({ incidents: true, names: true });
  const applied = c.setCategory('incidents', false);
  assert.deepEqual({ ...applied }, { incidents: false, names: true },
    'names survives — it was never subordinate to incidents');
  assert.equal(c.isCollecting(), false, 'but nothing is collected any more');
});

test('revoking `names` does NOT revoke `incidents`', () => {
  const c = createTelemetryClient();
  c.setConsent({ incidents: true, names: true });
  const applied = c.setCategory('names', false);
  assert.deepEqual({ ...applied }, { incidents: true, names: false });
  assert.equal(c.isCollecting(), true, 'incidents keeps collecting');
});

test('each category toggles independently, in any order, with no ordering dependency', () => {
  const c = createTelemetryClient();
  assert.equal(c.setCategory('names', true).names, true, 'names can be set FIRST');
  assert.equal(c.setCategory('incidents', true).names, true, 'and survives incidents being set after');
  assert.deepEqual({ ...c.getConsent() }, { incidents: true, names: true });
});

// ==========================================================================
// (4) OFF-BY-DEFAULT SURVIVES EVERY FAILURE MODE
// ==========================================================================

test('a non-boolean value never flips a category', () => {
  const c = createTelemetryClient();
  c.setConsent({ incidents: 'true', names: 1 });
  assert.deepEqual({ ...c.getConsent() }, ALL_OFF, 'garbage leaves every category off');
  assert.equal(c.record(errorEvent), false);
});

test('replaceConsent() resolves missing / malformed / unrecognized state to nothing enabled', () => {
  for (const bad of [undefined, null, 42, 'extended', [], { unknownCategory: true }, { incidents: 'yes' }]) {
    const c = createTelemetryClient();
    c.replaceConsent(bad);
    assert.deepEqual({ ...c.getConsent() }, ALL_OFF, `resolves to nothing for ${JSON.stringify(bad)}`);
    assert.equal(c.record(errorEvent), false, `and records nothing for ${JSON.stringify(bad)}`);
  }
});

test('an unrecognized category key is ignored and can never enable collection', () => {
  const c = createTelemetryClient();
  c.setConsent({ usage: true });
  assert.deepEqual({ ...c.getConsent() }, ALL_OFF);
  assert.equal(c.isCollecting(), false);
});

console.log(`\n✓ TELEMETRY-CLIENT TESTS PASS (${passed})`);
