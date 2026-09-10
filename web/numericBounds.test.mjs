// Pure tests for the shared numeric clamp the settings sections use
// (WARDEN-1331).
//
// numericBounds.ts is deliberately import-free, so (like pollIntervalDraft.test.mjs)
// this loads the REAL module — transpiled TS -> ESM via Vite's OXC transform —
// and exercises the pure helpers with plain values.
//
// The helpers are the ONE clamp behind every in-scope section's onBlur: the
// input's min/max attributes, the blur clamp and the "capped to N on blur"
// hint all derive from the SERVED bound (config.bounds.*, which comes from
// src/config-schema.js's clamp/uiRange descriptors). The cross-layer pin —
// that the served band equals what the resolver/enforcer expects — lives in
// pollIntervalDraft.test.mjs and src/config-schema.test.js; this file pins the
// helper's own contract, notably the ONE-SIDED bound behavior (no max is ever
// invented where the server enforces none).
//
// Run: node numericBounds.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));

const tmpDir = mkdtempSync(join(tmpdir(), 'warden-numbounds-test-'));
const absPath = resolve(__dirname, 'src/components/settings/numericBounds.ts');
const { code } = await transformWithOxc(readFileSync(absPath, 'utf8'), absPath, {});
const tmpFile = join(tmpDir, 'numericBounds.mjs');
writeFileSync(tmpFile, code);
const { clampToBounds, isOutOfBounds } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

console.log('\nbilateral bounds clamp both sides (the connectTimeout / observerSessionTimeout shape)');
const bilateral = { min: 1, max: 60 };
test('in-range passes through verbatim', () => {
  assert.equal(clampToBounds(30, bilateral), 30);
});
test('below min clamps up; above max clamps down; endpoints inclusive', () => {
  assert.equal(clampToBounds(0, bilateral), 1);
  assert.equal(clampToBounds(999, bilateral), 60);
  assert.equal(clampToBounds(1, bilateral), 1);
  assert.equal(clampToBounds(60, bilateral), 60);
});
test('isOutOfBounds flags only the outside', () => {
  assert.equal(isOutOfBounds(0, bilateral), true);
  assert.equal(isOutOfBounds(61, bilateral), true);
  assert.equal(isOutOfBounds(30, bilateral), false);
  assert.equal(isOutOfBounds(1, bilateral), false);
  assert.equal(isOutOfBounds(60, bilateral), false);
});

console.log('\none-sided bounds clamp only the declared side — no max is invented (the health/tokenBudget shape)');
const minOnly = { min: 1 };
test('a huge value is NOT clamped down by an absent max', () => {
  assert.equal(clampToBounds(5000, minOnly), 5000, 'the server enforces no ceiling here');
  assert.equal(clampToBounds(0, minOnly), 1);
});
test('isOutOfBounds ignores the absent side', () => {
  assert.equal(isOutOfBounds(5000, minOnly), false);
  assert.equal(isOutOfBounds(0, minOnly), true);
});
const maxOnly = { max: 180 };
test('an absent min never clamps up', () => {
  assert.equal(clampToBounds(-5, maxOnly), -5, 'the server enforces no floor here');
  assert.equal(clampToBounds(999, maxOnly), 180);
});

console.log('\nunbounded-shaped input is harmless');
test('an empty bound clamps nothing and flags nothing', () => {
  assert.equal(clampToBounds(-999, {}), -999);
  assert.equal(isOutOfBounds(999, {}), false);
});

console.log(`\n✓ NUMERIC-BOUNDS TESTS PASS (${passed})`);
