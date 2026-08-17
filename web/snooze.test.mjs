// Tests for snooze.ts — the pure suppression/expiry math behind the time-boxed
// attention-alert snooze (WARDEN-551).
//
// No front-end test runner in this repo, so (like attentionRollup.test.mjs) this
// loads the REAL src/lib/snooze.ts (transpiled TS -> ESM via Vite's OXC transform)
// and exercises it with plain values. The file has zero runtime imports (only
// `import type`, erased at transpile time), so the emitted module loads standalone.
//
// Under test: activeSnoozedKeys (active vs expired, boundary at now === expiresAt),
// alertMuteState (the per-row muted/snoozedUntil derivation the attention sections
// feed to their rows), pruneExpired (drops only expired, keeps active, stable ref
// when nothing pruned, handles empty), plus the supporting snoozeExpiry (1h /
// until-tomorrow-midnight) and formatSnoozeRemaining.
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
  alertMuteState,
  pruneExpired,
  withoutSnoozeKey,
  snoozeExpiry,
  formatSnoozeRemaining,
  snoozeManyKeys,
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
// alertMuteState — the per-row derivation each AttentionList section feeds to its
// row (WARDEN-1043). It was seven byte-identical inline JSX expressions; the two
// fields stay SEPARATE (never collapsed to one "suppressed" boolean) because the
// row renders BellOff for a permanent mute but a Clock + countdown for a snooze.
// `snoozedSet` is built with activeSnoozedKeys here exactly as the call site does
// (once per render), so these cases exercise the real composition.
// ---------------------------------------------------------------------------
const muteStateAt = (key, muteEnabled, muted, snoozed, now = NOW) =>
  alertMuteState(key, muteEnabled, new Set(muted), activeSnoozedKeys(snoozed, now), snoozed);

test('alertMuteState: neither muted nor snoozed -> no suppression', () => {
  assert.deepEqual(muteStateAt('a', true, [], {}), { muted: false, snoozedUntil: null });
});

test('alertMuteState: a permanently-muted key reports muted, NOT snoozed (BellOff, no countdown)', () => {
  assert.deepEqual(muteStateAt('a', true, ['a'], {}), { muted: true, snoozedUntil: null });
});

test('alertMuteState: an actively-snoozed key reports its expiry, NOT muted (Clock + countdown)', () => {
  assert.deepEqual(muteStateAt('a', true, [], { a: NOW + 60_000 }), {
    muted: false,
    snoozedUntil: NOW + 60_000,
  });
});

test('alertMuteState: an EXPIRED snooze yields snoozedUntil null, not the stale timestamp', () => {
  // The trap this function exists to close: the entry is STILL PRESENT in the
  // snooze map (App's prune effect only runs on cadence), so the obvious
  // `snoozedAlertKeys[key] ?? null` would hand the row an expired timestamp and
  // render a dead snooze as active. The activeSnoozedKeys gate is what prevents
  // it — stub the snooze branch to a bare index and THIS case is what fails.
  assert.deepEqual(muteStateAt('a', true, [], { a: NOW - 1 }), { muted: false, snoozedUntil: null });
  // ...including at the exact expiry instant (the closed-open boundary).
  assert.deepEqual(muteStateAt('a', true, [], { a: NOW }), { muted: false, snoozedUntil: null });
});

test('alertMuteState: muteEnabled false zeroes BOTH fields (master desktop-alert gate off)', () => {
  // With the channel off the whole routing layer is moot: no bell, no
  // strike-through — the row renders exactly as it did before WARDEN-364, even
  // for a key that is both muted and actively snoozed.
  assert.deepEqual(muteStateAt('a', false, ['a'], { a: NOW + 60_000 }), {
    muted: false,
    snoozedUntil: null,
  });
});

test('alertMuteState: mute and snooze are reported independently, never collapsed', () => {
  // The two channels are mutually exclusive in practice (App's setter clears one
  // when setting the other), but the pure derivation reports each on its own so
  // the row can always tell which visual to render.
  assert.deepEqual(muteStateAt('a', true, ['a'], { a: NOW + 60_000 }), {
    muted: true,
    snoozedUntil: NOW + 60_000,
  });
});

test('alertMuteState: does not bleed across keys', () => {
  assert.deepEqual(muteStateAt('b', true, ['a'], { a: NOW + 60_000 }), {
    muted: false,
    snoozedUntil: null,
  });
});

