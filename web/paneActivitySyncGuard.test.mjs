// WARDEN-1691 (client-state slice 49) — STATIC SOURCE GUARD for the
// <PaneActivitySync/> extraction. The onAnyMessage → markPaneActivity wiring and
// the focus-clear effect live in the always-mounted null-rendering component;
// App owns neither store-hook subscription. Same source-reading precedent as
// appMenuBridgeGuard.test.mjs.
//
// NEGATIVE CONTROL (verified when written): re-add
//   streamApi.onAnyMessage = () => {};
// to App.tsx and guard (a) goes red naming onAnyMessage.

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(resolve(__dirname, 'src/App.tsx'), 'utf8');
const compSrc = readFileSync(resolve(__dirname, 'src/components/PaneActivitySync.tsx'), 'utf8');

const NAMES = ['onAnyMessage', 'useMarkPaneActivity', 'useClearPaneActivity', 'markPaneActivity', 'clearPaneActivity'];

test('(a) the activity wiring is gone from App.tsx and lives in PaneActivitySync', () => {
  for (const name of NAMES) {
    assert.ok(!new RegExp(`\\b${name}\\b`).test(appSrc), `${name} must not appear in App.tsx`);
    assert.ok(new RegExp(`\\b${name}\\b`).test(compSrc), `${name} lives in PaneActivitySync.tsx`);
  }
});

test('(b) <PaneActivitySync appears exactly once in App.tsx, AFTER the settingsOpen ternary closes (stays mounted)', () => {
  assert.strictEqual((appSrc.match(/<PaneActivitySync\b/g) ?? []).length, 1, 'rendered exactly once');
  const idx = appSrc.indexOf('<PaneActivitySync');
  const ternaryIdx = appSrc.indexOf('{settingsOpen ?');
  assert.notEqual(ternaryIdx, -1, 'the settingsOpen ternary is findable in App.tsx');
  const closeIdx = appSrc.indexOf('\n      )}\n', ternaryIdx);
  assert.notEqual(closeIdx, -1, 'the ternary close is findable');
  assert.ok(idx > closeIdx, '<PaneActivitySync must come after the settingsOpen ternary closes, not inside it');
});

test('(c) cleanup nulls the onAnyMessage slot', () => {
  const cleanup = compSrc.slice(compSrc.indexOf('return () =>'));
  assert.ok(/streamApi\.onAnyMessage\s*=\s*null/.test(cleanup), 'cleanup nulls onAnyMessage');
});

test('(d) the component reads focus from the store only (no focus ref/prop)', () => {
  assert.ok(/\buseFocused\(\)/.test(compSrc), 'focus comes from useFocused()');
  assert.ok(!/focusedRef/.test(compSrc), 'no focusedRef');
  assert.ok(!/export function PaneActivitySync\(\s*[^)\s]/.test(compSrc), 'takes no props');
});
