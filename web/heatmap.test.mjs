// Tests for the pure fleet-activity heatmap join (WARDEN-532): selectHeatmapCells
// + cellIntensity / cellHasError / bucketLabelIndices / rowAriaLabel /
// matrixAriaLabel (web/src/lib/heatmap.ts).
//
// No front-end test runner in this repo, so (like agentSparkline.test.mjs) this
// loads the REAL src/lib/heatmap.ts (transpiled TS -> ESM via Vite's OXC
// transform) and exercises it with plain objects. The `import type` in that file
// is erased at transpile time, so the emitted module is import-free and loads
// standalone.
//
// The case this file exists to lock down is selectHeatmapCells's THIRD branch +
// the shared-axis normalization: a container that is alive but had ZERO events
// in the window must yield a zero-filled row (→ the renderer draws a flat dim
// stripe), NOT be dropped; and every cell's intensity MUST be normalized against
// the FLEET-WIDE max so cross-agent patterns stay comparable (a vertical quiet
// stripe reads because a low-volume agent and a high-volume agent share one
// scale). The idle-container + fleet-normalization assertions below fail the
// moment either regresses.
//
// Run: node heatmap.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const helperPath = resolve(__dirname, 'src/lib/heatmap.ts');

// --- Load the REAL heatmap.ts (TS -> ESM via the OXC transform Vite bundles) ----
const src = readFileSync(helperPath, 'utf8');
const { code } = await transformWithOxc(src, helperPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-heatmap-test-'));
const tmpFile = join(tmpDir, 'heatmap.mjs');
writeFileSync(tmpFile, code);
const {
  selectHeatmapCells,
  cellIntensity,
  cellHasError,
  bucketLabelIndices,
  rowAriaLabel,
  matrixAriaLabel,
} = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// Builders so each case reads as "which agent / which series" not a wall of literals.
// `series` mirrors the wire ActivitySeries shape: parallel total/error arrays per
// container, plus the epoch-aligned bucket grid.
const bucket = (n, start) => Array.from({ length: n }, (_, i) => start + i); // epoch grid
const series = (entries, n = 5) => ({
  bucketMs: 3_600_000,
  buckets: bucket(n, 0),
  series: entries,
});
const activityEntry = (total, error) => ({ total, error: error ?? total.map(() => 0) });
const agent = (container) => ({ container });

console.log('\nselectHeatmapCells — null / empty series -> empty matrix (graceful, no crash)');
test('null series -> empty rows, empty buckets, max 0', () => {
  const m = selectHeatmapCells(null, [agent('c1')]);
  assert.equal(m.rows.length, 0);
  assert.deepEqual(m.buckets, []);
  assert.equal(m.max, 0);
});
test('series with zero buckets -> empty matrix', () => {
  const m = selectHeatmapCells({ bucketMs: 3_600_000, buckets: [], series: {} }, [agent('c1')]);
  assert.equal(m.rows.length, 0);
});
test('empty agents list -> empty rows but buckets preserved (axis known, no rows)', () => {
  const m = selectHeatmapCells(series({ c1: activityEntry([0, 1, 0, 0, 0]) }), []);
  assert.equal(m.rows.length, 0);
  assert.equal(m.buckets.length, 5);
});

console.log('\ncase 1 — no container -> no row (manual/tmux chats carry no activity data)');
test('container null/undefined/empty all filtered out, container agents kept', () => {
  const m = selectHeatmapCells(
    series({ c1: activityEntry([0, 1, 0, 0, 0]) }),
    [agent(null), agent(undefined), agent(''), agent('c1')],
  );
  assert.deepEqual(m.rows.map((r) => r.agent.container), ['c1']);
});

console.log('\ncase 2 — container with events -> real per-bucket cells + fleet-normalized intensity');
test('active agent -> one cell per bucket, totals/errors copied through', () => {
  const m = selectHeatmapCells(
    series({ c1: activityEntry([0, 2, 0, 3, 0], [0, 1, 0, 0, 0]) }),
    [agent('c1')],
  );
  assert.equal(m.rows.length, 1);
  const cells = m.rows[0].cells;
  assert.deepEqual(cells.map((c) => c.total), [0, 2, 0, 3, 0]);
  assert.deepEqual(cells.map((c) => c.error), [0, 1, 0, 0, 0]);
  assert.equal(cells.length, 5);
});
test('max is the FLEET-WIDE max across every cell (the intensity denominator)', () => {
  // c1 peaks at 4 in bucket 1; c2 peaks at 8 in bucket 3 -> fleet max 8.
  const m = selectHeatmapCells(
    series({
      c1: activityEntry([0, 4, 0, 0, 0]),
      c2: activityEntry([0, 0, 0, 8, 0]),
    }),
    [agent('c1'), agent('c2')],
  );
  assert.equal(m.max, 8);
});
test('intensity normalized against the fleet max — a quiet agent is NOT rescaled to its own peak', () => {
  // c1's peak is 4 but the fleet max is 8, so its peak intensity is 0.5 — NOT 1.
  // This is what makes a vertical quiet stripe readable: both rows share one scale.
  const m = selectHeatmapCells(
    series({
      c1: activityEntry([0, 4, 0, 0, 0]),
      c2: activityEntry([0, 0, 0, 8, 0]),
    }),
    [agent('c1'), agent('c2')],
  );
  const c1 = m.rows[0].cells;
  assert.equal(c1[1].intensity, 0.5); // 4 / 8
  assert.equal(c1[0].intensity, 0);   // 0 / 8 (idle bucket)
  const c2 = m.rows[1].cells;
  assert.equal(c2[3].intensity, 1);   // 8 / 8 (the fleet peak)
});
test('row order follows the agents list (alignment with the per-row sparklines)', () => {
  const m = selectHeatmapCells(
    series({ c1: activityEntry([1, 0, 0, 0, 0]), c2: activityEntry([0, 0, 1, 0, 0]) }),
    [agent('c2'), agent('c1')], // passed out of series order on purpose
  );
  assert.deepEqual(m.rows.map((r) => r.agent.container), ['c2', 'c1']);
});
test('non-numeric / missing counts are coerced to ints, never NaN', () => {
  const m = selectHeatmapCells(
    series({ c1: { total: [2, 'x'], error: [1, undefined] } }, 2),
    [agent('c1')],
  );
  const cells = m.rows[0].cells;
  assert.deepEqual(cells.map((c) => c.total), [2, 0]);
  assert.deepEqual(cells.map((c) => c.error), [1, 0]);
  assert.ok(cells.every((c) => !Number.isNaN(c.intensity)));
});

console.log('\ncase 3 — container with NO events (idle) -> zero-filled row (flat dim stripe, NOT blank)');
console.log('  (THE parity fix: an alive-but-quiet agent renders a row, not a gap)');
test('idle container -> a full row of zero cells spanning the bucket grid', () => {
  // c-idle is a real container but had zero events, so it is ABSENT from the
  // activity map (getSeriesSince never creates a zero-event entry). It must
  // STILL get a row — zero-filled across every bucket column.
  const m = selectHeatmapCells(
    series({ c1: activityEntry([0, 1, 0, 0, 0]) }),
    [agent('c1'), agent('c-idle')],
  );
  assert.equal(m.rows.length, 2, 'idle container produces a row, not a gap');
  const idle = m.rows[1];
  assert.equal(idle.agent.container, 'c-idle');
  assert.equal(idle.cells.length, 5, 'zero-fill spans every bucket column');
  assert.ok(idle.cells.every((c) => c.total === 0 && c.error === 0), 'all cells zero');
  assert.ok(idle.cells.every((c) => c.intensity === 0), 'idle cells are intensity 0');
});
test('a real entry never falls through to the idle zero-fill', () => {
  const m = selectHeatmapCells(
    series({ c1: activityEntry([0, 2, 0, 0, 0]) }),
    [agent('c1')],
  );
  assert.deepEqual(m.rows[0].cells.map((c) => c.total), [0, 2, 0, 0, 0]);
});
test('an all-idle fleet -> max 0, every intensity 0 (nothing to scale against)', () => {
  const m = selectHeatmapCells(series({}), [agent('c-a'), agent('c-b')]);
  assert.equal(m.max, 0);
  assert.ok(m.rows.every((r) => r.cells.every((c) => c.intensity === 0)));
});

console.log('\ncellIntensity — pure single-cell normalization');
test('total/max clamped to [0,1], 0 when max <= 0', () => {
  assert.equal(cellIntensity(5, 10), 0.5);
  assert.equal(cellIntensity(10, 10), 1);
  assert.equal(cellIntensity(20, 10), 1); // clamped
  assert.equal(cellIntensity(3, 0), 0);   // idle fleet
  assert.equal(cellIntensity(3, -1), 0);  // defensive
});

console.log('\ncellHasError — a bucket is an error burst iff it has >=1 error event');
test('error count > 0 -> true; 0 / negative / non-numeric -> false', () => {
  assert.equal(cellHasError(1), true);
  assert.equal(cellHasError(5), true);
  assert.equal(cellHasError(0), false);
  assert.equal(cellHasError(-1), false);
  assert.equal(cellHasError(undefined), false);
  assert.equal(cellHasError(NaN), false);
});

console.log('\nbucketLabelIndices — sparse column labels, ~every step, final always labelled');
test('24 buckets, step 6 -> [0, 6, 12, 18, 23] (four 6h marks + now)', () => {
  assert.deepEqual(bucketLabelIndices(24, 6), [0, 6, 12, 18, 23]);
});
test('final bucket deduped when it already lands on a step', () => {
  // 6 buckets, step 3 -> 0, 3, then last (5) -> no dup of 3.
  assert.deepEqual(bucketLabelIndices(6, 3), [0, 3, 5]);
  // 3 buckets, step 3 -> 0, last (2). No dup.
  assert.deepEqual(bucketLabelIndices(3, 3), [0, 2]);
  // exactly divisible: 6 buckets step 3 lands 0,3; last is 5 (not a step) -> appended.
  // 3 buckets step 3 -> 0; last 2 not 0 -> appended.
});
test('count divisible by step does not double-add the final bucket', () => {
  // 12 buckets step 6 -> 0, 6; last is 11 (not 6) -> appended.
  assert.deepEqual(bucketLabelIndices(12, 6), [0, 6, 11]);
});
test('degenerate inputs -> empty', () => {
  assert.deepEqual(bucketLabelIndices(0, 6), []);
  assert.deepEqual(bucketLabelIndices(5, 0), []);
  assert.deepEqual(bucketLabelIndices(5, -1), []);
});

console.log('\nrowAriaLabel — screen-reader summary per row (mirrors sparkline grammar)');
test('plural events, no errors', () => {
  const cells = [{ total: 5, error: 0 }, { total: 1, error: 0 }];
  assert.equal(rowAriaLabel(cells), '6 events in the last 24 hours');
});
test('singular event', () => {
  assert.equal(rowAriaLabel([{ total: 1, error: 0 }]), '1 event in the last 24 hours');
});
test('events + singular error', () => {
  assert.equal(rowAriaLabel([{ total: 2, error: 1 }]), '2 events, 1 error in the last 24 hours');
});
test('events + plural errors', () => {
  assert.equal(rowAriaLabel([{ total: 2, error: 3 }]), '2 events, 3 errors in the last 24 hours');
});
test('fully idle row -> 0 events', () => {
  assert.equal(rowAriaLabel([{ total: 0, error: 0 }, { total: 0, error: 0 }]), '0 events in the last 24 hours');
});

console.log('\nmatrixAriaLabel — overall shape summary');
test('non-empty matrix announces agents + buckets', () => {
  const rows = [{ cells: [{}]}, { cells: [{}]}];
  assert.equal(matrixAriaLabel(rows, 24), 'Fleet activity heatmap, 2 agents across 24 hourly buckets in the last 24 hours');
});
test('singular agents / buckets', () => {
  assert.equal(matrixAriaLabel([{ cells: [{}] }], 1), 'Fleet activity heatmap, 1 agent across 1 hourly bucket in the last 24 hours');
});
test('empty matrix -> empty-state label', () => {
  assert.equal(matrixAriaLabel([], 24), 'Fleet activity heatmap is empty');
});

console.log(`\n✓ HEATMAP TESTS PASS (${passed})`);
