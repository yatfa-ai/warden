// Tests for stateDuration.ts — the pure "how long in current state" logic behind the
// Attention badge's live duration suffix (WARDEN-587).
//
// No front-end test runner in this repo, so (like snooze.test.mjs / whatsNew.test.mjs)
// this loads the REAL src/lib/stateDuration.ts (transpiled TS -> ESM via Vite's OXC
// transform) and exercises it with plain values. The file has zero runtime imports, so
// the emitted module loads standalone.
//
// Under test:
//  - formatStateDuration: compact relative label ('' sub-minute / missing / future,
//    'Nm' / 'Hh Mm' / 'Hh' / 'Nd Hh' / 'Nd') — the sibling of formatSnoozeRemaining,
//    extended to days, with the sub-minute window suppressed (never "0s").
//  - formatStateDurationVerbose: the screen-reader/tooltip form, same thresholds +
//    exact singular/plural.
//  - languishingTone: fresh (<15m) / amber (15m–1h) / red (>1h) — the supplementary
//    color, never the sole signal (WCAG 1.4.1).
//  - computeEnteredAt: the pure stamp/reset/keep rule behind useAttentionRollup's loop
//    (stamped on transition, reset on state change, baseline on first observation,
//    persisted stamp kept across restart).
//  - loadStateEnteredAt / saveStateEnteredAt: the persisted {key→ms} map round-trip +
//    defensive handling (corrupt payload, non-finite values, unavailable storage).
//
// Run: node stateDuration.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const helperPath = resolve(__dirname, 'src/lib/stateDuration.ts');

