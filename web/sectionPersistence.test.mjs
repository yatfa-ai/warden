// Tests for sectionPersistence — the pure seam behind the global Settings
// footer label (WARDEN-870).
//
// No front-end test runner in this repo, so (like desktopAlerts.test.mjs) this
// loads the REAL src/components/settings/sectionPersistence.ts (transpiled TS ->
// ESM via Vite's OXC transform) and exercises the pure helper. The module is
// import-free (no React, no UI), so it loads standalone.
//
// This file is auto-discovered by `npm test` (`node --test` runs every
// *.test.mjs in web/), so it runs in CI with no package.json wiring.
//
// Run: node sectionPersistence.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const helperPath = resolve(__dirname, 'src/components/settings/sectionPersistence.ts');

// --- Load the REAL sectionPersistence.ts (TS -> ESM via the OXC transform) ---
const src = readFileSync(helperPath, 'utf8');
const { code } = await transformWithOxc(src, helperPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-section-persistence-test-'));
const tmpFile = join(tmpDir, 'sectionPersistence.mjs');
writeFileSync(tmpFile, code);
const {
  sectionPersistence,
  CLIENT_PREF_SECTIONS,
  SERVER_PERSISTENCE_LABEL,
  CLIENT_PERSISTENCE_LABEL,
} = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

// --- Labels reused verbatim from WARDEN-784's NotificationsSection labels ---
const SERVER_LABEL = 'Saved when you press Save.';
const CLIENT_LABEL =
  'Applied instantly and remembered locally on this device — no Save needed.';

// The SETTINGS_SECTIONS partition (see SettingsPage.tsx). Server-config ids all
// pass `config`/`setConfig`; client-pref ids spread client-hook props only.
const SERVER_SECTIONS = [
  'hosts',
  'observer',
  'safety',
  'attention',
  'tokenbudget',
  'performance',
  'telemetry',
  'display',
  'patterns',
  'notifications', // hybrid IN-section (WARDEN-784 labels each channel) but Save
                   // commits its webhook/toast toggles, so it resolves to server.
];
const CLIENT_SECTIONS = ['appearance', 'newchats', 'snippets'];

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

test('exported label constants match the WARDEN-784 footer copy byte-for-byte', () => {
  assert.equal(SERVER_PERSISTENCE_LABEL, SERVER_LABEL);
  // Em dash (U+2014), not a hyphen — the "no Save needed" reassurance is the
  // whole point of WARDEN-870 and must reach the user intact.
  assert.equal(CLIENT_PERSISTENCE_LABEL, CLIENT_LABEL);
  assert.ok(CLIENT_PERSISTENCE_LABEL.includes('—'), 'client label uses an em dash');
  assert.ok(CLIENT_PERSISTENCE_LABEL.endsWith('no Save needed.'));
});

test('CLIENT_PREF_SECTIONS is exactly the three instant client-pref sections', () => {
  assert.equal(CLIENT_PREF_SECTIONS.size, 3);
  for (const id of CLIENT_SECTIONS) {
    assert.ok(CLIENT_PREF_SECTIONS.has(id), `expected client-pref set to contain "${id}"`);
  }
  for (const id of SERVER_SECTIONS) {
    assert.ok(!CLIENT_PREF_SECTIONS.has(id), `server section "${id}" must NOT be in the client-pref set`);
  }
});

test('every server-config section resolves to the server label', () => {
  for (const id of SERVER_SECTIONS) {
    const p = sectionPersistence(id);
    assert.equal(p.kind, 'server', `"${id}" should be server-config`);
    assert.equal(p.label, SERVER_LABEL, `"${id}" footer label`);
  }
});

test('every instant client-pref section resolves to the client label', () => {
  for (const id of CLIENT_SECTIONS) {
    const p = sectionPersistence(id);
    assert.equal(p.kind, 'client', `"${id}" should be instant client-pref`);
    assert.equal(p.label, CLIENT_LABEL, `"${id}" footer label`);
  }
});

test('notifications resolves to server (Save commits its webhook/toast toggles)', () => {
  // Explicit assertion of the hybrid-section edge case called out in WARDEN-870:
  // Notifications blends server toggles with an instant desktop-alert toggle
  // (each labeled in-section by WARDEN-784), but at the FOOTER level Save
  // commits the server toggles, so the footer must show the server label — not
  // the instant-apply label.
  const p = sectionPersistence('notifications');
  assert.equal(p.kind, 'server');
  assert.equal(p.label, SERVER_LABEL);
});

test('an unknown section id falls back to server (safe default — Save commits)', () => {
  // The default section ('hosts') and any future section that isn't explicitly
  // client-pref must read as server so the footer never claims "instant" about a
  // section that actually round-trips through PUT /api/config.
  assert.equal(sectionPersistence('hosts').kind, 'server');
  assert.equal(sectionPersistence('something-new').kind, 'server');
  assert.equal(sectionPersistence('').kind, 'server');
});

console.log(`\n  ${passed} tests passed — sectionPersistence (WARDEN-870)`);
