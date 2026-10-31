// WARDEN-2045 — pins sanitizeCompanionExcludedHosts' refusal/normalisation rules
// (dedup by trimmed value, per-entry length cap, entry-count cap, control
// character refusal). It is the single validator behind companionExcludedHosts
// (PUT /api/config and applyCompanionExclusions), where a dropped exclusion is
// invisible breakage, so each clause is pinned here directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeCompanionExcludedHosts,
  COMPANION_EXCLUDED_HOST_MAX,
  COMPANION_EXCLUDED_HOST_MAX_COUNT,
} from './config-schema.js';

test('trims and de-duplicates by trimmed value, keeping first-seen order', () => {
  assert.deepEqual(
    sanitizeCompanionExcludedHosts(['a', ' b ', 'a', 'b', ' a  ', 'c']),
    ['a', 'b', 'c'],
  );
});

test('accepts an entry of exactly the max length, refuses one more, measured after trimming', () => {
  const ok = 'h'.repeat(COMPANION_EXCLUDED_HOST_MAX);
  assert.deepEqual(sanitizeCompanionExcludedHosts([ok]), [ok]);
  assert.equal(sanitizeCompanionExcludedHosts([ok + 'h']), null);
  // Padding must not count toward the cap: trimmed length is exactly the max.
  assert.deepEqual(sanitizeCompanionExcludedHosts([`  ${ok}  `]), [ok]);
  // Trimmed length is max+1, so refused even though padding is stripped.
  assert.equal(sanitizeCompanionExcludedHosts([`  ${ok}h  `]), null);
});

test('accepts exactly the max count of distinct entries, refuses one more', () => {
  const hosts = Array.from({ length: COMPANION_EXCLUDED_HOST_MAX_COUNT }, (_, i) => `h${i}`);
  assert.deepEqual(sanitizeCompanionExcludedHosts(hosts), hosts);
  assert.equal(sanitizeCompanionExcludedHosts([...hosts, 'extra']), null);
});

test('duplicates do not count toward the count cap', () => {
  const hosts = Array.from({ length: COMPANION_EXCLUDED_HOST_MAX_COUNT }, (_, i) => `h${i}`);
  const withRepeats = [...hosts, 'h0', ' h1 ', 'h2', ...hosts];
  assert.deepEqual(sanitizeCompanionExcludedHosts(withRepeats), hosts);
});

test('refuses every control character anywhere in an entry, accepts space and non-ASCII', () => {
  for (const ch of ['\r', '\t', '\x00', '\x1f', '\x7f', '\n', '\x01']) {
    assert.equal(sanitizeCompanionExcludedHosts([`a${ch}b`]), null, JSON.stringify(ch));
    assert.equal(sanitizeCompanionExcludedHosts([`${ch}a${ch}b`]), null, JSON.stringify(ch));
  }
  assert.deepEqual(sanitizeCompanionExcludedHosts(['my host']), ['my host']);
  assert.deepEqual(sanitizeCompanionExcludedHosts(['ünï.example']), ['ünï.example']);
  assert.deepEqual(sanitizeCompanionExcludedHosts(['a\x80b']), ['a\x80b']);
});

test('one bad entry refuses the whole list (no partial clean-up)', () => {
  assert.equal(sanitizeCompanionExcludedHosts(['good', 'a,b']), null);
  assert.equal(sanitizeCompanionExcludedHosts(['good', 42]), null);
  assert.equal(sanitizeCompanionExcludedHosts(['good', '   ']), null);
  assert.equal(sanitizeCompanionExcludedHosts(['good', 'bad\x00']), null);
});

test('non-array input is refused, an empty array is a valid empty list', () => {
  for (const v of [undefined, null, 'a', 42, {}, { length: 0 }]) {
    assert.equal(sanitizeCompanionExcludedHosts(v), null);
  }
  assert.deepEqual(sanitizeCompanionExcludedHosts([]), []);
});
