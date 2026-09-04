// Tests for electron/telemetry-stall-event.cjs (WARDEN-1278) — the main-process
// builder that turns the server child's 'telemetry-stalls' IPC snapshot into a
// `server-stall` schema event.
//
// Pinned here (main.cjs itself can't be required without Electron — the
// window-state.cjs / telemetry-metrics-event.cjs pattern):
//   • a REAL stall-aggregator window builds into an event the canonical schema
//     VALIDATES (loaded through vite's OXC transform, like the other schema
//     consumers in this suite family) — the END-TO-END proof that the producer's
//     snapshot shape and the wire contract agree;
//   • the event's `runtime` is `server` and nothing else, because the whole
//     point of the v6 bump is that the BACKEND child is the process that froze;
//   • a snapshot that is not shaped like an aggregator window yields null
//     (nothing recorded — the builder never fabricates fields);
//   • the non-identifying labels are attached only when supplied.
//
// Run: node --test telemetry-stall-event.test.mjs   (from web/)

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

const { buildServerStallEvent } = require('../electron/telemetry-stall-event.cjs');
const { createStallAggregator } = require('../src/telemetry-stalls.cjs');

// Load the CANONICAL schema through the same OXC transform the other web tests
// use, so "validates" means the real wire contract, not a restatement.
const schemaPath = join(__dirname, 'src', 'lib', 'telemetry', 'schema.ts');
const { code } = await transformWithOxc(readFileSync(schemaPath, 'utf8'), schemaPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-tse-'));
const tmpFile = join(tmpDir, 'schema.mjs');
writeFileSync(tmpFile, code);
const { SCHEMA_VERSION, validateEvent } = await import(tmpFile);
try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }

// The REAL main-process validator too, so the two copies are proven to agree on
// this type rather than assumed to.
const { validateBaseEvent } = require('../electron/telemetry-source.cjs');

const stallRecord = (lagMs, attribution = [], syncTotals = []) => ({
  type: 'performance-stall',
  runtime: 'server',
  source: 'event-loop',
  timestamp: new Date(0).toISOString(),
  lagMs,
  heartbeatMs: 1000,
  thresholdMs: 1000,
  attribution,
  syncTotals,
});

// A window from the REAL aggregator, folded from realistic stall records.
function realWindow() {
  let t = 1735689300000;
  const agg = createStallAggregator({ now: () => t });
  agg.record(stallRecord(1500, [{ label: 'GET /api/claude-sessions', overlapMs: 1400 }]));
  agg.record(stallRecord(3200, [{ label: 'GET /api/claude-sessions', overlapMs: 3100 }],
    [{ label: 'fs.readFileSync', calls: 812, totalMs: 3000 }]));
  agg.record(stallRecord(9800, [{ label: 'sweep:budget', overlapMs: 9700 }]));
  t = 1735689600000;
  return agg.flush();
}

// ==========================================================================
// The end-to-end proof: producer window → built event → canonical validator
// ==========================================================================

test('a REAL aggregator window builds an event the CANONICAL schema validates', () => {
  const event = buildServerStallEvent({ snapshot: realWindow(), schemaVersion: SCHEMA_VERSION });
  assert.ok(event, 'a well-shaped window builds');
  assert.equal(validateEvent(event), true, 'the canonical wire contract accepts it');
  assert.equal(validateBaseEvent(event), true, 'and the main-process validator agrees');
});

test('the built event is ONE aggregate carrying the window, not one row per stall', () => {
  const event = buildServerStallEvent({ snapshot: realWindow(), schemaVersion: SCHEMA_VERSION });
  assert.equal(event.type, 'server-stall');
  assert.equal(event.count, 3, 'three stalls folded into ONE event');
  assert.equal(event.totalMs, 14500);
  assert.equal(event.maxMs, 9800, 'the headline freeze duration survives the fold');
  assert.equal(event.windowStartedAt, 1735689300000);
  assert.equal(event.windowEndedAt, 1735689600000);
  assert.equal(event.buckets.length, event.boundaries.length + 1);
  assert.equal(event.buckets.reduce((a, b) => a + b, 0), event.count);
  assert.ok(event.culprits.length > 0, 'and the attribution survives it too');
});

test("the event's runtime is `server` — the process that actually froze", () => {
  // Stamping `main` here would be a lie about which process froze, and it is
  // exactly the lie the new runtime was added to end. The schema pins it, so a
  // regression fails validation rather than shipping a mislabelled event.
  const event = buildServerStallEvent({ snapshot: realWindow(), schemaVersion: SCHEMA_VERSION });
  assert.equal(event.runtime, 'server');
  assert.equal(validateEvent({ ...event, runtime: 'main' }), false, 'a main-labelled server-stall is invalid');
});

test('every culprit key on the built event is a closed-set kebab literal', () => {
  const event = buildServerStallEvent({ snapshot: realWindow(), schemaVersion: SCHEMA_VERSION });
  for (const c of event.culprits) {
    assert.match(c.culprit, /^[a-z0-9][a-z0-9-]{0,63}$/, `${c.culprit} is wire-safe`);
    assert.ok(!c.culprit.includes('/'), 'no path separator');
    assert.ok(!c.culprit.includes('.'), 'no dotted hostname');
  }
});

