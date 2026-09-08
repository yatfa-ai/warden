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
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
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

const { loadUi, saveUi, persistUiState, DEFAULT_UI, STARTER_SNIPPETS } =
  await import(join(tmpDir, 'storage.mjs'));
const { createUiStore, uiStore } = await import(join(tmpDir, 'uiStore.mjs'));
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
  const snapshot = {
    ...loadUi(),
    snippets: store.getState().snippets,
    fileViewerViewMode: store.getState().fileViewerViewMode,
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

console.log(`\n✓ UI STORE TESTS PASS (${passed})`);