test('alertMuteState: a key in the active set but absent from the map coalesces to null, never undefined', () => {
  // Defensive: the two arguments cannot disagree at the real call site, but the
  // row's prop type is `number | null` — `undefined` must never leak through.
  const state = alertMuteState('a', true, new Set(), new Set(['a']), {});
  assert.deepEqual(state, { muted: false, snoozedUntil: null });
  assert.equal(state.snoozedUntil, null);
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
  assert.ok(activeSnoozedKeys({ a: expiry }, NOW).has('a'));
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

// ---------------------------------------------------------------------------
// snoozeManyKeys — the WARDEN-581 bulk setter (multi-select Snooze).
// Writes EXACTLY the selected-key set in one update; idempotent for keys that
// are already snoozed; leaves un-selected keys (incl. their existing snoozes)
// untouched. The "one snooze-duration vocabulary" guarantee is also pinned: the
// bulk expiry for a duration equals snoozeExpiry for that duration.
// ---------------------------------------------------------------------------
test('snoozeManyKeys: writes every selected key at the duration expiry (exact selected set)', () => {
  const out = snoozeManyKeys({}, ['a', 'b', 'c'], '1h', NOW);
  // Each selected key is present; no extras; every expiry is exactly 1h from NOW.
  assert.deepEqual(out, { a: NOW + 60 * 60 * 1000, b: NOW + 60 * 60 * 1000, c: NOW + 60 * 60 * 1000 });
});

test('snoozeManyKeys: every selected key is immediately suppressed after the bulk write', () => {
  const out = snoozeManyKeys({}, ['a', 'b'], 'tomorrow', NOW);
  const active = activeSnoozedKeys(out, NOW);
  assert.ok(active.has('a'));
  assert.ok(active.has('b'));
});

test('snoozeManyKeys: preserves existing snoozes on UN-selected keys (group snooze is additive)', () => {
  // 'zzz' was already snoozed; snoozing a,b,c must not disturb it.
  const prev = { zzz: NOW + 999_999 };
  const out = snoozeManyKeys(prev, ['a', 'b', 'c'], '1h', NOW);
  assert.equal(out.zzz, NOW + 999_999);
  assert.deepEqual(out.a, NOW + 60 * 60 * 1000);
  assert.deepEqual(out.b, NOW + 60 * 60 * 1000);
  assert.deepEqual(out.c, NOW + 60 * 60 * 1000);
});

test('snoozeManyKeys: idempotent for already-snoozed keys — re-snoozing refreshes, never errors or duplicates', () => {
  const once = snoozeManyKeys({}, ['a', 'b'], '1h', NOW);
  // Re-snooze the same keys at the same instant: identical result (a Record key
  // is unique, so there is no "duplicate entry" failure mode to worry about).
  const twice = snoozeManyKeys(once, ['a', 'b'], '1h', NOW);
  assert.deepEqual(twice, once);
});

test('snoozeManyKeys: re-snoozing at a later instant overwrites the expiry with a fresh window', () => {
  const first = snoozeManyKeys({}, ['a'], '1h', NOW);
  const later = NOW + 10 * 60_000; // 10 minutes later
  const second = snoozeManyKeys(first, ['a'], '1h', later);
  assert.equal(second.a, later + 60 * 60 * 1000);
});

test('snoozeManyKeys: empty key list returns the SAME reference (no-op bulk snooze)', () => {
  const map = { a: NOW + 60_000 };
  assert.equal(snoozeManyKeys(map, [], '1h', NOW), map);
});

test('snoozeManyKeys: does not mutate the input map', () => {
  const prev = { zzz: NOW + 60_000 };
  const out = snoozeManyKeys(prev, ['a'], '1h', NOW);
  assert.notEqual(out, prev);
  assert.deepEqual(prev, { zzz: NOW + 60_000 }); // input untouched
  assert.deepEqual(out, { zzz: NOW + 60_000, a: NOW + 60 * 60 * 1000 });
});

test('snoozeManyKeys: a duplicate id in the key list is harmless (last write wins, one entry)', () => {
  const out = snoozeManyKeys({}, ['a', 'a', 'b'], '1h', NOW);
  assert.deepEqual(out, { a: NOW + 60 * 60 * 1000, b: NOW + 60 * 60 * 1000 });
});

console.log(`\n✓ SNOOZE TESTS PASS (${passed})`);
