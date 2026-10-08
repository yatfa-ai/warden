// WARDEN-1659 (client-state slice 44) — STATIC SOURCE GUARD for the
// <AppearanceSync/> extraction. App must not subscribe to theme/density (a
// Settings → Appearance change would re-render all of App for nothing); the
// always-mounted AppearanceSync owns the two apply effects and sits OUTSIDE the
// settingsOpen ternary (the OS-flip listener must keep running while Settings —
// where the theme changes — is open). Same precedent as panelLayoutSyncGuard.
//
// NEGATIVE CONTROL: re-add `const theme = useTheme();` to App.tsx and guard (a)
// goes red naming useTheme.

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(__dirname, p), 'utf8');
const appSrc = read('src/App.tsx');
const syncSrc = read('src/components/AppearanceSync.tsx');
// Strip line comments so prose mentions don't trip the guard.
const appCode = appSrc.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

const NAMES = [
  'useTheme', 'useDensity', 'useSetResolvedThemeId',
  'applyTheme', 'applyDensity', 'listenSystemThemeChange', 'resolveThemeId',
];

test('(a) theme/density hooks + apply helpers are gone from App.tsx and live in AppearanceSync', () => {
  for (const name of NAMES) {
    assert.ok(!new RegExp(`\\b${name}\\b`).test(appCode), `${name} must not appear in App.tsx code`);
    assert.ok(new RegExp(`\\b${name}\\b`).test(syncSrc), `${name} must appear in AppearanceSync.tsx`);
  }
});

test('(b) AppearanceSync holds both effects with the original deps and the OS-flip cleanup', () => {
  assert.ok(/\}, \[theme\]\);/.test(syncSrc), '[theme] effect deps unchanged');
  assert.ok(/\}, \[density\]\);/.test(syncSrc), '[density] effect deps unchanged');
  assert.ok(/listenSystemThemeChange\(\(id\) => \{[\s\S]*?applyTheme\('system'\);[\s\S]*?setResolvedThemeId\(id\);[\s\S]*?return cleanup;/.test(syncSrc), 'system listener re-applies, pushes the resolved id and returns its cleanup');
  assert.ok(/setResolvedThemeId\(resolveThemeId\(theme\)\)/.test(syncSrc), 'resolved id is pushed on every theme change');
  assert.ok(/return null;/.test(syncSrc), 'AppearanceSync renders nothing');
});

test('(c) <AppearanceSync/> renders exactly once, AFTER the settingsOpen ternary closes (stays mounted)', () => {
  const matches = appSrc.match(/^\s*<AppearanceSync \/>/gm) ?? [];
  assert.strictEqual(matches.length, 1, '<AppearanceSync/> rendered exactly once');
  const ternaryIdx = appSrc.indexOf('{settingsOpen ?');
  assert.notEqual(ternaryIdx, -1, 'the settingsOpen ternary is findable');
  const closeIdx = appSrc.indexOf('\n      )}\n', ternaryIdx);
  assert.notEqual(closeIdx, -1, 'the ternary close is findable');
  assert.ok(appSrc.indexOf('      <AppearanceSync />') > closeIdx, '<AppearanceSync/> must come after the ternary closes, not inside it');
});
