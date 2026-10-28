// WARDEN-1770 (roadmap WARDEN-362, Context-Menu Completeness) — STATIC SOURCE GUARD.
//
// No front-end DOM runner exists here, so "right-click opens the themed menu" is
// verified live; these tests assert properties of the SOURCE only:
//  (a) each of the three gutter kinds' role="separator" element is the direct child
//      of a <ContextMenuTrigger asChild> (NOT the pointer-events-none overlay);
//  (b) the menu labels; (c) the double-click handlers are untouched;
//  (d) menu selects and double-click share the one reset path that commits.
// Mutation checks: move a trigger to the overlay div, or drop a commit call → red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(__dirname, 'src', 'components', 'PaneGrid.tsx'), 'utf8');
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const src = strip(raw);
// WARDEN-2002: the reset logic moved into the usePaneGridResize hook.
const hookSrc = strip(readFileSync(resolve(__dirname, 'src', 'lib', 'usePaneGridResize.ts'), 'utf8'));

const TRIGGER_THEN_SEP = /<ContextMenuTrigger asChild>\s*<div(?:\s+key=\{[^}]*\})?\s+role="separator"/g;

test('(a) at least three ContextMenuTriggers, each directly wrapping a role="separator" element', () => {
  const triggers = src.match(/<ContextMenuTrigger\b/g) ?? [];
  assert.ok(triggers.length >= 3, `expected >=3 triggers, got ${triggers.length}`);
  const wrapped = src.match(TRIGGER_THEN_SEP) ?? [];
  assert.equal(wrapped.length, 3, 'three triggers must each wrap a separator');
});

test('(a2) each trigger wraps the intended gutter kind (by aria-label)', () => {
  for (const label of ['Resize columns', 'Resize rows', 'Resize columns or rows']) {
    const re = new RegExp(
      `<ContextMenuTrigger asChild>\\s*<div\\s+role="separator"[^>]*?\\s+aria-label="${label}"`);
    assert.ok(re.test(src), `trigger must wrap the "${label}" separator`);
  }
});

test('(a3) the pointer-events-none overlay container is not wrapped by a trigger', () => {
  assert.ok(!/<ContextMenuTrigger asChild>\s*<div ref=\{setOverlayRef\}/.test(src));
});

test('(b) menu labels: strip menus offer one item, the crossing pad offers all three', () => {
  for (const l of ['Reset column sizes', 'Reset row sizes', 'Reset both']) {
    assert.ok(src.includes(`>${l}</ContextMenuItem>`), `missing item ${l}`);
  }
  const pad = src.slice(src.indexOf('key={`x${gCol}-${gRow}`}'));
  for (const l of ['Reset column sizes', 'Reset row sizes', 'Reset both']) {
    assert.ok(pad.includes(l), `crossing pad menu must offer ${l}`);
  }
});

test('(c) double-click handlers are still wired', () => {
  assert.ok(src.includes("onDoubleClick={resetAxis('col')}"));
  assert.ok(src.includes("onDoubleClick={resetAxis('row')}"));
  assert.ok(src.includes('onDoubleClick={resetBothAxes}'));
  const wrappers = hookSrc.slice(hookSrc.indexOf('const resetAxis ='));
  assert.ok(/const resetAxis = [^\n]*\n\s*e\.stopPropagation\(\);\s*applyResetAxis\(axis\)/.test(wrappers));
  assert.ok(/const resetBothAxes = [^\n]*\n\s*e\.stopPropagation\(\);\s*applyResetBothAxes\(\)/.test(wrappers));
});

test('(d) menu selects go through the shared reset path that commits the ratios', () => {
  assert.ok(src.includes("onSelect={() => applyResetAxis('col')}"));
  assert.ok(src.includes("onSelect={() => applyResetAxis('row')}"));
  assert.ok(src.includes('onSelect={() => applyResetBothAxes()}'));
  const axis = hookSrc.slice(hookSrc.indexOf('const applyResetAxis ='), hookSrc.indexOf('const resetAxis ='));
  assert.ok(/pushedRef\.current\.col = eq;[\s\S]*onPaneColRatiosChange\(eq\)/.test(axis), 'col commit');
  assert.ok(/pushedRef\.current\.row = eq;[\s\S]*onPaneRowRatiosChange\(eq\)/.test(axis), 'row commit');
  const both = hookSrc.slice(hookSrc.indexOf('const applyResetBothAxes ='), hookSrc.indexOf('const resetBothAxes ='));
  assert.ok(both.includes('onPaneColRatiosChange(eqCol)') && both.includes('onPaneRowRatiosChange(eqRow)'), 'both commit');
});
