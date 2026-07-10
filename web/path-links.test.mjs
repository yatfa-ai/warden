// Tests for findPathCandidates — the pure path-token extractor behind WARDEN-227's
// in-terminal clickable file paths.
//
// There is no front-end test runner in this repo, so (like storage.test.mjs) this
// loads the REAL src/lib/path-links.ts (transpiled TS -> ESM via Vite's OXC
// transform) and exercises it directly. The extractor is the riskiest pure-logic
// piece: it decides which substrings become candidates, splits path from an
// optional `:line[:col]` suffix, and must NOT fire on bare words, version numbers,
// or URL authorities. The async existence check is the real gate downstream; these
// tests pin the candidate-selection half so a regex slip can't silently break it.
//
// Run: node path-links.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pathLinksPath = resolve(__dirname, 'src/lib/path-links.ts');

// --- Load the REAL path-links.ts (TS -> ESM via the OXC transform Vite bundles) -
const src = readFileSync(pathLinksPath, 'utf8');
const { code } = await transformWithOxc(src, pathLinksPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-pathlinks-test-'));
const tmpFile = join(tmpDir, 'path-links.mjs');
writeFileSync(tmpFile, code);
const { findPathCandidates } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// Convenience: collect just the {path, line, col} of every candidate on a line,
// ignoring the range geometry (tested separately).
const picks = (line) => findPathCandidates(line).map((c) => ({ path: c.path, line: c.line, col: c.col }));

console.log('\npath extraction — keeps real relative paths with an extension');
test('a relative path with a slash and extension is a candidate', () => {
  const [c] = findPathCandidates('see deployment/monitoring/alertmanager-telegram.yaml for alerts');
  assert.ok(c, 'expected a candidate');
  assert.equal(c.path, 'deployment/monitoring/alertmanager-telegram.yaml');
  assert.equal(c.line, undefined);
});
test('a single-segment relative path is a candidate', () => {
  assert.deepEqual(picks('edit src/server.js now'), [{ path: 'src/server.js', line: undefined, col: undefined }]);
});
test('a ./-prefixed path is captured verbatim (read-file handles ./)', () => {
  assert.deepEqual(picks('run ./scripts/build.sh please'), [{ path: './scripts/build.sh', line: undefined, col: undefined }]);
});

console.log('\n:line and :line:col suffixes — split off the path, not sent to existence');
test('path:line parses the line off the path', () => {
  assert.deepEqual(picks('error at src/server.js:42 says no'), [{ path: 'src/server.js', line: 42, col: undefined }]);
});
test('path:line:col parses both line and col', () => {
  assert.deepEqual(picks('see app.ts:10:5'), [{ path: 'app.ts', line: 10, col: 5 }]);
});
test('a slashless name.ext:line is still a candidate (file:line ref)', () => {
  // AC example app.ts:10:5 has no slash; we linkify name.ext only when it carries
  // a :line suffix (so bare package.json / README.md are NOT probed).
  assert.deepEqual(picks('fail app.ts:10:5 boom'), [{ path: 'app.ts', line: 10, col: 5 }]);
});
test('the :line suffix is excluded from the path field', () => {
  const [c] = findPathCandidates('x src/server.js:42:9 y');
  assert.equal(c.path, 'src/server.js');
  assert.equal(c.line, 42);
  assert.equal(c.col, 9);
});

console.log('\nrange geometry — start/length cover the FULL token including :line[:col]');
test('range spans path + :line[:col] so the whole token is the clickable region', () => {
  const line = '  src/server.js:42';
  const [c] = findPathCandidates(line);
  assert.equal(c.start, 2);
  assert.equal(c.length, 'src/server.js:42'.length);
  assert.equal(line.slice(c.start, c.start + c.length), 'src/server.js:42');
});
test('multiple candidates on one line are each returned with independent ranges', () => {
  const line = 'a/foo.js and b/bar.js:7';
  const cs = findPathCandidates(line);
  assert.equal(cs.length, 2);
  assert.equal(cs[0].path, 'a/foo.js');
  assert.equal(cs[1].path, 'b/bar.js');
  assert.equal(cs[1].line, 7);
  // ranges reconstruct the exact tokens
  assert.equal(line.slice(cs[0].start, cs[0].start + cs[0].length), 'a/foo.js');
  assert.equal(line.slice(cs[1].start, cs[1].start + cs[1].length), 'b/bar.js:7');
});

console.log('\nnon-candidates — bare words / versions / URLs must NOT trigger probes');
test('a bare name.ext with no slash and no line is skipped', () => {
  assert.deepEqual(picks('see package.json and README.md'), []);
});
test('a version number is skipped', () => {
  assert.deepEqual(picks('upgraded to 1.2.3 today'), []);
});
test('a word with no extension is skipped', () => {
  assert.deepEqual(picks('edit src/server'), []);
});
test('a directory with no extension is skipped', () => {
  assert.deepEqual(picks('cd src/components'), []);
});
test('an http(s) URL authority is skipped (no wasted probe)', () => {
  // https://github.com/repo/file.js contains a path-like tail but never resolves
  // under cwd; the extractor must not offer it.
  assert.deepEqual(picks('see https://github.com/org/repo/blob/main/file.js here'), []);
});
test('a slashless name.ext without a line is skipped even next to a real candidate', () => {
  // package.json (no slash, no line) is ignored; src/index.js (slash) is kept.
  assert.deepEqual(picks('see package.json then src/index.js'), [{ path: 'src/index.js', line: undefined, col: undefined }]);
});

console.log('\nedge cases');
test('empty / whitespace-only lines yield no candidates', () => {
  assert.deepEqual(findPathCandidates(''), []);
  assert.deepEqual(findPathCandidates('   '), []);
});
test('absolute paths are candidates', () => {
  const [c] = findPathCandidates('log at /var/log/app.log done');
  assert.equal(c.path, '/var/log/app.log');
});
test('two adjacent path candidates do not overlap (matchAll is non-overlapping)', () => {
  const line = 'a/x.js b/y.js';
  const cs = findPathCandidates(line);
  assert.equal(cs.length, 2);
  assert.ok(cs[0].start + cs[0].length <= cs[1].start, 'candidates must not overlap');
});

console.log(`\n${passed} passed`);
