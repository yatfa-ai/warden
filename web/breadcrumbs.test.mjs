// FileViewer breadcrumb path-segmentation tests (WARDEN-740).
//
// There is no front-end test runner in this repo, so (like path-links.test.mjs
// and fileBrowser.test.mjs) this loads the REAL src/lib/pathBreadcrumbs.ts
// (transpiled TS -> ESM via Vite's OXC transform) and drives the segmentation
// contract directly.
//
// WHY THIS FILE EXISTS: the WARDEN-740 breadcrumb's click targets are derived
// from these pure helpers — each ancestor crumb lists the dir
// `ancestorDir(segments, i)` returns, and the file's own parent is
// `parentDir(filePath)`. A wrong slice index here would silently point a crumb
// at the WRONG directory (e.g. `src` listing root, or the parent listing the
// file itself), and a render-only check would never catch it — only the
// geometry is wrong. These tests pin the exact outcome the ticket specifies:
//   - root-file (no `/`) → single segment, NO ancestors;
//   - nested path → the correct ancestor dir per index;
//   - leading `./` / trailing `/` / doubled separators are normalized away.
//
// Run: node breadcrumbs.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libPath = resolve(__dirname, 'src/lib/pathBreadcrumbs.ts');

// --- Load the REAL pathBreadcrumbs.ts (TS -> ESM via the OXC transform Vite bundles) -
const src = readFileSync(libPath, 'utf8');
const { code } = await transformWithOxc(src, libPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-breadcrumbs-test-'));
const tmpFile = join(tmpDir, 'pathBreadcrumbs.mjs');
writeFileSync(tmpFile, code);
const { splitPathSegments, ancestorDir, parentDir } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

console.log('\nsplitPathSegments — basic segmentation');
test('a single root-level file has exactly one segment', () => {
  assert.deepEqual(splitPathSegments('README.md'), ['README.md']);
});
test('a nested path splits into each path component in order', () => {
  assert.deepEqual(splitPathSegments('src/components/FileViewer.tsx'), [
    'src',
    'components',
    'FileViewer.tsx',
  ]);
});
test('a two-segment path (one dir + file) splits cleanly', () => {
  assert.deepEqual(splitPathSegments('src/server.js'), ['src', 'server.js']);
});

console.log('\nrobustness — leading ./, trailing /, doubled separators, empties');
test('a leading ./ is normalized away (read-file still accepts it, but it is not a real segment)', () => {
  assert.deepEqual(splitPathSegments('./scripts/build.sh'), ['scripts', 'build.sh']);
});
test('a trailing / does not produce a phantom empty final segment', () => {
  assert.deepEqual(splitPathSegments('src/components/'), ['src', 'components']);
});
test('doubled separators do not produce empty segments', () => {
  assert.deepEqual(splitPathSegments('a//b'), ['a', 'b']);
});
test('a mid-path . segment (foo/./bar) is dropped as a no-op component', () => {
  assert.deepEqual(splitPathSegments('foo/./bar.ts'), ['foo', 'bar.ts']);
});
test('an empty path yields no segments', () => {
  assert.deepEqual(splitPathSegments(''), []);
});

console.log('\nancestorDir — the dir the i-th ancestor crumb lists (slice(0, i))');
test('ancestor 0 is always the repo root (empty dir)', () => {
  const segs = splitPathSegments('src/components/FileViewer.tsx');
  assert.equal(ancestorDir(segs, 0), '');
});
test('ancestor 1 is the first directory segment', () => {
  const segs = splitPathSegments('src/components/FileViewer.tsx');
  assert.equal(ancestorDir(segs, 1), 'src');
});
test('ancestor 2 is the first two segments joined (the file parent dir)', () => {
  const segs = splitPathSegments('src/components/FileViewer.tsx');
  assert.equal(ancestorDir(segs, 2), 'src/components');
});
test('a two-segment path has root + one dir as its ancestors', () => {
  const segs = splitPathSegments('src/server.js');
  assert.equal(ancestorDir(segs, 0), '');
  assert.equal(ancestorDir(segs, 1), 'src');
});
test('ancestorDir never mutates the input segment array', () => {
  const segs = splitPathSegments('src/components/FileViewer.tsx');
  const before = JSON.stringify(segs);
  ancestorDir(segs, 2);
  assert.equal(JSON.stringify(segs), before, 'input segments are untouched');
});

console.log('\nparentDir — the directory containing the open file');
test('a nested file parent is everything except the file name', () => {
  assert.equal(parentDir('src/components/FileViewer.tsx'), 'src/components');
});
test('a root-level file has an empty parent (it lives at the repo root)', () => {
  assert.equal(parentDir('README.md'), '');
});
test('parentDir honors ./ normalization', () => {
  assert.equal(parentDir('./scripts/build.sh'), 'scripts');
});

console.log('\nroot file — single segment, NO ancestors (the WARDEN-740 pin)');
test('a root file has one segment and its only ancestor is root, which is NOT a proper ancestor', () => {
  // The breadcrumb renders proper ancestors only. A root file has none: its
  // single segment IS the file, so the dir-segment list (segments minus the
  // file) is empty, even though ancestor 0 (root) exists abstractly.
  const segs = splitPathSegments('README.md');
  assert.equal(segs.length, 1, 'single segment');
  const dirSegments = segs.slice(0, -1);
  assert.deepEqual(dirSegments, [], 'no directory ancestors for a root file');
  assert.equal(parentDir('README.md'), '', 'parent is the repo root, not a named dir');
});

console.log('\nfull breadcrumb geometry — the dirs each crumb would list');
test('for src/components/FileViewer.tsx the crumbs list root, src, src/components (in order)', () => {
  const segs = splitPathSegments('src/components/FileViewer.tsx');
  // dirSegments[i] is labeled segs[i] and lists the dir of the first i+1 segments.
  const dirSegments = segs.slice(0, -1);
  const listedDirs = dirSegments.map((_, i) => ancestorDir(segs, i + 1));
  assert.deepEqual(listedDirs, ['src', 'src/components']);
  // the file itself is the last segment, never listed as a dir
  assert.equal(segs[segs.length - 1], 'FileViewer.tsx');
});

console.log(`\n✓ BREADCRUMBS TESTS PASS (${passed})`);
