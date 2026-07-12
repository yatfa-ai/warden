// Focused tests for the "Restore workspace on startup" preference.
//
// There is no front-end test runner in this repo, so this file loads the REAL
// storage module (transpiled TS -> ESM via Vite's esbuild) against an in-memory
// localStorage polyfill. It exercises loadUi/saveUi round-tripping of the new
// pref and — critically — proves the persistence-conflict pitfall is handled:
// an 'empty' launch must NOT wipe a previously-saved workspace.
//
// Run: node storage.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const storagePath = resolve(__dirname, 'src/lib/storage.ts');

// --- Polyfill localStorage (Node has none) BEFORE loading storage.ts ---------
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  clear: () => { mem.clear(); },
};
const reset = () => mem.clear();

// --- Load the REAL storage.ts (TS -> ESM via the OXC transform Vite bundles) -
const src = readFileSync(storagePath, 'utf8');
const { code } = await transformWithOxc(src, storagePath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-storage-test-'));
const tmpFile = join(tmpDir, 'storage.mjs');
writeFileSync(tmpFile, code);
const { loadUi, saveUi, loadObs, saveObs, persistUiState, initialWorkspace, validatePresetName, isReservedPresetName, PRESET_NAME_MAX, clampSidebarWidth, clampObserverWidth, clampLayoutWidths, SIDEBAR_MIN, SIDEBAR_MAX, OBSERVER_MIN, OBSERVER_MAX, PANE_MIN, HEALTH_WIDTH } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

console.log('\nrestoreOnStartup round-trips through loadUi/saveUi');
test('defaults to "previous" when nothing is stored', () => {
  reset();
  assert.equal(loadUi().restoreOnStartup, 'previous');
});
test('"empty" round-trips', () => {
  reset();
  saveUi({ ...loadUi(), restoreOnStartup: 'empty' });
  assert.equal(loadUi().restoreOnStartup, 'empty');
});
test('"previous" round-trips', () => {
  reset();
  saveUi({ ...loadUi(), restoreOnStartup: 'previous' });
  assert.equal(loadUi().restoreOnStartup, 'previous');
});
test('a stored non-"empty" value coerces back to "previous" on load (defensive)', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], restoreOnStartup: 'bogus' }));
  assert.equal(loadUi().restoreOnStartup, 'previous');
});
test('a missing field loads as "previous"', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'] }));
  assert.equal(loadUi().restoreOnStartup, 'previous');
});

console.log('\ndefault-new-chat prefs (agent type + host) round-trip through loadUi/saveUi');
test('preset defaults to "claude" and host to "(local)" when nothing is stored', () => {
  reset();
  const ui = loadUi();
  assert.equal(ui.defaultNewChatPreset, 'claude');
  assert.equal(ui.defaultNewChatHost, '(local)');
});
test('shell preset + a remote host round-trip', () => {
  reset();
  saveUi({ ...loadUi(), defaultNewChatPreset: 'shell', defaultNewChatHost: 'prod-box' });
  const ui = loadUi();
  assert.equal(ui.defaultNewChatPreset, 'shell');
  assert.equal(ui.defaultNewChatHost, 'prod-box');
});
test('an out-of-allow-set preset coerces back to "claude" on load (defensive)', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], defaultNewChatPreset: 'bogus', defaultNewChatHost: 'prod-box' }));
  const ui = loadUi();
  assert.equal(ui.defaultNewChatPreset, 'claude');
  assert.equal(ui.defaultNewChatHost, 'prod-box', 'host is unaffected by preset coercion');
});
test('a non-string host coerces back to "(local)" on load (defensive)', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], defaultNewChatHost: 42 }));
  assert.equal(loadUi().defaultNewChatHost, '(local)');
});
test('missing fields load as the defaults', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'] }));
  const ui = loadUi();
  assert.equal(ui.defaultNewChatPreset, 'claude');
  assert.equal(ui.defaultNewChatHost, '(local)');
});
test('both prefs survive an empty-mode mount (carried by the live spread, not the frozen workspace)', () => {
  // The new prefs are NOT workspace fields, so persistUiState spreads them from
  // `live`. Confirm an empty-launch still round-trips a freshly set default.
  reset();
  const d0 = loadUi();
  saveUi(persistUiState({ ...d0, defaultNewChatPreset: 'shell', defaultNewChatHost: 'prod-box' }, 'empty', d0, true));
  const after = loadUi();
  assert.equal(after.defaultNewChatPreset, 'shell');
  assert.equal(after.defaultNewChatHost, 'prod-box');
});

console.log('\ncustomPresets validate + round-trip through loadUi/saveUi');
test('defaults to [] when nothing is stored', () => {
  reset();
  assert.deepEqual(loadUi().customPresets, []);
});
test('valid presets round-trip', () => {
  reset();
  saveUi({ ...loadUi(), customPresets: [{ name: 'codex', cmd: 'codex' }, { name: 'gemini', cmd: 'gemini -m pro' }] });
  assert.deepEqual(loadUi().customPresets, [{ name: 'codex', cmd: 'codex' }, { name: 'gemini', cmd: 'gemini -m pro' }]);
});
test('a non-array customPresets coerces to [] (defensive, no throw)', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], customPresets: 'bogus' }));
  assert.deepEqual(loadUi().customPresets, []);
});
test('entries missing name or cmd are dropped (never blank the spawn command)', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], customPresets: [{ name: 'ok', cmd: 'ok' }, { name: 'nocmd' }, { cmd: 'noname' }, {}] }));
  assert.deepEqual(loadUi().customPresets, [{ name: 'ok', cmd: 'ok' }]);
});
test('reserved built-in names (claude/shell) are rejected as custom presets', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], customPresets: [{ name: 'claude', cmd: 'whatever' }, { name: 'shell', cmd: 'bash' }, { name: 'codex', cmd: 'codex' }] }));
  assert.deepEqual(loadUi().customPresets, [{ name: 'codex', cmd: 'codex' }]);
});
test('reserved built-in names are rejected CASE-INSENSITIVELY (no "Claude"/"Shell" near-collision)', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], customPresets: [{ name: 'Claude', cmd: 'whatever' }, { name: 'SHELL', cmd: 'bash' }, { name: 'ShElL', cmd: 'zsh' }, { name: 'codex', cmd: 'codex' }] }));
  // Every case variant of a built-in is dropped, matching the case-insensitive dedup.
  assert.deepEqual(loadUi().customPresets, [{ name: 'codex', cmd: 'codex' }]);
});
test('the name length cap is exactly PRESET_NAME_MAX (boundary: N ok, N+1 dropped)', () => {
  reset();
  const exact = 'x'.repeat(PRESET_NAME_MAX);
  const tooLong = 'x'.repeat(PRESET_NAME_MAX + 1);
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], customPresets: [{ name: exact, cmd: 'a' }, { name: tooLong, cmd: 'b' }] }));
  assert.deepEqual(loadUi().customPresets, [{ name: exact, cmd: 'a' }]);
});
test('duplicate names are de-duplicated (case-insensitive, first wins)', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], customPresets: [{ name: 'Codex', cmd: 'codex' }, { name: 'codex', cmd: 'codex2' }] }));
  assert.deepEqual(loadUi().customPresets, [{ name: 'Codex', cmd: 'codex' }]);
});
test('names over 32 chars are dropped', () => {
  reset();
  const long = 'x'.repeat(33);
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], customPresets: [{ name: long, cmd: 'cmd' }, { name: 'ok', cmd: 'ok' }] }));
  assert.deepEqual(loadUi().customPresets, [{ name: 'ok', cmd: 'ok' }]);
});

