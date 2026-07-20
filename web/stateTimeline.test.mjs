// Tests for the pure fleet state-timeline join (WARDEN-788): selectStateCells +
// deriveDone + stateGlyph / stateLabel / countStateSegments / rowStateAriaLabel /
// matrixStateAriaLabel (web/src/lib/stateTimeline.ts).
//
// No front-end test runner in this repo, so (like heatmap.test.mjs) this loads the
// REAL src/lib/stateTimeline.ts (transpiled TS -> ESM via Vite's OXC transform)
// and exercises it with plain objects. The `import type` in that file is erased at
// transpile time, so the emitted module is import-free and loads standalone.
//
// The cases this file exists to lock down:
//   1. selectStateCells mirrors selectHeatmapCells's three cases — a container
//      with NO stateSeries entry still yields a null-filled row (alive-but-
//      untracked reads as a row, not a gap), and manual chats (no container) drop.
//   2. deriveDone relabels active→idle runs as `done` (the WARDEN-575 completion),
//      but idle after a NON-active predecessor stays `idle`.
//   3. countStateSegments / rowStateAriaLabel surface the oscillation signal — a
//      stuck→active→stuck row reads as multiple state changes, a steady one as none.
//
// Run: node stateTimeline.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const helperPath = resolve(__dirname, 'src/lib/stateTimeline.ts');

