// Tests for the shared client-state store (WARDEN-1271, roadmap WARDEN-1204
// slice 1) — the Zustand store over storage.ts that replaced App-owned useState
// + prop-drilling as the SHARING channel for `snippets`.
//
// Two things are proved here, and they are the two the slice's design rests on:
//
//   1. THE PERSISTENCE BOUNDARY IS UNBROKEN. The store did NOT take over
//      writing localStorage — the ONE compile-locked saveUi effect still does.
//      So the round trip under test is the REAL production chain:
//
//        store.setSnippets(next)
//          → App's subscription re-renders App
//          → the `snippets` field of App's PersistedPrefSnapshot changes
//          → useConfigPersistence's effect fires: saveUi(persistUiState(...))
//          → loadUi() returns it on the next launch
//
//      There is no React runner in this repo, so the App/effect hops are driven
//      here by their PURE parts (the store's own state + persistUiState/saveUi,
//      the exact calls useConfigPersistence.ts makes) rather than by rendering.
//      That is the same seam-level approach gitStatusQuery.test.mjs takes for
//      the TanStack slice.
//
//   2. THE FACTORY REALLY ISOLATES. "A module-level store leaks between tests
//      unless handled deliberately" is a first-class constraint of the roadmap
//      this slice opens, and it is the whole reason uiStore.ts exports a
//      factory alongside the app-level singleton. A test that mutates one store
//      must not be able to move another — including the singleton.
//
// Run: node uiStore.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Polyfill localStorage (Node has none) BEFORE loading either module ------
// uiStore.ts seeds itself from loadUi() at module load, so the polyfill must
// exist first — exactly as it must in the browser.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  clear: () => { mem.clear(); },
};
const reset = () => mem.clear();

// --- Load the REAL modules (TS -> ESM via the OXC transform Vite bundles) ----
// The temp dir lives INSIDE web/ (not os.tmpdir()) because uiStore.ts imports
// `zustand`, a real package: Node resolves a bare specifier by walking up from
// the importing file, so the transpiled module must sit under web/'s
// node_modules ancestry to find it.
const tmpDir = mkdtempSync(join(__dirname, '.uistore-test-'));
const emit = (relPath, outName, rewrite = (c) => c) => {
  const absPath = resolve(__dirname, relPath);
  return transformWithOxc(readFileSync(absPath, 'utf8'), absPath, {})
    .then(({ code }) => writeFileSync(join(tmpDir, outName), rewrite(code)));
};
await emit('src/lib/themes.ts', 'themes.mjs');
await emit('src/lib/storage.ts', 'storage.mjs', (c) => c.replaceAll('@/lib/themes', './themes.mjs'));
await emit('src/lib/uiStore.ts', 'uiStore.mjs', (c) => c.replaceAll('@/lib/storage', './storage.mjs'));
// WARDEN-1362: quickReply.ts is pure + dependency-free (its lone `import type` is
// erased at transpile — same harness quickReply.test.mjs uses), so it emits clean
// here too. The rewrite is a defensive no-op kept for shape parity with the above.
await emit('src/lib/quickReply.ts', 'quickReply.mjs', (c) => c.replaceAll('@/lib/storage', './storage.mjs'));

const { loadUi, saveUi, persistUiState, DEFAULT_UI, STARTER_SNIPPETS, resetUiPrefDefaults, DEFAULT_TERMINAL_FONT_FAMILY } =
  await import(join(tmpDir, 'storage.mjs'));
const { createUiStore, uiStore } = await import(join(tmpDir, 'uiStore.mjs'));
const { replySnippetPreview } = await import(join(tmpDir, 'quickReply.mjs'));
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// The persistence hop App + useConfigPersistence perform, called exactly as
// useConfigPersistence.ts calls it. `store` stands in for App's subscription:
// reading `store.getState().snippets` here IS what App's `useSnippets()` gives
// its PersistedPrefSnapshot.
const flushSnapshotToDisk = (store, { restoreOnStartup = 'previous', startedEmpty = false } = {}) => {
  const s = store.getState();
  const snapshot = {
    ...loadUi(),
    snippets: s.snippets,
    fileViewerViewMode: s.fileViewerViewMode,
    // WARDEN-1322: the six terminal prefs ride the same snapshot — App's
    // PersistedPrefSnapshot carries every one of them (compile-locked), so the
    // honest stand-in for "App re-rendered" includes all eight facts.
    terminalFontSize: s.terminalFontSize,
    terminalScrollback: s.terminalScrollback,
    terminalFontFamily: s.terminalFontFamily,
    terminalCursorStyle: s.terminalCursorStyle,
    copyOnSelect: s.copyOnSelect,
    onExitBehavior: s.onExitBehavior,
    // WARDEN-1342 (slice 4): same compile-locked snapshot field.
    timestampFormat: s.timestampFormat,
    // WARDEN-1204 slice 6: same compile-locked snapshot field.
    hostLabels: s.hostLabels,
    // WARDEN-1375 (slice 7): same compile-locked snapshot field.
    agentFilter: s.agentFilter,
    agentSort: s.agentSort,
    // WARDEN-1383 (slice 8): the eight spawn-family snapshot fields.
    defaultNewChatPreset: s.defaultNewChatPreset,
    defaultNewChatPresetByHost: s.defaultNewChatPresetByHost,
    defaultNewChatHost: s.defaultNewChatHost,
    defaultNewChatCwd: s.defaultNewChatCwd,
    defaultNewChatCwdByHost: s.defaultNewChatCwdByHost,
    customPresets: s.customPresets,
    defaultShell: s.defaultShell,
    defaultShellByHost: s.defaultShellByHost,
  };
  saveUi(persistUiState(snapshot, restoreOnStartup, loadUi(), startedEmpty));
};

console.log('\ncreateUiStore — the seed (storage.ts owns the shape and the defaults)');
test('a fresh store seeds from loadUi() — the starter library on a clean install', () => {
  reset();
  const store = createUiStore();
  // Not a re-declared default: loadUi() is where STARTER_SNIPPETS seeding lives,
  // and the store reads it rather than owning a copy.
  assert.deepEqual(store.getState().snippets, STARTER_SNIPPETS);
  assert.deepEqual(store.getState().snippets, DEFAULT_UI.snippets);
});
test('a fresh store seeds from the PERSISTED payload when one exists', () => {
  reset();
  const mine = [{ name: 'Deploy', text: 'ship it' }];
  saveUi({ ...loadUi(), snippets: mine });
  assert.deepEqual(createUiStore().getState().snippets, mine);
});
test('the seed runs through loadUi\'s sanitizers (names/text trimmed, not raw JSON)', () => {
  reset();
  mem.set('warden:ui:v3', JSON.stringify({
    activeTabs: ['x'],
    snippets: [{ name: '  Run tests  ', text: '  run it  ' }],
  }));
  assert.deepEqual(createUiStore().getState().snippets, [{ name: 'Run tests', text: 'run it' }]);
});
test('an explicit seed overrides the persisted read (so a test needs no localStorage)', () => {
  reset();
  const seeded = [{ name: 'Seeded', text: 'from the factory' }];
  assert.deepEqual(createUiStore({ snippets: seeded }).getState().snippets, seeded);
});

console.log('\nsetSnippets — the store is the live copy, and it does NOT write localStorage');
test('setSnippets replaces the list', () => {
  reset();
  const store = createUiStore({ snippets: [] });
  const next = [{ name: 'Pull', text: 'pull latest' }];
  store.getState().setSnippets(next);
  assert.deepEqual(store.getState().snippets, next);
});
test('a subscriber is notified with the new list (the SHARING channel every surface reads)', () => {
  reset();
  const store = createUiStore({ snippets: [] });
  const seen = [];
  const unsubscribe = store.subscribe((s) => seen.push(s.snippets));
  const next = [{ name: 'Commit', text: 'commit your work' }];
  store.getState().setSnippets(next);
  unsubscribe();
  assert.deepEqual(seen, [next]);
  // After unsubscribing, a further write must not reach it.
  store.getState().setSnippets([]);
  assert.equal(seen.length, 1);
});
test('setSnippets alone writes NOTHING to localStorage (single-writer: the saveUi effect owns the write)', () => {
  reset();
  const store = createUiStore({ snippets: [] });
  store.getState().setSnippets([{ name: 'Ghost', text: 'never persisted on its own' }]);
  // Nothing has run the persistence effect yet, so the payload is still absent.
  // This is the invariant the slice's "no store-owned write-through" non-goal
  // rests on: a second writer here would silently race the compile-locked one.
  assert.equal(mem.get('warden:ui:v3'), undefined);
});
test('the action identity is stable across writes (safe in a React dep array)', () => {
  reset();
  const store = createUiStore({ snippets: [] });
  const before = store.getState().setSnippets;
  before([{ name: 'A', text: 'a' }]);
  assert.equal(store.getState().setSnippets, before);
});

