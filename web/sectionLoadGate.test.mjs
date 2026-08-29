// Tests for sectionLoadGate — the pure seam behind Settings' PER-SECTION
// readiness (WARDEN-976), which replaced the full-pane "Loading configuration…"
// gate that blanked all 13 section bodies on one /api/config GET.
//
// No front-end test runner in this repo, so (like sectionPersistence.test.mjs)
// this loads the REAL src/components/settings/sectionLoadGate.ts, transpiled
// TS -> ESM via Vite's OXC transform. Unlike that helper this one is NOT
// import-free: it imports CLIENT_PREF_SECTIONS from sectionPersistence.ts — on
// purpose, so there is exactly ONE list of "which sections need the backend".
// Both modules are therefore transpiled into the same tmpdir and the extension-
// less relative specifier is rewritten so Node's ESM loader can resolve it.
//
// This file is auto-discovered by `npm test` (`node --test` runs every
// *.test.mjs in web/), so it runs in CI with no package.json wiring.
//
// Run: node sectionLoadGate.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const settingsDir = resolve(__dirname, 'src/components/settings');

// --- Load the REAL modules (TS -> ESM via the OXC transform) ---
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-section-load-gate-test-'));
for (const name of ['sectionPersistence', 'sectionLoadGate']) {
  const path = join(settingsDir, `${name}.ts`);
  const { code } = await transformWithOxc(readFileSync(path, 'utf8'), path, {});
  // Node's ESM loader needs a real file extension on the relative specifier.
  // Quote-agnostic: the OXC transform is free to emit either quote style.
  const rewritten = code.replace(/(['"])\.\/sectionPersistence\1/g, "'./sectionPersistence.mjs'");
  writeFileSync(join(tmpDir, `${name}.mjs`), rewritten);
}
const { sectionGate, canSaveBackendConfig } = await import(join(tmpDir, 'sectionLoadGate.mjs'));
const { CLIENT_PREF_SECTIONS } = await import(join(tmpDir, 'sectionPersistence.mjs'));
rmSync(tmpDir, { recursive: true, force: true });

// The 13 rail section ids (SettingsPage.tsx SETTINGS_SECTIONS), split by the
// classification under test. Listed literally rather than imported so a silent
// re-classification of a section is caught here rather than sailing through.
const CLIENT_IDS = ['appearance', 'newchats', 'snippets'];
const SERVER_IDS = [
  'hosts', 'observer', 'safety', 'attention', 'tokenbudget', 'performance',
  'telemetry', 'display', 'patterns', 'notifications',
];

const LOADING = { configLoaded: false, loadFailed: false };
const FAILED = { configLoaded: false, loadFailed: true };
const LOADED = { configLoaded: true, loadFailed: false };

test('the gate reads the SAME classification as the footer persistence label', () => {
  // The whole point of WARDEN-976's Technical Notes: no second, divergent copy.
  assert.deepEqual([...CLIENT_PREF_SECTIONS].sort(), [...CLIENT_IDS].sort());
});

test('client-pref sections are ready in EVERY load state — they never wait on the backend', () => {
  // This is the headline fix: opening Settings against a stalled or failed
  // backend must still put an interactive Appearance/NewChats/Snippets on
  // screen. A regression to the full-pane gate fails here.
  for (const id of CLIENT_IDS) {
    assert.equal(sectionGate(id, LOADING), 'ready', `${id} while the config GET is in flight`);
    assert.equal(sectionGate(id, FAILED), 'ready', `${id} after the bounded load failed`);
    assert.equal(sectionGate(id, LOADED), 'ready', `${id} once config resolved`);
  }
});

test('the landing section is a client-pref one, so Settings opens usable', () => {
  // SettingsPage's LANDING_SECTION. Settings must not open on a section that
  // needs the network — that is what made a slow GET read as a blank page.
  assert.equal(sectionGate('appearance', LOADING), 'ready');
  assert.ok(CLIENT_PREF_SECTIONS.has('appearance'));
});

test('backend-config sections are pending while the GET is in flight — not ready, not failed', () => {
  // "Pending" is what makes them degrade IN PLACE: they must not render
  // DEFAULT_CONFIG values, which would show wrong values and invite a clobber.
  for (const id of SERVER_IDS) {
    assert.equal(sectionGate(id, LOADING), 'pending', id);
  }
});

test('backend-config sections surface the retry state when the bounded load fails', () => {
  // WARDEN-828's forever-spinner fix must survive per-section scoping: a
  // failure still has to reach a retry affordance, never an endless loader.
  for (const id of SERVER_IDS) {
    assert.equal(sectionGate(id, FAILED), 'failed', id);
  }
});

test('backend-config sections are ready once the config GET resolves', () => {
  for (const id of SERVER_IDS) {
    assert.equal(sectionGate(id, LOADED), 'ready', id);
  }
});

test('a loaded config wins over a later failure — real values are never replaced by an error', () => {
  // Retry is only reachable from the failed state today, but the precedence is
  // the safety property: once real values are on screen, a subsequent failed
  // refetch must not blank them back to an error pane.
  assert.equal(sectionGate('hosts', { configLoaded: true, loadFailed: true }), 'ready');
});

test('unknown section ids fall back to the backend-gated path', () => {
  // Fail-safe direction: a section added to the rail without being classified
  // waits for config rather than silently rendering DEFAULT_CONFIG values.
  assert.equal(sectionGate('some-future-section', LOADING), 'pending');
  assert.equal(sectionGate('some-future-section', LOADED), 'ready');
});

test('Save is impossible until a config GET has actually succeeded', () => {
  // The clobber guard: a never-loaded draft is DEFAULT_CONFIG, and PUTting that
  // would overwrite the real persisted configuration with defaults.
  assert.equal(canSaveBackendConfig({ configLoaded: false, saving: false }), false);
  assert.equal(canSaveBackendConfig({ configLoaded: false, saving: true }), false);
});

test('Save is enabled once loaded, and blocked while a save is in flight', () => {
  assert.equal(canSaveBackendConfig({ configLoaded: true, saving: false }), true);
  assert.equal(canSaveBackendConfig({ configLoaded: true, saving: true }), false);
});
