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

const { loadUi, saveUi, persistUiState, DEFAULT_UI, STARTER_SNIPPETS, resetUiPrefDefaults, DEFAULT_TERMINAL_FONT_FAMILY, saveObs, resetObsPrefDefaults } =
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
// its PersistedPrefSnapshot. `restoreOnStartup` defaults to the STORE's own
// value since WARDEN-1420 (slice 12) migrated that pref — App reads it through
// `useRestoreOnStartup()` and passes it to useConfigPersistence as
// persistUiState's separate argument — and an explicit override stays available
// for the empty-mode launch test below.
const flushSnapshotToDisk = (store, { restoreOnStartup, startedEmpty = false } = {}) => {
  const s = store.getState();
  const snapshot = {
    ...loadUi(),
    snippets: s.snippets,
    fileViewerViewMode: s.fileViewerViewMode,
    // WARDEN-1322: the six terminal prefs ride the same snapshot — App's
    // PersistedPrefSnapshot carries every one of them (compile-locked), so the
    // honest stand-in for "App re-rendered" mirrors every MIGRATED fact, not
    // just the slice under test. (Slice 3's note said "all eight facts" — true
    // when the store held snippets + fileViewerViewMode + these six; the list
    // has grown with every slice since, so the claim is stated by shape now
    // rather than by a count that silently goes stale.)
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
    // WARDEN-1408 (slice 11): the attention/notification pair — same
    // compile-locked snapshot fields.
    attentionDesktopAlerts: s.attentionDesktopAlerts,
    attentionStates: s.attentionStates,
    // WARDEN-1420 (slice 12): the six remaining appearance prefs. FIVE are
    // compile-locked snapshot fields; `restoreOnStartup` is the ONE UiState
    // field persistUiState takes as a SEPARATE argument (it is excluded from
    // PERSISTED_PREF_KEYS), so it rides the call below rather than the bag —
    // exactly as App passes it to useConfigPersistence.
    theme: s.theme,
    density: s.density,
    paneLayout: s.paneLayout,
    autoFocusNewPane: s.autoFocusNewPane,
    terminalColorScheme: s.terminalColorScheme,
    // WARDEN-1426 (slice 13): the Fleet Health pair — same compile-locked
    // snapshot fields. App keeps them (it subscribes keep-local-names) even
    // though HealthDashboard is now the only surface that reads or writes them.
    healthGroupBy: s.healthGroupBy,
    healthCollapsedHosts: s.healthCollapsedHosts,
    // WARDEN-1433 (slice 14): the pane-ratio pair — same compile-locked
    // snapshot fields. App keeps only the value subscriptions (PaneGrid is the
    // pair's only reader AND writer; the ratios are NOT resettable, so there
    // is no resetSetters entry to keep a setter for).
    paneColRatios: s.paneColRatios,
    paneRowRatios: s.paneRowRatios,
  };
  saveUi(persistUiState(snapshot, restoreOnStartup ?? store.getState().restoreOnStartup, loadUi(), startedEmpty));
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

// ─── the attention/notification pair (WARDEN-1408, roadmap WARDEN-1204 slice 11) ───
//
// Two facts — the master OS-desktop-alert opt-in (attentionDesktopAlerts) and
// the per-state Attention badge display filters (attentionStates) — that FIVE
// surfaces beyond the writer's subscription read: useAttentionRollup's three
// poller gates (the hidden-tab relaxation keeping the WATCH ping alive),
// useTokenBudget's OS-notification gate, and App's persist/reset channels.
// NotificationsSection (the writer) and each consumer subscribe here now; the
// DesktopAlertPrefs Settings props bag is retired.
console.log('\ncreateUiStore — the attention pair seeds from storage.ts, never from re-declared defaults');
test('a fresh store seeds the pair from DEFAULT_UI on a clean install (not local literals)', () => {
  reset();
  const store = createUiStore();
  assert.equal(store.getState().attentionDesktopAlerts, false);
  assert.equal(store.getState().attentionDesktopAlerts, DEFAULT_UI.attentionDesktopAlerts);
  assert.deepEqual(store.getState().attentionStates, { stuck: true, done: true });
  assert.deepEqual(store.getState().attentionStates, DEFAULT_UI.attentionStates);
});
test('a fresh store seeds the pair from the PERSISTED payload when one exists', () => {
  reset();
  saveUi({ ...loadUi(), attentionDesktopAlerts: true, attentionStates: { stuck: false, done: true } });
  const store = createUiStore();
  assert.equal(store.getState().attentionDesktopAlerts, true);
  assert.deepEqual(store.getState().attentionStates, { stuck: false, done: true });
});
test("the seed runs through loadUi's sanitizers (only an explicit true opts in; only an explicit false silences a state)", () => {
  reset();
  // A corrupt/legacy payload: the opt-in is a string, the stuck filter is a
  // string, done is missing entirely.
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], attentionDesktopAlerts: 'yes', attentionStates: { stuck: 'no' } }));
  const store = createUiStore();
  // attentionDesktopAlerts' `=== true` sanitizer keeps the conservative OFF…
  assert.equal(store.getState().attentionDesktopAlerts, false);
  // …while attentionStates' `!== false` semantics keep every state ON
  // (a partial payload never drops a state silently — and buildAttentionRollup's
  // enabledStates[k] !== false reads the same shape).
  assert.deepEqual(store.getState().attentionStates, { stuck: true, done: true });
});
test('an explicit seed overrides the persisted read (so a test needs no localStorage) — the UiStoreSeed addition', () => {
  reset();
  saveUi({ ...loadUi(), attentionDesktopAlerts: true, attentionStates: { stuck: false } });
  const store = createUiStore({ attentionDesktopAlerts: false, attentionStates: { stuck: true, done: false } });
  assert.equal(store.getState().attentionDesktopAlerts, false);
  assert.deepEqual(store.getState().attentionStates, { stuck: true, done: false });
});

console.log("\nsetAttentionDesktopAlerts/setAttentionStates — the section's writes, and they do NOT touch localStorage");
test('the setters replace the pair, and a subscriber is notified (the SHARING channel every consumer reads)', () => {
  reset();
  const store = createUiStore({ attentionDesktopAlerts: false, attentionStates: { stuck: true, done: true } });
  const seen = [];
  const unsubscribe = store.subscribe((s) => seen.push([s.attentionDesktopAlerts, { ...s.attentionStates }]));
  store.getState().setAttentionDesktopAlerts(true);            // NotificationsSection's master toggle
  store.getState().setAttentionStates({ stuck: false, done: true }); // its per-state toggles
  unsubscribe();
  assert.deepEqual(seen, [[true, { stuck: true, done: true }], [true, { stuck: false, done: true }]]);
  // After unsubscribing, a further write must not reach it.
  store.getState().setAttentionDesktopAlerts(false);
  assert.equal(seen.length, 2);
});
test('the setters alone write NOTHING to localStorage (single-writer: the saveUi effect owns the write)', () => {
  reset();
  const store = createUiStore({ attentionDesktopAlerts: false, attentionStates: { stuck: true, done: true } });
  store.getState().setAttentionDesktopAlerts(true);
  store.getState().setAttentionStates({ stuck: false });
  // The store deliberately has no write-through persistence: a second writer
  // here would silently race the ONE compile-locked saveUi effect.
  assert.equal(mem.get('warden:ui:v3'), undefined);
});
test('the two action identities are stable across writes (safe in a React dep array, and in resetSetters)', () => {
  reset();
  const store = createUiStore();
  const beforeAlerts = store.getState().setAttentionDesktopAlerts;
  const beforeStates = store.getState().setAttentionStates;
  beforeAlerts(true);
  beforeStates({ stuck: false });
  assert.equal(store.getState().setAttentionDesktopAlerts, beforeAlerts);
  assert.equal(store.getState().setAttentionStates, beforeStates);
});

