// Pure tests for the dashboard poll-cadence resolver.
//
// Like timelinePacing.test.mjs, there is no FE test runner in this repo, so
// this loads the REAL src/lib/pollInterval.ts (transpiled TS -> ESM via Vite's
// OXC transform) and exercises resolvePollIntervalMs — the pure helper that
// maps the persisted pollIntervalMs pref onto a web-safe dashboard refresh
// cadence. App.tsx feeds this into both setInterval calls; this guards the
// "no SSH-load regression" + "10s floor" + "below-floor -> 60s default"
// contract without a browser.
//
// Run: node pollInterval.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const helperPath = resolve(__dirname, 'src/lib/pollInterval.ts');

// --- Load the REAL pollInterval.ts (TS -> ESM via the OXC transform) ----------
const src = readFileSync(helperPath, 'utf8');
const { code } = await transformWithOxc(src, helperPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-pollinterval-test-'));
const tmpFile = join(tmpDir, 'pollInterval.mjs');
writeFileSync(tmpFile, code);
const {
  resolvePollIntervalMs,
  WEB_POLL_FLOOR_MS,
  WEB_POLL_CEILING_MS,
  WEB_POLL_DEFAULT_MS,
  CLI_POLL_DEFAULT_MS,
} = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

console.log('\nconstants: floor/default/ceiling form a sane web cadence ladder');
test('WEB_POLL_FLOOR_MS is 10000 (10s, matches HEALTH_POLL_MS)', () => {
  assert.equal(WEB_POLL_FLOOR_MS, 10_000);
});
test('WEB_POLL_DEFAULT_MS is 60000 (60s — the historical hardcoded cadence)', () => {
  assert.equal(WEB_POLL_DEFAULT_MS, 60_000);
});
test('WEB_POLL_CEILING_MS is 120000 (2min)', () => {
  assert.equal(WEB_POLL_CEILING_MS, 120_000);
});
test('CLI_POLL_DEFAULT_MS is 1500 (config.js default)', () => {
  assert.equal(CLI_POLL_DEFAULT_MS, 1_500);
});

console.log('\nabsent / invalid -> 60s web default (no crash, no fast poll)');
test('undefined -> 60s', () => {
  assert.equal(resolvePollIntervalMs(undefined), WEB_POLL_DEFAULT_MS);
});
test('null -> 60s', () => {
  assert.equal(resolvePollIntervalMs(null), WEB_POLL_DEFAULT_MS);
});
test('NaN -> 60s', () => {
  assert.equal(resolvePollIntervalMs(NaN), WEB_POLL_DEFAULT_MS);
});
test('Infinity -> 60s', () => {
  assert.equal(resolvePollIntervalMs(Infinity), WEB_POLL_DEFAULT_MS);
});
test('non-number string is rejected (typeof guard) -> 60s', () => {
  // A persisted config value arriving as a string must not slip through.
  assert.equal(resolvePollIntervalMs('15000'), WEB_POLL_DEFAULT_MS);
});

console.log('\nthe CLI default (1500) must NOT pass through — it would flood SSH');
test('1500 (config.js CLI default) -> 60s, NOT 1.5s', () => {
  assert.equal(resolvePollIntervalMs(1500), WEB_POLL_DEFAULT_MS);
});
test('1500 maps to 60s even though it is also below the floor', () => {
  assert.notEqual(resolvePollIntervalMs(1500), 1500);
  assert.notEqual(resolvePollIntervalMs(1500), WEB_POLL_FLOOR_MS);
});

console.log('\nbelow the 10s floor -> 60s default (NOT clamped up to 10s)');
test('5000 (sub-floor) -> 60s, NOT 10s', () => {
  assert.equal(resolvePollIntervalMs(5000), WEB_POLL_DEFAULT_MS);
  assert.notEqual(resolvePollIntervalMs(5000), WEB_POLL_FLOOR_MS);
});
test('9999 (just under floor) -> 60s', () => {
  assert.equal(resolvePollIntervalMs(9999), WEB_POLL_DEFAULT_MS);
});
test('0 -> 60s', () => {
  assert.equal(resolvePollIntervalMs(0), WEB_POLL_DEFAULT_MS);
});
test('negative -> 60s', () => {
  assert.equal(resolvePollIntervalMs(-1000), WEB_POLL_DEFAULT_MS);
});

console.log('\nin-range values pass through unchanged (the pref actually governs)');
test('10000 (exactly the floor) -> 10000', () => {
  assert.equal(resolvePollIntervalMs(10000), 10000);
});
test('15000 (the success-criterion value) -> 15000', () => {
  assert.equal(resolvePollIntervalMs(15000), 15000);
});
test('30000 -> 30000', () => {
  assert.equal(resolvePollIntervalMs(30000), 30000);
});
test('60000 (web default) -> 60000', () => {
  assert.equal(resolvePollIntervalMs(60000), 60000);
});
test('120000 (exactly the ceiling) -> 120000', () => {
  assert.equal(resolvePollIntervalMs(120000), 120000);
});

console.log('\nabove the 2min ceiling -> clamped to 2min');
test('200000 -> 120000', () => {
  assert.equal(resolvePollIntervalMs(200000), WEB_POLL_CEILING_MS);
});
test('Number.MAX_SAFE_INTEGER -> 120000', () => {
  assert.equal(resolvePollIntervalMs(Number.MAX_SAFE_INTEGER), WEB_POLL_CEILING_MS);
});

console.log('\nidempotent: resolving an already-resolved value is a fixed point');
test('resolve(resolve(x)) === resolve(x) across the ladder', () => {
  for (const x of [undefined, 1500, 5000, 10000, 15000, 60000, 120000, 999999]) {
    const once = resolvePollIntervalMs(x);
    assert.equal(resolvePollIntervalMs(once), once);
  }
});

console.log(`\n✓ POLL INTERVAL TESTS PASS (${passed})`);
