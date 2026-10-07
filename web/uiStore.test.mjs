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
await emit('src/lib/layout.ts', 'layout.mjs');
await emit('src/lib/paneAttach.ts', 'paneAttach.mjs');
await emit('src/lib/uiStore.ts', 'uiStore.mjs', (c) => c.replaceAll('@/lib/storage', './storage.mjs').replaceAll('@/lib/layout', './layout.mjs').replaceAll('@/lib/paneAttach', './paneAttach.mjs').replaceAll('@/lib/themes', './themes.mjs'));
// WARDEN-1362: quickReply.ts is pure + dependency-free (its lone `import type` is
// erased at transpile — same harness quickReply.test.mjs uses), so it emits clean
// here too. The rewrite is a defensive no-op kept for shape parity with the above.
await emit('src/lib/quickReply.ts', 'quickReply.mjs', (c) => c.replaceAll('@/lib/storage', './storage.mjs'));

const { loadUi, saveUi, persistUiState, DEFAULT_UI, STARTER_SNIPPETS, resetUiPrefDefaults, DEFAULT_TERMINAL_FONT_FAMILY, saveObs, loadObs, resetObsPrefDefaults, OBS_RESET_KEYS, OBS_PRESERVED_KEYS, PERSISTED_PREF_KEYS, RESET_PRESERVED_KEYS } =
  await import(join(tmpDir, 'storage.mjs'));
const { createUiStore, uiStore, selectTerminalThemeId, selectActiveWorkspace, selectRecentlyClosed, selectOpenPanes, selectPersistedStorePrefs, STORE_PERSISTED_KEYS, RECENTLY_SAVED_TTL_MS, OBS_STORE_KEYS, selectPersistedObsPrefs } = await import(join(tmpDir, 'uiStore.mjs'));
const { SIDEBAR_MIN, SIDEBAR_MAX, OBSERVER_MIN, OBSERVER_MAX, PANE_MIN, HEALTH_WIDTH, clampObserverWidth, clampSidebarWidth } = await import(join(tmpDir, 'layout.mjs'));
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
// reading the store through `selectPersistedStorePrefs(store.getState())` here
// IS what the hook's useShallow(selectPersistedStorePrefs) subscription gives
// the merged PersistedPrefSnapshot (WARDEN-1471, slice 16 — the selector IS
// the production snapshot half, so this harness can no longer drift from it
// the way the hand-copied 31-field list it replaced could). `restoreOnStartup`
// defaults to the STORE's own value since WARDEN-1420 (slice 12) migrated that
// pref — App reads it through `useRestoreOnStartup()` and passes it to
// useConfigPersistence as persistUiState's separate argument — and an explicit
// override stays available for the empty-mode launch test below.
const flushSnapshotToDisk = (store, { restoreOnStartup, startedEmpty = false } = {}) => {
  const s = store.getState();
  // The store-owned half rides the PRODUCTION selector (the 39 STORE_PERSISTED_KEYS
  // facts, workspaces / activeWorkspaceId included since WARDEN-1526); the
  // `{...loadUi(), …}` open stands in for every DEFAULT_UI field the snapshot
  // always carried.
  const snapshot = {
    ...loadUi(),
    ...selectPersistedStorePrefs(s),
  };
  saveUi(persistUiState(snapshot, restoreOnStartup ?? store.getState().restoreOnStartup, loadUi(), startedEmpty));
};

// The ObsUi persistence hop useObsPersistence performs, called exactly as
// useObsPersistence.ts calls it (WARDEN-1477, slice 17 — the ObsUi twin of
// flushSnapshotToDisk above). `store` stands in for the hook's single
// useShallow(selectPersistedObsPrefs) subscription: reading the store through
// the PRODUCTION selector is what the hook merges, and the `{...loadObs(), …}`
// spread is the partial-bag guard itself — the disk document under the store
// prefs — so this harness cannot drift from the writer the way a hand-copied
// field list could.
const flushObsStoreToDisk = (store) => {
  saveObs({ ...loadObs(), ...selectPersistedObsPrefs(store.getState()) });
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

test("'saveObs(' lives in exactly THREE production call sites — useObsPersistence.ts (the always-mounted store-half writer) + ObserverTabs.tsx (the compile-locked booted-gated bag effect, the component half) + App.tsx (the Settings-reset disk write) — plus its storage.ts definition (the ObsUi write-axis twin of the saveUi guard)", () => {
  // The invariant this guards (WARDEN-832's "one writer per fact", applied to
  // the SECOND storage namespace; WARDEN-1397 slice 10): ObsUi has exactly
  // three writers, each with a distinct role — useObsPersistence's
  // always-mounted effect, the STORE-half writer slice 17 added
  // (WARDEN-1477: saveObs({ ...loadObs(), ...selectPersistedObsPrefs(...) }),
  // the four ObsUi view prefs persisted as a property of the store instead of
  // depending on ObserverTabs being mounted AND booted); ObserverTabs'
  // booted-gated saveObs effect, the COMPONENT-half writer whose payload is
  // the `satisfies Required<ObsUi>` compile-locked bag (so a field can only
  // reach disk through the bag; it also harmlessly re-asserts the four prefs
  // it already holds live store values for); and App's reset write —
  // `saveObs(resetObsPrefsPreservingWorkspace(loadObs()))`, the disk half of
  // Settings → Reset (WARDEN-981), deliberately separated from the live half
  // (see App's reset comment). Same file-set convention as the saveUi guard
  // above: storage.ts matches the pattern because it holds the `export
  // function saveObs(` definition itself, and tests are excluded (all suites
  // live in web/*.test.mjs, outside src/, but the exclusion is kept
  // defensive). Guard updated deliberately for slice 17 — TWO became THREE
  // when the always-mounted store-half writer landed. Mutation-check
  // (verified red): adding a FOURTH saveObs( call site — e.g. a component
  // writing ObsUi directly, bypassing the bag — turns this leg red.
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
    ['src/App.tsx', 'src/components/ObserverTabs.tsx', 'src/lib/storage.ts', 'src/lib/useObsPersistence.ts'],
    "saveObs( must appear in exactly THREE production call sites (useObsPersistence.ts's always-mounted store-half writer + ObserverTabs.tsx's compile-locked booted-gated bag effect + App.tsx's Settings-reset disk write) plus its storage.ts definition — a fourth writer bypasses the Required<ObsUi> save bag",
  );
});

console.log('\nObsUi store half (WARDEN-1477, slice 17): the four view prefs persist as a property of the store');
test('OBS_STORE_KEYS partitions the ObsUi prefs: no duplicates, every key a live store fact, and selectPersistedObsPrefs covers exactly OBS_RESET_KEYS', () => {
  // The ObsUi twin of the slice-16 STORE_PERSISTED_KEYS partition test. Three
  // legs:
  //
  //   1. NO DUPLICATES / LIVE FACTS — every OBS_STORE_KEYS element is a real,
  //      non-setter key on createUiStore().getState(), so the hook's selector
  //      and subscription can never read undefined or a function.
  //   2. COMPLETENESS + BIJECTION — selectPersistedObsPrefs' output carries
  //      EXACTLY the OBS_RESET_KEYS pref names (the four ObsUi prefs the
  //      always-mounted writer owns — no extras, none missing), and each
  //      output value IS the corresponding store fact, which pins the pairing
  //      direction (viewMode ↔ observerViewMode, …) at runtime where the
  //      transpiled module's types are gone.
  //   3. THE COMPONENT HALF STAYS OFF THE STORE — openIds/activeId are
  //      ObserverTabs' workspace state (OBS_PRESERVED_KEYS), meaningless
  //      before boot reconciliation; they must not appear on the store or in
  //      the selector's output, or the always-mounted writer would start
  //      persisting un-reconciled workspace facts.
  const storeKeys = [...OBS_STORE_KEYS];
  assert.equal(new Set(storeKeys).size, storeKeys.length, `OBS_STORE_KEYS holds a duplicate: ${storeKeys.join(', ')}`);
  const state = createUiStore().getState();
  for (const key of storeKeys) {
    assert.ok(key in state, `OBS_STORE_KEYS member '${key}' does not exist on createUiStore().getState()`);
    assert.ok(typeof state[key] !== 'function', `OBS_STORE_KEYS member '${key}' resolved to a function on the store state — the tuple must name FACTS (values), not setters`);
  }
  reset();
  const fresh = createUiStore().getState();
  const selected = selectPersistedObsPrefs(fresh);
  assert.deepEqual(
    Object.keys(selected).sort(),
    [...OBS_RESET_KEYS].sort(),
    'selectPersistedObsPrefs must cover exactly the OBS_RESET_KEYS prefs — a missing one would not persist (the dropped-key class), an extra one is not an ObsUi pref',
  );
  assert.equal(selected.viewMode, fresh.observerViewMode, 'selector pairing broken: viewMode must read observerViewMode');
  assert.equal(selected.activityFilters, fresh.observerActivityFilters, 'selector pairing broken: activityFilters must read observerActivityFilters');
  assert.equal(selected.directiveFilters, fresh.observerDirectiveFilters, 'selector pairing broken: directiveFilters must read observerDirectiveFilters');
  assert.equal(selected.attentionFilters, fresh.observerAttentionFilters, 'selector pairing broken: attentionFilters must read observerAttentionFilters');
  assert.deepEqual([...OBS_PRESERVED_KEYS].sort(), ['activeId', 'openIds'], 'OBS_PRESERVED_KEYS must stay exactly the two workspace facts — the reset-vs-preserve partition storage.ts owns');
  for (const workspaceKey of OBS_PRESERVED_KEYS) {
    assert.ok(!(workspaceKey in state), `workspace fact '${workspaceKey}' must stay component-local (ObserverTabs') — it is not a store fact and the always-mounted writer must never persist it`);
    assert.ok(!(workspaceKey in selected), `workspace fact '${workspaceKey}' leaked into selectPersistedObsPrefs' output — the store-half writer would clobber boot reconciliation`);
  }
});

test('MODE 1 (WARDEN-1477): a store write with NO ObserverTabs mounted survives a restart — the measured defect closes, with the ui:v3 controls on the same store', () => {
  // The regression test for the probe that measured the defect: App's
  // "View Activity" deep-link (openActivityTab) writes setObserverViewMode
  // from App itself — with the Settings ternary's full-page switch having
  // unmounted ObserverTabs, so NO component-half writer exists. There is no
  // React runner here, so the hop is driven by its PURE parts, exactly as
  // this file's header states: the store writes, then the always-mounted
  // writer's effect hop (flushObsStoreToDisk — the exact calls
  // useObsPersistence.ts makes), then a FRESH store as the restart.
  // terminalFontSize/timestampFormat ride the SAME store through the warden:ui:v3
  // hop as the CONTROLS: they are store facts written through the identical
  // gesture in the identical harness, so a passing pair proves the
  // instrument persists a store write — a failed ObsUi pair is then a
  // measurement, not a broken probe.
  reset();
  const store = createUiStore();
  // App's own writes — no ObserverTabs anywhere in this story.
  store.getState().setTerminalFontSize(19);                       // CONTROL 1 (warden:ui:v3)
  store.getState().setTimestampFormat('absolute');                // CONTROL 2 (warden:ui:v3)
  store.getState().setObserverViewMode('activity');               // TARGET 1
  store.getState().setObserverActivityFilters({ type: 'task', agent: 'claude-1', host: 'h1' }); // TARGET 2
  flushSnapshotToDisk(store);   // useConfigPersistence's effect hop
  flushObsStoreToDisk(store);   // useObsPersistence's effect hop (the fix under test)
  // Restart: a fresh store seeds from loadUi() + loadObs().
  const restarted = createUiStore();
  assert.equal(restarted.getState().terminalFontSize, 19, 'CONTROL 1 lost — the probe is broken, not the fix');
  assert.equal(restarted.getState().timestampFormat, 'absolute', 'CONTROL 2 lost — the probe is broken, not the fix');
  assert.equal(restarted.getState().observerViewMode, 'activity', 'TARGET 1 lost across restart — the always-mounted ObsUi writer is not persisting the store half');
  assert.deepEqual(
    restarted.getState().observerActivityFilters,
    { type: 'task', agent: 'claude-1', host: 'h1' },
    'TARGET 2 lost across restart — the always-mounted ObsUi writer is not persisting the store half',
  );
});

