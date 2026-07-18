// Pure display-logic tests for the transmission-log panel (WARDEN-668 — the
// verifiability third leg). web/src/lib/telemetry/transmission-display.ts maps a
// ring entry → the row descriptor the panel renders, plus the section-header
// tally. The null-handling is the load-bearing part: an entry crosses the
// Electron contextBridge clone, so a malformed entry must degrade to a
// placeholder (—) / 'Unknown', never a render throw that blanks the whole panel.
//
// This repo has no React/RTL runner and browser QA is sandbox-blocked
// (WARDEN-130/WARDEN-68), so the panel's render behavior is verified at the
// pure-seam level: drive every entry shape — including the nulls the CJS module
// can legitimately produce (status null on a network error, host null on a bad
// URL, outcome null on a malformed transport result) — and assert the row the
// JSX would consume. Layout/visual claims are deferred to the reviewer sandbox.
//
// Loads the REAL transmission-display.ts (transpiled TS → ESM via Vite's OXC
// transform). The module imports only `import type { TransmissionLogEntry }`,
// which transpile strips — so it transpiles standalone with no rewrite (see
// web/storage.test.mjs for the bare-specifier precedent).
//
// Run: node telemetry-transmission-display.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const displayPath = resolve(__dirname, 'src/lib/telemetry/transmission-display.ts');

// --- Load the REAL transmission-display.ts (TS -> ESM via OXC) ---------------
const displaySrc = readFileSync(displayPath, 'utf8');
const { code } = await transformWithOxc(displaySrc, displayPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-tlm-display-test-'));
const tmpFile = join(tmpDir, 'transmission-display.mjs');
writeFileSync(tmpFile, code);
const {
  describeTransmissionEntry,
  summarizeTransmission,
  TRANSMISSION_DASH,
} = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

const OK = { timestamp: 1000, endpointHost: 'telemetry.example.invalid', schemaVersion: 1, eventCount: 3, outcome: 'ok', attempts: 1, status: 200 };

// ==========================================================================
// describeTransmissionEntry — a well-formed entry maps to its row
// ==========================================================================

test('a delivered entry maps to Delivered / ok tone with its status + host', () => {
  const d = describeTransmissionEntry(OK);
  assert.equal(d.outcomeLabel, 'Delivered');
  assert.equal(d.outcomeTone, 'ok');
  assert.equal(d.statusLabel, '200');
  assert.equal(d.hostLabel, 'telemetry.example.invalid');
  assert.equal(d.attempts, 1);
  assert.equal(d.eventCount, 3);
  assert.equal(d.timestamp, 1000);
});

test('a dropped entry maps to Dropped / dropped tone', () => {
  const d = describeTransmissionEntry({ ...OK, outcome: 'dropped', attempts: 3, status: 503 });
  assert.equal(d.outcomeLabel, 'Dropped');
  assert.equal(d.outcomeTone, 'dropped');
  assert.equal(d.statusLabel, '503');
  assert.equal(d.attempts, 3);
});

// ==========================================================================
// Null handling — the load-bearing part (a malformed entry never crashes)
// ==========================================================================

test('a network-error entry (status null) renders HTTP DASH — never blank, never a throw', () => {
  const d = describeTransmissionEntry({ ...OK, status: null, outcome: 'dropped' });
  assert.equal(d.statusLabel, TRANSMISSION_DASH, 'null status → — (not "null", not empty)');
});

test('an entry with a malformed endpoint (host null) renders host DASH', () => {
  const d = describeTransmissionEntry({ ...OK, endpointHost: null });
  assert.equal(d.hostLabel, TRANSMISSION_DASH);
});

test('an empty-string host renders DASH (an empty column would read as a failed load)', () => {
  const d = describeTransmissionEntry({ ...OK, endpointHost: '' });
  assert.equal(d.hostLabel, TRANSMISSION_DASH);
});

test('a null outcome maps to Unknown / unknown tone (a malformed transport result does not crash)', () => {
  const d = describeTransmissionEntry({ ...OK, outcome: null });
  assert.equal(d.outcomeLabel, 'Unknown');
  assert.equal(d.outcomeTone, 'unknown');
});

test('an unrecognized outcome string also maps to Unknown (forward-compatible with future outcomes)', () => {
  const d = describeTransmissionEntry({ ...OK, outcome: 'pending' });
  assert.equal(d.outcomeLabel, 'Unknown');
  assert.equal(d.outcomeTone, 'unknown');
});

test('a maximally-malformed entry (every field null/missing) degrades to a still-renderable row', () => {
  // If the bridge ever hands the panel a degenerate entry, the WHOLE panel must
  // not crash — this row degrades to Unknown + DASH + 0s.
  const d = describeTransmissionEntry({ timestamp: null, endpointHost: null, schemaVersion: null, eventCount: null, outcome: null, attempts: null, status: null });
  assert.equal(d.outcomeLabel, 'Unknown');
  assert.equal(d.outcomeTone, 'unknown');
  assert.equal(d.statusLabel, TRANSMISSION_DASH);
  assert.equal(d.hostLabel, TRANSMISSION_DASH);
  assert.equal(d.eventCount, 0);
  assert.equal(d.attempts, 0);
  assert.equal(d.timestamp, 0);
});

test('a null/undefined entry argument degrades to a renderable row (never throws)', () => {
  for (const bad of [null, undefined]) {
    assert.doesNotThrow(() => {
      const d = describeTransmissionEntry(bad);
      assert.equal(d.outcomeLabel, 'Unknown');
      assert.equal(d.hostLabel, TRANSMISSION_DASH);
      assert.equal(d.statusLabel, TRANSMISSION_DASH);
    });
  }
});

test('non-finite numeric fields coerce to their safe fallbacks', () => {
  // status NaN / attempts NaN must not surface as "NaN" text in the row.
  const d = describeTransmissionEntry({ ...OK, status: NaN, attempts: NaN, eventCount: NaN, timestamp: Infinity });
  assert.equal(d.statusLabel, TRANSMISSION_DASH, 'NaN status → — (not "NaN")');
  assert.equal(d.attempts, 0, 'NaN attempts → 0');
  assert.equal(d.eventCount, 0, 'NaN eventCount → 0');
  assert.equal(d.timestamp, 0, 'non-finite timestamp → 0');
});

// ==========================================================================
// summarizeTransmission — the section-header tally
// ==========================================================================

test('summarize tallies delivered + dropped + total across a mixed ring', () => {
  const entries = [
    { ...OK, outcome: 'ok' },
    { ...OK, outcome: 'dropped' },
    { ...OK, outcome: 'ok' },
    { ...OK, outcome: null }, // unknown counts toward neither bucket
  ];
  const s = summarizeTransmission(entries);
  assert.equal(s.total, 4);
  assert.equal(s.delivered, 2);
  assert.equal(s.dropped, 1);
});

test('an empty ring summarizes to all-zero (the header hides when total is 0)', () => {
  const s = summarizeTransmission([]);
  assert.deepEqual(s, { total: 0, delivered: 0, dropped: 0 });
});

test('summarize ignores null/malformed entries in the buckets but still counts them in total', () => {
  const entries = [null, undefined, { ...OK, outcome: 'ok' }];
  const s = summarizeTransmission(entries);
  assert.equal(s.total, 3, 'malformed entries are still entries the panel would render');
  assert.equal(s.delivered, 1);
  assert.equal(s.dropped, 0);
});

console.log(`\n✓ TELEMETRY TRANSMISSION-DISPLAY TESTS PASS (${passed})`);
