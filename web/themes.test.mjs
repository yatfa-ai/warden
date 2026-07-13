// Tests for the named-theme registry (WARDEN-255).
//
// There is no front-end test runner in this repo, so this file loads the REAL
// themes module (transpiled TS -> ESM via Vite's OXC transform) and exercises the
// pure registry + migration/resolution helpers. themes.ts is intentionally
// DOM-free, so no polyfills are needed — unlike storage.test.mjs.
//
// Run: node themes.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const themesPath = resolve(__dirname, 'src/lib/themes.ts');

// --- Load the REAL themes.ts (TS -> ESM via the OXC transform Vite bundles) --
const src = readFileSync(themesPath, 'utf8');
const { code } = await transformWithOxc(src, themesPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-themes-test-'));
const tmpFile = join(tmpDir, 'themes.mjs');
writeFileSync(tmpFile, code);
const {
  THEMES, THEME_MAP, THEME_IDS,
  DEFAULT_THEME_ID, DEFAULT_LIGHT_THEME_ID, DEFAULT_DARK_THEME_ID,
  SYSTEM_LIGHT_THEME_ID, SYSTEM_DARK_THEME_ID,
  getThemeById, getThemeMode, isThemeId,
  resolveSystemThemeId, resolveTerminalThemeId, normalizeThemePref,
} = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// The exact roster from the ticket's "Proposed roster" (2 light + 6 dark = 8).
const EXPECTED_IDS = [
  'github-light', 'vscode-light',
  'github-dark', 'vscode-dark', 'catppuccin-mocha', 'dracula', 'nord', 'one-dark',
];

console.log('\nregistry roster matches the ticket (8 themes: 2 light + 6 dark)');
test('THEMES has exactly the 8 expected ids in order', () => {
  assert.deepEqual(THEMES.map((t) => t.id), EXPECTED_IDS);
});
test('exactly 2 light + 6 dark themes', () => {
  assert.equal(THEMES.filter((t) => t.mode === 'light').length, 2);
  assert.equal(THEMES.filter((t) => t.mode === 'dark').length, 6);
});
test('every theme id is unique', () => {
  assert.equal(new Set(THEMES.map((t) => t.id)).size, THEMES.length);
});

console.log('\nevery registry entry carries the required fields');
test('each entry has id, label, mode, and a 5-field xterm palette', () => {
  for (const t of THEMES) {
    assert.equal(typeof t.id, 'string', `${t.id}: id is a string`);
    assert.ok(t.id.length > 0);
    assert.equal(typeof t.label, 'string', `${t.id}: label is a string`);
    assert.ok(t.label.length > 0);
    assert.ok(t.mode === 'light' || t.mode === 'dark', `${t.id}: mode is light|dark`);
    assert.ok(t.xterm && typeof t.xterm === 'object', `${t.id}: xterm present`);
    for (const k of ['background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground']) {
      assert.equal(typeof t.xterm[k], 'string', `${t.id}: xterm.${k} is a string`);
      assert.ok(t.xterm[k].length > 0, `${t.id}: xterm.${k} non-empty`);
    }
  }
});

console.log('\nxterm palettes use concrete hex (xterm cannot parse oklch)');
test('no xterm value contains "oklch" — xterm needs hex/rgba', () => {
  for (const t of THEMES) {
    for (const k of ['background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground']) {
      assert.ok(!/oklch/i.test(t.xterm[k]), `${t.id}: xterm.${k} must not be oklch`);
    }
  }
});
test('background/foreground/cursor/cursorAccent are solid hex (#rrggbb) — not rgba', () => {
  // The terminal surface + cursor must be solid colors (only the selection
  // overlay may be semi-transparent rgba).
  for (const t of THEMES) {
    for (const k of ['background', 'foreground', 'cursor', 'cursorAccent']) {
      assert.ok(/^#[0-9a-fA-F]{6}$/.test(t.xterm[k]), `${t.id}: xterm.${k} should be #rrggbb, got ${t.xterm[k]}`);
    }
  }
});

console.log('\ndefaults + system pair');
test('DEFAULT_THEME_ID is GitHub Dark and is registered', () => {
  assert.equal(DEFAULT_THEME_ID, 'github-dark');
  assert.ok(THEME_MAP[DEFAULT_THEME_ID], 'default is in the registry');
});
test('system pair is GitHub Light <-> GitHub Dark', () => {
  assert.equal(SYSTEM_LIGHT_THEME_ID, 'github-light');
  assert.equal(SYSTEM_DARK_THEME_ID, 'github-dark');
  assert.equal(DEFAULT_LIGHT_THEME_ID, 'github-light');
  assert.equal(DEFAULT_DARK_THEME_ID, 'github-dark');
});

console.log('\ngetThemeById / getThemeMode / isThemeId');
test('getThemeById returns the entry for a known id', () => {
  const t = getThemeById('dracula');
  assert.equal(t?.label, 'Dracula');
  assert.equal(t?.mode, 'dark');
});
test('getThemeById returns undefined for an unknown id', () => {
  assert.equal(getThemeById('nope-not-a-theme'), undefined);
});
test('getThemeMode reports the inherent light/dark mode', () => {
  assert.equal(getThemeMode('github-light'), 'light');
  assert.equal(getThemeMode('vscode-light'), 'light');
  assert.equal(getThemeMode('github-dark'), 'dark');
  assert.equal(getThemeMode('catppuccin-mocha'), 'dark');
});
test('isThemeId narrows for valid ids and rejects everything else', () => {
  for (const id of EXPECTED_IDS) assert.equal(isThemeId(id), true);
  assert.equal(isThemeId('system'), false);   // 'system' is a pref, not a theme id
  assert.equal(isThemeId('dark'), false);     // legacy mode literal, not a theme id
  assert.equal(isThemeId(''), false);
  assert.equal(isThemeId('bogus'), false);
});
test('THEME_IDS lists every concrete id (no "system")', () => {
  assert.deepEqual([...THEME_IDS].sort(), [...EXPECTED_IDS].sort());
  assert.ok(!THEME_IDS.includes('system'));
});

console.log('\nresolveSystemThemeId — pure OS-state -> theme id');
test('OS dark -> GitHub Dark; OS light -> GitHub Light', () => {
  assert.equal(resolveSystemThemeId(true), SYSTEM_DARK_THEME_ID);
  assert.equal(resolveSystemThemeId(false), SYSTEM_LIGHT_THEME_ID);
});

console.log('\nresolveTerminalThemeId — the terminal color-scheme override');
test('"auto" defers to the active theme id', () => {
  assert.equal(resolveTerminalThemeId('auto', 'dracula'), 'dracula');
  assert.equal(resolveTerminalThemeId('auto', 'github-light'), 'github-light');
});
test('"dark" forces the system default dark theme regardless of active theme', () => {
  assert.equal(resolveTerminalThemeId('dark', 'github-light'), SYSTEM_DARK_THEME_ID);
  assert.equal(resolveTerminalThemeId('dark', 'nord'), SYSTEM_DARK_THEME_ID);
});
test('"light" forces the system default light theme regardless of active theme', () => {
  assert.equal(resolveTerminalThemeId('light', 'github-dark'), SYSTEM_LIGHT_THEME_ID);
  assert.equal(resolveTerminalThemeId('light', 'dracula'), SYSTEM_LIGHT_THEME_ID);
});

console.log('\nnormalizeThemePref — backward-compatible migration (legacy light/dark/system)');
test('"system" passes through unchanged', () => {
  assert.equal(normalizeThemePref('system'), 'system');
});
test('a registered theme id passes through unchanged (new shape)', () => {
  assert.equal(normalizeThemePref('dracula'), 'dracula');
  assert.equal(normalizeThemePref('github-dark'), 'github-dark');
  assert.equal(normalizeThemePref('vscode-light'), 'vscode-light');
});
test('legacy "dark" migrates to the default dark theme (GitHub Dark)', () => {
  assert.equal(normalizeThemePref('dark'), DEFAULT_DARK_THEME_ID);
});
test('legacy "light" migrates to the default light theme (GitHub Light)', () => {
  assert.equal(normalizeThemePref('light'), DEFAULT_LIGHT_THEME_ID);
});
test('a bogus string coerces back to "system" (never an unknown id)', () => {
  assert.equal(normalizeThemePref('bogus'), 'system');
  assert.equal(normalizeThemePref('octocat'), 'system');
});
test('an empty string coerces to "system"', () => {
  assert.equal(normalizeThemePref(''), 'system');
});
test('a missing / null value coerces to "system"', () => {
  assert.equal(normalizeThemePref(undefined), 'system');
  assert.equal(normalizeThemePref(null), 'system');
});
test('a non-string value coerces to "system" (defensive, no throw)', () => {
  assert.equal(normalizeThemePref(42), 'system');
  assert.equal(normalizeThemePref({ id: 'dracula' }), 'system');
  assert.equal(normalizeThemePref(['dracula']), 'system');
});

// A migrated legacy value must itself be a VALID theme pref — i.e. the output of
// normalizeThemePref is always either 'system' or a registered id. This is the
// contract loadUi relies on so the app never loads an unknown theme.
console.log('\nnormalizeThemePref output is always a valid pref (system | registered id)');
test('every legacy/malformed input resolves to "system" or a registered id', () => {
  const inputs = ['system', 'dark', 'light', 'github-dark', 'bogus', '', undefined, null, 42, {}];
  for (const i of inputs) {
    const out = normalizeThemePref(i);
    assert.ok(out === 'system' || isThemeId(out), `input ${JSON.stringify(i)} -> invalid pref ${out}`);
  }
});

console.log(`\n✓ THEMES TESTS PASS (${passed})`);
