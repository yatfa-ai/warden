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
// storage.ts imports normalizeThemePref from @/lib/themes (the WARDEN-255 theme
// migration), so we transpile BOTH modules into the same tmp dir and rewrite
// the bare `@/lib/themes` specifier to a relative path Node can resolve.
const themesPath = resolve(__dirname, 'src/lib/themes.ts');
const storageSrc = readFileSync(storagePath, 'utf8');
const themesSrc = readFileSync(themesPath, 'utf8');
const { code: storageCode } = await transformWithOxc(storageSrc, storagePath, {});
const { code: themesCode } = await transformWithOxc(themesSrc, themesPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-storage-test-'));
writeFileSync(join(tmpDir, 'themes.mjs'), themesCode);
const tmpFile = join(tmpDir, 'storage.mjs');
writeFileSync(tmpFile, storageCode.replaceAll('@/lib/themes', './themes.mjs'));
const { loadUi, saveUi, loadObs, saveObs, persistUiState, initialWorkspace, mergeRecentlyClosed, RECENTLY_CLOSED_CAP, validatePresetName, isReservedPresetName, PRESET_NAME_MAX, validateSnippetName, SNIPPET_NAME_MAX, SNIPPET_TEXT_MAX, SNIPPET_MAX_COUNT, STARTER_SNIPPETS, clampSidebarWidth, clampObserverWidth, clampLayoutWidths, SIDEBAR_MIN, SIDEBAR_MAX, OBSERVER_MIN, OBSERVER_MAX, PANE_MIN, HEALTH_WIDTH, resetUiPrefsPreservingWorkspace } = await import(tmpFile);
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
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], restoreOnStartup: 'bogus' }));
  assert.equal(loadUi().restoreOnStartup, 'previous');
});
test('a missing field loads as "previous"', () => {
  reset();
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'] }));
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
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], defaultNewChatPreset: 'bogus', defaultNewChatHost: 'prod-box' }));
  const ui = loadUi();
  assert.equal(ui.defaultNewChatPreset, 'claude');
  assert.equal(ui.defaultNewChatHost, 'prod-box', 'host is unaffected by preset coercion');
});
test('a non-string host coerces back to "(local)" on load (defensive)', () => {
  reset();
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], defaultNewChatHost: 42 }));
  assert.equal(loadUi().defaultNewChatHost, '(local)');
});
test('missing fields load as the defaults', () => {
  reset();
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'] }));
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
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], customPresets: 'bogus' }));
  assert.deepEqual(loadUi().customPresets, []);
});
test('entries missing name or cmd are dropped (never blank the spawn command)', () => {
  reset();
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], customPresets: [{ name: 'ok', cmd: 'ok' }, { name: 'nocmd' }, { cmd: 'noname' }, {}] }));
  assert.deepEqual(loadUi().customPresets, [{ name: 'ok', cmd: 'ok' }]);
});
test('reserved built-in names (claude/shell) are rejected as custom presets', () => {
  reset();
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], customPresets: [{ name: 'claude', cmd: 'whatever' }, { name: 'shell', cmd: 'bash' }, { name: 'codex', cmd: 'codex' }] }));
  assert.deepEqual(loadUi().customPresets, [{ name: 'codex', cmd: 'codex' }]);
});
test('reserved built-in names are rejected CASE-INSENSITIVELY (no "Claude"/"Shell" near-collision)', () => {
  reset();
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], customPresets: [{ name: 'Claude', cmd: 'whatever' }, { name: 'SHELL', cmd: 'bash' }, { name: 'ShElL', cmd: 'zsh' }, { name: 'codex', cmd: 'codex' }] }));
  // Every case variant of a built-in is dropped, matching the case-insensitive dedup.
  assert.deepEqual(loadUi().customPresets, [{ name: 'codex', cmd: 'codex' }]);
});
test('the name length cap is exactly PRESET_NAME_MAX (boundary: N ok, N+1 dropped)', () => {
  reset();
  const exact = 'x'.repeat(PRESET_NAME_MAX);
  const tooLong = 'x'.repeat(PRESET_NAME_MAX + 1);
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], customPresets: [{ name: exact, cmd: 'a' }, { name: tooLong, cmd: 'b' }] }));
  assert.deepEqual(loadUi().customPresets, [{ name: exact, cmd: 'a' }]);
});
test('duplicate names are de-duplicated (case-insensitive, first wins)', () => {
  reset();
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], customPresets: [{ name: 'Codex', cmd: 'codex' }, { name: 'codex', cmd: 'codex2' }] }));
  assert.deepEqual(loadUi().customPresets, [{ name: 'Codex', cmd: 'codex' }]);
});
test('names over 32 chars are dropped', () => {
  reset();
  const long = 'x'.repeat(33);
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], customPresets: [{ name: long, cmd: 'cmd' }, { name: 'ok', cmd: 'ok' }] }));
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
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], customPresets: [], defaultNewChatPreset: 'codex' }));
  // codex is not in the (empty) custom list → must not dangle
  assert.equal(loadUi().defaultNewChatPreset, 'claude');
});
test('built-in claude/shell defaults remain valid', () => {
  reset();
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], defaultNewChatPreset: 'shell' }));
  assert.equal(loadUi().defaultNewChatPreset, 'shell');
});
test('a stored non-string preset coerces back to claude (defensive)', () => {
  reset();
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], defaultNewChatPreset: 42 }));
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
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], paneLayout: 'diagonal' }));
  assert.equal(loadUi().paneLayout, 'auto');
});
test('a missing field loads as "auto"', () => {
  reset();
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'] }));
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
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], terminalColorScheme: 'bogus' }));
  assert.equal(loadUi().terminalColorScheme, 'auto');
});
test('a missing field loads as "auto"', () => {
  reset();
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'] }));
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
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], terminalCursorStyle: 'diagonal' }));
  assert.equal(loadUi().terminalCursorStyle, 'blink-block');
});
test('a missing field loads as "blink-block"', () => {
  reset();
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'] }));
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
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'] }));
  assert.equal(loadUi().copyOnSelect, false);
});
test('a non-boolean coerces back to false on load (defensive)', () => {
  // copyOnSelect === true is the only gate, so a truthy-but-not-true value
  // (1, "true", {}) must NOT enable it. This is the conservative default.
  reset();
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], copyOnSelect: 1 }));
  assert.equal(loadUi().copyOnSelect, false);
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], copyOnSelect: 'true' }));
  assert.equal(loadUi().copyOnSelect, false);
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], copyOnSelect: {} }));
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
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], onExitBehavior: 'destroy' }));
  assert.equal(loadUi().onExitBehavior, 'keep');
});
test('a non-string value coerces back to "keep" on load (defensive)', () => {
  reset();
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], onExitBehavior: 42 }));
  assert.equal(loadUi().onExitBehavior, 'keep');
});
test('a missing field loads as "keep"', () => {
  reset();
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'] }));
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
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], autoFocusNewPane: 42 }));
  assert.equal(loadUi().autoFocusNewPane, true);
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], autoFocusNewPane: 'false' }));
  assert.equal(loadUi().autoFocusNewPane, true, 'the string "false" is not the boolean false');
});
test('a missing field loads as true', () => {
  reset();
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'] }));
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
  const disk = { ...loadUi(), workspaces: [{ id: 'w1', name: 'Workspace 1', openPanes: ['a'], focused: 'a', recentlyClosed: [] }], activeWorkspaceId: 'w1', paneHost: { a: 'host' } };
  const ws = initialWorkspace(disk, 'previous');
  assert.deepEqual(ws.workspaces, [{ id: 'w1', name: 'Workspace 1', openPanes: ['a'], focused: 'a', recentlyClosed: [] }]);
  assert.equal(ws.activeWorkspaceId, 'w1');
  assert.deepEqual(ws.paneHost, { a: 'host' });
});
test('"empty" yields a clean slate: one empty workspace, no panes, no hosts', () => {
  const disk = { ...loadUi(), workspaces: [{ id: 'w1', name: 'Workspace 1', openPanes: ['a'], focused: 'a', recentlyClosed: [] }], activeWorkspaceId: 'w1', paneHost: { a: 'host' } };
  const ws = initialWorkspace(disk, 'empty');
  assert.equal(ws.workspaces.length, 1, 'exactly one workspace on a clean slate');
  assert.deepEqual(ws.workspaces[0].openPanes, [], 'empty workspace has no panes');
  assert.equal(ws.workspaces[0].focused, null, 'empty workspace has no focus');
  assert.deepEqual(ws.workspaces[0].recentlyClosed, [], 'empty workspace has no recently-closed');
  assert.equal(ws.activeWorkspaceId, ws.workspaces[0].id, 'the empty workspace is active');
  assert.deepEqual(ws.paneHost, {});
});

