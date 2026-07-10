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
const { loadUi, saveUi, persistUiState, initialWorkspace } = await import(tmpFile);
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

console.log(`\n✓ STORAGE TESTS PASS (${passed})`);