test('MODE 2 (WARDEN-1477): the write also survives with the panel mounted but UNBOOTED, and the store-half writer writes ONLY the four prefs', () => {
  // MODE 2's real-world shape: ObserverTabs IS in the tree, but its
  // booted-gated effect never fires (the boot create-failure branch returns
  // without setting `booted`). In the harness the component half is simply
  // ABSENT — no componentHalfWrite is ever performed — which is exactly the
  // unbooted panel's behaviour. Two assertions beyond MODE 1:
  //   1. the pref write still survives (the always-mounted writer is the
  //      only writer and it is enough);
  //   2. the store-half writer NEVER fabricates workspace state — the disk
  //      document's openIds/activeId ride through from loadObs() untouched
  //      (here: the all-defaults document), so a boot-less panel cannot
  //      leak un-reconciled openIds into storage.
  reset();
  const store = createUiStore();
  store.getState().setObserverViewMode('attention');
  store.getState().setObserverDirectiveFilters({ agent: 'codex-1', host: 'h2' });
  flushObsStoreToDisk(store);
  const onDisk = JSON.parse(localStorage.getItem('warden:observer:v1'));
  assert.equal(onDisk.viewMode, 'attention');
  assert.deepEqual(onDisk.directiveFilters, { agent: 'codex-1', host: 'h2' });
  assert.deepEqual(onDisk.openIds, [], "the store-half writer fabricated openIds — workspace state must stay ObserverTabs's to reconcile at boot");
  assert.equal(onDisk.activeId, null, "the store-half writer fabricated activeId — workspace state must stay ObserverTabs's to reconcile at boot");
  // The restart still reads the pref back.
  assert.equal(createUiStore().getState().observerViewMode, 'attention');
});

test('the two ObsUi writers interleave without clobbering (WARDEN-1477): the store half preserves the component half and vice versa', () => {
  // The partial-bag hazard this slice was told not to create, proved from
  // both directions. saveObs writes the WHOLE warden:observer:v1 document,
  // so whichever writer runs second must carry the other half's facts:
  //   - the store half by merging over loadObs() (useObsPersistence.ts);
  //   - the component half because its `satisfies Required<ObsUi>` bag reads
  //     all four prefs LIVE from the store on every render (ObserverTabs'
  //     four useObserver*() subscriptions), so a whole-document write
  //     re-asserts the current prefs, never stale ones.
  reset();
  const store = createUiStore();

  // The component half, simulated exactly as ObserverTabs' booted-gated
  // effect writes it: workspace facts from its own state, prefs from its
  // live store subscriptions.
  const componentHalfWrite = (openIds, activeId) => {
    saveObs({ openIds, activeId, ...selectPersistedObsPrefs(store.getState()) });
  };
  const disk = () => JSON.parse(localStorage.getItem('warden:observer:v1'));

  // 1. A store-half write lands (still no workspace on disk).
  store.getState().setObserverViewMode('activity');
  flushObsStoreToDisk(store);
  assert.equal(disk().viewMode, 'activity');

  // 2. The component half writes (boot reconciliation: two tabs, first
  //    active). Its whole-document write must not clobber the pref.
  componentHalfWrite(['s1', 's2'], 's1');
  assert.deepEqual(disk().openIds, ['s1', 's2']);
  assert.equal(disk().activeId, 's1');
  assert.equal(disk().viewMode, 'activity', 'the component-half write clobbered viewMode');

  // 3. A store-half write lands AFTER the component half — the direction
  //    that motivated the loadObs() merge: the pref change must not clobber
  //    the reconciled workspace.
  store.getState().setObserverActivityFilters({ type: 'incident', agent: 'all', host: 'all' });
  flushObsStoreToDisk(store);
  assert.deepEqual(
    disk().activityFilters,
    { type: 'incident', agent: 'all', host: 'all' },
    'the store-half write did not land',
  );
  assert.deepEqual(disk().openIds, ['s1', 's2'], 'the store-half write clobbered openIds');
  assert.equal(disk().activeId, 's1', 'the store-half write clobbered activeId');
  assert.equal(disk().viewMode, 'activity', 'the store-half write clobbered viewMode');

  // 4. The component half writes again (a tab closed) — prefs stay intact.
  componentHalfWrite(['s2'], 's2');
  assert.deepEqual(disk().openIds, ['s2']);
  assert.equal(disk().activeId, 's2');
  assert.equal(disk().viewMode, 'activity', 'the component-half write clobbered viewMode');
  assert.deepEqual(disk().activityFilters, { type: 'incident', agent: 'all', host: 'all' }, 'the component-half write clobbered activityFilters');
});

console.log('\nstructural guard: the store / App ownership partition of PERSISTED_PREF_KEYS (WARDEN-1471, slice 16)');
test('STORE_PERSISTED_KEYS partitions PERSISTED_PREF_KEYS: no duplicates, every key persisted-shaped, every key live on the store', () => {
  // The invariant this guards: the store-owned half of the persisted snapshot
  // is declared ONCE (STORE_PERSISTED_KEYS in uiStore.ts) and every consumer
  // — useConfigPersistence's subscription, the merged PersistedPrefSnapshot,
  // and this file's flushSnapshotToDisk — derives from it. Three legs, each
  // catching a different corruption:
  //
  //   1. NO DUPLICATES — a repeated element would make the selector (and the
  //      dep array inside the hook) carry the same fact twice, silently.
  //   2. PERSISTED-SHAPE — every STORE key must be a PERSISTED_PREF_KEYS
  //      member, so a key that persists elsewhere (the four ObsUi observer
  //      facts via ObserverTabs' saveObs; restoreOnStartup via persistUiState's
  //      separate argument) cannot sneak in. `satisfies` enforces this at
  //      compile time; this leg re-states it at runtime because this harness
  //      runs the TRANSPILED module where types are gone.
  //   3. LIVE ON THE STORE — every STORE key must exist on
  //      createUiStore().getState(), so the selector and the hook can never
  //      select a key the store does not carry.
  //
  // A key REMOVED from STORE_PERSISTED_KEYS is caught on the other side, by
  // tsc: useConfigPersistence's snapshot (typed PersistedPrefSnapshot =
  // Required<Pick<…PERSISTED_PREF_KEYS>>) then misses a REQUIRED property —
  // since slice 23 (WARDEN-1526) the store owns EVERY persisted fact, so there
  // is no App-owned half left.
  // What this test adds is the runtime half of the same fence — the harness
  // here has no typechecker to lean on.
  const persistedKeys = new Set(PERSISTED_PREF_KEYS);
  const storeKeys = [...STORE_PERSISTED_KEYS];
  assert.equal(
    new Set(storeKeys).size,
    storeKeys.length,
    `STORE_PERSISTED_KEYS holds a duplicate: ${storeKeys.join(', ')}`,
  );
  const state = createUiStore().getState();
  for (const key of storeKeys) {
    assert.ok(
      persistedKeys.has(key),
      `STORE_PERSISTED_KEYS member '${key}' is not a PERSISTED_PREF_KEYS key — facts persisted outside the saveUi snapshot (the ObsUi observer facts via saveObs; restoreOnStartup via persistUiState's argument) must not ride the store-owned snapshot half`,
    );
    assert.ok(
      key in state,
      `STORE_PERSISTED_KEYS member '${key}' does not exist on createUiStore().getState() — the selector and the hook would read undefined`,
    );
    assert.ok(
      typeof state[key] !== 'function',
      `STORE_PERSISTED_KEYS member '${key}' resolved to a function on the store state — the tuple must name FACTS (values), not setters`,
    );
  }
  // The partition itself, stated as the union the two halves compose: every
  // persisted key is owned by exactly one side, so the store half plus the
  // complement reconstructs the full persisted key set.
  const union = new Set([...storeKeys, ...persistedKeys]);
  assert.equal(union.size, persistedKeys.size);
  assert.deepEqual(
    union,
    persistedKeys,
    'STORE_PERSISTED_KEYS ∪ (PERSISTED_PREF_KEYS − STORE_PERSISTED_KEYS) must reconstruct PERSISTED_PREF_KEYS',
  );
});

// ─── sourceControlCollapsed (WARDEN-1486, roadmap WARDEN-1204 slice 18) ───
//
// The sidebar's Source Control section collapse — the LAST cross-component
// persisted prop pair (App useState → ChatSidebar props + a `?? (() => {})`
// silent no-op fallback). ChatSidebar now subscribes to the store directly.
// storage.ts still owns shape/default/sanitizer/RESET_PRESERVED_KEYS.
console.log('\ncreateUiStore — sourceControlCollapsed seeds from storage.ts, never from a re-declared default');
test('a fresh store seeds sourceControlCollapsed from DEFAULT_UI (collapsed, WARDEN-1422)', () => {
  reset();
  const s = createUiStore().getState();
  assert.equal(s.sourceControlCollapsed, true);
  assert.equal(s.sourceControlCollapsed, DEFAULT_UI.sourceControlCollapsed);
});
test('a fresh store seeds from the PERSISTED payload; an explicit seed overrides it', () => {
  reset();
  saveUi({ ...loadUi(), sourceControlCollapsed: false });
  assert.equal(createUiStore().getState().sourceControlCollapsed, false);
  assert.equal(createUiStore({ sourceControlCollapsed: true }).getState().sourceControlCollapsed, true);
});
test('setSourceControlCollapsed toggles the fact, notifies subscribers, and writes NOTHING to localStorage', () => {
  reset();
  const store = createUiStore();
  const seen = [];
  const unsubscribe = store.subscribe((s) => seen.push(s.sourceControlCollapsed));
  store.getState().setSourceControlCollapsed(false);
  store.getState().setSourceControlCollapsed(true);
  unsubscribe();
  assert.deepEqual(seen, [false, true]);
  assert.equal(mem.get('warden:ui:v3'), undefined, 'single-writer: the saveUi effect owns the write');
});
test('the setter identity is stable across writes (safe in a React dep array)', () => {
  reset();
  const store = createUiStore();
  const before = store.getState().setSourceControlCollapsed;
  before(false);
  assert.equal(store.getState().setSourceControlCollapsed, before);
});
test("sourceControlCollapsed joins STORE_PERSISTED_KEYS (39 keys) and rides selectPersistedStorePrefs", () => {
  reset();
  assert.ok(STORE_PERSISTED_KEYS.includes('sourceControlCollapsed'));
  assert.equal(STORE_PERSISTED_KEYS.length, 39);
  const store = createUiStore({ sourceControlCollapsed: false });
  const picked = selectPersistedStorePrefs(store.getState());
  assert.equal(Object.keys(picked).length, 39);
  assert.equal(picked.sourceControlCollapsed, false);
});