console.log('\npersistence-conflict pitfall: an "empty" session must not wipe the saved workspace');
test('empty mount persists empty live workspace WITHOUT destroying the saved workspace', () => {
  reset();
  // 1) Last session (previous mode, startedEmpty=false) saved a real workspace.
  const d0 = loadUi();
  saveUi(persistUiState({ ...d0, workspaces: [{ id: 'w1', name: 'Workspace 1', openPanes: ['chat-1'], focused: 'chat-1', recentlyClosed: [] }], activeWorkspaceId: 'w1', paneHost: { 'chat-1': 'host-a' } }, 'previous', d0, false));

  // 2) A fresh launch in 'empty' mode: startedEmpty=true seeds an empty live
  //    workspace (initialWorkspace('empty')), and the saveUi effect fires on
  //    mount with that empty workspace — the exact situation that used to wipe it.
  const d1 = loadUi();
  const emptyWs = initialWorkspace(d1, 'empty');
  saveUi(persistUiState({ ...d1, workspaces: emptyWs.workspaces, activeWorkspaceId: emptyWs.activeWorkspaceId, paneHost: {} }, 'empty', d1, true));

  // 3) The persisted workspace must STILL be intact.
  const after = loadUi();
  assert.equal(after.restoreOnStartup, 'empty');
  assert.deepEqual(after.workspaces, [{ id: 'w1', name: 'Workspace 1', openPanes: ['chat-1'], focused: 'chat-1', recentlyClosed: [] }], 'workspaces survived the empty mount');
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
  saveUi(persistUiState({ ...d0, workspaces: [{ id: 'w1', name: 'Workspace 1', openPanes: ['A'], focused: 'A', recentlyClosed: [] }], activeWorkspaceId: 'w1', paneHost: { A: 'host-a' } }, 'previous', d0, false));

  // Empty launch, then flip back to 'previous' mid-session (live workspace still empty).
  const d1 = loadUi();
  const emptyWs = initialWorkspace(d1, 'empty');
  saveUi(persistUiState({ ...d1, workspaces: emptyWs.workspaces, activeWorkspaceId: emptyWs.activeWorkspaceId, paneHost: {} }, 'previous', d1, true));

  // The saved workspace survives the flip.
  const after = loadUi();
  assert.equal(after.restoreOnStartup, 'previous', 'pref persisted as previous');
  assert.deepEqual(after.workspaces, [{ id: 'w1', name: 'Workspace 1', openPanes: ['A'], focused: 'A', recentlyClosed: [] }], 'flip empty->previous preserved workspaces');
  assert.equal(after.activeWorkspaceId, 'w1', 'flip empty->previous preserved activeWorkspaceId');
  assert.deepEqual(after.paneHost, { A: 'host-a' }, 'flip empty->previous preserved paneHost');
});
test('a previous-started session flipping to empty then back preserves the workspace too', () => {
  // startedEmpty=false the whole time: flipping previous -> empty -> previous.
  // While pref is 'empty' the workspace is frozen on disk; flipping back writes
  // the (still-present) live workspace legitimately. No loss in any direction.
  reset();
  const d0 = loadUi();
  const ws = [{ id: 'w1', name: 'Workspace 1', openPanes: ['X'], focused: 'X', recentlyClosed: [] }];
  saveUi(persistUiState({ ...d0, workspaces: ws, activeWorkspaceId: 'w1' }, 'previous', d0, false));
  // previous -> empty (mid-session, startedEmpty=false): freeze on disk.
  const d1 = loadUi();
  saveUi(persistUiState({ ...d1, workspaces: ws, activeWorkspaceId: 'w1' }, 'empty', d1, false));
  assert.deepEqual(loadUi().workspaces, ws, 'workspace frozen while pref is empty');
  // empty -> previous (still startedEmpty=false): live workspace is legitimate again.
  const d2 = loadUi();
  saveUi(persistUiState({ ...d2, workspaces: ws, activeWorkspaceId: 'w1' }, 'previous', d2, false));
  assert.deepEqual(loadUi().workspaces, ws, 'workspace intact after flipping back');
});
test('sanity: naively persisting the live empty workspace WOULD wipe it (guard against regression)', () => {
  // If persistUiState ever stopped protecting the workspace in 'empty' mode and
  // just spread the live arrays, the saved workspace would be destroyed. This
  // encodes the dangerous behavior we explicitly do NOT do, to document the risk.
  reset();
  saveUi({ ...loadUi(), workspaces: [{ id: 'w1', name: 'Workspace 1', openPanes: ['chat-1'], focused: 'chat-1', recentlyClosed: [] }] });
  assert.deepEqual(loadUi().workspaces[0].openPanes, ['chat-1']);
  // The naive (wrong) write the fix replaces:
  const blanked = initialWorkspace(loadUi(), 'empty');
  saveUi({ ...loadUi(), workspaces: blanked.workspaces });
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

test('UI data under an older versioned key (v1) is promoted forward to v3 on load', () => {
  reset();
  // Only the older key exists; the current key (v3) is absent. theme:'dark' is a
  // legacy mode literal — it survives the KEY migration and is normalized to the
  // GitHub Dark theme id (WARDEN-255) on the same load.
  mem.set('warden:ui:v1', JSON.stringify({ activeTabs: ['chat-a'], theme: 'dark', density: 'compact' }));
  const ui = loadUi();
  // The data survived the (simulated) version bump and was read correctly.
  assert.equal(ui.theme, 'github-dark', 'legacy dark pref migrated to GitHub Dark');
  assert.equal(ui.density, 'compact');
  // The payload physically migrated forward: v3 now holds it, v1 is cleared.
  assert.ok(mem.has('warden:ui:v3'), 'payload promoted to the current key');
  assert.ok(!mem.has('warden:ui:v1'), 'old key removed after promotion');
});

test('UI data under the prior versioned key (v2) is promoted forward to v3 on load (WARDEN-323 bump)', () => {
  // The real upgrade path: an existing install has its data under v2. Bumping
  // KEY_VERSION to 3 must promote that payload forward with NO data loss — the
  // user's workspace + prefs survive — and physically migrate it to v3.
  reset();
  // theme:'dark' is a legacy literal — it survives the v2->v3 promotion AND
  // normalizes to GitHub Dark (WARDEN-255) on load; snippets seed because the v2
  // payload has no snippets field (the starter-set discriminator fires).
  mem.set('warden:ui:v2', JSON.stringify({ workspaces: [{ id: 'w1', name: 'Workspace 1', openPanes: ['chat-a', 'chat-b'], focused: 'chat-a', recentlyClosed: [] }], activeWorkspaceId: 'w1', theme: 'dark', density: 'compact', customPresets: [{ name: 'codex', cmd: 'codex' }] }));
  const ui = loadUi();
  assert.deepEqual(ui.workspaces[0].openPanes, ['chat-a', 'chat-b'], 'workspace openPanes survived the v2->v3 promotion');
  assert.equal(ui.activeWorkspaceId, 'w1', 'activeWorkspaceId survived the promotion');
  assert.equal(ui.theme, 'github-dark', 'legacy dark pref migrated to GitHub Dark across the promotion');
  assert.equal(ui.density, 'compact', 'density survived');
  assert.deepEqual(ui.customPresets, [{ name: 'codex', cmd: 'codex' }], 'customPresets survived');
  assert.deepEqual(ui.snippets, STARTER_SNIPPETS, 'snippets seeded (no field in the v2 payload)');
  assert.ok(mem.has('warden:ui:v3'), 'payload promoted to the current key (v3)');
  assert.ok(!mem.has('warden:ui:v2'), 'prior key (v2) removed after promotion');
});

test('UI data under the current key (v3) is read as-is and triggers no migration', () => {
  reset();
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['keep'], theme: 'light' }));
  const ui = loadUi();
  assert.equal(ui.theme, 'github-light', 'legacy light pref migrated to GitHub Light');
  // No older key existed, so none was touched.
  assert.ok(!mem.has('warden:ui:v1'), 'no spurious older key created');
});