console.log('\nround trip: store → App snapshot → the saveUi effect → loadUi (the production chain)');
test('a snippet added through the store survives a restart', () => {
  reset();
  const store = createUiStore();
  const added = [...store.getState().snippets, { name: 'Deploy', text: 'ship it' }];
  store.getState().setSnippets(added);          // Settings' addSnippet
  flushSnapshotToDisk(store);                    // App snapshot → saveUi effect
  assert.deepEqual(loadUi().snippets, added);    // next launch
  // And the next launch's store seeds from exactly that.
  assert.deepEqual(createUiStore().getState().snippets, added);
});
test('rename / edit-text / delete each round-trip the same way', () => {
  reset();
  const store = createUiStore({ snippets: [{ name: 'Old', text: 'body' }, { name: 'Keep', text: 'k' }] });

  store.getState().setSnippets(store.getState().snippets.map((s) => (s.name === 'Old' ? { ...s, name: 'New' } : s)));
  flushSnapshotToDisk(store);
  assert.deepEqual(loadUi().snippets, [{ name: 'New', text: 'body' }, { name: 'Keep', text: 'k' }]);

  store.getState().setSnippets(store.getState().snippets.map((s) => (s.name === 'New' ? { ...s, text: 'edited' } : s)));
  flushSnapshotToDisk(store);
  assert.deepEqual(loadUi().snippets, [{ name: 'New', text: 'edited' }, { name: 'Keep', text: 'k' }]);

  store.getState().setSnippets(store.getState().snippets.filter((s) => s.name !== 'New'));
  flushSnapshotToDisk(store);
  assert.deepEqual(loadUi().snippets, [{ name: 'Keep', text: 'k' }]);
});
test('deleting everything sticks — the starter seed does NOT come back (WARDEN-323 Decision 3)', () => {
  reset();
  const store = createUiStore();
  store.getState().setSnippets([]);
  flushSnapshotToDisk(store);
  assert.deepEqual(loadUi().snippets, []);
  assert.deepEqual(createUiStore().getState().snippets, []);
});
test('the reset path restores STARTER_SNIPPETS through the store-backed setter', () => {
  reset();
  const store = createUiStore({ snippets: [{ name: 'Mine', text: 'hand-written' }] });
  // App's resetSetters entry is `snippets: setSnippets` — the SAME setter, now
  // backed by the store. resetUiPrefDefaults().snippets is what it is handed.
  store.getState().setSnippets(DEFAULT_UI.snippets);
  flushSnapshotToDisk(store);
  assert.deepEqual(store.getState().snippets, STARTER_SNIPPETS);
  assert.deepEqual(loadUi().snippets, STARTER_SNIPPETS);
});
test('an empty-mode launch still persists the library (it rides the live spread, not the frozen workspace)', () => {
  reset();
  const store = createUiStore();
  const mine = [{ name: 'Mine', text: 'do the thing' }];
  store.getState().setSnippets(mine);
  flushSnapshotToDisk(store, { restoreOnStartup: 'empty', startedEmpty: true });
  assert.deepEqual(loadUi().snippets, mine);
});

// ─── fileViewerViewMode (WARDEN-1288, roadmap WARDEN-1204 slice 2) ───────────
//
// The File Viewer's Rendered ⇄ Source toggle (WARDEN-480), the second fact
// migrated onto the store. Its shape here is the whole point of the slice: ONE
// reader and ONE writer (FileViewer's own toolbar) that used to be drilled
// through four PURE pass-through carriers. The legs below prove the same two
// invariants the snippets legs above do — the persistence boundary is unbroken
// (the store never writes localStorage; App's saveUi effect still does) and the
// factory really isolates.

console.log('\ncreateUiStore — fileViewerViewMode seeds from storage.ts, never from a re-declared default');
test('a fresh store seeds \'rendered\' on a clean install (the DEFAULT_UI value, not a local literal)', () => {
  reset();
  assert.equal(createUiStore().getState().fileViewerViewMode, 'rendered');
  assert.equal(createUiStore().getState().fileViewerViewMode, DEFAULT_UI.fileViewerViewMode);
});
test('a fresh store seeds from the PERSISTED payload when one exists', () => {
  reset();
  saveUi({ ...loadUi(), fileViewerViewMode: 'source' });
  assert.equal(createUiStore().getState().fileViewerViewMode, 'source');
});
test('the seed runs through loadUi\'s sanitizer (a bogus persisted value falls back to \'rendered\')', () => {
  reset();
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], fileViewerViewMode: 'bogus' }));
  assert.equal(createUiStore().getState().fileViewerViewMode, 'rendered');
});
test('an explicit seed overrides the persisted read (so a test needs no localStorage)', () => {
  reset();
  saveUi({ ...loadUi(), fileViewerViewMode: 'rendered' });
  assert.equal(createUiStore({ fileViewerViewMode: 'source' }).getState().fileViewerViewMode, 'source');
});

console.log('\nsetFileViewerViewMode — the toolbar toggle\'s write, and it does NOT touch localStorage');
test('setFileViewerViewMode replaces the value', () => {
  reset();
  const store = createUiStore({ fileViewerViewMode: 'rendered' });
  store.getState().setFileViewerViewMode('source');
  assert.equal(store.getState().fileViewerViewMode, 'source');
  store.getState().setFileViewerViewMode('rendered');
  assert.equal(store.getState().fileViewerViewMode, 'rendered');
});
test('a subscriber is notified with the new mode (the SHARING channel FileViewer reads)', () => {
  reset();
  const store = createUiStore({ fileViewerViewMode: 'rendered' });
  const seen = [];
  const unsubscribe = store.subscribe((s) => seen.push(s.fileViewerViewMode));
  store.getState().setFileViewerViewMode('source');
  unsubscribe();
  assert.deepEqual(seen, ['source']);
  // After unsubscribing, a further write must not reach it.
  store.getState().setFileViewerViewMode('rendered');
  assert.equal(seen.length, 1);
});
test('setFileViewerViewMode alone writes NOTHING to localStorage (single-writer: the saveUi effect owns the write)', () => {
  reset();
  const store = createUiStore({ fileViewerViewMode: 'rendered' });
  store.getState().setFileViewerViewMode('source');
  // The store deliberately has no write-through persistence: a second writer
  // here would silently race the ONE compile-locked saveUi effect.
  assert.equal(mem.get('warden:ui:v3'), undefined);
});
test('the action identity is stable across writes (safe in a React dep array, and in resetSetters)', () => {
  reset();
  const store = createUiStore({ fileViewerViewMode: 'rendered' });
  const before = store.getState().setFileViewerViewMode;
  before('source');
  assert.equal(store.getState().setFileViewerViewMode, before);
});

console.log('\nround trip: FileViewer toggle → store → App snapshot → the saveUi effect → loadUi');
test('a mode picked in the viewer survives a restart', () => {
  reset();
  const store = createUiStore();
  assert.equal(store.getState().fileViewerViewMode, 'rendered');
  store.getState().setFileViewerViewMode('source');   // the toolbar toggle
  flushSnapshotToDisk(store);                          // App snapshot → saveUi effect
  assert.equal(loadUi().fileViewerViewMode, 'source'); // next launch
  // And the next launch's store seeds from exactly that.
  assert.equal(createUiStore().getState().fileViewerViewMode, 'source');
});
test('the reset path restores \'rendered\' through the store-backed setter', () => {
  reset();
  const store = createUiStore({ fileViewerViewMode: 'source' });
  // App's resetSetters entry is `fileViewerViewMode: setFileViewerViewMode` —
  // the SAME setter, now backed by the store, called with a plain value.
  store.getState().setFileViewerViewMode(DEFAULT_UI.fileViewerViewMode);
  flushSnapshotToDisk(store);
  assert.equal(store.getState().fileViewerViewMode, 'rendered');
  assert.equal(loadUi().fileViewerViewMode, 'rendered');
});

console.log('\nfactory isolation — fileViewerViewMode');
test('two stores do not share the view mode', () => {
  reset();
  const a = createUiStore({ fileViewerViewMode: 'rendered' });
  const b = createUiStore({ fileViewerViewMode: 'rendered' });
  a.getState().setFileViewerViewMode('source');
  assert.equal(a.getState().fileViewerViewMode, 'source');
  assert.equal(b.getState().fileViewerViewMode, 'rendered');
});
test('mutating a factory store leaves the APP-LEVEL singleton\'s view mode untouched', () => {
  reset();
  const before = uiStore.getState().fileViewerViewMode;
  createUiStore({ fileViewerViewMode: 'rendered' }).getState().setFileViewerViewMode('source');
  assert.equal(uiStore.getState().fileViewerViewMode, before);
});
test('the two migrated facts are independent — writing one does not disturb the other', () => {
  reset();
  const store = createUiStore({ snippets: [{ name: 'Keep', text: 'k' }], fileViewerViewMode: 'rendered' });
  store.getState().setFileViewerViewMode('source');
  assert.deepEqual(store.getState().snippets, [{ name: 'Keep', text: 'k' }]);
  store.getState().setSnippets([]);
  assert.equal(store.getState().fileViewerViewMode, 'source');
});