console.log('\nvalidatePresetName / isReservedPresetName — the write-site contract (add/rename route through this)');
test('isReservedPresetName matches built-ins case-insensitively', () => {
  assert.equal(isReservedPresetName('claude'), true);
  assert.equal(isReservedPresetName('SHELL'), true);
  assert.equal(isReservedPresetName('ShElL'), true);
  assert.equal(isReservedPresetName('codex'), false);
  assert.equal(isReservedPresetName(''), false);
});
test('validatePresetName returns null for an acceptable name', () => {
  assert.equal(validatePresetName('codex', [{ name: 'gemini', cmd: 'g' }]), null);
});
test('validatePresetName flags empty (after trim)', () => {
  assert.equal(validatePresetName('', []), 'empty');
  assert.equal(validatePresetName('   ', []), 'empty');
});
test('validatePresetName flags names longer than PRESET_NAME_MAX', () => {
  // Regression for the blocking review issue: rename must not bypass the cap.
  assert.equal(validatePresetName('x'.repeat(PRESET_NAME_MAX), []), null);
  assert.equal(validatePresetName('x'.repeat(PRESET_NAME_MAX + 1), []), 'too-long');
});
test('validatePresetName flags reserved built-ins case-insensitively', () => {
  assert.equal(validatePresetName('claude', []), 'reserved');
  assert.equal(validatePresetName('Claude', []), 'reserved');
  assert.equal(validatePresetName('SHELL', []), 'reserved');
});
test('validatePresetName flags duplicates case-insensitively', () => {
  const existing = [{ name: 'codex', cmd: 'c' }];
  assert.equal(validatePresetName('codex', existing), 'duplicate');
  assert.equal(validatePresetName('CODEX', existing), 'duplicate');
  assert.equal(validatePresetName('gemini', existing), null);
});
test('validatePresetName excludes `except` so a case-only rename is allowed', () => {
  // Renaming codex -> Codex must NOT be flagged as its own duplicate.
  const existing = [{ name: 'codex', cmd: 'c' }];
  assert.equal(validatePresetName('Codex', existing, 'codex'), null);
  // But a rename colliding with a DIFFERENT preset is still blocked.
  const two = [{ name: 'codex', cmd: 'c' }, { name: 'gemini', cmd: 'g' }];
  assert.equal(validatePresetName('gemini', two, 'codex'), 'duplicate');
});
test('validatePresetName trims before validating (matches load-time normalization)', () => {
  assert.equal(validatePresetName('  codex  ', []), null);
  assert.equal(validatePresetName('  codex  ', [{ name: 'codex', cmd: 'c' }]), 'duplicate');
});

console.log('\ndefaultNewChatPreset (widened) accepts a custom preset name and falls back on delete');
test('a custom preset name can be the default and round-trips', () => {
  reset();
  saveUi({ ...loadUi(), customPresets: [{ name: 'codex', cmd: 'codex' }], defaultNewChatPreset: 'codex' });
  const ui = loadUi();
  assert.equal(ui.defaultNewChatPreset, 'codex');
  assert.deepEqual(ui.customPresets, [{ name: 'codex', cmd: 'codex' }]);
});
test('a default naming a since-deleted preset falls back to claude (criterion e)', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], customPresets: [], defaultNewChatPreset: 'codex' }));
  // codex is not in the (empty) custom list → must not dangle
  assert.equal(loadUi().defaultNewChatPreset, 'claude');
});
test('built-in claude/shell defaults remain valid', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], defaultNewChatPreset: 'shell' }));
  assert.equal(loadUi().defaultNewChatPreset, 'shell');
});
test('a stored non-string preset coerces back to claude (defensive)', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], defaultNewChatPreset: 42 }));
  assert.equal(loadUi().defaultNewChatPreset, 'claude');
});
test('custom presets survive an empty-mode mount (criterion c)', () => {
  reset();
  const d0 = loadUi();
  saveUi(persistUiState({ ...d0, customPresets: [{ name: 'codex', cmd: 'codex' }], defaultNewChatPreset: 'codex' }, 'empty', d0, true));
  const after = loadUi();
  assert.deepEqual(after.customPresets, [{ name: 'codex', cmd: 'codex' }]);
  assert.equal(after.defaultNewChatPreset, 'codex');
});

console.log('\npaneLayout round-trips through loadUi/saveUi');
test('defaults to "auto" when nothing is stored', () => {
  reset();
  assert.equal(loadUi().paneLayout, 'auto');
});
test('"stacked" round-trips', () => {
  reset();
  saveUi({ ...loadUi(), paneLayout: 'stacked' });
  assert.equal(loadUi().paneLayout, 'stacked');
});
test('"side-by-side" round-trips', () => {
  reset();
  saveUi({ ...loadUi(), paneLayout: 'side-by-side' });
  assert.equal(loadUi().paneLayout, 'side-by-side');
});
test('"auto" round-trips', () => {
  reset();
  saveUi({ ...loadUi(), paneLayout: 'auto' });
  assert.equal(loadUi().paneLayout, 'auto');
});
test('a stored invalid value coerces back to "auto" on load (defensive)', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], paneLayout: 'diagonal' }));
  assert.equal(loadUi().paneLayout, 'auto');
});
test('a missing field loads as "auto"', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'] }));
  assert.equal(loadUi().paneLayout, 'auto');
});

