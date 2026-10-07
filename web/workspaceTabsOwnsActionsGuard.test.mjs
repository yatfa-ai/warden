// WARDEN-1638 (client-state slice 41) — STATIC SOURCE GUARD: <WorkspaceTabs/> owns its six
// workspace actions, the feature-use ticks and the close-workspace confirm dialog; App sheds
// them. No existing spec covers the tick move (featureUsageTelemetry.test.mjs tests the
// sampler API only), so the tick counts are pinned here. Same readFileSync precedent as
// streamStatusDotGuard / globalSearchHostGuard / resizableRailGuard.
//
// Settings-ternary decision: the strip (and so its confirm target, local useState) unmounts
// when Settings opens; a pending close confirmation is simply cancelled and nothing stale
// resurrects on return. Benign + transient (the dialog is modal), so no store command needed.

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(resolve(__dirname, 'src/App.tsx'), 'utf8');
const tabsSrc = readFileSync(resolve(__dirname, 'src/components/WorkspaceTabs.tsx'), 'utf8');

const count = (src, re) => (src.match(re) ?? []).length;

test('(a) App.tsx sheds the six hooks, the close-confirm machine and its dialog', () => {
  for (const name of [
    'useSelectWorkspace', 'useCreateWorkspace', 'useRenameWorkspace',
    'useMovePaneToWorkspace', 'useMovePaneToNewWorkspace', 'useCloseWorkspace',
    'workspaceCloseTarget', 'requestCloseWorkspace', 'confirmCloseWorkspace', 'cancelCloseWorkspace',
  ]) {
    assert.ok(!new RegExp(`\\b${name}\\b`).test(appSrc), `${name} must not appear in App.tsx`);
  }
  assert.ok(!appSrc.includes('Close workspace?'), 'close dialog must not be in App.tsx');
  assert.ok(!/recordFeatureUse\('workspace-(switch|create)'\)/.test(appSrc), 'workspace ticks must not be in App.tsx');
});

test('(b) App renders <WorkspaceTabs/> once with no action props; useConfirmTarget stays for the kill machines', () => {
  assert.strictEqual(count(appSrc, /^\s*<WorkspaceTabs\b/gm), 1, 'rendered exactly once');
  const tag = appSrc.match(/^\s*<WorkspaceTabs\b[^>]*?\/>/ms);
  assert.ok(tag, 'self-closing <WorkspaceTabs … /> found');
  for (const p of ['onSelect', 'onCreate', 'onRename', 'onClose', 'onDropPane', 'onDropPaneNew']) {
    assert.ok(!new RegExp(`\\b${p}\\b`).test(tag[0]), `${p} prop must be gone`);
  }
  assert.ok(/import \{ useConfirmTarget \}/.test(appSrc), 'useConfirmTarget import stays in App');
  assert.strictEqual(count(appSrc, /useConfirmTarget\(/g), 2, 'two kill machines remain');
});

test('(c) WorkspaceTabs owns the six hooks, the confirm machine (ungated) and the dialog', () => {
  for (const h of [
    'useSelectWorkspace', 'useCreateWorkspace', 'useRenameWorkspace',
    'useMovePaneToWorkspace', 'useMovePaneToNewWorkspace', 'useCloseWorkspace',
  ]) {
    assert.strictEqual(count(tabsSrc, new RegExp(`\\b${h}\\(\\)`, 'g')), 1, `${h}() called once`);
  }
  assert.ok(/useConfirmTarget\(closeWorkspace\)/.test(tabsSrc), 'confirm machine with NO gate predicate');
  assert.ok(tabsSrc.includes('title="Close workspace?"'), 'dialog title');
  assert.ok(/destructive/.test(tabsSrc), 'dialog destructive');
  assert.ok(!/interface Props \{[^}]*\bon[A-Z]\w*:/s.test(tabsSrc), 'no action props remain');
});

test('(d) feature-use ticks: switch once, create twice (＋ click and drop-on-＋); rename/move/close tick nothing', () => {
  assert.strictEqual(count(tabsSrc, /recordFeatureUse\('workspace-switch'\)/g), 1);
  assert.strictEqual(count(tabsSrc, /recordFeatureUse\('workspace-create'\)/g), 2);
  assert.strictEqual(count(tabsSrc, /recordFeatureUse\(/g), 3, 'no other ticks');
  // ＋ click must call createWorkspace() with no args (an onClick passthrough would feed the event as seedPaneId)
  assert.ok(/createWorkspace\(\);/.test(tabsSrc), 'create called without args');
});