console.log('\nfactory isolation — the reason this is a factory and not a bare module-level store');
test('two stores built from the same persisted payload do not share state', () => {
  reset();
  const a = createUiStore({ snippets: [] });
  const b = createUiStore({ snippets: [] });
  a.getState().setSnippets([{ name: 'Only A', text: 'a' }]);
  assert.deepEqual(a.getState().snippets, [{ name: 'Only A', text: 'a' }]);
  assert.deepEqual(b.getState().snippets, []);
});
test('a subscriber on one store never fires for another store\'s write', () => {
  reset();
  const a = createUiStore({ snippets: [] });
  const b = createUiStore({ snippets: [] });
  let bNotifications = 0;
  const unsubscribe = b.subscribe(() => { bNotifications += 1; });
  a.getState().setSnippets([{ name: 'A', text: 'a' }]);
  unsubscribe();
  assert.equal(bNotifications, 0);
});
test('mutating a factory store leaves the APP-LEVEL singleton untouched', () => {
  reset();
  const before = uiStore.getState().snippets;
  createUiStore({ snippets: [] }).getState().setSnippets([{ name: 'Test-only', text: 'x' }]);
  assert.deepEqual(uiStore.getState().snippets, before);
  assert.ok(!uiStore.getState().snippets.some((s) => s.name === 'Test-only'),
    'a test store\'s write must never leak into the app store');
});

// ─── the six terminal prefs (WARDEN-1322, roadmap WARDEN-1204 slice 3) ───────
//
// terminalFontSize, terminalScrollback, terminalFontFamily, terminalCursorStyle,
// copyOnSelect, onExitBehavior — the largest cluster migrated onto the store.
// TWO components read them (PaneTile — which also WRITES font size via its
// A−/A+ buttons and context menu — and Settings' AppearanceSection), and the
// prop chain between App and them was a proven-zero-use carrier (PaneGrid
// forwarded all of them without reading one). The legs below prove the same
// invariants the earlier slices do, PLUS the slice's one trap: the
// terminalFontFamily seed is truthiness, not nullish — DEFAULT_UI's value is ''
// and a persisted '' must seed the real font stack, never ''.

console.log('\ncreateUiStore — the six terminal prefs seed from storage.ts, never from re-declared defaults');
test('a fresh store seeds the five ??-seeded terminal prefs from DEFAULT_UI (not local literals)', () => {
  reset();
  const s = createUiStore().getState();
  assert.equal(s.terminalFontSize, DEFAULT_UI.terminalFontSize);
  assert.equal(s.terminalScrollback, DEFAULT_UI.terminalScrollback);
  assert.equal(s.terminalCursorStyle, DEFAULT_UI.terminalCursorStyle);
  assert.equal(s.copyOnSelect, DEFAULT_UI.copyOnSelect);
  assert.equal(s.onExitBehavior, DEFAULT_UI.onExitBehavior);
});
test('a fresh store seeds the six from the PERSISTED payload when one exists', () => {
  reset();
  saveUi({
    ...loadUi(),
    terminalFontSize: 18,
    terminalScrollback: 5000,
    terminalFontFamily: '"Hack Nerd Font", monospace',
    terminalCursorStyle: 'steady-bar',
    copyOnSelect: true,
    onExitBehavior: 'dim',
  });
  const s = createUiStore().getState();
  assert.equal(s.terminalFontSize, 18);
  assert.equal(s.terminalScrollback, 5000);
  assert.equal(s.terminalFontFamily, '"Hack Nerd Font", monospace');
  assert.equal(s.terminalCursorStyle, 'steady-bar');
  assert.equal(s.copyOnSelect, true);
  assert.equal(s.onExitBehavior, 'dim');
});
test('a persisted terminalFontFamily of \'\' seeds the DEFAULT stack, never \'\' (the truthiness trap)', () => {
  reset();
  // DEFAULT_UI.terminalFontFamily is '' (blank = default stack) — exactly what a
  // user who never picked a custom font has on disk. A ??-only seed would hand
  // '' to xterm and blank the pane; the seed must use || like App's old
  // useState initializer did.
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], terminalFontFamily: '' }));
  const seeded = createUiStore().getState().terminalFontFamily;
  assert.equal(seeded, DEFAULT_TERMINAL_FONT_FAMILY);
  assert.notEqual(seeded, '');
  // And an absent value behaves identically (loadUi normalizes it to '').
  reset();
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'] }));
  assert.equal(createUiStore().getState().terminalFontFamily, DEFAULT_TERMINAL_FONT_FAMILY);
});
test('the seed runs through loadUi\'s sanitizers (bogus values fall back, then the font seed applies)', () => {
  reset();
  mem.set('warden:ui:v3', JSON.stringify({
    activeTabs: ['x'],
    terminalFontSize: 'big',
    terminalScrollback: 'many',
    terminalFontFamily: 42,
    terminalCursorStyle: 'wiggly',
    onExitBehavior: 'explode',
  }));
  const s = createUiStore().getState();
  assert.equal(s.terminalFontSize, DEFAULT_UI.terminalFontSize);
  assert.equal(s.terminalScrollback, DEFAULT_UI.terminalScrollback);
  // A non-string font is coerced to '' by loadUi — which the || seed then
  // lifts to the real stack. The sanitizer and the seed compose.
  assert.equal(s.terminalFontFamily, DEFAULT_TERMINAL_FONT_FAMILY);
  assert.equal(s.terminalCursorStyle, DEFAULT_UI.terminalCursorStyle);
  assert.equal(s.onExitBehavior, DEFAULT_UI.onExitBehavior);
  // The sanitizer rejects TYPES, not ranges: an out-of-range number passes
  // through raw, exactly as the old useState seeds did — the 8–24 / 100–100000
  // clamps live at PaneTile's use site (safeFontSize/safeScrollback), where
  // they have always been.
  reset();
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], terminalFontSize: 999, terminalScrollback: -5 }));
  const raw = createUiStore().getState();
  assert.equal(raw.terminalFontSize, 999);
  assert.equal(raw.terminalScrollback, -5);
});
test('an explicit seed overrides the persisted read for all six (so a test needs no localStorage)', () => {
  reset();
  saveUi({
    ...loadUi(),
    terminalFontSize: 18,
    terminalScrollback: 5000,
    terminalFontFamily: '"Hack Nerd Font", monospace',
    terminalCursorStyle: 'steady-bar',
    copyOnSelect: true,
    onExitBehavior: 'dim',
  });
  const seeded = {
    terminalFontSize: 10,
    terminalScrollback: 2000,
    terminalFontFamily: '"Seeded Font", monospace',
    terminalCursorStyle: 'blink-underline',
    copyOnSelect: false,
    onExitBehavior: 'auto-close',
  };
  const s = createUiStore(seeded).getState();
  assert.equal(s.terminalFontSize, 10);
  assert.equal(s.terminalScrollback, 2000);
  assert.equal(s.terminalFontFamily, '"Seeded Font", monospace');
  assert.equal(s.terminalCursorStyle, 'blink-underline');
  assert.equal(s.copyOnSelect, false);
  assert.equal(s.onExitBehavior, 'auto-close');
});

console.log('\nthe six setters — the store is the live copy, and it does NOT write localStorage');
test('each of the six setters replaces its value and notifies subscribers', () => {
  reset();
  const store = createUiStore();
  const seen = [];
  const unsubscribe = store.subscribe((s) => seen.push({
    fontSize: s.terminalFontSize, scrollback: s.terminalScrollback, font: s.terminalFontFamily,
    cursor: s.terminalCursorStyle, copy: s.copyOnSelect, exit: s.onExitBehavior,
  }));
  store.getState().setTerminalFontSize(20);            // PaneTile's A+ button, AppearanceSection's input
  store.getState().setTerminalScrollback(25000);
  store.getState().setTerminalFontFamily('"F", monospace');
  store.getState().setTerminalCursorStyle('steady-block');
  store.getState().setCopyOnSelect(true);
  store.getState().setOnExitBehavior('auto-close');
  unsubscribe();
  assert.equal(seen.length, 6);
  assert.deepEqual(seen[0], { fontSize: 20, scrollback: 10000, font: DEFAULT_TERMINAL_FONT_FAMILY, cursor: 'blink-block', copy: false, exit: 'keep' });
  assert.deepEqual(seen[5], { fontSize: 20, scrollback: 25000, font: '"F", monospace', cursor: 'steady-block', copy: true, exit: 'auto-close' });
});
test('the six setters alone write NOTHING to localStorage (single-writer: the saveUi effect owns the write)', () => {
  reset();
  const store = createUiStore();
  store.getState().setTerminalFontSize(22);
  store.getState().setTerminalScrollback(30000);
  store.getState().setTerminalFontFamily('"Ghost Font", monospace');
  store.getState().setTerminalCursorStyle('blink-bar');
  store.getState().setCopyOnSelect(true);
  store.getState().setOnExitBehavior('dim');
  // No write-through persistence in the store — a second writer here would
  // silently race the ONE compile-locked saveUi effect.
  assert.equal(mem.get('warden:ui:v3'), undefined);
});
test('the six action identities are stable across writes (safe in resetSetters and dep arrays)', () => {
  reset();
  const store = createUiStore();
  const before = store.getState();
  before.setTerminalFontSize(16);
  before.setTerminalScrollback(9000);
  before.setTerminalFontFamily('"X", monospace');
  before.setTerminalCursorStyle('steady-underline');
  before.setCopyOnSelect(true);
  before.setOnExitBehavior('keep');
  const after = store.getState();
  assert.equal(after.setTerminalFontSize, before.setTerminalFontSize);
  assert.equal(after.setTerminalScrollback, before.setTerminalScrollback);
  assert.equal(after.setTerminalFontFamily, before.setTerminalFontFamily);
  assert.equal(after.setTerminalCursorStyle, before.setTerminalCursorStyle);
  assert.equal(after.setCopyOnSelect, before.setCopyOnSelect);
  assert.equal(after.setOnExitBehavior, before.setOnExitBehavior);
});

