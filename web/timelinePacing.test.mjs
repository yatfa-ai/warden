// Pure tests for the live Activity Timeline's cadence + visibility decisions.
//
// Like diff.test.mjs, there is no FE test runner in this repo, so this loads
// the REAL src/lib/timelinePacing.ts (transpiled TS -> ESM via Vite's OXC
// transform) and exercises the pure helpers that drive useLiveTimeline's
// polling gate, its "refresh-on-focus" behavior, and the "Updated Ns ago"
// affordance. The hook delegates to these — so this guards the live/pause/
// hidden behavior without a browser.
//
// Run: node timelinePacing.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pacingPath = resolve(__dirname, 'src/lib/timelinePacing.ts');

// --- Load the REAL timelinePacing.ts (TS -> ESM via the OXC transform) -------
const src = readFileSync(pacingPath, 'utf8');
const { code } = await transformWithOxc(src, pacingPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-timeline-test-'));
const tmpFile = join(tmpDir, 'timelinePacing.mjs');
writeFileSync(tmpFile, code);
const { shouldPoll, shouldRefreshOnVisibility, formatUpdatedAgo, POLL_INTERVAL_MS, sortedFilterOptions } =
  await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

console.log('\nshouldPoll: polling runs only while Live AND visible');
test('Live + visible -> poll', () => {
  assert.equal(shouldPoll(true, true), true);
});
test('Live + hidden -> NO poll (paused while tab hidden)', () => {
  assert.equal(shouldPoll(true, false), false);
});
test('Paused + visible -> NO poll (user froze the feed)', () => {
  assert.equal(shouldPoll(false, true), false);
});
test('Paused + hidden -> NO poll', () => {
  assert.equal(shouldPoll(false, false), false);
});

console.log('\nshouldRefreshOnVisibility: immediate refresh only on hidden->visible while Live');
test('hidden -> visible while Live refreshes immediately', () => {
  assert.equal(shouldRefreshOnVisibility(true, false, true), true);
});
test('visible -> hidden does NOT refresh', () => {
  assert.equal(shouldRefreshOnVisibility(false, true, true), false);
});
test('hidden -> visible while Paused does NOT refresh', () => {
  assert.equal(shouldRefreshOnVisibility(true, false, false), false);
});
test('already visible (no transition) does NOT refresh', () => {
  assert.equal(shouldRefreshOnVisibility(false, false, true), false);
});

console.log('\nformatUpdatedAgo: relative labels from explicit `now` (no clock)');
test('null lastUpdated -> null', () => {
  assert.equal(formatUpdatedAgo(1_000_000, null), null);
});
test('0s diff -> "just now"', () => {
  const now = 1_000_000;
  assert.equal(formatUpdatedAgo(now, now), 'just now');
});
test('under 60s -> "Ns ago"', () => {
  assert.equal(formatUpdatedAgo(1_000_000, 1_000_000 - 30_000), '30s ago');
});
test('under 60m -> "Nm ago"', () => {
  assert.equal(formatUpdatedAgo(1_000_000, 1_000_000 - 125_000), '2m ago');
});
test('hours -> "Nh ago"', () => {
  assert.equal(formatUpdatedAgo(1_000_000, 1_000_000 - 3 * 3600_000), '3h ago');
});
test('negative diff (clock skew) clamps to "just now", not negative/NaN', () => {
  assert.equal(formatUpdatedAgo(1_000_000, 1_000_000 + 5_000), 'just now');
});

console.log('\nthe cadence is the ~15s live interval (not seconds, not minutes)');
test('POLL_INTERVAL_MS is 15000 (15s)', () => {
  assert.equal(POLL_INTERVAL_MS, 15_000);
});

console.log('\nsortedFilterOptions: stable filter-menu order from a newest-first feed');
test('dedupes repeated values (one option per distinct value)', () => {
  assert.deepEqual(sortedFilterOptions(['alpha', 'zeta', 'alpha', 'zeta', 'alpha']), ['alpha', 'zeta']);
});
test('drops falsy values — undefined/null/empty are not selectable options', () => {
  assert.deepEqual(
    sortedFilterOptions(['zeta', undefined, 'alpha', null, '', 'zeta']),
    ['alpha', 'zeta'],
  );
});
test('sorts by localeCompare, NOT by feed insertion order', () => {
  // Input is newest-first (the order both feeds arrive in); output is alphabetical.
  assert.deepEqual(sortedFilterOptions(['zeta', 'alpha', 'Mid']), ['alpha', 'Mid', 'zeta']);
});
test('empty input -> []', () => {
  assert.deepEqual(sortedFilterOptions([]), []);
});
test('all-falsy input -> []', () => {
  assert.deepEqual(sortedFilterOptions([undefined, null, '']), []);
});
test('THE BUG: a newly-active host does not reorder the menu across a poll', () => {
  // Poll 1: alpha was most recently active, so the newest-first feed leads with it.
  const poll1 = sortedFilterOptions(['alpha', 'zeta']);
  // Poll 2: zeta emits an event and jumps to the head of the same feed.
  const poll2 = sortedFilterOptions(['zeta', 'alpha']);
  // The menu the user is reaching for must be identical across the two polls.
  assert.deepEqual(poll1, poll2);
  assert.deepEqual(poll2, ['alpha', 'zeta']);
});
test('the option SET is preserved — same values as a plain dedupe+falsy-drop', () => {
  const raw = ['zeta', undefined, 'alpha', 'zeta', '', 'mid', null];
  const today = Array.from(new Set(raw.filter(Boolean)));
  assert.deepEqual([...sortedFilterOptions(raw)].sort(), [...today].sort());
});
test('does not mutate the caller\'s array', () => {
  const input = ['zeta', 'alpha'];
  sortedFilterOptions(input);
  assert.deepEqual(input, ['zeta', 'alpha']);
});

console.log(`\n✓ TIMELINE PACING TESTS PASS (${passed})`);