test('the built event carries NO free-text field anywhere in its shape', () => {
  const event = buildServerStallEvent({
    snapshot: realWindow(), schemaVersion: SCHEMA_VERSION, appVersion: '0.1.50', platform: 'linux',
  });
  const allowed = new Set(['server-stall', 'server', '0.1.50', 'linux']);
  const strings = [];
  const walk = (v) => {
    if (typeof v === 'string') { strings.push(v); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(event);
  for (const s of strings) {
    assert.ok(allowed.has(s) || /^[a-z0-9][a-z0-9-]{0,63}$/.test(s), `unexpected string on the wire: ${JSON.stringify(s)}`);
  }
});

// ==========================================================================
// Defensiveness — null on a shape that is not an aggregator window
// ==========================================================================

test('a snapshot that is not an aggregator window yields NULL (nothing recorded)', () => {
  for (const bad of [
    undefined, null, 42, 'window', [],
    {},
    { startedAt: 1, endedAt: 2 }, // missing totals + arrays
    { startedAt: 'soon', endedAt: 2, count: 0, totalMs: 0, maxMs: 0, boundaries: [1], buckets: [0, 0], culprits: [] },
    { startedAt: 1, endedAt: 2, count: NaN, totalMs: 0, maxMs: 0, boundaries: [1], buckets: [0, 0], culprits: [] },
    { startedAt: 1, endedAt: 2, count: 0, totalMs: 0, maxMs: 0, boundaries: 'nope', buckets: [0, 0], culprits: [] },
    { startedAt: 1, endedAt: 2, count: 0, totalMs: 0, maxMs: 0, boundaries: [1], buckets: 'nope', culprits: [] },
    { startedAt: 1, endedAt: 2, count: 0, totalMs: 0, maxMs: 0, boundaries: [1], buckets: [0, 0], culprits: 'nope' },
  ]) {
    assert.equal(
      buildServerStallEvent({ snapshot: bad, schemaVersion: SCHEMA_VERSION }),
      null,
      `snapshot ${JSON.stringify(bad)} must build nothing`,
    );
  }
});

test('the builder is NOT the last line of defense — a hostile window still fails validation', () => {
  // The builder is defensive, but the pipeline's redact → validate stages remain
  // authoritative. A structurally-plausible window carrying a hostile culprit key
  // builds (the builder does not re-implement the validator) and is then DROPPED
  // pre-send by the schema check.
  const hostile = {
    startedAt: 1, endedAt: 2, count: 1, totalMs: 1, maxMs: 1,
    boundaries: [1000], buckets: [1, 0],
    culprits: [{ culprit: '/home/alice/.ssh/id_rsa', count: 1, totalOverlapMs: 1 }],
  };
  const event = buildServerStallEvent({ snapshot: hostile, schemaVersion: SCHEMA_VERSION });
  assert.ok(event, 'the builder does not itself reject it');
  assert.equal(validateEvent(event), false, 'but the wire contract does');
  assert.equal(validateBaseEvent(event), false, 'on both validators');
});

// ==========================================================================
// The non-identifying labels
// ==========================================================================

test('appVersion / platform are attached only when supplied', () => {
  const snapshot = realWindow();
  const bare = buildServerStallEvent({ snapshot, schemaVersion: SCHEMA_VERSION });
  assert.equal('appVersion' in bare, false, 'omitted, not stamped empty');
  assert.equal('platform' in bare, false);
  assert.equal(validateEvent(bare), true, 'and an event without them still validates');

  const labelled = buildServerStallEvent({
    snapshot, schemaVersion: SCHEMA_VERSION, appVersion: '0.1.50', platform: 'darwin',
  });
  assert.equal(labelled.appVersion, '0.1.50');
  assert.equal(labelled.platform, 'darwin');

  // A non-string / empty label is not stamped at all rather than coerced.
  for (const bad of [42, '', null, {}]) {
    const e = buildServerStallEvent({ snapshot, schemaVersion: SCHEMA_VERSION, appVersion: bad, platform: bad });
    assert.equal('appVersion' in e, false, `appVersion ${JSON.stringify(bad)} is omitted`);
    assert.equal('platform' in e, false, `platform ${JSON.stringify(bad)} is omitted`);
  }
});

test('the timestamp comes from the injected clock', () => {
  const event = buildServerStallEvent({
    snapshot: realWindow(), schemaVersion: SCHEMA_VERSION, now: () => 424242,
  });
  assert.equal(event.timestamp, 424242);
});

test('a WRONG schemaVersion builds but does not validate (the version is threaded, not assumed)', () => {
  const event = buildServerStallEvent({ snapshot: realWindow(), schemaVersion: 5 });
  assert.equal(event.schemaVersion, 5);
  assert.equal(validateEvent(event), false, 'the canonical validator pins the version');
});