console.log('\nround trip: Settings → Notifications → store → App snapshot → the saveUi effect → loadUi');
test('the pair survives a restart through the real chain', () => {
  reset();
  const store = createUiStore();
  assert.equal(store.getState().attentionDesktopAlerts, false);
  assert.deepEqual(store.getState().attentionStates, { stuck: true, done: true });
  store.getState().setAttentionDesktopAlerts(true);            // the master toggle
  store.getState().setAttentionStates({ stuck: false, done: true }); // the per-state toggles
  flushSnapshotToDisk(store);                  // App snapshot → saveUi effect
  const persisted = loadUi();                  // next launch
  assert.equal(persisted.attentionDesktopAlerts, true);
  assert.deepEqual(persisted.attentionStates, { stuck: false, done: true });
  // And the next launch's store seeds from exactly that.
  const next = createUiStore().getState();
  assert.equal(next.attentionDesktopAlerts, true);
  assert.deepEqual(next.attentionStates, { stuck: false, done: true });
});
test('the reset path restores both defaults through the store-backed setters', () => {
  reset();
  const store = createUiStore({ attentionDesktopAlerts: true, attentionStates: { stuck: false, done: false } });
  // App's resetSetters entries are `attentionDesktopAlerts:
  // setAttentionDesktopAlerts` / `attentionStates: setAttentionStates` — the
  // SAME setters, now backed by the store, called with resetUiPrefDefaults()' values.
  store.getState().setAttentionDesktopAlerts(DEFAULT_UI.attentionDesktopAlerts);
  store.getState().setAttentionStates(DEFAULT_UI.attentionStates);
  flushSnapshotToDisk(store);
  assert.equal(store.getState().attentionDesktopAlerts, false);
  assert.deepEqual(store.getState().attentionStates, { stuck: true, done: true });
  assert.equal(loadUi().attentionDesktopAlerts, false);
  assert.deepEqual(loadUi().attentionStates, { stuck: true, done: true });
});
test('the pair is independent of the other migrated facts', () => {
  reset();
  const store = createUiStore({ attentionDesktopAlerts: true });
  store.getState().setAttentionStates({ stuck: false });
  assert.deepEqual(store.getState().snippets, STARTER_SNIPPETS);
  assert.equal(store.getState().agentFilter, 'all');
  assert.equal(store.getState().defaultNewChatHost, '(local)');
  store.getState().setAttentionDesktopAlerts(false);
  assert.deepEqual(store.getState().attentionStates, { stuck: false });
});

// ─── the six remaining appearance prefs (WARDEN-1420, roadmap WARDEN-1204 slice 12) ───
//
// theme, density, paneLayout, autoFocusNewPane, restoreOnStartup and
// terminalColorScheme — the last UiState pairs riding the AppearancePrefs
// Settings props bag. AppearanceSection (the only writer of all six) and
// PaneGrid (the only runtime reader of paneLayout) subscribe here now; the bag
// shrinks to the three ELECTRON pairs, which are not UiState prefs at all.
// `restoreOnStartup` is the one of the six that is NOT in PERSISTED_PREF_KEYS —
// persistUiState takes it as a separate argument — so its round trip below
// rides that argument rather than the snapshot bag.
console.log('\ncreateUiStore — the six appearance prefs seed from storage.ts, never from re-declared defaults');
test('a fresh store seeds all six from DEFAULT_UI on a clean install (not local literals)', () => {
  reset();
  const s = createUiStore().getState();
  assert.equal(s.theme, 'system');
  assert.equal(s.theme, DEFAULT_UI.theme);
  assert.equal(s.density, 'comfortable');
  assert.equal(s.density, DEFAULT_UI.density);
  assert.equal(s.paneLayout, 'auto');
  assert.equal(s.paneLayout, DEFAULT_UI.paneLayout);
  assert.equal(s.autoFocusNewPane, true);
  assert.equal(s.autoFocusNewPane, DEFAULT_UI.autoFocusNewPane);
  assert.equal(s.restoreOnStartup, 'previous');
  assert.equal(s.restoreOnStartup, DEFAULT_UI.restoreOnStartup);
  assert.equal(s.terminalColorScheme, 'auto');
  assert.equal(s.terminalColorScheme, DEFAULT_UI.terminalColorScheme);
});
test('a fresh store seeds all six from the PERSISTED payload when one exists', () => {
  reset();
  saveUi({
    ...loadUi(),
    theme: 'dracula',
    density: 'compact',
    paneLayout: 'stacked',
    autoFocusNewPane: false,
    restoreOnStartup: 'empty',
    terminalColorScheme: 'light',
  });
  const s = createUiStore().getState();
  assert.equal(s.theme, 'dracula');
  assert.equal(s.density, 'compact');
  assert.equal(s.paneLayout, 'stacked');
  assert.equal(s.autoFocusNewPane, false);
  assert.equal(s.restoreOnStartup, 'empty');
  assert.equal(s.terminalColorScheme, 'light');
});
test("the seed runs through loadUi's sanitizers (bogus persisted values fall back to the defaults)", () => {
  reset();
  mem.set('warden:ui:v3', JSON.stringify({
    activeTabs: ['x'],
    theme: 'not-a-theme',
    density: 'roomy',
    paneLayout: 'diagonal',
    autoFocusNewPane: 'yes',
    restoreOnStartup: 'sometimes',
    terminalColorScheme: 'neon',
  }));
  const s = createUiStore().getState();
  assert.equal(s.theme, DEFAULT_UI.theme);
  assert.equal(s.density, DEFAULT_UI.density);
  assert.equal(s.paneLayout, DEFAULT_UI.paneLayout);
  assert.equal(s.autoFocusNewPane, DEFAULT_UI.autoFocusNewPane);
  assert.equal(s.restoreOnStartup, DEFAULT_UI.restoreOnStartup);
  assert.equal(s.terminalColorScheme, DEFAULT_UI.terminalColorScheme);
});
test('an explicit seed overrides the persisted read for all six (so a test needs no localStorage)', () => {
  reset();
  saveUi({ ...loadUi(), theme: 'dracula', density: 'compact', paneLayout: 'stacked', autoFocusNewPane: false, restoreOnStartup: 'empty', terminalColorScheme: 'light' });
  const s = createUiStore({
    theme: 'system',
    density: 'comfortable',
    paneLayout: 'side-by-side',
    autoFocusNewPane: true,
    restoreOnStartup: 'previous',
    terminalColorScheme: 'dark',
  }).getState();
  assert.equal(s.theme, 'system');
  assert.equal(s.density, 'comfortable');
  assert.equal(s.paneLayout, 'side-by-side');
  assert.equal(s.autoFocusNewPane, true);
  assert.equal(s.restoreOnStartup, 'previous');
  assert.equal(s.terminalColorScheme, 'dark');
});
test("a persisted autoFocusNewPane of FALSE survives the seed (the ??-not-|| trap the boolean default invites)", () => {
  // DEFAULT_UI.autoFocusNewPane is `true`, so a `||` seed would silently
  // resurrect the default for a user who deliberately turned it OFF — the
  // mirror of terminalFontFamily's truthiness case, and the reason this fact
  // is ??-seeded. Mutation-check: swapping ?? for || here turns this leg red.
  reset();
  saveUi({ ...loadUi(), autoFocusNewPane: false });
  assert.equal(createUiStore().getState().autoFocusNewPane, false);
  assert.equal(createUiStore({ autoFocusNewPane: false }).getState().autoFocusNewPane, false);
});

