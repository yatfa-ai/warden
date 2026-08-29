// Tests for the pure pin helpers in src/lib/pinSync.ts (WARDEN-1240).
//
// The sidebar's PUT /api/pins replaces the stored list wholesale, so the two
// rules under test are the whole fix: (1) a failed or error-bodied load parses
// to null ("unknown"), never an empty set — so the next pin write can never
// wipe the stored list; (2) toggling builds a fresh set per call, letting
// serialized writes each land their own change instead of racing snapshots.
//
// Run: node pinSync.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libDir = resolve(__dirname, 'src/lib');

// --- Load the REAL pinSync.ts (TS -> ESM via OXC) ---------------------------
const src = readFileSync(join(libDir, 'pinSync.ts'), 'utf8');
const { code } = await transformWithOxc(src, join(libDir, 'pinSync.ts'), {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-pinsync-test-'));
const tmpFile = join(tmpDir, 'pinSync.mjs');
writeFileSync(tmpFile, code);
const { parseLoadedPins, nextPins } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// ---------------------------------------------------------------------------
console.log('\nparseLoadedPins — a trustworthy pin list');
// ---------------------------------------------------------------------------
test('valid pins array → set of ids', () => {
  assert.deepEqual([...parseLoadedPins({ pins: ['a', 'b'] })].sort(), ['a', 'b']);
});
test('empty pins array → empty set (a VERIFIED empty list)', () => {
  assert.equal(parseLoadedPins({ pins: [] }).size, 0);
});
test('non-array pins → null (unknown, not empty)', () => {
  assert.equal(parseLoadedPins({ pins: 'a,b' }), null);
});
test('error body → null (a parseable error response is a failure)', () => {
  assert.equal(parseLoadedPins({ error: 'pins must be an array' }), null);
});
test('missing pins key → null', () => {
  assert.equal(parseLoadedPins({}), null);
});
test('non-object body → null', () => {
  assert.equal(parseLoadedPins(null), null);
  assert.equal(parseLoadedPins('ok'), null);
});
test('non-string / empty-string entries are dropped', () => {
  const pins = parseLoadedPins({ pins: ['a', 42, null, '', 'b'] });
  assert.deepEqual([...pins].sort(), ['a', 'b']);
});

// ---------------------------------------------------------------------------
console.log('\nnextPins — toggle math');
// ---------------------------------------------------------------------------
test('adds an unpinned chat', () => {
  assert.deepEqual([...nextPins(new Set(['a']), 'b')].sort(), ['a', 'b']);
});
test('removes a pinned chat (unpin still works)', () => {
  assert.deepEqual([...nextPins(new Set(['a', 'b']), 'a')], ['b']);
});
test('returns a NEW set — the input is never mutated', () => {
  const current = new Set(['a']);
  const next = nextPins(current, 'b');
  assert.notEqual(next, current);
  assert.deepEqual([...current], ['a']); // caller can safely hold the old ref
});
test('each toggle compounds — three rapid pins all survive serialization', () => {
  let pins = new Set();
  for (const id of ['a', 'b', 'c']) pins = nextPins(pins, id);
  assert.deepEqual([...pins].sort(), ['a', 'b', 'c']);
});

console.log(`\n${passed} passed\n`);