console.log('\nround trip: ChatSidebar toggle → store → snapshot → the saveUi effect → loadUi');
test('an expanded panel survives a restart through the production hop', () => {
  reset();
  const store = createUiStore();
  assert.equal(store.getState().sourceControlCollapsed, true);
  store.getState().setSourceControlCollapsed(false);
  flushSnapshotToDisk(store);
  assert.equal(loadUi().sourceControlCollapsed, false);
  assert.equal(createUiStore().getState().sourceControlCollapsed, false);
});
test('the UI-prefs reset PRESERVES the collapse (RESET_PRESERVED_KEYS, storage.ts untouched)', () => {
  reset();
  const defaults = resetUiPrefDefaults();
  assert.ok(!('sourceControlCollapsed' in defaults), 'sourceControlCollapsed must stay in RESET_PRESERVED_KEYS — a defaults entry means it left the preserved set');
  const store = createUiStore({ sourceControlCollapsed: false });
  const s = store.getState();
  s.setTheme(defaults.theme);
  flushSnapshotToDisk(store);
  assert.equal(loadUi().sourceControlCollapsed, false);
});

// ─── paneHost (WARDEN-1498, roadmap WARDEN-1204 slice 19) ───
//
// The pane → host map: App useState + five inline idempotent-merge ternaries +
// a PaneGrid prop → one store fact with ONE idempotent action. The seed goes
// THROUGH initialWorkspace so "Start empty" boots with {}.
console.log('\ncreateUiStore — paneHost: one idempotent writer');
test('primePaneHost is idempotent: the same pair twice leaves paneHost referentially identical and notifies nobody', () => {
  reset();
  const store = createUiStore();
  store.getState().primePaneHost('p1', 'hostA');
  const before = store.getState().paneHost;
  const stateBefore = store.getState();
  let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications++; });
  store.getState().primePaneHost('p1', 'hostA');
  unsubscribe();
  assert.equal(store.getState().paneHost, before, 'same map identity (===)');
  assert.equal(store.getState(), stateBefore, 'same state object — zustand skips the notification');
  assert.equal(notifications, 0);
});
test('a different host for the same pane id replaces it; other ids survive', () => {
  reset();
  const store = createUiStore({ paneHost: { a: 'h1', b: 'h2' } });
  store.getState().primePaneHost('a', 'h9');
  assert.deepEqual(store.getState().paneHost, { a: 'h9', b: 'h2' });
  store.getState().primePaneHost('c', 'h3');
  assert.deepEqual(store.getState().paneHost, { a: 'h9', b: 'h2', c: 'h3' });
});
test('primePaneHost never mutates the previous map in place (new identity on change)', () => {
  reset();
  const store = createUiStore({ paneHost: { a: 'h1' } });
  const prev = store.getState().paneHost;
  store.getState().primePaneHost('a', 'h2');
  assert.notEqual(store.getState().paneHost, prev);
  assert.deepEqual(prev, { a: 'h1' });
});
test('the primePaneHost action identity is stable across writes (safe in a React dep array)', () => {
  reset();
  const store = createUiStore();
  const before = store.getState().primePaneHost;
  before('x', 'h');
  assert.equal(store.getState().primePaneHost, before);
});
test('primePaneHost writes NOTHING to localStorage (the saveUi effect owns the write)', () => {
  reset();
  const store = createUiStore();
  store.getState().primePaneHost('x', 'h');
  assert.equal(mem.get('warden:ui:v3'), undefined);
});

console.log('\ncreateUiStore — paneHost seeds through initialWorkspace (the "Start empty" trap)');
test("persisted paneHost seeds under restoreOnStartup 'previous'", () => {
  reset();
  saveUi({ ...loadUi(), paneHost: { a: 'h' }, restoreOnStartup: 'previous' });
  assert.deepEqual(createUiStore().getState().paneHost, { a: 'h' });
});
test("persisted paneHost does NOT seed under restoreOnStartup 'empty' (boots with {})", () => {
  reset();
  saveUi({ ...loadUi(), paneHost: { a: 'h' }, restoreOnStartup: 'empty' });
  assert.equal(loadUi().restoreOnStartup, 'empty', 'precondition: the disk pref is empty');
  assert.deepEqual(createUiStore().getState().paneHost, {});
});
test("an explicit restoreOnStartup seed steers the paneHost seed; an explicit paneHost seed wins outright", () => {
  reset();
  saveUi({ ...loadUi(), paneHost: { a: 'h' }, restoreOnStartup: 'previous' });
  assert.deepEqual(createUiStore({ restoreOnStartup: 'empty' }).getState().paneHost, {});
  assert.deepEqual(createUiStore({ paneHost: { z: 'q' } }).getState().paneHost, { z: 'q' });
});
test('a clean install seeds paneHost as {}', () => {
  reset();
  assert.deepEqual(createUiStore().getState().paneHost, {});
});

console.log('\ncreateUiStore — paneHost joins STORE_PERSISTED_KEYS (39) and rides the selector');
test('paneHost is a STORE_PERSISTED_KEYS member and selectPersistedStorePrefs carries it', () => {
  reset();
  assert.ok(STORE_PERSISTED_KEYS.includes('paneHost'));
  assert.equal(STORE_PERSISTED_KEYS.length, 39);
  const store = createUiStore({ paneHost: { a: 'h' } });
  const picked = selectPersistedStorePrefs(store.getState());
  assert.equal(Object.keys(picked).length, 39);
  assert.deepEqual(picked.paneHost, { a: 'h' });
});

console.log('\nround trip: primePaneHost → store → snapshot → the saveUi effect → loadUi');
test('a primed host survives a restart through the production hop', () => {
  reset();
  const store = createUiStore();
  store.getState().primePaneHost('p1', 'hostA');
  flushSnapshotToDisk(store);
  assert.deepEqual(loadUi().paneHost, { p1: 'hostA' });
  assert.deepEqual(createUiStore().getState().paneHost, { p1: 'hostA' });
});
test("a 'Start empty' launch boots with {} yet persistUiState's startedEmpty freeze keeps the DISK map", () => {
  reset();
  saveUi({ ...loadUi(), paneHost: { a: 'h' }, restoreOnStartup: 'empty' });
  const store = createUiStore();
  assert.deepEqual(store.getState().paneHost, {});
  // a pane opened in this empty session primes a host; the freeze must still
  // leave the on-disk map untouched
  store.getState().primePaneHost('n', 'newhost');
  flushSnapshotToDisk(store, { startedEmpty: true });
  assert.deepEqual(loadUi().paneHost, { a: 'h' });
});
test('the UI-prefs reset PRESERVES paneHost (RESET_PRESERVED_KEYS, storage.ts untouched)', () => {
  reset();
  const defaults = resetUiPrefDefaults();
  assert.ok(!('paneHost' in defaults), 'paneHost must stay in RESET_PRESERVED_KEYS');
  const store = createUiStore({ paneHost: { a: 'h' } });
  store.getState().setTheme(defaults.theme);
  flushSnapshotToDisk(store);
  assert.deepEqual(loadUi().paneHost, { a: 'h' });
});

console.log('\ncreateUiStore — watchedChats (WARDEN-1506, roadmap WARDEN-1204 slice 20)');
test('watchedChats seeds [] on a clean install, from the persisted payload, and seed wins', () => {
  reset();
  assert.deepEqual(createUiStore().getState().watchedChats, []);
  saveUi({ ...loadUi(), watchedChats: ['a', 'b'] });
  assert.deepEqual(createUiStore().getState().watchedChats, ['a', 'b']);
  assert.deepEqual(createUiStore({ watchedChats: ['z'] }).getState().watchedChats, ['z']);
});
test('setWatchedChats replaces the set and keeps a stable identity', () => {
  reset();
  const store = createUiStore();
  const before = store.getState().setWatchedChats;
  before(['k1', 'k2']);
  assert.deepEqual(store.getState().watchedChats, ['k1', 'k2']);
  assert.equal(store.getState().setWatchedChats, before);
});
test('watchedChats is a STORE_PERSISTED_KEYS member and selectPersistedStorePrefs carries it', () => {
  reset();
  assert.ok(STORE_PERSISTED_KEYS.includes('watchedChats'));
  assert.equal(STORE_PERSISTED_KEYS.length, 39);
  const store = createUiStore({ watchedChats: ['w'] });
  const picked = selectPersistedStorePrefs(store.getState());
  assert.equal(Object.keys(picked).length, 39);
  assert.deepEqual(picked.watchedChats, ['w']);
});
test('a watched set survives a restart through the production hop; [] persists as []', () => {
  reset();
  const store = createUiStore();
  store.getState().setWatchedChats(['p1', 'p2']);
  flushSnapshotToDisk(store);
  assert.deepEqual(loadUi().watchedChats, ['p1', 'p2']);
  assert.deepEqual(createUiStore().getState().watchedChats, ['p1', 'p2']);
  store.getState().setWatchedChats([]);
  flushSnapshotToDisk(store);
  assert.deepEqual(loadUi().watchedChats, []);
  assert.deepEqual(createUiStore().getState().watchedChats, []);
});
test('the UI-prefs reset CLEARS watchedChats (not in RESET_PRESERVED_KEYS)', () => {
  reset();
  const defaults = resetUiPrefDefaults();
  assert.ok('watchedChats' in defaults, 'watchedChats must stay resettable');
  assert.deepEqual(defaults.watchedChats, []);
  const store = createUiStore({ watchedChats: ['a'] });
  store.getState().setWatchedChats(defaults.watchedChats);
  flushSnapshotToDisk(store);
  assert.deepEqual(loadUi().watchedChats, []);
});