// --- Load the REAL stateTimeline.ts (TS -> ESM via the OXC transform Vite bundles) -
const src = readFileSync(helperPath, 'utf8');
const { code } = await transformWithOxc(src, helperPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-state-timeline-test-'));
const tmpFile = join(tmpDir, 'stateTimeline.mjs');
writeFileSync(tmpFile, code);
const {
  selectStateCells,
  deriveDone,
  stateGlyph,
  stateLabel,
  countStateSegments,
  rowStateAriaLabel,
  matrixStateAriaLabel,
} = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// Builders mirroring the wire ActivitySeries shape. `stateSeries` is keyed by
// container, each entry a `states` array parallel to `buckets`.
const bucket = (n, start) => Array.from({ length: n }, (_, i) => start + i * 3_600_000);
const series = (stateEntries, n = 5) => ({
  bucketMs: 3_600_000,
  buckets: bucket(n, 0),
  series: {}, // volume — unused by selectStateCells
  stateSeries: stateEntries,
});
const agent = (container) => ({ container });

console.log('\nselectStateCells — null / empty series -> empty matrix (graceful, no crash)');
test('null series -> empty rows, empty buckets', () => {
  const m = selectStateCells(null, [agent('c1')]);
  assert.equal(m.rows.length, 0);
  assert.deepEqual(m.buckets, []);
});
test('series with zero buckets -> empty matrix', () => {
  const m = selectStateCells({ bucketMs: 3_600_000, buckets: [], series: {}, stateSeries: {} }, [agent('c1')]);
  assert.equal(m.rows.length, 0);
});
test('series with no stateSeries field -> null-filled rows (forward-compat with a pre-WARDEN-788 server)', () => {
  // activitySeries.stateSeries is optional; its absence must not crash, and every
  // cell reads null (unobserved) rather than throwing.
  const m = selectStateCells({ bucketMs: 3_600_000, buckets: bucket(3, 0), series: {} }, [agent('c1')]);
  assert.equal(m.rows.length, 1);
  assert.deepEqual(m.rows[0].cells.map((c) => c.state), [null, null, null]);
});

console.log('\ncase 1 — no container -> no row (manual/tmux chats carry no state timeline)');
test('container null/undefined/empty all filtered out, container agents kept', () => {
  const m = selectStateCells(series({ c1: { states: ['active', 'idle', null, 'stuck', 'active'] } }), [
    agent(null), agent(undefined), agent(''), agent('c1'),
  ]);
  assert.deepEqual(m.rows.map((r) => r.agent.container), ['c1']);
});

console.log('\ncase 2 — container with a stateSeries entry -> real per-bucket cells');
test('each bucket carries the agent state, parallel to buckets', () => {
  // No active→idle adjacency, so deriveDone is a no-op and the raw states pass through.
  const m = selectStateCells(series({ c1: { states: ['stuck', 'erroring', 'blocked', 'waiting', 'active'] } }), [agent('c1')]);
  assert.equal(m.rows.length, 1);
  assert.equal(m.rows[0].cells.length, 5);
  assert.deepEqual(m.rows[0].cells.map((c) => c.state), ['stuck', 'erroring', 'blocked', 'waiting', 'active']);
});
test('row order follows the agents list', () => {
  const m = selectStateCells(
    series({ c1: { states: ['active', null, null, null, null] }, c2: { states: ['idle', null, null, null, null] } }),
    [agent('c2'), agent('c1')], // passed out of series order on purpose
  );
  assert.deepEqual(m.rows.map((r) => r.agent.container), ['c2', 'c1']);
});

console.log('\ncase 3 — container with NO stateSeries entry -> null-filled row (parity with the heatmap idle zero-fill)');
test('an alive-but-untracked container yields a full null row, not a gap', () => {
  const m = selectStateCells(series({ c1: { states: ['active', null, null, null, null] } }), [agent('c1'), agent('c-untracked')]);
  assert.equal(m.rows.length, 2, 'untracked container still produces a row');
  assert.equal(m.rows[1].agent.container, 'c-untracked');
  assert.deepEqual(m.rows[1].cells.map((c) => c.state), [null, null, null, null, null]);
});

console.log('\nderiveDone — active→idle relabeled done; other predecessors keep idle');
test('a clean active→idle run becomes done (the WARDEN-575 completion)', () => {
  assert.deepEqual(deriveDone(['active', 'idle', 'idle']), ['active', 'done', 'done']);
});
test('idle with NO active predecessor stays idle (not a finish)', () => {
  assert.deepEqual(deriveDone(['idle', 'idle']), ['idle', 'idle']);
  assert.deepEqual(deriveDone([null, null, 'idle']), [null, null, 'idle']);
});
test('idle after a non-active state (stuck/erroring/…) stays idle', () => {
  assert.deepEqual(deriveDone(['stuck', 'idle']), ['stuck', 'idle']);
  assert.deepEqual(deriveDone(['active', 'stuck', 'idle']), ['active', 'stuck', 'idle']);
});
test('a second work burst restarts the done-run (active→idle→active→idle)', () => {
  assert.deepEqual(deriveDone(['active', 'idle', 'active', 'idle']), ['active', 'done', 'active', 'done']);
});
test('null (unobserved) is transparent — does not break a done-run across a gap', () => {
  // active, <unobserved gap>, idle: the idle still reads as done (bookends suggest a finish).
  assert.deepEqual(deriveDone(['active', null, 'idle']), ['active', null, 'done']);
});

console.log('\nselectStateCells applies deriveDone (done surfaces on the rendered matrix)');
test('an active→idle row renders an active then a done segment', () => {
  const m = selectStateCells(series({ c1: { states: ['active', 'active', 'idle', 'idle', 'idle'] } }), [agent('c1')]);
  assert.deepEqual(m.rows[0].cells.map((c) => c.state), ['active', 'active', 'done', 'done', 'done']);
});

console.log('\ncountStateSegments / rowStateAriaLabel — the oscillation signal');
test('a steady row (one state) = 1 segment = no state changes', () => {
  assert.equal(countStateSegments([{ state: 'active' }, { state: 'active' }, { state: 'active' }]), 1);
  assert.equal(rowStateAriaLabel([{ state: 'active' }, { state: 'active' }]), 'no state changes in the last 24 hours');
});
test('stuck→active→stuck = 3 segments = 2 state changes (the looping pattern)', () => {
  const cells = [{ state: 'stuck' }, { state: 'stuck' }, { state: 'active' }, { state: 'stuck' }];
  assert.equal(countStateSegments(cells), 3);
  assert.equal(rowStateAriaLabel(cells), '2 state changes in the last 24 hours');
});
test('singular grammar: exactly one state change', () => {
  const cells = [{ state: 'active' }, { state: 'stuck' }];
  assert.equal(countStateSegments(cells), 2);
  assert.equal(rowStateAriaLabel(cells), '1 state change in the last 24 hours');
});
test('null buckets are skipped (unobserved neither starts nor breaks a segment)', () => {
  // stuck, <gap>, stuck = ONE continuous segment (the gap is unknown, not a change).
  assert.equal(countStateSegments([{ state: 'stuck' }, { state: null }, { state: 'stuck' }]), 1);
});

console.log('\nstateGlyph / stateLabel — known states + null + an unknown server state');
test('each known state has a non-empty glyph + a human label', () => {
  for (const s of ['active', 'idle', 'stuck', 'erroring', 'blocked', 'waiting', 'done', 'capture_failed']) {
    assert.ok(stateGlyph(s).length > 0, `${s} has a glyph`);
    assert.ok(stateLabel(s).length > 0, `${s} has a label`);
  }
});
test('null (unobserved) -> empty glyph + "unknown" label', () => {
  assert.equal(stateGlyph(null), '');
  assert.ok(stateLabel(null).includes('unknown'));
});
test('a future/unknown server state degrades gracefully (glyph + verbatim label)', () => {
  assert.ok(stateGlyph('future_state').length > 0, 'unknown state gets a neutral glyph');
  assert.equal(stateLabel('future_state'), 'future_state', 'label is the state verbatim');
});

console.log('\nmatrixStateAriaLabel — overall shape summary');
test('non-empty matrix announces agents + buckets', () => {
  const rows = [{ cells: [{}] }, { cells: [{}] }];
  assert.equal(matrixStateAriaLabel(rows, 24), 'Fleet state timeline, 2 agents across 24 hourly buckets in the last 24 hours');
});
test('empty matrix -> empty-state label', () => {
  assert.equal(matrixStateAriaLabel([], 24), 'Fleet state timeline is empty');
});

console.log(`\n✓ STATE TIMELINE TESTS PASS (${passed})`);
