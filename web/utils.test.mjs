// Focused tests for `timeAgo()` in src/lib/utils.ts (WARDEN-206 annotate view).
//
// There is no front-end test runner in this repo, so this file loads the REAL
// utils module (transpiled TS -> ESM via Vite's OXC transform) and exercises
// `timeAgo` against deterministic offsets from the real wall clock.
//
// WHY THESE TESTS EXIST — regression guard for the relative-date divisor bug.
// The original `timeAgo` derived its divisor from the *previous* step's
// threshold. That is the current unit's magnitude for second/minute/hour/day,
// but NOT for month/year (the day threshold 604800 is a *week*, not a month;
// the month threshold 2629800 is a month, not a year). So a 2020 commit rendered
// "78 years ago" instead of "7 years ago" — ~12x over-count on the year branch,
// and ~4.3x on the month branch. These tests pin the correct magnitude per unit
// and would have failed loudly on the buggy implementation.
//
// DETERMINISM — no mocking required. `timeAgo` reads `Date.now()` internally;
// we build each input ISO from a `Date.now()` read microseconds earlier, at an
// exact integer multiple of the unit's size. The sub-millisecond gap between the
// two reads is ~1e-7 of a unit — far inside any Math.round ±0.5 boundary — so the
// formatted output is stable across runs and across the test's own clock drift.
//
// Run: node utils.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const utilsPath = resolve(__dirname, 'src/lib/utils.ts');

// --- Load the REAL utils.ts (TS -> ESM via the OXC transform Vite bundles) ----
// Temp dir is created INSIDE web/ so the bare specifiers utils.ts imports
// (clsx, tailwind-merge) resolve against web/node_modules.
const src = readFileSync(utilsPath, 'utf8');
const { code } = await transformWithOxc(src, utilsPath, {});
const tmpDir = mkdtempSync(join(__dirname, '.tmp-utils-test-'));
const tmpFile = join(tmpDir, 'utils.mjs');
writeFileSync(tmpFile, code);
let timeAgo;
try {
  ({ timeAgo } = await import(tmpFile));
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

// Build an ISO timestamp a fixed number of seconds in the past, relative to now.
const ago = (seconds) => new Date(Date.now() - seconds * 1000).toISOString();

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

console.log('\ntimeAgo returns "" for missing / invalid input');
test('empty string -> ""', () => {
  assert.equal(timeAgo(''), '');
});
test('garbage (non-date) -> ""', () => {
  assert.equal(timeAgo('not-a-real-date'), '');
});
test('undefined -> "" (defensive)', () => {
  assert.equal(timeAgo(undefined), '');
});

console.log('\ntimeAgo formats each unit at its own magnitude (the divisor fix)');
test('10 seconds ago -> "10 seconds ago" (second branch)', () => {
  assert.equal(timeAgo(ago(10)), '10 seconds ago');
});
test('5 minutes ago -> "5 minutes ago" (minute branch)', () => {
  assert.equal(timeAgo(ago(5 * 60)), '5 minutes ago');
});
test('3 hours ago -> "3 hours ago" (hour branch)', () => {
  assert.equal(timeAgo(ago(3 * 3600)), '3 hours ago');
});
test('5 days ago -> "5 days ago" (day branch)', () => {
  assert.equal(timeAgo(ago(5 * 86400)), '5 days ago');
});

console.log('\nregression: month/year branches are NOT over-counted (the headline bug)');
test('20 days ago -> "last month", NOT "3 months ago" (month divisor fix)', () => {
  // Buggy code divided by the day threshold (604800 = a week): 20d -> ~3 months.
  assert.equal(timeAgo(ago(20 * 86400)), 'last month');
});
test('1 year ago -> "last year", NOT "12 years ago" (year divisor fix)', () => {
  // Buggy code divided by the month threshold (2629800): 1yr -> ~12 years.
  assert.equal(timeAgo(ago(31557600)), 'last year');
});
test('2 years ago -> "2 years ago", NOT "24 years ago"', () => {
  assert.equal(timeAgo(ago(2 * 31557600)), '2 years ago');
});
test('7 years ago -> "7 years ago" (the reported "78 years ago" defect)', () => {
  // This is the exact symptom QA reported for a 2020-01-01 commit: rendered
  // "78 years ago" (~12x over-count) instead of ~"7 years ago".
  assert.equal(timeAgo(ago(7 * 31557600)), '7 years ago');
});
test('10 years ago -> "10 years ago", NOT "120 years ago"', () => {
  assert.equal(timeAgo(ago(10 * 31557600)), '10 years ago');
});

console.log('\ntimeAgo handles future timestamps (sign symmetry)');
test('10 seconds in the future -> "in 10 seconds"', () => {
  assert.equal(timeAgo(new Date(Date.now() + 10 * 1000).toISOString()), 'in 10 seconds');
});

console.log(`\n✓ UTILS TESTS PASS (${passed})`);