console.log('\nround trip: each terminal pref survives a restart through the real chain');
test('all six round-trip store → App snapshot → the saveUi effect → loadUi → the next store', () => {
  reset();
  const store = createUiStore();
  store.getState().setTerminalFontSize(9);             // clamped at the use site, stored raw
  store.getState().setTerminalScrollback(77777);
  store.getState().setTerminalFontFamily('"Round Trip", monospace');
  store.getState().setTerminalCursorStyle('steady-bar');
  store.getState().setCopyOnSelect(true);
  store.getState().setOnExitBehavior('auto-close');
  flushSnapshotToDisk(store);                           // App snapshot → saveUi effect
  const persisted = loadUi();
  assert.equal(persisted.terminalFontSize, 9);
  assert.equal(persisted.terminalScrollback, 77777);
  assert.equal(persisted.terminalFontFamily, '"Round Trip", monospace');
  assert.equal(persisted.terminalCursorStyle, 'steady-bar');
  assert.equal(persisted.copyOnSelect, true);
  assert.equal(persisted.onExitBehavior, 'auto-close');
  // The next launch's store seeds from exactly that.
  const relaunched = createUiStore().getState();
  assert.equal(relaunched.terminalFontSize, 9);
  assert.equal(relaunched.terminalScrollback, 77777);
  assert.equal(relaunched.terminalFontFamily, '"Round Trip", monospace');
  assert.equal(relaunched.terminalCursorStyle, 'steady-bar');
  assert.equal(relaunched.copyOnSelect, true);
  assert.equal(relaunched.onExitBehavior, 'auto-close');
});
test('the reset path restores all six defaults through the store-backed setters — with the terminalFontFamily deviation', () => {
  reset();
  const store = createUiStore({
    terminalFontSize: 20,
    terminalScrollback: 5000,
    terminalFontFamily: '"Mine", monospace',
    terminalCursorStyle: 'steady-block',
    copyOnSelect: true,
    onExitBehavior: 'dim',
  });
  // App's resetSetters entries are the SAME store setters, called with
  // resetUiPrefDefaults()' values. That is where the terminalFontFamily
  // deviation lives: the curated stack, NOT DEFAULT_UI's '' sentinel.
  const defaults = resetUiPrefDefaults();
  assert.equal(defaults.terminalFontFamily, DEFAULT_TERMINAL_FONT_FAMILY);
  assert.notEqual(defaults.terminalFontFamily, DEFAULT_UI.terminalFontFamily);
  store.getState().setTerminalFontSize(defaults.terminalFontSize);
  store.getState().setTerminalScrollback(defaults.terminalScrollback);
  store.getState().setTerminalFontFamily(defaults.terminalFontFamily);
  store.getState().setTerminalCursorStyle(defaults.terminalCursorStyle);
  store.getState().setCopyOnSelect(defaults.copyOnSelect);
  store.getState().setOnExitBehavior(defaults.onExitBehavior);
  flushSnapshotToDisk(store);
  const s = store.getState();
  assert.equal(s.terminalFontSize, DEFAULT_UI.terminalFontSize);
  assert.equal(s.terminalScrollback, DEFAULT_UI.terminalScrollback);
  assert.equal(s.terminalFontFamily, DEFAULT_TERMINAL_FONT_FAMILY);
  assert.equal(s.terminalCursorStyle, DEFAULT_UI.terminalCursorStyle);
  assert.equal(s.copyOnSelect, DEFAULT_UI.copyOnSelect);
  assert.equal(s.onExitBehavior, DEFAULT_UI.onExitBehavior);
  // Persisted too — and the next launch's seed keeps the stack (the || seed
  // leaves a truthy persisted value untouched).
  assert.equal(loadUi().terminalFontFamily, DEFAULT_TERMINAL_FONT_FAMILY);
  assert.equal(createUiStore().getState().terminalFontFamily, DEFAULT_TERMINAL_FONT_FAMILY);
});

console.log('\nfactory isolation + fact independence — the six terminal prefs');
test('two stores do not share terminal prefs; writing one does not disturb the others', () => {
  reset();
  const a = createUiStore({ terminalFontSize: 14, copyOnSelect: false });
  const b = createUiStore({ terminalFontSize: 14, copyOnSelect: false });
  a.getState().setTerminalFontSize(24);
  a.getState().setCopyOnSelect(true);
  assert.equal(a.getState().terminalFontSize, 24);
  assert.equal(b.getState().terminalFontSize, 14);
  assert.equal(b.getState().copyOnSelect, false);
  // Within one store, the eight migrated facts are independent.
  a.getState().setTerminalScrollback(1234);
  assert.equal(a.getState().terminalFontSize, 24);
  assert.deepEqual(a.getState().snippets, STARTER_SNIPPETS);
  assert.equal(a.getState().fileViewerViewMode, 'rendered');
});
test('mutating a factory store\'s terminal prefs leaves the APP-LEVEL singleton untouched', () => {
  reset();
  const before = uiStore.getState().terminalFontSize;
  createUiStore().getState().setTerminalFontSize(23);
  assert.equal(uiStore.getState().terminalFontSize, before);
});

// ─── timestampFormat (WARDEN-1342, roadmap WARDEN-1204 slice 4) ──────────────
//
// The dashboard-wide Timestamp format (WARDEN-213), the fourth fact migrated
// onto the store — and the one that closed a REACH gap while it moved: three
// surfaces (GitBadges ×2, TelemetryTransmissionLog) called the relative-mode
// primitive `formatRelative` directly and ignored the pref outright; every one
// of them now subscribes here. Same invariants as the slices before it: the
// persistence boundary is unbroken, the factory really isolates.

console.log('\ncreateUiStore — timestampFormat seeds from storage.ts, never from a re-declared default');
test('a fresh store seeds \'relative\' on a clean install (the DEFAULT_UI value, not a local literal)', () => {
  reset();
  assert.equal(createUiStore().getState().timestampFormat, 'relative');
  assert.equal(createUiStore().getState().timestampFormat, DEFAULT_UI.timestampFormat);
});
test('a fresh store seeds from the PERSISTED payload when one exists', () => {
  reset();
  saveUi({ ...loadUi(), timestampFormat: 'absolute' });
  assert.equal(createUiStore().getState().timestampFormat, 'absolute');
});
test('the seed runs through loadUi\'s sanitizer (a bogus persisted value falls back to \'relative\')', () => {
  reset();
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], timestampFormat: 'bogus' }));
  assert.equal(createUiStore().getState().timestampFormat, 'relative');
});
test('an explicit seed overrides the persisted read (so a test needs no localStorage)', () => {
  reset();
  saveUi({ ...loadUi(), timestampFormat: 'relative' });
  assert.equal(createUiStore({ timestampFormat: 'absolute' }).getState().timestampFormat, 'absolute');
});

console.log('\nsetTimestampFormat — the Settings Select\'s write, and it does NOT touch localStorage');
test('setTimestampFormat replaces the value', () => {
  reset();
  const store = createUiStore({ timestampFormat: 'relative' });
  store.getState().setTimestampFormat('absolute');
  assert.equal(store.getState().timestampFormat, 'absolute');
  store.getState().setTimestampFormat('relative');
  assert.equal(store.getState().timestampFormat, 'relative');
});
test('a subscriber is notified with the new mode (the SHARING channel every timestamp surface reads)', () => {
  reset();
  const store = createUiStore({ timestampFormat: 'relative' });
  const seen = [];
  const unsubscribe = store.subscribe((s) => seen.push(s.timestampFormat));
  store.getState().setTimestampFormat('absolute');
  unsubscribe();
  assert.deepEqual(seen, ['absolute']);
  // After unsubscribing, a further write must not reach it.
  store.getState().setTimestampFormat('relative');
  assert.equal(seen.length, 1);
});
test('setTimestampFormat alone writes NOTHING to localStorage (single-writer: the saveUi effect owns the write)', () => {
  reset();
  const store = createUiStore({ timestampFormat: 'relative' });
  store.getState().setTimestampFormat('absolute');
  // The store deliberately has no write-through persistence: a second writer
  // here would silently race the ONE compile-locked saveUi effect.
  assert.equal(mem.get('warden:ui:v3'), undefined);
});
test('the action identity is stable across writes (safe in a React dep array, and in resetSetters)', () => {
  reset();
  const store = createUiStore({ timestampFormat: 'relative' });
  const before = store.getState().setTimestampFormat;
  before('absolute');
  assert.equal(store.getState().setTimestampFormat, before);
});

