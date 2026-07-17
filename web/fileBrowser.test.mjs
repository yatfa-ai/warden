// File-browser directory-toggle tests (WARDEN-573).
//
// There is no front-end test runner in this repo, so (like paneGrid.test.mjs and
// layout.test.mjs) this loads the REAL src/lib/fileBrowserTree.ts (transpiled
// TS -> ESM via Vite's OXC transform) and drives the directory-toggle contract.
//
// WHY THIS FILE EXISTS: the WARDEN-573 review rejected PR #260 because
// subdirectory expansion was completely non-functional. The component's inline
// `toggleDir` read `tree[dir]` and early-returned on a missing node — but a
// subdir is NEVER a tree key until first toggled (the open-effect seeds only the
// root; child dirs exist only as entries inside their parent). So the FIRST click
// of any subdir hit `if (!node) return` and did nothing: no expand, no
// /api/git-ls?dir=<subdir> request, no children. The dialog rendered fine — a
// render-only check passed — so the breakage only showed under a real
// click-driven state change.
//
// The fix moved the toggle DECISION into a pure, exported `applyToggle` so it can
// be asserted directly. These tests prove the actual outcome the ticket asks for:
// a human can expand a directory and its children are requested. The "BUG repro"
// case keeps the pre-fix decision inline to document why it failed — and to fail
// loudly if anyone re-introduces the `if (!node) return` bail.
//
// Run: node --test   (from web/)   or   node fileBrowser.test.mjs
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libPath = resolve(__dirname, 'src/lib/fileBrowserTree.ts');

