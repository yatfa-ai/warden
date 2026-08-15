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
const { splitPathSegments, ancestorDir, parentDir, collapseCrumbs, MAX_VISIBLE_CRUMBS } = await import(tmpFile);
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


// ---------------------------------------------------------------------------
// collapseCrumbs — the deep-path collapse (WARDEN-1006)
//
// WHY THESE EXIST: the crumbs are fixed-size click targets, so a deep path's
// crumb run does not fit the dialog title row. The FIRST attempt at WARDEN-1006
// let CSS handle it — the run got a clip box — and the tail crumbs were sliced
// off past the edge: invisible AND unclickable, with nothing saying they were
// there. CSS cannot choose WHICH crumbs to drop; only this function can, and the
// property that makes the collapse non-destructive is that it drops none of them
// (`lead + hidden + tail` is always the whole input, and `hidden` is exactly what
// the `…` menu re-offers). A geometry test cannot see that; this can.
const crumbList = (n) => Array.from({ length: n }, (_, i) => ({ dir: `d${i}`, label: `l${i}` }));
const roundTrip = (r) => [...r.lead, ...r.hidden, ...r.tail];

console.log('\ncollapseCrumbs — short paths render whole');
test('a path at the cap renders every crumb, with nothing hidden', () => {
  const crumbs = crumbList(MAX_VISIBLE_CRUMBS);
  const r = collapseCrumbs(crumbs);
  assert.deepEqual(r.lead, crumbs, 'all crumbs stay in the visible lead run');
  assert.deepEqual(r.hidden, [], 'nothing hidden → the UI shows no … trigger');
  assert.deepEqual(r.tail, []);
});
test('a single crumb (one-dir-deep file) is never collapsed', () => {
  const r = collapseCrumbs(crumbList(1));
  assert.equal(r.lead.length, 1);
  assert.deepEqual(r.hidden, []);
});
test('an empty crumb list collapses to nothing rather than throwing', () => {
  const r = collapseCrumbs([]);
  assert.deepEqual(roundTrip(r), []);
  assert.deepEqual(r.hidden, []);
});

console.log('\ncollapseCrumbs — deep paths collapse the MIDDLE, keeping both ends');
test('the reviewer deep path (7 crumbs) keeps the root and the 2 nearest the file', () => {
  const crumbs = crumbList(7);
  const r = collapseCrumbs(crumbs);
  assert.deepEqual(r.lead.map((c) => c.dir), ['d0'], 'the repo root crumb survives');
  assert.deepEqual(r.tail.map((c) => c.dir), ['d5', 'd6'], 'the crumbs NEAREST the file survive');
  assert.deepEqual(r.hidden.map((c) => c.dir), ['d1', 'd2', 'd3', 'd4'], 'the middle collapses');
});
test('the collapsed row renders exactly MAX_VISIBLE_CRUMBS boxes (… counts as one)', () => {
  for (const n of [5, 7, 12, 40]) {
    const r = collapseCrumbs(crumbList(n));
    const boxes = r.lead.length + 1 /* the … trigger */ + r.tail.length;
    assert.equal(boxes, MAX_VISIBLE_CRUMBS, `${n} crumbs → ${MAX_VISIBLE_CRUMBS} boxes`);
  }
});
test('collapsing never drops a crumb — lead+hidden+tail rebuilds the input in order', () => {
  // THE load-bearing property: every hidden crumb is handed to the … menu, which
  // lists it and opens its directory. If a crumb could fall out here it would be
  // unreachable in the UI — exactly the defect this rework exists to fix.
  for (const n of [0, 1, 3, 4, 5, 6, 7, 25]) {
    const crumbs = crumbList(n);
    assert.deepEqual(roundTrip(collapseCrumbs(crumbs)), crumbs, `${n} crumbs round-trip`);
  }
});
test('a deep path always hides at least one crumb (the … is never an empty menu)', () => {
  for (const n of [5, 6, 7, 30]) {
    assert.ok(collapseCrumbs(crumbList(n)).hidden.length > 0, `${n} crumbs hide something`);
  }
});
test('the first crumb past the cap collapses (the boundary is not off-by-one)', () => {
  assert.deepEqual(collapseCrumbs(crumbList(MAX_VISIBLE_CRUMBS)).hidden, [], 'at the cap: whole');
  assert.equal(collapseCrumbs(crumbList(MAX_VISIBLE_CRUMBS + 1)).hidden.length, 2, 'one past: collapsed');
});

console.log('\ncollapseCrumbs — the cap is clamped so a collapse always leaves both ends');
test('a cap below 3 still leaves a lead crumb, the … trigger, and one tail crumb', () => {
  for (const cap of [-5, 0, 1, 2]) {
    const r = collapseCrumbs(crumbList(6), cap);
    assert.equal(r.lead.length, 1, `cap ${cap}: keeps the root crumb`);
    assert.equal(r.tail.length, 1, `cap ${cap}: keeps the crumb nearest the file`);
    assert.ok(r.hidden.length > 0);
    assert.deepEqual(roundTrip(r), crumbList(6));
  }
});
test('a larger cap collapses less, and still round-trips', () => {
  const crumbs = crumbList(8);
  const r = collapseCrumbs(crumbs, 6);
  assert.equal(r.lead.length + 1 + r.tail.length, 6);
  assert.deepEqual(r.tail.map((c) => c.dir), ['d4', 'd5', 'd6', 'd7']);
  assert.deepEqual(roundTrip(r), crumbs);
});
test('collapseCrumbs does not mutate the array it is given', () => {
  const crumbs = crumbList(9);
  const before = JSON.stringify(crumbs);
  collapseCrumbs(crumbs);
  assert.equal(JSON.stringify(crumbs), before, 'input crumbs are untouched');
});

console.log(`\n✓ BREADCRUMBS TESTS PASS (${passed})`);
