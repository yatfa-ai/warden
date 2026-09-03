// Unit tests for the stall-journal summary (WARDEN-1280).
//
// electron/stall-summary.cjs reduces the raw ~/.yatfa-warden/stalls.jsonl records
// (written by src/loop-monitor.js's buildStallRecord) into the three facts the
// Help > "Stall Diagnostics…" dialog reports: how many stalls are retained, when
// the last one happened, and which labelled work was most often blocking the
// loop. main.cjs can't be exercised under `node --test` (it requires electron),
// so the reduction lives in an electron-free module — the window-state.cjs split
// — and is asserted here against the REAL record shape.
//
// Run: node stall-summary.test.mjs   (or: npm test, from web/)
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { summarizeStalls, formatStallSummary, formatAge } = require('../electron/stall-summary.cjs');

/** A record in the exact shape src/loop-monitor.js buildStallRecord writes. */
function stall({ timestamp, lagMs = 1200, attribution = [], syncTotals = [] }) {
  return {
    type: 'performance-stall',
    runtime: 'server',
    source: 'loop-monitor',
    timestamp,
    lagMs,
    heartbeatMs: 500,
    thresholdMs: 1000,
    attribution,
    syncTotals,
    pid: 4242,
  };
}

// ---------------------------------------------------------------------------
// The healthy case — no stalls — must read as health, not as a failed read.
// ---------------------------------------------------------------------------

test('an empty journal summarizes to zero and reads as healthy', () => {
  const summary = summarizeStalls([]);
  assert.deepEqual(summary, { count: 0, lastAt: null, topCulprit: null, worstLagMs: null });
  const text = formatStallSummary(summary);
  assert.match(text, /No stalls recorded/);
  // The healthy case must not read like an error opening the file.
  assert.doesNotMatch(text, /could not|fail|error/i);
});

test('a non-array input degrades to the empty summary instead of throwing', () => {
  for (const bad of [undefined, null, 0, 'nope', {}]) {
    assert.deepEqual(summarizeStalls(bad), { count: 0, lastAt: null, topCulprit: null, worstLagMs: null });
  }
});

// ---------------------------------------------------------------------------
// Counting, recency and worst-case.
// ---------------------------------------------------------------------------

test('counts every record and reports the NEWEST timestamp', () => {
  const summary = summarizeStalls([
    stall({ timestamp: '2026-09-01T10:00:00.000Z' }),
    stall({ timestamp: '2026-09-03T08:30:00.000Z' }),
    stall({ timestamp: '2026-08-28T22:00:00.000Z' }),
  ]);
  assert.equal(summary.count, 3);
  assert.equal(summary.lastAt, '2026-09-03T08:30:00.000Z');
});

test('recency does not depend on the file order (readStalls gives newest first, but a hand-edited file may not)', () => {
  const oldest = stall({ timestamp: '2026-01-01T00:00:00.000Z' });
  const newest = stall({ timestamp: '2026-06-01T00:00:00.000Z' });
  assert.equal(summarizeStalls([newest, oldest]).lastAt, '2026-06-01T00:00:00.000Z');
  assert.equal(summarizeStalls([oldest, newest]).lastAt, '2026-06-01T00:00:00.000Z');
});

test('reports the longest block seen across the retained records', () => {
  const summary = summarizeStalls([
    stall({ timestamp: '2026-09-01T10:00:00.000Z', lagMs: 1100 }),
    stall({ timestamp: '2026-09-01T11:00:00.000Z', lagMs: 8400.6 }),
    stall({ timestamp: '2026-09-01T12:00:00.000Z', lagMs: 2000 }),
  ]);
  assert.equal(summary.worstLagMs, 8401);
});

// ---------------------------------------------------------------------------
// The culprit — the fact that makes a duration actionable.
// ---------------------------------------------------------------------------

test('the top culprit is the label with the most blocking time, counted across BOTH evidence tracks', () => {
  const summary = summarizeStalls([
    stall({
      timestamp: '2026-09-01T10:00:00.000Z',
      // One long open operation…
      attribution: [{ label: 'GET /api/sessions', overlapMs: 900, open: false, durationMs: 900 }],
      // …plus a thousand cheap synchronous reads, which attribution alone
      // under-reports. Both must fold into the same ledger.
      syncTotals: [{ label: 'fs.statSync', calls: 4000, totalMs: 1500 }],
    }),
    stall({
      timestamp: '2026-09-01T10:05:00.000Z',
      syncTotals: [{ label: 'fs.statSync', calls: 3000, totalMs: 1200 }],
    }),
  ]);
  assert.equal(summary.topCulprit.label, 'fs.statSync');
  assert.equal(summary.topCulprit.totalMs, 2700);
  assert.equal(summary.topCulprit.stalls, 2, 'stalls counts distinct records naming the label');
});

test('a label named twice within ONE record counts as one stall for that record', () => {
  const summary = summarizeStalls([
    stall({
      timestamp: '2026-09-01T10:00:00.000Z',
      attribution: [{ label: 'git', overlapMs: 100 }],
      syncTotals: [{ label: 'git', calls: 2, totalMs: 400 }],
    }),
  ]);
  assert.equal(summary.topCulprit.stalls, 1);
  assert.equal(summary.topCulprit.totalMs, 500);
});