console.log('\ncreateUiStore — panel-collapse flags (WARDEN-1510, roadmap WARDEN-1204 slice 21)');
const COLLAPSE_KEYS = ['sidebarCollapsed', 'observerCollapsed', 'healthCollapsed'];
test('a fresh store seeds the three flags equal to DEFAULT_UI (health starts collapsed)', () => {
  reset();
  const s = createUiStore().getState();
  for (const k of COLLAPSE_KEYS) assert.equal(s[k], DEFAULT_UI[k], `${k} must mirror DEFAULT_UI`);
  assert.equal(s.sidebarCollapsed, false);
  assert.equal(s.observerCollapsed, false);
  assert.equal(s.healthCollapsed, true);
});
test('a persisted payload seeds the flags; healthCollapsed absent -> true; seed wins', () => {
  reset();
  saveUi({ ...loadUi(), sidebarCollapsed: true, observerCollapsed: true, healthCollapsed: false });
  const s = createUiStore().getState();
  assert.equal(s.sidebarCollapsed, true);
  assert.equal(s.observerCollapsed, true);
  assert.equal(s.healthCollapsed, false);
  reset();
  mem.set('warden:ui:v3', JSON.stringify({ activeTabs: ['x'], sidebarCollapsed: true }));
  const t = createUiStore().getState();
  assert.equal(t.sidebarCollapsed, true);
  assert.equal(t.observerCollapsed, false);
  assert.equal(t.healthCollapsed, true, 'absent healthCollapsed seeds true');
  const o = createUiStore({ sidebarCollapsed: false, healthCollapsed: false }).getState();
  assert.equal(o.sidebarCollapsed, false);
  assert.equal(o.healthCollapsed, false);
});
test('toggleSidebarCollapsed / toggleObserverCollapsed flip atomically; twice -> original', () => {
  reset();
  const store = createUiStore();
  const { toggleSidebarCollapsed, toggleObserverCollapsed } = store.getState();
  toggleSidebarCollapsed();
  toggleSidebarCollapsed(); // back-to-back: functional, no stale read
  assert.equal(store.getState().sidebarCollapsed, false);
  toggleSidebarCollapsed();
  assert.equal(store.getState().sidebarCollapsed, true);
  assert.equal(store.getState().observerCollapsed, false, 'toggling one leaves the other alone');
  toggleObserverCollapsed();
  assert.equal(store.getState().observerCollapsed, true);
  toggleObserverCollapsed();
  assert.equal(store.getState().observerCollapsed, false);
  assert.equal(store.getState().toggleSidebarCollapsed, toggleSidebarCollapsed, 'stable identity');
});
test('the three flags join STORE_PERSISTED_KEYS (39) and ride selectPersistedStorePrefs', () => {
  reset();
  for (const k of COLLAPSE_KEYS) assert.ok(STORE_PERSISTED_KEYS.includes(k), k);
  assert.equal(STORE_PERSISTED_KEYS.length, 39);
  const picked = selectPersistedStorePrefs(createUiStore().getState());
  assert.equal(Object.keys(picked).length, 39);
});
test('each flag round-trips store -> snapshot -> saveUi -> loadUi -> a fresh store', () => {
  reset();
  const store = createUiStore();
  store.getState().setSidebarCollapsed(true);
  store.getState().setObserverCollapsed(true);
  store.getState().setHealthCollapsed(false);
  flushSnapshotToDisk(store);
  const disk = loadUi();
  assert.equal(disk.sidebarCollapsed, true);
  assert.equal(disk.observerCollapsed, true);
  assert.equal(disk.healthCollapsed, false);
  const next = createUiStore().getState();
  assert.equal(next.sidebarCollapsed, true);
  assert.equal(next.observerCollapsed, true);
  assert.equal(next.healthCollapsed, false);
  // and a toggle (the Alt+S path) persists too
  store.getState().toggleSidebarCollapsed();
  flushSnapshotToDisk(store);
  assert.equal(loadUi().sidebarCollapsed, false);
});
test('the UI-prefs reset PRESERVES all three (RESET_PRESERVED_KEYS, storage.ts untouched)', () => {
  reset();
  const defaults = resetUiPrefDefaults();
  for (const k of COLLAPSE_KEYS) assert.ok(!(k in defaults), `${k} must stay in RESET_PRESERVED_KEYS`);
  const store = createUiStore({ sidebarCollapsed: true, observerCollapsed: true, healthCollapsed: false });
  store.getState().setTheme(defaults.theme);
  flushSnapshotToDisk(store);
  const disk = loadUi();
  assert.equal(disk.sidebarCollapsed, true);
  assert.equal(disk.observerCollapsed, true);
  assert.equal(disk.healthCollapsed, false);
});

// ---------------------------------------------------------------------------
// WARDEN-1516 (roadmap WARDEN-1204 slice 22): sidebarWidth / observerWidth + the
// store-owned collapse-aware reclampPanelWidths action. The pure clamp math is
// layout.test.mjs's; here: seeding/defaults, setters, persistence, the reset
// preservation, and the ACTION (reads the store's own collapse flags, ONE set).
// ---------------------------------------------------------------------------
console.log('\nWARDEN-1516 — panel widths on the store + reclampPanelWidths');
const WIDTH_KEYS = ['sidebarWidth', 'observerWidth'];
const midOf = (win, st) =>
  win - (st.sidebarCollapsed ? 0 : st.sidebarWidth) - (st.observerCollapsed ? 0 : st.observerWidth) - (st.healthCollapsed ? 0 : HEALTH_WIDTH);

test('defaults mirror DEFAULT_UI (220 / 380) on a clean install, pinned against storage.ts', () => {
  reset();
  const s = createUiStore().getState();
  assert.equal(s.sidebarWidth, 220);
  assert.equal(s.observerWidth, 380);
  assert.equal(s.sidebarWidth, DEFAULT_UI.sidebarWidth);
  assert.equal(s.observerWidth, DEFAULT_UI.observerWidth);
});
test('seeds from the persisted payload, and an explicit seed wins over it', () => {
  reset();
  saveUi({ ...loadUi(), sidebarWidth: 260, observerWidth: 450 });
  const s = createUiStore().getState();
  assert.equal(s.sidebarWidth, 260);
  assert.equal(s.observerWidth, 450);
  const o = createUiStore({ sidebarWidth: 190, observerWidth: 310 }).getState();
  assert.equal(o.sidebarWidth, 190);
  assert.equal(o.observerWidth, 310);
});
test('the seed is NOT clamped at creation (the first-paint clamp is an explicit action call)', () => {
  reset();
  const s = createUiStore({ sidebarWidth: 400, observerWidth: 600 }).getState();
  assert.equal(s.sidebarWidth, 400);
  assert.equal(s.observerWidth, 600);
});
test('setters write one width each, with stable identity', () => {
  reset();
  const store = createUiStore();
  const { setSidebarWidth, setObserverWidth } = store.getState();
  setSidebarWidth(250);
  assert.equal(store.getState().sidebarWidth, 250);
  assert.equal(store.getState().observerWidth, 380, 'the other width is untouched');
  setObserverWidth(500);
  assert.equal(store.getState().observerWidth, 500);
  assert.equal(store.getState().setSidebarWidth, setSidebarWidth);
  assert.equal(store.getState().setObserverWidth, setObserverWidth);
});
test('both widths join STORE_PERSISTED_KEYS (39) and ride selectPersistedStorePrefs', () => {
  reset();
  for (const k of WIDTH_KEYS) assert.ok(STORE_PERSISTED_KEYS.includes(k), k);
  assert.equal(STORE_PERSISTED_KEYS.length, 39);
  const picked = selectPersistedStorePrefs(createUiStore({ sidebarWidth: 233, observerWidth: 411 }).getState());
  assert.equal(Object.keys(picked).length, 39);
  assert.equal(picked.sidebarWidth, 233);
  assert.equal(picked.observerWidth, 411);
});
test('both widths round-trip store -> production selector -> saveUi -> loadUi -> a fresh store', () => {
  reset();
  const store = createUiStore();
  store.getState().setSidebarWidth(275);
  store.getState().setObserverWidth(520);
  flushSnapshotToDisk(store);
  const disk = loadUi();
  assert.equal(disk.sidebarWidth, 275);
  assert.equal(disk.observerWidth, 520);
  const next = createUiStore().getState();
  assert.equal(next.sidebarWidth, 275);
  assert.equal(next.observerWidth, 520);
});
test('the UI-prefs reset PRESERVES both widths (RESET_PRESERVED_KEYS, storage.ts untouched)', () => {
  reset();
  const defaults = resetUiPrefDefaults();
  for (const k of WIDTH_KEYS) assert.ok(!(k in defaults), `${k} must stay in RESET_PRESERVED_KEYS`);
  const store = createUiStore({ sidebarWidth: 300, observerWidth: 450 });
  store.getState().setTheme(defaults.theme);
  flushSnapshotToDisk(store);
  assert.equal(loadUi().sidebarWidth, 300);
  assert.equal(loadUi().observerWidth, 450);
});
test('reclampPanelWidths is a no-op when the window has room for everything', () => {
  reset();
  const store = createUiStore();
  store.getState().reclampPanelWidths(1400);
  assert.equal(store.getState().sidebarWidth, 220);
  assert.equal(store.getState().observerWidth, 380);
});
test('reclampPanelWidths: first-paint clamp trims defaults at the 900px floor (sidebar yields first)', () => {
  reset();
  const store = createUiStore();
  store.getState().reclampPanelWidths(900);
  assert.equal(store.getState().sidebarWidth, 200, 'asymmetric trim: sidebar 220 -> 200');
  assert.equal(store.getState().observerWidth, 380);
  assert.equal(midOf(900, store.getState()), PANE_MIN);
});
test('reclampPanelWidths: a stale both-max pair is trimmed asymmetrically (sidebar to its floor first)', () => {
  reset();
  const store = createUiStore({ sidebarWidth: SIDEBAR_MAX, observerWidth: OBSERVER_MAX });
  store.getState().reclampPanelWidths(900);
  const s = store.getState();
  assert.equal(s.sidebarWidth + s.observerWidth, 580, 'pair sums to the shared space');
  assert.equal(s.sidebarWidth, SIDEBAR_MIN, 'sidebar yields to its floor first');
  assert.equal(s.observerWidth, 400);
});
test('health toggle re-clamp: opening health at 900px retreats both panels to their floors, middle never 0', () => {
  reset();
  const store = createUiStore();
  store.getState().reclampPanelWidths(900);
  store.getState().setHealthCollapsed(false);
  store.getState().reclampPanelWidths(900); // what the space-shape effect fires
  const s = store.getState();
  assert.equal(s.sidebarWidth, SIDEBAR_MIN);
  assert.equal(s.observerWidth, OBSERVER_MIN);
  assert.ok(midOf(900, s) > 0);
});
test('health toggle re-clamp runs both directions and never crushes the middle on a feasible window', () => {
  reset();
  const store = createUiStore();
  store.getState().reclampPanelWidths(1200);
  store.getState().setHealthCollapsed(false);
  store.getState().reclampPanelWidths(1200);
  assert.equal(store.getState().sidebarWidth, 180, 'expanding health trimmed the sidebar toward its floor');
  assert.ok(midOf(1200, store.getState()) >= PANE_MIN);
  store.getState().setHealthCollapsed(true);
  store.getState().reclampPanelWidths(1200);
  assert.ok(midOf(1200, store.getState()) >= PANE_MIN);
  assert.equal(store.getState().sidebarWidth, 180, 'no memory of the pre-trim value: collapse does not regrow');
});
test('a window shrink re-clamp keeps the middle floor (or both panels at their floors)', () => {
  reset();
  const store = createUiStore();
  store.getState().setHealthCollapsed(false);
  store.getState().reclampPanelWidths(1400);
  store.getState().reclampPanelWidths(1000);
  const s = store.getState();
  assert.ok(midOf(1000, s) >= PANE_MIN || (s.sidebarWidth === SIDEBAR_MIN && s.observerWidth === OBSERVER_MIN));
});
test('collapsed neighbour is treated as 0: a lone visible panel keeps its wide value, hidden width untouched', () => {
  reset();
  const store = createUiStore({ sidebarWidth: 200, observerWidth: 580, sidebarCollapsed: true });
  store.getState().reclampPanelWidths(900);
  assert.equal(store.getState().observerWidth, 580);
  assert.equal(store.getState().sidebarWidth, 200);
  assert.ok(midOf(900, store.getState()) >= PANE_MIN);
});
test('side-panel EXPAND re-clamp: collapse sidebar, drag observer wide, expand sidebar -> pair trimmed, middle at the floor', () => {
  reset();
  const store = createUiStore();
  const st = () => store.getState();
  st().reclampPanelWidths(900);
  st().setSidebarCollapsed(true);
  // drag observer wide (the drag handler passes the collapsed neighbour as 0)
  st().setObserverWidth(clampObserverWidth(580, 0, { windowWidth: 900, healthCollapsed: true }));
  assert.equal(st().observerWidth, 580);
  st().setSidebarCollapsed(false);
  // BUG shape: without the re-clamp the middle is crushed
  assert.ok(midOf(900, st()) < PANE_MIN, 'unclamped expand crushes the middle');
  st().reclampPanelWidths(900); // the re-clamp the expand must trigger
  assert.equal(st().sidebarWidth, SIDEBAR_MIN, 'sidebar yields first');
  assert.equal(st().observerWidth, 400);
  assert.equal(midOf(900, st()), PANE_MIN);
});
test('the decisive collapse dance never crushes the middle to 0', () => {
  reset();
  const store = createUiStore();
  const st = () => store.getState();
  const ctx = { windowWidth: 900, healthCollapsed: true };
  st().reclampPanelWidths(900);
  st().setSidebarCollapsed(true);
  st().setObserverWidth(clampObserverWidth(580, 0, ctx));
  st().setObserverCollapsed(true);
  st().setSidebarCollapsed(false);
  st().reclampPanelWidths(900);
  st().setSidebarWidth(clampSidebarWidth(400, 0, ctx));
  st().setObserverCollapsed(false);
  st().reclampPanelWidths(900);
  assert.ok(st().sidebarWidth >= SIDEBAR_MIN && st().observerWidth >= OBSERVER_MIN);
  assert.equal(midOf(900, st()), PANE_MIN);
});
test('reclampPanelWidths writes BOTH widths in ONE set (a subscriber never sees a half-clamped pair)', () => {
  reset();
  const store = createUiStore({ sidebarWidth: SIDEBAR_MAX, observerWidth: OBSERVER_MAX });
  const seen = [];
  store.subscribe((s) => seen.push([s.sidebarWidth, s.observerWidth]));
  store.getState().reclampPanelWidths(900);
  assert.equal(seen.length, 1, 'exactly one notification');
  assert.deepEqual(seen[0], [SIDEBAR_MIN, 400]);
});
test('reclampPanelWidths has a stable identity across calls', () => {
  reset();
  const store = createUiStore();
  const before = store.getState().reclampPanelWidths;
  before(900);
  assert.equal(store.getState().reclampPanelWidths, before);
});

