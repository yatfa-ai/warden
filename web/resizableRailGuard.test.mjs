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
