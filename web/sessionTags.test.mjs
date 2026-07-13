// Tests for the session-tag pure helpers (WARDEN-342), extracted from ChatSidebar
// into src/lib/sessionTags.ts so the orphan-hiding + tag-filter + add/remove logic
// is unit-testable without a React runner. Like agentFilter.test.mjs and
// diff.test.mjs this loads the REAL src/lib/sessionTags.ts (transpiled TS -> ESM via
// Vite's OXC transform) and exercises it directly with plain objects.
//
// Coverage focus — the success criteria the frontend is responsible for:
//   · computeTagsInUse hides orphan tags (a vanished session's tag is never shown)
//   · filterSessionsByTags is a union (ANY active tag) and a no-op when unfiltered
//   · addTag trims + case-insensitive-dedupes; removeTag is exact-match
//
// Run: node sessionTags.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libPath = resolve(__dirname, 'src/lib/sessionTags.ts');

// --- Load the REAL sessionTags.ts (TS -> ESM via the OXC transform Vite bundles)
const src = readFileSync(libPath, 'utf8');
const { code } = await transformWithOxc(src, libPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-sessiontags-test-'));
const tmpFile = join(tmpDir, 'sessionTags.mjs');
writeFileSync(tmpFile, code);
const { computeTagsInUse, filterSessionsByTags, addTag, removeTag } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}`); console.error(e); process.exitCode = 1; }
};

console.log('computeTagsInUse:');
test('returns the distinct set of tags among in-list session ids, sorted', () => {
  const sessions = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const tags = { a: ['shipped', 'auth'], b: ['shipped'], c: ['needs-review'] };
  assert.deepStrictEqual(computeTagsInUse(sessions, tags), ['auth', 'needs-review', 'shipped']);
});

test('hides orphan tags — a tag on a session NOT in the list is never shown', () => {
  // `gone` is in the sidecar but absent from sessions (the session vanished): its
  // tags must be ignored, not surfaced. This is the "never throws / never shown on
  // a disappeared session" success criterion.
  const sessions = [{ id: 'a' }];
  const tags = { a: ['shipped'], gone: ['abandoned', 'reference'] };
  assert.deepStrictEqual(computeTagsInUse(sessions, tags), ['shipped']);
});

test('returns [] when no session has tags (or the list is empty)', () => {
  assert.deepStrictEqual(computeTagsInUse([], { a: ['x'] }), []);
  assert.deepStrictEqual(computeTagsInUse([{ id: 'a' }], {}), []);
});

test('ignores malformed sidecar values (non-array / falsy) without throwing', () => {
  const sessions = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const tags = { a: ['ok'], b: null, c: 'not-an-array' };
  assert.deepStrictEqual(computeTagsInUse(sessions, tags), ['ok']);
});

console.log('\nfilterSessionsByTags:');
test('returns ALL sessions (a copy) when no filter is active', () => {
  const sessions = [{ id: 'a' }, { id: 'b' }];
  const tags = { a: ['shipped'] };
  const out = filterSessionsByTags(sessions, tags, new Set());
  assert.deepStrictEqual(out.map((s) => s.id), ['a', 'b']);
  assert.notStrictEqual(out, sessions, 'must return a copy, not the same reference');
});

test('union semantics — a session matches if it bears ANY active tag', () => {
  const sessions = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const tags = { a: ['shipped'], b: ['needs-review'], c: ['shipped', 'auth'], d: ['reference'] };
  // active: shipped OR auth → a (shipped), c (shipped+auth). b (needs-review) and
  // d (reference) are excluded.
  const out = filterSessionsByTags(sessions, tags, new Set(['shipped', 'auth']));
  assert.deepStrictEqual(out.map((s) => s.id), ['a', 'c']);
});

test('preserves source order (does not re-sort)', () => {
  const sessions = [{ id: 'z' }, { id: 'a' }, { id: 'm' }];
  const tags = { z: ['t'], a: ['t'], m: ['t'] };
  const out = filterSessionsByTags(sessions, tags, new Set(['t']));
  assert.deepStrictEqual(out.map((s) => s.id), ['z', 'a', 'm']);
});

test('a session with no tags is excluded when a filter is active', () => {
  const sessions = [{ id: 'a' }, { id: 'b' }];
  const tags = { a: ['shipped'] }; // b has no tags entry
  const out = filterSessionsByTags(sessions, tags, new Set(['shipped']));
  assert.deepStrictEqual(out.map((s) => s.id), ['a']);
});

console.log('\naddTag / removeTag:');
test('addTag trims whitespace', () => {
  assert.deepStrictEqual(addTag([], '  shipped  '), ['shipped']);
});

test('addTag case-insensitively dedupes (keeps existing casing)', () => {
  assert.deepStrictEqual(addTag(['Shipped'], 'shipped'), ['Shipped']);
  assert.deepStrictEqual(addTag(['shipped'], 'SHIPPED'), ['shipped']);
});

test('addTag appends a genuinely new tag, preserving order', () => {
  assert.deepStrictEqual(addTag(['shipped'], 'auth'), ['shipped', 'auth']);
});

test('addTag returns a copy even for empty/blank input (no mutation, no add)', () => {
  const existing = ['shipped'];
  const out = addTag(existing, '   ');
  assert.deepStrictEqual(out, ['shipped']);
  assert.notStrictEqual(out, existing);
});

test('removeTag does exact-match removal (case-sensitive, no trim)', () => {
  assert.deepStrictEqual(removeTag(['shipped', 'auth'], 'auth'), ['shipped']);
  // case-sensitive: 'Shipped' does not match 'shipped'
  assert.deepStrictEqual(removeTag(['shipped'], 'Shipped'), ['shipped']);
});

test('removeTag returns a new array, never mutating the input', () => {
  const existing = ['shipped', 'auth'];
  const out = removeTag(existing, 'auth');
  assert.deepStrictEqual(existing, ['shipped', 'auth'], 'input must be unchanged');
  assert.deepStrictEqual(out, ['shipped']);
});

console.log(`\n${passed} passed`);