test('UI data under a legacy unversioned key (warden:ui) is promoted to v3', () => {
  reset();
  // Pre-versioning shape: the bare prefix key, no :vN suffix.
  mem.set('warden:ui', JSON.stringify({ activeTabs: ['legacy'], terminalFontSize: 18 }));
  const ui = loadUi();
  assert.equal(ui.terminalFontSize, 18);
  assert.ok(mem.has('warden:ui:v3'), 'legacy payload promoted to the current key');
  assert.ok(!mem.has('warden:ui'), 'legacy unversioned key removed after promotion');
});

test('UI migration prefers the newest surviving version (v3 beats v1)', () => {
  reset();
  // Both keys present (e.g. a partial bump left an old copy behind). The current
  // version wins and the older copy is left untouched (it was never read).
  // density distinguishes the two payloads so the assertion proves WHICH one loaded.
  mem.set('warden:ui:v3', JSON.stringify({ density: 'compact' }));
  mem.set('warden:ui:v1', JSON.stringify({ density: 'comfortable', terminalScrollback: 9999 }));
  const ui = loadUi();
  assert.equal(ui.density, 'compact', 'the newer v3 payload won');
  assert.ok(mem.has('warden:ui:v1'), 'unread older key is not disturbed');
});

test('corrupt UI JSON falls back to defaults instead of throwing (WARDEN-89)', () => {
  reset();
  mem.set('warden:ui:v3', '{not valid json');
  const ui = loadUi();
  assert.equal(ui.workspaces.length, 1, 'falls back to one default workspace');
  assert.deepEqual(ui.workspaces[0].openPanes, [], 'default workspace is empty');
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
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], defaultSplitShell: '  zsh  ' }));
  assert.equal(loadUi().defaultSplitShell, 'zsh');
  // All-whitespace collapses to the blank "auto-detect" value.
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], defaultSplitShell: '   ' }));
  assert.equal(loadUi().defaultSplitShell, '');
});
test('a non-string coerces back to "" (defensive)', () => {
  reset();
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], defaultSplitShell: 42 }));
  assert.equal(loadUi().defaultSplitShell, '');
});
test('a missing field loads as ""', () => {
  reset();
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'] }));
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
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], defaultNewChatCwdByHost: 'bogus' }));
  assert.deepEqual(loadUi().defaultNewChatCwdByHost, {});
  // An array is an object but NOT a plain map → {}.
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], defaultNewChatCwdByHost: [['prod-box', '/srv/app']] }));
  assert.deepEqual(loadUi().defaultNewChatCwdByHost, {});
  // A number → {}.
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], defaultNewChatCwdByHost: 42 }));
  assert.deepEqual(loadUi().defaultNewChatCwdByHost, {});
});
test('entries with non-string values are dropped (never seed the spawn field with a non-path)', () => {
  reset();
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], defaultNewChatCwdByHost: { 'prod-box': '/srv/app', 'num': 42, 'obj': { x: 1 }, 'arr': [1] } }));
  assert.deepEqual(loadUi().defaultNewChatCwdByHost, { 'prod-box': '/srv/app' });
});
test('entries with empty/whitespace values are dropped (empty override = use the global default, never persists as a blank)', () => {
  reset();
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], defaultNewChatCwdByHost: { 'prod-box': '/srv/app', 'blank': '', 'ws': '   ', 'tab': '\t' } }));
  assert.deepEqual(loadUi().defaultNewChatCwdByHost, { 'prod-box': '/srv/app' });
});
test('entries with an empty-string key are dropped', () => {
  reset();
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], defaultNewChatCwdByHost: { '': '/srv/app', 'prod-box': '/srv/app' } }));
  assert.deepEqual(loadUi().defaultNewChatCwdByHost, { 'prod-box': '/srv/app' });
});
test('values are trimmed on load (matching defaultNewChatCwd)', () => {
  reset();
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], defaultNewChatCwdByHost: { 'prod-box': '  /srv/app  ' } }));
  assert.deepEqual(loadUi().defaultNewChatCwdByHost, { 'prod-box': '/srv/app' });
});
test('a missing field loads as {}', () => {
  reset();
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'] }));
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
    { id: 'w1', name: 'Project A', openPanes: ['a', 'b'], focused: 'a', recentlyClosed: [] },
    { id: 'w2', name: 'Project B', openPanes: ['c'], focused: 'c', recentlyClosed: [] },
  ];
  saveUi({ ...loadUi(), workspaces: ws, activeWorkspaceId: 'w2' });
  const ui = loadUi();
  assert.deepEqual(ui.workspaces, ws, 'both workspaces round-trip intact');
  assert.equal(ui.activeWorkspaceId, 'w2', 'activeWorkspaceId round-trips');
});
test('activeTabs/hiddenTabs are abolished: a legacy payload drops them (one-way, no migration)', () => {
  // WARDEN-372: the tabs model is gone. A payload that still carries flat
  // activeTabs/hiddenTabs loads without them — they are ignored, never stored
  // back out, and workspaces (with recentlyClosed) is the only pane model.
  reset();
  saveUi({ ...loadUi(), activeTabs: ['x', 'y'], hiddenTabs: ['z'], workspaces: [{ id: 'w1', name: 'Workspace 1', openPanes: ['x'], focused: 'x', recentlyClosed: [] }] });
  const ui = loadUi();
  assert.equal('activeTabs' in ui, false, 'activeTabs is not a UiState field');
  assert.equal('hiddenTabs' in ui, false, 'hiddenTabs is not a UiState field');
  assert.deepEqual(ui.workspaces, [{ id: 'w1', name: 'Workspace 1', openPanes: ['x'], focused: 'x', recentlyClosed: [] }], 'workspaces round-trip without the flat tabs');
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
  saveUi(persistUiState({ ...d0, workspaces: [{ id: 'w1', name: 'Workspace 1', openPanes: ['a'], focused: 'a', recentlyClosed: [] }], activeWorkspaceId: 'w1' }, 'previous', d0, false));
  // 2) Empty mount: disk now has w1; the live state is the empty default workspace.
  //    persistUiState must carry disk.workspaces forward, NOT the empty live one.
  const d1 = loadUi();
  assert.deepEqual(d1.workspaces, [{ id: 'w1', name: 'Workspace 1', openPanes: ['a'], focused: 'a', recentlyClosed: [] }], 'disk has the saved workspace');
  const emptyWs = initialWorkspace(d1, 'empty');
  saveUi(persistUiState({ ...d1, workspaces: emptyWs.workspaces, activeWorkspaceId: emptyWs.activeWorkspaceId }, 'empty', d1, true));
  // 3) The saved workspace survives the empty mount.
  const after = loadUi();
  assert.deepEqual(after.workspaces, [{ id: 'w1', name: 'Workspace 1', openPanes: ['a'], focused: 'a', recentlyClosed: [] }], 'workspaces frozen on disk across an empty mount');
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
  assert.equal('activeTabs' in ui, false, 'legacy flat activeTabs is dropped (tabs abolished, WARDEN-372)');
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

console.log('\nrecentlyClosed (per-workspace recovery list) — WARDEN-372');
const rc = (id, over = {}) => ({ id, name: id, host: '(local)', cwd: '', closedAt: Number(id.slice(1)), ...over });
test('defaults to [] on every workspace when nothing is stored', () => {
  reset();
  const ui = loadUi();
  assert.deepEqual(ui.workspaces[0].recentlyClosed, [], 'default workspace has an empty recovery list');
});
test('a workspace missing recentlyClosed coerces to [] on load (default-to-[] migration)', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ workspaces: [{ id: 'w1', name: 'Workspace 1', openPanes: ['a'], focused: 'a' }] }));
  const ui = loadUi();
  assert.deepEqual(ui.workspaces[0].recentlyClosed, [], 'absent recentlyClosed → []');
});
test('recentlyClosed round-trips per-workspace through loadUi/saveUi', () => {
  reset();
  const entry = rc('c1', { name: 'my agent', host: 'prod-box', cwd: '/srv', closedAt: 12345 });
  saveUi({ ...loadUi(), workspaces: [{ id: 'w1', name: 'Workspace 1', openPanes: [], focused: null, recentlyClosed: [entry] }], activeWorkspaceId: 'w1' });
  const ui = loadUi();
  assert.deepEqual(ui.workspaces[0].recentlyClosed, [entry], 'the entry round-trips with all fields');
});
test('parse sanitizes recentlyClosed: drops non-string ids + bad entries, keeps the rest', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ workspaces: [{ id: 'w1', name: 'Workspace 1', openPanes: [], focused: null, recentlyClosed: [rc('good'), { name: 'noid' }, { id: 42 }, null, 'stray', { id: 'good', closedAt: 9 }, { id: 'other', name: 7, host: 1 }] }] }));
  const ui = loadUi();
  const ids = ui.workspaces[0].recentlyClosed.map((e) => e.id);
  // 'good' appears twice → deduped (first wins, closedAt kept); bad ids / non-objects dropped.
  assert.deepEqual(ids, ['good', 'other']);
  assert.equal(ui.workspaces[0].recentlyClosed[1].name, '', 'non-string name coerces to ""');
  assert.equal(ui.workspaces[0].recentlyClosed[1].host, '', 'non-string host coerces to ""');
});
test('parse caps recentlyClosed at RECENTLY_CLOSED_CAP, keeping the newest-first order', () => {
  reset();
  const over = Array.from({ length: RECENTLY_CLOSED_CAP + 5 }, (_, i) => rc(`c${i}`, { closedAt: i }));
  mem.set('warden:ui:v2', JSON.stringify({ workspaces: [{ id: 'w1', name: 'Workspace 1', openPanes: [], focused: null, recentlyClosed: over }] }));
  const ui = loadUi();
  assert.equal(ui.workspaces[0].recentlyClosed.length, RECENTLY_CLOSED_CAP, 'capped at the constant');
});

