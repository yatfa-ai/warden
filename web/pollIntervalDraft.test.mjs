// Pure tests for the "Dashboard Refresh Interval (ms)" typed-draft rules
// (WARDEN-938).
//
// No front-end test runner in this repo, so (like pollInterval.test.mjs and
// settingsDirty.test.mjs) this loads the REAL modules — transpiled TS -> ESM via
// Vite's OXC transform — and exercises the pure helpers with plain values. Both
// modules are import-free, so the emitted code loads standalone.
//
// The control this backs used to render the RESOLVER OUTPUT as its controlled
// `value`, which made it un-typeable (typing `1` re-rendered as `60000`). The
// fix moves the keystrokes into a local draft and commits on blur; these are the
// two pure rules of that commit, plus the invariants they must not break:
//
//   - an UNTOUCHED field commits nothing (pollIntervalMs is shared with the CLI,
//     whose watch mode legitimately uses 1500ms — tabbing past must not clamp it)
//   - whatever IS committed round-trips through resolvePollIntervalMs unchanged,
//     so displayed value == persisted value == the cadence actually run
//   - the draft bounds stay equal to the resolver's floor/ceiling
//
// Run: node pollIntervalDraft.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Load the REAL TS modules (TS -> ESM via the OXC transform Vite bundles) --
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-polldraft-test-'));
const load = async (relPath, outName) => {
  const absPath = resolve(__dirname, relPath);
  const { code } = await transformWithOxc(readFileSync(absPath, 'utf8'), absPath, {});
  const tmpFile = join(tmpDir, outName);
  writeFileSync(tmpFile, code);
  return import(tmpFile);
};
const { POLL_INPUT_MIN_MS, POLL_INPUT_MAX_MS, commitPollIntervalDraft, isPollDraftOutOfRange } =
  await load('src/components/settings/pollIntervalDraft.ts', 'pollIntervalDraft.mjs');
const { resolvePollIntervalMs, WEB_POLL_FLOOR_MS, WEB_POLL_CEILING_MS, CLI_POLL_DEFAULT_MS } =
  await load('src/lib/pollInterval.ts', 'pollInterval.mjs');
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

console.log('\nthe draft bounds mirror the resolver (the control advertises min/max from these)');
test('POLL_INPUT_MIN_MS === WEB_POLL_FLOOR_MS', () => {
  assert.equal(POLL_INPUT_MIN_MS, WEB_POLL_FLOOR_MS, 'drifting bounds would commit a value the resolver rewrites');
});
test('POLL_INPUT_MAX_MS === WEB_POLL_CEILING_MS', () => {
  assert.equal(POLL_INPUT_MAX_MS, WEB_POLL_CEILING_MS);
});

console.log('\nan untouched field commits NOTHING (the CLI 1500ms default survives a tab-through)');
test('a null draft commits null', () => {
  assert.equal(commitPollIntervalDraft(null), null);
});
test('a null draft is never flagged out of range', () => {
  assert.equal(isPollDraftOutOfRange(null), false);
});

console.log('\nan in-range typed value is committed verbatim');
test('the ticket scenario: "15000" commits 15000', () => {
  assert.equal(commitPollIntervalDraft('15000'), 15000);
});
test('both endpoints are inclusive', () => {
  assert.equal(commitPollIntervalDraft('10000'), 10000);
  assert.equal(commitPollIntervalDraft('120000'), 120000);
});
test('an in-range value shows no out-of-range hint', () => {
  assert.equal(isPollDraftOutOfRange('15000'), false);
  assert.equal(isPollDraftOutOfRange('10000'), false);
  assert.equal(isPollDraftOutOfRange('120000'), false);
});

console.log('\nan out-of-range typed value is clamped, never persisted raw');
test('a partial keystroke ("1") clamps up to the floor instead of reaching config.json', () => {
  // The old control persisted this raw, and src/cli.js reads pollIntervalMs with
  // no floor — a stored 1 turned CLI watch mode into a 1ms SSH redraw loop.
  assert.equal(commitPollIntervalDraft('1'), POLL_INPUT_MIN_MS);
});
test('below the floor clamps up', () => {
  assert.equal(commitPollIntervalDraft('9999'), POLL_INPUT_MIN_MS);
  assert.equal(commitPollIntervalDraft('-5000'), POLL_INPUT_MIN_MS);
  assert.equal(commitPollIntervalDraft('0'), POLL_INPUT_MIN_MS);
});
test('above the ceiling clamps down', () => {
  assert.equal(commitPollIntervalDraft('200000'), POLL_INPUT_MAX_MS);
  assert.equal(commitPollIntervalDraft('120001'), POLL_INPUT_MAX_MS);
});
test('out-of-range drafts raise the hint', () => {
  assert.equal(isPollDraftOutOfRange('1'), true);
  assert.equal(isPollDraftOutOfRange('9999'), true);
  assert.equal(isPollDraftOutOfRange('120001'), true);
});

console.log('\nan unparseable draft reverts (commits nothing) rather than writing a NaN');
test('an emptied field commits null', () => {
  assert.equal(commitPollIntervalDraft(''), null, 'clearing + leaving keeps the stored cadence');
});
test('junk the number input can emit commits null', () => {
  assert.equal(commitPollIntervalDraft('-'), null);
  assert.equal(commitPollIntervalDraft('abc'), null);
  assert.equal(commitPollIntervalDraft('   '), null);
});
test('an unparseable draft raises no out-of-range hint', () => {
  assert.equal(isPollDraftOutOfRange(''), false);
  assert.equal(isPollDraftOutOfRange('abc'), false);
});

console.log('\nround trip: what is committed is what is displayed and what runs');
test('every committed value passes through resolvePollIntervalMs unchanged', () => {
  for (const typed of ['1', '9999', '10000', '15000', '60000', '119999', '120000', '999999']) {
    const committed = commitPollIntervalDraft(typed);
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
  assert.ok(CLI_POLL_DEFAULT_MS < POLL_INPUT_MIN_MS);
  assert.notEqual(commitPollIntervalDraft(String(CLI_POLL_DEFAULT_MS)), CLI_POLL_DEFAULT_MS);
});

console.log(`\n✓ POLL-INTERVAL DRAFT TESTS PASS (${passed})`);
