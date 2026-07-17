// Tests for the telemetry config-wiring helper (WARDEN-524). resolveTelemetryTier
// is the PURE decision logic main.cjs uses to drive the source's base-consent
// toggle and the pipeline's consent resolver: it maps the persisted prefs
// (telemetryBaseEnabled / telemetryExtendedEnabled) to a pipeline tier, mirroring
// the SERVER's extended-requires-base clamp (src/server.js PUT /api/config line
// `cfg.telemetryExtendedEnabled = cfg.telemetryExtendedEnabled && cfg.telemetryBaseEnabled`).
//
// Factored out of main.cjs (mirroring electron/window-state.cjs's separable pure
// logic) so the resolution is unit-testable under `node --test` without Electron.
//
// Auto-discovered by `npm test` in web/ (`node --test`).
//
// Run: node telemetry-config.test.mjs   (from web/)
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { resolveTelemetryTier, readTelemetryPrefs } = require(join(__dirname, '..', 'electron', 'telemetry-config.cjs'));

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

console.log('\nresolveTelemetryTier — off / base / extended resolution');

test('both off → off (the off-by-default posture)', () => {
  assert.equal(resolveTelemetryTier({ telemetryBaseEnabled: false, telemetryExtendedEnabled: false }), 'off');
});

test('base on, extended off → base', () => {
  assert.equal(resolveTelemetryTier({ telemetryBaseEnabled: true, telemetryExtendedEnabled: false }), 'base');
});

test('base on AND extended on → extended', () => {
  assert.equal(resolveTelemetryTier({ telemetryBaseEnabled: true, telemetryExtendedEnabled: true }), 'extended');
});

console.log('\nextended-requires-base — mirrors the server-side clamp');

test('base off but extended on → OFF (extended is unreachable without base)', () => {
  // This is the corrupt-disk-state self-heal: a persisted (extended on, base off)
  // pair resolves to OFF here, the same clamp the server applies on its next PUT.
  assert.equal(resolveTelemetryTier({ telemetryBaseEnabled: false, telemetryExtendedEnabled: true }), 'off');
});

test('revoking base demotes extended → off (subordinate tier latches off)', () => {
  const prefs = { telemetryBaseEnabled: true, telemetryExtendedEnabled: true };
  assert.equal(resolveTelemetryTier(prefs), 'extended');
  prefs.telemetryBaseEnabled = false; // user revokes base
  assert.equal(resolveTelemetryTier(prefs), 'off');
});

console.log('\nmissing / malformed prefs → off (never accidentally retains identifiers)');

test('empty object → off', () => {
  assert.equal(resolveTelemetryTier({}), 'off');
});

test('undefined / null / non-object → off', () => {
  assert.equal(resolveTelemetryTier(undefined), 'off');
  assert.equal(resolveTelemetryTier(null), 'off');
  assert.equal(resolveTelemetryTier('extended'), 'off');
  assert.equal(resolveTelemetryTier(42), 'off');
});

test('non-boolean prefs are treated as off (type-strict, never truthy-coerced)', () => {
  // A corrupt body or hand-edited config that wrote a string/number must not
  // accidentally enable telemetry. Only the strict boolean true counts.
  assert.equal(resolveTelemetryTier({ telemetryBaseEnabled: 1, telemetryExtendedEnabled: 1 }), 'off');
  assert.equal(resolveTelemetryTier({ telemetryBaseEnabled: 'true', telemetryExtendedEnabled: true }), 'off');
  assert.equal(resolveTelemetryTier({ telemetryBaseEnabled: 'yes' }), 'off');
});

test('base on with extended MISSING → base (a missing extended is just "not extended")', () => {
  assert.equal(resolveTelemetryTier({ telemetryBaseEnabled: true }), 'base');
});

test('only extended present (no base key) → off', () => {
  assert.equal(resolveTelemetryTier({ telemetryExtendedEnabled: true }), 'off');
});

console.log('\nreadTelemetryPrefs — boot disk read (missing/malformed → safe all-off)');

test('reads the telemetry prefs verbatim from the config file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'warden-telcfg-'));
  const cfgPath = join(dir, 'config.json');
  writeFileSync(cfgPath, JSON.stringify({
    hosts: ['example'], llm: { model: 'x' }, // unrelated keys ignored
    telemetryBaseEnabled: true,
    telemetryExtendedEnabled: false,
    telemetryEndpoint: 'https://receiver.invalid/ingest',
    telemetryAuthToken: 'shared-secret-token',
  }));
  try {
    assert.deepEqual(readTelemetryPrefs(cfgPath), {
      telemetryBaseEnabled: true,
      telemetryExtendedEnabled: false,
      telemetryEndpoint: 'https://receiver.invalid/ingest',
      telemetryAuthToken: 'shared-secret-token',
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('missing telemetry keys default to off / empty (first-run posture)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'warden-telcfg-'));
  const cfgPath = join(dir, 'config.json');
  writeFileSync(cfgPath, JSON.stringify({ hosts: ['example'] })); // no telemetry keys
  try {
    assert.deepEqual(readTelemetryPrefs(cfgPath), {
      telemetryBaseEnabled: false,
      telemetryExtendedEnabled: false,
      telemetryEndpoint: '',
      telemetryAuthToken: '',
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a missing file → safe all-off defaults (never throws)', () => {
  assert.doesNotThrow(() => readTelemetryPrefs(join(tmpdir(), 'warden-does-not-exist-xyz', 'config.json')));
  assert.deepEqual(readTelemetryPrefs(join(tmpdir(), 'warden-does-not-exist-xyz', 'config.json')), {
    telemetryBaseEnabled: false,
    telemetryExtendedEnabled: false,
    telemetryEndpoint: '',
    telemetryAuthToken: '',
  });
});

test('a malformed (unparseable) config → safe all-off defaults (never throws)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'warden-telcfg-'));
  const cfgPath = join(dir, 'config.json');
  writeFileSync(cfgPath, '{ this is not valid json,,,');
  try {
    assert.deepEqual(readTelemetryPrefs(cfgPath), {
      telemetryBaseEnabled: false,
      telemetryExtendedEnabled: false,
      telemetryEndpoint: '',
      telemetryAuthToken: '',
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('non-boolean / non-string values are ignored (type-strict, never truthy-coerced)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'warden-telcfg-'));
  const cfgPath = join(dir, 'config.json');
  // A corrupt/hand-edited config with wrong types must not enable telemetry.
  writeFileSync(cfgPath, JSON.stringify({
    telemetryBaseEnabled: 'true',
    telemetryExtendedEnabled: 1,
    telemetryEndpoint: 42,
    telemetryAuthToken: 99,
  }));
  try {
    assert.deepEqual(readTelemetryPrefs(cfgPath), {
      telemetryBaseEnabled: false,
      telemetryExtendedEnabled: false,
      telemetryEndpoint: '',
      telemetryAuthToken: '',
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\n✓ TELEMETRY CONFIG (resolveTelemetryTier + readTelemetryPrefs) TESTS PASS (${passed})`);