test('ties break deterministically (count, then alphabetically)', () => {
  const a = summarizeStalls([
    stall({ timestamp: '2026-09-01T10:00:00.000Z', syncTotals: [{ label: 'zeta', calls: 1, totalMs: 100 }, { label: 'alpha', calls: 1, totalMs: 100 }] }),
  ]);
  assert.equal(a.topCulprit.label, 'alpha');
});

test('stalls with no instrumented work report no culprit rather than a fabricated one', () => {
  const summary = summarizeStalls([stall({ timestamp: '2026-09-01T10:00:00.000Z' })]);
  assert.equal(summary.count, 1);
  assert.equal(summary.topCulprit, null);
  assert.match(formatStallSummary(summary), /nothing instrumented was running/);
});

// ---------------------------------------------------------------------------
// Untrusted input — the journal is an append-only file on the owner's disk.
// ---------------------------------------------------------------------------

test('malformed records and fields are skipped, never thrown on', () => {
  const summary = summarizeStalls([
    null,
    'a string',
    42,
    { timestamp: 'not-a-date', lagMs: 'huge', attribution: 'nope', syncTotals: null },
    { timestamp: '2026-09-02T00:00:00.000Z', attribution: [null, { label: '' }, { overlapMs: 5 }, { label: 'ok', overlapMs: 'x' }] },
  ]);
  // The three non-object entries are skipped; the two object records count.
  assert.equal(summary.count, 2);
  assert.equal(summary.lastAt, '2026-09-02T00:00:00.000Z');
  assert.equal(summary.worstLagMs, null, 'a non-numeric lagMs contributes nothing');
  // The one usable label survives with a zero contribution rather than NaN.
  assert.equal(summary.topCulprit.label, 'ok');
  assert.equal(summary.topCulprit.totalMs, 0);
});

test('a negative or non-finite duration cannot poison the ledger', () => {
  const summary = summarizeStalls([
    stall({ timestamp: '2026-09-01T10:00:00.000Z', syncTotals: [{ label: 'weird', calls: 1, totalMs: -5000 }] }),
    stall({ timestamp: '2026-09-01T10:01:00.000Z', syncTotals: [{ label: 'weird', calls: 1, totalMs: Number.NaN }] }),
    stall({ timestamp: '2026-09-01T10:02:00.000Z', syncTotals: [{ label: 'weird', calls: 1, totalMs: 300 }] }),
  ]);
  assert.equal(summary.topCulprit.totalMs, 300);
});

test('an epoch-number timestamp is accepted alongside the ISO form', () => {
  const ms = Date.UTC(2026, 4, 5, 6, 7, 8);
  assert.equal(summarizeStalls([{ timestamp: ms }]).lastAt, new Date(ms).toISOString());
});

// ---------------------------------------------------------------------------
// The rendered dialog body — the exact sentences the owner reads.
// ---------------------------------------------------------------------------

test('the dialog body names the count, the last stall, the worst block and the culprit', () => {
  const now = Date.UTC(2026, 8, 3, 12, 0, 0);
  const summary = summarizeStalls([
    stall({
      timestamp: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
      lagMs: 2400,
      syncTotals: [{ label: 'fs.readFileSync', calls: 900, totalMs: 2100 }],
    }),
  ]);
  const text = formatStallSummary(summary, { logFile: '/home/me/.yatfa-warden/stalls.jsonl', now });
  assert.match(text, /1 stall recorded/);
  assert.match(text, /Last stall: .*\(3h ago\)/);
  assert.match(text, /Longest block: 2400ms/);
  assert.match(text, /Top culprit: fs\.readFileSync \(2100ms across 1 stall\)/);
  assert.match(text, /Journal: \/home\/me\/\.yatfa-warden\/stalls\.jsonl/);
});

test('the dialog body pluralizes on the count', () => {
  const two = summarizeStalls([
    stall({ timestamp: '2026-09-01T10:00:00.000Z' }),
    stall({ timestamp: '2026-09-01T11:00:00.000Z' }),
  ]);
  assert.match(formatStallSummary(two), /2 stalls recorded/);
});

test('the journal path is omitted when not supplied and the body still renders', () => {
  const text = formatStallSummary(summarizeStalls([stall({ timestamp: '2026-09-01T10:00:00.000Z' })]));
  assert.doesNotMatch(text, /Journal:/);
  assert.match(text, /1 stall recorded/);
});

test('formatStallSummary tolerates a malformed summary object', () => {
  for (const bad of [undefined, null, 'x', 7]) {
    assert.match(formatStallSummary(bad), /No stalls recorded/);
  }
});

test('formatAge is coarse and monotone', () => {
  assert.equal(formatAge(30 * 1000), 'less than a minute');
  assert.equal(formatAge(5 * 60 * 1000), '5m');
  assert.equal(formatAge(59 * 60 * 1000), '59m');
  assert.equal(formatAge(2 * 60 * 60 * 1000), '2h');
  assert.equal(formatAge(50 * 60 * 60 * 1000), '2d');
  assert.equal(formatAge(-1), null);
  assert.equal(formatAge('x'), null);
});
