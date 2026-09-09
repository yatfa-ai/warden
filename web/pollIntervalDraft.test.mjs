// Pure tests for the "Dashboard Refresh Interval (ms)" typed-draft rules
// (WARDEN-938, bounds-parameterized by WARDEN-1331).
//
// No front-end test runner in this repo, so (like pollInterval.test.mjs and
// settingsDirty.test.mjs) this loads the REAL modules — transpiled TS -> ESM via
// Vite's OXC transform — and exercises the pure helpers with plain values. Both
// web modules are import-free, so the emitted code loads standalone.
//
// WARDEN-1331: the draft functions no longer carry a module-constant band —
// they take the SERVED bound (`config.bounds.pollIntervalMs`, derived from
// src/config-schema.js's uiRange descriptor) as a parameter. The old
// hand-copy assertions (POLL_INPUT_MIN_MS === WEB_POLL_FLOOR_MS and the MAX
// twin) are rewritten to assert against the SERVED bound instead: this test
// imports the REAL src/config-schema.js (pure, dependency-free ESM) and pins
// that the band the server declares IS the band the web resolver passes
// through — a three-layer cross-check (server declaration ↔ resolver
// constants) that the old two-layer test could not make.
//
// Invariants pinned:
//   - an UNTOUCHED field commits nothing (pollIntervalMs is shared with the
//     CLI, whose watch mode legitimately uses 1500ms — tabbing past must not
//     clamp it), and the CLI default stays BELOW the served input band
//   - whatever IS committed round-trips through resolvePollIntervalMs unchanged,
//     so displayed value == persisted value == the cadence actually run
//   - the served input band equals the resolver's floor/ceiling
//
// Run: node pollIntervalDraft.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The REAL server registry — the single declaration of the band this control
// advertises. (Pure ESM: no Electron, no fs, no ssh.)
const { buildBounds } = await import(resolve(__dirname, '../src/config-schema.js'));

// --- Load the REAL TS modules (TS -> ESM via the OXC transform Vite bundles) --
const tmpDir = mkdtempSync(join(__dirname, 'warden-polldraft-test-'));
const load = async (relPath, outName) => {
  const absPath = resolve(__dirname, relPath);
  const { code } = await transformWithOxc(readFileSync(absPath, 'utf8'), absPath, {});
  const tmpFile = join(tmpDir, outName);
  writeFileSync(tmpFile, code);
  return import(tmpFile);
};
const { commitPollIntervalDraft, isPollDraftOutOfRange } =
  await load('src/components/settings/pollIntervalDraft.ts', 'pollIntervalDraft.mjs');
const { resolvePollIntervalMs, WEB_POLL_FLOOR_MS, WEB_POLL_CEILING_MS, CLI_POLL_DEFAULT_MS } =
  await load('src/lib/pollInterval.ts', 'pollInterval.mjs');
rmSync(tmpDir, { recursive: true, force: true });

// The SERVED band — exactly what GET /api/config delivers for this field and
// what HostsSection passes into these helpers.
const SERVED_POLL_BOUNDS = buildBounds().pollIntervalMs;

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

console.log('\nthe SERVED input band is the band the web resolver passes through (the rewritten WARDEN-1331 mirror check)');
test('buildBounds().pollIntervalMs equals { min: WEB_POLL_FLOOR_MS, max: WEB_POLL_CEILING_MS }', () => {
  assert.deepEqual(
    SERVED_POLL_BOUNDS,
    { min: WEB_POLL_FLOOR_MS, max: WEB_POLL_CEILING_MS },
    'drifting bounds would commit a value the resolver rewrites — the server declaration and the resolver constants must agree',
  );
});
test('the served band is bilateral (both sides declared)', () => {
  assert.equal(typeof SERVED_POLL_BOUNDS.min, 'number');
  assert.equal(typeof SERVED_POLL_BOUNDS.max, 'number');
});

console.log('\nan untouched field commits NOTHING (the CLI 1500ms default survives a tab-through)');
test('a null draft commits null', () => {
  assert.equal(commitPollIntervalDraft(null, SERVED_POLL_BOUNDS), null);
});
test('a null draft is never flagged out of range', () => {
  assert.equal(isPollDraftOutOfRange(null, SERVED_POLL_BOUNDS), false);
});