// --- Load the REAL stateDuration.ts (TS -> ESM via the OXC transform Vite bundles) ---
const src = readFileSync(helperPath, 'utf8');
const { code } = await transformWithOxc(src, helperPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-state-duration-test-'));
const tmpFile = join(tmpDir, 'stateDuration.mjs');
writeFileSync(tmpFile, code);
const {
  formatStateDuration,
  formatStateDurationVerbose,
  languishingTone,
  computeEnteredAt,
  sortOldestEnteredAtFirst,
  loadStateEnteredAt,
  saveStateEnteredAt,
  LANGUISHING_AMBER_MS,
  LANGUISHING_RED_MS,
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
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------
// formatStateDuration (compact)
// ---------------------------------------------------------------------------
console.log('\nformatStateDuration: sub-minute / missing / future → no suffix (never "0s")');
test('a missing enteredAt → "" (an unstamped row renders no suffix)', () => {
  assert.equal(formatStateDuration(undefined, NOW), '');
  assert.equal(formatStateDuration(null, NOW), '');
});
test('a non-finite enteredAt → "" (defensive: a corrupt stamp never renders)', () => {
  assert.equal(formatStateDuration(NaN, NOW), '');
  assert.equal(formatStateDuration(Infinity, NOW), '');
  assert.equal(formatStateDuration('later', NOW), '');
});
test('the first observation (~0s) → "" (the "first poll, never 0s" edge case)', () => {
  assert.equal(formatStateDuration(NOW, NOW), '');
  assert.equal(formatStateDuration(NOW - 1, NOW), '');
});
test('sub-minute (1–59s) → "" (suppressed to avoid false precision)', () => {
  assert.equal(formatStateDuration(NOW - 30_000, NOW), '');
  assert.equal(formatStateDuration(NOW - 59_999, NOW), '');
});
test('a future enteredAt (clock skew) → "" (never a negative/nonsense duration)', () => {
  assert.equal(formatStateDuration(NOW + 5_000, NOW), '');
});

console.log('\nformatStateDuration: minute granularity under an hour');
test('exactly 1m → "1m" (the first label to appear)', () => {
  assert.equal(formatStateDuration(NOW - MIN, NOW), '1m');
});
test('whole minutes under an hour', () => {
  assert.equal(formatStateDuration(NOW - 2 * MIN, NOW), '2m');
  assert.equal(formatStateDuration(NOW - 47 * MIN, NOW), '47m');
  assert.equal(formatStateDuration(NOW - 59 * MIN, NOW), '59m');
});

console.log('\nformatStateDuration: hours + minutes (sibling of formatSnoozeRemaining)');
test('a whole-hour duration drops the minutes term', () => {
  assert.equal(formatStateDuration(NOW - HOUR, NOW), '1h');
  assert.equal(formatStateDuration(NOW - 3 * HOUR, NOW), '3h');
});
test('hours + minutes beyond an hour', () => {
  assert.equal(formatStateDuration(NOW - (2 * HOUR + 14 * MIN), NOW), '2h 14m');
  assert.equal(formatStateDuration(NOW - (2 * HOUR + 30 * MIN), NOW), '2h 30m');
});

console.log('\nformatStateDuration: days (an agent can languish for days — extends snooze)');
test('exactly 24h → "1d" (whole day drops the hours term)', () => {
  assert.equal(formatStateDuration(NOW - DAY, NOW), '1d');
});
test('days + hours past a day', () => {
  assert.equal(formatStateDuration(NOW - (DAY + HOUR), NOW), '1d 1h');
  assert.equal(formatStateDuration(NOW - (3 * DAY + 5 * HOUR), NOW), '3d 5h');
});
test('a whole number of days drops the hours term', () => {
  assert.equal(formatStateDuration(NOW - 3 * DAY, NOW), '3d');
});

// ---------------------------------------------------------------------------
// formatStateDurationVerbose (aria / tooltip)
// ---------------------------------------------------------------------------
console.log('\nformatStateDurationVerbose: mirrors compact thresholds + exact plural');
test('sub-minute / missing → "" (no empty tooltip)', () => {
  assert.equal(formatStateDurationVerbose(undefined, NOW), '');
  assert.equal(formatStateDurationVerbose(NOW, NOW), '');
  assert.equal(formatStateDurationVerbose(NOW - 30_000, NOW), '');
});
test('singular vs plural minutes', () => {
  assert.equal(formatStateDurationVerbose(NOW - MIN, NOW), '1 minute');
  assert.equal(formatStateDurationVerbose(NOW - 47 * MIN, NOW), '47 minutes');
});
test('singular vs plural hours, whole + with minutes', () => {
  assert.equal(formatStateDurationVerbose(NOW - HOUR, NOW), '1 hour');
  assert.equal(formatStateDurationVerbose(NOW - 3 * HOUR, NOW), '3 hours');
  assert.equal(formatStateDurationVerbose(NOW - (2 * HOUR + 14 * MIN), NOW), '2 hours 14 minutes');
  assert.equal(formatStateDurationVerbose(NOW - (2 * HOUR + MIN), NOW), '2 hours 1 minute');
});
test('singular vs plural days, whole + with hours', () => {
  assert.equal(formatStateDurationVerbose(NOW - DAY, NOW), '1 day');
  assert.equal(formatStateDurationVerbose(NOW - 3 * DAY, NOW), '3 days');
  assert.equal(formatStateDurationVerbose(NOW - (DAY + HOUR), NOW), '1 day 1 hour');
  assert.equal(formatStateDurationVerbose(NOW - (3 * DAY + 5 * HOUR), NOW), '3 days 5 hours');
});

// ---------------------------------------------------------------------------
// languishingTone
// ---------------------------------------------------------------------------
console.log('\nlanguishingTone: muted → amber → red (supplementary, never the sole signal)');
test('a missing/non-finite enteredAt → "fresh" (an unstamped row never reads languishing)', () => {
  assert.equal(languishingTone(undefined, NOW), 'fresh');
  assert.equal(languishingTone(null, NOW), 'fresh');
  assert.equal(languishingTone(NaN, NOW), 'fresh');
});
test('under 15m → "fresh"', () => {
  assert.equal(languishingTone(NOW - MIN, NOW), 'fresh');
  assert.equal(languishingTone(NOW - (LANGUISHING_AMBER_MS - 1), NOW), 'fresh');
});
test('the 15m boundary → "amber" (>= amber, the closed threshold)', () => {
  assert.equal(languishingTone(NOW - LANGUISHING_AMBER_MS, NOW), 'amber');
  assert.equal(languishingTone(NOW - 47 * MIN, NOW), 'amber');
});
test('the 1h boundary → "red" (>= red)', () => {
  assert.equal(languishingTone(NOW - LANGUISHING_RED_MS, NOW), 'red');
  assert.equal(languishingTone(NOW - (3 * HOUR + 14 * MIN), NOW), 'red');
  assert.equal(languishingTone(NOW - 3 * DAY, NOW), 'red');
});

// ---------------------------------------------------------------------------
// computeEnteredAt — the pure stamp/reset/keep rule
// ---------------------------------------------------------------------------
console.log('\ncomputeEnteredAt: stamp on transition, reset on change, baseline on first obs');
test('first observation with NO existing stamp → stamps now (baseline)', () => {
  assert.equal(computeEnteredAt(null, 'stuck', false, NOW), NOW);
});
test('first observation WITH an existing (persisted) stamp → KEEP (restart does not reset)', () => {
  // success criterion #2: a stamp that survived restart stays; we never re-baseline it.
  assert.equal(computeEnteredAt(null, 'stuck', true, NOW), null);
});
test('a genuine transition (prev !== cur) → RESET to now (the new state starts fresh)', () => {
  assert.equal(computeEnteredAt('active', 'stuck', true, NOW), NOW);
  assert.equal(computeEnteredAt('stuck', 'erroring', false, NOW), NOW);
  assert.equal(computeEnteredAt('active', 'idle', true, NOW), NOW, 'the active→idle finish is a transition too');
});
test('unchanged state (prev === cur) → KEEP (the duration keeps growing)', () => {
  assert.equal(computeEnteredAt('stuck', 'stuck', true, NOW), null);
  assert.equal(computeEnteredAt('stuck', 'stuck', false, NOW), null);
});
test('the reset is what makes the duration restart on a state change', () => {
  // Simulate three polls of one key: first obs (baseline) → stable (keep) → transition (reset).
  const t0 = NOW;
  const t1 = NOW + 30_000;
  const t2 = NOW + 60_000;
  assert.equal(computeEnteredAt(null, 'stuck', false, t0), t0, 'poll 1: baseline');
  assert.equal(computeEnteredAt('stuck', 'stuck', true, t1), null, 'poll 2: unchanged → keep t0');
  assert.equal(computeEnteredAt('stuck', 'erroring', true, t2), t2, 'poll 3: transition → reset to t2');
});

// ---------------------------------------------------------------------------
// sortOldestEnteredAtFirst — within-section ordering (WARDEN-587 criterion #3)
// ---------------------------------------------------------------------------
console.log('\nsortOldestEnteredAtFirst: longest-duration (oldest enteredAt) first within a section');
const row = (id, enteredAt) => ({ id, ...(enteredAt === undefined ? {} : { enteredAt }) });

test('the oldest enteredAt (longest-held state) floats to the top', () => {
  const sorted = sortOldestEnteredAtFirst([
    row('fresh', NOW - MIN),       // 1m
    row('ancient', NOW - 3 * HOUR), // 3h — languishing
    row('mid', NOW - 20 * MIN),    // 20m
  ]);
  assert.deepEqual(sorted.map((r) => r.id), ['ancient', 'mid', 'fresh']);
});
test('a row with NO enteredAt sorts LAST (never leapfrogs a languishing row)', () => {
  const sorted = sortOldestEnteredAtFirst([
    row('unstamped'),              // undefined → Infinity → last
    row('stale', NOW - HOUR),
  ]);
  assert.deepEqual(sorted.map((r) => r.id), ['stale', 'unstamped']);
});
test('two unstamped rows keep input order (NaN-safe: Infinity === Infinity → 0, stable)', () => {
  // The regression guard: the old `(a ?? Infinity) - (b ?? Infinity)` returned NaN here,
  // giving Array#sort undefined ordering. The fixed comparator returns 0 on a tie.
  const sorted = sortOldestEnteredAtFirst([row('a'), row('b'), row('c')]);
  assert.deepEqual(sorted.map((r) => r.id), ['a', 'b', 'c']);
});
test('rows with the SAME enteredAt keep input order (stable on equal)', () => {
  const t = NOW - HOUR;
  const sorted = sortOldestEnteredAtFirst([row('a', t), row('b', t), row('c', t)]);
  assert.deepEqual(sorted.map((r) => r.id), ['a', 'b', 'c']);
});
test('a mix of stamped + unstamped: stamped ordered by age, unstamped after, ties stable', () => {
  const sorted = sortOldestEnteredAtFirst([
    row('u1'), row('old', NOW - 2 * HOUR), row('u2'), row('new', NOW - 5 * MIN), row('u3'),
  ]);
  assert.deepEqual(sorted.map((r) => r.id), ['old', 'new', 'u1', 'u2', 'u3']);
});
test('does not mutate the input array (returns a new sorted copy)', () => {
  const input = [row('a', NOW - MIN), row('b', NOW - HOUR)];
  const snapshot = input.map((r) => r.id);
  sortOldestEnteredAtFirst(input);
  assert.deepEqual(input.map((r) => r.id), snapshot, 'input order unchanged');
});
test('empty + single-row arrays are returned as-is', () => {
  assert.deepEqual(sortOldestEnteredAtFirst([]), []);
  assert.deepEqual(sortOldestEnteredAtFirst([row('solo', NOW - HOUR)]).map((r) => r.id), ['solo']);
});

// ---------------------------------------------------------------------------
// loadStateEnteredAt / saveStateEnteredAt — persistence (mirrors whatsNew)
// ---------------------------------------------------------------------------
console.log('\nload/saveStateEnteredAt: round-trip + defensive handling');
// A tiny localStorage mock so the I/O helpers can be exercised in Node.
const makeStorage = () => {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
  };
};

test('save then load round-trips the {key → ms} map', () => {
  globalThis.localStorage = makeStorage();
  saveStateEnteredAt({ a: NOW - HOUR, b: NOW - 3 * HOUR });
  assert.deepEqual(loadStateEnteredAt(), { a: NOW - HOUR, b: NOW - 3 * HOUR });
});

test('load with no key present → {} (never throws, never null)', () => {
  globalThis.localStorage = makeStorage();
  assert.deepEqual(loadStateEnteredAt(), {});
});

test('load a corrupt / non-object payload → {} (a bad value is ignored, not fatal)', () => {
  globalThis.localStorage = makeStorage();
  const origWarn = console.warn;
  console.warn = () => {}; // load WARNs each parse failure — silence it in the test log
  try {
    globalThis.localStorage.setItem('warden:stateEnteredAt', 'not json{');
    assert.deepEqual(loadStateEnteredAt(), {});
    globalThis.localStorage.setItem('warden:stateEnteredAt', '"a string"');
    assert.deepEqual(loadStateEnteredAt(), {});
    globalThis.localStorage.setItem('warden:stateEnteredAt', '42');
    assert.deepEqual(loadStateEnteredAt(), {});
  } finally {
    console.warn = origWarn;
  }
});

test('load sanitizes entries: only finite, positive epoch-ms survive', () => {
  globalThis.localStorage = makeStorage();
  // A hand-corrupted entry (negative / NaN / string) must not produce a nonsense duration.
  globalThis.localStorage.setItem(
    'warden:stateEnteredAt',
    JSON.stringify({ good: NOW, zero: 0, neg: -5, nan: NaN, str: 'x' }),
  );
  assert.deepEqual(loadStateEnteredAt(), { good: NOW });
});

test('saveStateEnteredAt never throws on a quota failure (console.warn, not fatal)', () => {
  const throwing = makeStorage();
  throwing.setItem = () => { throw new Error('QuotaExceeded'); };
  globalThis.localStorage = throwing;
  const origWarn = console.warn;
  console.warn = () => {}; // the helper WARNs the failure — silence it in the test log
  try {
    assert.doesNotThrow(() => saveStateEnteredAt({ a: NOW }));
  } finally {
    console.warn = origWarn;
  }
});

test('when localStorage is unavailable, load → {} and save is a quiet no-op', () => {
  delete globalThis.localStorage;
  assert.deepEqual(loadStateEnteredAt(), {});
  const origWarn = console.warn;
  console.warn = () => {}; // save warns "localStorage is not defined" — silence it
  try {
    assert.doesNotThrow(() => saveStateEnteredAt({ a: NOW }));
  } finally {
    console.warn = origWarn;
  }
});

// Restore: leave the env clean for any test runner that runs after this file.
delete globalThis.localStorage;

console.log(`\n✓ STATE DURATION TESTS PASS (${passed})`);
