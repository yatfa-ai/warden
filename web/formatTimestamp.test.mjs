// Pure tests for the shared formatTimestamp helper (WARDEN-213): the formatting
// core behind the client-side "Timestamp format" preference (Relative vs
// Absolute).
//
// Like timelinePacing.test.mjs, there is no FE test runner in this repo, so this
// loads the REAL src/lib/formatTimestamp.ts (transpiled TS -> ESM via Vite's OXC
// transform) and exercises the pure helpers. The relative branch reads the wall
// clock, so these tests pin Date.now for determinism.
//
// Run: node formatTimestamp.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const helperPath = resolve(__dirname, 'src/lib/formatTimestamp.ts');

// --- Load the REAL formatTimestamp.ts (TS -> ESM via the OXC transform) ------
const src = readFileSync(helperPath, 'utf8');
const { code } = await transformWithOxc(src, helperPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-fmtts-test-'));
const tmpFile = join(tmpDir, 'formatTimestamp.mjs');
writeFileSync(tmpFile, code);
const { formatTimestamp, formatRelative, formatAbsolute, formatAbsoluteFull } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// A fixed wall-clock epoch the relative-bucket tests pin Date.now to. Chosen so
// none of the deltas below cross a day boundary relative to each other.
const NOW = 1_700_000_000_000; // 2023-11-14T22:13:20Z

console.log('\nformatRelative: compact buckets, bare (no " ago" suffix), clock pinned');
const realNow = Date.now;
Date.now = () => NOW;
try {
  test('0s -> "0s"', () => assert.equal(formatRelative(NOW), '0s'));
  test('30s -> "30s"', () => assert.equal(formatRelative(NOW - 30_000), '30s'));
  test('125s -> "2m"', () => assert.equal(formatRelative(NOW - 125_000), '2m'));
  test('3h -> "3h"', () => assert.equal(formatRelative(NOW - 3 * 3600_000), '3h'));
  test('2d -> "2d"', () => assert.equal(formatRelative(NOW - 2 * 86400_000), '2d'));
  test('bare bucket (no " ago" suffix)', () => {
    assert.equal(formatRelative(NOW - 125_000).endsWith(' ago'), false);
  });
} finally {
  Date.now = realNow;
}

console.log('\nformatTimestamp: mode routing');
test("relative mode -> bare relative bucket", () => {
  Date.now = () => NOW;
  try {
    assert.equal(formatTimestamp(NOW - 30_000, 'relative'), '30s');
  } finally {
    Date.now = realNow;
  }
});
test('absolute mode != relative mode for the same instant', () => {
  Date.now = () => NOW;
  try {
    assert.notEqual(formatTimestamp(NOW - 30_000, 'absolute'), formatTimestamp(NOW - 30_000, 'relative'));
  } finally {
    Date.now = realNow;
  }
});

console.log('\nformatTimestamp: input coercion (number | ISO string | Date)');
// One fixed instant in the year 2000 — far from "today" so the absolute path is
// the deterministic "older date -> date + time" branch regardless of the clock.
const MS = Date.UTC(2000, 0, 1, 0, 0, 0);
const ISO = new Date(MS).toISOString();
const expectedAbsolute = `${new Date(MS).toLocaleDateString()} ${new Date(MS).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
test('number input', () => assert.equal(formatTimestamp(MS, 'absolute'), expectedAbsolute));
test('ISO string input', () => assert.equal(formatTimestamp(ISO, 'absolute'), expectedAbsolute));
test('Date input', () => assert.equal(formatTimestamp(new Date(MS), 'absolute'), expectedAbsolute));

console.log('\nformatAbsolute: older date renders date + time; bare time for today');
test('older date -> "date time"', () => {
  assert.equal(formatAbsolute(MS), expectedAbsolute);
});
test('today -> bare time (no date prefix)', () => {
  const today = new Date();
  // same calendar day, a few hours earlier
  const sameDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 1, 5);
  const out = formatAbsolute(sameDay.getTime());
  const time = new Date(sameDay).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  assert.equal(out, time);
});

console.log('\nformatTimestamp: withSuffix opt-in (" ago" in relative ONLY — never absolute)');
// The bug this guards: call sites that used to own a literal " ago" rendered
// "2:13 PM ago" under Absolute mode. withSuffix centralizes the suffix and
// suppresses it in absolute mode, so the grammar holds in either mode.
test('withSuffix + relative -> bare bucket + " ago"', () => {
  Date.now = () => NOW;
  try {
    assert.equal(formatTimestamp(NOW - 125_000, 'relative', { withSuffix: true }), '2m ago');
  } finally {
    Date.now = realNow;
  }
});
test('withSuffix + absolute -> NO suffix (the "2:13 PM ago" bug stays dead)', () => {
  // Far from today so the absolute path is the deterministic "date + time" branch.
  const out = formatTimestamp(MS, 'absolute', { withSuffix: true });
  assert.equal(out, expectedAbsolute);
  assert.equal(out.endsWith(' ago'), false);
});
test('no withSuffix -> never a suffix, either mode', () => {
  Date.now = () => NOW;
  try {
    assert.equal(formatTimestamp(NOW - 30_000, 'relative').endsWith(' ago'), false);
  } finally {
    Date.now = realNow;
  }
  assert.equal(formatTimestamp(MS, 'absolute').endsWith(' ago'), false);
});

console.log('\nformatAbsoluteFull: full-precision absolute (date + time WITH seconds) for tooltips');
// The chat-row hover's purpose is exact time — more precise than the pref-driven
// row. formatAbsoluteFull keeps the seconds the compact row form drops, and is
// mode-independent (always absolute).
test('equals new Date(ms).toLocaleString() (preserves pre-pref tooltip precision)', () => {
  assert.equal(formatAbsoluteFull(MS), new Date(MS).toLocaleString());
});
test('more precise than the compact formatAbsolute (differs from it)', () => {
  assert.notEqual(formatAbsoluteFull(MS), formatAbsolute(MS));
});
test('coerces ISO string and Date like formatTimestamp', () => {
  assert.equal(formatAbsoluteFull(ISO), new Date(MS).toLocaleString());
  assert.equal(formatAbsoluteFull(new Date(MS)), new Date(MS).toLocaleString());
});

console.log(`\n✓ FORMAT TIMESTAMP TESTS PASS (${passed})`);
