// WARDEN-1645 (client-state slice 42) — STATIC SOURCE GUARD for the
// <PanelLayoutSync/> + <PanelToggleButtons/> + <HealthPanel/> extraction. App must
// not subscribe to the three panel-collapse flags (a toggle would re-render all of
// App); the always-mounted PanelLayoutSync owns the expand ticks, resize listener
// and re-clamp, and sits OUTSIDE the settingsOpen ternary (the header/<main>
// unmount while Settings is open; useRecordOnExpand seeds from the MOUNT value).
// Same source-reading precedent as globalSearchHostGuard / resizableRailGuard.
//
// NEGATIVE CONTROL (verified when written): re-add
//   const healthCollapsed = useHealthCollapsed();
// to App.tsx and guard (a) goes red naming useHealthCollapsed.

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(__dirname, p), 'utf8');
const appSrc = read('src/App.tsx');
const syncSrc = read('src/components/PanelLayoutSync.tsx');
const buttonsSrc = read('src/components/PanelToggleButtons.tsx');
const healthSrc = read('src/components/HealthPanel.tsx');
const newSrc = syncSrc + buttonsSrc + healthSrc;

const NAMES = [
  'useSidebarCollapsed', 'useObserverCollapsed', 'useHealthCollapsed',
  'useToggleSidebarCollapsed', 'useToggleObserverCollapsed', 'useReclampPanelWidths',
  'useRecordOnExpand', 'applyLayoutClamp', 'HEALTH_WIDTH', 'useSetHealthCollapsed',
];

test('(a) the collapse subscriptions + layout plumbing are gone from App.tsx and live in the new components', () => {
  for (const name of NAMES) {
    assert.ok(!new RegExp(`\\b${name}\\b`).test(appSrc), `${name} must not appear in App.tsx`);
    assert.ok(new RegExp(`\\b${name}\\b`).test(newSrc), `${name} must appear in the new component files`);
  }
  assert.ok(/\buseRecordOnExpand\b/.test(syncSrc) && /\buseReclampPanelWidths\b/.test(syncSrc), 'PanelLayoutSync owns expand ticks + re-clamp');
  assert.ok(/addEventListener\('resize'/.test(syncSrc), 'PanelLayoutSync owns the window resize listener');
  assert.ok(/\bHEALTH_WIDTH\b/.test(healthSrc), 'HealthPanel owns HEALTH_WIDTH');
  assert.ok(!/\bHealthDashboard\b[^\n]*import|import[^\n]*\bHealthDashboard\b/.test(appSrc), 'App no longer imports HealthDashboard');
});

test("(b) the health button's expand tick stays a button-local recordFeatureUse (not useRecordOnExpand)", () => {
  assert.ok(buttonsSrc.includes("recordFeatureUse('panel-expand-health')"), "toggle button records 'panel-expand-health'");
  assert.ok(!appSrc.includes("'panel-expand-health'"), "'panel-expand-health' must not remain in App.tsx");
  assert.ok(!/useRecordOnExpand\([^)]*health/i.test(syncSrc), 'health is deliberately NOT a useRecordOnExpand');
  assert.ok(/getFeatureUsageSampler/.test(appSrc), 'App keeps its getFeatureUsageSampler import (still used elsewhere)');
});

test('(c) <PanelLayoutSync/> renders exactly once, AFTER the settingsOpen ternary closes (stays mounted)', () => {
  const matches = appSrc.match(/^\s*<PanelLayoutSync \/>/gm) ?? [];
  assert.strictEqual(matches.length, 1, '<PanelLayoutSync/> rendered exactly once');
  const ternaryIdx = appSrc.indexOf('{settingsOpen ?');
  assert.notEqual(ternaryIdx, -1, 'the settingsOpen ternary is findable');
  const closeIdx = appSrc.indexOf('\n      )}\n', ternaryIdx);
  assert.notEqual(closeIdx, -1, 'the ternary close is findable');
  assert.ok(appSrc.indexOf('      <PanelLayoutSync />') > closeIdx, '<PanelLayoutSync/> must come after the ternary closes, not inside it');
});

test('(d) toggle buttons + HealthPanel render inside the ternary non-settings branch, once per position', () => {
  const ternaryIdx = appSrc.indexOf('{settingsOpen ?');
  const closeIdx = appSrc.indexOf('\n      )}\n', ternaryIdx);
  const elseIdx = appSrc.indexOf('      ) : (', ternaryIdx);
  assert.ok(elseIdx > ternaryIdx && elseIdx < closeIdx, 'the non-settings branch is findable');
  const branch = appSrc.slice(elseIdx, closeIdx);
  for (const panel of ['sidebar', 'health', 'observer']) {
    assert.strictEqual((appSrc.match(new RegExp(`<PanelToggleButtons panel="${panel}"`, 'g')) ?? []).length, 1, `one ${panel} toggle in App`);
    assert.ok(branch.includes(`<PanelToggleButtons panel="${panel}"`), `${panel} toggle is in the non-settings branch`);
  }
  assert.strictEqual((appSrc.match(/^\s*<HealthPanel$/gm) ?? []).length, 1, '<HealthPanel/> rendered once');
  assert.ok(/^\s*<HealthPanel$/m.test(branch), '<HealthPanel/> is in the non-settings branch');
  // DOM order: sidebar toggle precedes the title; health then observer toggles in the right cluster.
  const iSide = branch.indexOf('panel="sidebar"'), iTitle = branch.indexOf('Yatfa Warden');
  const iHealth = branch.indexOf('panel="health"'), iObs = branch.indexOf('panel="observer"'), iSet = branch.indexOf('label="settings"');
  assert.ok(iSide < iTitle && iTitle < iHealth && iHealth < iObs && iObs < iSet, 'header DOM order unchanged');
});
