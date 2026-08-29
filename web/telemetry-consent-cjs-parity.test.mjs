// CJS consent PARITY tests (WARDEN-1116). The consent authority exists twice:
//
//   • web/src/lib/telemetry/consent.ts — the canonical TypeScript module the
//     renderer (Settings, the transparency panel) imports.
//   • src/telemetry-consent.cjs        — the CJS mirror the Electron MAIN process
//     and the backend SERVER both load (neither can require TypeScript).
//
// A divergence between them would mean the renderer and the processes that
// actually gate collection disagree about what the user consented to — the worst
// possible bug on a consent surface, and one no other test would catch. This
// suite loads BOTH and asserts they are behaviorally identical: same registry,
// same resolver, same queries, same migration, across every persisted shape
// including the corrupt / missing / stale-tier ones.
//
// Same discipline as web/telemetry-redact-cjs-parity.test.mjs.
//
// Auto-discovered by `npm test` in web/ (`node --test`).
//
// Run: node telemetry-consent-cjs-parity.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// --- Load the REAL consent.ts (TS -> ESM via the OXC transform Vite bundles) ---
const tsPath = resolve(__dirname, 'src/lib/telemetry/consent.ts');
const { code } = await transformWithOxc(readFileSync(tsPath, 'utf8'), tsPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-telemetry-consent-parity-'));
const tsTmp = join(tmpDir, 'consent.mjs');
writeFileSync(tsTmp, code);
const ts = await import(tsTmp);
rmSync(tmpDir, { recursive: true, force: true });

// --- Load the CJS mirror ------------------------------------------------------
const cjs = require('../src/telemetry-consent.cjs');

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// Plain-object views so deepEqual compares VALUES, not frozen-object identity.
const plain = (o) => ({ ...o });
const descriptorView = (c) => ({
  id: c.id,
  configKey: c.configKey,
  legacy: { key: c.legacy.key, requires: c.legacy.requires },
  role: c.role,
  label: c.label,
  summary: c.summary,
  eventTypes: [...c.eventTypes],
  gatedFields: [...c.gatedFields],
});

console.log('\nparity — the REGISTRY is identical (ids, order, and every descriptor field)');

test('the same category ids, in the same order', () => {
  assert.deepEqual([...cjs.TELEMETRY_CATEGORY_IDS], [...ts.TELEMETRY_CATEGORY_IDS]);
});

test('every descriptor is field-for-field identical (labels + summaries included)', () => {
  // The user-facing copy matters too: the Settings switch reads the TS label while
  // the server documents the CJS one. Divergence there is a lie to the user.
  assert.deepEqual(
    cjs.TELEMETRY_CATEGORIES.map(descriptorView),
    ts.TELEMETRY_CATEGORIES.map(descriptorView),
  );
});

test('the gated-field → category map is identical', () => {
  assert.deepEqual([...cjs.GATED_FIELD_CATEGORY.entries()].sort(), [...ts.GATED_FIELD_CATEGORY.entries()].sort());
});

test('NO_CONSENT is identical', () => {
  assert.deepEqual(plain(cjs.NO_CONSENT), plain(ts.NO_CONSENT));
});

console.log('\nparity — the RESOLVER decides identically across every persisted shape');

// Every shape a persisted / injected consent value can take: per-category keys,
// the legacy pair (migration), corrupt values, unrecognized keys, stale tier
// strings from a pre-WARDEN-1116 build, and outright garbage.
const PREF_BATTERY = [
  {},
  { telemetryIncidentsEnabled: true },
  { telemetryNamesEnabled: true },
  { telemetryIncidentsEnabled: true, telemetryNamesEnabled: true },
  { telemetryIncidentsEnabled: false, telemetryNamesEnabled: true },
  { telemetryIncidentsEnabled: 'true', telemetryNamesEnabled: 1 },
  { telemetryIncidentsEnabled: null },
  { telemetryBaseEnabled: true },
  { telemetryBaseEnabled: true, telemetryExtendedEnabled: true },
  { telemetryBaseEnabled: false, telemetryExtendedEnabled: true },
  { telemetryBaseEnabled: 'true', telemetryExtendedEnabled: 1 },
  { telemetryBaseEnabled: true, telemetryIncidentsEnabled: false },
  { telemetryBaseEnabled: true, telemetryIncidentsEnabled: 'true' },
  { telemetryUsageEnabled: true },
  { hosts: ['a'], llm: {} },
  null,
  undefined,
  42,
  0,
  '',
  'off',
  'base',
  'extended',
  true,
  [],
];

for (const prefs of PREF_BATTERY) {
  test(`resolveConsent parity for ${String(JSON.stringify(prefs)).slice(0, 64)}`, () => {
    assert.deepEqual(plain(cjs.resolveConsent(prefs)), plain(ts.resolveConsent(prefs)));
  });
}

const STATE_BATTERY = [
  {},
  { incidents: true },
  { names: true },
  { incidents: true, names: true },
  { incidents: 'yes' },
  { incidents: 1 },
  { unknown: true },
  null,
  undefined,
  'extended',
  42,
  [],
];

for (const state of STATE_BATTERY) {
  test(`normalizeConsent parity for ${String(JSON.stringify(state)).slice(0, 64)}`, () => {
    assert.deepEqual(plain(cjs.normalizeConsent(state)), plain(ts.normalizeConsent(state)));
  });
}

console.log('\nparity — the QUERIES every gate uses agree');

for (const state of STATE_BATTERY) {
  test(`query parity for ${String(JSON.stringify(state)).slice(0, 64)}`, () => {
    const c1 = cjs.normalizeConsent(state);
    const c2 = ts.normalizeConsent(state);
    assert.equal(cjs.collectsEvents(c1), ts.collectsEvents(c2), 'collectsEvents');
    assert.deepEqual(cjs.enabledCategories(c1), ts.enabledCategories(c2), 'enabledCategories');
    assert.deepEqual(cjs.collectedEventTypes(c1), ts.collectedEventTypes(c2), 'collectedEventTypes');
    assert.deepEqual(cjs.retainedFields(c1), ts.retainedFields(c2), 'retainedFields');
    assert.deepEqual(cjs.consentToPrefs(c1), ts.consentToPrefs(c2), 'consentToPrefs');
    for (const id of [...ts.TELEMETRY_CATEGORY_IDS, 'nope']) {
      assert.equal(cjs.isCategoryEnabled(c1, id), ts.isCategoryEnabled(c2, id), `isCategoryEnabled(${id})`);
    }
  });
}

test('withCategory parity across every category × both directions', () => {
  for (const id of ts.TELEMETRY_CATEGORY_IDS) {
    for (const on of [true, false]) {
      for (const state of STATE_BATTERY) {
        assert.deepEqual(
          plain(cjs.withCategory(cjs.normalizeConsent(state), id, on)),
          plain(ts.withCategory(ts.normalizeConsent(state), id, on)),
          `withCategory(${id}, ${on}) for ${JSON.stringify(state)}`,
        );
      }
    }
  }
});

console.log('\nparity — MIGRATION produces identical prefs');

for (const prefs of PREF_BATTERY.filter((p) => p && typeof p === 'object' && !Array.isArray(p))) {
  test(`migrateConsentPrefs parity for ${String(JSON.stringify(prefs)).slice(0, 64)}`, () => {
    assert.deepEqual(cjs.migrateConsentPrefs(prefs), ts.migrateConsentPrefs(prefs));
  });
}

console.log(`\n✓ TELEMETRY CJS-CONSENT PARITY TESTS PASS (${passed})`);