// ─── WARDEN-1526 (slice 23): the workspace set + its actions ─────────────────
console.log('\ncreateUiStore — workspaces + activeWorkspaceId (slice 23)');
const ws = (id, openPanes = [], focused = null, name = id) => ({ id, name, openPanes, focused, recentlyClosed: [] });
const seeded = (workspaces, activeWorkspaceId = workspaces[0].id) => createUiStore({ workspaces, activeWorkspaceId });
test('workspaces + activeWorkspaceId join STORE_PERSISTED_KEYS (39) and ride selectPersistedStorePrefs', () => {
  reset();
  assert.ok(STORE_PERSISTED_KEYS.includes('workspaces'));
  assert.ok(STORE_PERSISTED_KEYS.includes('activeWorkspaceId'));
  assert.equal(STORE_PERSISTED_KEYS.length, 39);
  const s = seeded([ws('a'), ws('b')], 'b');
  const picked = selectPersistedStorePrefs(s.getState());
  assert.equal(Object.keys(picked).length, 39);
  assert.equal(picked.workspaces, s.getState().workspaces);
  assert.equal(picked.activeWorkspaceId, 'b');
});
test("a fresh store seeds the workspace set from the PERSISTED payload ('previous')", () => {
  reset();
  saveUi({ ...loadUi(), workspaces: [ws('a', ['p1'], 'p1'), ws('b')], activeWorkspaceId: 'b' });
  const s = createUiStore().getState();
  assert.deepEqual(s.workspaces.map((w) => w.id), ['a', 'b']);
  assert.equal(s.activeWorkspaceId, 'b');
});
test("'empty' seed boots ONE workspace whose id MATCHES activeWorkspaceId (one initialWorkspace call) and paneHost is {}", () => {
  reset();
  saveUi({ ...loadUi(), workspaces: [ws('a', ['p1'])], activeWorkspaceId: 'a', paneHost: { p1: 'h' } });
  for (let i = 0; i < 5; i++) {
    const s = createUiStore({ restoreOnStartup: 'empty' }).getState();
    assert.equal(s.workspaces.length, 1);
    assert.equal(s.workspaces[0].id, s.activeWorkspaceId, 'a second initialWorkspace call would mint a fresh id and desync these');
    assert.notEqual(s.activeWorkspaceId, 'a', 'the disk workspace is not resurrected');
    assert.deepEqual(s.workspaces[0].openPanes, []);
    assert.deepEqual(s.paneHost, {});
  }
  assert.deepEqual(loadUi().workspaces.map((w) => w.id), ['a'], 'seeding never touches the disk');
});
test('the workspace set round-trips store -> production selector -> saveUi -> loadUi -> a fresh store', () => {
  reset();
  const s = createUiStore();
  s.getState().createWorkspace('p9');
  flushSnapshotToDisk(s);
  const next = createUiStore().getState();
  assert.deepEqual(next.workspaces, s.getState().workspaces);
  assert.equal(next.activeWorkspaceId, s.getState().activeWorkspaceId);
});
test('"Start empty" does NOT overwrite the disk workspace (persistUiState carry-forward) and Settings→Reset preserves the set', () => {
  reset();
  saveUi({ ...loadUi(), workspaces: [ws('a', ['p1'], 'p1')], activeWorkspaceId: 'a' });
  const s = createUiStore({ restoreOnStartup: 'empty' });
  flushSnapshotToDisk(s, { startedEmpty: true });
  assert.deepEqual(loadUi().workspaces.map((w) => w.id), ['a']);
  assert.equal(loadUi().activeWorkspaceId, 'a');
  assert.ok(!('workspaces' in resetUiPrefDefaults()) && !('activeWorkspaceId' in resetUiPrefDefaults()));
});
test('selectWorkspace switches the active id', () => {
  reset();
  const s = seeded([ws('a'), ws('b')]);
  s.getState().selectWorkspace('b');
  assert.equal(s.getState().activeWorkspaceId, 'b');
});
test('createWorkspace appends "Workspace N" (count-based), activates it in ONE set, and returns the id', () => {
  reset();
  const s = seeded([ws('a'), ws('b')]);
  let notes = 0;
  s.subscribe(() => { notes += 1; });
  const id = s.getState().createWorkspace('p1');
  assert.equal(notes, 1);
  const st = s.getState();
  assert.equal(st.workspaces.length, 3);
  assert.equal(st.activeWorkspaceId, id);
  assert.deepEqual(st.workspaces[2], { id, name: 'Workspace 3', openPanes: ['p1'], focused: 'p1', recentlyClosed: [] });
  const blank = st.createWorkspace();
  assert.deepEqual(s.getState().workspaces[3], { id: blank, name: 'Workspace 4', openPanes: [], focused: null, recentlyClosed: [] });
});
test('renameWorkspace trims; a blank name keeps the old one', () => {
  reset();
  const s = seeded([ws('a', [], null, 'Old'), ws('b')]);
  s.getState().renameWorkspace('a', '  New  ');
  assert.equal(s.getState().workspaces[0].name, 'New');
  s.getState().renameWorkspace('a', '   ');
  assert.equal(s.getState().workspaces[0].name, 'New', 'blank keeps the old name');
  assert.equal(s.getState().workspaces[1].name, 'b', 'other workspaces untouched');
});
test('closeWorkspace at ONE workspace is a no-op (never below one)', () => {
  reset();
  const s = seeded([ws('a', ['p1'])]);
  const before = s.getState();
  s.getState().closeWorkspace('a');
  assert.equal(s.getState(), before, 'same state object');
  assert.equal(s.getState().workspaces.length, 1);
});
test('closeWorkspace: closing the ACTIVE one falls back to remaining[0]; closing another keeps the active id', () => {
  reset();
  const s = seeded([ws('a'), ws('b'), ws('c')], 'b');
  s.getState().closeWorkspace('b');
  assert.deepEqual(s.getState().workspaces.map((w) => w.id), ['a', 'c']);
  assert.equal(s.getState().activeWorkspaceId, 'a');
  s.getState().selectWorkspace('c');
  s.getState().closeWorkspace('a');
  assert.deepEqual(s.getState().workspaces.map((w) => w.id), ['c']);
  assert.equal(s.getState().activeWorkspaceId, 'c');
});
test('movePaneToWorkspace: dedups, source-focus falls back to remaining[0] ?? null, switches to the target', () => {
  reset();
  const s = seeded([ws('a', ['p1', 'p2'], 'p1'), ws('b', ['p3'], 'p3'), ws('c', ['p4'], 'p4')], 'a');
  const cBefore = s.getState().workspaces[2];
  s.getState().movePaneToWorkspace('p1', 'b');
  let st = s.getState();
  assert.deepEqual(st.workspaces[0].openPanes, ['p2']);
  assert.equal(st.workspaces[0].focused, 'p2', 'source focus falls back to the first remaining pane');
  assert.deepEqual(st.workspaces[1].openPanes, ['p3', 'p1']);
  assert.equal(st.workspaces[1].focused, 'p1');
  assert.equal(st.activeWorkspaceId, 'b');
  assert.equal(st.workspaces[2], cBefore, 'untouched workspace keeps identity');
  // moving the only pane leaves the source focused:null
  s.getState().movePaneToWorkspace('p4', 'a');
  st = s.getState();
  assert.deepEqual(st.workspaces[2].openPanes, []);
  assert.equal(st.workspaces[2].focused, null);
  // a non-focused source pane keeps the source focus
  s.getState().movePaneToWorkspace('p2', 'c');
  assert.equal(s.getState().workspaces[0].focused, 'p4');
});
test('movePaneToWorkspace into the workspace that already holds the pane is a list no-op; an unknown target leaves the list alone', () => {
  reset();
  const s = seeded([ws('a', ['p1'], 'p1'), ws('b')], 'b');
  const list = s.getState().workspaces;
  s.getState().movePaneToWorkspace('p1', 'a');
  assert.equal(s.getState().workspaces[0].openPanes.length, 1);
  assert.equal(s.getState().activeWorkspaceId, 'a');
  s.getState().movePaneToWorkspace('p1', 'nope');
  assert.deepEqual(s.getState().workspaces.map((w) => w.openPanes), list.map((w) => w.openPanes));
});
test('movePaneToNewWorkspace: new workspace holds the pane, source-focus fallback, ONE set', () => {
  reset();
  const s = seeded([ws('a', ['p1', 'p2'], 'p1')]);
  let notes = 0;
  s.subscribe(() => { notes += 1; });
  const id = s.getState().movePaneToNewWorkspace('p1');
  assert.equal(notes, 1);
  const st = s.getState();
  assert.deepEqual(st.workspaces[0].openPanes, ['p2']);
  assert.equal(st.workspaces[0].focused, 'p2');
  assert.deepEqual(st.workspaces[1], { id, name: 'Workspace 2', openPanes: ['p1'], focused: 'p1', recentlyClosed: [] });
  assert.equal(st.activeWorkspaceId, id);
});
test('updateActiveWorkspace: applies to the active workspace; the SAME object returned is an identity no-op', () => {
  reset();
  const s = seeded([ws('a'), ws('b', ['p1'])], 'b');
  const before = s.getState();
  s.getState().updateActiveWorkspace((w) => w);
  assert.equal(s.getState(), before, 'same state object');
  assert.equal(s.getState().workspaces, before.workspaces, 'same array reference');
  s.getState().updateActiveWorkspace((w) => ({ ...w, name: 'X' }));
  assert.equal(s.getState().workspaces[1].name, 'X');
  assert.equal(s.getState().workspaces[0], before.workspaces[0]);
});
test('updateActiveWorkspace: a dangling activeWorkspaceId falls back to the FIRST workspace', () => {
  reset();
  const s = createUiStore({ workspaces: [ws('a'), ws('b')], activeWorkspaceId: 'gone' });
  s.getState().updateActiveWorkspace((w) => ({ ...w, name: 'first' }));
  assert.equal(s.getState().workspaces[0].name, 'first');
  assert.equal(s.getState().workspaces[1].name, 'b');
  assert.equal(selectActiveWorkspace(s.getState()).id, 'a');
});
test('setOpenPanes / setFocused: value or functional form, identity-preserving on no-op', () => {
  reset();
  const s = seeded([ws('a', ['p1'], 'p1')]);
  const before = s.getState();
  s.getState().setOpenPanes((p) => p);
  s.getState().setFocused((f) => f);
  s.getState().setFocused('p1');
  assert.equal(s.getState(), before);
  s.getState().setOpenPanes((p) => [...p, 'p2']);
  s.getState().setFocused('p2');
  assert.deepEqual(s.getState().workspaces[0].openPanes, ['p1', 'p2']);
  assert.equal(s.getState().workspaces[0].focused, 'p2');
  s.getState().setOpenPanes(['z']);
  assert.deepEqual(s.getState().workspaces[0].openPanes, ['z']);
});
test('revealPane switches workspace and focuses the pane in ONE set (focus optional); a repeat is a no-op', () => {
  reset();
  const s = seeded([ws('a'), ws('b', ['p1', 'p2'], 'p2')], 'a');
  let notes = 0;
  s.subscribe(() => { notes += 1; });
  s.getState().revealPane('b', 'p1', false);
  assert.equal(s.getState().activeWorkspaceId, 'b');
  assert.equal(s.getState().workspaces[1].focused, 'p2', 'focus untouched when not asked');
  s.getState().revealPane('b', 'p1', true);
  assert.equal(s.getState().workspaces[1].focused, 'p1');
  const n = notes;
  s.getState().revealPane('b', 'p1', true);
  assert.equal(notes, n, 'nothing changed -> no notification');
});
test('dropRecentlyClosed removes the id from EVERY workspace; no match is an identity no-op', () => {
  reset();
  const e = (id) => ({ id, name: id, host: '', cwd: '', closedAt: 1 });
  const s = seeded([{ ...ws('a'), recentlyClosed: [e('x'), e('y')] }, { ...ws('b'), recentlyClosed: [e('x')] }]);
  s.getState().dropRecentlyClosed('x');
  assert.deepEqual(s.getState().workspaces.map((w) => w.recentlyClosed.map((r) => r.id)), [['y'], []]);
  const before = s.getState();
  s.getState().dropRecentlyClosed('nope');
  assert.equal(s.getState(), before);
});