console.log('\nround trip: Settings Select → store → App snapshot → the saveUi effect → loadUi');
test('a format picked in Settings survives a restart', () => {
  reset();
  const store = createUiStore();
  assert.equal(store.getState().timestampFormat, 'relative');
  store.getState().setTimestampFormat('absolute');    // the Settings Select
  flushSnapshotToDisk(store);                         // App snapshot → saveUi effect
  assert.equal(loadUi().timestampFormat, 'absolute'); // next launch
  // And the next launch's store seeds from exactly that.
  assert.equal(createUiStore().getState().timestampFormat, 'absolute');
});
test('the reset path restores \'relative\' through the store-backed setter', () => {
  reset();
  const store = createUiStore({ timestampFormat: 'absolute' });
  // Exactly what App's "Reset appearance & UI preferences" does: resetUiPrefDefaults
  // returns the pref block, then the resetSetters entry (App.tsx) writes it back
  // through the same plain-value store setter the Settings Select uses.
  const defaults = resetUiPrefDefaults();
  store.getState().setTimestampFormat(defaults.timestampFormat);
  assert.equal(store.getState().timestampFormat, DEFAULT_UI.timestampFormat);
});

console.log('\nfactory isolation + fact independence — timestampFormat');
test('two stores do not share the timestamp format', () => {
  reset();
  const a = createUiStore({ timestampFormat: 'relative' });
  const b = createUiStore({ timestampFormat: 'relative' });
  a.getState().setTimestampFormat('absolute');
  assert.equal(a.getState().timestampFormat, 'absolute');
  assert.equal(b.getState().timestampFormat, 'relative');
});
test("mutating a factory store's timestampFormat leaves the APP-LEVEL singleton untouched", () => {
  reset();
  const before = uiStore.getState().timestampFormat;
  createUiStore().getState().setTimestampFormat('absolute');
  assert.equal(uiStore.getState().timestampFormat, before);
});
test('the migrated facts are independent — writing timestampFormat does not disturb the others', () => {
  reset();
  const store = createUiStore();
  store.getState().setTimestampFormat('absolute');
  assert.equal(store.getState().fileViewerViewMode, 'rendered');
  assert.deepEqual(store.getState().snippets, STARTER_SNIPPETS);
  assert.equal(store.getState().terminalFontSize, DEFAULT_UI.terminalFontSize);
});

// ─── hostLabels (WARDEN-490, roadmap WARDEN-1204 slice 6) ────────────────────
//
// Per-host display labels — the LAST shared fact with two sharing channels (a
// purpose-built React context with ~10 readers, plus a props channel to the
// Settings writer). This slice is its ONE home: the context module is deleted
// and web/src has zero React contexts. The store's seeded {} replaces the
// context's `undefined` default with an equivalent — hostLabelFor/hostTagOf
// treat both as "no labels" — so nothing renders differently. Same invariants
// as the slices before it: the persistence boundary is unbroken, the factory
// really isolates.

console.log('\ncreateUiStore — hostLabels seeds from storage.ts, never from a re-declared default');
test('a fresh store seeds {} on a clean install (the DEFAULT_UI value, not a local literal)', () => {
  reset();
  assert.deepEqual(createUiStore().getState().hostLabels, {});
  assert.deepEqual(createUiStore().getState().hostLabels, DEFAULT_UI.hostLabels);
});
test('a fresh store seeds from the PERSISTED payload when one exists', () => {
  reset();
  const mine = { '(local)': 'workstation', 'ci-runner': 'CI runner' };
  saveUi({ ...loadUi(), hostLabels: mine });
  assert.deepEqual(createUiStore().getState().hostLabels, mine);
});
test("the seed runs through loadUi's sanitizer (blank/whitespace labels are dropped)", () => {
  reset();
  mem.set('warden:ui:v3', JSON.stringify({
    activeTabs: ['x'],
    hostLabels: { '(local)': '  Desk  ', 'ci-runner': '   ', ghost: 42 },
  }));
  // loadUi drops empty/whitespace values (an empty label means "no label", so
  // it must never persist as a blank) and non-strings — the store inherits
  // that rather than re-declaring it.
  assert.deepEqual(createUiStore().getState().hostLabels, { '(local)': 'Desk' });
});
test('an explicit seed overrides the persisted read (so a test needs no localStorage)', () => {
  reset();
  saveUi({ ...loadUi(), hostLabels: { 'ci-runner': 'CI runner' } });
  const seeded = { '(local)': 'from the factory' };
  assert.deepEqual(createUiStore({ hostLabels: seeded }).getState().hostLabels, seeded);
});

console.log("\nsetHostLabels — the store is the live copy, and it does NOT write localStorage");
test('setHostLabels replaces the map', () => {
  reset();
  const store = createUiStore({ hostLabels: { '(local)': 'old' } });
  const next = { '(local)': 'workstation', 'ci-runner': 'CI runner' };
  store.getState().setHostLabels(next);
  assert.deepEqual(store.getState().hostLabels, next);
  // Deleting a label = writing a map without the key (HostsSection's
  // setHostLabel drops the key for an empty value).
  store.getState().setHostLabels({ 'ci-runner': 'CI runner' });
  assert.deepEqual(store.getState().hostLabels, { 'ci-runner': 'CI runner' });
});
test('a subscriber is notified with the new map (the SHARING channel every host-tag surface reads)', () => {
  reset();
  const store = createUiStore({ hostLabels: {} });
  const seen = [];
  const unsubscribe = store.subscribe((s) => seen.push(s.hostLabels));
  const next = { 'ci-runner': 'CI runner' };
  store.getState().setHostLabels(next);
  unsubscribe();
  assert.deepEqual(seen, [next]);
  // After unsubscribing, a further write must not reach it.
  store.getState().setHostLabels({});
  assert.equal(seen.length, 1);
});
test('setHostLabels alone writes NOTHING to localStorage (single-writer: the saveUi effect owns the write)', () => {
  reset();
  const store = createUiStore({ hostLabels: {} });
  store.getState().setHostLabels({ '(local)': 'Ghost label' });
  // The store deliberately has no write-through persistence: a second writer
  // here would silently race the ONE compile-locked saveUi effect.
  assert.equal(mem.get('warden:ui:v3'), undefined);
});
test('the action identity is stable across writes (safe in a React dep array, and in resetSetters)', () => {
  reset();
  const store = createUiStore({ hostLabels: {} });
  const before = store.getState().setHostLabels;
  before({ '(local)': 'x' });
  assert.equal(store.getState().setHostLabels, before);
});

console.log('\nround trip: Hosts edit → store → App snapshot → the saveUi effect → loadUi');
test('a label set in Settings → Hosts survives a restart', () => {
  reset();
  const store = createUiStore();
  assert.deepEqual(store.getState().hostLabels, {});
  store.getState().setHostLabels({ '(local)': 'workstation', 'ci-runner': 'CI runner' }); // HostsSection
  flushSnapshotToDisk(store);                                                              // App snapshot → saveUi effect
  assert.deepEqual(loadUi().hostLabels, { '(local)': 'workstation', 'ci-runner': 'CI runner' }); // next launch
  // And the next launch's store seeds from exactly that.
  assert.deepEqual(createUiStore().getState().hostLabels, { '(local)': 'workstation', 'ci-runner': 'CI runner' });
});
test('clearing every label sticks — the empty map is the no-label identity, never resurrected', () => {
  reset();
  const store = createUiStore({ hostLabels: { '(local)': 'workstation' } });
  // HostsSection's setHostLabel deletes the key when the value is emptied, so
  // the last cleared label leaves {}.
  store.getState().setHostLabels({});
  flushSnapshotToDisk(store);
  assert.deepEqual(loadUi().hostLabels, {});
  assert.deepEqual(createUiStore().getState().hostLabels, {});
});
test('the reset path restores {} through the store-backed setter', () => {
  reset();
  const store = createUiStore({ hostLabels: { '(local)': 'workstation' } });
  // App's resetSetters entry is `hostLabels: setHostLabels` — the SAME setter,
  // now backed by the store, called with resetUiPrefDefaults()' {}.
  store.getState().setHostLabels(DEFAULT_UI.hostLabels);
  flushSnapshotToDisk(store);
  assert.deepEqual(store.getState().hostLabels, {});
  assert.deepEqual(loadUi().hostLabels, {});
});

