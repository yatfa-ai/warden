// WARDEN-1600 (roadmap WARDEN-1204, slice 35) — STATIC SOURCE GUARD.
//
// WHY: App.tsx re-rendered on every Settings toggle of four prefs it never
// renders (defaultShell, defaultShellByHost, autoFocusNewPane, restoreOnStartup).
// It only consults them when a user gesture fires (spawnShell / openChat), so
// those are CALL-TIME reads via `uiStore.getState()`; restoreOnStartup is read
// by useConfigPersistence itself. Re-adding a subscription compiles and works,
// so only a source assertion catches the regression.
//
// Precedent: workspaceShapeTickGuard.test.mjs, chatCreateSeamGuard.test.mjs.
// Mutation check: re-add `const defaultShell = useDefaultShell();` (or any of
// the four hooks) to App.tsx and this file goes red.
//
// Auto-discovered by `npm test` in web/ (`node --test`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(resolve(__dirname, 'src', 'App.tsx'), 'utf8');
const persistSrc = readFileSync(resolve(__dirname, 'src', 'lib', 'useConfigPersistence.ts'), 'utf8');

function body(src, decl) {
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `App.tsx declares ${decl}`);
  const next = src.indexOf('\n  const ', start + decl.length);
  assert.notEqual(next, -1, `${decl} is followed by another declaration`);
  return src.slice(start, next);
}

test('App.tsx subscribes to none of the four call-time prefs', () => {
  for (const hook of ['useDefaultShellByHost', 'useDefaultShell', 'useAutoFocusNewPane', 'useRestoreOnStartup']) {
    assert.ok(!new RegExp(`\\b${hook}\\b`).test(appSrc), `App.tsx must not reference ${hook}`);
  }
});

test('spawnShell reads defaultShell/defaultShellByHost at call time', () => {
  const b = body(appSrc, 'const spawnShell = useCallback(');
  assert.match(b, /const \{ defaultShell, defaultShellByHost \} = uiStore\.getState\(\);/);
  assert.doesNotMatch(b.slice(b.lastIndexOf('}, [')), /defaultShell/, 'deps must not list the shell prefs');
});

test('openChat reads autoFocusNewPane at call time', () => {
  const b = body(appSrc, 'const openChat = useCallback(');
  assert.match(b, /autoFocusNewPane[^\n]*= uiStore\.getState\(\);/);
  assert.doesNotMatch(b.slice(b.lastIndexOf('}, [')), /autoFocusNewPane/, 'deps must not list autoFocusNewPane');
});

test('useConfigPersistence reads restoreOnStartup itself, not as an arg', () => {
  assert.match(persistSrc, /const restoreOnStartup = useRestoreOnStartup\(\);/);
  const args = persistSrc.slice(persistSrc.indexOf('interface UseConfigPersistenceArgs'));
  assert.doesNotMatch(args.slice(0, args.indexOf('}')), /restoreOnStartup/);
  assert.doesNotMatch(appSrc, /useConfigPersistence\(\{[^}]*restoreOnStartup/);
});

// WARDEN-1685 (roadmap WARDEN-1204, slice 48): the "launched in Start empty" boot
// fact is derived INSIDE useConfigPersistence; App no longer reads the persisted
// document. Mutation check: re-add `useState(() => loadUi())` to App.tsx -> red.
test('App.tsx neither imports nor calls loadUi (non-comment code)', () => {
  const code = appSrc.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.doesNotMatch(code, /\bloadUi\b/);
  assert.doesNotMatch(code, /\bstartedEmpty\b/);
});

test('useConfigPersistence derives startedEmpty via lazy useState(launchedEmpty), not as an arg', () => {
  assert.match(persistSrc, /useState\(launchedEmpty\)/);
  const args = persistSrc.slice(persistSrc.indexOf('interface UseConfigPersistenceArgs'));
  assert.doesNotMatch(args.slice(0, args.indexOf('\n}')), /startedEmpty/);
});
