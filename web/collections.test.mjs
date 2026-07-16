// Tests for the Collections criteria helpers (WARDEN-553), extracted into
// src/lib/collections.ts so the matcher + the new custom-criteria parser are
// unit-testable without a React runner. The extracted functions are PURE (no
// React, no imports beyond types), so (like agentFilter.test.mjs and
// diff.test.mjs) this loads the REAL src/lib/collections.ts (transpiled TS -> ESM
// via Vite's OXC transform) and exercises it directly with plain objects.
//
// Coverage focus:
//   - parseCustomCriteria: the writable half of the "custom criteria" grouping
//     the Create dialog advertises. Split / trim / drop-empty / dedupe / empty.
//   - chatMatchesCriteria: the matcher mirrored from the backend
//     (src/collections.js:getAgentsInCollection) — AND across role/project/host,
//     custom is an OR over its values each compared against role/project/host/name.
//     This is the logic the card count, the open-view membership list, and the
//     server's /api/collections/:id/agents must agree on, so it is the crux of
//     WARDEN-553's success criteria (a custom value like `warden` must match, not
//     read as 0).
//   - countAgentsInCollection: the no-criteria → 0 guard preserved from the old
//     CollectionsSection inline copy.
//
// Run: node collections.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libPath = resolve(__dirname, 'src/lib/collections.ts');