// ─── recentlyClosed selector (WARDEN-1580, roadmap WARDEN-1204 slice 32) ───
test('selectRecentlyClosed: a workspace with none returns the SAME frozen reference on every read (loop guard)', () => {
  reset();
  const s = seeded([{ ...ws('a'), recentlyClosed: undefined }, ws('b')], 'a');
  const first = selectRecentlyClosed(s.getState());
  assert.deepEqual(first, []);
  assert.ok(Object.isFrozen(first), 'shared empty constant is frozen');
  assert.equal(selectRecentlyClosed(s.getState()), first, 'identity-stable across reads');
  s.getState().setFocused('x');
  assert.equal(selectRecentlyClosed(s.getState()), first, 'identity-stable across unrelated store changes');
  // a workspace whose field is missing entirely hits the same constant
  const t = seeded([{ ...ws('b'), recentlyClosed: undefined }], 'b');
  assert.equal(selectRecentlyClosed(t.getState()), first, 'one shared constant across stores');
});
test('selectRecentlyClosed: tracks the close action path and dropRecentlyClosed', () => {
  reset();
  const e = (id) => ({ id, name: id, host: '', cwd: '', closedAt: 1 });
  const s = seeded([ws('a')], 'a');
  const entry = e('x');
  s.getState().updateActiveWorkspace((w) => ({ ...w, recentlyClosed: [entry, ...(w.recentlyClosed ?? [])] }));
  const afterClose = selectRecentlyClosed(s.getState());
  assert.deepEqual(afterClose.map((r) => r.id), ['x']);
  assert.equal(selectRecentlyClosed(s.getState()), afterClose, 'real array reference is stable between reads');
  s.getState().dropRecentlyClosed('x');
  assert.deepEqual(selectRecentlyClosed(s.getState()).map((r) => r.id), []);
});
test('selectRecentlyClosed: switching activeWorkspaceId swaps the result', () => {
  reset();
  const e = (id) => ({ id, name: id, host: '', cwd: '', closedAt: 1 });
  const s = seeded([{ ...ws('a'), recentlyClosed: [e('x')] }, { ...ws('b'), recentlyClosed: [e('y')] }], 'a');
  assert.deepEqual(selectRecentlyClosed(s.getState()).map((r) => r.id), ['x']);
  s.setState({ activeWorkspaceId: 'b' });
  assert.deepEqual(selectRecentlyClosed(s.getState()).map((r) => r.id), ['y']);
});
test('selectRecentlyClosed: a dangling activeWorkspaceId falls back to workspaces[0]', () => {
  reset();
  const e = (id) => ({ id, name: id, host: '', cwd: '', closedAt: 1 });
  const s = createUiStore({ workspaces: [{ ...ws('a'), recentlyClosed: [e('x')] }, ws('b')], activeWorkspaceId: 'gone' });
  assert.deepEqual(selectRecentlyClosed(s.getState()).map((r) => r.id), ['x']);
});

// ─── openPanes selector (WARDEN-1591, roadmap WARDEN-1204 slice 33) ───
test('selectOpenPanes: a workspace with none returns the SAME frozen reference on every read (loop guard)', () => {
  reset();
  const s = seeded([{ ...ws('a'), openPanes: undefined }, ws('b')], 'a');
  const first = selectOpenPanes(s.getState());
  assert.deepEqual(first, []);
  assert.ok(Object.isFrozen(first), 'shared empty constant is frozen');
  assert.equal(selectOpenPanes(s.getState()), first, 'identity-stable across reads');
  s.getState().setFocused('x');
  assert.equal(selectOpenPanes(s.getState()), first, 'identity-stable across unrelated store changes');
  const t = seeded([{ ...ws('b'), openPanes: undefined }], 'b');
  assert.equal(selectOpenPanes(t.getState()), first, 'one shared constant across stores');
});
test('selectOpenPanes: tracks setOpenPanes and the close path, reference-stable between reads', () => {
  reset();
  const s = seeded([ws('a', ['p1', 'p2'], 'p1')], 'a');
  s.getState().setOpenPanes(['p1', 'p2', 'p3']);
  const afterOpen = selectOpenPanes(s.getState());
  assert.deepEqual([...afterOpen], ['p1', 'p2', 'p3']);
  assert.equal(selectOpenPanes(s.getState()), afterOpen, 'real array reference is stable between reads');
  s.getState().setOpenPanes((p) => p.filter((x) => x !== 'p2'));
  const afterClose = selectOpenPanes(s.getState());
  assert.deepEqual([...afterClose], ['p1', 'p3']);
  assert.equal(selectOpenPanes(s.getState()), afterClose);
});
test('selectOpenPanes: switching activeWorkspaceId swaps the result', () => {
  reset();
  const s = seeded([ws('a', ['p1'], 'p1'), ws('b', ['p2', 'p3'], 'p2')], 'a');
  assert.deepEqual([...selectOpenPanes(s.getState())], ['p1']);
  s.setState({ activeWorkspaceId: 'b' });
  assert.deepEqual([...selectOpenPanes(s.getState())], ['p2', 'p3']);
});
test('selectOpenPanes: a dangling activeWorkspaceId falls back to workspaces[0]', () => {
  reset();
  const s = createUiStore({ workspaces: [ws('a', ['p1'], 'p1'), ws('b', ['p2'], 'p2')], activeWorkspaceId: 'gone' });
  assert.deepEqual([...selectOpenPanes(s.getState())], ['p1']);
});

// ─── maximized pane id (WARDEN-1530, roadmap WARDEN-1204 slice 24): first NON-persisted shared fact ───
console.log('\ncreateUiStore — maximized (not persisted; folds WARDEN-256 + WARDEN-521)');
const maxSeeded = (maxId = 'p1') => {
  const s = seeded([ws('a', ['p1', 'p2'], 'p1'), ws('b', ['p3'], 'p3')], 'a');
  s.getState().setMaximized(maxId);
  return s;
};
test('maximized starts null; setMaximized takes value and functional forms and is identity-preserving on an identical value', () => {
  reset();
  const s = seeded([ws('a', ['p1'], 'p1')]);
  assert.equal(s.getState().maximized, null);
  const before = s.getState();
  s.getState().setMaximized(null);
  s.getState().setMaximized((m) => m);
  assert.equal(s.getState(), before, 'no-op writes keep the state referentially identical');
  s.getState().setMaximized('p1');
  assert.equal(s.getState().maximized, 'p1');
  s.getState().setMaximized((m) => (m === 'p1' ? null : 'p1'));
  assert.equal(s.getState().maximized, null);
  s.getState().setMaximized('p1');
  const same = s.getState();
  s.getState().setMaximized('p1');
  assert.equal(s.getState(), same);
});
test('maximized is NOT persisted: STORE_PERSISTED_KEYS stays 39 and excludes it; the selector never carries it', () => {
  reset();
  assert.equal(STORE_PERSISTED_KEYS.length, 39);
  assert.ok(!STORE_PERSISTED_KEYS.includes('maximized'));
  const s = maxSeeded();
  const picked = selectPersistedStorePrefs(s.getState());
  assert.equal(Object.keys(picked).length, 39);
  assert.ok(!('maximized' in picked));
  assert.equal(createUiStore().getState().maximized, null, 'never seeded');
});
test('WARDEN-256: each of the six actions that move the active workspace clears maximized in the SAME set', () => {
  reset();
  const check = (name, act) => {
    const s = maxSeeded();
    let notes = 0;
    s.subscribe(() => { notes += 1; });
    act(s.getState());
    assert.equal(s.getState().maximized, null, `${name} clears maximized`);
    assert.equal(notes, 1, `${name} lands in ONE update`);
  };
  check('selectWorkspace', (st) => st.selectWorkspace('b'));
  check('createWorkspace', (st) => st.createWorkspace());
  check('closeWorkspace (active)', (st) => st.closeWorkspace('a'));
  check('movePaneToWorkspace', (st) => st.movePaneToWorkspace('p1', 'b'));
  check('movePaneToWorkspace (unknown target)', (st) => st.movePaneToWorkspace('p1', 'nope'));
  check('movePaneToNewWorkspace', (st) => st.movePaneToNewWorkspace('p2'));
  check('revealPane', (st) => st.revealPane('b', 'p3', true));
  check('revealPane (no focus)', (st) => st.revealPane('b', 'p3', false));
});
test('same-value switches do NOT clear maximized (the retired effect fired on id VALUE change only)', () => {
  reset();
  const s = maxSeeded();
  s.getState().selectWorkspace('a');
  assert.equal(s.getState().maximized, 'p1', 'selectWorkspace(current)');
  s.getState().movePaneToWorkspace('p2', 'a');
  assert.equal(s.getState().maximized, 'p1', 'movePaneToWorkspace into the active workspace');
  s.getState().revealPane('a', 'p1', false);
  assert.equal(s.getState().maximized, 'p1', 'revealPane already-active, no focus (early return)');
  s.getState().revealPane('a', 'p2', true);
  assert.equal(s.getState().workspaces[0].focused, 'p2', 'the needsFocus path did proceed');
  assert.equal(s.getState().maximized, 'p1', 'revealPane already-active needing focus');
});
test('closeWorkspace of a NON-active workspace leaves maximized alone', () => {
  reset();
  const s = maxSeeded();
  s.getState().closeWorkspace('b');
  assert.equal(s.getState().activeWorkspaceId, 'a');
  assert.equal(s.getState().maximized, 'p1');
});
test('WARDEN-521: setOpenPanes clears maximized iff the next list drops it (remove / replace); add, reorder and no-op keep it', () => {
  reset();
  let s = maxSeeded();
  let notes = 0;
  s.subscribe(() => { notes += 1; });
  s.getState().setOpenPanes((p) => p.filter((x) => x !== 'p2'));
  assert.equal(s.getState().maximized, 'p1', 'removing a DIFFERENT pane keeps it');
  s.getState().setOpenPanes((p) => (p.includes('p9') ? p : [...p, 'p9']));
  assert.equal(s.getState().maximized, 'p1', 'add keeps it');
  s.getState().setOpenPanes((p) => [...p].reverse());
  assert.equal(s.getState().maximized, 'p1', 'reorder keeps it');
  const before = s.getState();
  s.getState().setOpenPanes((p) => p);
  assert.equal(s.getState(), before, 'no-op updater is referentially identical');
  notes = 0;
  s.getState().setOpenPanes((p) => p.filter((x) => x !== 'p1'));
  assert.equal(notes, 1, 'removal + clear land in ONE update');
  assert.deepEqual(s.getState().workspaces[0].openPanes, ['p9']);
  assert.equal(s.getState().maximized, null, 'removing the maximized pane clears it');
  s = maxSeeded();
  s.getState().setOpenPanes(['z']);
  assert.equal(s.getState().maximized, null, 'value form dropping it clears too');
  s = seeded([ws('a', ['p1'], 'p1')]);
  s.getState().setOpenPanes((p) => p.filter((x) => x !== 'p1'));
  assert.equal(s.getState().maximized, null, 'nothing maximized stays null');
});