console.log('\nterminal color scheme (auto/dark/light) round-trips through loadUi/saveUi');
test('defaults to "auto" when nothing is stored', () => {
  reset();
  assert.equal(loadUi().terminalColorScheme, 'auto');
});
test('"dark" and "light" round-trip', () => {
  reset();
  saveUi({ ...loadUi(), terminalColorScheme: 'dark' });
  assert.equal(loadUi().terminalColorScheme, 'dark');
  saveUi({ ...loadUi(), terminalColorScheme: 'light' });
  assert.equal(loadUi().terminalColorScheme, 'light');
});
test('an out-of-allow-set value coerces back to "auto" on load (defensive)', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], terminalColorScheme: 'bogus' }));
  assert.equal(loadUi().terminalColorScheme, 'auto');
});
test('a missing field loads as "auto"', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'] }));
  assert.equal(loadUi().terminalColorScheme, 'auto');
});
test('the pref survives an empty-mode mount (carried by the live spread, not the frozen workspace)', () => {
  // terminalColorScheme is NOT a workspace field, so persistUiState spreads it
  // from `live`. Confirm an empty-launch still round-trips a freshly set value.
  reset();
  const d0 = loadUi();
  saveUi(persistUiState({ ...d0, terminalColorScheme: 'light' }, 'empty', d0, true));
  assert.equal(loadUi().terminalColorScheme, 'light');
});

console.log('\nterminal cursor style (blink/steady × block/underline/bar) round-trips through loadUi/saveUi');
test('defaults to "blink-block" when nothing is stored', () => {
  reset();
  assert.equal(loadUi().terminalCursorStyle, 'blink-block');
});
test('all six values round-trip', () => {
  const all = ['blink-block', 'steady-block', 'blink-underline', 'steady-underline', 'blink-bar', 'steady-bar'];
  for (const v of all) {
    reset();
    saveUi({ ...loadUi(), terminalCursorStyle: v });
    assert.equal(loadUi().terminalCursorStyle, v, `${v} should round-trip`);
  }
});
test('an out-of-allow-set value coerces back to "blink-block" on load (defensive)', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], terminalCursorStyle: 'diagonal' }));
  assert.equal(loadUi().terminalCursorStyle, 'blink-block');
});
test('a missing field loads as "blink-block"', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'] }));
  assert.equal(loadUi().terminalCursorStyle, 'blink-block');
});
test('the pref survives an empty-mode mount (carried by the live spread, not the frozen workspace)', () => {
  // terminalCursorStyle is NOT a workspace field, so persistUiState spreads it
  // from `live`. Confirm an empty-launch still round-trips a freshly set value.
  reset();
  const d0 = loadUi();
  saveUi(persistUiState({ ...d0, terminalCursorStyle: 'steady-bar' }, 'empty', d0, true));
  assert.equal(loadUi().terminalCursorStyle, 'steady-bar');
});

console.log('\ncopyOnSelect (opt-in select-to-copy) round-trips through loadUi/saveUi — WARDEN-285');
test('defaults to false when nothing is stored (today\'s exact behavior, zero regression)', () => {
  reset();
  assert.equal(loadUi().copyOnSelect, false);
});
test('true round-trips', () => {
  reset();
  saveUi({ ...loadUi(), copyOnSelect: true });
  assert.equal(loadUi().copyOnSelect, true);
});
test('false round-trips (stays off)', () => {
  reset();
  saveUi({ ...loadUi(), copyOnSelect: false });
  assert.equal(loadUi().copyOnSelect, false);
});
test('only an explicitly-stored true enables it — missing stays false (opt-in)', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'] }));
  assert.equal(loadUi().copyOnSelect, false);
});
test('a non-boolean coerces back to false on load (defensive)', () => {
  // copyOnSelect === true is the only gate, so a truthy-but-not-true value
  // (1, "true", {}) must NOT enable it. This is the conservative default.
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], copyOnSelect: 1 }));
  assert.equal(loadUi().copyOnSelect, false);
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], copyOnSelect: 'true' }));
  assert.equal(loadUi().copyOnSelect, false);
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], copyOnSelect: {} }));
  assert.equal(loadUi().copyOnSelect, false);
});
test('the pref survives an empty-mode mount (carried by the live spread, not the frozen workspace)', () => {
  // copyOnSelect is NOT a workspace field, so persistUiState spreads it from
  // `live`. Confirm an empty-launch still round-trips a freshly enabled value.
  reset();
  const d0 = loadUi();
  saveUi(persistUiState({ ...d0, copyOnSelect: true }, 'empty', d0, true));
  assert.equal(loadUi().copyOnSelect, true);
});

console.log('\nonExitBehavior (keep/dim/auto-close) round-trips through loadUi/saveUi — WARDEN-248');
test('defaults to "keep" when nothing is stored', () => {
  reset();
  assert.equal(loadUi().onExitBehavior, 'keep');
});
test('"dim" and "auto-close" round-trip', () => {
  reset();
  saveUi({ ...loadUi(), onExitBehavior: 'dim' });
  assert.equal(loadUi().onExitBehavior, 'dim');
  saveUi({ ...loadUi(), onExitBehavior: 'auto-close' });
  assert.equal(loadUi().onExitBehavior, 'auto-close');
});
test('"keep" round-trips', () => {
  reset();
  saveUi({ ...loadUi(), onExitBehavior: 'keep' });
  assert.equal(loadUi().onExitBehavior, 'keep');
});
test('an out-of-allow-set value coerces back to "keep" on load (defensive)', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], onExitBehavior: 'destroy' }));
  assert.equal(loadUi().onExitBehavior, 'keep');
});
test('a non-string value coerces back to "keep" on load (defensive)', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], onExitBehavior: 42 }));
  assert.equal(loadUi().onExitBehavior, 'keep');
});
test('a missing field loads as "keep"', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'] }));
  assert.equal(loadUi().onExitBehavior, 'keep');
});
test('the pref survives an empty-mode mount (carried by the live spread, not the frozen workspace)', () => {
  // onExitBehavior is NOT a workspace field, so persistUiState spreads it from
  // `live`. Confirm an empty-launch still round-trips a freshly set value.
  reset();
  const d0 = loadUi();
  saveUi(persistUiState({ ...d0, onExitBehavior: 'auto-close' }, 'empty', d0, true));
  assert.equal(loadUi().onExitBehavior, 'auto-close');
});

