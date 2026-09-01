// Tests for electron/telemetry-metrics-event.cjs (WARDEN-1258) — the
// main-process builder that turns the server child's 'telemetry-metrics' IPC
// snapshot into an `operational-metrics` schema event.
//
// Pinned here (main.cjs itself can't be required without Electron — the
// window-state.cjs / telemetry-source.cjs pattern):
//   • a REAL M1-aggregator window builds into an event the canonical schema
//     VALIDATES (loaded through vite's OXC transform, like the other schema
//     consumers in this suite family);
//   • a snapshot that is not shaped like an aggregator window yields null
//     (nothing recorded — the builder never fabricates fields);
//   • the non-identifying labels are attached only when supplied.
//
// Run: node --test telemetry-metrics-event.test.mjs   (from web/)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformWithOxc } from 'vite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const { buildOperationalMetricsEvent } = require('../electron/telemetry-metrics-event.cjs');
const { createMetricAggregator } = require('../src/telemetry-metrics.cjs');

// Load the CANONICAL schema through the same OXC transform the other web tests
// use, so "validates" means the real wire contract, not a restatement.
const schemaPath = join(__dirname, 'src', 'lib', 'telemetry', 'schema.ts');
const { code } = await transformWithOxc(readFileSync(schemaPath, 'utf8'), schemaPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-tme-'));
const tmpFile = join(tmpDir, 'schema.mjs');
writeFileSync(tmpFile, code);
const { SCHEMA_VERSION, validateEvent } = await import(tmpFile);
try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }

// A real aggregator window, folded exactly like src/fileExistsTelemetry.js.
function realSnapshot() {
  const agg = createMetricAggregator({ now: () => 1_000 });
  agg.record('file-exists-local', 1, { ok: true });
  agg.record('file-exists-local', 2, { ok: false });
  agg.record('file-exists-remote', 400, { ok: true });
  agg.record('file-exists-cache-hit', 0, { ok: true });
  return agg.flush();
}

const TS = 1_795_000_000_000;

test('a real aggregator window builds into a schema-valid event', () => {
  const event = buildOperationalMetricsEvent({
    snapshot: realSnapshot(),
    schemaVersion: SCHEMA_VERSION,
    appVersion: '0.1.50',
    platform: 'linux',
    now: () => TS,
  });
  assert.ok(event);
  assert.equal(event.type, 'operational-metrics');
  assert.equal(event.runtime, 'main');
  assert.equal(event.timestamp, TS);
  assert.equal(event.appVersion, '0.1.50');
  assert.equal(event.platform, 'linux');
  assert.equal(event.windowStartedAt, 1_000);
  assert.ok(Array.isArray(event.operations) && event.operations.length === 3);
  assert.equal(validateEvent(event), true, 'the built event passes the canonical wire validator');
});

test('labels are omitted when not supplied (they are optional per the schema)', () => {
  const event = buildOperationalMetricsEvent({
    snapshot: realSnapshot(),
    schemaVersion: SCHEMA_VERSION,
    now: () => TS,
  });
  assert.ok(event);
  assert.equal('appVersion' in event, false);
  assert.equal('platform' in event, false);
  assert.equal(validateEvent(event), true);
});

test('a snapshot that is not shaped like an aggregator window yields null', () => {
  for (const bad of [
    null, undefined, 'nope', 42,
    {}, // no fields at all
    { startedAt: 1, endedAt: 2 }, // missing arrays / rejected
    { startedAt: 'x', endedAt: 2, boundaries: [], operations: [], rejected: 0 },
    { startedAt: 1, endedAt: 2, boundaries: 'no', operations: [], rejected: 0 },
    { startedAt: 1, endedAt: 2, boundaries: [], operations: {}, rejected: 0 },
    { startedAt: 1, endedAt: 2, boundaries: [], operations: [], rejected: 'x' },
  ]) {
    assert.equal(buildOperationalMetricsEvent({ snapshot: bad, schemaVersion: SCHEMA_VERSION, now: () => TS }), null,
      `snapshot ${JSON.stringify(bad)} must not build`);
  }
});

test('the builder never fabricates: hostile operation names pass through only to be dropped by the validator', () => {
  // The builder is defensive about SHAPE, not about hostile CONTENT — the
  // pipeline's validator is the authority for that. Proving the division of
  // labor: a path-riding operation key builds an event, and the CANONICAL
  // validator rejects it.
  const snap = realSnapshot();
  snap.operations[0].operation = '/etc/passwd';
  const event = buildOperationalMetricsEvent({ snapshot: snap, schemaVersion: SCHEMA_VERSION, now: () => TS });
  assert.ok(event, 'shape-valid snapshot builds');
  assert.equal(validateEvent(event), false, 'the wire validator rejects the hostile key');
});