console.log("\nthe six setters — AppearanceSection's writes, and they do NOT touch localStorage");
test('each of the six setters replaces its value and notifies subscribers', () => {
  reset();
  const store = createUiStore();
  const seen = [];
  const unsubscribe = store.subscribe((s) => seen.push([s.theme, s.density, s.paneLayout, s.autoFocusNewPane, s.restoreOnStartup, s.terminalColorScheme]));
  store.getState().setTheme('dracula');
  store.getState().setDensity('compact');
  store.getState().setPaneLayout('stacked');
  store.getState().setAutoFocusNewPane(false);
  store.getState().setRestoreOnStartup('empty');
  store.getState().setTerminalColorScheme('light');
  unsubscribe();
  assert.equal(seen.length, 6);
  assert.deepEqual(seen[5], ['dracula', 'compact', 'stacked', false, 'empty', 'light']);
  // After unsubscribing, a further write must not reach it.
  store.getState().setTheme('system');
  assert.equal(seen.length, 6);
});
test('the six setters alone write NOTHING to localStorage (single-writer: the saveUi effect owns the write)', () => {
  reset();
  const store = createUiStore();
  store.getState().setTheme('dracula');
  store.getState().setDensity('compact');
  store.getState().setPaneLayout('stacked');
  store.getState().setAutoFocusNewPane(false);
  store.getState().setRestoreOnStartup('empty');
  store.getState().setTerminalColorScheme('light');
  // The store deliberately has no write-through persistence: a second writer
  // here would silently race the ONE compile-locked saveUi effect.
  assert.equal(mem.get('warden:ui:v3'), undefined);
});
test('the six action identities are stable across writes (safe in resetSetters and dep arrays)', () => {
  reset();
  const store = createUiStore();
  const before = {
    theme: store.getState().setTheme,
    density: store.getState().setDensity,
    paneLayout: store.getState().setPaneLayout,
    autoFocusNewPane: store.getState().setAutoFocusNewPane,
    restoreOnStartup: store.getState().setRestoreOnStartup,
    terminalColorScheme: store.getState().setTerminalColorScheme,
  };
  before.theme('dracula');
  before.density('compact');
  before.paneLayout('stacked');
  before.autoFocusNewPane(false);
  before.restoreOnStartup('empty');
  before.terminalColorScheme('light');
  assert.equal(store.getState().setTheme, before.theme);
  assert.equal(store.getState().setDensity, before.density);
  assert.equal(store.getState().setPaneLayout, before.paneLayout);
  assert.equal(store.getState().setAutoFocusNewPane, before.autoFocusNewPane);
  assert.equal(store.getState().setRestoreOnStartup, before.restoreOnStartup);
  assert.equal(store.getState().setTerminalColorScheme, before.terminalColorScheme);
});

console.log('\nround trip: Settings → Appearance → store → App snapshot → the saveUi effect → loadUi');
test('all six survive a restart through the real chain', () => {
  reset();
  const store = createUiStore();
  store.getState().setTheme('dracula');
  store.getState().setDensity('compact');
  store.getState().setPaneLayout('side-by-side');
  store.getState().setAutoFocusNewPane(false);
  store.getState().setTerminalColorScheme('light');
  flushSnapshotToDisk(store);                  // App snapshot → saveUi effect
  const persisted = loadUi();                  // next launch
  assert.equal(persisted.theme, 'dracula');
  assert.equal(persisted.density, 'compact');
  assert.equal(persisted.paneLayout, 'side-by-side');
  assert.equal(persisted.autoFocusNewPane, false);
  assert.equal(persisted.terminalColorScheme, 'light');
  // And the next launch's store seeds from exactly that.
  const next = createUiStore().getState();
  assert.equal(next.theme, 'dracula');
  assert.equal(next.paneLayout, 'side-by-side');
  assert.equal(next.autoFocusNewPane, false);
});
test("restoreOnStartup round-trips through persistUiState's SEPARATE argument, not the snapshot bag", () => {
  // The one of the six excluded from PERSISTED_PREF_KEYS. App reads the LIVE
  // value here (useRestoreOnStartup) and hands it to useConfigPersistence,
  // which passes it to persistUiState as its own argument — so a flip written
  // through the store still reaches disk.
  reset();
  const store = createUiStore();
  assert.equal(store.getState().restoreOnStartup, 'previous');
  store.getState().setRestoreOnStartup('empty');       // the Settings Select's write
  flushSnapshotToDisk(store);                          // reads the store's live value
  assert.equal(loadUi().restoreOnStartup, 'empty');
  assert.equal(createUiStore().getState().restoreOnStartup, 'empty');
});
test('the reset path restores all six defaults through the store-backed setters', () => {
  reset();
  const store = createUiStore({
    theme: 'dracula',
    density: 'compact',
    paneLayout: 'stacked',
    autoFocusNewPane: false,
    restoreOnStartup: 'empty',
    terminalColorScheme: 'light',
  });
  // App's resetSetters entries are `theme: setTheme` (…and siblings) — the SAME
  // setters, now backed by the store, called with resetUiPrefDefaults()' values.
  const defaults = resetUiPrefDefaults();
  store.getState().setTheme(defaults.theme);
  store.getState().setDensity(defaults.density);
  store.getState().setPaneLayout(defaults.paneLayout);
  store.getState().setAutoFocusNewPane(defaults.autoFocusNewPane);
  store.getState().setRestoreOnStartup(defaults.restoreOnStartup);
  store.getState().setTerminalColorScheme(defaults.terminalColorScheme);
  flushSnapshotToDisk(store);
  const s = store.getState();
  assert.equal(s.theme, DEFAULT_UI.theme);
  assert.equal(s.density, DEFAULT_UI.density);
  assert.equal(s.paneLayout, DEFAULT_UI.paneLayout);
  assert.equal(s.autoFocusNewPane, DEFAULT_UI.autoFocusNewPane);
  assert.equal(s.restoreOnStartup, DEFAULT_UI.restoreOnStartup);
  assert.equal(s.terminalColorScheme, DEFAULT_UI.terminalColorScheme);
  assert.equal(loadUi().theme, DEFAULT_UI.theme);
  assert.equal(loadUi().paneLayout, DEFAULT_UI.paneLayout);
  assert.equal(loadUi().restoreOnStartup, DEFAULT_UI.restoreOnStartup);
});
test('the family is independent of the other migrated facts', () => {
  reset();
  const store = createUiStore();
  store.getState().setTheme('dracula');
  store.getState().setPaneLayout('stacked');
  assert.deepEqual(store.getState().snippets, STARTER_SNIPPETS);
  assert.equal(store.getState().agentFilter, 'all');
  assert.equal(store.getState().timestampFormat, 'relative');
  assert.equal(store.getState().defaultNewChatHost, '(local)');
  assert.equal(store.getState().attentionDesktopAlerts, false);
  // …and writing one of the six does not disturb the other five.
  assert.equal(store.getState().density, 'comfortable');
  assert.equal(store.getState().autoFocusNewPane, true);
  assert.equal(store.getState().restoreOnStartup, 'previous');
  assert.equal(store.getState().terminalColorScheme, 'auto');
});
test('two stores do not share the appearance family; the APP-LEVEL singleton is untouched', () => {
  reset();
  const a = createUiStore();
  const b = createUiStore();
  a.getState().setTheme('dracula');
  a.getState().setPaneLayout('stacked');
  assert.equal(b.getState().theme, 'system');
  assert.equal(b.getState().paneLayout, 'auto');
  assert.equal(uiStore.getState().theme, 'system');
  assert.equal(uiStore.getState().paneLayout, 'auto');
});

