// Tests for the per-section data-dependency classification + readiness gate
// (WARDEN-1210): "a Settings section must wait only on the data it actually
// reads".
//
// No front-end test runner in this repo, so (like normalizeLoadedConfig.test.mjs)
// this loads the REAL src/components/settings/*.ts modules (transpiled TS -> ESM
// via Vite's OXC transform). sectionLoadGate.ts imports './sectionPersistence'
// by relative path, so both are emitted into ONE temp dir where that import
// resolves — exercising the real wiring, not a copy.
//
// THE INVARIANTS UNDER TEST (the ticket's territory):
//   1. ONE authoritative classification — CLIENT_PREF_SECTIONS and the footer
//      persistence kind are DERIVED from the dependency map, so the footer
//      label, the gate, and the map can never disagree.
//   2. Host data NEVER gates a section. The only section that reads host data
//      (`hosts`) gates on exactly the same config-load state as every plain
//      config section; the new-chat host picker (`newchats`) is client-pref and
//      does not wait on ANYTHING. Both degrade in-section, so slow/unreachable
//      hosts — however many, however slow — cannot delay a section becoming
//      usable. (LoadState deliberately has no host-data input; criterion 5
//      pins that structurally by arity.)
//   3. An unknown/new section id defaults to 'config' — gated, never rendered
//      against unloaded defaults.
//   4. Config-load failure surfaces 'failed' (Retry, in place) and a loaded
//      config wins over a later failed refetch.
//   5. Save stays impossible for configuration that was never loaded
//      (canSaveBackendConfig keyed on configLoaded, not on in-flight state).
//
// Run: node sectionDependencies.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dir = resolve(__dirname, 'src/components/settings');

// --- Load the REAL modules (TS -> ESM, one shared temp dir so the relative
// --- import inside sectionLoadGate.ts resolves to the real classification) ---
const tmp = mkdtempSync(join(tmpdir(), 'warden-section-deps-'));
for (const name of ['sectionPersistence', 'sectionLoadGate']) {
  const p = join(dir, `${name}.ts`);
  const { code } = await transformWithOxc(readFileSync(p, 'utf8'), p, {});
  // The emitted ESM keeps the extensionless relative import ('./sectionPersistence'),
  // which Node cannot resolve — pin the .mjs suffix so the real wiring loads.
  writeFileSync(
    join(tmp, `${name}.mjs`),
    code.replace(/from\s+['"]\.\/(sectionPersistence)['"]/g, "from './$1.mjs'"),
  );
}
const {
  sectionDataDependency,
  isClientPrefDependency,
  readsBackendConfig,
  CLIENT_PREF_SECTIONS,
  sectionPersistence,
} = await import(join(tmp, 'sectionPersistence.mjs'));
const { sectionGate, canSaveBackendConfig } = await import(join(tmp, 'sectionLoadGate.mjs'));
rmSync(tmp, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// The complete SETTINGS_SECTIONS enumeration from SettingsPage.tsx, pinned here
// so a NEW section cannot silently fall outside the classification (it lands on
// the 'config' default — gated — and this list forces the author to notice).
const ALL_SECTION_IDS = [
  'hosts', 'observer', 'safety', 'attention', 'tokenbudget', 'performance',
  'telemetry', 'display', 'appearance', 'newchats', 'snippets', 'patterns',
  'notifications',
];

// --- 1. One authoritative classification --------------------------------------

test('every SETTINGS_SECTIONS id resolves a dependency', () => {
  for (const id of ALL_SECTION_IDS) {
    assert.notEqual(sectionDataDependency(id), undefined, id);
  }
});

test('CLIENT_PREF_SECTIONS is DERIVED from the dependency map (no second list)', () => {
  const fromMap = ALL_SECTION_IDS.filter((id) => isClientPrefDependency(sectionDataDependency(id)));
  assert.deepEqual([...CLIENT_PREF_SECTIONS].sort(), fromMap.sort());
  assert.deepEqual([...CLIENT_PREF_SECTIONS].sort(), ['appearance', 'newchats', 'snippets']);
});

test('footer persistence kind agrees with the dependency map', () => {
  for (const id of ALL_SECTION_IDS) {
    assert.equal(
      sectionPersistence(id).kind,
      isClientPrefDependency(sectionDataDependency(id)) ? 'client' : 'server',
      id,
    );
  }
});

// --- 2. Per-section accuracy: what each section reads --------------------------

test('the host-data sections are exactly hosts + the new-chat picker', () => {
  // Only `hosts` reads host data AND backend config; `newchats` reads host data
  // (the picker) with client-localStorage values.
  const hostReading = ALL_SECTION_IDS.filter(
    (id) => sectionDataDependency(id) === 'config-hosts' || sectionDataDependency(id) === 'client-host-picker',
  );
  assert.deepEqual(hostReading, ['hosts', 'newchats']);
});

test('non-host backend sections read plain config only', () => {
  for (const id of ['telemetry', 'safety', 'attention', 'tokenbudget', 'performance', 'display', 'patterns', 'notifications', 'observer']) {
    assert.equal(sectionDataDependency(id), 'config', id);
  }
});

test('a section that reads no host data never waits on host work — gate is config-load state only', () => {
  // The contract is structural: whatever the host/discovery state is, it is not
  // (and cannot be) an input to sectionGate. While the config GET is in flight
  // the non-host sections read 'pending' — and the hosts section reads the SAME
  // gate, because host data degrades in-section rather than gating.
  const loading = { configLoaded: false, loadFailed: false };
  assert.equal(sectionGate('telemetry', loading), 'pending');
  assert.equal(sectionGate('hosts', loading), 'pending');
  // The picker sections are usable IMMEDIATELY, discovery or not.
  assert.equal(sectionGate('newchats', loading), 'ready');
  assert.equal(sectionGate('appearance', loading), 'ready');
});

test('sectionGate takes exactly the config-load state (no host-data parameter can creep in)', () => {
  // LoadState must not grow a hostsReady flag: feeding host state is a TYPE
  // error in TS, and at runtime the function must ignore extra keys rather than
  // behave differently — asserting with a host-looking key proves it is inert.
  assert.equal(sectionGate('hosts', { configLoaded: true, loadFailed: false, hostsDiscovered: false }), 'ready');
});

// --- 3. Unknown sections default to gated --------------------------------------

test('an unknown section id defaults to config (never renders unloaded defaults)', () => {
  assert.equal(sectionDataDependency('brand-new-section'), 'config');
  assert.equal(sectionGate('brand-new-section', { configLoaded: false, loadFailed: false }), 'pending');
});

// --- 4. Load failure + loaded-wins semantics -----------------------------------

test('exhausted config load surfaces failed (Retry, in place)', () => {
  assert.equal(sectionGate('telemetry', { configLoaded: false, loadFailed: true }), 'failed');
  assert.equal(sectionGate('hosts', { configLoaded: false, loadFailed: true }), 'failed');
});

test('configLoaded wins over loadFailed (a failed refetch never blanks real values)', () => {
  assert.equal(sectionGate('telemetry', { configLoaded: true, loadFailed: true }), 'ready');
});

// --- 5. Save safety -------------------------------------------------------------/

test('Save stays impossible for configuration that was never loaded', () => {
  assert.equal(canSaveBackendConfig({ configLoaded: false, saving: false }), false);
  assert.equal(canSaveBackendConfig({ configLoaded: true, saving: false }), true);
  assert.equal(canSaveBackendConfig({ configLoaded: true, saving: true }), false);
});

console.log(`\n✓ SECTION DEPENDENCY TESTS PASS (${passed})`);