console.log('\nfactory isolation + fact independence — hostLabels');
test('two stores do not share the label map', () => {
  reset();
  const a = createUiStore({ hostLabels: {} });
  const b = createUiStore({ hostLabels: {} });
  a.getState().setHostLabels({ '(local)': 'only A' });
  assert.deepEqual(a.getState().hostLabels, { '(local)': 'only A' });
  assert.deepEqual(b.getState().hostLabels, {});
});
test("mutating a factory store's hostLabels leaves the APP-LEVEL singleton untouched", () => {
  reset();
  const before = uiStore.getState().hostLabels;
  createUiStore({ hostLabels: {} }).getState().setHostLabels({ '(local)': 'Test-only' });
  assert.deepEqual(uiStore.getState().hostLabels, before);
});
test('the migrated facts are independent — writing hostLabels does not disturb the others', () => {
  reset();
  const store = createUiStore({ hostLabels: {} });
  store.getState().setHostLabels({ '(local)': 'workstation' });
  assert.equal(store.getState().fileViewerViewMode, 'rendered');
  assert.deepEqual(store.getState().snippets, STARTER_SNIPPETS);
  assert.equal(store.getState().timestampFormat, 'relative');
  assert.equal(store.getState().terminalFontSize, DEFAULT_UI.terminalFontSize);
  store.getState().setTimestampFormat('absolute');
  assert.deepEqual(store.getState().hostLabels, { '(local)': 'workstation' });
});

console.log('\nWARDEN-1362 — the supply side QuickReply reads now that the last snippets prop is retired');
test('a store seeded with two snippets renders them through the replySnippetPreview seam (the store is the only supply channel left)', () => {
  reset();
  const mine = [
    { name: 'Deploy', text: 'ship it' },
    { name: 'Retest', text: 'rerun the suite' },
  ];
  const store = createUiStore({ snippets: mine });
  // The exact per-render expression QuickReply.tsx evaluates since WARDEN-1362
  // deleted the last prop override: `useSnippets()` → `replySnippetPreview(snippets)`.
  // No prop re-covers this seam — the attention surfaces pass nothing, so the
  // store subscription is the ONLY way one-click fills can arrive.
  assert.deepEqual(replySnippetPreview(store.getState().snippets), mine);
  // And the supply stays reactive through the same seam: a Settings-CRUD write
  // (Settings → Snippets) updates the store, the subscription re-renders, and the
  // previews follow — no prop threading involved at either hop.
  const next = [{ name: 'Rollback', text: 'revert it' }];
  store.getState().setSnippets(next);
  assert.deepEqual(replySnippetPreview(store.getState().snippets), next);
});

console.log('\nWARDEN-1375 (roadmap slice 7) — agentFilter/agentSort: the sidebar fleet filter/sort pair');
test("a fresh store seeds 'all'/'manual' on a clean install (the DEFAULT_UI values, not local literals)", () => {
  reset();
  const store = createUiStore();
  assert.equal(store.getState().agentFilter, 'all');
  assert.equal(store.getState().agentFilter, DEFAULT_UI.agentFilter);
  assert.equal(store.getState().agentSort, 'manual');
  assert.equal(store.getState().agentSort, DEFAULT_UI.agentSort);
});
test('a fresh store seeds both from the PERSISTED payload when one exists', () => {
  reset();
  saveUi({ ...loadUi(), agentFilter: 'yatfa', agentSort: 'name' });
  const store = createUiStore();
  assert.equal(store.getState().agentFilter, 'yatfa');
  assert.equal(store.getState().agentSort, 'name');
});
test("the seed runs through loadUi's sanitizers (a bogus filter falls back to 'all'; a legal sort is accepted)", () => {
  reset();
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], agentFilter: 'claude-only-please', agentSort: 'activity' }));
  const store = createUiStore();
  // agentFilter's enum-membership sanitizer rejects the bogus value (the same
  // normalizer App's retired lazy initializer inherited from loadUi) …
  assert.equal(store.getState().agentFilter, 'all');
  // … while agentSort's ?? sanitizer passes the legal value straight through.
  assert.equal(store.getState().agentSort, 'activity');
});
test('an explicit seed overrides the persisted read (so a test needs no localStorage) — the UiStoreSeed addition', () => {
  reset();
  saveUi({ ...loadUi(), agentFilter: 'yatfa', agentSort: 'name' });
  const store = createUiStore({ agentFilter: 'manual', agentSort: 'status' });
  assert.equal(store.getState().agentFilter, 'manual');
  assert.equal(store.getState().agentSort, 'status');
});

console.log("\nsetAgentFilter/setAgentSort — the popover's writes, and they do NOT touch localStorage");
test('the setters replace both values, and a subscriber is notified (the SHARING channel ChatSidebar reads)', () => {
  reset();
  const store = createUiStore({ agentFilter: 'all', agentSort: 'manual' });
  const seen = [];
  const unsubscribe = store.subscribe((s) => seen.push([s.agentFilter, s.agentSort]));
  store.getState().setAgentFilter('claude');
  store.getState().setAgentSort('host');
  unsubscribe();
  assert.deepEqual(seen, [['claude', 'manual'], ['claude', 'host']]);
  // After unsubscribing, a further write must not reach it.
  store.getState().setAgentFilter('all');
  assert.equal(seen.length, 2);
});
test('the setters alone write NOTHING to localStorage (single-writer: the saveUi effect owns the write)', () => {
  reset();
  const store = createUiStore({ agentFilter: 'all', agentSort: 'manual' });
  store.getState().setAgentFilter('yatfa');
  store.getState().setAgentSort('name');
  // The store deliberately has no write-through persistence: a second writer
  // here would silently race the ONE compile-locked saveUi effect.
  assert.equal(mem.get('warden:ui:v3'), undefined);
});
test('the action identities are stable across writes (safe in a React dep array, and in resetSetters)', () => {
  reset();
  const store = createUiStore({ agentFilter: 'all', agentSort: 'manual' });
  const beforeFilter = store.getState().setAgentFilter;
  const beforeSort = store.getState().setAgentSort;
  beforeFilter('yatfa');
  beforeSort('name');
  assert.equal(store.getState().setAgentFilter, beforeFilter);
  assert.equal(store.getState().setAgentSort, beforeSort);
});

console.log('\nround trip: sidebar popover → store → App snapshot → the saveUi effect → loadUi');
test('a filter/sort picked in ANY of the three headers survives a restart', () => {
  reset();
  const store = createUiStore();
  assert.equal(store.getState().agentFilter, 'all');
  assert.equal(store.getState().agentSort, 'manual');
  store.getState().setAgentFilter('claude');   // the popover's filter Select
  store.getState().setAgentSort('status');     // the popover's sort Select
  flushSnapshotToDisk(store);                  // App snapshot → saveUi effect
  assert.equal(loadUi().agentFilter, 'claude'); // next launch
  assert.equal(loadUi().agentSort, 'status');
  // And the next launch's store seeds from exactly that.
  assert.equal(createUiStore().getState().agentFilter, 'claude');
  assert.equal(createUiStore().getState().agentSort, 'status');
});
test("the reset path restores 'all'/'manual' through the store-backed setters", () => {
  reset();
  const store = createUiStore({ agentFilter: 'yatfa', agentSort: 'name' });
  // App's resetSetters entries are `agentFilter: setAgentFilter` /
  // `agentSort: setAgentSort` — the SAME setters, now backed by the store,
  // called with resetUiPrefDefaults()' values.
  store.getState().setAgentFilter(DEFAULT_UI.agentFilter);
  store.getState().setAgentSort(DEFAULT_UI.agentSort);
  flushSnapshotToDisk(store);
  assert.equal(store.getState().agentFilter, 'all');
  assert.equal(store.getState().agentSort, 'manual');
  assert.equal(loadUi().agentFilter, 'all');
  assert.equal(loadUi().agentSort, 'manual');
});
test('the pair is independent of the other migrated facts', () => {
  reset();
  const store = createUiStore({ agentFilter: 'yatfa', agentSort: 'name' });
  store.getState().setAgentFilter('manual');
  assert.deepEqual(store.getState().snippets, STARTER_SNIPPETS);
  assert.equal(store.getState().fileViewerViewMode, 'rendered');
  assert.deepEqual(store.getState().hostLabels, {});
  store.getState().setTimestampFormat('absolute');
  assert.equal(store.getState().agentFilter, 'manual');
  assert.equal(store.getState().agentSort, 'name');
});

