// Tests for the pure diff-line classifier DiffViewer uses for highlighting.
//
// There is no front-end test runner in this repo, so (like storage.test.mjs) this
// loads the REAL src/lib/diff.ts (transpiled TS -> ESM via Vite's OXC transform)
// and exercises classifyDiffLine directly. The critical case is the file-header
// trap: '+++'/'---' lines start with + / - but must classify as 'meta', not as
// added/removed — otherwise every diff's header pair gets mis-colored.
//
// Run: node diff.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const diffPath = resolve(__dirname, 'src/lib/diff.ts');

// --- Load the REAL diff.ts (TS -> ESM via the OXC transform Vite bundles) ----
const src = readFileSync(diffPath, 'utf8');
const { code } = await transformWithOxc(src, diffPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-diff-test-'));
const tmpFile = join(tmpDir, 'diff.mjs');
writeFileSync(tmpFile, code);
const { classifyDiffLine } = await import(tmpFile);
const { collectChangeRegions } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

console.log('\nclassifyDiffLine colors added/removed lines');
test('a "+" line is "add"', () => {
  assert.equal(classifyDiffLine('+added line'), 'add');
});
test('a "-" line is "remove"', () => {
  assert.equal(classifyDiffLine('-removed line'), 'remove');
});

console.log('\nfile-header trap: +++/--- are metadata, not add/remove');
test('the "+++ b/file" header is "meta" (NOT "add")', () => {
  assert.equal(classifyDiffLine('+++ b/src/server.js'), 'meta');
});
test('the "--- a/file" header is "meta" (NOT "remove")', () => {
  assert.equal(classifyDiffLine('--- a/src/server.js'), 'meta');
});

console.log('\nhunk headers and banners are "meta"/"hunk"');
test('a "@@ ... @@" hunk header is "hunk"', () => {
  assert.equal(classifyDiffLine('@@ -1,2 +1,3 @@'), 'hunk');
});
test('"diff --git" is "meta"', () => {
  assert.equal(classifyDiffLine('diff --git a/f b/f'), 'meta');
});
test('"index ..." is "meta"', () => {
  assert.equal(classifyDiffLine('index abc..def 100644'), 'meta');
});
test('"\\ No newline at end of file" is "meta"', () => {
  assert.equal(classifyDiffLine('\\ No newline at end of file'), 'meta');
});
test('"new file mode" is "meta"', () => {
  assert.equal(classifyDiffLine('new file mode 100644'), 'meta');
});

console.log('\ncontext lines are "context"');
test('a leading-space context line is "context"', () => {
  assert.equal(classifyDiffLine(' unchanged line'), 'context');
});
test('an empty line is "context"', () => {
  assert.equal(classifyDiffLine(''), 'context');
});

console.log('\nempty-diff edge cases render without error');
test('classifyDiffLine never throws on non-string-ish input passed as a line', () => {
  // The viewer maps split('\n') lines; a lone "" (empty diff string split) yields
  // ['']. classifyDiffLine must return a stable kind, not throw.
  assert.doesNotThrow(() => ''.split('\n').map(classifyDiffLine));
  assert.deepEqual(''.split('\n').map(classifyDiffLine), ['context']);
});

// --- collectChangeRegions (WARDEN-663 prev/next changed-region nav) ---------
// A region is the FIRST line index of each maximal run of consecutive add/remove
// lines; consecutive +/- lines collapse into ONE region so the indicator counts
// hunks-of-changes, not individual changed lines. Jump targets must always be
// changed lines (add/remove), never context/hunk/meta — the core acceptance rule.
const ONE_HUNK_TWO_REGIONS = [
  'diff --git a/f.txt b/f.txt', // 0  meta
  'index abc..def 100644',      // 1  meta
  '--- a/f.txt',                // 2  meta
  '+++ b/f.txt',                // 3  meta
  '@@ -1,3 +1,4 @@',            // 4  hunk
  ' ctx',                       // 5  context
  '-old2',                      // 6  remove -> region 0 (start of run)
  '+new2',                      // 7  add    (same run)
  '+new3',                      // 8  add    (same run)
  ' ctx',                       // 9  context (breaks the run)
  '@@ -10,2 +11,2 @@',          // 10 hunk   (breaks the run)
  ' ctx10',                     // 11 context
  '-old11',                     // 12 remove -> region 1 (start of run)
  '+new11',                     // 13 add    (same run)
].join('\n');

// A range-mode diff spanning two files — regions from BOTH files are collected in
// document order so the nav walks the whole unpushed/incoming set top to bottom.
const TWO_FILE_RANGE = [
  'diff --git a/a.txt b/a.txt', // 0  meta
  '--- a/a.txt',                // 1  meta
  '+++ b/a.txt',                // 2  meta
  '@@ -1,1 +1,1 @@',            // 3  hunk
  '-aOld',                      // 4  remove -> region 0
  '+aNew',                      // 5  add
  'diff --git b/b.txt b/b.txt', // 6  meta
  '--- b/b.txt',                // 7  meta
  '+++ b/b.txt',                // 8  meta
  '@@ -1,1 +1,2 @@',            // 9  hunk
  ' bCtx',                      // 10 context
  '+bNew',                      // 11 add -> region 1
].join('\n');

console.log('\ncollectChangeRegions returns the first line of each add/remove run');
test('a single file with two hunks yields two regions at the run starts', () => {
  assert.deepEqual(collectChangeRegions(ONE_HUNK_TWO_REGIONS), [6, 12]);
});
test('a two-file range diff collects regions from both files in order', () => {
  assert.deepEqual(collectChangeRegions(TWO_FILE_RANGE), [4, 11]);
});

console.log('\nevery region index points at a changed (add/remove) line — never context/hunk/meta');
test('region targets are all add/remove lines (single file)', () => {
  const lines = ONE_HUNK_TWO_REGIONS.split('\n');
  const regions = collectChangeRegions(ONE_HUNK_TWO_REGIONS);
  assert.ok(regions.length > 0);
  for (const i of regions) {
    const kind = classifyDiffLine(lines[i]);
    assert.ok(kind === 'add' || kind === 'remove', `region ${i} is ${kind}, not add/remove`);
  }
});
test('consecutive add/remove lines collapse into a single region (counts regions, not lines)', () => {
  // ONE_HUNK_TWO_REGIONS has FOUR changed lines in its first hunk (1 remove + 2 add
  // ... = 3, then a separate hunk) — assert the run collapses to ONE entry, not three.
  const firstHunkChangedLines = 3; // lines 6,7,8
  const regions = collectChangeRegions(ONE_HUNK_TWO_REGIONS);
  assert.equal(regions.length, 2);
  assert.ok(!regions.includes(7) && !regions.includes(8), 'mid-run lines must not be regions');
  // sanity: the count is below the raw changed-line count
  const changedLineCount = ONE_HUNK_TWO_REGIONS.split('\n')
    .filter(l => { const k = classifyDiffLine(l); return k === 'add' || k === 'remove'; }).length;
  assert.ok(changedLineCount >= firstHunkChangedLines + 2);
  assert.ok(regions.length < changedLineCount);
});

console.log('\nfile-header / hunk / metadata lines are never counted as regions');
test('+++/--- headers are NOT regions (the file-header trap, again)', () => {
  const diff = ['--- a/f', '+++ b/f', '@@ -1,1 +1,1 @@', '-old', '+new'].join('\n');
  // Only the -old/+new run counts; headers/hunk are skipped. Region points at -old (index 3).
  assert.deepEqual(collectChangeRegions(diff), [3]);
  const lines = diff.split('\n');
  assert.equal(classifyDiffLine(lines[3]), 'remove');
});

console.log('\nempty / no-change diffs yield no regions (nav stays hidden — WARDEN-68)');
test('an empty diff string yields []', () => {
  assert.deepEqual(collectChangeRegions(''), []);
});
test('a diff with only context + meta (no add/remove) yields []', () => {
  const diff = ['diff --git a/f b/f', '--- a/f', '+++ b/f', '@@ -1,1 +1,1 @@', ' unchanged'].join('\n');
  assert.deepEqual(collectChangeRegions(diff), []);
});
test('a single-region diff (one run) yields exactly one entry', () => {
  const diff = ['@@ -1,2 +1,2 @@', ' ctx', '-old', '+new'].join('\n');
  assert.deepEqual(collectChangeRegions(diff), [2]);
});

console.log(`\n✓ DIFF TESTS PASS (${passed})`);
