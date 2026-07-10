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
const { shouldPoll, shouldRefreshOnVisibility, formatUpdatedAgo, POLL_INTERVAL_MS } =
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

console.log(`\n✓ TIMELINE PACING TESTS PASS (${passed})`);