// ─── the Fleet Health pair (WARDEN-1426, roadmap WARDEN-1204 slice 13) ───
//
// healthGroupBy (the Health | Host | Project toggle, WARDEN-237/741, persisted
// WARDEN-468) and healthCollapsedHosts (the per-host collapse map inside Host
// grouping, WARDEN-500) — the LAST persisted UiState family that crossed a
// props bag into another component. HealthDashboard is the pair's only reader
// AND only writer and is mounted in exactly one place, so it subscribes here
// now and App's four JSX pass sites + four Props entries are gone. Both facts
// ARE in PERSISTED_PREF_KEYS, so both round-trip through the snapshot bag (no
// restoreOnStartup-style separate argument here).
console.log('\ncreateUiStore — the health pair seeds from storage.ts, never from re-declared defaults');
test('a fresh store seeds the pair from DEFAULT_UI on a clean install (not local literals)', () => {
  reset();
  const s = createUiStore().getState();
  assert.equal(s.healthGroupBy, 'health');
  assert.equal(s.healthGroupBy, DEFAULT_UI.healthGroupBy);
  assert.deepEqual(s.healthCollapsedHosts, {});
  assert.deepEqual(s.healthCollapsedHosts, DEFAULT_UI.healthCollapsedHosts);
});
test('a fresh store seeds the pair from the PERSISTED payload when one exists', () => {
  reset();
  saveUi({ ...loadUi(), healthGroupBy: 'host', healthCollapsedHosts: { 'build-01': true, '(local)': false } });
  const s = createUiStore().getState();
  assert.equal(s.healthGroupBy, 'host');
  assert.deepEqual(s.healthCollapsedHosts, { 'build-01': true, '(local)': false });
});
test("the seed runs through loadUi's sanitizers (a bogus mode falls back; non-boolean map entries are dropped)", () => {
  reset();
  // A corrupt/legacy payload: the mode is outside the 3-way allow-list, and the
  // map mixes a real boolean with a truthy string and a numeric 1 — exactly the
  // values parseCollapsedHosts documents as dropped.
  mem.set('warden:ui:v3', JSON.stringify({
    activeTabs: ['x'],
    healthGroupBy: 'by-vibes',
    healthCollapsedHosts: { 'build-01': true, 'web-02': 'yes', 'db-03': 1, '(local)': false },
  }));
  const s = createUiStore().getState();
  assert.equal(s.healthGroupBy, DEFAULT_UI.healthGroupBy);
  // `false` is a real KEPT value — an explicitly-expanded host is not an absent one.
  assert.deepEqual(s.healthCollapsedHosts, { 'build-01': true, '(local)': false });
});
test('a non-object collapsed-hosts payload degrades to {} (every host expanded — today\'s default)', () => {
  reset();
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], healthCollapsedHosts: 'all-of-them' }));
  assert.deepEqual(createUiStore().getState().healthCollapsedHosts, {});
});
test('an explicit seed overrides the persisted read (so a test needs no localStorage) — the UiStoreSeed addition', () => {
  reset();
  saveUi({ ...loadUi(), healthGroupBy: 'host', healthCollapsedHosts: { 'build-01': true } });
  const s = createUiStore({ healthGroupBy: 'project', healthCollapsedHosts: {} }).getState();
  assert.equal(s.healthGroupBy, 'project');
  assert.deepEqual(s.healthCollapsedHosts, {});
});

console.log("\nsetHealthGroupBy/setHealthCollapsedHosts — the dashboard's own writes, and they do NOT touch localStorage");
test('the setters replace the pair, and a subscriber is notified (the SHARING channel the dashboard reads)', () => {
  reset();
  const store = createUiStore({ healthGroupBy: 'health', healthCollapsedHosts: {} });
  const seen = [];
  const unsubscribe = store.subscribe((s) => seen.push([s.healthGroupBy, { ...s.healthCollapsedHosts }]));
  store.getState().setHealthGroupBy('host');                       // the mode buttons
  store.getState().setHealthCollapsedHosts({ 'build-01': true });  // the per-host collapse toggle
  unsubscribe();
  assert.deepEqual(seen, [['host', {}], ['host', { 'build-01': true }]]);
  // After unsubscribing, a further write must not reach it.
  store.getState().setHealthGroupBy('project');
  assert.equal(seen.length, 2);
});
test('the setters alone write NOTHING to localStorage (single-writer: the saveUi effect owns the write)', () => {
  reset();
  const store = createUiStore({ healthGroupBy: 'health', healthCollapsedHosts: {} });
  store.getState().setHealthGroupBy('host');
  store.getState().setHealthCollapsedHosts({ 'build-01': true });
  // The store deliberately has no write-through persistence: a second writer
  // here would silently race the ONE compile-locked saveUi effect.
  assert.equal(mem.get('warden:ui:v3'), undefined);
});
test('the two action identities are stable across writes (safe in a React dep array, and in resetSetters)', () => {
  reset();
  const store = createUiStore();
  const beforeMode = store.getState().setHealthGroupBy;
  const beforeHosts = store.getState().setHealthCollapsedHosts;
  beforeMode('project');
  beforeHosts({ 'build-01': true });
  assert.equal(store.getState().setHealthGroupBy, beforeMode);
  assert.equal(store.getState().setHealthCollapsedHosts, beforeHosts);
});