console.log('\nautoFocusNewPane (true/false) round-trips through loadUi/saveUi — WARDEN-274');
test('defaults to true when nothing is stored', () => {
  reset();
  assert.equal(loadUi().autoFocusNewPane, true);
});
test('false round-trips (the opt-out value)', () => {
  reset();
  saveUi({ ...loadUi(), autoFocusNewPane: false });
  assert.equal(loadUi().autoFocusNewPane, false);
});
test('true round-trips', () => {
  reset();
  saveUi({ ...loadUi(), autoFocusNewPane: true });
  assert.equal(loadUi().autoFocusNewPane, true);
});
test('only an explicit false opts out — a non-boolean value coerces back to true (defensive)', () => {
  // Anything that is not strictly === false keeps today's focus-on-open behavior,
  // so a corrupt/partial payload can never silently disable focus-stealing.
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], autoFocusNewPane: 42 }));
  assert.equal(loadUi().autoFocusNewPane, true);
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], autoFocusNewPane: 'false' }));
  assert.equal(loadUi().autoFocusNewPane, true, 'the string "false" is not the boolean false');
});
test('a missing field loads as true', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'] }));
  assert.equal(loadUi().autoFocusNewPane, true);
});
test('the pref survives an empty-mode mount (carried by the live spread, not the frozen workspace)', () => {
  // autoFocusNewPane is NOT a workspace field, so persistUiState spreads it from
  // `live`. Confirm an empty-launch still round-trips a freshly set opt-out.
  reset();
  const d0 = loadUi();
  saveUi(persistUiState({ ...d0, autoFocusNewPane: false }, 'empty', d0, true));
  assert.equal(loadUi().autoFocusNewPane, false);
});

console.log('\ninitialWorkspace gates the workspace on mount');
test('"previous" restores the last-saved workspace', () => {
  const disk = { ...loadUi(), activeTabs: ['a', 'b'], hiddenTabs: ['h'], workspaces: [{ id: 'w1', name: 'Workspace 1', openPanes: ['a'], focused: 'a' }], activeWorkspaceId: 'w1', paneHost: { a: 'host' } };
  const ws = initialWorkspace(disk, 'previous');
  assert.deepEqual(ws.activeTabs, ['a', 'b']);
  assert.deepEqual(ws.hiddenTabs, ['h']);
  assert.deepEqual(ws.workspaces, [{ id: 'w1', name: 'Workspace 1', openPanes: ['a'], focused: 'a' }]);
  assert.equal(ws.activeWorkspaceId, 'w1');
  assert.deepEqual(ws.paneHost, { a: 'host' });
});
test('"empty" yields a clean slate: one empty workspace, blank tabs, no hosts', () => {
  const disk = { ...loadUi(), activeTabs: ['a', 'b'], hiddenTabs: ['h'], workspaces: [{ id: 'w1', name: 'Workspace 1', openPanes: ['a'], focused: 'a' }], activeWorkspaceId: 'w1', paneHost: { a: 'host' } };
  const ws = initialWorkspace(disk, 'empty');
  assert.deepEqual(ws.activeTabs, []);
  assert.deepEqual(ws.hiddenTabs, []);
  assert.equal(ws.workspaces.length, 1, 'exactly one workspace on a clean slate');
  assert.deepEqual(ws.workspaces[0].openPanes, [], 'empty workspace has no panes');
  assert.equal(ws.workspaces[0].focused, null, 'empty workspace has no focus');
  assert.equal(ws.activeWorkspaceId, ws.workspaces[0].id, 'the empty workspace is active');
  assert.deepEqual(ws.paneHost, {});
});

