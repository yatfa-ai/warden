// Tests for THE telemetry consent authority (WARDEN-1116) —
// web/src/lib/telemetry/consent.ts.
//
// This module is the ONE place a consent decision is made. Every gate in the
// pipeline (redaction, the source's arm/disarm, the pipeline's send gate, the
// transparency catalog, the Settings surface, the server's config write path,
// the Electron boot read) consults it rather than deciding for itself. So the
// properties asserted here are the ones the whole feature rests on:
//
//   1. OFF BY DEFAULT, in every failure mode. Missing, partial, non-boolean,
//      corrupt, unrecognized, or a stale tier string from an older build — all
//      resolve to nothing enabled.
//   2. INDEPENDENCE (WARDEN-443 Principle 2). Turning one category on never turns
//      another on; turning one off never turns another off; there is no ordering
//      and no clamp.
//   3. MIGRATION. A config written by a pre-WARDEN-1116 build carries the user's
//      EFFECTIVE consent forward — nothing new is silently enabled.
//   4. THE REGISTRY IS DATA. Adding a category is an entry, not a redesign: the
//      structural assertions below hold for whatever the registry contains, so
//      they keep guarding a category that does not exist yet.
//
// Like web/telemetry-redact.test.mjs, this loads the REAL TypeScript module via
// Vite's OXC transform. consent.ts has ZERO runtime imports, so the emitted
// module loads standalone.
//
// Auto-discovered by `npm test` in web/ (`node --test`).
//
// Run: node telemetry-consent.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modPath = resolve(__dirname, 'src/lib/telemetry/consent.ts');
const { code } = await transformWithOxc(readFileSync(modPath, 'utf8'), modPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-telemetry-consent-test-'));
const tmpFile = join(tmpDir, 'consent.mjs');
writeFileSync(tmpFile, code);
const {
  TELEMETRY_CATEGORIES,
  TELEMETRY_CATEGORY_IDS,
  CATEGORY_BY_ID,
  GATED_FIELD_CATEGORY,
  NO_CONSENT,
  normalizeConsent,
  resolveConsent,
  migrateConsentPrefs,
  consentToPrefs,
  isCategoryEnabled,
  enabledCategories,
  collectsEvents,
  collectedEventTypes,
  retainedFields,
  withCategory,
} = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

/** Every value a persisted / injected consent can degenerate to. */
const GARBAGE = [
  undefined,
  null,
  42,
  0,
  '',
  'off',
  'base',      // a stale TIER STRING from a pre-WARDEN-1116 build
  'extended',
  true,
  false,
  [],
  [['incidents', true]],
  { unknownCategory: true },
  { incidents: 'true' },
  { incidents: 1 },
  { incidents: null },
];

const ALL_OFF = Object.fromEntries(TELEMETRY_CATEGORY_IDS.map((id) => [id, false]));
const ALL_ON = Object.fromEntries(TELEMETRY_CATEGORY_IDS.map((id) => [id, true]));

console.log('\nthe registry — data, with a real producer behind every entry');

test('every category declares the full descriptor the derived surfaces need', () => {
  // The forcing function for "a new category is a DATA addition": if an entry is
  // missing any of these, some derived surface (config field, migration, gate,
  // catalog, Settings switch) silently has nothing to work with.
  assert.ok(TELEMETRY_CATEGORIES.length > 0, 'the registry is non-empty');
  for (const c of TELEMETRY_CATEGORIES) {
    assert.equal(typeof c.id, 'string');
    assert.ok(c.id.length > 0, 'a category has a stable id');
    assert.equal(c.configKey, `telemetry${c.id[0].toUpperCase()}${c.id.slice(1)}Enabled`,
      `${c.id}'s config key follows the derivable convention`);
    assert.equal(typeof c.legacy.key, 'string', `${c.id} declares where to migrate from`);
    assert.ok(c.role === 'collecting' || c.role === 'decorating', `${c.id} declares a role`);
    assert.ok(c.label.length > 0, `${c.id} has a Settings label`);
    assert.ok(c.summary.length > 0, `${c.id} has an honest user-facing summary`);
    assert.ok(Array.isArray(c.eventTypes) && Array.isArray(c.gatedFields));
  }
});

test('NO category is declared without a real producer behind it', () => {
  // The ticket's hard rule: "No switch is exposed for a category that collects
  // nothing yet." A category that neither produces an event type nor gates a
  // field would surface a toggle that does nothing — WARDEN-131's silent-no-op
  // trap on a consent surface, where it is worst.
  for (const c of TELEMETRY_CATEGORIES) {
    assert.ok(
      c.eventTypes.length > 0 || c.gatedFields.length > 0,
      `${c.id} must produce events or gate fields — otherwise it is an empty switch`,
    );
  }
});

test('at least one COLLECTING category exists, and a DECORATING category gates fields', () => {
  const collecting = TELEMETRY_CATEGORIES.filter((c) => c.role === 'collecting');
  assert.ok(collecting.length > 0, 'something must actually produce events');
  for (const c of collecting) assert.ok(c.eventTypes.length > 0, `${c.id} produces event types`);
  for (const c of TELEMETRY_CATEGORIES.filter((x) => x.role === 'decorating')) {
    assert.ok(c.gatedFields.length > 0, `${c.id} gates at least one field`);
  }
});

test('ids, lookup map, and gated-field map are all derived consistently', () => {
  assert.deepEqual([...TELEMETRY_CATEGORY_IDS], TELEMETRY_CATEGORIES.map((c) => c.id));
  for (const c of TELEMETRY_CATEGORIES) assert.equal(CATEGORY_BY_ID.get(c.id), c);
  for (const c of TELEMETRY_CATEGORIES) {
    for (const f of c.gatedFields) {
      assert.equal(GATED_FIELD_CATEGORY.get(f), c.id, `${f} is gated by ${c.id}`);
      assert.equal(f, f.toLowerCase(), 'gated field names are lowercased for case-insensitive matching');
    }
  }
});

test('no field is gated by two categories (an ambiguous gate would be undecidable)', () => {
  const seen = new Set();
  for (const c of TELEMETRY_CATEGORIES) {
    for (const f of c.gatedFields) {
      assert.ok(!seen.has(f), `${f} is claimed by more than one category`);
      seen.add(f);
    }
  }
});

console.log('\noff by default — in EVERY failure mode');

test('NO_CONSENT has every category off', () => {
  assert.deepEqual({ ...NO_CONSENT }, ALL_OFF);
  assert.equal(collectsEvents(NO_CONSENT), false);
});

test('normalizeConsent resolves every degenerate value to nothing enabled', () => {
  for (const bad of GARBAGE) {
    assert.deepEqual({ ...normalizeConsent(bad) }, ALL_OFF, `nothing enabled for ${JSON.stringify(bad)}`);
    assert.equal(collectsEvents(normalizeConsent(bad)), false, `not collecting for ${JSON.stringify(bad)}`);
  }
});

test('resolveConsent resolves every degenerate value to nothing enabled', () => {
  for (const bad of GARBAGE) {
    assert.deepEqual({ ...resolveConsent(bad) }, ALL_OFF, `nothing enabled for ${JSON.stringify(bad)}`);
  }
});

test('ONLY the strict boolean true enables a category — never a truthy value', () => {
  for (const c of TELEMETRY_CATEGORIES) {
    for (const truthy of ['true', 1, {}, [], 'yes', Infinity]) {
      assert.equal(normalizeConsent({ [c.id]: truthy })[c.id], false,
        `${c.id} not enabled by ${JSON.stringify(truthy)}`);
      assert.equal(resolveConsent({ [c.configKey]: truthy })[c.id], false,
        `${c.configKey} not enabled by ${JSON.stringify(truthy)}`);
    }
    assert.equal(normalizeConsent({ [c.id]: true })[c.id], true, `${c.id} enabled by a real true`);
  }
});

test('an unrecognized key is ignored and can never enable anything', () => {
  assert.deepEqual({ ...normalizeConsent({ usage: true, everything: true }) }, ALL_OFF);
  assert.deepEqual({ ...resolveConsent({ telemetryUsageEnabled: true }) }, ALL_OFF);
});

test('a PARTIAL state leaves the unmentioned categories off', () => {
  for (const c of TELEMETRY_CATEGORIES) {
    const out = normalizeConsent({ [c.id]: true });
    assert.equal(out[c.id], true);
    for (const other of TELEMETRY_CATEGORIES) {
      if (other.id === c.id) continue;
      assert.equal(out[other.id], false, `${other.id} stays off when only ${c.id} is set`);
    }
  }
});

test('the resolved state is FROZEN — a caller cannot mutate consent after the fact', () => {
  const c = resolveConsent({ telemetryIncidentsEnabled: true });
  assert.ok(Object.isFrozen(c));
  assert.throws(() => { 'use strict'; c.names = true; }, TypeError);
});

console.log('\nINDEPENDENCE — no category implies, clamps, or revokes another');

test('enabling one category never enables another (every pair, both directions)', () => {
  for (const a of TELEMETRY_CATEGORIES) {
    const out = normalizeConsent({ [a.id]: true });
    for (const b of TELEMETRY_CATEGORIES) {
      if (a.id === b.id) continue;
      assert.equal(out[b.id], false, `enabling ${a.id} must not enable ${b.id}`);
    }
  }
});

test('disabling one category never disables another (every pair, both directions)', () => {
  for (const a of TELEMETRY_CATEGORIES) {
    const out = withCategory(normalizeConsent(ALL_ON), a.id, false);
    assert.equal(out[a.id], false, `${a.id} was disabled`);
    for (const b of TELEMETRY_CATEGORIES) {
      if (a.id === b.id) continue;
      assert.equal(out[b.id], true, `disabling ${a.id} must not disable ${b.id}`);
    }
  }
});

test('order does not matter — flipping categories in any sequence lands on the same state', () => {
  const ids = [...TELEMETRY_CATEGORY_IDS];
  const forward = ids.reduce((acc, id) => withCategory(acc, id, true), NO_CONSENT);
  const backward = [...ids].reverse().reduce((acc, id) => withCategory(acc, id, true), NO_CONSENT);
  assert.deepEqual({ ...forward }, { ...backward });
  assert.deepEqual({ ...forward }, ALL_ON);
});

test('a DECORATING category alone never causes collection (inert, not clamped)', () => {
  for (const c of TELEMETRY_CATEGORIES.filter((x) => x.role === 'decorating')) {
    const only = normalizeConsent({ [c.id]: true });
    assert.equal(only[c.id], true, `${c.id} is genuinely enabled — not clamped away`);
    assert.equal(collectsEvents(only), false, `${c.id} alone collects nothing`);
    assert.deepEqual(collectedEventTypes(only), [], `${c.id} alone produces no event types`);
  }
});

test('a COLLECTING category alone opens the send gate', () => {
  for (const c of TELEMETRY_CATEGORIES.filter((x) => x.role === 'collecting')) {
    const only = normalizeConsent({ [c.id]: true });
    assert.equal(collectsEvents(only), true, `${c.id} alone collects`);
    assert.deepEqual(collectedEventTypes(only), [...c.eventTypes]);
  }
});

console.log('\nqueries every gate uses');

test('isCategoryEnabled / enabledCategories reflect the state (unknown ids are off)', () => {
  const c = normalizeConsent({ incidents: true });
  assert.equal(isCategoryEnabled(c, 'incidents'), true);
  assert.equal(isCategoryEnabled(c, 'names'), false);
  assert.equal(isCategoryEnabled(c, 'nope'), false, 'an unknown id is never enabled');
  assert.deepEqual(enabledCategories(c), ['incidents']);
  assert.deepEqual(enabledCategories(NO_CONSENT), []);
});

test('retainedFields lists exactly the enabled categories\' gated fields, in registry order', () => {
  assert.deepEqual(retainedFields(NO_CONSENT), []);
  const all = retainedFields(normalizeConsent(ALL_ON));
  assert.deepEqual(all, TELEMETRY_CATEGORIES.flatMap((c) => [...c.gatedFields]));
  for (const c of TELEMETRY_CATEGORIES) {
    assert.deepEqual(retainedFields(normalizeConsent({ [c.id]: true })), [...c.gatedFields]);
  }
});

test('collectedEventTypes de-duplicates across categories', () => {
  const types = collectedEventTypes(normalizeConsent(ALL_ON));
  assert.deepEqual(types, [...new Set(types)], 'no event type is listed twice');
});

console.log('\npersisted representation — config keys round-trip');

test('consentToPrefs projects onto the persisted config keys', () => {
  const prefs = consentToPrefs(normalizeConsent({ incidents: true }));
  assert.deepEqual(prefs, { telemetryIncidentsEnabled: true, telemetryNamesEnabled: false });
});

test('consentToPrefs → resolveConsent is a lossless round trip', () => {
  for (const state of [ALL_OFF, ALL_ON, { incidents: true, names: false }, { incidents: false, names: true }]) {
    const consent = normalizeConsent(state);
    assert.deepEqual({ ...resolveConsent(consentToPrefs(consent)) }, { ...consent });
  }
});

console.log('\nMIGRATION — a pre-WARDEN-1116 config carries forward with no behavioral change');

test('the legacy pair maps to the equivalent categories', () => {
  assert.deepEqual({ ...resolveConsent({ telemetryBaseEnabled: true, telemetryExtendedEnabled: true }) },
    { incidents: true, names: true });
  assert.deepEqual({ ...resolveConsent({ telemetryBaseEnabled: true, telemetryExtendedEnabled: false }) },
    { incidents: true, names: false });
  assert.deepEqual({ ...resolveConsent({ telemetryBaseEnabled: false, telemetryExtendedEnabled: false }) },
    ALL_OFF);
});

test('a base-only legacy config does NOT silently enable names', () => {
  assert.deepEqual({ ...resolveConsent({ telemetryBaseEnabled: true }) }, { incidents: true, names: false });
});

test('a stale extended-WITHOUT-base legacy pair migrates to nothing enabled', () => {
  // The old model clamped this to "send nothing". Carrying the RAW flag forward
  // would enable a category the user's effective consent never had on.
  assert.deepEqual({ ...resolveConsent({ telemetryBaseEnabled: false, telemetryExtendedEnabled: true }) },
    ALL_OFF);
});

test('a non-boolean legacy value never migrates into consent', () => {
  assert.deepEqual({ ...resolveConsent({ telemetryBaseEnabled: 'true', telemetryExtendedEnabled: 1 }) }, ALL_OFF);
});

test('once a new key EXISTS it wins — a leftover legacy key cannot resurrect a revoked category', () => {
  assert.deepEqual(
    {
      ...resolveConsent({
        telemetryBaseEnabled: true,
        telemetryExtendedEnabled: true,
        telemetryIncidentsEnabled: false,
        telemetryNamesEnabled: false,
      }),
    },
    ALL_OFF,
  );
});

test('a CORRUPT new key resolves to off instead of falling back to the legacy key', () => {
  // Falling back would reinterpret a corrupt value into an enabled state.
  assert.deepEqual(
    { ...resolveConsent({ telemetryBaseEnabled: true, telemetryIncidentsEnabled: 'true' }) },
    ALL_OFF,
  );
});

test('migrateConsentPrefs materializes the new keys WITHOUT destroying the legacy ones', () => {
  const before = { telemetryBaseEnabled: true, telemetryExtendedEnabled: true, hosts: ['a'] };
  const after = migrateConsentPrefs(before);
  assert.equal(after.telemetryIncidentsEnabled, true);
  assert.equal(after.telemetryNamesEnabled, true);
  assert.equal(after.telemetryBaseEnabled, true, 'the legacy key is left on disk (a downgrade still finds it)');
  assert.deepEqual(after.hosts, ['a'], 'unrelated keys are untouched');
  assert.deepEqual(before, { telemetryBaseEnabled: true, telemetryExtendedEnabled: true, hosts: ['a'] },
    'the input is not mutated');
});

test('migrateConsentPrefs is IDEMPOTENT — re-migrating an already-migrated config is a no-op', () => {
  const once = migrateConsentPrefs({ telemetryBaseEnabled: true, telemetryExtendedEnabled: true });
  assert.deepEqual(migrateConsentPrefs(once), once);
});

test('migrateConsentPrefs on garbage yields the safe all-off keys without throwing', () => {
  for (const bad of [{}, { junk: 1 }]) {
    const out = migrateConsentPrefs(bad);
    for (const c of TELEMETRY_CATEGORIES) assert.equal(out[c.configKey], false);
  }
});

console.log(`\n✓ TELEMETRY CONSENT AUTHORITY TESTS PASS (${passed})`);
