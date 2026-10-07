// WARDEN-1620 (client-state slice 37) — STATIC SOURCE GUARD for the <GlobalSearchHost/>
// extraction. The global-search surface's state lives in the host (viewingSession,
// the Ctrl+Shift+F shortcut, the 'session-view' telemetry) or on the uiStore
// (`globalSearchOpen`), the host stays mounted OUTSIDE the settings ternary (so the
// shortcut works while Settings is open), and App no longer owns any of it.
// Same source-reading precedent as returnBannerGuard.test.mjs (no React/DOM runner here).
//
// NEGATIVE CONTROL (verified when written): re-add
//   const [showGlobalSearch, setShowGlobalSearch] = useState(false);
// to App.tsx and guard (a) goes red naming showGlobalSearch.

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(resolve(__dirname, 'src/App.tsx'), 'utf8');
const hostSrc = readFileSync(resolve(__dirname, 'src/components/GlobalSearchHost.tsx'), 'utf8');
const storeSrc = readFileSync(resolve(__dirname, 'src/lib/uiStore.ts'), 'utf8');

const NAMES = ['showGlobalSearch', 'setShowGlobalSearch', 'viewingSession', 'handleFocusPane', 'handleJumpToMatch'];

test('(a) global-search state + relays are gone from App.tsx and live in the host / store', () => {
  for (const name of NAMES) {
    assert.ok(!new RegExp(`\\b${name}\\b`).test(appSrc), `${name} must not appear in App.tsx`);
  }
  assert.ok(/\bviewingSession\b/.test(hostSrc), 'viewingSession lives in GlobalSearchHost.tsx');
  assert.ok(/\bglobalSearchOpen\b/.test(storeSrc) && /\bsetGlobalSearchOpen\b/.test(storeSrc), 'the open command lives in uiStore.ts');
  assert.ok(/\buseGlobalSearchOpen\b/.test(hostSrc), 'the host subscribes to the store fact');
  assert.ok(!/\buseGlobalSearchOpen\b/.test(appSrc), 'App no longer subscribes to the open flag');
  assert.ok(!/import \{[^}]*\b(GlobalSearchDialog|SessionTranscriptViewer)\b/.test(appSrc), 'App no longer imports the dialog/viewer');
});

test('(b) <GlobalSearchHost appears exactly once in App.tsx, AFTER the settingsOpen ternary closes (stays mounted)', () => {
  const matches = appSrc.match(/<GlobalSearchHost\b/g) ?? [];
  assert.strictEqual(matches.length, 1, '<GlobalSearchHost rendered exactly once');
  const hostIdx = appSrc.indexOf('<GlobalSearchHost');
  const ternaryIdx = appSrc.indexOf('{settingsOpen ?');
  assert.notEqual(ternaryIdx, -1, 'the settingsOpen ternary is findable in App.tsx');
  const closeIdx = appSrc.indexOf('\n      )}\n', ternaryIdx);
  assert.notEqual(closeIdx, -1, 'the ternary close is findable');
  assert.ok(hostIdx > closeIdx, '<GlobalSearchHost must come after the settingsOpen ternary closes, not inside it');
});

test("(c) the 'session-view' telemetry call and Ctrl+Shift+F shortcut live in the host, not App.tsx", () => {
  assert.ok(!appSrc.includes("'session-view'"), "'session-view' must not remain in App.tsx");
  assert.ok(hostSrc.includes("recordFeatureUse('session-view')"), "host records 'session-view'");
  assert.ok(/e\.ctrlKey && e\.shiftKey && e\.key === 'F'/.test(hostSrc), 'shortcut lives in the host');
  assert.ok(!/e\.ctrlKey && e\.shiftKey && e\.key === 'F'/.test(appSrc), 'shortcut must not remain in App.tsx');
});