console.log('\nan in-range typed value is committed verbatim');
test('the ticket scenario: "15000" commits 15000', () => {
  assert.equal(commitPollIntervalDraft('15000', SERVED_POLL_BOUNDS), 15000);
});
test('both endpoints are inclusive', () => {
  assert.equal(commitPollIntervalDraft('10000', SERVED_POLL_BOUNDS), 10000);
  assert.equal(commitPollIntervalDraft('120000', SERVED_POLL_BOUNDS), 120000);
});
test('an in-range value shows no out-of-range hint', () => {
  assert.equal(isPollDraftOutOfRange('15000', SERVED_POLL_BOUNDS), false);
  assert.equal(isPollDraftOutOfRange('10000', SERVED_POLL_BOUNDS), false);
  assert.equal(isPollDraftOutOfRange('120000', SERVED_POLL_BOUNDS), false);
});

console.log('\nan out-of-range typed value is clamped, never persisted raw');
test('a partial keystroke ("1") clamps up to the floor instead of reaching config.json', () => {
  // The old control persisted this raw, and src/cli.js reads pollIntervalMs with
  // no floor — a stored 1 turned CLI watch mode into a 1ms SSH redraw loop.
  assert.equal(commitPollIntervalDraft('1', SERVED_POLL_BOUNDS), SERVED_POLL_BOUNDS.min);
});
test('below the floor clamps up', () => {
  assert.equal(commitPollIntervalDraft('9999', SERVED_POLL_BOUNDS), SERVED_POLL_BOUNDS.min);
  assert.equal(commitPollIntervalDraft('-5000', SERVED_POLL_BOUNDS), SERVED_POLL_BOUNDS.min);
  assert.equal(commitPollIntervalDraft('0', SERVED_POLL_BOUNDS), SERVED_POLL_BOUNDS.min);
});
test('above the ceiling clamps down', () => {
  assert.equal(commitPollIntervalDraft('200000', SERVED_POLL_BOUNDS), SERVED_POLL_BOUNDS.max);
  assert.equal(commitPollIntervalDraft('120001', SERVED_POLL_BOUNDS), SERVED_POLL_BOUNDS.max);
});
test('out-of-range drafts raise the hint', () => {
  assert.equal(isPollDraftOutOfRange('1', SERVED_POLL_BOUNDS), true);
  assert.equal(isPollDraftOutOfRange('9999', SERVED_POLL_BOUNDS), true);
  assert.equal(isPollDraftOutOfRange('120001', SERVED_POLL_BOUNDS), true);
});

console.log('\nan unparseable draft reverts (commits nothing) rather than writing a NaN');
test('an emptied field commits null', () => {
  assert.equal(commitPollIntervalDraft('', SERVED_POLL_BOUNDS), null, 'clearing + leaving keeps the stored cadence');
});
test('junk the number input can emit commits null', () => {
  assert.equal(commitPollIntervalDraft('-', SERVED_POLL_BOUNDS), null);
  assert.equal(commitPollIntervalDraft('abc', SERVED_POLL_BOUNDS), null);
  assert.equal(commitPollIntervalDraft('   ', SERVED_POLL_BOUNDS), null);
});
test('an unparseable draft raises no out-of-range hint', () => {
  assert.equal(isPollDraftOutOfRange('', SERVED_POLL_BOUNDS), false);
  assert.equal(isPollDraftOutOfRange('abc', SERVED_POLL_BOUNDS), false);
});

console.log('\nround trip: what is committed is what is displayed and what runs');
test('every committed value passes through resolvePollIntervalMs unchanged', () => {
  for (const typed of ['1', '9999', '10000', '15000', '60000', '119999', '120000', '999999']) {
    const committed = commitPollIntervalDraft(typed, SERVED_POLL_BOUNDS);
    assert.equal(
      resolvePollIntervalMs(committed),
      committed,
      `typed ${typed} -> committed ${committed} must not be rewritten by the resolver`,
    );
  }
});
test('a committed value can never be the CLI default (which the resolver maps to 60s)', () => {
  // The displayed-vs-stored lie only exists for values the resolver rewrites;
  // the clamp band excludes 1500 by construction.
  assert.ok(CLI_POLL_DEFAULT_MS < SERVED_POLL_BOUNDS.min,
    'the CLI default must stay below the served input band (the server must never clamp the stored field up to it)');
  assert.notEqual(commitPollIntervalDraft(String(CLI_POLL_DEFAULT_MS), SERVED_POLL_BOUNDS), CLI_POLL_DEFAULT_MS);
});

console.log(`\n✓ POLL-INTERVAL DRAFT TESTS PASS (${passed})`);