console.log('\nround trip: Fleet Health → store → App snapshot → the saveUi effect → loadUi');
test('the pair survives a restart through the real chain', () => {
  reset();
  const store = createUiStore();
  assert.equal(store.getState().healthGroupBy, 'health');
  assert.deepEqual(store.getState().healthCollapsedHosts, {});
  store.getState().setHealthGroupBy('host');                                        // pick Host grouping
  store.getState().setHealthCollapsedHosts({ 'build-01': true, '(local)': false }); // collapse a host
  flushSnapshotToDisk(store);                  // App snapshot → saveUi effect
  const persisted = loadUi();                  // next launch
  assert.equal(persisted.healthGroupBy, 'host');
  assert.deepEqual(persisted.healthCollapsedHosts, { 'build-01': true, '(local)': false });
  // And the next launch's store seeds from exactly that.
  const next = createUiStore().getState();
  assert.equal(next.healthGroupBy, 'host');
  assert.deepEqual(next.healthCollapsedHosts, { 'build-01': true, '(local)': false });
});
test('the reset path restores both defaults through the store-backed setters', () => {
  reset();
  const store = createUiStore({ healthGroupBy: 'project', healthCollapsedHosts: { 'build-01': true } });
  // App's resetSetters entries are `healthGroupBy: setHealthGroupBy` /
  // `healthCollapsedHosts: setHealthCollapsedHosts` — the SAME setters, now
  // backed by the store, called with resetUiPrefDefaults()' values.
  const defaults = resetUiPrefDefaults();
  store.getState().setHealthGroupBy(defaults.healthGroupBy);
  store.getState().setHealthCollapsedHosts(defaults.healthCollapsedHosts);
  flushSnapshotToDisk(store);
  assert.equal(store.getState().healthGroupBy, DEFAULT_UI.healthGroupBy);
  assert.deepEqual(store.getState().healthCollapsedHosts, DEFAULT_UI.healthCollapsedHosts);
  assert.equal(loadUi().healthGroupBy, DEFAULT_UI.healthGroupBy);
  assert.deepEqual(loadUi().healthCollapsedHosts, DEFAULT_UI.healthCollapsedHosts);
});
test('the pair is independent of the other migrated facts', () => {
  reset();
  const store = createUiStore({ healthGroupBy: 'host' });
  store.getState().setHealthCollapsedHosts({ 'build-01': true });
  assert.deepEqual(store.getState().snippets, STARTER_SNIPPETS);
  assert.equal(store.getState().agentFilter, 'all');
  assert.equal(store.getState().theme, 'system');
  assert.equal(store.getState().defaultNewChatHost, '(local)');
  // …and writing one of the pair does not disturb the other.
  assert.equal(store.getState().healthGroupBy, 'host');
  store.getState().setHealthGroupBy('project');
  assert.deepEqual(store.getState().healthCollapsedHosts, { 'build-01': true });
});
test('two stores do not share the health pair; the APP-LEVEL singleton is untouched', () => {
  reset();
  const a = createUiStore();
  const b = createUiStore();
  a.getState().setHealthGroupBy('host');
  a.getState().setHealthCollapsedHosts({ 'build-01': true });
  assert.equal(b.getState().healthGroupBy, 'health');
  assert.deepEqual(b.getState().healthCollapsedHosts, {});
  assert.equal(uiStore.getState().healthGroupBy, 'health');
  assert.deepEqual(uiStore.getState().healthCollapsedHosts, {});
});

// ─── the pane-ratio pair (WARDEN-1433, roadmap WARDEN-1204 slice 14) ───
//
// paneColRatios/paneRowRatios (the draggable resize-gutter track weights,
// WARDEN-660) — the LAST App→PaneGrid props-bag family. PaneGrid is the pair's
// only reader AND only writer (App never read the values beyond the persistence
// snapshot), so it subscribes here now and App's four JSX pass sites + four
// Props entries are gone. Both facts ARE in PERSISTED_PREF_KEYS, so both
// round-trip through the snapshot bag — and both are PRESERVED by the UI-prefs
// reset (RESET_PRESERVED_KEYS, WARDEN-934: "they are panel layout, which the
// shipped button promises to keep"), pinned below.
console.log('\ncreateUiStore — the pane-ratio pair seeds from storage.ts, never from re-declared defaults');
test('a fresh store seeds the pair from DEFAULT_UI on a clean install (not local literals)', () => {
  reset();
  const s = createUiStore().getState();
  assert.deepEqual(s.paneColRatios, []);
  assert.deepEqual(s.paneColRatios, DEFAULT_UI.paneColRatios);
  assert.deepEqual(s.paneRowRatios, []);
  assert.deepEqual(s.paneRowRatios, DEFAULT_UI.paneRowRatios);
});
test('a fresh store seeds the pair from the PERSISTED payload when one exists', () => {
  reset();
  saveUi({ ...loadUi(), paneColRatios: [0.6, 0.4], paneRowRatios: [0.3, 0.7] });
  const s = createUiStore().getState();
  assert.deepEqual(s.paneColRatios, [0.6, 0.4]);
  assert.deepEqual(s.paneRowRatios, [0.3, 0.7]);
});
test("the seed runs through loadUi's sanitizers (a non-array payload degrades; a non-positive entry drops the WHOLE array)", () => {
  reset();
  // Exactly what parseRatioArray documents: a present-but-wrong-type value is
  // genuine corruption → [], and one non-positive/non-finite entry poisons the
  // whole array (a partial ratio list would distort the grid template) → [].
  mem.set('warden:ui:v3', JSON.stringify({
    activeTabs: ['x'],
    paneColRatios: 'all-of-them',
    paneRowRatios: [0.3, -1],
  }));
  const s = createUiStore().getState();
  assert.deepEqual(s.paneColRatios, DEFAULT_UI.paneColRatios);
  assert.deepEqual(s.paneRowRatios, DEFAULT_UI.paneRowRatios);
});
test('an explicit seed overrides the persisted read (so a test needs no localStorage) — the UiStoreSeed addition', () => {
  reset();
  saveUi({ ...loadUi(), paneColRatios: [0.6, 0.4], paneRowRatios: [0.3, 0.7] });
  const s = createUiStore({ paneColRatios: [0.8, 0.2], paneRowRatios: [] }).getState();
  assert.deepEqual(s.paneColRatios, [0.8, 0.2]);
  assert.deepEqual(s.paneRowRatios, []);
});

console.log("\nsetPaneColRatios/setPaneRowRatios — PaneGrid's pointerUp commits, and they do NOT touch localStorage");
test('the setters replace the pair, and a subscriber is notified (the SHARING channel PaneGrid reads)', () => {
  reset();
  const store = createUiStore({ paneColRatios: [], paneRowRatios: [] });
  const seen = [];
  const unsubscribe = store.subscribe((s) => seen.push([[...s.paneColRatios], [...s.paneRowRatios]]));
  store.getState().setPaneColRatios([0.6, 0.4]);  // a column-gutter pointerUp commit
  store.getState().setPaneRowRatios([0.3, 0.7]);  // a row-gutter pointerUp commit
  unsubscribe();
  assert.deepEqual(seen, [[[0.6, 0.4], []], [[0.6, 0.4], [0.3, 0.7]]]);
  // After unsubscribing, a further write must not reach it.
  store.getState().setPaneColRatios([0.5, 0.5]);
  assert.equal(seen.length, 2);
});
test('the setters alone write NOTHING to localStorage (single-writer: the saveUi effect owns the write)', () => {
  reset();
  const store = createUiStore({ paneColRatios: [], paneRowRatios: [] });
  store.getState().setPaneColRatios([0.6, 0.4]);
  store.getState().setPaneRowRatios([0.3, 0.7]);
  // The store deliberately has no write-through persistence: a second writer
  // here would silently race the ONE compile-locked saveUi effect.
  assert.equal(mem.get('warden:ui:v3'), undefined);
});
test('the two action identities are stable across writes (safe in a React dep array — the property the WARDEN-16 handler convention asked of the props setters)', () => {
  reset();
  const store = createUiStore();
  const beforeCol = store.getState().setPaneColRatios;
  const beforeRow = store.getState().setPaneRowRatios;
  beforeCol([0.6, 0.4]);
  beforeRow([0.3, 0.7]);
  assert.equal(store.getState().setPaneColRatios, beforeCol);
  assert.equal(store.getState().setPaneRowRatios, beforeRow);
});

