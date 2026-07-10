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
const { loadUi, saveUi, persistUiState, initialWorkspace, validatePresetName, isReservedPresetName, PRESET_NAME_MAX, clampSidebarWidth, clampObserverWidth, clampLayoutWidths, SIDEBAR_MIN, SIDEBAR_MAX, OBSERVER_MIN, OBSERVER_MAX, PANE_MIN, HEALTH_WIDTH } = await import(tmpFile);
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

console.log('\ninitialWorkspace gates the workspace on mount');
test('"previous" restores the last-saved workspace', () => {
  const disk = { ...loadUi(), activeTabs: ['a', 'b'], hiddenTabs: ['h'], openPanes: ['a'], focused: 'a', paneHost: { a: 'host' } };
  const ws = initialWorkspace(disk, 'previous');
  assert.deepEqual(ws.activeTabs, ['a', 'b']);
  assert.deepEqual(ws.hiddenTabs, ['h']);
  assert.deepEqual(ws.openPanes, ['a']);
  assert.equal(ws.focused, 'a');
  assert.deepEqual(ws.paneHost, { a: 'host' });
});
test('"empty" yields a clean slate regardless of what was saved', () => {
  const disk = { ...loadUi(), activeTabs: ['a', 'b'], hiddenTabs: ['h'], openPanes: ['a'], focused: 'a', paneHost: { a: 'host' } };
  const ws = initialWorkspace(disk, 'empty');
  assert.deepEqual(ws.activeTabs, []);
  assert.deepEqual(ws.hiddenTabs, []);
  assert.deepEqual(ws.openPanes, []);
  assert.equal(ws.focused, null);
  assert.deepEqual(ws.paneHost, {});
});

console.log('\npersistence-conflict pitfall: an "empty" session must not wipe the saved workspace');
test('empty mount persists empty live workspace WITHOUT destroying the saved workspace', () => {
  reset();
  // 1) Last session (previous mode, startedEmpty=false) saved a real workspace.
  const d0 = loadUi();
  saveUi(persistUiState({ ...d0, activeTabs: ['chat-1', 'chat-2'], openPanes: ['chat-1'], focused: 'chat-1', paneHost: { 'chat-1': 'host-a' } }, 'previous', d0, false));
  assert.deepEqual(loadUi().activeTabs, ['chat-1', 'chat-2']);

  // 2) A fresh launch in 'empty' mode: startedEmpty=true seeds empty live arrays
  //    (initialWorkspace('empty')), and the saveUi effect fires on mount with
  //    those empty arrays — the exact situation that used to wipe the workspace.
  const d1 = loadUi();
  const emptyLive = { ...d1, activeTabs: [], hiddenTabs: [], openPanes: [], focused: null, paneHost: {} };
  saveUi(persistUiState(emptyLive, 'empty', d1, true));

  // 3) The persisted workspace must STILL be intact.
  const after = loadUi();
  assert.equal(after.restoreOnStartup, 'empty');
  assert.deepEqual(after.activeTabs, ['chat-1', 'chat-2'], 'activeTabs survived the empty mount');
  assert.deepEqual(after.openPanes, ['chat-1'], 'openPanes survived the empty mount');
  assert.equal(after.focused, 'chat-1', 'focused survived the empty mount');
  assert.deepEqual(after.paneHost, { 'chat-1': 'host-a' }, 'paneHost survived the empty mount');
});
test('flipping empty -> previous AFTER an empty launch does NOT wipe the saved workspace', () => {
  // Regression guard for the in-session flip data-loss bug. The live workspace is
  // still [] from the empty mount; flipping the pref to 'previous' re-fires the
  // saveUi effect. Because startedEmpty=true, persistUiState must still carry the
  // on-disk workspace forward — NOT write the live [] under the new 'previous' mode.
  reset();
  const d0 = loadUi();
  saveUi(persistUiState({ ...d0, activeTabs: ['A', 'B', 'C'], openPanes: ['A'], focused: 'A', paneHost: { A: 'host-a' } }, 'previous', d0, false));

  // Empty launch, then flip back to 'previous' mid-session (live workspace still []).
  const d1 = loadUi();
  saveUi(persistUiState({ ...d1, activeTabs: [], openPanes: [], focused: null, paneHost: {} }, 'previous', d1, true));

  // The saved workspace survives the flip — criterion #4.
  const after = loadUi();
  assert.equal(after.restoreOnStartup, 'previous', 'pref persisted as previous');
  assert.deepEqual(after.activeTabs, ['A', 'B', 'C'], 'flip empty->previous preserved activeTabs');
  assert.deepEqual(after.openPanes, ['A'], 'flip empty->previous preserved openPanes');
  assert.equal(after.focused, 'A', 'flip empty->previous preserved focused');
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
  saveUi(persistUiState({ ...d0, activeTabs: ['X', 'Y'], openPanes: ['X'], focused: 'X' }, 'previous', d0, false));
  // previous -> empty (mid-session, startedEmpty=false): freeze on disk.
  const d1 = loadUi();
  saveUi(persistUiState({ ...d1, activeTabs: ['X', 'Y'], openPanes: ['X'], focused: 'X' }, 'empty', d1, false));
  assert.deepEqual(loadUi().activeTabs, ['X', 'Y'], 'workspace frozen while pref is empty');
  // empty -> previous (still startedEmpty=false): live workspace is legitimate again.
  const d2 = loadUi();
  saveUi(persistUiState({ ...d2, activeTabs: ['X', 'Y'], openPanes: ['X'], focused: 'X' }, 'previous', d2, false));
  assert.deepEqual(loadUi().activeTabs, ['X', 'Y'], 'workspace intact after flipping back');
});
test('sanity: naively persisting the live empty arrays WOULD wipe it (guard against regression)', () => {
  // If persistUiState ever stopped protecting the workspace in 'empty' mode and
  // just spread the live arrays, the saved workspace would be destroyed. This
  // encodes the dangerous behavior we explicitly do NOT do, to document the risk.
  reset();
  saveUi({ ...loadUi(), activeTabs: ['chat-1'], openPanes: ['chat-1'], focused: 'chat-1' });
  const before = loadUi();
  assert.deepEqual(before.activeTabs, ['chat-1']);
  // The naive (wrong) write the fix replaces:
  saveUi({ ...loadUi(), activeTabs: [], openPanes: [], focused: null });
  assert.deepEqual(loadUi().activeTabs, [], 'naive write wipes the workspace (this is what persistUiState prevents)');
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

console.log(`\n✓ STORAGE TESTS PASS (${passed})`);