// ─── the new-chats spawn family (WARDEN-1383, roadmap WARDEN-1204 slice 8) ───
//
// Eight facts — defaultNewChatPreset, defaultNewChatPresetByHost,
// defaultNewChatHost, defaultNewChatCwd, defaultNewChatCwdByHost,
// customPresets, defaultShell, defaultShellByHost — that NewChatForm read
// through a PRIVATE `useState(() => loadUi())` while NewChatsSection wrote
// them through the (now-retired) NewChatsPrefs bag. One home now: the store.
console.log('\ncreateUiStore — the spawn family seeds from storage.ts, never from re-declared defaults');
test('a fresh store seeds the eight spawn facts from DEFAULT_UI (not local literals)', () => {
  reset();
  const store = createUiStore();
  assert.equal(store.getState().defaultNewChatPreset, 'claude');
  assert.equal(store.getState().defaultNewChatPreset, DEFAULT_UI.defaultNewChatPreset);
  assert.deepEqual(store.getState().defaultNewChatPresetByHost, {});
  assert.deepEqual(store.getState().defaultNewChatPresetByHost, DEFAULT_UI.defaultNewChatPresetByHost);
  assert.equal(store.getState().defaultNewChatHost, '(local)');
  assert.equal(store.getState().defaultNewChatHost, DEFAULT_UI.defaultNewChatHost);
  assert.equal(store.getState().defaultNewChatCwd, '');
  assert.equal(store.getState().defaultNewChatCwd, DEFAULT_UI.defaultNewChatCwd);
  assert.deepEqual(store.getState().defaultNewChatCwdByHost, {});
  assert.deepEqual(store.getState().defaultNewChatCwdByHost, DEFAULT_UI.defaultNewChatCwdByHost);
  assert.deepEqual(store.getState().customPresets, []);
  assert.deepEqual(store.getState().customPresets, DEFAULT_UI.customPresets);
  assert.equal(store.getState().defaultShell, '');
  assert.equal(store.getState().defaultShell, DEFAULT_UI.defaultShell);
  assert.deepEqual(store.getState().defaultShellByHost, {});
  assert.deepEqual(store.getState().defaultShellByHost, DEFAULT_UI.defaultShellByHost);
});
test('a fresh store seeds the eight from the PERSISTED payload when one exists (incl. shape of the maps and the preset list)', () => {
  reset();
  saveUi({
    ...loadUi(),
    defaultNewChatPreset: 'codex',
    defaultNewChatPresetByHost: { 'box-1': 'claude' },
    defaultNewChatHost: 'box-1',
    defaultNewChatCwd: '/srv/work',
    defaultNewChatCwdByHost: { 'box-1': '/srv/work/agents' },
    customPresets: [{ name: 'codex', cmd: 'codex --full-auto' }],
    defaultShell: 'zsh',
    defaultShellByHost: { 'box-1': 'fish' },
  });
  const store = createUiStore();
  assert.equal(store.getState().defaultNewChatPreset, 'codex');
  assert.deepEqual(store.getState().defaultNewChatPresetByHost, { 'box-1': 'claude' });
  assert.equal(store.getState().defaultNewChatHost, 'box-1');
  assert.equal(store.getState().defaultNewChatCwd, '/srv/work');
  assert.deepEqual(store.getState().defaultNewChatCwdByHost, { 'box-1': '/srv/work/agents' });
  // The array shape survives: each entry keeps its {name, cmd} pair.
  assert.deepEqual(store.getState().customPresets, [{ name: 'codex', cmd: 'codex --full-auto' }]);
  assert.equal(store.getState().defaultShell, 'zsh');
  assert.deepEqual(store.getState().defaultShellByHost, { 'box-1': 'fish' });
});
test("the seed runs through loadUi's sanitizers (a bogus cwd map entry and a blank shell both fall back)", () => {
  reset();
  // parseObjectMap's coerceNonEmptyString drops the blank cwd value (a blank
  // per-host entry must never seed the spawn field empty), and a '' global
  // defaultShell is dropped by loadUi's own blank-dropping — both the same
  // normalizers App's retired lazy initializers inherited.
  mem.set('warden:ui:v3', JSON.stringify({
    activeTabs: ['x'],
    defaultNewChatCwdByHost: { 'box-1': '   ' },
    defaultNewChatCwd: '/srv/work',
    defaultShell: '',
  }));
  const store = createUiStore();
  assert.deepEqual(store.getState().defaultNewChatCwdByHost, {});
  assert.equal(store.getState().defaultNewChatCwd, '/srv/work');
  assert.equal(store.getState().defaultShell, '');
});
test('an explicit seed overrides the persisted read for the eight (so a test needs no localStorage)', () => {
  reset();
  saveUi({ ...loadUi(), defaultNewChatHost: 'box-1', defaultShell: 'zsh', customPresets: [{ name: 'codex', cmd: 'codex' }] });
  const store = createUiStore({
    defaultNewChatPreset: 'shell',
    defaultNewChatPresetByHost: { 'box-1': 'claude' },
    defaultNewChatHost: 'box-2',
    defaultNewChatCwd: '/tmp',
    defaultNewChatCwdByHost: { 'box-2': '/var/tmp' },
    customPresets: [{ name: 'aider', cmd: 'aider' }],
    defaultShell: 'bash',
    defaultShellByHost: { 'box-2': 'fish' },
  });
  assert.equal(store.getState().defaultNewChatPreset, 'shell');
  assert.deepEqual(store.getState().defaultNewChatPresetByHost, { 'box-1': 'claude' });
  assert.equal(store.getState().defaultNewChatHost, 'box-2');
  assert.equal(store.getState().defaultNewChatCwd, '/tmp');
  assert.deepEqual(store.getState().defaultNewChatCwdByHost, { 'box-2': '/var/tmp' });
  assert.deepEqual(store.getState().customPresets, [{ name: 'aider', cmd: 'aider' }]);
  assert.equal(store.getState().defaultShell, 'bash');
  assert.deepEqual(store.getState().defaultShellByHost, { 'box-2': 'fish' });
});

console.log('\nthe spawn-family setters — the store is the live copy, and they do NOT write localStorage');
test('each of the eight setters replaces its value and notifies subscribers', () => {
  reset();
  const store = createUiStore();
  const seen = [];
  const unsubscribe = store.subscribe((s) => seen.push(s.defaultNewChatPreset));
  store.getState().setDefaultNewChatPreset('codex');
  unsubscribe();
  assert.deepEqual(seen, ['codex']);
  assert.equal(store.getState().defaultNewChatPreset, 'codex');

  const seenMap = [];
  const unsubMap = store.subscribe((s) => seenMap.push(s.defaultNewChatCwdByHost));
  store.getState().setDefaultNewChatCwdByHost({ 'box-1': '/srv' });
  unsubMap();
  assert.equal(seenMap.length, 1);
  assert.deepEqual(store.getState().defaultNewChatCwdByHost, { 'box-1': '/srv' });

  const seenPresets = [];
  const unsubPresets = store.subscribe((s) => seenPresets.push(s.customPresets));
  store.getState().setCustomPresets([{ name: 'codex', cmd: 'codex' }]);
  unsubPresets();
  assert.equal(seenPresets.length, 1);
  assert.deepEqual(store.getState().customPresets, [{ name: 'codex', cmd: 'codex' }]);

  store.getState().setDefaultNewChatPresetByHost({ 'box-1': 'aider' });
  assert.deepEqual(store.getState().defaultNewChatPresetByHost, { 'box-1': 'aider' });
  store.getState().setDefaultNewChatHost('box-1');
  assert.equal(store.getState().defaultNewChatHost, 'box-1');
  store.getState().setDefaultNewChatCwd('/srv/work');
  assert.equal(store.getState().defaultNewChatCwd, '/srv/work');
  store.getState().setDefaultShell('zsh');
  assert.equal(store.getState().defaultShell, 'zsh');
  store.getState().setDefaultShellByHost({ 'box-1': 'fish' });
  assert.deepEqual(store.getState().defaultShellByHost, { 'box-1': 'fish' });
});
test('the eight setters alone write NOTHING to localStorage (single-writer: the saveUi effect owns the write)', () => {
  reset();
  const store = createUiStore();
  store.getState().setDefaultNewChatPreset('codex');
  store.getState().setDefaultNewChatPresetByHost({ 'box-1': 'claude' });
  store.getState().setDefaultNewChatHost('box-1');
  store.getState().setDefaultNewChatCwd('/srv/work');
  store.getState().setDefaultNewChatCwdByHost({ 'box-1': '/srv' });
  store.getState().setCustomPresets([{ name: 'codex', cmd: 'codex' }]);
  store.getState().setDefaultShell('zsh');
  store.getState().setDefaultShellByHost({ 'box-1': 'fish' });
  // The store deliberately has no write-through persistence: a second writer
  // here would silently race the ONE compile-locked saveUi effect.
  assert.equal(mem.get('warden:ui:v3'), undefined);
});
test('the eight action identities are stable across writes (safe in a React dep array, and in resetSetters)', () => {
  reset();
  const store = createUiStore();
  const before = {
    preset: store.getState().setDefaultNewChatPreset,
    presetByHost: store.getState().setDefaultNewChatPresetByHost,
    host: store.getState().setDefaultNewChatHost,
    cwd: store.getState().setDefaultNewChatCwd,
    cwdByHost: store.getState().setDefaultNewChatCwdByHost,
    customPresets: store.getState().setCustomPresets,
    shell: store.getState().setDefaultShell,
    shellByHost: store.getState().setDefaultShellByHost,
  };
  store.getState().setDefaultNewChatPreset('codex');
  store.getState().setDefaultNewChatPresetByHost({});
  store.getState().setDefaultNewChatHost('box-1');
  store.getState().setDefaultNewChatCwd('/x');
  store.getState().setDefaultNewChatCwdByHost({});
  store.getState().setCustomPresets([]);
  store.getState().setDefaultShell('zsh');
  store.getState().setDefaultShellByHost({});
  assert.equal(store.getState().setDefaultNewChatPreset, before.preset);
  assert.equal(store.getState().setDefaultNewChatPresetByHost, before.presetByHost);
  assert.equal(store.getState().setDefaultNewChatHost, before.host);
  assert.equal(store.getState().setDefaultNewChatCwd, before.cwd);
  assert.equal(store.getState().setDefaultNewChatCwdByHost, before.cwdByHost);
  assert.equal(store.getState().setCustomPresets, before.customPresets);
  assert.equal(store.getState().setDefaultShell, before.shell);
  assert.equal(store.getState().setDefaultShellByHost, before.shellByHost);
});

