// Renderer-side graceful-degradation tests for the transmission-log accessor
// (WARDEN-668 — verifiability's third leg). web/src/lib/electron.ts exposes
// getTelemetryTransmissionLog(), which the Settings verifiability panel calls on
// mount + a refresh interval. This is the seam that determines the panel's three
// render states: a non-Electron host (browser/dev/smoke) has no
// window.wardenTelemetry, and the ring may also be empty or a throwing bridge
// may misbehave — all three MUST collapse to [] so the panel renders its honest
// "no sends this session yet" empty state rather than crashing.
//
// There is no front-end test runner here, so (like storage.test.mjs /
// layout.test.mjs) this loads the REAL electron.ts (transpiled TS → ESM via
// Vite's OXC transform). electron.ts has NO value imports (only type
// declarations), so it transpiles standalone with no bare-specifier rewrite.
//
// Run: node telemetry-transmission-bridge.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const electronPath = resolve(__dirname, 'src/lib/electron.ts');

// electron.ts reads `window.wardenTelemetry` at call time. Node has no window,
// so alias it to globalThis BEFORE the accessor runs (the module's top level
// never touches window, so the import itself is safe; only the call needs it).
globalThis.window = globalThis;

// --- Load the REAL electron.ts (TS -> ESM via the OXC transform Vite bundles) -
const electronSrc = readFileSync(electronPath, 'utf8');
const { code } = await transformWithOxc(electronSrc, electronPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-tlm-bridge-test-'));
const tmpFile = join(tmpDir, 'electron.mjs');
writeFileSync(tmpFile, code);
const { getTelemetryTransmissionLog } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed += 1;
  console.log('  ok -', name);
};

const fresh = () => {
  // Reset the bridge between tests so each case is isolated.
  delete globalThis.wardenTelemetry;
};

// ==========================================================================
// State (c): bridge ABSENT (browser / `npm run dev` / `node web/smoke.cjs`)
// ==========================================================================

await test('bridge absent → [] (the panel renders its honest empty state, no crash)', async () => {
  fresh();
  const out = await getTelemetryTransmissionLog();
  assert.deepEqual(out, [], 'no window.wardenTelemetry ⇒ []');
  assert.ok(Array.isArray(out), 'always an array (the panel never has to branch on undefined)');
});

// ==========================================================================
// State (b): bridge present but the ring is empty (telemetry off / no sends yet)
// ==========================================================================

await test('bridge present + empty ring → [] (telemetry off surfaces as "no sends")', async () => {
  fresh();
  globalThis.wardenTelemetry = { getTransmissionLog: async () => [] };
  const out = await getTelemetryTransmissionLog();
  assert.deepEqual(out, []);
});

// ==========================================================================
// State (a): bridge present + real entries → the snapshot flows through unchanged
// ==========================================================================

await test('bridge present + entries → the metadata-only entries flow through to the panel', async () => {
  fresh();
  const entries = [
    { timestamp: 1, endpointHost: 'telemetry.example.invalid', schemaVersion: 1, eventCount: 3, outcome: 'ok', attempts: 1, status: 200 },
    { timestamp: 2, endpointHost: null, schemaVersion: null, eventCount: 1, outcome: 'dropped', attempts: 3, status: 503 },
  ];
  globalThis.wardenTelemetry = { getTransmissionLog: async () => entries };
  const out = await getTelemetryTransmissionLog();
  assert.deepEqual(out, entries, 'the snapshot is passed through verbatim — no re-shaping');
  assert.equal(out.length, 2);
});

// ==========================================================================
// Defensive: a throwing or malformed bridge never rejects + never crashes
// ==========================================================================

await test('a THROWING bridge degrades to [] (never rejects into the panel)', async () => {
  fresh();
  globalThis.wardenTelemetry = {
    getTransmissionLog: async () => { throw new Error('IPC exploded'); },
  };
  const out = await getTelemetryTransmissionLog();
  assert.deepEqual(out, [], 'the throw was caught and [] returned');
});

await test('a NON-ARRAY resolution degrades to [] (a malformed main response cannot crash the panel)', async () => {
  fresh();
  for (const malformed of [null, undefined, {}, { outcome: 'ok' }, 'not-an-array', 42]) {
    globalThis.wardenTelemetry = { getTransmissionLog: async () => malformed };
    // eslint-disable-next-line no-await-in-loop
    const out = await getTelemetryTransmissionLog();
    assert.deepEqual(out, [], `${JSON.stringify(malformed)} ⇒ [] (Array.isArray gate)`);
  }
});

await test('getTransmissionLog missing on the bridge object degrades to [] (never a TypeError)', async () => {
  // A bridge that predates WARDEN-668 (older preload) exposes no getTransmissionLog.
  fresh();
  globalThis.wardenTelemetry = { getRuntimeStatus: async () => ({ drifted: false }) };
  // The accessor calls b.getTransmissionLog(); if undefined it throws a TypeError,
  // which the catch must swallow → [].
  const out = await getTelemetryTransmissionLog();
  assert.deepEqual(out, [], 'a bridge without getTransmissionLog ⇒ [] (no TypeError escapes)');
});

console.log(`\n✓ TELEMETRY TRANSMISSION-BRIDGE TESTS PASS (${passed})`);