console.log('\nmergeRecentlyClosed — dedup by id (incoming wins), newest-first, cap');
test('incoming entries land first; duplicates by id drop the older (incoming wins)', () => {
  const merged = mergeRecentlyClosed([rc('a', { closedAt: 1 })], [rc('b'), rc('a', { closedAt: 9 })]);
  assert.deepEqual(merged.map((e) => e.id), ['b', 'a'], 'incoming order first; disk dup dropped');
  assert.equal(merged[1].closedAt, 9, 'incoming dup value wins (re-close moves it to top with new data)');
});
test('a single new entry prepends to the existing list (the pushRecentlyClosed pattern)', () => {
  // App.pushRecentlyClosed calls mergeRecentlyClosed(existingList, [newEntry]) so
  // the just-closed pane is newest-first. This locks that contract.
  const merged = mergeRecentlyClosed([rc('old1'), rc('old2')], [rc('new')]);
  assert.deepEqual(merged.map((e) => e.id), ['new', 'old1', 'old2'], 'newest close lands on top');
});
test('merge caps at RECENTLY_CLOSED_CAP', () => {
  const existing = Array.from({ length: RECENTLY_CLOSED_CAP }, (_, i) => rc(`e${i}`));
  const incoming = Array.from({ length: 5 }, (_, i) => rc(`i${i}`));
  const merged = mergeRecentlyClosed(existing, incoming);
  assert.equal(merged.length, RECENTLY_CLOSED_CAP, 'never exceeds the cap');
  assert.deepEqual(merged.slice(0, 5).map((e) => e.id), ['i0', 'i1', 'i2', 'i3', 'i4'], 'incoming at the top');
});

