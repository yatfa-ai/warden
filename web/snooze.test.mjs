// Tests for snooze.ts — the pure suppression/expiry math behind the time-boxed
// attention-alert snooze (WARDEN-551).
//
// No front-end test runner in this repo, so (like attentionRollup.test.mjs) this
// loads the REAL src/lib/snooze.ts (transpiled TS -> ESM via Vite's OXC transform)
// and exercises it with plain values. The file has zero runtime imports (only
// `import type`, erased at transpile time), so the emitted module loads standalone.
//
// Under test: activeSnoozedKeys (active vs expired, boundary at now === expiresAt),
// isSuppressed (permanent-mute OR active-snooze), pruneExpired (drops only
// expired, keeps active, stable ref when nothing pruned, handles empty), plus the
// supporting snoozeExpiry (1h / until-tomorrow-midnight) and formatSnoozeRemaining.
//
// Run: node snooze.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const helperPath = resolve(__dirname, 'src/lib/snooze.ts');

// --- Load the REAL snooze.ts (TS -> ESM via the OXC transform Vite bundles) ---
const src = readFileSync(helperPath, 'utf8');
const { code } = await transformWithOxc(src, helperPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-snooze-test-'));
const tmpFile = join(tmpDir, 'snooze.mjs');
writeFileSync(tmpFile, code);
const {
  activeSnoozedKeys,
  isSuppressed,
  pruneExpired,
  withoutSnoozeKey,
  snoozeExpiry,
  formatSnoozeRemaining,
} = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// A fixed clock so every case is deterministic. The base instant is arbitrary.
const NOW = 1_700_000_000_000; // 2023-11-14T22:13:20Z-ish; only arithmetic matters here.

// ---------------------------------------------------------------------------
// activeSnoozedKeys
// ---------------------------------------------------------------------------
test('activeSnoozedKeys: empty map -> empty set (today\'s default behavior)', () => {
  assert.deepEqual([...activeSnoozedKeys({}, NOW)], []);
});

test('activeSnoozedKeys: an entry whose expiry is in the future is active', () => {
  const set = activeSnoozedKeys({ a: NOW + 60_000 }, NOW);
  assert.deepEqual([...set], ['a']);
});

test('activeSnoozedKeys: an entry whose expiry is in the past is NOT active (auto-rearm)', () => {
  const set = activeSnoozedKeys({ a: NOW - 1, b: NOW + 60_000 }, NOW);
  assert.deepEqual([...set], ['b']);
});

test('activeSnoozedKeys: the boundary now === expiresAt is EXPIRED (closed-open window)', () => {
  // A 1h snooze set at 12:00 suppresses through 12:59:59.999 and re-arms at 13:00
  // exactly. So at the instant of expiry the key is already free to fire again.
  const set = activeSnoozedKeys({ a: NOW }, NOW);
  assert.deepEqual([...set], []);
});

test('activeSnoozedKeys: a non-number / non-finite expiry is dropped (defensive)', () => {
  const set = activeSnoozedKeys(
    { good: NOW + 60_000, nan: NaN, str: 'later', inf: Infinity, neg: -5 },
    NOW,
  );
  assert.deepEqual([...set], ['good']);
});

// ---------------------------------------------------------------------------
// isSuppressed
// ---------------------------------------------------------------------------
test('isSuppressed: false for an unmuted, unsnoozed key', () => {
  assert.equal(isSuppressed('a', new Set(), {}, NOW), false);
});

test('isSuppressed: true for a permanently-muted key (the WARDEN-364 path, unchanged)', () => {
  assert.equal(isSuppressed('a', new Set(['a']), {}, NOW), true);
});

test('isSuppressed: true for an actively-snoozed key (the new path, identical suppression)', () => {
  assert.equal(isSuppressed('a', new Set(), { a: NOW + 60_000 }, NOW), true);
});

test('isSuppressed: false for a key whose snooze just expired (auto-rearm)', () => {
  assert.equal(isSuppressed('a', new Set(), { a: NOW }, NOW), false);
  assert.equal(isSuppressed('a', new Set(), { a: NOW - 1 }, NOW), false);
});

test('isSuppressed: permanent mute OR snooze — a muted key stays suppressed even if also snoozed', () => {
  // The two never overlap in practice (App's setter keeps them exclusive), but
  // the pure rule is a union: either condition suppresses.
  assert.equal(isSuppressed('a', new Set(['a']), { a: NOW + 60_000 }, NOW), true);
});

test('isSuppressed: does not bleed across keys', () => {
  assert.equal(isSuppressed('b', new Set(['a']), { a: NOW + 60_000 }, NOW), false);
});

// ---------------------------------------------------------------------------
// pruneExpired
// ---------------------------------------------------------------------------
test('pruneExpired: empty map -> empty map', () => {
  assert.deepEqual(pruneExpired({}, NOW), {});
});

test('pruneExpired: keeps active entries, drops expired ones', () => {
  const out = pruneExpired({ a: NOW + 60_000, b: NOW - 1, c: NOW + 120_000 }, NOW);
  assert.deepEqual(out, { a: NOW + 60_000, c: NOW + 120_000 });
});

test('pruneExpired: the boundary now === expiresAt is pruned (expired)', () => {
  const out = pruneExpired({ a: NOW }, NOW);
  assert.deepEqual(out, {});
});

test('pruneExpired: drops non-number / non-finite / non-positive entries too', () => {
  const out = pruneExpired(
    { good: NOW + 60_000, nan: NaN, str: 'x', inf: Infinity, zero: 0, neg: -10 },
    NOW,
  );
  assert.deepEqual(out, { good: NOW + 60_000 });
});

test('pruneExpired: returns the SAME reference when nothing was pruned (no spurious re-render)', () => {
  const map = { a: NOW + 60_000, b: NOW + 120_000 };
  assert.equal(pruneExpired(map, NOW), map);
});

test('pruneExpired: returns a NEW reference when at least one entry was pruned', () => {
  const map = { a: NOW + 60_000, b: NOW - 1 };
  const out = pruneExpired(map, NOW);
  assert.notEqual(out, map);
  assert.deepEqual(out, { a: NOW + 60_000 });
});

// ---------------------------------------------------------------------------
// withoutSnoozeKey (App's setAlertMute clears one channel when setting the other)
// ---------------------------------------------------------------------------
test('withoutSnoozeKey: removes the key when present', () => {
  assert.deepEqual(withoutSnoozeKey({ a: NOW + 60_000, b: NOW + 120_000 }, 'a'), { b: NOW + 120_000 });
});

test('withoutSnoozeKey: returns the SAME reference when the key is absent (no-op setState)', () => {
  const map = { a: NOW + 60_000 };
  assert.equal(withoutSnoozeKey(map, 'zzz'), map);
});

test('withoutSnoozeKey: on an empty map returns the same empty reference', () => {
  const map = {};
  assert.equal(withoutSnoozeKey(map, 'a'), map);
});

// ---------------------------------------------------------------------------
// snoozeExpiry
// ---------------------------------------------------------------------------
test('snoozeExpiry: "1h" is exactly now + one hour', () => {
  assert.equal(snoozeExpiry('1h', NOW), NOW + 60 * 60 * 1000);
});

test('snoozeExpiry: "1h" is in the future and active immediately after being set', () => {
  const expiry = snoozeExpiry('1h', NOW);
  assert.ok(expiry > NOW);
  assert.equal(isSuppressed('a', new Set(), { a: expiry }, NOW), true);
});

test('snoozeExpiry: "tomorrow" is the next local midnight strictly after now', () => {
  const expiry = snoozeExpiry('tomorrow', NOW);
  // Construct the same "next local midnight" the helper builds, then assert
  // equality — this pins the exact semantics (roll setHours(24,0,0,0)) so a
  // future refactor that changes the clock math is caught.
  const expected = new Date(NOW);
  expected.setHours(24, 0, 0, 0);
  assert.equal(expiry, expected.getTime());
  assert.ok(expiry > NOW, 'tomorrow is strictly later than now');
});

test('snoozeExpiry: "tomorrow" lands at 00:00:00.000 local', () => {
  const expiry = snoozeExpiry('tomorrow', NOW);
  const d = new Date(expiry);
  assert.equal(d.getHours(), 0);
  assert.equal(d.getMinutes(), 0);
  assert.equal(d.getSeconds(), 0);
  assert.equal(d.getMilliseconds(), 0);
});

// ---------------------------------------------------------------------------
// formatSnoozeRemaining
// ---------------------------------------------------------------------------
test('formatSnoozeRemaining: empty once expired (<= 0 ms left)', () => {
  assert.equal(formatSnoozeRemaining(NOW, NOW), '');
  assert.equal(formatSnoozeRemaining(NOW - 1, NOW), '');
});

test('formatSnoozeRemaining: "<1m" inside the final minute', () => {
  assert.equal(formatSnoozeRemaining(NOW + 30_000, NOW), '<1m');
  assert.equal(formatSnoozeRemaining(NOW + 59_999, NOW), '<1m');
});

test('formatSnoozeRemaining: whole minutes under an hour', () => {
  assert.equal(formatSnoozeRemaining(NOW + 60_000, NOW), '1m');
  assert.equal(formatSnoozeRemaining(NOW + 42 * 60_000, NOW), '42m');
});

test('formatSnoozeRemaining: hours + minutes beyond an hour', () => {
  assert.equal(formatSnoozeRemaining(NOW + (60 + 5) * 60_000, NOW), '1h 5m');
  assert.equal(formatSnoozeRemaining(NOW + (2 * 60 + 30) * 60_000, NOW), '2h 30m');
});

test('formatSnoozeRemaining: a whole-hour remaining drops the minutes term', () => {
  assert.equal(formatSnoozeRemaining(NOW + 60 * 60_000, NOW), '1h');
  assert.equal(formatSnoozeRemaining(NOW + 3 * 60 * 60_000, NOW), '3h');
});

console.log(`\n✓ SNOOZE TESTS PASS (${passed})`);