console.log('\nround trip: Settings → New Chats → store → App snapshot → the saveUi effect → loadUi');
test('every spawn-family fact survives a restart through the real chain', () => {
  reset();
  const store = createUiStore();
  // NewChatsSection's writes: the CRUD + per-host maps + the three globals.
  store.getState().setDefaultNewChatPreset('codex');
  store.getState().setDefaultNewChatPresetByHost({ 'box-1': 'claude' });
  store.getState().setDefaultNewChatHost('box-1');
  store.getState().setDefaultNewChatCwd('/srv/work');
  store.getState().setDefaultNewChatCwdByHost({ 'box-1': '/srv/work/agents' });
  store.getState().setCustomPresets([{ name: 'codex', cmd: 'codex --full-auto' }]);
  store.getState().setDefaultShell('zsh');
  store.getState().setDefaultShellByHost({ 'box-1': 'fish' });
  flushSnapshotToDisk(store);                  // App snapshot → saveUi effect
  const persisted = loadUi();                  // next launch
  assert.equal(persisted.defaultNewChatPreset, 'codex');
  assert.deepEqual(persisted.defaultNewChatPresetByHost, { 'box-1': 'claude' });
  assert.equal(persisted.defaultNewChatHost, 'box-1');
  assert.equal(persisted.defaultNewChatCwd, '/srv/work');
  assert.deepEqual(persisted.defaultNewChatCwdByHost, { 'box-1': '/srv/work/agents' });
  assert.deepEqual(persisted.customPresets, [{ name: 'codex', cmd: 'codex --full-auto' }]);
  assert.equal(persisted.defaultShell, 'zsh');
  assert.deepEqual(persisted.defaultShellByHost, { 'box-1': 'fish' });
  // And the next launch's store seeds from exactly that.
  const next = createUiStore().getState();
  assert.equal(next.defaultNewChatPreset, 'codex');
  assert.equal(next.defaultNewChatHost, 'box-1');
  assert.deepEqual(next.customPresets, [{ name: 'codex', cmd: 'codex --full-auto' }]);
});
test('the reset path restores all eight defaults through the store-backed setters', () => {
  reset();
  const store = createUiStore({
    defaultNewChatPreset: 'codex',
    defaultNewChatPresetByHost: { 'box-1': 'claude' },
    defaultNewChatHost: 'box-1',
    defaultNewChatCwd: '/srv/work',
    defaultNewChatCwdByHost: { 'box-1': '/srv' },
    customPresets: [{ name: 'codex', cmd: 'codex' }],
    defaultShell: 'zsh',
    defaultShellByHost: { 'box-1': 'fish' },
  });
  // App's resetSetters entries are `defaultNewChatPreset: setDefaultNewChatPreset`
  // (…and siblings) — the SAME setters, now backed by the store, called with
  // resetUiPrefDefaults()' values.
  store.getState().setDefaultNewChatPreset(DEFAULT_UI.defaultNewChatPreset);
  store.getState().setDefaultNewChatPresetByHost(DEFAULT_UI.defaultNewChatPresetByHost);
  store.getState().setDefaultNewChatHost(DEFAULT_UI.defaultNewChatHost);
  store.getState().setDefaultNewChatCwd(DEFAULT_UI.defaultNewChatCwd);
  store.getState().setDefaultNewChatCwdByHost(DEFAULT_UI.defaultNewChatCwdByHost);
  store.getState().setCustomPresets(DEFAULT_UI.customPresets);
  store.getState().setDefaultShell(DEFAULT_UI.defaultShell);
  store.getState().setDefaultShellByHost(DEFAULT_UI.defaultShellByHost);
  flushSnapshotToDisk(store);
  assert.equal(store.getState().defaultNewChatPreset, 'claude');
  assert.deepEqual(store.getState().defaultNewChatPresetByHost, {});
  assert.equal(store.getState().defaultNewChatHost, '(local)');
  assert.equal(store.getState().defaultNewChatCwd, '');
  assert.deepEqual(store.getState().defaultNewChatCwdByHost, {});
  assert.deepEqual(store.getState().customPresets, []);
  assert.equal(store.getState().defaultShell, '');
  assert.deepEqual(store.getState().defaultShellByHost, {});
  assert.equal(loadUi().defaultNewChatPreset, 'claude');
  assert.equal(loadUi().defaultNewChatHost, '(local)');
});
test('the family is independent of the other migrated facts', () => {
  reset();
  const store = createUiStore();
  store.getState().setDefaultNewChatHost('box-1');
  store.getState().setDefaultNewChatPreset('codex');
  assert.deepEqual(store.getState().snippets, STARTER_SNIPPETS);
  assert.equal(store.getState().agentFilter, 'all');
  assert.equal(store.getState().timestampFormat, 'relative');
  assert.deepEqual(store.getState().hostLabels, {});
});

console.log('\nstructural guard: components never read persisted state directly — they subscribe');
test("no file under web/src/components/ contains 'loadUi(' (the read-axis analogue of the PERSISTED_PREF_KEYS compile-lock)", () => {
  // The invariant this guards: a persisted client fact has ONE place it is
  // defined and ONE way it is read — the store (or App's composition root).
  // A component that calls loadUi() directly is exactly the second read
  // channel this slice retired (NewChatForm.tsx:55 did `useState(() =>
  // loadUi())` for eight facts while Settings wrote them through the store-
  // threaded bag). Mutation-check: restoring that call must turn this leg red.
  const walk = (dir) => {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(p));
      else out.push(p);
    }
    return out;
  };
  const offenders = walk(join(__dirname, 'src', 'components'))
    .filter((p) => /\.(ts|tsx)$/.test(p))
    .filter((p) => readFileSync(p, 'utf8').includes('loadUi('));
  assert.deepEqual(
    offenders.map((p) => p.slice(__dirname.length + 1)),
    [],
    'component file(s) read persisted state via loadUi( directly — subscribe to the uiStore instead',
  );
});

test("'saveUi(' lives in exactly ONE production call site — useConfigPersistence.ts — plus its storage.ts definition (the write-axis analogue of the guard above)", () => {
  // The invariant this guards (WARDEN-832's "one writer per fact", write
  // axis): a persisted client fact has ONE writer — the compile-locked
  // saveUi effect in useConfigPersistence. App's theme effect once carried a
  // second writer (`saveUi({ ...loadUi(), theme })`) that bypassed
  // persistUiState — a writer with a different payload shape for the same
  // fact, so a future normalization or empty-mode carry-forward rule added
  // there would silently not apply to theme. Mutation-check: restoring that
  // call in App.tsx must turn this leg red.
  //
  // The census asserts the exact expected FILE SET rather than a fragile
  // count: storage.ts matches the pattern too because it holds the
  // `export function saveUi(` definition itself, and useConfigPersistence.ts
  // is the ONE production caller. Tests are excluded (all suites live in
  // web/*.test.mjs, outside src/, but the exclusion is kept defensive).
  const walk = (dir) => {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(p));
      else out.push(p);
    }
    return out;
  };
  const files = walk(join(__dirname, 'src'))
    .filter((p) => /\.(ts|tsx)$/.test(p) && !/\.test\.(ts|tsx|mjs)$/.test(p))
    .filter((p) => readFileSync(p, 'utf8').includes('saveUi('));
  assert.deepEqual(
    files.map((p) => p.slice(__dirname.length + 1)).sort(),
    ['src/lib/storage.ts', 'src/lib/useConfigPersistence.ts'],
    "saveUi( must appear in exactly ONE production call site (useConfigPersistence.ts) plus its storage.ts definition — a second writer bypasses persistUiState's normalization + empty-mode carry-forward",
  );
});

console.log(`\n✓ UI STORE TESTS PASS (${passed})`);