console.log('\nrecentlyClosed is EXEMPT from the empty-mode freeze (WARDEN-372)');
test('disk recentlyClosed survives an empty-mode mount (not wiped by the freeze)', () => {
  reset();
  const d0 = loadUi();
  saveUi(persistUiState({ ...d0, workspaces: [{ id: 'w1', name: 'Workspace 1', openPanes: [], focused: null, recentlyClosed: [rc('old', { closedAt: 1 })] }], activeWorkspaceId: 'w1', paneHost: {} }, 'previous', d0, false));
  // Empty launch: live state is the empty default workspace, but the disk
  // workspace's recentlyClosed must survive the freeze (it is recovery state,
  // not workspace-restoration state).
  const d1 = loadUi();
  const emptyWs = initialWorkspace(d1, 'empty');
  saveUi(persistUiState({ ...d1, workspaces: emptyWs.workspaces, activeWorkspaceId: emptyWs.activeWorkspaceId, paneHost: {} }, 'empty', d1, true));
  const after = loadUi();
  assert.equal(after.workspaces[0].recentlyClosed.length, 1, 'disk recovery entry survived the empty mount');
  assert.equal(after.workspaces[0].recentlyClosed[0].id, 'old');
});
test('this session\'s close is MERGED into the frozen disk recentlyClosed (live recovery activity persists in empty mode)', () => {
  reset();
  const d0 = loadUi();
  saveUi(persistUiState({ ...d0, workspaces: [{ id: 'w1', name: 'Workspace 1', openPanes: [], focused: null, recentlyClosed: [rc('old', { closedAt: 1 })] }], activeWorkspaceId: 'w1', paneHost: {} }, 'previous', d0, false));
  const d1 = loadUi();
  // Empty launch: the live (fresh-id) workspace accrues a close THIS session.
  const emptyWs = initialWorkspace(d1, 'empty');
  const liveWorkspaces = [{ ...emptyWs.workspaces[0], recentlyClosed: [rc('fresh', { closedAt: 50 })] }];
  saveUi(persistUiState({ ...d1, workspaces: liveWorkspaces, activeWorkspaceId: liveWorkspaces[0].id, paneHost: {} }, 'empty', d1, true));
  const after = loadUi();
  const ids = after.workspaces[0].recentlyClosed.map((e) => e.id);
  assert.ok(ids.includes('old'), 'disk history preserved (not wiped by the fresh live workspace)');
  assert.ok(ids.includes('fresh'), 'this session\'s close merged in (exempt: tracks live, not frozen)');
  assert.equal(after.workspaces[0].openPanes.length, 0, 'the pane grid is STILL frozen to disk (only recentlyClosed is exempt)');
});

console.log('\ntheme (named-theme pref) round-trips through loadUi/saveUi — WARDEN-255');
test('defaults to "system" when nothing is stored', () => {
  reset();
  assert.equal(loadUi().theme, 'system');
});
test('a named theme id round-trips', () => {
  reset();
  saveUi({ ...loadUi(), theme: 'dracula' });
  assert.equal(loadUi().theme, 'dracula');
});
test('"system" round-trips', () => {
  reset();
  saveUi({ ...loadUi(), theme: 'system' });
  assert.equal(loadUi().theme, 'system');
});
test('a legacy "dark" pref migrates to GitHub Dark on load (backward compatible)', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], theme: 'dark' }));
  assert.equal(loadUi().theme, 'github-dark');
});
test('a legacy "light" pref migrates to GitHub Light on load (backward compatible)', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], theme: 'light' }));
  assert.equal(loadUi().theme, 'github-light');
});
test('a legacy "system" pref stays "system" on load', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], theme: 'system' }));
  assert.equal(loadUi().theme, 'system');
});
test('an unknown theme id coerces back to "system" on load (never loads a token-less theme)', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], theme: 'octocat' }));
  assert.equal(loadUi().theme, 'system');
});
test('a missing theme field loads as "system"', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'] }));
  assert.equal(loadUi().theme, 'system');
});
test('a non-string theme coerces to "system" (defensive, no throw)', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], theme: 42 }));
  assert.equal(loadUi().theme, 'system');
});
test('the theme pref survives an empty-mode mount (carried by the live spread)', () => {
  // theme is NOT a workspace field, so persistUiState spreads it from `live`.
  reset();
  const d0 = loadUi();
  saveUi(persistUiState({ ...d0, theme: 'nord' }, 'empty', d0, true));
  assert.equal(loadUi().theme, 'nord');
});
test('a migrated legacy value persists as the new id on the next save', () => {
  // After migration (legacy 'dark' -> 'github-dark'), a normal saveUi/loadUi
  // cycle must keep the migrated id — it does not revert to the legacy literal.
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], theme: 'dark' }));
  const migrated = loadUi();
  assert.equal(migrated.theme, 'github-dark');
  saveUi({ ...migrated });
  assert.equal(loadUi().theme, 'github-dark');
});