console.log('\nround trip: PaneGrid pointerUp → store → App snapshot → the saveUi effect → loadUi');
test('the pair survives a restart through the real chain (shipped WARDEN-660 behavior, unchanged)', () => {
  reset();
  const store = createUiStore();
  assert.deepEqual(store.getState().paneColRatios, []);
  assert.deepEqual(store.getState().paneRowRatios, []);
  store.getState().setPaneColRatios([0.6, 0.4]); // resize columns, release the gutter
  store.getState().setPaneRowRatios([0.3, 0.7]); // resize rows, release the gutter
  flushSnapshotToDisk(store);                    // App snapshot → saveUi effect
  const persisted = loadUi();                    // next launch
  assert.deepEqual(persisted.paneColRatios, [0.6, 0.4]);
  assert.deepEqual(persisted.paneRowRatios, [0.3, 0.7]);
  // And the next launch's store seeds from exactly that.
  const next = createUiStore().getState();
  assert.deepEqual(next.paneColRatios, [0.6, 0.4]);
  assert.deepEqual(next.paneRowRatios, [0.3, 0.7]);
});
test('the UI-prefs reset PRESERVES the pair (WARDEN-934: ratios are panel layout, PRESERVED)', () => {
  reset();
  saveUi({ ...loadUi(), paneColRatios: [0.6, 0.4], paneRowRatios: [0.3, 0.7] });
  const store = createUiStore();
  // The shipped reset is keyed by ResettableKey = (PERSISTED_PREF_KEYS ∪
  // restoreOnStartup) − RESET_PRESERVED_KEYS. The pair sits in
  // RESET_PRESERVED_KEYS, so it has NO entry in resetUiPrefDefaults() and NO
  // entry in App's resetSetters — nothing in the reset can move it. Pin the
  // exclusion itself (the compile lock's runtime shadow: pulling a key out of
  // RESET_PRESERVED_KEYS forces a defaults entry, and this leg goes red), then
  // drive a representative slice of the defaults sweep through the
  // store-backed setters and show the saveUi effect re-persists the pair
  // UNCHANGED.
  const defaults = resetUiPrefDefaults();
  assert.ok(!('paneColRatios' in defaults), 'paneColRatios must stay in RESET_PRESERVED_KEYS (WARDEN-934: ratios are panel layout) — a defaults entry means it left the preserved set');
  assert.ok(!('paneRowRatios' in defaults), 'paneRowRatios must stay in RESET_PRESERVED_KEYS (WARDEN-934: ratios are panel layout) — a defaults entry means it left the preserved set');
  const s = store.getState();
  s.setTheme(defaults.theme);
  s.setPaneLayout(defaults.paneLayout);
  s.setHealthGroupBy(defaults.healthGroupBy);
  flushSnapshotToDisk(store);
  assert.deepEqual(loadUi().paneColRatios, [0.6, 0.4]);
  assert.deepEqual(loadUi().paneRowRatios, [0.3, 0.7]);
  assert.deepEqual(store.getState().paneColRatios, [0.6, 0.4]);
  assert.deepEqual(store.getState().paneRowRatios, [0.3, 0.7]);
});
test('the pair is independent of the other migrated facts', () => {
  reset();
  const store = createUiStore({ paneColRatios: [0.6, 0.4] });
  store.getState().setPaneRowRatios([0.3, 0.7]);
  assert.deepEqual(store.getState().snippets, STARTER_SNIPPETS);
  assert.equal(store.getState().agentFilter, 'all');
  assert.equal(store.getState().theme, 'system');
  assert.equal(store.getState().defaultNewChatHost, '(local)');
  // …and writing one axis does not disturb the other.
  assert.deepEqual(store.getState().paneColRatios, [0.6, 0.4]);
  store.getState().setPaneColRatios([0.7, 0.3]);
  assert.deepEqual(store.getState().paneRowRatios, [0.3, 0.7]);
});
test('two stores do not share the pane-ratio pair; the APP-LEVEL singleton is untouched', () => {
  reset();
  const a = createUiStore();
  const b = createUiStore();
  a.getState().setPaneColRatios([0.6, 0.4]);
  a.getState().setPaneRowRatios([0.3, 0.7]);
  assert.deepEqual(b.getState().paneColRatios, []);
  assert.deepEqual(b.getState().paneRowRatios, []);
  assert.deepEqual(uiStore.getState().paneColRatios, []);
  assert.deepEqual(uiStore.getState().paneRowRatios, []);
});

// ─── the Observer panel's four view prefs (WARDEN-1441, roadmap WARDEN-1204 slice 15) ───
//
// observerViewMode + the three per-tab filter shapes (observerActivityFilters /
// observerDirectiveFilters / observerAttentionFilters) — the FIRST facts on the
// store from the SECOND storage namespace (ObsUi / warden:observer:v1, behind
// loadObs/saveObs). They used to be ObserverTabs useStates that App could only
// command through a one-shot prop + a nonce; now App writes the store directly
// and both channels are deleted. These facts are NOT in PERSISTED_PREF_KEYS and
// never ride the saveUi snapshot — their persistence stays with ObserverTabs'
// `satisfies Required<ObsUi>` saveObs effect (saveObs guard below pins exactly
// two call sites) — and the store deliberately has NO write-through for them,
// the same single-writer rule as every slice before. Seeding reads loadObs()
// ONCE per store instance with resetObsPrefDefaults() as the ??-only fallback:
// storage.ts owns shape and defaults; nothing here re-declares a literal.
console.log('\ncreateUiStore — the Observer view prefs seed from the ObsUi namespace, never from re-declared defaults');
test('a fresh store seeds the four prefs from resetObsPrefDefaults() on a clean install (not local literals)', () => {
  reset();
  const s = createUiStore().getState();
  const d = resetObsPrefDefaults();
  assert.equal(s.observerViewMode, 'sessions');
  assert.deepEqual(s.observerActivityFilters, { type: 'all', agent: 'all', host: 'all' });
  assert.deepEqual(s.observerDirectiveFilters, { agent: 'all', host: 'all' });
  assert.deepEqual(s.observerAttentionFilters, { agent: 'all', host: 'all' });
  // The storage-owned factory is the source — every field of it, byte for byte.
  assert.deepEqual(
    [s.observerViewMode, s.observerActivityFilters, s.observerDirectiveFilters, s.observerAttentionFilters],
    [d.viewMode, d.activityFilters, d.directiveFilters, d.attentionFilters],
  );
});
test('a fresh store seeds the four prefs from the PERSISTED warden:observer:v1 payload when one exists', () => {
  reset();
  saveObs({
    openIds: ['s1'], activeId: 's1',
    viewMode: 'attention',
    activityFilters: { type: 'error', agent: 'claude', host: 'build-01' },
    directiveFilters: { agent: 'codex', host: 'web-02' },
    attentionFilters: { agent: 'gemini', host: '(local)' },
  });
  const s = createUiStore().getState();
  assert.equal(s.observerViewMode, 'attention');
  assert.deepEqual(s.observerActivityFilters, { type: 'error', agent: 'claude', host: 'build-01' });
  assert.deepEqual(s.observerDirectiveFilters, { agent: 'codex', host: 'web-02' });
  assert.deepEqual(s.observerAttentionFilters, { agent: 'gemini', host: '(local)' });
});
test('a payload that predates the filter fields (viewMode-era only) still seeds every shape from resetObsPrefDefaults', () => {
  reset();
  // The no-migration upgrade path storage.ts documents: a payload written
  // before WARDEN-879/971 loads the missing fields as undefined, and the
  // store's ??-only fallback supplies the defaults.
  saveObs({ openIds: ['s1'], activeId: 's1', viewMode: 'directives' });
  const s = createUiStore().getState();
  const d = resetObsPrefDefaults();
  assert.equal(s.observerViewMode, 'directives');
  assert.deepEqual(s.observerActivityFilters, d.activityFilters);
  assert.deepEqual(s.observerDirectiveFilters, d.directiveFilters);
  assert.deepEqual(s.observerAttentionFilters, d.attentionFilters);
});
test('an explicit seed overrides the persisted read (so a test needs no localStorage) — the UiStoreSeed addition', () => {
  reset();
  saveObs({
    openIds: ['s1'], activeId: 's1',
    viewMode: 'attention',
    activityFilters: { type: 'error', agent: 'claude', host: 'build-01' },
    directiveFilters: { agent: 'codex', host: 'web-02' },
    attentionFilters: { agent: 'gemini', host: '(local)' },
  });
  const s = createUiStore({
    observerViewMode: 'activity',
    observerActivityFilters: { type: 'chat', agent: 'all', host: 'all' },
    observerDirectiveFilters: { agent: 'all', host: 'db-03' },
    observerAttentionFilters: { agent: 'all', host: '(local)' },
  }).getState();
  assert.equal(s.observerViewMode, 'activity');
  assert.deepEqual(s.observerActivityFilters, { type: 'chat', agent: 'all', host: 'all' });
  assert.deepEqual(s.observerDirectiveFilters, { agent: 'all', host: 'db-03' });
  assert.deepEqual(s.observerAttentionFilters, { agent: 'all', host: '(local)' });
});

