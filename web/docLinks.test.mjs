// Tests for resolveDocRelative — the pure resolver behind WARDEN-805's in-doc
// relative file links (rendered markdown in the FileViewer).
//
// There is no front-end test runner in this repo, so (like path-links.test.mjs)
// this loads the REAL src/lib/docLinks.ts (transpiled TS -> ESM via Vite's OXC
// transform) and exercises it directly. The resolver is the riskiest pure-logic
// piece: it must resolve `./sibling`, `../parent`, and `dir/x` against the
// rendering doc's directory, clamp `..` at the repo root, and return null for
// every non-relative href (schemes, anchors, absolute paths) so MarkdownBody
// falls back to its unchanged external rendering. These tests pin that contract
// so a regex/normalize slip can't silently turn an external link into a
// misrouted in-app nav (or vice versa).
//
// Run: node docLinks.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const docLinksPath = resolve(__dirname, 'src/lib/docLinks.ts');

// --- Load the REAL docLinks.ts (TS -> ESM via the OXC transform Vite bundles) -
const src = readFileSync(docLinksPath, 'utf8');
const { code } = await transformWithOxc(src, docLinksPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-doclinks-test-'));
const tmpFile = join(tmpDir, 'docLinks.mjs');
writeFileSync(tmpFile, code);
const { resolveDocRelative } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

console.log('\nrelative file refs — resolve against the doc\'s directory');
test('a ./-prefixed sibling resolves into the doc\'s dir', () => {
  assert.equal(resolveDocRelative('docs/README.md', './INSTALL.md'), 'docs/INSTALL.md');
});
test('a bare sibling resolves into the doc\'s dir (z.md case)', () => {
  assert.equal(resolveDocRelative('docs/README.md', 'INSTALL.md'), 'docs/INSTALL.md');
});
test('a subdir-relative path resolves (dir/z.md)', () => {
  assert.equal(resolveDocRelative('docs/README.md', 'notes/draft.md'), 'docs/notes/draft.md');
});
test('../ climbs one level out of the doc\'s dir', () => {
  // doc at docs/notes.md references ../lib/utils.ts -> lib/utils.ts
  assert.equal(resolveDocRelative('docs/notes.md', '../lib/utils.ts'), 'lib/utils.ts');
});
test('a root-level doc resolves a sibling at root', () => {
  assert.equal(resolveDocRelative('README.md', './CONTRIBUTING.md'), 'CONTRIBUTING.md');
});

console.log('\nclamping — a ../ past repo root never produces a leading ../');
test('one ../ from a root-level file clamps to root', () => {
  assert.equal(resolveDocRelative('README.md', '../LICENSE'), 'LICENSE');
});
test('multiple ../ past root still clamp (no leading ../)', () => {
  assert.equal(resolveDocRelative('README.md', '../../../etc/foo.md'), 'etc/foo.md');
});
test('multiple ../ from a nested doc climb then clamp', () => {
  // docs/README.md + ../../top.md -> climbs past root, clamps -> top.md
  assert.equal(resolveDocRelative('docs/README.md', '../../top.md'), 'top.md');
});

console.log('\ntrailing anchor / query — stripped before resolving');
test('a trailing #anchor is dropped from the resolved path', () => {
  assert.equal(resolveDocRelative('docs/README.md', './INSTALL.md#install'), 'docs/INSTALL.md');
});
test('a trailing ?query is dropped from the resolved path', () => {
  assert.equal(resolveDocRelative('docs/README.md', './INSTALL.md?v=1'), 'docs/INSTALL.md');
});
test('anchor + query together are both dropped', () => {
  assert.equal(resolveDocRelative('docs/README.md', 'INSTALL.md#sec?x=1'), 'docs/INSTALL.md');
});

console.log('\nnon-relative hrefs — return null (MarkdownBody renders external)');
test('http(s) URLs return null', () => {
  assert.equal(resolveDocRelative('docs/README.md', 'https://example.com/x.md'), null);
  assert.equal(resolveDocRelative('docs/README.md', 'http://example.com'), null);
});
test('mailto: returns null', () => {
  assert.equal(resolveDocRelative('docs/README.md', 'mailto:a@b.com'), null);
});
test('tel: returns null', () => {
  assert.equal(resolveDocRelative('docs/README.md', 'tel:+155512345'), null);
});
test('data: URIs return null', () => {
  assert.equal(resolveDocRelative('docs/README.md', 'data:text/plain;base64,aGk='), null);
});
test('ftp: returns null', () => {
  assert.equal(resolveDocRelative('docs/README.md', 'ftp://host/x.md'), null);
});
test('protocol-relative //host/path returns null', () => {
  assert.equal(resolveDocRelative('docs/README.md', '//example.com/x.md'), null);
});
test('absolute /path returns null (not a relative ref)', () => {
  assert.equal(resolveDocRelative('docs/README.md', '/src/index.ts'), null);
});
test('anchor-only #section returns null', () => {
  assert.equal(resolveDocRelative('docs/README.md', '#top'), null);
  assert.equal(resolveDocRelative('docs/README.md', '#'), null);
});
test('empty href returns null', () => {
  assert.equal(resolveDocRelative('docs/README.md', ''), null);
  assert.equal(resolveDocRelative('docs/README.md', '   '), null);
});

console.log('\nedge cases');
test('./ collapses a same-dir . segment', () => {
  // docs/./README.md as the base still resolves ./INSTALL.md into docs/
  assert.equal(resolveDocRelative('docs/README.md', '././INSTALL.md'), 'docs/INSTALL.md');
});
test('a deeply nested doc resolves a multi-segment ../chain', () => {
  // a/b/c/notes.md references ../../shared/util.ts -> a/shared/util.ts
  assert.equal(resolveDocRelative('a/b/c/notes.md', '../../shared/util.ts'), 'a/shared/util.ts');
});
test('non-string href returns null (defensive)', () => {
  assert.equal(resolveDocRelative('docs/README.md', undefined), null);
  assert.equal(resolveDocRelative('docs/README.md', null), null);
});
test('a Windows-drive-style C:\\ path returns null (scheme regex)', () => {
  assert.equal(resolveDocRelative('docs/README.md', 'C:\\Users\\x\\README.md'), null);
});

console.log(`\n${passed} passed`);
