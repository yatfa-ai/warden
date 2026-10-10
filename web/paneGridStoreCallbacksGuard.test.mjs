// WARDEN-1719 (roadmap WARDEN-1204, slice 55) — STATIC SOURCE GUARD.
//
// WHY: PaneGrid's three store-pure write callbacks (onFocus, onToggleMax,
// onReorderPanes) used to ride App's props channel while only wrapping store
// actions. PaneGrid now subscribes to the stable actions itself. Re-adding a
// prop compiles and works, so only a source assertion catches the regression.
//
// Precedent: appStoreReadsGuard.test.mjs.
// Mutation check: re-add `onToggleMax={toggleMax}` to App's <PaneGrid> and (c) goes red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(resolve(__dirname, 'src', 'App.tsx'), 'utf8');
const gridSrc = readFileSync(resolve(__dirname, 'src', 'components', 'PaneGrid.tsx'), 'utf8');

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const app = stripComments(appSrc);
const grid = stripComments(gridSrc);
const CALLBACKS = ['onFocus', 'onToggleMax', 'onReorderPanes'];

test('(a) PaneGrid Props declares none of the three store-pure callbacks', () => {
  const start = grid.indexOf('interface Props {');
  assert.notEqual(start, -1, 'PaneGrid declares interface Props');
  const props = grid.slice(start, grid.indexOf('\n}\n', start));
  for (const cb of CALLBACKS) {
    assert.ok(!new RegExp(`\\b${cb}\\??\\s*:`).test(props), `Props must not declare ${cb}`);
  }
});

test('(b) App.tsx (comments stripped) references none of the moved identifiers', () => {
  for (const id of ['toggleMax', 'reorderPanes', 'useSetMaximized', 'swapPanes']) {
    assert.ok(!new RegExp(`\\b${id}\\b`).test(app), `App.tsx must not reference ${id}`);
  }
});

test('(c) the <PaneGrid JSX passes none of the three callbacks', () => {
  const start = app.indexOf('<PaneGrid');
  assert.notEqual(start, -1, 'App renders <PaneGrid');
  const jsx = app.slice(start, app.indexOf('/>', start));
  for (const cb of CALLBACKS) {
    assert.ok(!new RegExp(`\\b${cb}\\s*=`).test(jsx), `<PaneGrid must not pass ${cb}=`);
  }
});

test("(d) recordFeatureUse('pane-maximize') lives once in PaneGrid, never in App", () => {
  const needle = /recordFeatureUse\('pane-maximize'\)/g;
  assert.equal((grid.match(needle) ?? []).length, 1);
  assert.equal((app.match(needle) ?? []).length, 0);
});

test('(e) PaneGrid calls the three store hooks', () => {
  for (const hook of ['useSetFocused', 'useSetMaximized', 'useSetOpenPanes']) {
    assert.ok(new RegExp(`\\b${hook}\\(\\)`).test(grid), `PaneGrid must call ${hook}()`);
  }
});