// --- Load the REAL fileBrowserTree.ts (TS -> ESM via the OXC transform Vite bundles) --
const src = readFileSync(libPath, 'utf8');
const { code } = await transformWithOxc(src, libPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-fileBrowser-test-'));
const tmpFile = join(tmpDir, 'fileBrowserTree.mjs');
writeFileSync(tmpFile, code);
const { applyToggle, joinPath, EMPTY_DIR } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// A directory node shape helpers. `loaded` dirs already have their entries; an
// unseeded child dir is simply ABSENT from the tree (the realistic state after
// the root listing resolves — `src` is an entry inside root, not a tree key).
const loadedDir = (entries, expanded = true) => ({
  loaded: true,
  loading: false,
  error: null,
  entries,
  expanded,
});
const dirEntry = (name) => ({ name, type: 'dir' });
const fileEntry = (name) => ({ name, type: 'file' });

// The PRE-fix inline decision, kept here to demonstrate the regression. It read
// `tree[dir]` and bailed on a missing node — so an unseeded subdir was a no-op:
// no expansion, no fetch. (This is exactly the `if (!node) return` that shipped.)
const oldToggleDecision = (tree, dir) => {
  const node = tree[dir];
  if (!node) return { tree, needsFetch: false }; // ← the bug: bail on unseeded child
  if (node.expanded) return { tree: { ...tree, [dir]: { ...node, expanded: false } }, needsFetch: false };
  return { tree: { ...tree, [dir]: { ...node, expanded: true } }, needsFetch: !node.loaded };
};

// Root listing has resolved: it lists one subdir (`src`) and one file. The subdir
// is an ENTRY inside root — it is NOT a key in `tree` (the state after fetchDir('')
// resolves, before any subdir is clicked). This is the exact state the bug bit.
const rootWithSrcEntry = {
  '': loadedDir([dirEntry('src'), fileEntry('README.md')]),
};

console.log('\nsubdirectory expansion: the WARDEN-573 outcome (a subdir expands AND requests its children)');

test('BUG repro: the OLD decision left an unseeded subdir untouched and fetched nothing', () => {
  // A human clicks `src`. The old code bailed because tree['src'] was undefined.
  const result = oldToggleDecision(rootWithSrcEntry, 'src');
  assert.equal(result.needsFetch, false, 'old decision never requested the subdir listing');
  assert.equal(result.tree['src'], undefined, 'old decision never seeded the subdir node');
  assert.deepEqual(Object.keys(result.tree), [''], 'tree is unchanged — the click was a no-op');
});

test('FIX: clicking an unseeded subdir expands it AND requests its children (the core outcome)', () => {
  const result = applyToggle(rootWithSrcEntry, 'src');
  assert.equal(result.needsFetch, true, 'a first click MUST request /api/git-ls?dir=src');
  assert.equal(result.tree['src'].expanded, true, 'the subdir node is now expanded');
  assert.equal(result.tree['src'].loaded, false, 'not yet loaded (the fetch is what loads it)');
});

test('expanding a subdir does not drop its sibling entries or the root listing', () => {
  const result = applyToggle(rootWithSrcEntry, 'src');
  assert.deepEqual(
    result.tree[''].entries.map((e) => e.name),
    ['src', 'README.md'],
    'root listing is preserved across the child toggle',
  );
});

test('a nested subdir (src/components) also expands + fetches — works at any depth', () => {
  // src is loaded and expanded; its entries include a nested `components` dir.
  // `components` is an entry inside `src`, not a tree key — same shape, one level down.
  const tree = {
    '': loadedDir([dirEntry('src')]),
    src: loadedDir([dirEntry('components'), fileEntry('index.ts')]),
  };
  const result = applyToggle(tree, 'src/components');
  assert.equal(result.needsFetch, true, 'nested subdir requests its own listing');
  assert.equal(result.tree['src/components'].expanded, true, 'nested subdir is expanded');
});

test('toggling an expanded dir COLLAPSES it and does not refetch', () => {
  const tree = {
    '': loadedDir([dirEntry('src')]),
    src: loadedDir([fileEntry('a.ts')], true), // expanded + loaded
  };
  const result = applyToggle(tree, 'src');
  assert.equal(result.needsFetch, false, 'collapse never fetches');
  assert.equal(result.tree['src'].expanded, false, 'dir is now collapsed');
  assert.deepEqual(
    result.tree['src'].entries.map((e) => e.name),
    ['a.ts'],
    'cached entries are kept so a re-expand is instant',
  );
});

test('re-expanding a loaded-but-collapsed dir does NOT refetch (cached, instant)', () => {
  const tree = {
    '': loadedDir([dirEntry('src')]),
    src: loadedDir([fileEntry('a.ts')], false), // collapsed but already loaded
  };
  const result = applyToggle(tree, 'src');
  assert.equal(result.needsFetch, false, 'a previously-loaded dir is served from cache');
  assert.equal(result.tree['src'].expanded, true, 'dir is expanded again');
});

test('applyToggle never mutates the input tree (React needs a new reference to re-render)', () => {
  const before = JSON.stringify(rootWithSrcEntry);
  applyToggle(rootWithSrcEntry, 'src');
  assert.equal(JSON.stringify(rootWithSrcEntry), before, 'input tree is untouched');
  assert.equal(rootWithSrcEntry['src'], undefined, 'no node was spliced into the original');
});

test('root dir (empty-string key) expands + fetches like any subdir', () => {
  // The open-effect seeds root itself, but applyToggle must handle '' correctly
  // (it is just another key) — a fresh tree with no root seeded should seed it.
  const result = applyToggle({}, '');
  assert.equal(result.needsFetch, true, 'an unseeded root requests its listing');
  assert.equal(result.tree[''].expanded, true, 'root is expanded');
});

console.log('\njoinPath: cwd-relative path normalization (shared by the API dir= and FileViewer filePath=)');

test('joinPath: root entry has no leading slash', () => {
  assert.equal(joinPath('', 'src'), 'src');
});

test('joinPath: nested entry is dir/name with a single separator', () => {
  assert.equal(joinPath('src', 'components'), 'src/components');
  assert.equal(joinPath('src/components', 'Button.tsx'), 'src/components/Button.tsx');
});

test('EMPTY_DIR ships as collapsed + unloaded (the seed-on-demand default)', () => {
  assert.equal(EMPTY_DIR.expanded, false);
  assert.equal(EMPTY_DIR.loaded, false);
  assert.deepEqual(EMPTY_DIR.entries, []);
});

console.log(`\n✓ FILEBROWSER TESTS PASS (${passed})`);
