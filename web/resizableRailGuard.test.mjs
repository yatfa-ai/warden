// WARDEN-1628 (client-state slice 39) — STATIC SOURCE GUARD for the <ResizableRail/>
// extraction. The panel-resize drag (and the subscriptions to both panel widths)
// live in the rail, so a mousemove while dragging re-renders only the rail, not the
// whole App. Same source-reading precedent as returnBannerGuard / globalSearchHostGuard
// (no React/DOM runner here).

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(resolve(__dirname, 'src/App.tsx'), 'utf8');
const railSrc = readFileSync(resolve(__dirname, 'src/components/ResizableRail.tsx'), 'utf8');

const DRAG_NAMES = [
  'isResizing',
  'dragStartX',
  'dragOtherWidth',
  'dragHealthCollapsed',
  'handleSidebarMouseDown',
  'handleObserverMouseDown',
  'useSidebarWidth',
  'useObserverWidth',
  'useSetSidebarWidth',
  'useSetObserverWidth',
  'clampSidebarWidth',
  'clampObserverWidth',
];

test('(a) drag state + width subscriptions live in ResizableRail.tsx, not App.tsx', () => {
  for (const name of DRAG_NAMES) {
    assert.ok(!new RegExp(`\\b${name}`).test(appSrc), `${name} must not appear in App.tsx`);
  }
  for (const name of ['isResizing', 'dragStartX', 'dragOtherWidth', 'dragHealthCollapsed', 'useSidebarWidth', 'useObserverWidth', 'useSetSidebarWidth', 'useSetObserverWidth', 'clampSidebarWidth', 'clampObserverWidth']) {
    assert.ok(new RegExp(`\\b${name}`).test(railSrc), `${name} must appear in ResizableRail.tsx`);
  }
});

test('(b) <ResizableRail appears exactly twice in App.tsx (sidebar + observer)', () => {
  const matches = appSrc.match(/<ResizableRail\b/g) ?? [];
  assert.strictEqual(matches.length, 2, '<ResizableRail rendered exactly twice');
  assert.ok(/<ResizableRail side="sidebar"/.test(appSrc), 'sidebar rail present');
  assert.ok(/<ResizableRail side="observer"/.test(appSrc), 'observer rail present');
});

test('(c) the rail calls both clamp helpers with the neighbour width captured at mousedown', () => {
  assert.ok(/clampSidebarWidth\(newWidth, dragOtherWidth\.current, ctx\)/.test(railSrc));
  assert.ok(/clampObserverWidth\(newWidth, dragOtherWidth\.current, ctx\)/.test(railSrc));
  // the neighbour capture happens in the mousedown handler, reading 0 when collapsed
  const down = railSrc.slice(railSrc.indexOf('const handleMouseDown'), railSrc.indexOf('useEffect('));
  assert.ok(/dragOtherWidth\.current\s*=/.test(down), 'neighbour width captured at mousedown');
  assert.ok(/Collapsed \? 0 :/.test(down), 'collapsed neighbour reserves 0');
  assert.ok(/uiStore\.getState\(\)/.test(down), 'captured imperatively from the store');
});

// WARDEN-1774 (d) — themed right-click menu on the handle + primary-button-only drag start.
// Comments are stripped so prose cannot satisfy a pattern.
const railCode = railSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

export function checkMenuGuard(code) {
  const errs = [];
  if (!/<ContextMenuTrigger asChild>\s*<div\b[^>]*?onMouseDown=\{handleMouseDown\}/.test(code)) errs.push('trigger must wrap the handle div');
  if (/onContextMenu/.test(code)) errs.push('no native onContextMenu listeners');
  const reset = code.slice(code.indexOf('const handleResetWidth'), code.indexOf('const handleMouseDown'));
  if (!/DEFAULT_UI\.sidebarWidth/.test(reset) || !/DEFAULT_UI\.observerWidth/.test(reset)) errs.push('reset must read DEFAULT_UI widths');
  if (!/clampSidebarWidth\(target, otherWidth, ctx\)/.test(reset)) errs.push('sidebar reset must route through clampSidebarWidth');
  if (!/clampObserverWidth\(target, otherWidth, ctx\)/.test(reset)) errs.push('observer reset must route through clampObserverWidth');
  if (!/Collapsed \? 0 :/.test(reset) || !/uiStore\.getState\(\)/.test(reset)) errs.push('reset must capture neighbour as 0 when collapsed from the store');
  if (/\b(220|380)\b/.test(code)) errs.push('no literal default widths');
  const down = code.slice(code.indexOf('const handleMouseDown'));
  const guardAt = down.indexOf('if (e.button !== 0) return;');
  if (guardAt < 0 || guardAt > down.indexOf('setIsResizing(true)') || guardAt > down.indexOf('preventDefault')) errs.push('mousedown must return on non-primary button before setIsResizing/preventDefault');
  return errs;
}

test('(d) rail handle: themed menu (Reset width / Collapse) + primary-button-only drag', () => {
  assert.deepStrictEqual(checkMenuGuard(railCode), []);
  assert.ok(/Reset \{label\} width/.test(railCode) && /Collapse \{label\}/.test(railCode));
  assert.ok(/<ContextMenuSeparator \/>/.test(railCode));
});

test('(d) negative control: removing the button guard / trigger makes the check fail', () => {
  assert.ok(checkMenuGuard(railCode.replace('if (e.button !== 0) return;', '')).length > 0);
  assert.ok(checkMenuGuard(railCode.replace('<ContextMenuTrigger asChild>', '<div>')).length > 0);
  assert.ok(checkMenuGuard(railCode.replace('clampSidebarWidth(target,', 'setX(target,')).length > 0);
});