// --- Load the REAL collections.ts (TS -> ESM via the OXC transform Vite bundles)
const src = readFileSync(libPath, 'utf8');
const { code } = await transformWithOxc(src, libPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-collections-test-'));
const tmpFile = join(tmpDir, 'collections.mjs');
writeFileSync(tmpFile, code);
const { parseCustomCriteria, chatMatchesCriteria, countAgentsInCollection } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// Tiny chat builder so each case reads as "what kind of agent is this".
const chat = (over = {}) => ({ id: 'c1', host: '(local)', ...over });
const criteria = (over = {}) => ({ ...over });

// ---------------------------------------------------------------------------
console.log('\nparseCustomCriteria — split / trim / drop-empty / dedupe');
// ---------------------------------------------------------------------------
test('empty string → []', () => {
  assert.deepEqual(parseCustomCriteria(''), []);
});
test('whitespace-only → []', () => {
  assert.deepEqual(parseCustomCriteria('   '), []);
  assert.deepEqual(parseCustomCriteria(' , , , '), []);
});
test('single value → [value]', () => {
  assert.deepEqual(parseCustomCriteria('warden'), ['warden']);
});
test('trims whitespace around each value', () => {
  assert.deepEqual(parseCustomCriteria('  warden , server1 '), ['warden', 'server1']);
});
test('comma-separated list → string[] in order', () => {
  assert.deepEqual(parseCustomCriteria('warden, server1, worker'), ['warden', 'server1', 'worker']);
});
test('drops empties between commas', () => {
  assert.deepEqual(parseCustomCriteria('warden,,worker,'), ['warden', 'worker']);
});
test('dedupes (first-wins, order preserved)', () => {
  assert.deepEqual(parseCustomCriteria('warden, server1, warden, worker, server1'), ['warden', 'server1', 'worker']);
});
test('case-sensitive (Warden ≠ warden — both kept)', () => {
  assert.deepEqual(parseCustomCriteria('Warden, warden'), ['Warden', 'warden']);
});
test('null/undefined input → [] (defensive)', () => {
  assert.deepEqual(parseCustomCriteria(null), []);
  assert.deepEqual(parseCustomCriteria(undefined), []);
});

// ---------------------------------------------------------------------------
console.log('\nchatMatchesCriteria — role / project / host (AND across)');
// ---------------------------------------------------------------------------
test('no filters (empty criteria) → matches every agent', () => {
  assert.equal(chatMatchesCriteria(chat(), criteria()), true);
});
test('role filter matches when equal', () => {
  assert.equal(chatMatchesCriteria(chat({ role: 'worker' }), criteria({ role: 'worker' })), true);
});
test('role filter rejects on mismatch', () => {
  assert.equal(chatMatchesCriteria(chat({ role: 'reviewer' }), criteria({ role: 'worker' })), false);
});
test('project filter matches when equal', () => {
  assert.equal(chatMatchesCriteria(chat({ project: 'warden' }), criteria({ project: 'warden' })), true);
});
test('host filter matches when equal', () => {
  assert.equal(chatMatchesCriteria(chat({ host: 'server1' }), criteria({ host: 'server1' })), true);
});
test('AND across role + project — both must hold', () => {
  const c = criteria({ role: 'worker', project: 'warden' });
  assert.equal(chatMatchesCriteria(chat({ role: 'worker', project: 'warden' }), c), true);
  assert.equal(chatMatchesCriteria(chat({ role: 'worker', project: 'tinker' }), c), false);
  assert.equal(chatMatchesCriteria(chat({ role: 'reviewer', project: 'warden' }), c), false);
});

// ---------------------------------------------------------------------------
console.log('\nchatMatchesCriteria — custom (OR within; AND across the rest)');
// ---------------------------------------------------------------------------
test('custom matches when a value equals the chat role', () => {
  assert.equal(chatMatchesCriteria(chat({ role: 'worker' }), criteria({ custom: ['worker'] })), true);
});
test('custom matches when a value equals the chat project', () => {
  assert.equal(chatMatchesCriteria(chat({ project: 'warden' }), criteria({ custom: ['warden'] })), true);
});
test('custom matches when a value equals the chat host', () => {
  assert.equal(chatMatchesCriteria(chat({ host: 'server1' }), criteria({ custom: ['server1'] })), true);
});
test('custom matches when a value equals the chat name', () => {
  assert.equal(chatMatchesCriteria(chat({ name: 'My Agent' }), criteria({ custom: ['My Agent'] })), true);
});
test('custom rejects when no value matches any field', () => {
  assert.equal(
    chatMatchesCriteria(chat({ role: 'worker', project: 'warden', host: 'server1', name: 'X' }), criteria({ custom: ['nope'] })),
    false,
  );
});
test('custom is OR — one of several values matching is enough', () => {
  assert.equal(
    chatMatchesCriteria(chat({ project: 'warden' }), criteria({ custom: ['tinker', 'warden', 'other'] })),
    true,
  );
});
test('empty custom array → no constraint (matches)', () => {
  // Mirrors the backend guard: a length-0 custom array is ignored.
  assert.equal(chatMatchesCriteria(chat({ role: 'worker' }), criteria({ custom: [] })), true);
});
test('custom AND role — both the role and one custom value must hold', () => {
  const c = criteria({ role: 'worker', custom: ['warden'] });
  assert.equal(chatMatchesCriteria(chat({ role: 'worker', project: 'warden' }), c), true);
  // role matches but no field equals 'warden' → reject
  assert.equal(chatMatchesCriteria(chat({ role: 'worker', project: 'tinker' }), c), false);
  // a field equals 'warden' but role is wrong → reject
  assert.equal(chatMatchesCriteria(chat({ role: 'reviewer', project: 'warden' }), c), false);
});

// ---------------------------------------------------------------------------
console.log('\ncountAgentsInCollection — no-criteria guard + counting');
// ---------------------------------------------------------------------------
test('a collection with NO criteria object → 0 (guard preserved)', () => {
  const chats = [chat({ id: 'a', role: 'worker' }), chat({ id: 'b', role: 'reviewer' })];
  assert.equal(countAgentsInCollection({ id: 'x', name: 'X', criteria: undefined, metadata: {}, createdAt: 0, updatedAt: 0 }, chats), 0);
});
test('counts matching agents for a custom value (the WARDEN-553 success case)', () => {
  const chats = [
    chat({ id: 'a', project: 'warden' }),
    chat({ id: 'b', project: 'warden', name: 'lead' }),
    chat({ id: 'c', project: 'tinker' }),
    chat({ id: 'd', role: 'warden' }), // custom also matches role
  ];
  const collection = { id: 'x', name: 'X', criteria: { custom: ['warden'] }, metadata: {}, createdAt: 0, updatedAt: 0 };
  // a, b (project warden) + d (role warden) = 3; c is tinker → excluded
  assert.equal(countAgentsInCollection(collection, chats), 3);
});
test('empty criteria {} counts every agent (leave-all-empty = include all)', () => {
  const chats = [chat({ id: 'a' }), chat({ id: 'b' })];
  const collection = { id: 'x', name: 'X', criteria: {}, metadata: {}, createdAt: 0, updatedAt: 0 };
  assert.equal(countAgentsInCollection(collection, chats), 2);
});
test('AND across role + custom narrows the count', () => {
  const chats = [
    chat({ id: 'a', role: 'worker', project: 'warden' }),
    chat({ id: 'b', role: 'worker', project: 'tinker' }),
    chat({ id: 'c', role: 'reviewer', project: 'warden' }),
  ];
  const collection = { id: 'x', name: 'X', criteria: { role: 'worker', custom: ['warden'] }, metadata: {}, createdAt: 0, updatedAt: 0 };
  // only a satisfies both role=worker AND a field === 'warden'
  assert.equal(countAgentsInCollection(collection, chats), 1);
});

console.log(`\n✓ COLLECTIONS TESTS PASS (${passed})`);