console.log('\npersistence-conflict pitfall: an "empty" session must not wipe the saved workspace');
test('empty mount persists empty live workspace WITHOUT destroying the saved workspace', () => {
  reset();
  // 1) Last session (previous mode, startedEmpty=false) saved a real workspace.
  const d0 = loadUi();
  saveUi(persistUiState({ ...d0, activeTabs: ['chat-1', 'chat-2'], workspaces: [{ id: 'w1', name: 'Workspace 1', openPanes: ['chat-1'], focused: 'chat-1' }], activeWorkspaceId: 'w1', paneHost: { 'chat-1': 'host-a' } }, 'previous', d0, false));
  assert.deepEqual(loadUi().activeTabs, ['chat-1', 'chat-2']);

  // 2) A fresh launch in 'empty' mode: startedEmpty=true seeds an empty live
  //    workspace (initialWorkspace('empty')), and the saveUi effect fires on
  //    mount with that empty workspace — the exact situation that used to wipe it.
  const d1 = loadUi();
  const emptyWs = initialWorkspace(d1, 'empty');
  saveUi(persistUiState({ ...d1, activeTabs: [], hiddenTabs: [], workspaces: emptyWs.workspaces, activeWorkspaceId: emptyWs.activeWorkspaceId, paneHost: {} }, 'empty', d1, true));

  // 3) The persisted workspace must STILL be intact.
  const after = loadUi();
  assert.equal(after.restoreOnStartup, 'empty');
  assert.deepEqual(after.activeTabs, ['chat-1', 'chat-2'], 'activeTabs survived the empty mount');
  assert.deepEqual(after.workspaces, [{ id: 'w1', name: 'Workspace 1', openPanes: ['chat-1'], focused: 'chat-1' }], 'workspaces survived the empty mount');
  assert.equal(after.activeWorkspaceId, 'w1', 'activeWorkspaceId survived the empty mount');
  assert.deepEqual(after.paneHost, { 'chat-1': 'host-a' }, 'paneHost survived the empty mount');
});
test('flipping empty -> previous AFTER an empty launch does NOT wipe the saved workspace', () => {
  // Regression guard for the in-session flip data-loss bug. The live workspace is
  // still empty from the empty mount; flipping the pref to 'previous' re-fires the
  // saveUi effect. Because startedEmpty=true, persistUiState must still carry the
  // on-disk workspace forward — NOT write the live empty workspace under the new
  // 'previous' mode.
  reset();
  const d0 = loadUi();
  saveUi(persistUiState({ ...d0, activeTabs: ['A', 'B', 'C'], workspaces: [{ id: 'w1', name: 'Workspace 1', openPanes: ['A'], focused: 'A' }], activeWorkspaceId: 'w1', paneHost: { A: 'host-a' } }, 'previous', d0, false));

  // Empty launch, then flip back to 'previous' mid-session (live workspace still empty).
  const d1 = loadUi();
  const emptyWs = initialWorkspace(d1, 'empty');
  saveUi(persistUiState({ ...d1, activeTabs: [], workspaces: emptyWs.workspaces, activeWorkspaceId: emptyWs.activeWorkspaceId, paneHost: {} }, 'previous', d1, true));

  // The saved workspace survives the flip.
  const after = loadUi();
  assert.equal(after.restoreOnStartup, 'previous', 'pref persisted as previous');
  assert.deepEqual(after.activeTabs, ['A', 'B', 'C'], 'flip empty->previous preserved activeTabs');
  assert.deepEqual(after.workspaces, [{ id: 'w1', name: 'Workspace 1', openPanes: ['A'], focused: 'A' }], 'flip empty->previous preserved workspaces');
  assert.equal(after.activeWorkspaceId, 'w1', 'flip empty->previous preserved activeWorkspaceId');
  assert.deepEqual(after.paneHost, { A: 'host-a' }, 'flip empty->previous preserved paneHost');

  // And the next launch (now 'previous', startedEmpty=false) restores it intact.
  assert.deepEqual(loadUi().activeTabs, ['A', 'B', 'C'], 'next previous-launch restores the workspace');
});
test('a previous-started session flipping to empty then back preserves the workspace too', () => {
  // startedEmpty=false the whole time: flipping previous -> empty -> previous.
  // While pref is 'empty' the workspace is frozen on disk; flipping back writes
  // the (still-present) live workspace legitimately. No loss in any direction.
  reset();
  const d0 = loadUi();
  const ws = [{ id: 'w1', name: 'Workspace 1', openPanes: ['X'], focused: 'X' }];
  saveUi(persistUiState({ ...d0, activeTabs: ['X', 'Y'], workspaces: ws, activeWorkspaceId: 'w1' }, 'previous', d0, false));
  // previous -> empty (mid-session, startedEmpty=false): freeze on disk.
  const d1 = loadUi();
  saveUi(persistUiState({ ...d1, activeTabs: ['X', 'Y'], workspaces: ws, activeWorkspaceId: 'w1' }, 'empty', d1, false));
  assert.deepEqual(loadUi().workspaces, ws, 'workspace frozen while pref is empty');
  // empty -> previous (still startedEmpty=false): live workspace is legitimate again.
  const d2 = loadUi();
  saveUi(persistUiState({ ...d2, activeTabs: ['X', 'Y'], workspaces: ws, activeWorkspaceId: 'w1' }, 'previous', d2, false));
  assert.deepEqual(loadUi().workspaces, ws, 'workspace intact after flipping back');
});
test('sanity: naively persisting the live empty workspace WOULD wipe it (guard against regression)', () => {
  // If persistUiState ever stopped protecting the workspace in 'empty' mode and
  // just spread the live arrays, the saved workspace would be destroyed. This
  // encodes the dangerous behavior we explicitly do NOT do, to document the risk.
  reset();
  saveUi({ ...loadUi(), activeTabs: ['chat-1'], workspaces: [{ id: 'w1', name: 'Workspace 1', openPanes: ['chat-1'], focused: 'chat-1' }] });
  assert.deepEqual(loadUi().workspaces[0].openPanes, ['chat-1']);
  // The naive (wrong) write the fix replaces:
  const blanked = initialWorkspace(loadUi(), 'empty');
  saveUi({ ...loadUi(), activeTabs: [], workspaces: blanked.workspaces });
  assert.deepEqual(loadUi().workspaces[0].openPanes, [], 'naive write wipes the workspace (this is what persistUiState prevents)');
});

// Middle pane width implied by a (window, sidebar, observer, health?) layout.
const middle = (w, sb, ob, healthCollapsed = true) => w - sb - ob - (healthCollapsed ? 0 : HEALTH_WIDTH);

console.log('\nlayout width clamps: no panel crushes below a usable floor (WARDEN-183)');
test('constants define usable floors + caps + the middle-pane reserve', () => {
  assert.equal(SIDEBAR_MIN, 180);
  assert.equal(SIDEBAR_MAX, 400);
  assert.equal(OBSERVER_MIN, 300);
  assert.equal(OBSERVER_MAX, 600);
  assert.equal(PANE_MIN, 320);
  assert.equal(HEALTH_WIDTH, 320);
});

test('clampSidebarWidth applies the [min,max] band on a wide window', () => {
  const ctx = { windowWidth: 1400, healthCollapsed: true };
  assert.equal(clampSidebarWidth(10, 380, ctx), SIDEBAR_MIN, 'floors to SIDEBAR_MIN');
  assert.equal(clampSidebarWidth(9999, 380, ctx), SIDEBAR_MAX, 'caps at SIDEBAR_MAX');
  assert.equal(clampSidebarWidth(250, 380, ctx), 250, 'passes through in-range values');
});

test('clampSidebarWidth caps a wide drag so the middle pane keeps its floor', () => {
  // 900px window (the Electron floor), observer already valid at 380. Dragging
  // the sidebar all the way to its 400 cap would crush the middle; the clamp
  // must stop it at the point the middle pane reserve (PANE_MIN) is preserved.
  const ctx = { windowWidth: 900, healthCollapsed: true };
  const sb = clampSidebarWidth(400, 380, ctx);
  assert.equal(sb, 200, 'sidebar capped at 200, not 400');
  assert.ok(middle(900, sb, 380) >= PANE_MIN, 'middle pane >= PANE_MIN after sidebar drag');
});

test('clampObserverWidth is symmetric — caps a wide drag to protect the middle', () => {
  const ctx = { windowWidth: 900, healthCollapsed: true };
  const ob = clampObserverWidth(600, 220, ctx);
  assert.equal(ob, 360, 'observer capped at 360, not 600');
  assert.ok(middle(900, 220, ob) >= PANE_MIN, 'middle pane >= PANE_MIN after observer drag');
});