console.log("\nthe four Observer setters write the store, and they do NOT touch localStorage");
test('the setters replace the values, and a subscriber is notified (the SHARING channel ObserverTabs + App both read)', () => {
  reset();
  const store = createUiStore();
  const seen = [];
  const unsubscribe = store.subscribe((s) => seen.push([
    s.observerViewMode,
    { ...s.observerActivityFilters },
    { ...s.observerDirectiveFilters },
    { ...s.observerAttentionFilters },
  ]));
  store.getState().setObserverViewMode('activity');                                    // App's "View Activity"
  store.getState().setObserverActivityFilters({ type: 'error', agent: 'all', host: 'all' }); // the tab's type Select
  store.getState().setObserverDirectiveFilters({ agent: 'codex', host: 'all' });       // the tab's agent Select
  store.getState().setObserverAttentionFilters({ agent: 'all', host: 'web-02' });      // the tab's host Select
  unsubscribe();
  assert.deepEqual(seen, [
    ['activity', { type: 'all', agent: 'all', host: 'all' }, { agent: 'all', host: 'all' }, { agent: 'all', host: 'all' }],
    ['activity', { type: 'error', agent: 'all', host: 'all' }, { agent: 'all', host: 'all' }, { agent: 'all', host: 'all' }],
    ['activity', { type: 'error', agent: 'all', host: 'all' }, { agent: 'codex', host: 'all' }, { agent: 'all', host: 'all' }],
    ['activity', { type: 'error', agent: 'all', host: 'all' }, { agent: 'codex', host: 'all' }, { agent: 'all', host: 'web-02' }],
  ]);
  // After unsubscribing, a further write must not reach it.
  store.getState().setObserverViewMode('sessions');
  assert.equal(seen.length, 4);
});
test('the four setters alone write NOTHING to localStorage (single-writer: ObserverTabs\u2019 saveObs effect owns the write)', () => {
  reset();
  const store = createUiStore();
  store.getState().setObserverViewMode('activity');
  store.getState().setObserverActivityFilters({ type: 'error', agent: 'all', host: 'all' });
  store.getState().setObserverDirectiveFilters({ agent: 'codex', host: 'all' });
  store.getState().setObserverAttentionFilters({ agent: 'all', host: 'web-02' });
  // The store deliberately has no write-through persistence for the ObsUi
  // namespace: a second writer here would silently race the ONE compile-locked
  // saveObs effect (App's Settings-reset disk write is the only other site).
  assert.equal(mem.get('warden:observer:v1'), undefined);
});
test('the four action identities are stable across writes (safe in a React dep array, and in App\u2019s obsResetSetters map)', () => {
  reset();
  const store = createUiStore();
  const before = [
    store.getState().setObserverViewMode,
    store.getState().setObserverActivityFilters,
    store.getState().setObserverDirectiveFilters,
    store.getState().setObserverAttentionFilters,
  ];
  before[0]('activity');
  before[1]({ type: 'error', agent: 'all', host: 'all' });
  before[2]({ agent: 'codex', host: 'all' });
  before[3]({ agent: 'all', host: 'web-02' });
  assert.equal(store.getState().setObserverViewMode, before[0]);
  assert.equal(store.getState().setObserverActivityFilters, before[1]);
  assert.equal(store.getState().setObserverDirectiveFilters, before[2]);
  assert.equal(store.getState().setObserverAttentionFilters, before[3]);
});
test('DEAD-LINK REGRESSION (WARDEN-880): writing the same view mode the manual switch left behind STILL navigates', () => {
  reset();
  const store = createUiStore();
  // The retired prop channel could not do this: after the first deep-link the
  // prop was already 'activity', so the 2nd set was a React same-value bailout
  // (no re-render → no effect → the click navigated nowhere) until the consume
  // callback reset it to null. A store write is always a fresh transition the
  // subscriber re-renders from — deep-link, manual switch, deep-link again.
  store.getState().setObserverViewMode('activity');  // "View Activity" deep-link #1
  store.getState().setObserverViewMode('sessions');  // the human's manual tab switch
  assert.equal(store.getState().observerViewMode, 'sessions');
  store.getState().setObserverViewMode('activity');  // "View Activity" deep-link #2 — must win
  assert.equal(store.getState().observerViewMode, 'activity');
});
test('STALE-CLOSURE REGRESSION (the Clear-filters audit): two consecutive partial writes through the adapter pattern COMPOSE', () => {
  reset();
  // ObserverTabs’ seven spread-updater adapters are functional writes —
  // exactly the `(p) => ({ ...p, key: v })` shape below — because one handler
  // can fire TWO of them back-to-back: AttentionView’s clearFilters runs
  // `setHostFilter?.('all'); setAgentFilter?.('all')`. A spread of a
  // RENDER-captured shape (the first pass’s bug, caught in the WARDEN-1441
  // audit) let the second write silently restore the first key: from
  // {agent:'a1', host:'h1'}, clearFilters landed {agent:'all', host:'h1'} —
  // still filtered by host, still showing the empty state.
  const store = createUiStore({ observerAttentionFilters: { agent: 'a1', host: 'h1' } });
  // getState() re-reads before AND after: each set replaces the store’s
  // state object, so a snapshot held across the writes is itself stale — the
  // very failure mode this test pins, at one level up.
  store.getState().setObserverAttentionFilters((p) => ({ ...p, host: 'all' }));   // setHostFilter?.('all')
  store.getState().setObserverAttentionFilters((p) => ({ ...p, agent: 'all' }));  // setAgentFilter?.('all')
  assert.deepEqual(store.getState().observerAttentionFilters, { agent: 'all', host: 'all' });
});
test('the Settings-reset path snaps all four through the store-backed setters (the slice-15 shape of App\u2019s obsResetSetters sweep)', () => {
  reset();
  saveObs({
    openIds: ['s1'], activeId: 's1',
    viewMode: 'attention',
    activityFilters: { type: 'error', agent: 'claude', host: 'build-01' },
    directiveFilters: { agent: 'codex', host: 'web-02' },
    attentionFilters: { agent: 'gemini', host: '(local)' },
  });
  const store = createUiStore();
  // Exactly what App's reset callback does since slice 15: one
  // resetObsPrefDefaults() build, an ObsResetKey-keyed map of the same actions
  // the panel writes, and a sweep. (openIds/activeId stay component state and
  // ride through untouched — the disk half, resetObsPrefsPreservingWorkspace,
  // is storage.test.mjs's territory.)
  const d = resetObsPrefDefaults();
  const obsResetSetters = {
    viewMode: () => store.getState().setObserverViewMode(d.viewMode),
    activityFilters: () => store.getState().setObserverActivityFilters(d.activityFilters),
    directiveFilters: () => store.getState().setObserverDirectiveFilters(d.directiveFilters),
    attentionFilters: () => store.getState().setObserverAttentionFilters(d.attentionFilters),
  };
  for (const apply of Object.values(obsResetSetters)) apply();
  const s = store.getState();
  assert.equal(s.observerViewMode, d.viewMode);
  assert.deepEqual(s.observerActivityFilters, d.activityFilters);
  assert.deepEqual(s.observerDirectiveFilters, d.directiveFilters);
  assert.deepEqual(s.observerAttentionFilters, d.attentionFilters);
});
test('the four prefs are independent of the other migrated facts', () => {
  reset();
  const store = createUiStore({ observerViewMode: 'activity' });
  store.getState().setObserverActivityFilters({ type: 'error', agent: 'all', host: 'all' });
  assert.deepEqual(store.getState().snippets, STARTER_SNIPPETS);
  assert.equal(store.getState().agentFilter, 'all');
  assert.equal(store.getState().theme, 'system');
  assert.deepEqual(store.getState().paneColRatios, []);
  // …and writing one axis does not disturb the others.
  assert.equal(store.getState().observerViewMode, 'activity');
  store.getState().setObserverViewMode('directives');
  assert.deepEqual(store.getState().observerActivityFilters, { type: 'error', agent: 'all', host: 'all' });
  assert.equal(store.getState().theme, 'system');
});
test('two stores do not share the Observer prefs; the APP-LEVEL singleton is untouched', () => {
  reset();
  const a = createUiStore();
  const b = createUiStore();
  a.getState().setObserverViewMode('attention');
  a.getState().setObserverActivityFilters({ type: 'error', agent: 'all', host: 'all' });
  assert.equal(b.getState().observerViewMode, 'sessions');
  assert.deepEqual(b.getState().observerActivityFilters, { type: 'all', agent: 'all', host: 'all' });
  assert.equal(uiStore.getState().observerViewMode, 'sessions');
  assert.deepEqual(uiStore.getState().observerActivityFilters, { type: 'all', agent: 'all', host: 'all' });
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

console.log('\nstructural guard: the ObsUi namespace (warden:observer:v1) reads and writes through the same discipline');
test("'loadObs(' is read in exactly ONE component file — ObserverTabs.tsx — via exactly ONE call, the boot re-read (the ObsUi read-axis twin of the loadUi guard)", () => {
  // The invariant this guards (WARDEN-1397, client-state slice 10): the second
  // storage namespace is seeded ONCE per ObserverTabs mount — `const [obsSeed] =
  // useState(loadObs)` — and the only other sanctioned read is the boot effect's
  // deliberate post-refresh re-read (`const stored = loadObs();`), both inside
  // ObserverTabs.tsx. The pre-slice shape was 10 per-field lazy useState seeds,
  // each a separate JSON.parse of the same warden:observer:v1 document. The seed
  // rides as a BARE function reference — no call parens — so the literal
  // 'loadObs(' census counts exactly ONE occurrence in web/src/components/: the
  // boot re-read. Mutation-check (verified red): restoring any per-field lazy
  // seed that calls loadObs takes the occurrence count to 2 and turns the count
  // leg red; a read in any OTHER component file breaks the file-set leg.
  const walk = (dir) => {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(p));
      else out.push(p);
    }
    return out;
  };
  const readers = walk(join(__dirname, 'src', 'components'))
    .filter((p) => /\.(ts|tsx)$/.test(p))
    .filter((p) => readFileSync(p, 'utf8').includes('loadObs('));
  assert.deepEqual(
    readers.map((p) => p.slice(__dirname.length + 1)),
    ['src/components/ObserverTabs.tsx'],
    "component file(s) read ObsUi via loadObs( directly — ObserverTabs.tsx's single mount seed + boot re-read is the one sanctioned reader",
  );
  const occurrences = readFileSync(join(__dirname, 'src', 'components', 'ObserverTabs.tsx'), 'utf8').split('loadObs(').length - 1;
  assert.equal(
    occurrences,
    1,
    "ObserverTabs.tsx must hold exactly ONE loadObs( call — the boot effect's deliberate post-refresh re-read; the mount seed rides as the bare useState(loadObs) reference, so a second occurrence is a restored per-field lazy seed (the per-field re-parse shape slice 10 retired)",
  );
});