console.log('\nsnippets (instruction library) validate + round-trip through loadUi/saveUi — WARDEN-323');
test('seeds STARTER_SNIPPETS when nothing is stored (fresh install)', () => {
  reset();
  assert.deepEqual(loadUi().snippets, STARTER_SNIPPETS);
});
test('seeds STARTER_SNIPPETS when the persisted field is absent (v2->v3 promote)', () => {
  // A v2 payload (no snippets field) promoted forward must seed the starter set,
  // so an upgrading user gets the library out of the box.
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'] }));
  assert.deepEqual(loadUi().snippets, STARTER_SNIPPETS);
});
test('does NOT re-seed once an empty list is persisted (deletions stick)', () => {
  reset();
  saveUi({ ...loadUi(), snippets: [] });
  assert.deepEqual(loadUi().snippets, [], 'an explicit [] is respected, not re-seeded');
});
test('does NOT re-seed once a non-empty list is persisted', () => {
  reset();
  const mine = [{ name: 'Mine', text: 'do the thing' }];
  saveUi({ ...loadUi(), snippets: mine });
  assert.deepEqual(loadUi().snippets, mine);
});
test('valid snippets round-trip', () => {
  reset();
  const list = [{ name: 'Run tests', text: 'run the test suite' }, { name: 'Ship it', text: 'commit and push' }];
  saveUi({ ...loadUi(), snippets: list });
  assert.deepEqual(loadUi().snippets, list);
});
test('a non-array snippets coerces to [] (defensive, no throw) — and does NOT re-seed', () => {
  // A present-but-wrong-type value is "a value exists": parseSnippets returns []
  // rather than re-seeding, matching the "deletions stick" contract.
  reset();
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], snippets: 'bogus' }));
  assert.deepEqual(loadUi().snippets, []);
});
test('entries missing name or text are dropped', () => {
  reset();
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], snippets: [{ name: 'ok', text: 'ok' }, { name: 'notext' }, { text: 'noname' }, {}] }));
  assert.deepEqual(loadUi().snippets, [{ name: 'ok', text: 'ok' }]);
});
test('the name length cap is exactly SNIPPET_NAME_MAX (boundary: N ok, N+1 dropped)', () => {
  reset();
  const exact = 'x'.repeat(SNIPPET_NAME_MAX);
  const tooLong = 'x'.repeat(SNIPPET_NAME_MAX + 1);
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], snippets: [{ name: exact, text: 'a' }, { name: tooLong, text: 'b' }] }));
  assert.deepEqual(loadUi().snippets, [{ name: exact, text: 'a' }]);
});
test('the text length cap is exactly SNIPPET_TEXT_MAX (boundary: N ok, N+1 dropped)', () => {
  reset();
  const exact = 'y'.repeat(SNIPPET_TEXT_MAX);
  const tooLong = 'y'.repeat(SNIPPET_TEXT_MAX + 1);
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], snippets: [{ name: 'a', text: exact }, { name: 'b', text: tooLong }] }));
  assert.deepEqual(loadUi().snippets, [{ name: 'a', text: exact }]);
});
test('duplicate names are de-duplicated (case-insensitive, first wins)', () => {
  reset();
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], snippets: [{ name: 'Run Tests', text: 'first' }, { name: 'run tests', text: 'second' }] }));
  assert.deepEqual(loadUi().snippets, [{ name: 'Run Tests', text: 'first' }]);
});
test('the count cap drops overflow (first SNIPPET_MAX_COUNT win)', () => {
  reset();
  const many = Array.from({ length: SNIPPET_MAX_COUNT + 5 }, (_, i) => ({ name: `s${i}`, text: `t${i}` }));
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], snippets: many }));
  const loaded = loadUi().snippets;
  assert.equal(loaded.length, SNIPPET_MAX_COUNT, 'overflow entries dropped');
  assert.deepEqual(loaded[0], { name: 's0', text: 't0' });
});
test('names and text are trimmed on load', () => {
  reset();
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], snippets: [{ name: '  Run tests  ', text: '  run it  ' }] }));
  assert.deepEqual(loadUi().snippets, [{ name: 'Run tests', text: 'run it' }]);
});
test('snippets survive an empty-mode mount (carried by the live spread, not the frozen workspace)', () => {
  reset();
  const d0 = loadUi();
  const mine = [{ name: 'Mine', text: 'do the thing' }];
  saveUi(persistUiState({ ...d0, snippets: mine }, 'empty', d0, true));
  assert.deepEqual(loadUi().snippets, mine);
});

console.log('\nvalidateSnippetName — the write-site contract (add/rename route through this)');
test('returns null for an acceptable name', () => {
  assert.equal(validateSnippetName('Run tests', [{ name: 'Ship', text: 'x' }]), null);
});
test('flags empty (after trim)', () => {
  assert.equal(validateSnippetName('', []), 'empty');
  assert.equal(validateSnippetName('   ', []), 'empty');
});
test('flags names longer than SNIPPET_NAME_MAX', () => {
  assert.equal(validateSnippetName('x'.repeat(SNIPPET_NAME_MAX), []), null);
  assert.equal(validateSnippetName('x'.repeat(SNIPPET_NAME_MAX + 1), []), 'too-long');
});
test('flags duplicates case-insensitively', () => {
  const existing = [{ name: 'Run tests', text: 'r' }];
  assert.equal(validateSnippetName('Run tests', existing), 'duplicate');
  assert.equal(validateSnippetName('RUN TESTS', existing), 'duplicate');
  assert.equal(validateSnippetName('Ship', existing), null);
});
test('excludes `except` so a case-only rename is allowed', () => {
  const existing = [{ name: 'Run tests', text: 'r' }];
  assert.equal(validateSnippetName('RUN TESTS', existing, 'Run tests'), null);
  // But a rename colliding with a DIFFERENT snippet is still blocked.
  const two = [{ name: 'Run tests', text: 'r' }, { name: 'Ship', text: 's' }];
  assert.equal(validateSnippetName('Ship', two, 'Run tests'), 'duplicate');
});
test('trims before validating (matches load-time normalization)', () => {
  assert.equal(validateSnippetName('  Run tests  ', []), null);
  assert.equal(validateSnippetName('  Run tests  ', [{ name: 'Run tests', text: 'r' }]), 'duplicate');
});