test('clampLayoutWidths is a no-op when the window has room for everything', () => {
  const r = clampLayoutWidths({ sidebar: 220, observer: 380 }, { windowWidth: 1400, healthCollapsed: true });
  assert.deepEqual(r, { sidebar: 220, observer: 380 });
  assert.ok(middle(1400, r.sidebar, r.observer) >= PANE_MIN);
});

test('clampLayoutWidths trims a stale both-max pair on load so the middle never collapses', () => {
  // Persisted 400/600 (saved on a big window) loaded at the 900px floor: the
  // pair must be trimmed so the middle pane keeps PANE_MIN.
  const r = clampLayoutWidths({ sidebar: 400, observer: 600 }, { windowWidth: 900, healthCollapsed: true });
  assert.ok(r.sidebar >= SIDEBAR_MIN && r.sidebar <= SIDEBAR_MAX, 'sidebar stays in band');
  assert.ok(r.observer >= OBSERVER_MIN && r.observer <= OBSERVER_MAX, 'observer stays in band');
  assert.equal(middle(900, r.sidebar, r.observer), PANE_MIN, 'middle pane exactly at the floor');
  assert.equal(r.sidebar + r.observer, 580, 'pair sums to the shared space (900 - 320)');
});

test('clampLayoutWidths accounts for the expanded health panel', () => {
  // Health expanded reserves HEALTH_WIDTH too, so the shared space shrinks and
  // the pair is trimmed harder — but the middle pane still keeps its floor.
  const r = clampLayoutWidths({ sidebar: 220, observer: 380 }, { windowWidth: 1200, healthCollapsed: false });
  assert.ok(middle(1200, r.sidebar, r.observer, false) >= PANE_MIN, 'middle >= PANE_MIN with health open');
  assert.ok(r.sidebar + r.observer <= 1200 - PANE_MIN - HEALTH_WIDTH, 'pair fits the health-aware shared space');
});

test('clampLayoutWidths preserves the floors at the 900px window with health collapsed', () => {
  // The degenerate-but-reachable minimum: both panels at their defaults on the
  // 900px floor. Neither should fall below its usable floor; the middle keeps
  // its reserve. (180 + 300 + 320 = 800 fits in 900.)
  const r = clampLayoutWidths({ sidebar: 220, observer: 380 }, { windowWidth: 900, healthCollapsed: true });
  assert.ok(r.sidebar >= SIDEBAR_MIN, 'sidebar >= SIDEBAR_MIN');
  assert.ok(r.observer >= OBSERVER_MIN, 'observer >= OBSERVER_MIN');
  assert.ok(middle(900, r.sidebar, r.observer) >= PANE_MIN, 'middle pane >= PANE_MIN');
});

// --- Key-version migration guard (WARDEN-181) --------------------------------
// readVersioned promotes the newest surviving payload forward to the current key
// so a future KEY bump (v2 -> v3 ...) never silently drops the user's data. Each
// test asserts the actual state change — data physically moves to the current
// key and the old key is cleared — not merely that load returned a value.
console.log('\nreadVersioned key-migration guard promotes old payloads forward');

test('UI data under an older versioned key (v1) is promoted forward to v2 on load', () => {
  reset();
  // Only the older key exists; the current key (v2) is absent.
  mem.set('warden:ui:v1', JSON.stringify({ activeTabs: ['chat-a'], theme: 'dark', density: 'compact' }));
  const ui = loadUi();
  // The data survived the (simulated) version bump and was read correctly.
  assert.deepEqual(ui.activeTabs, ['chat-a']);
  assert.equal(ui.theme, 'dark');
  assert.equal(ui.density, 'compact');
  // The payload physically migrated forward: v2 now holds it, v1 is cleared.
  assert.ok(mem.has('warden:ui:v2'), 'payload promoted to the current key');
  assert.ok(!mem.has('warden:ui:v1'), 'old key removed after promotion');
});

test('UI data under the current key (v2) is read as-is and triggers no migration', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['keep'], theme: 'light' }));
  const ui = loadUi();
  assert.deepEqual(ui.activeTabs, ['keep']);
  assert.equal(ui.theme, 'light');
  // No older key existed, so none was touched.
  assert.ok(!mem.has('warden:ui:v1'), 'no spurious older key created');
});

test('UI data under a legacy unversioned key (warden:ui) is promoted to v2', () => {
  reset();
  // Pre-versioning shape: the bare prefix key, no :vN suffix.
  mem.set('warden:ui', JSON.stringify({ activeTabs: ['legacy'], terminalFontSize: 18 }));
  const ui = loadUi();
  assert.deepEqual(ui.activeTabs, ['legacy']);
  assert.equal(ui.terminalFontSize, 18);
  assert.ok(mem.has('warden:ui:v2'), 'legacy payload promoted to the current key');
  assert.ok(!mem.has('warden:ui'), 'legacy unversioned key removed after promotion');
});

test('UI migration prefers the newest surviving version (v2 beats v1)', () => {
  reset();
  // Both keys present (e.g. a partial bump left an old copy behind). The current
  // version wins and the older copy is left untouched (it was never read).
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['newer'] }));
  mem.set('warden:ui:v1', JSON.stringify({ activeTabs: ['older'] }));
  const ui = loadUi();
  assert.deepEqual(ui.activeTabs, ['newer']);
  assert.ok(mem.has('warden:ui:v1'), 'unread older key is not disturbed');
});

test('corrupt UI JSON falls back to defaults instead of throwing (WARDEN-89)', () => {
  reset();
  mem.set('warden:ui:v2', '{not valid json');
  const ui = loadUi();
  assert.deepEqual(ui.activeTabs, []);
  assert.equal(ui.theme, 'system', 'falls back to the default theme');
});

test('observer data under a legacy unversioned key (warden:observer) promotes to v1', () => {
  reset();
  mem.set('warden:observer', JSON.stringify({ openIds: ['obs-1', 'obs-2'], activeId: 'obs-2' }));
  const obs = loadObs();
  assert.deepEqual(obs.openIds, ['obs-1', 'obs-2']);
  assert.equal(obs.activeId, 'obs-2');
  assert.ok(mem.has('warden:observer:v1'), 'observer payload promoted to the current key');
  assert.ok(!mem.has('warden:observer'), 'legacy observer key removed after promotion');
});

test('observer round-trips under the current key without disturbing older keys', () => {
  reset();
  saveObs({ openIds: ['s1'], activeId: 's1' });
  assert.deepEqual(loadObs().openIds, ['s1']);
  assert.ok(!mem.has('warden:observer'), 'no legacy key created on a normal save/load');
});