// ─── newActivity (WARDEN-1547, roadmap WARDEN-1204 slice 27): second NON-persisted shared fact ───
console.log('\ncreateUiStore — newActivity (not persisted; unfocused-pane output badge)');
test('newActivity starts empty; markPaneActivity adds an unfocused pane', () => {
  reset();
  const s = seeded([ws('a', ['p1', 'p2'], 'p1')]);
  assert.equal(s.getState().newActivity.size, 0);
  s.getState().markPaneActivity('p2');
  assert.deepEqual([...s.getState().newActivity], ['p2']);
});
test('markPaneActivity on the ACTIVE workspace\'s focused pane is a no-op returning the identical state object', () => {
  reset();
  const s = seeded([ws('a', ['p1', 'p2'], 'p1'), ws('b', ['p3'], 'p3')], 'a');
  const before = s.getState();
  s.getState().markPaneActivity('p1');
  assert.equal(s.getState(), before);
  assert.equal(s.getState().newActivity.size, 0);
  // a focused pane of a NON-active workspace is NOT guarded (App compared against the active focus only)
  s.getState().markPaneActivity('p3');
  assert.ok(s.getState().newActivity.has('p3'));
});
test('markPaneActivity twice keeps Set (and state) identity', () => {
  reset();
  const s = seeded([ws('a', ['p1', 'p2'], 'p1')]);
  s.getState().markPaneActivity('p2');
  const set = s.getState().newActivity;
  const st = s.getState();
  s.getState().markPaneActivity('p2');
  assert.equal(s.getState().newActivity, set);
  assert.equal(s.getState(), st);
});
test('markPaneActivity copies on write (the previous Set is never mutated)', () => {
  reset();
  const s = seeded([ws('a', ['p1', 'p2', 'p3'], 'p1')]);
  s.getState().markPaneActivity('p2');
  const prev = s.getState().newActivity;
  s.getState().markPaneActivity('p3');
  assert.notEqual(s.getState().newActivity, prev);
  assert.deepEqual([...prev], ['p2']);
});
test('clearPaneActivity removes the id; a no-op (identical state object) when absent', () => {
  reset();
  const s = seeded([ws('a', ['p1', 'p2', 'p3'], 'p1')]);
  s.getState().markPaneActivity('p2');
  s.getState().markPaneActivity('p3');
  const prev = s.getState().newActivity;
  s.getState().clearPaneActivity('p2');
  assert.deepEqual([...s.getState().newActivity], ['p3']);
  assert.deepEqual([...prev].sort(), ['p2', 'p3'], 'previous Set untouched');
  const before = s.getState();
  s.getState().clearPaneActivity('nope');
  assert.equal(s.getState(), before);
});
test('newActivity is NOT persisted: STORE_PERSISTED_KEYS stays 39 and excludes it; never seeded', () => {
  reset();
  assert.equal(STORE_PERSISTED_KEYS.length, 39);
  assert.ok(!STORE_PERSISTED_KEYS.includes('newActivity'));
  const s = seeded([ws('a', ['p1', 'p2'], 'p1')]);
  s.getState().markPaneActivity('p2');
  const picked = selectPersistedStorePrefs(s.getState());
  assert.equal(Object.keys(picked).length, 39);
  assert.ok(!('newActivity' in picked));
  assert.equal(createUiStore().getState().newActivity.size, 0, 'never seeded');
});

// ─── recentlySavedIds (WARDEN-1552, roadmap WARDEN-1204 slice 28): third NON-persisted shared fact ───
console.log('\ncreateUiStore — recentlySavedIds (not persisted; "just saved" pill marker with store-owned expiry)');
// Capture the scheduled expiry timers instead of really waiting (no module mocking).
const withCapturedTimers = (fn) => {
  const real = globalThis.setTimeout;
  const timers = [];
  globalThis.setTimeout = (cb, ms) => { timers.push({ cb, ms }); return timers.length; };
  try { fn(timers); } finally { globalThis.setTimeout = real; }
};
test('recentlySavedIds starts empty; markRecentlySaved adds the id', () => {
  reset();
  withCapturedTimers(() => {
    const s = createUiStore();
    assert.equal(s.getState().recentlySavedIds.size, 0);
    s.getState().markRecentlySaved('c1');
    assert.deepEqual([...s.getState().recentlySavedIds], ['c1']);
    s.getState().markRecentlySaved('c2');
    assert.deepEqual([...s.getState().recentlySavedIds].sort(), ['c1', 'c2'], 'mark ADDS, never replaces');
  });
});
test('marking an id already present keeps it present (and the identical Set)', () => {
  reset();
  withCapturedTimers(() => {
    const s = createUiStore();
    s.getState().markRecentlySaved('c1');
    const set = s.getState().recentlySavedIds;
    s.getState().markRecentlySaved('c1');
    assert.ok(s.getState().recentlySavedIds.has('c1'));
    assert.equal(s.getState().recentlySavedIds, set);
  });
});
test('markRecentlySaved copies on write (the previous Set is never mutated)', () => {
  reset();
  withCapturedTimers(() => {
    const s = createUiStore();
    s.getState().markRecentlySaved('c1');
    const prev = s.getState().recentlySavedIds;
    s.getState().markRecentlySaved('c2');
    assert.notEqual(s.getState().recentlySavedIds, prev);
    assert.deepEqual([...prev], ['c1']);
  });
});
test('expireRecentlySaved removes the id; a no-op (identical state object) when absent', () => {
  reset();
  withCapturedTimers(() => {
    const s = createUiStore();
    s.getState().markRecentlySaved('c1');
    s.getState().markRecentlySaved('c2');
    s.getState().expireRecentlySaved('c1');
    assert.deepEqual([...s.getState().recentlySavedIds], ['c2']);
    const before = s.getState();
    s.getState().expireRecentlySaved('nope');
    assert.equal(s.getState(), before);
  });
});
test('the scheduled expiry fires after RECENTLY_SAVED_TTL_MS (30 s) and removes only that id', () => {
  reset();
  assert.equal(RECENTLY_SAVED_TTL_MS, 30_000);
  withCapturedTimers((timers) => {
    const s = createUiStore();
    s.getState().markRecentlySaved('c1');
    s.getState().markRecentlySaved('c2');
    assert.equal(timers.length, 2);
    assert.ok(timers.every((t) => t.ms === RECENTLY_SAVED_TTL_MS));
    assert.deepEqual([...s.getState().recentlySavedIds].sort(), ['c1', 'c2'], 'still marked before the timer fires');
    timers[0].cb();
    assert.deepEqual([...s.getState().recentlySavedIds], ['c2'], 'only c1 expired');
    timers[1].cb();
    assert.equal(s.getState().recentlySavedIds.size, 0);
  });
});
test('recentlySavedIds is NOT persisted: STORE_PERSISTED_KEYS stays 39 and excludes it; never seeded; absent from the loadUi round trip', () => {
  reset();
  assert.equal(STORE_PERSISTED_KEYS.length, 39);
  assert.ok(!STORE_PERSISTED_KEYS.includes('recentlySavedIds'));
  withCapturedTimers(() => {
    const s = createUiStore();
    s.getState().markRecentlySaved('c1');
    const picked = selectPersistedStorePrefs(s.getState());
    assert.equal(Object.keys(picked).length, 39);
    assert.ok(!('recentlySavedIds' in picked));
    saveUi(persistUiState({ ...DEFAULT_UI, ...picked }));
    assert.ok(!('recentlySavedIds' in loadUi()));
    assert.equal(createUiStore().getState().recentlySavedIds.size, 0, 'never seeded');
  });
});

// ─── reconnectTokens (WARDEN-1558, roadmap WARDEN-1204 slice 29): fourth NON-persisted shared fact ───
console.log('\ncreateUiStore — reconnectTokens (not persisted; per-pane re-attach bump counts)');
test('reconnectTokens starts empty; bumping an absent id → 1, repeated → 2', () => {
  reset();
  const s = createUiStore();
  assert.deepEqual(s.getState().reconnectTokens, {});
  s.getState().bumpReconnectToken('p1');
  assert.equal(s.getState().reconnectTokens.p1, 1);
  s.getState().bumpReconnectToken('p1');
  assert.equal(s.getState().reconnectTokens.p1, 2);
});
test('bumpReconnectToken leaves other panes unchanged and never mutates the prior map', () => {
  reset();
  const s = createUiStore();
  s.getState().bumpReconnectToken('p1');
  s.getState().bumpReconnectToken('p2');
  s.getState().bumpReconnectToken('p2');
  const prev = s.getState().reconnectTokens;
  const snapshot = { ...prev };
  s.getState().bumpReconnectToken('p1');
  const next = s.getState().reconnectTokens;
  assert.notEqual(next, prev, 'a fresh map');
  assert.deepEqual(prev, snapshot, 'prior map not mutated');
  assert.equal(next.p1, 2);
  assert.equal(next.p2, 2, 'other pane untouched');
});
test('bump for a not-open pane is harmless: the entry waits unused, nothing else moves', () => {
  reset();
  const s = createUiStore();
  const before = s.getState();
  s.getState().bumpReconnectToken('not-open-pane');
  assert.equal(s.getState().reconnectTokens['not-open-pane'], 1);
  assert.equal(s.getState().workspaces, before.workspaces);
  assert.equal(s.getState().maximized, before.maximized);
  assert.equal(s.getState().reconnectTokens['some-other-id'], undefined, 'never-bumped pane reads undefined');
});
test('reconnectTokens is NOT persisted: STORE_PERSISTED_KEYS stays 39 and excludes it; never seeded; absent from the loadUi round trip', () => {
  reset();
  assert.equal(STORE_PERSISTED_KEYS.length, 39);
  assert.ok(!STORE_PERSISTED_KEYS.includes('reconnectTokens'));
  const s = createUiStore();
  s.getState().bumpReconnectToken('p1');
  const picked = selectPersistedStorePrefs(s.getState());
  assert.equal(Object.keys(picked).length, 39);
  assert.ok(!('reconnectTokens' in picked));
  saveUi(persistUiState({ ...DEFAULT_UI, ...picked }));
  assert.ok(!('reconnectTokens' in loadUi()));
  assert.deepEqual(createUiStore().getState().reconnectTokens, {}, 'never seeded');
});