console.log('\ndefaultNewChatPresetByHost (per-host preset overrides) round-trips through loadUi/saveUi — WARDEN-352');
test('defaults to {} when nothing is stored', () => {
  reset();
  assert.deepEqual(loadUi().defaultNewChatPresetByHost, {});
});
test('a valid host→preset map round-trips (a custom preset present in the same payload is kept)', () => {
  reset();
  // 'codex' is a custom preset in the SAME payload → kept; built-ins always kept.
  saveUi({ ...loadUi(), customPresets: [{ name: 'codex', cmd: 'codex' }], defaultNewChatPresetByHost: { 'gpu-box': 'codex', '(local)': 'claude' } });
  assert.deepEqual(loadUi().defaultNewChatPresetByHost, { 'gpu-box': 'codex', '(local)': 'claude' });
});
test('an empty map round-trips as {} (clearing all overrides persists nothing)', () => {
  reset();
  saveUi({ ...loadUi(), customPresets: [{ name: 'codex', cmd: 'codex' }], defaultNewChatPresetByHost: {} });
  assert.deepEqual(loadUi().defaultNewChatPresetByHost, {});
});
test('a non-object coerces to {} (defensive, no throw)', () => {
  reset();
  // A string is not a plain map → {}.
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], defaultNewChatPresetByHost: 'bogus' }));
  assert.deepEqual(loadUi().defaultNewChatPresetByHost, {});
  // An array is an object but NOT a plain map → {}.
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], defaultNewChatPresetByHost: [['gpu-box', 'codex']] }));
  assert.deepEqual(loadUi().defaultNewChatPresetByHost, {});
  // A number → {}.
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], defaultNewChatPresetByHost: 42 }));
  assert.deepEqual(loadUi().defaultNewChatPresetByHost, {});
});
test('a per-host value naming a custom preset NOT in the stored customPresets is DROPPED (falls back to global at read time — the key correctness behavior)', () => {
  reset();
  // 'codex' is not a built-in and NOT in the (empty) customPresets → dropped.
  // 'claude' is a built-in → kept.
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], customPresets: [], defaultNewChatPresetByHost: { 'gpu-box': 'codex', '(local)': 'claude' } }));
  assert.deepEqual(loadUi().defaultNewChatPresetByHost, { '(local)': 'claude' });
});
test('a per-host value of a reserved built-in (claude/shell) is kept with no custom presets', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], customPresets: [], defaultNewChatPresetByHost: { 'gpu-box': 'shell', '(local)': 'claude' } }));
  assert.deepEqual(loadUi().defaultNewChatPresetByHost, { 'gpu-box': 'shell', '(local)': 'claude' });
});
test('entries with non-string values are dropped (never seed the agent-type field with a non-name)', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], defaultNewChatPresetByHost: { '(local)': 'claude', 'num': 42, 'obj': { x: 1 }, 'arr': [1] } }));
  assert.deepEqual(loadUi().defaultNewChatPresetByHost, { '(local)': 'claude' });
});
test('entries with empty/whitespace values are dropped (empty override = use the global default, never persists as a blank)', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], defaultNewChatPresetByHost: { '(local)': 'claude', 'blank': '', 'ws': '   ', 'tab': '\t' } }));
  assert.deepEqual(loadUi().defaultNewChatPresetByHost, { '(local)': 'claude' });
});
test('entries with an empty-string key are dropped', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], defaultNewChatPresetByHost: { '': 'claude', '(local)': 'claude' } }));
  assert.deepEqual(loadUi().defaultNewChatPresetByHost, { '(local)': 'claude' });
});
test('values are trimmed on load (matching defaultNewChatPreset)', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'], defaultNewChatPresetByHost: { '(local)': '  claude  ' } }));
  assert.deepEqual(loadUi().defaultNewChatPresetByHost, { '(local)': 'claude' });
});
test('a missing field loads as {}', () => {
  reset();
  mem.set('warden:ui:v2', JSON.stringify({ activeTabs: ['x'] }));
  assert.deepEqual(loadUi().defaultNewChatPresetByHost, {});
});
test('the map survives an empty-mode mount (carried by the live spread, not the frozen workspace)', () => {
  // defaultNewChatPresetByHost is NOT a workspace field, so persistUiState spreads
  // it from `live`. Confirm an empty-launch still round-trips a freshly set map.
  reset();
  const d0 = loadUi();
  saveUi(persistUiState({ ...d0, customPresets: [{ name: 'codex', cmd: 'codex' }], defaultNewChatPresetByHost: { 'gpu-box': 'codex' } }, 'empty', d0, true));
  assert.deepEqual(loadUi().defaultNewChatPresetByHost, { 'gpu-box': 'codex' });
});

// --- resetUiPrefsPreservingWorkspace — workspace-preserving reset (WARDEN-346) -
// A fully over-tuned UiState: EVERY pref AND every workspace/layout field set to
// a NON-default value, so the reset tests below prove the transformation both
// changes the prefs (not a tautology — the input really was tuned) and keeps the
// workspace (not just because it happened to already be default).
const overTunedLive = () => {
  const live = loadUi();
  const wsId = live.activeWorkspaceId;
  return {
    ...live,
    // prefs (all non-default → must reset to DEFAULT_UI)
    theme: 'dark',
    density: 'compact',
    paneLayout: 'stacked',
    onExitBehavior: 'auto-close',
    autoFocusNewPane: false,
    restoreOnStartup: 'empty',
    timestampFormat: 'absolute',
    terminalFontSize: 20,
    attentionDesktopAlerts: true,
    attentionStates: { stuck: false, erroring: false, waiting: false, blocked: false },
    alertCritical: false, alertWarning: false, alertDirective: false, alertError: false,
    mutedAlertKeys: ['mute-1'],
    watchedChats: ['watch-1'],
    terminalScrollback: 5000,
    terminalFontFamily: '"Hack Nerd Font", ui-monospace, monospace',
    terminalColorScheme: 'dark',
    terminalCursorStyle: 'steady-bar',
    copyOnSelect: true,
    defaultNewChatPreset: 'shell',
    defaultNewChatPresetByHost: { 'host-a': 'shell' },
    defaultNewChatHost: 'prod-box',
    defaultNewChatCwd: '~/projects/warden',
    defaultNewChatCwdByHost: { 'host-a': '/srv' },
    customPresets: [{ name: 'codex', cmd: 'codex' }],
    snippets: [{ name: 'custom-snippet', text: 'do the thing' }],
    defaultSplitShell: 'zsh',
    hostOptions: { 'host-a': { seamlessCopy: true } },
    copyHintDismissed: { 'host-a': true },
    agentFilter: 'filtering',
    agentSort: 'recent',
    // workspace + layout (all non-default → must be PRESERVED). WARDEN-372 moved
    // the open panes + focus into per-workspace WorkspacePaneSet objects under
    // `workspaces` (+ activeWorkspaceId); paneHost stayed global. Seed a
    // non-default, multi-workspace set so the "survives reset" assertion is not
    // a tautology (the input really differs from the single-empty-workspace
    // default).
    workspaces: [
      { id: wsId, name: 'Tuned workspace', openPanes: ['chat-1', 'chat-2'], focused: 'chat-2', recentlyClosed: [] },
      { id: 'ws-extra', name: 'Extra', openPanes: ['chat-3'], focused: 'chat-3', recentlyClosed: [] },
    ],
    activeWorkspaceId: wsId,
    paneHost: { 'chat-1': 'host-a', 'chat-2': 'host-b', 'chat-3': 'host-c' },
    sidebarCollapsed: true,
    observerCollapsed: true,
    healthCollapsed: false,
    sidebarWidth: 300,
    observerWidth: 500,
  };
};

console.log('\nresetUiPrefsPreservingWorkspace snaps prefs to defaults while preserving the workspace — WARDEN-346');

