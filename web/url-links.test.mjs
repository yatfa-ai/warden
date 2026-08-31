// Tests for findUrlCandidates / maskUrls — the pure http(s) URL extractor behind
// WARDEN-1256's in-terminal clickable URLs.
//
// Same harness as path-links.test.mjs (no front-end test runner in this repo):
// load the REAL src/lib/url-links.ts (transpiled TS -> ESM via Vite's OXC
// transform) and exercise it directly. The extractor decides which substrings
// become links, how trailing punctuation is trimmed, how a wrap-split URL is
// excluded, and how the path matcher's input is masked — the risky pure-logic
// pieces. The opener (OS browser via the wardenWindow bridge) and the xterm
// wiring are integration concerns verified live; these tests pin the recognition
// half so a regex slip can't silently break it.
//
// Run: node url-links.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const urlLinksPath = resolve(__dirname, 'src/lib/url-links.ts');

// --- Load the REAL url-links.ts (TS -> ESM via the OXC transform Vite bundles) -
const src = readFileSync(urlLinksPath, 'utf8');
const { code } = await transformWithOxc(src, urlLinksPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-urllinks-test-'));
const tmpFile = join(tmpDir, 'url-links.mjs');
writeFileSync(tmpFile, code);
const { findUrlCandidates, maskUrls } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// Convenience: just the URL strings recognized on a line.
const urls = (line, opts) => findUrlCandidates(line, opts).map((c) => c.url);

console.log('\nrecognition — http(s) URLs are found whole');
test('a plain https URL mid-line is one candidate', () => {
  assert.deepEqual(urls('see https://github.com/org/repo/pull/42 for the PR'),
    ['https://github.com/org/repo/pull/42']);
});
test('http with host, port and path is captured in full', () => {
  assert.deepEqual(urls('serving http://localhost:7421/api/foo.json now'),
    ['http://localhost:7421/api/foo.json']);
});
test('a URL at start or end of line is recognized', () => {
  assert.deepEqual(urls('https://a.dev/x is at the start'), ['https://a.dev/x']);
  assert.deepEqual(urls('at the end: http://b.dev/y'), ['http://b.dev/y']);
});
test('multiple URLs on one line are independent candidates', () => {
  assert.deepEqual(urls('a https://x.dev/1 b http://y.dev/2 c'), ['https://x.dev/1', 'http://y.dev/2']);
});
test('uppercase schemes are recognized (case-insensitive)', () => {
  assert.deepEqual(urls('go HTTPS://EXAMPLE.COM/X here'), ['HTTPS://EXAMPLE.COM/X']);
});
test('a scheme glued to a word is not linkified (word boundary)', () => {
  assert.deepEqual(urls('xhttps://a.com is not a link'), []);
  assert.deepEqual(urls('foo.https://a.com is a link'), ['https://a.com']);
});
test('a second scheme inside an earlier URL token yields ONE candidate, not two', () => {
  // `https://a.https://b` — the `.` before the second scheme is a word
  // boundary and the first scan consumes to whitespace, covering it. The inner
  // match must be skipped so candidates never overlap.
  assert.deepEqual(urls('see https://a.https://b now'), ['https://a.https://b']);
});

console.log('\nrange geometry — start/length reconstruct the exact URL');
test('range spans exactly the URL text', () => {
  const line = '  see https://a.dev/x/y end';
  const [c] = findUrlCandidates(line);
  assert.equal(line.slice(c.start, c.start + c.length), 'https://a.dev/x/y');
});
test('range reflects the punctuation-trimmed length, not the raw token', () => {
  const line = 'go to https://a.dev/x.';
  const [c] = findUrlCandidates(line);
  assert.equal(line.slice(c.start, c.start + c.length), 'https://a.dev/x');
  assert.equal(c.url, 'https://a.dev/x');
});

console.log('\ntrailing punctuation — sentence marks are trimmed off the tail');
test('trailing period / comma / colon / question / bang are trimmed', () => {
  assert.deepEqual(urls('PR https://a.dev/x.'), ['https://a.dev/x']);
  assert.deepEqual(urls('PR https://a.dev/x,'), ['https://a.dev/x']);
  assert.deepEqual(urls('PR https://a.dev/x:'), ['https://a.dev/x']);
  assert.deepEqual(urls('PR https://a.dev/x?'), ['https://a.dev/x']);
  assert.deepEqual(urls('PR https://a.dev/x!'), ['https://a.dev/x']);
});
test('an unbalanced closing paren is trimmed, the open stays behind', () => {
  // The `)` has no matching open inside the url, so it is sentence punctuation.
  assert.deepEqual(urls('read (https://a.dev/x) now'), ['https://a.dev/x']);
});
test('balanced parens INSIDE the url are kept (wikipedia-style)', () => {
  assert.deepEqual(urls('see https://en.wikipedia.org/wiki/Foo_(bar) ok'),
    ['https://en.wikipedia.org/wiki/Foo_(bar)']);
});
test('angle-bracketed URLs are recognized without the brackets', () => {
  assert.deepEqual(urls('<https://a.dev/x>'), ['https://a.dev/x']);
});
test('a run of trailing punctuation is trimmed entirely', () => {
  assert.deepEqual(urls('see https://a.dev/x).'), ['https://a.dev/x']);
});

console.log('\nnon-candidates — bare schemes and other schemes');
test('a scheme with nothing after it is not a link', () => {
  assert.deepEqual(urls('go to https:// now'), []);
  assert.deepEqual(urls('go to http://.'), []);
});
test('non-http schemes are out of scope', () => {
  assert.deepEqual(urls('ftp://a.dev/x.js file:///etc/passwd ssh://git@h/r'), []);
  assert.deepEqual(urls('mailto:a@b.dev and https://c.dev keep'), ['https://c.dev']);
});
test('bare host:port without a scheme is not a link', () => {
  assert.deepEqual(urls('listening on localhost:7421'), []);
});

console.log('\nline-wrap — a URL split by the terminal wrap is not linked');
test('wrappedAtEol drops a URL that runs to end-of-line', () => {
  assert.deepEqual(findUrlCandidates('see https://a.dev/very/long/path', { wrappedAtEol: true }), []);
});
test('wrappedAtEol keeps URLs that end mid-line (the wrap splits later text)', () => {
  assert.deepEqual(urls('see https://a.dev/x and then more words wrap', { wrappedAtEol: true }),
    ['https://a.dev/x']);
});
test('without wrap context the same URL is a normal candidate', () => {
  assert.deepEqual(urls('see https://a.dev/very/long/path'), ['https://a.dev/very/long/path']);
});
test('a dropped wrapped URL does not affect neighbours on the same line', () => {
  const line = 'first https://a.dev/one then https://b.dev/x';
  const found = urls(line, { wrappedAtEol: true });
  // b.dev/x touches EOL → dropped; a.dev/one ends mid-line → kept.
  assert.deepEqual(found, ['https://a.dev/one']);
});

console.log('\nmaskUrls — URL spans blank out for the path matcher');
test('masking preserves length and all non-URL text', () => {
  const line = 'See http://localhost:7421/api/foo.json end';
  const masked = maskUrls(line);
  assert.equal(masked.length, line.length);
  assert.ok(!masked.includes('http'), 'no URL text may survive masking');
  assert.equal(masked.slice(0, 4), 'See ');
  assert.equal(masked.slice(-4), ' end');
});
test('a line without URLs passes through unchanged', () => {
  assert.equal(maskUrls('edit src/server.js:42 now'), 'edit src/server.js:42 now');
});
test('masking a wrap-split URL fragment still blanks it (path matcher protection)', () => {
  // maskUrls applies no wrap context on purpose: any URL-shaped span is masked
  // so its path-like tail can never leak into path candidates.
  const line = 'see https://a.dev/x/y.js';
  assert.equal(maskUrls(line).trim(), 'see');
});
test('masking is astral-character safe (UTF-16 indices, not code-point indices)', () => {
  // An emoji before the URL: its UTF-16 length (2) must not shift the masked
  // span — masking stays index-true against the original line.
  const line = '🦆 doc https://a.dev/x.json';
  const masked = maskUrls(line);
  assert.equal(masked.length, line.length);
  assert.equal(masked.slice(0, 6), '🦆 doc');
  assert.ok(!masked.includes('https'));
});

console.log(`\n${passed} passed`);
