import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * STATIC SOURCE GUARD for the main app header strip's themed context menu
 * (WARDEN-1748, roadmap WARDEN-362). No front-end DOM runner exists, so these
 * pin properties of the SOURCE; "right-click opens the menu" is verified live.
 *
 * NEGATIVE CONTROL: change an item's action in AppHeaderMenu.tsx (e.g.
 * toggleObserver → toggleSidebar) and the matching assertion goes red.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(HERE, 'src', ...p), 'utf8');
const text = read('components', 'AppHeaderMenu.tsx');
const app = read('App.tsx');
const buttons = read('components', 'PanelToggleButtons.tsx');
const menu = text.slice(text.indexOf('<ContextMenuContent>'), text.indexOf('</ContextMenuContent>'));

describe('App header context menu (WARDEN-1748)', () => {
  it('wraps exactly one element, the unchanged header strip, with an asChild trigger', () => {
    assert.strictEqual(text.split('ContextMenuTrigger asChild').length - 1, 1);
    assert.match(text, /<ContextMenuTrigger asChild>\s*<header className="flex items-center gap-3 px-3 h-11 border-b shrink-0">/);
    assert.ok(app.includes('<AppHeaderMenu>') && app.includes('</AppHeaderMenu>'));
    assert.ok(!app.includes('<header className="flex items-center gap-3 px-3 h-11 border-b shrink-0">'));
  });

  it('adds no own context-menu handler and never stops propagation (tab menus keep winning)', () => {
    assert.ok(!text.includes('onContextMenu'));
    assert.ok(!text.includes('stopPropagation'));
    assert.ok(!text.includes('preventDefault'));
  });

  it('subscribes to the collapse flags itself; App.tsx does not', () => {
    for (const n of ['useSidebarCollapsed', 'useObserverCollapsed', 'useHealthCollapsed']) {
      assert.match(text, new RegExp(`\\b${n}\\(\\)`));
      assert.ok(!new RegExp(`\\b${n}\\b`).test(app));
    }
  });

  it('sidebar item calls only the toggle action, labelled by state', () => {
    assert.match(menu, /onSelect=\{\(\) => \{ toggleSidebar\(\); \}\}>\{sidebarCollapsed \? 'Show sidebar' : 'Hide sidebar'\}/);
    assert.match(buttons, /useToggleSidebarCollapsed\(\)/);
  });

  it('observer item calls only the toggle action, labelled by state', () => {
    assert.match(menu, /onSelect=\{\(\) => \{ toggleObserver\(\); \}\}>\{observerCollapsed \? 'Show observer' : 'Hide observer'\}/);
  });

  it('sidebar/observer items do not record feature use (PanelLayoutSync owns their ticks)', () => {
    const lines = menu.split('\n').filter((l) => /toggleSidebar\(\)|toggleObserver\(\)/.test(l));
    assert.strictEqual(lines.length, 2);
    for (const l of lines) assert.ok(!l.includes('recordFeatureUse'));
  });

  it('Health item records panel-expand-health on collapsed→expanded only, then sets !collapsed', () => {
    assert.match(menu, /onSelect=\{\(\) => \{ if \(healthCollapsed\) getFeatureUsageSampler\(\)\.sampler\.recordFeatureUse\('panel-expand-health'\); setHealthCollapsed\(!healthCollapsed\); \}\}>\{healthCollapsed \? 'Show Health panel' : 'Hide Health panel'\}/);
    assert.strictEqual(menu.split("'panel-expand-health'").length - 1, 1);
    // same behaviour as the button
    assert.match(buttons, /if \(collapsed\) getFeatureUsageSampler\(\)\.sampler\.recordFeatureUse\('panel-expand-health'\); setCollapsed\(!collapsed\);/);
  });

  it('Search… and Settings… match the header buttons, after a separator', () => {
    assert.match(menu, /<ContextMenuSeparator \/>\s*<ContextMenuItem onSelect=\{\(\) => setGlobalSearchOpen\(true\)\}>Search…<\/ContextMenuItem>/);
    assert.match(menu, /onSelect=\{\(\) => \{ getFeatureUsageSampler\(\)\.sampler\.recordFeatureUse\('settings'\); setSettingsOpen\(true\); \}\}>Settings…</);
    assert.match(app, /onClick=\{\(\) => setGlobalSearchOpen\(true\)\}/);
    assert.match(app, /recordFeatureUse\('settings'\); setSettingsOpen\(true\);/);
  });
});