test('every pref field of resetUiPrefsPreservingWorkspace(live) equals DEFAULT_UI\'s value', () => {
  reset();
  const live = overTunedLive();
  // Guard: the input prefs really were non-default (else the test is tautological
  // — a reset that returns defaults from default input proves nothing).
  assert.equal(live.theme, 'dark');
  assert.equal(live.density, 'compact');
  assert.notEqual(live.terminalFontFamily, '');
  assert.equal(live.copyOnSelect, true);
  assert.deepEqual(live.customPresets, [{ name: 'codex', cmd: 'codex' }]);
  assert.equal(live.restoreOnStartup, 'empty');
  assert.equal(live.timestampFormat, 'absolute');
  assert.equal(live.alertCritical, false);
  assert.deepEqual(live.mutedAlertKeys, ['mute-1']);
  assert.deepEqual(live.snippets, [{ name: 'custom-snippet', text: 'do the thing' }]);

  const r = resetUiPrefsPreservingWorkspace(live);
  // Every pref snaps to its DEFAULT_UI value.
  assert.equal(r.theme, 'system');
  assert.equal(r.density, 'comfortable');
  assert.equal(r.paneLayout, 'auto');
  assert.equal(r.onExitBehavior, 'keep');
  assert.equal(r.autoFocusNewPane, true);
  assert.equal(r.restoreOnStartup, 'previous');
  assert.equal(r.terminalFontSize, 14);
  assert.equal(r.attentionDesktopAlerts, false);
  assert.equal(r.terminalScrollback, 10000);
  assert.equal(r.terminalFontFamily, '', 'DEFAULT_UI sentinel (App coerces to the stack for live state)');
  assert.equal(r.terminalColorScheme, 'auto');
  assert.equal(r.terminalCursorStyle, 'blink-block');
  assert.equal(r.copyOnSelect, false);
  assert.equal(r.defaultNewChatPreset, 'claude');
  assert.equal(r.defaultNewChatHost, '(local)');
  assert.equal(r.defaultNewChatCwd, '');
  assert.deepEqual(r.customPresets, []);
  assert.equal(r.defaultSplitShell, '');
  // Prefs added by tickets that landed after WARDEN-346 branched reset too.
  assert.equal(r.timestampFormat, 'relative');
  assert.deepEqual(r.attentionStates, { stuck: true, erroring: true, waiting: true, blocked: true });
  assert.equal(r.alertCritical, true);
  assert.equal(r.alertWarning, true);
  assert.equal(r.alertDirective, true);
  assert.equal(r.alertError, true);
  assert.deepEqual(r.mutedAlertKeys, []);
  assert.deepEqual(r.watchedChats, []);
  assert.deepEqual(r.defaultNewChatPresetByHost, {});
  assert.deepEqual(r.defaultNewChatCwdByHost, {});
  assert.deepEqual(r.snippets, STARTER_SNIPPETS);
  assert.deepEqual(r.hostOptions, {});
  assert.deepEqual(r.copyHintDismissed, {});
  // agentFilter/agentSort are in DEFAULT_UI; the helper resets them too.
  assert.equal(r.agentFilter, 'all');
  assert.equal(r.agentSort, 'manual');
});

test('the workspace + panel-layout fields are copied from live (the workspace survives)', () => {
  reset();
  const live = overTunedLive();
  const r = resetUiPrefsPreservingWorkspace(live);
  // Workspace model (WARDEN-372): the full workspaces array + active id + global
  // paneHost are preserved verbatim — the open panes/focus inside each workspace
  // survive, and a multi-workspace set is kept whole.
  assert.equal(r.workspaces.length, 2);
  assert.equal(r.activeWorkspaceId, live.activeWorkspaceId);
  assert.equal(r.workspaces[0].name, 'Tuned workspace');
  assert.deepEqual(r.workspaces[0].openPanes, ['chat-1', 'chat-2']);
  assert.equal(r.workspaces[0].focused, 'chat-2');
  assert.equal(r.workspaces[1].id, 'ws-extra');
  assert.deepEqual(r.workspaces[1].openPanes, ['chat-3']);
  assert.deepEqual(r.paneHost, { 'chat-1': 'host-a', 'chat-2': 'host-b', 'chat-3': 'host-c' });
  // Panel layout (collapse state + widths) is preserved too.
  assert.equal(r.sidebarCollapsed, true);
  assert.equal(r.observerCollapsed, true);
  assert.equal(r.healthCollapsed, false);
  assert.equal(r.sidebarWidth, 300);
  assert.equal(r.observerWidth, 500);
});

test('round-trip: saveUi(resetUiPrefsPreservingWorkspace(live)) then loadUi() yields DEFAULT prefs + preserved workspace', () => {
  reset();
  const live = overTunedLive();
  saveUi(resetUiPrefsPreservingWorkspace(live));
  const after = loadUi();
  // Prefs are the defaults, read back through the full loadUi coercion path.
  assert.equal(after.theme, 'system');
  assert.equal(after.density, 'comfortable');
  assert.equal(after.paneLayout, 'auto');
  assert.equal(after.onExitBehavior, 'keep');
  assert.equal(after.autoFocusNewPane, true);
  assert.equal(after.restoreOnStartup, 'previous');
  assert.equal(after.terminalFontSize, 14);
  assert.equal(after.attentionDesktopAlerts, false);
  assert.equal(after.terminalScrollback, 10000);
  assert.equal(after.terminalFontFamily, '');
  assert.equal(after.terminalColorScheme, 'auto');
  assert.equal(after.terminalCursorStyle, 'blink-block');
  assert.equal(after.copyOnSelect, false);
  assert.equal(after.defaultNewChatPreset, 'claude');
  assert.equal(after.defaultNewChatHost, '(local)');
  assert.equal(after.defaultNewChatCwd, '');
  assert.deepEqual(after.customPresets, []);
  assert.equal(after.defaultSplitShell, '');
  // Prefs added after WARDEN-346 round-trip to their defaults through loadUi too.
  assert.equal(after.timestampFormat, 'relative');
  assert.deepEqual(after.attentionStates, { stuck: true, erroring: true, waiting: true, blocked: true });
  assert.deepEqual(after.mutedAlertKeys, []);
  assert.deepEqual(after.watchedChats, []);
  assert.deepEqual(after.hostOptions, {});
  assert.deepEqual(after.snippets, STARTER_SNIPPETS);
  // Workspace + layout survive the same reload — the core "reset is
  // non-destructive to the open session" invariant. WARDEN-372 model: the
  // workspaces array (each workspace's openPanes/focus) + active id + global
  // paneHost read back through loadUi's parse path intact.
  assert.equal(after.workspaces.length, 2);
  assert.equal(after.activeWorkspaceId, live.activeWorkspaceId);
  assert.deepEqual(after.workspaces[0].openPanes, ['chat-1', 'chat-2']);
  assert.equal(after.workspaces[0].focused, 'chat-2');
  assert.deepEqual(after.workspaces[1].openPanes, ['chat-3']);
  assert.deepEqual(after.paneHost, { 'chat-1': 'host-a', 'chat-2': 'host-b', 'chat-3': 'host-c' });
  assert.equal(after.sidebarCollapsed, true);
  assert.equal(after.observerCollapsed, true);
  assert.equal(after.healthCollapsed, false);
  assert.equal(after.sidebarWidth, 300);
  assert.equal(after.observerWidth, 500);
});

test('the helper is pure — it does not mutate the input live object', () => {
  reset();
  const live = overTunedLive();
  const snapshot = JSON.parse(JSON.stringify(live));
  resetUiPrefsPreservingWorkspace(live);
  assert.deepEqual(live, snapshot, 'input live object is unchanged');
});

console.log(`\n✓ STORAGE TESTS PASS (${passed})`);
