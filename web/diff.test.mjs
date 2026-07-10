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

console.log(`\n✓ DIFF TESTS PASS (${passed})`);
