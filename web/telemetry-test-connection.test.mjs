// UI-layer tests for the "Test connection" probe display mapping (WARDEN-595).
// describeTelemetryTestVerdict is the PURE seam that turns a backend verdict into
// the { tone, label } the Settings page renders — split out so the four states are
// verifiable without a browser (the worker sandbox cannot drive the renderer; CDP
// SIGTRAPs). Loads the REAL web/src/lib/telemetry/testConnection.ts, transpiled
// TS -> ESM via Vite's OXC transform (same harness as telemetry-schema.test.mjs).
// The module has only `import type` (erased), so it loads standalone.
//
// Run: node telemetry-test-connection.test.mjs   (from web/)

import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modPath = resolve(__dirname, 'src/lib/telemetry/testConnection.ts');

// --- Load the REAL testConnection.ts (TS -> ESM via the OXC transform Vite uses) ---
const src = readFileSync(modPath, 'utf8');
const { code } = await transformWithOxc(src, modPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-tel-test-conn-'));
const tmpFile = join(tmpDir, 'testConnection.mjs');
writeFileSync(tmpFile, code);
const { describeTelemetryTestVerdict } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// --- The four states: each maps to a DISTINCT label, and tone tracks `ok` ---

test('connected → positive tone, "Connected" label (the one affirmative state)', () => {
  const d = describeTelemetryTestVerdict({
    kind: 'connected',
    ok: true,
    message: 'Connected — receiver is reachable and schema-matched (no auth required).',
  });
  assert.equal(d.tone, 'positive');
  assert.equal(d.label, 'Connected');
});

test('schema-drift → warning tone, "Schema mismatch" label', () => {
  const d = describeTelemetryTestVerdict({
    kind: 'schema-drift',
    ok: false,
    message: 'Schema version mismatch: your client speaks v1, the receiver speaks v2.',
  });
  assert.equal(d.tone, 'warning');
  assert.equal(d.label, 'Schema mismatch');
});

test('auth-required → warning tone, "Auth required" label', () => {
  const d = describeTelemetryTestVerdict({
    kind: 'auth-required',
    ok: false,
    message: 'The receiver requires an auth token.',
  });
  assert.equal(d.tone, 'warning');
  assert.equal(d.label, 'Auth required');
});

test('no-receiver → warning tone, "No receiver" label', () => {
  const d = describeTelemetryTestVerdict({
    kind: 'no-receiver',
    ok: false,
    message: 'No warden-telemetry receiver responded at this URL.',
  });
  assert.equal(d.tone, 'warning');
  assert.equal(d.label, 'No receiver');
});

// --- Tone integrity: never show a "positive" tone for a non-ok verdict ---

test('every non-ok kind is a warning — a green tone is reserved for connected only', () => {
  for (const kind of ['schema-drift', 'auth-required', 'no-receiver']) {
    const d = describeTelemetryTestVerdict({ kind, ok: false, message: 'm' });
    assert.equal(d.tone, 'warning', `${kind} must not read as success`);
  }
});

test('a connected verdict with ok:false is still a warning (defensive — never green for not-ok)', () => {
  // Shouldn't happen (the backend sets ok:true only with connected), but the UI must
  // never paint a success tone for anything that is not unambiguously ok.
  const d = describeTelemetryTestVerdict({ kind: 'connected', ok: false, message: 'm' });
  assert.equal(d.tone, 'warning');
});

// --- Distinctness: the four labels are all different (legible at a glance) ---

test('the four labels are pairwise distinct (each state is legible at a glance)', () => {
  const labels = new Set(
    ['connected', 'schema-drift', 'auth-required', 'no-receiver'].map((kind) =>
      describeTelemetryTestVerdict({ kind, ok: kind === 'connected', message: 'm' }).label
    )
  );
  assert.equal(labels.size, 4, 'four distinct labels for four states');
});

// --- Defensive: an unrecognized kind never throws in the renderer ---

test('an unrecognized kind falls back to a neutral warning (never throws)', () => {
  const d = describeTelemetryTestVerdict({ kind: 'something-unexpected', ok: false, message: 'm' });
  assert.equal(d.tone, 'warning');
  assert.equal(typeof d.label, 'string');
  assert.ok(d.label.length > 0);
});

console.log(`\n# tests ${passed}`);
console.log('# pass 0'.replace('0', passed)); // mirror node --test summary shape
console.log('# fail 0');
