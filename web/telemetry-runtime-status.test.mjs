// Pure-derivation tests for the runtime telemetry drift status (WARDEN-631).
//
// deriveTelemetryRuntimeStatus maps the main→renderer bridge payload
// { drifted } into the rendered descriptor { kind: 'schema-drift' | 'ok' }. It is
// the RUNTIME sibling of deriveTelemetrySendingStatus (a pure function of CONFIG
// prefs) — this one is a pure function of the pipeline's runtime DELIVERY outcome.
// Kept side-effect-free + verifiable independent of the DOM, mirroring destination.ts
// / testConnection.ts.
//
// The module is TS/ESM, so it is loaded via Vite's OXC transform (the same pattern
// telemetry-pipeline.test.mjs uses for redact.ts). Auto-discovered by `npm test`
// in web/ (`node --test`).
//
// Run: node telemetry-runtime-status.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Load runtimeStatus.ts (TS -> ESM via the OXC transform Vite bundles) ------
const modPath = resolve(__dirname, 'src/lib/telemetry/runtimeStatus.ts');
const modSrc = readFileSync(modPath, 'utf8');
const { code: modCode } = await transformWithOxc(modSrc, modPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-telemetry-runtime-status-test-'));
// The module imports `@/lib/electron` (a type-only import — erased by the OXC
// transform, so no resolver is needed; the emitted JS has no runtime dependency).
const modTmp = join(tmpDir, 'runtimeStatus.mjs');
writeFileSync(modTmp, modCode);
const { deriveTelemetryRuntimeStatus } = await import(modTmp);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

test('a drifted payload derives to the schema-drift descriptor', () => {
  assert.deepEqual(deriveTelemetryRuntimeStatus({ drifted: true }), { kind: 'schema-drift' });
});

test('a non-drifted payload derives to ok', () => {
  assert.deepEqual(deriveTelemetryRuntimeStatus({ drifted: false }), { kind: 'ok' });
});

test('a null/undefined/missing payload derives to ok (never a false drift alarm)', () => {
  // The renderer may query before main has pushed, or receive a malformed message.
  // Each must map to ok — only an UNAMBIGUOUS drifted:true surfaces the warning.
  assert.deepEqual(deriveTelemetryRuntimeStatus(null), { kind: 'ok' });
  assert.deepEqual(deriveTelemetryRuntimeStatus(undefined), { kind: 'ok' });
});

test('a malformed payload (non-boolean drifted) derives to ok (defensive)', () => {
  assert.deepEqual(deriveTelemetryRuntimeStatus({}), { kind: 'ok' });
  assert.deepEqual(deriveTelemetryRuntimeStatus({ drifted: 'true' }), { kind: 'ok' });
  assert.deepEqual(deriveTelemetryRuntimeStatus({ drifted: 1 }), { kind: 'ok' });
  assert.deepEqual(deriveTelemetryRuntimeStatus({ drifted: null }), { kind: 'ok' });
});

test('the mapping is pure — same input always yields the same output', () => {
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(deriveTelemetryRuntimeStatus({ drifted: true }), { kind: 'schema-drift' });
    assert.deepEqual(deriveTelemetryRuntimeStatus({ drifted: false }), { kind: 'ok' });
  }
});

// ==========================================================================
// WARDEN-808 — the delivery-failing status (sustained non-415 delivery failure)
// ==========================================================================
// deriveTelemetryRuntimeStatus now maps a third payload field `deliveryFailing`
// into a third descriptor kind. These pin the new branch + the precedence rule
// (schema-drift wins over delivery-failing wins over ok). The ring→deliveryFailing
// DERIVATION (how the main process computes the boolean) is exercised end-to-end
// in telemetry-pipeline.test.mjs; here we pin only the renderer's pure mapping
// from the already-computed payload.

test('a deliveryFailing payload (drifted false) derives to the delivery-failing descriptor', () => {
  assert.deepEqual(
    deriveTelemetryRuntimeStatus({ drifted: false, deliveryFailing: true }),
    { kind: 'delivery-failing' },
  );
});

test('schema-drift takes precedence over delivery-failing when both hold (a 415 is also all-drops)', () => {
  // A 415 produces a run of drops too, so both flags can be true at once. The
  // schema mismatch is the more actionable, permanent condition, so it wins.
  assert.deepEqual(
    deriveTelemetryRuntimeStatus({ drifted: true, deliveryFailing: true }),
    { kind: 'schema-drift' },
  );
});

test('a payload with both flags false derives to ok', () => {
  assert.deepEqual(
    deriveTelemetryRuntimeStatus({ drifted: false, deliveryFailing: false }),
    { kind: 'ok' },
  );
});

test('a non-boolean deliveryFailing derives to ok (defensive — never a false alarm)', () => {
  // Only an UNAMBIGUOUS deliveryFailing:true surfaces the banner. A truthy but
  // non-boolean value, or a payload that omits the field, maps to ok.
  assert.deepEqual(deriveTelemetryRuntimeStatus({ drifted: false }), { kind: 'ok' });
  assert.deepEqual(
    deriveTelemetryRuntimeStatus({ drifted: false, deliveryFailing: 'true' }),
    { kind: 'ok' },
  );
  assert.deepEqual(
    deriveTelemetryRuntimeStatus({ drifted: false, deliveryFailing: 1 }),
    { kind: 'ok' },
  );
  assert.deepEqual(
    deriveTelemetryRuntimeStatus({ drifted: false, deliveryFailing: null }),
    { kind: 'ok' },
  );
});

console.log(`\n✓ TELEMETRY RUNTIME-STATUS TESTS PASS (${passed})`);