console.log('\ndefaultSplitShell (the ＋ split shell) round-trips through loadUi/saveUi — WARDEN-223');
test('defaults to "" (auto-detect host login shell) when nothing is stored', () => {
  reset();
  assert.equal(loadUi().defaultSplitShell, '');
});
test('a set shell (e.g. zsh) round-trips', () => {
  reset();
  saveUi({ ...loadUi(), defaultSplitShell: 'zsh' });
  assert.equal(loadUi().defaultSplitShell, 'zsh');
});
test('a blank value round-trips (the meaningful "auto-detect" value)', () => {
  reset();
  saveUi({ ...loadUi(), defaultSplitShell: '' });
  assert.equal(loadUi().defaultSplitShell, '');
});
test('whitespace is trimmed on load so it can never become the spawned shell name', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], defaultSplitShell: '  zsh  ' }));
  assert.equal(loadUi().defaultSplitShell, 'zsh');
  // All-whitespace collapses to the blank "auto-detect" value.
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], defaultSplitShell: '   ' }));
  assert.equal(loadUi().defaultSplitShell, '');
});
test('a non-string coerces back to "" (defensive)', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], defaultSplitShell: 42 }));
  assert.equal(loadUi().defaultSplitShell, '');
});
test('a missing field loads as ""', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'] }));
  assert.equal(loadUi().defaultSplitShell, '');
});
test('the pref survives an empty-mode mount (carried by the live spread, not the frozen workspace)', () => {
  // defaultSplitShell is NOT a workspace field, so persistUiState spreads it from
  // `live`. Confirm an empty-launch still round-trips a freshly set value.
  reset();
  const d0 = loadUi();
  saveUi(persistUiState({ ...d0, defaultSplitShell: 'pwsh' }, 'empty', d0, true));
  assert.equal(loadUi().defaultSplitShell, 'pwsh');
});

console.log('\ndefaultNewChatCwdByHost (per-host cwd overrides) round-trips through loadUi/saveUi — WARDEN-336');
test('defaults to {} when nothing is stored', () => {
  reset();
  assert.deepEqual(loadUi().defaultNewChatCwdByHost, {});
});
test('a valid host→cwd map round-trips', () => {
  reset();
  saveUi({ ...loadUi(), defaultNewChatCwdByHost: { 'prod-box': '/srv/app', '(local)': '~/projects/warden' } });
  assert.deepEqual(loadUi().defaultNewChatCwdByHost, { 'prod-box': '/srv/app', '(local)': '~/projects/warden' });
});
test('an empty map round-trips as {} (clearing all overrides persists nothing)', () => {
  reset();
  saveUi({ ...loadUi(), defaultNewChatCwdByHost: {} });
  assert.deepEqual(loadUi().defaultNewChatCwdByHost, {});
});
test('a non-object coerces to {} (defensive, no throw)', () => {
  reset();
  // A string is not a plain map → {}.
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], defaultNewChatCwdByHost: 'bogus' }));
  assert.deepEqual(loadUi().defaultNewChatCwdByHost, {});
  // An array is an object but NOT a plain map → {}.
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], defaultNewChatCwdByHost: [['prod-box', '/srv/app']] }));
  assert.deepEqual(loadUi().defaultNewChatCwdByHost, {});
  // A number → {}.
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], defaultNewChatCwdByHost: 42 }));
  assert.deepEqual(loadUi().defaultNewChatCwdByHost, {});
});
test('entries with non-string values are dropped (never seed the spawn field with a non-path)', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], defaultNewChatCwdByHost: { 'prod-box': '/srv/app', 'num': 42, 'obj': { x: 1 }, 'arr': [1] } }));
  assert.deepEqual(loadUi().defaultNewChatCwdByHost, { 'prod-box': '/srv/app' });
});
test('entries with empty/whitespace values are dropped (empty override = use the global default, never persists as a blank)', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], defaultNewChatCwdByHost: { 'prod-box': '/srv/app', 'blank': '', 'ws': '   ', 'tab': '\t' } }));
  assert.deepEqual(loadUi().defaultNewChatCwdByHost, { 'prod-box': '/srv/app' });
});
test('entries with an empty-string key are dropped', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], defaultNewChatCwdByHost: { '': '/srv/app', 'prod-box': '/srv/app' } }));
  assert.deepEqual(loadUi().defaultNewChatCwdByHost, { 'prod-box': '/srv/app' });
});
test('values are trimmed on load (matching defaultNewChatCwd)', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], defaultNewChatCwdByHost: { 'prod-box': '  /srv/app  ' } }));
  assert.deepEqual(loadUi().defaultNewChatCwdByHost, { 'prod-box': '/srv/app' });
});
test('a missing field loads as {}', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'] }));
  assert.deepEqual(loadUi().defaultNewChatCwdByHost, {});
});
test('the map survives an empty-mode mount (carried by the live spread, not the frozen workspace)', () => {
  // defaultNewChatCwdByHost is NOT a workspace field, so persistUiState spreads it
  // from `live`. Confirm an empty-launch still round-trips a freshly set map.
  reset();
  const d0 = loadUi();
  saveUi(persistUiState({ ...d0, defaultNewChatCwdByHost: { 'prod-box': '/srv/app' } }, 'empty', d0, true));
  assert.deepEqual(loadUi().defaultNewChatCwdByHost, { 'prod-box': '/srv/app' });
});

