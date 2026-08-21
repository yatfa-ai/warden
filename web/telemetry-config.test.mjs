// Tests for the telemetry config-wiring helper (WARDEN-524, reworked onto
// per-category consent by WARDEN-1116). `resolveTelemetryConsent` is the PURE
// decision logic main.cjs uses to drive the source's consent state and the
// pipeline's consent resolver; `readTelemetryPrefs` is the main-process BOOT DISK
// READ — one of the TWO INDEPENDENT off-by-default enforcement points (the other
// is the server's config write path, pinned in src/server-config.test.js).
//
// This file's job is that main-process half: whatever is on disk — missing,
// partial, malformed, corrupt, unrecognized, or written by an OLDER build — must
// resolve to nothing enabled unless the user really opted in. The main process
// never trusts that the server sanitized what it wrote.
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
const { resolveTelemetryConsent, readTelemetryPrefs } = require(join(__dirname, '..', 'electron', 'telemetry-config.cjs'));

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

/** Write a config.json in a throwaway dir and run `fn(path)`. */
function withConfig(contents, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'warden-telcfg-'));
  const cfgPath = join(dir, 'config.json');
  writeFileSync(cfgPath, typeof contents === 'string' ? contents : JSON.stringify(contents));
  try {
    return fn(cfgPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ALL_OFF = { incidents: false, names: false };
/** The full prefs shape readTelemetryPrefs returns when nothing is configured. */
const SAFE_DEFAULTS = {
  telemetryEndpoint: '',
  telemetryAuthToken: '',
  telemetryIncidentsEnabled: false,
  telemetryNamesEnabled: false,
};

console.log('\nresolveTelemetryConsent — independent per-category resolution');

test('everything off → nothing enabled (the off-by-default posture)', () => {
  assert.deepEqual(
    { ...resolveTelemetryConsent({ telemetryIncidentsEnabled: false, telemetryNamesEnabled: false }) },
    ALL_OFF,
  );
});

test('incidents on, names off → only incidents', () => {
  assert.deepEqual(
    { ...resolveTelemetryConsent({ telemetryIncidentsEnabled: true, telemetryNamesEnabled: false }) },
    { incidents: true, names: false },
  );
});

test('both on → both', () => {
  assert.deepEqual(
    { ...resolveTelemetryConsent({ telemetryIncidentsEnabled: true, telemetryNamesEnabled: true }) },
    { incidents: true, names: true },
  );
});

console.log('\nINDEPENDENCE — no category is clamped to, or implied by, another');

test('names on with incidents OFF resolves to names ON (no extended-requires-base clamp)', () => {
  // The old resolver mirrored the server clamp and collapsed this to "off". Per
  // WARDEN-443 Principle 2 the categories are independent, so the user's choice
  // must survive resolution verbatim. Safety comes from the SOURCE being inert
  // with nothing collecting (web/telemetry-source.test.mjs), not from a clamp here.
  assert.deepEqual(
    { ...resolveTelemetryConsent({ telemetryIncidentsEnabled: false, telemetryNamesEnabled: true }) },
    { incidents: false, names: true },
  );
});

test('revoking incidents leaves names exactly as the user set it', () => {
  const prefs = { telemetryIncidentsEnabled: true, telemetryNamesEnabled: true };
  assert.deepEqual({ ...resolveTelemetryConsent(prefs) }, { incidents: true, names: true });
  prefs.telemetryIncidentsEnabled = false; // user revokes incidents
  assert.deepEqual({ ...resolveTelemetryConsent(prefs) }, { incidents: false, names: true },
    'names is NOT demoted with incidents — it was never subordinate');
});

test('a missing category key is just "not enabled", never an implication', () => {
  assert.deepEqual({ ...resolveTelemetryConsent({ telemetryIncidentsEnabled: true }) },
    { incidents: true, names: false });
  assert.deepEqual({ ...resolveTelemetryConsent({ telemetryNamesEnabled: true }) },
    { incidents: false, names: true });
});

console.log('\nmissing / malformed prefs → nothing enabled (never accidentally retains identifiers)');

test('empty object → nothing enabled', () => {
  assert.deepEqual({ ...resolveTelemetryConsent({}) }, ALL_OFF);
});

test('undefined / null / non-object → nothing enabled', () => {
  for (const bad of [undefined, null, 'extended', 42, [], true]) {
    assert.deepEqual({ ...resolveTelemetryConsent(bad) }, ALL_OFF, `nothing enabled for ${JSON.stringify(bad)}`);
  }
});

test('non-boolean prefs are treated as off (type-strict, never truthy-coerced)', () => {
  // A corrupt body or hand-edited config that wrote a string/number must not
  // accidentally enable telemetry. Only the strict boolean true counts.
  assert.deepEqual({ ...resolveTelemetryConsent({ telemetryIncidentsEnabled: 1, telemetryNamesEnabled: 1 }) }, ALL_OFF);
  assert.deepEqual({ ...resolveTelemetryConsent({ telemetryIncidentsEnabled: 'true', telemetryNamesEnabled: 'yes' }) }, ALL_OFF);
  assert.deepEqual({ ...resolveTelemetryConsent({ telemetryIncidentsEnabled: {} }) }, ALL_OFF);
});

test('an unrecognized category key can never enable anything', () => {
  assert.deepEqual({ ...resolveTelemetryConsent({ telemetryUsageEnabled: true, telemetryEverythingEnabled: true }) }, ALL_OFF);
});

console.log('\nMIGRATION — a config written by a pre-WARDEN-1116 build carries over unchanged');

test('the legacy base+extended pair maps to incidents+names', () => {
  assert.deepEqual(
    { ...resolveTelemetryConsent({ telemetryBaseEnabled: true, telemetryExtendedEnabled: true }) },
    { incidents: true, names: true },
  );
});

test('legacy base-only maps to incidents only — nothing new is silently enabled', () => {
  assert.deepEqual(
    { ...resolveTelemetryConsent({ telemetryBaseEnabled: true }) },
    { incidents: true, names: false },
  );
});

test('a stale legacy extended-WITHOUT-base pair maps to nothing enabled', () => {
  // The old model resolved this to "send nothing" (the extended-requires-base
  // clamp). The migration carries the EFFECTIVE consent forward, so upgrading
  // cannot enable a category the user never effectively had on.
  assert.deepEqual(
    { ...resolveTelemetryConsent({ telemetryBaseEnabled: false, telemetryExtendedEnabled: true }) },
    ALL_OFF,
  );
});

test('a NON-BOOLEAN legacy value never migrates into consent', () => {
  assert.deepEqual({ ...resolveTelemetryConsent({ telemetryBaseEnabled: 'true' }) }, ALL_OFF);
  assert.deepEqual({ ...resolveTelemetryConsent({ telemetryBaseEnabled: 1, telemetryExtendedEnabled: 1 }) }, ALL_OFF);
});

test('once the new key exists it WINS — a leftover legacy key cannot re-enable a revoked category', () => {
  assert.deepEqual(
    {
      ...resolveTelemetryConsent({
        telemetryBaseEnabled: true,
        telemetryExtendedEnabled: true,
        telemetryIncidentsEnabled: false,
        telemetryNamesEnabled: false,
      }),
    },
    ALL_OFF,
  );
});

test('a CORRUPT new key resolves to off rather than falling back to the legacy key', () => {
  // Falling back would let a corrupt value be reinterpreted into an enabled
  // state — the exact "corrupt input must never enable" rule this guards.
  assert.deepEqual(
    { ...resolveTelemetryConsent({ telemetryBaseEnabled: true, telemetryIncidentsEnabled: 'true' }) },
    ALL_OFF,
  );
});

console.log('\nreadTelemetryPrefs — boot disk read (missing/malformed → safe all-off)');

test('reads the telemetry prefs verbatim from the config file', () => {
  withConfig({
    hosts: ['example'], llm: { model: 'x' }, // unrelated keys ignored
    telemetryIncidentsEnabled: true,
    telemetryNamesEnabled: false,
    telemetryEndpoint: 'https://receiver.invalid/ingest',
    telemetryAuthToken: 'shared-secret-token',
  }, (cfgPath) => {
    assert.deepEqual(readTelemetryPrefs(cfgPath), {
      telemetryEndpoint: 'https://receiver.invalid/ingest',
      telemetryAuthToken: 'shared-secret-token',
      telemetryIncidentsEnabled: true,
      telemetryNamesEnabled: false,
    });
  });
});

test('MIGRATES a legacy on-disk config at boot (an existing opt-in keeps working)', () => {
  withConfig({
    telemetryBaseEnabled: true,
    telemetryExtendedEnabled: true,
    telemetryEndpoint: 'https://receiver.invalid/ingest',
  }, (cfgPath) => {
    const prefs = readTelemetryPrefs(cfgPath);
    assert.equal(prefs.telemetryIncidentsEnabled, true, 'base → incidents at boot');
    assert.equal(prefs.telemetryNamesEnabled, true, 'extended → names at boot');
    assert.equal(prefs.telemetryEndpoint, 'https://receiver.invalid/ingest');
  });
});

test('a names-ONLY on-disk config is read verbatim (no clamp on the boot read either)', () => {
  withConfig({ telemetryIncidentsEnabled: false, telemetryNamesEnabled: true }, (cfgPath) => {
    const prefs = readTelemetryPrefs(cfgPath);
    assert.equal(prefs.telemetryIncidentsEnabled, false);
    assert.equal(prefs.telemetryNamesEnabled, true);
  });
});

test('missing telemetry keys default to off / empty (first-run posture)', () => {
  withConfig({ hosts: ['example'] }, (cfgPath) => {
    assert.deepEqual(readTelemetryPrefs(cfgPath), SAFE_DEFAULTS);
  });
});

test('a missing file → safe all-off defaults (never throws)', () => {
  const missing = join(tmpdir(), 'warden-does-not-exist-xyz', 'config.json');
  assert.doesNotThrow(() => readTelemetryPrefs(missing));
  assert.deepEqual(readTelemetryPrefs(missing), SAFE_DEFAULTS);
});

test('a malformed (unparseable) config → safe all-off defaults (never throws)', () => {
  withConfig('{ this is not valid json,,,', (cfgPath) => {
    assert.deepEqual(readTelemetryPrefs(cfgPath), SAFE_DEFAULTS);
  });
});

test('a config whose root is not an object → safe all-off defaults', () => {
  withConfig('[1,2,3]', (cfgPath) => {
    assert.deepEqual(readTelemetryPrefs(cfgPath), SAFE_DEFAULTS);
  });
});

test('non-boolean / non-string values are ignored (type-strict, never truthy-coerced)', () => {
  // A corrupt/hand-edited config with wrong types must not enable telemetry.
  withConfig({
    telemetryIncidentsEnabled: 'true',
    telemetryNamesEnabled: 1,
    telemetryEndpoint: 42,
    telemetryAuthToken: 99,
  }, (cfgPath) => {
    assert.deepEqual(readTelemetryPrefs(cfgPath), SAFE_DEFAULTS);
  });
});

test('a PARTIAL config (one category set, the other absent) enables only what was set', () => {
  withConfig({ telemetryIncidentsEnabled: true }, (cfgPath) => {
    assert.deepEqual(readTelemetryPrefs(cfgPath), {
      ...SAFE_DEFAULTS,
      telemetryIncidentsEnabled: true,
    });
  });
});

console.log(`\n✓ TELEMETRY CONFIG (resolveTelemetryConsent + readTelemetryPrefs) TESTS PASS (${passed})`);
