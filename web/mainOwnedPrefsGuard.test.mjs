// WARDEN-1622 (roadmap WARDEN-1204, slice 38) — STATIC SOURCE GUARD.
//
// WHY: the three Electron-main-owned window prefs (rememberWindowBounds,
// launchAtLogin, closeToTray) have exactly ONE reader/writer — AppearanceSection
// — so their display-mirror state lives there via useMainOwnedPref, not in App
// behind an `appearance={{...}}` props bag. Re-adding App state compiles and
// works, so only a source assertion catches the regression.
//
// Mutation check: re-add `const [closeToTray, setCloseToTrayState] = useState(false);`
// to App.tsx and this file goes red naming closeToTray.
//
// Auto-discovered by `npm test` in web/ (`node --test`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(resolve(__dirname, 'src', ...p), 'utf8');
const appSrc = read('App.tsx');
const sectionSrc = read('components', 'settings', 'sections', 'AppearanceSection.tsx');
const settingsPageSrc = read('components', 'SettingsPage.tsx');
const typesSrc = read('components', 'settings', 'types.ts');
const reconcileSrc = read('lib', 'mainOwnedPref.ts');

const TOKENS = [
  'rememberWindowBounds', 'launchAtLogin', 'closeToTray',
  'RememberWindowBounds', 'LaunchAtLogin', 'CloseToTray',
  'reconcileMainOwnedPref', 'AppearancePrefs',
];
const hit = (src, token) => new RegExp(`\\b${token}\\b`).test(src);

test('positive control: the token greps fire on a source known to hold them', () => {
  assert.ok(hit(reconcileSrc, 'reconcileMainOwnedPref'));
  assert.ok(hit(sectionSrc, 'rememberWindowBounds'));
  assert.ok(hit(sectionSrc, 'closeToTray'));
});

test('App.tsx holds none of the main-owned pref identifiers and passes no appearance prop', () => {
  for (const t of TOKENS) assert.ok(!hit(appSrc, t), `App.tsx must not reference ${t}`);
  assert.ok(!/\bappearance\s*=/.test(appSrc), 'App.tsx must not pass an appearance= prop');
});

test('SettingsPage.tsx and settings/types.ts hold no appearance bag', () => {
  for (const t of TOKENS) {
    assert.ok(!hit(settingsPageSrc, t), `SettingsPage.tsx must not reference ${t}`);
    assert.ok(!hit(typesSrc, t), `settings/types.ts must not reference ${t}`);
  }
  assert.ok(!/\bappearance\s*[:?=]/.test(settingsPageSrc.replace(/'appearance'/g, '')), 'SettingsPage has no appearance prop');
  assert.ok(!/\.\.\.appearance\b/.test(settingsPageSrc), 'SettingsPage must not spread appearance');
});

test('AppearanceSection calls useMainOwnedPref exactly three times', () => {
  const calls = sectionSrc.match(/=\s*useMainOwnedPref\(/g) ?? [];
  assert.equal(calls.length, 3);
  assert.ok(/AppearanceSectionProps = \{ hidden: boolean \}/.test(sectionSrc));
});
