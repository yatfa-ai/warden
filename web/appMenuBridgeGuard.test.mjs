// WARDEN-1671 (client-state slice 46) — STATIC SOURCE GUARD for the <AppMenuBridge/>
// extraction. The application menu's Settings… and Edit ▸ Select All push
// subscriptions live in the always-mounted null-rendering bridge; "Settings open"
// is a non-persisted uiStore fact; App owns neither subscription. Same
// source-reading precedent as globalSearchHostGuard.test.mjs.
//
// NEGATIVE CONTROL (verified when written): re-add
//   useEffect(() => onSelectAll(...), []);
// to App.tsx and guard (a) goes red naming onSelectAll.

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(resolve(__dirname, 'src/App.tsx'), 'utf8');
const bridgeSrc = readFileSync(resolve(__dirname, 'src/components/AppMenuBridge.tsx'), 'utf8');
const storeSrc = readFileSync(resolve(__dirname, 'src/lib/uiStore.ts'), 'utf8');

const NAMES = ['onOpenSettings', 'onSelectAll', 'routeMenuSelectAll', 'TERMINAL_SELECT_ALL_EVENT'];

test('(a) the menu subscriptions are gone from App.tsx and live in the bridge; settingsOpen lives on the store', () => {
  for (const name of NAMES) {
    assert.ok(!new RegExp(`\\b${name}\\b`).test(appSrc), `${name} must not appear in App.tsx`);
    assert.ok(new RegExp(`\\b${name}\\b`).test(bridgeSrc), `${name} lives in AppMenuBridge.tsx`);
  }
  assert.ok(!/const \[settingsOpen, setSettingsOpen\] = useState/.test(appSrc), 'settingsOpen is no longer App useState');
  assert.ok(/\bsettingsOpen: false\b/.test(storeSrc) && /\bsetSettingsOpen\b/.test(storeSrc), 'settingsOpen lives in uiStore.ts');
  assert.ok(/\buseSetSettingsOpen\b/.test(bridgeSrc), 'the bridge writes the store fact');
});

test('(b) <AppMenuBridge appears exactly once in App.tsx, AFTER the settingsOpen ternary closes (stays mounted)', () => {
  const matches = appSrc.match(/<AppMenuBridge\b/g) ?? [];
  assert.strictEqual(matches.length, 1, '<AppMenuBridge rendered exactly once');
  const idx = appSrc.indexOf('<AppMenuBridge');
  const ternaryIdx = appSrc.indexOf('{settingsOpen ?');
  assert.notEqual(ternaryIdx, -1, 'the settingsOpen ternary is findable in App.tsx');
  const closeIdx = appSrc.indexOf('\n      )}\n', ternaryIdx);
  assert.notEqual(closeIdx, -1, 'the ternary close is findable');
  assert.ok(idx > closeIdx, '<AppMenuBridge must come after the settingsOpen ternary closes, not inside it');
});