test("'saveObs(' lives in exactly TWO production call sites — ObserverTabs.tsx (the compile-locked save effect) + App.tsx (the Settings-reset disk write) — plus its storage.ts definition (the ObsUi write-axis twin of the saveUi guard)", () => {
  // The invariant this guards (WARDEN-832's "one writer per fact", applied to
  // the SECOND storage namespace; WARDEN-1397 slice 10): ObsUi has exactly two
  // writers, each with a distinct role — ObserverTabs' booted-gated saveObs
  // effect, the live-pref writer whose payload is now the `satisfies
  // Required<ObsUi>` compile-locked bag (so a field can only reach disk through
  // the bag), and App's reset write — `saveObs(resetObsPrefsPreservingWorkspace(
  // loadObs()))`, the disk half of Settings → Reset (WARDEN-981), deliberately
  // separated from the live half (see App's reset comment). Same file-set
  // convention as the saveUi guard above: storage.ts matches the pattern
  // because it holds the `export function saveObs(` definition itself, and
  // tests are excluded (all suites live in web/*.test.mjs, outside src/, but
  // the exclusion is kept defensive). Mutation-check (verified red): adding a
  // third saveObs( call site — e.g. a component writing ObsUi directly,
  // bypassing the bag — turns this leg red.
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
    .filter((p) => readFileSync(p, 'utf8').includes('saveObs('));
  assert.deepEqual(
    files.map((p) => p.slice(__dirname.length + 1)).sort(),
    ['src/App.tsx', 'src/components/ObserverTabs.tsx', 'src/lib/storage.ts'],
    "saveObs( must appear in exactly TWO production call sites (ObserverTabs.tsx's compile-locked save effect + App.tsx's Settings-reset disk write) plus its storage.ts definition — a third writer bypasses the Required<ObsUi> save bag",
  );
});

console.log(`\n✓ UI STORE TESTS PASS (${passed})`);