// --- Multi-workspace model (WARDEN-256) ---------------------------------------
// workspaces[] + activeWorkspaceId replace the flat openPanes/focused. activeTabs/
// hiddenTabs stay flat (the sidebar's global working set); paneHost stays global.
console.log('\nworkspaces round-trip through loadUi/saveUi');
test('defaults to exactly one empty workspace (the active one) when nothing is stored', () => {
  reset();
  const ui = loadUi();
  assert.ok(Array.isArray(ui.workspaces), 'workspaces is an array');
  assert.equal(ui.workspaces.length, 1, 'exactly one default workspace');
  assert.deepEqual(ui.workspaces[0].openPanes, [], 'default workspace has no panes');
  assert.equal(ui.workspaces[0].focused, null, 'default workspace has no focus');
  assert.equal(typeof ui.workspaces[0].id, 'string', 'workspace has a stable id');
  assert.equal(ui.activeWorkspaceId, ui.workspaces[0].id, 'the default workspace is active');
});
test('multiple workspaces + activeWorkspaceId round-trip', () => {
  reset();
  const ws = [
    { id: 'w1', name: 'Project A', openPanes: ['a', 'b'], focused: 'a' },
    { id: 'w2', name: 'Project B', openPanes: ['c'], focused: 'c' },
  ];
  saveUi({ ...loadUi(), workspaces: ws, activeWorkspaceId: 'w2' });
  const ui = loadUi();
  assert.deepEqual(ui.workspaces, ws, 'both workspaces round-trip intact');
  assert.equal(ui.activeWorkspaceId, 'w2', 'activeWorkspaceId round-trips');
});
test('activeTabs/hiddenTabs stay flat and round-trip alongside workspaces', () => {
  reset();
  saveUi({ ...loadUi(), activeTabs: ['x', 'y'], hiddenTabs: ['z'], workspaces: [{ id: 'w1', name: 'Workspace 1', openPanes: ['x'], focused: 'x' }] });
  const ui = loadUi();
  assert.deepEqual(ui.activeTabs, ['x', 'y'], 'flat activeTabs preserved');
  assert.deepEqual(ui.hiddenTabs, ['z'], 'flat hiddenTabs preserved');
});
test('an activeWorkspaceId pointing at a missing workspace falls back to the first', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], workspaces: [{ id: 'w1', name: 'Workspace 1', openPanes: ['x'], focused: 'x' }, { id: 'w2', name: 'Workspace 2', openPanes: [], focused: null }], activeWorkspaceId: 'ghost' }));
  const ui = loadUi();
  assert.equal(ui.activeWorkspaceId, 'w1', 'dangling activeWorkspaceId coerces to the first workspace');
});
test('a non-array workspaces coerces to the default single workspace (defensive, no throw)', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], workspaces: 'bogus' }));
  const ui = loadUi();
  assert.equal(ui.workspaces.length, 1, 'non-array workspaces → one default workspace');
  assert.deepEqual(ui.workspaces[0].openPanes, []);
});
test('an empty workspaces array coerces to the default single workspace (never zero workspaces)', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], workspaces: [] }));
  const ui = loadUi();
  assert.equal(ui.workspaces.length, 1, 'never leave loadUi with zero workspaces');
  assert.deepEqual(ui.workspaces[0].openPanes, []);
});
test('a workspace missing a name falls back to the default name', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], workspaces: [{ id: 'w1', openPanes: ['x'], focused: 'x' }] }));
  const ui = loadUi();
  assert.equal(ui.workspaces[0].name, 'Workspace 1', 'missing name → default name');
});
test('duplicate workspace ids are de-duplicated (first wins) so lookup-by-id is unambiguous', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], workspaces: [{ id: 'dup', name: 'First', openPanes: ['x'], focused: 'x' }, { id: 'dup', name: 'Second', openPanes: ['y'], focused: 'y' }] }));
  const ui = loadUi();
  assert.equal(ui.workspaces.length, 2, 'both entries survive');
  const ids = ui.workspaces.map((w) => w.id);
  assert.equal(new Set(ids).size, 2, 'ids are now unique');
  assert.equal(ui.workspaces[0].name, 'First', 'first occurrence keeps its id/name');
});
test('workspaces survive an empty-mode mount (carried forward by persistUiState, not the live spread)', () => {
  reset();
  // 1) Save a real workspace (previous mode) so the on-disk snapshot holds it.
  const d0 = loadUi();
  saveUi(persistUiState({ ...d0, workspaces: [{ id: 'w1', name: 'Workspace 1', openPanes: ['a'], focused: 'a' }], activeWorkspaceId: 'w1' }, 'previous', d0, false));
  // 2) Empty mount: disk now has w1; the live state is the empty default workspace.
  //    persistUiState must carry disk.workspaces forward, NOT the empty live one.
  const d1 = loadUi();
  assert.deepEqual(d1.workspaces, [{ id: 'w1', name: 'Workspace 1', openPanes: ['a'], focused: 'a' }], 'disk has the saved workspace');
  const emptyWs = initialWorkspace(d1, 'empty');
  saveUi(persistUiState({ ...d1, workspaces: emptyWs.workspaces, activeWorkspaceId: emptyWs.activeWorkspaceId }, 'empty', d1, true));
  // 3) The saved workspace survives the empty mount.
  const after = loadUi();
  assert.deepEqual(after.workspaces, [{ id: 'w1', name: 'Workspace 1', openPanes: ['a'], focused: 'a' }], 'workspaces frozen on disk across an empty mount');
  assert.equal(after.activeWorkspaceId, 'w1', 'activeWorkspaceId frozen across an empty mount');
});

console.log('\nlegacy single-workspace migration: flat openPanes/focused → one workspace (no pane lost)');
test('a legacy flat payload (no workspaces) migrates into one workspace preserving openPanes + focused', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['a', 'b'], openPanes: ['a'], focused: 'a' }));
  const ui = loadUi();
  assert.equal(ui.workspaces.length, 1, 'legacy flat state → exactly one workspace');
  assert.deepEqual(ui.workspaces[0].openPanes, ['a'], 'legacy openPanes migrated, no pane lost');
  assert.equal(ui.workspaces[0].focused, 'a', 'legacy focused migrated');
  assert.equal(ui.activeWorkspaceId, ui.workspaces[0].id, 'the migrated workspace is active');
  assert.deepEqual(ui.activeTabs, ['a', 'b'], 'flat activeTabs untouched');
});
test('a legacy payload with no open panes migrates to one empty workspace', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['a'], openPanes: [], focused: null }));
  const ui = loadUi();
  assert.equal(ui.workspaces.length, 1);
  assert.deepEqual(ui.workspaces[0].openPanes, []);
  assert.equal(ui.workspaces[0].focused, null);
});
test('a legacy payload with object-style openPanes entries still migrates', () => {
  // Older shapes stored tab objects; the legacy migration normalizes them to ids.
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: [{ id: 'a' }, { id: 'b' }], openPanes: [{ id: 'a' }], focused: 'a' }));
  const ui = loadUi();
  assert.deepEqual(ui.workspaces[0].openPanes, ['a'], 'object openPanes normalized to ids during migration');
});

console.log(`\n✓ STORAGE TESTS PASS (${passed})`);