// ─── externalSearchQuery (WARDEN-1568, roadmap WARDEN-1204 slice 30): fifth NON-persisted shared fact ───
console.log('\ncreateUiStore — externalSearchQuery (not persisted; one-shot search-jump command)');
test('externalSearchQuery starts null', () => {
  reset();
  assert.equal(createUiStore().getState().externalSearchQuery, null);
});
test('setExternalSearchQuery stores the exact object; null clears', () => {
  reset();
  const s = createUiStore();
  const v = { paneId: 'p1', query: 'needle' };
  s.getState().setExternalSearchQuery(v);
  assert.equal(s.getState().externalSearchQuery, v, 'same reference stored as-is');
  s.getState().setExternalSearchQuery(null);
  assert.equal(s.getState().externalSearchQuery, null);
});
test('two successive sets of equal-valued objects yield two DISTINCT references', () => {
  reset();
  const s = createUiStore();
  s.getState().setExternalSearchQuery({ paneId: 'p1', query: 'q' });
  const a = s.getState().externalSearchQuery;
  s.getState().setExternalSearchQuery({ paneId: 'p1', query: 'q' });
  const b = s.getState().externalSearchQuery;
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
});
test('externalSearchQuery is NOT persisted: STORE_PERSISTED_KEYS stays 39 and excludes it; never seeded; absent from the loadUi round trip', () => {
  reset();
  assert.equal(STORE_PERSISTED_KEYS.length, 39);
  assert.ok(!STORE_PERSISTED_KEYS.includes('externalSearchQuery'));
  const s = createUiStore();
  s.getState().setExternalSearchQuery({ paneId: 'p1', query: 'q' });
  const picked = selectPersistedStorePrefs(s.getState());
  assert.equal(Object.keys(picked).length, 39);
  assert.ok(!('externalSearchQuery' in picked));
  saveUi(persistUiState({ ...DEFAULT_UI, ...picked }));
  assert.ok(!('externalSearchQuery' in loadUi()));
  assert.equal(createUiStore().getState().externalSearchQuery, null, 'never seeded');
});

// ─── globalSearchOpen (WARDEN-1620, roadmap WARDEN-1204 slice 37): NON-persisted "open global search" command ───
console.log('\ncreateUiStore — globalSearchOpen (not persisted; "open global search" session fact)');
test('globalSearchOpen starts false', () => {
  reset();
  assert.equal(createUiStore().getState().globalSearchOpen, false);
});
test('setGlobalSearchOpen stores the value (open then close)', () => {
  reset();
  const s = createUiStore();
  s.getState().setGlobalSearchOpen(true);
  assert.equal(s.getState().globalSearchOpen, true);
  s.getState().setGlobalSearchOpen(false);
  assert.equal(s.getState().globalSearchOpen, false);
});
test('globalSearchOpen is NOT persisted: STORE_PERSISTED_KEYS stays 39 and excludes it; never seeded; absent from the loadUi round trip', () => {
  reset();
  assert.equal(STORE_PERSISTED_KEYS.length, 39);
  assert.ok(!STORE_PERSISTED_KEYS.includes('globalSearchOpen'));
  const s = createUiStore();
  s.getState().setGlobalSearchOpen(true);
  const picked = selectPersistedStorePrefs(s.getState());
  assert.equal(Object.keys(picked).length, 39);
  assert.ok(!('globalSearchOpen' in picked));
  saveUi(persistUiState({ ...DEFAULT_UI, ...picked }));
  assert.ok(!('globalSearchOpen' in loadUi()));
  assert.equal(createUiStore().getState().globalSearchOpen, false, 'never seeded');
});

// ─── resolvedThemeId (WARDEN-1574, roadmap WARDEN-1204 slice 31): sixth NON-persisted shared fact ───
console.log('\ncreateUiStore — resolvedThemeId / selectTerminalThemeId (not persisted; DOM-free seed)');
test('selectTerminalThemeId: dark/light overrides win regardless of resolved theme; auto follows the resolved id', () => {
  reset();
  const s = createUiStore({ theme: 'dracula' });
  s.getState().setResolvedThemeId('dracula');
  s.getState().setTerminalColorScheme('dark');
  assert.equal(selectTerminalThemeId(s.getState()), 'github-dark');
  s.getState().setTerminalColorScheme('light');
  assert.equal(selectTerminalThemeId(s.getState()), 'github-light');
  s.getState().setTerminalColorScheme('auto');
  assert.equal(selectTerminalThemeId(s.getState()), 'dracula');
});
test('setResolvedThemeId changes the selector under auto but not under a forced scheme', () => {
  reset();
  const s = createUiStore({ terminalColorScheme: 'auto' });
  s.getState().setResolvedThemeId('github-light');
  assert.equal(selectTerminalThemeId(s.getState()), 'github-light');
  s.getState().setResolvedThemeId('dracula');
  assert.equal(selectTerminalThemeId(s.getState()), 'dracula', 'OS flip under auto re-themes');
  s.getState().setTerminalColorScheme('dark');
  s.getState().setResolvedThemeId('github-light');
  assert.equal(selectTerminalThemeId(s.getState()), 'github-dark', 'forced scheme ignores the flip');
  assert.equal(s.getState().resolvedThemeId, 'github-light', 'the fact itself still moved');
});
test('resolvedThemeId is NOT persisted: STORE_PERSISTED_KEYS stays 39 and excludes it; never seeded from disk or a previous store; absent from the loadUi round trip', () => {
  reset();
  assert.equal(STORE_PERSISTED_KEYS.length, 39);
  assert.ok(!STORE_PERSISTED_KEYS.includes('resolvedThemeId'));
  const s = createUiStore({ theme: 'system' });
  s.getState().setResolvedThemeId('dracula');
  const picked = selectPersistedStorePrefs(s.getState());
  assert.equal(Object.keys(picked).length, 39);
  assert.ok(!('resolvedThemeId' in picked));
  saveUi(persistUiState({ ...DEFAULT_UI, ...picked }));
  assert.ok(!('resolvedThemeId' in loadUi()));
  assert.equal(createUiStore({ theme: 'system' }).getState().resolvedThemeId, 'github-dark', 'never seeded from the previous store');
});
test('seeding is a pure mapping of the theme pref: concrete id passes through; system -> dark placeholder', () => {
  reset();
  assert.equal(createUiStore({ theme: 'dracula' }).getState().resolvedThemeId, 'dracula');
  assert.equal(createUiStore({ theme: 'github-light' }).getState().resolvedThemeId, 'github-light');
  assert.equal(createUiStore({ theme: 'system' }).getState().resolvedThemeId, 'github-dark');
});
test('resolvedThemeId is factory-isolated: one store\'s write never reaches another', () => {
  reset();
  const a = createUiStore({ theme: 'system' });
  const b = createUiStore({ theme: 'system' });
  a.getState().setResolvedThemeId('github-light');
  assert.equal(b.getState().resolvedThemeId, 'github-dark');
  assert.equal(selectTerminalThemeId(b.getState()), 'github-dark');
});

console.log('\nresetUiPrefs — the store-owned reset action (WARDEN-1596, slice 34)');
// A value guaranteed to differ from `v` by type, so the test needs no per-key
// hand-written list that could drift from ResettableKey.
const perturb = (v) => {
  if (typeof v === 'boolean') return !v;
  if (typeof v === 'number') return v + 7;
  if (typeof v === 'string') return `${v}-MUTATED`;
  if (Array.isArray(v)) return [...v, 'MUTATED'];
  return { ...v, MUTATED: true };
};
const OBS_FACT = { viewMode: 'observerViewMode', activityFilters: 'observerActivityFilters', directiveFilters: 'observerDirectiveFilters', attentionFilters: 'observerAttentionFilters' };
test('resetUiPrefs() snaps EVERY ResettableKey + the four observer facts to defaults and moves NO RESET_PRESERVED_KEY', () => {
  reset();
  const store = createUiStore();
  const defaults = resetUiPrefDefaults();
  const obsDefaults = resetObsPrefDefaults();
  const dirty = {};
  for (const k of Object.keys(defaults)) dirty[k] = perturb(defaults[k]);
  for (const k of OBS_RESET_KEYS) dirty[OBS_FACT[k]] = perturb(obsDefaults[k]);
  const before = store.getState();
  const preserved = {};
  for (const k of RESET_PRESERVED_KEYS) { preserved[k] = perturb(before[k]); dirty[k] = preserved[k]; }
  store.setState(dirty);
  // Sanity: the dirtying took, so the assertions below are not vacuous.
  for (const k of Object.keys(defaults)) assert.notDeepEqual(store.getState()[k], defaults[k], `${k} was dirtied`);

  store.getState().resetUiPrefs();

  const after = store.getState();
  for (const k of Object.keys(defaults)) assert.deepEqual(after[k], defaults[k], `ResettableKey ${k} reset`);
  for (const k of OBS_RESET_KEYS) assert.deepEqual(after[OBS_FACT[k]], obsDefaults[k], `observer fact ${OBS_FACT[k]} reset`);
  for (const k of RESET_PRESERVED_KEYS) assert.equal(after[k], preserved[k], `preserved key ${k} untouched (===)`);
  assert.equal(after.terminalFontFamily, DEFAULT_TERMINAL_FONT_FAMILY);
});
test('resetUiPrefs() is atomic: ONE store notification per call', () => {
  reset();
  const store = createUiStore();
  let notifications = 0;
  store.subscribe(() => { notifications += 1; });
  store.getState().resetUiPrefs();
  assert.equal(notifications, 1);
});
test('resetUiPrefs() aliases no module default: object/array values are fresh per call and per store', () => {
  reset();
  const a = createUiStore();
  const b = createUiStore();
  a.getState().resetUiPrefs();
  const first = a.getState();
  const objectKeys = [...Object.keys(resetUiPrefDefaults()), ...Object.values(OBS_FACT)].filter((k) => first[k] !== null && typeof first[k] === 'object');
  assert.ok(objectKeys.length >= 5, 'the aliasing check covers real object/array facts');
  a.getState().resetUiPrefs(); // second call on the same store
  b.getState().resetUiPrefs(); // and on another store
  for (const k of objectKeys) {
    assert.notEqual(a.getState()[k], first[k], `${k}: second reset hands the store a fresh object`);
    assert.notEqual(a.getState()[k], b.getState()[k], `${k}: not shared across stores`);
  }
  // In-place mutation of a reset value must not leak into the next reset.
  a.getState().resetUiPrefs();
  a.getState().snippets.push({ name: 'leak', text: 'leak' });
  a.getState().observerActivityFilters.type = 'LEAK';
  a.getState().resetUiPrefs();
  assert.deepEqual(a.getState().snippets, resetUiPrefDefaults().snippets);
  assert.equal(a.getState().observerActivityFilters.type, 'all');
});
test('resetUiPrefs() writes state only: no localStorage write (the disk half stays at App\'s saveObs site)', () => {
  reset();
  const store = createUiStore();
  store.getState().resetUiPrefs();
  assert.equal(mem.size, 0);
});

console.log(`\n✓ UI STORE TESTS PASS (${passed})`);
