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
//      but idle after a NON-active predecessor stays `idle` — and (WARDEN-1318) an
//      unobserved `null` gap BREAKS the run rather than being transparent, so a
//      completion is never asserted across hours nobody watched.
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
  KNOWN_STATES,
  PATTERN_MATCHED,
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
  // No active→idle adjacency, so deriveDone is a no-op and the re-encoded states
  // pass through. (WARDEN-1368: the classifier's erroring/blocked/waiting arrive
  // re-encoded as the ONE neutral `pattern_matched` — the substring guesses are
  // no longer rendered as agent states.)
  const m = selectStateCells(series({ c1: { states: ['stuck', 'erroring', 'blocked', 'waiting', 'active'] } }), [agent('c1')]);
  assert.equal(m.rows.length, 1);
  assert.equal(m.rows[0].cells.length, 5);
  assert.deepEqual(m.rows[0].cells.map((c) => c.state), ['stuck', 'pattern_matched', 'pattern_matched', 'pattern_matched', 'active']);
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
test('idle after a non-active state (stuck/pattern_matched/…) stays idle', () => {
  assert.deepEqual(deriveDone(['stuck', 'idle']), ['stuck', 'idle']);
  assert.deepEqual(deriveDone(['active', 'stuck', 'idle']), ['active', 'stuck', 'idle']);
});
test('a second work burst restarts the done-run (active→idle→active→idle)', () => {
  assert.deepEqual(deriveDone(['active', 'idle', 'active', 'idle']), ['active', 'done', 'active', 'done']);
});
test('null (unobserved) BREAKS a done-run — a completion is not asserted across a blackout (WARDEN-1318)', () => {
  // Before the forward-fill was bounded, a mid-row null was effectively impossible
  // (nulls appeared only as the never-observed prefix), so "transparent across a
  // gap" was a rule about an unreachable case. Now a mid-row null means "nobody
  // watched for >= STATE_STALE_AFTER_MS", and carrying a done-run across one would
  // assert a completion spanning hours nobody observed. active, <gap>, idle → the
  // idle stays honest `idle`.
  assert.deepEqual(deriveDone(['active', null, 'idle']), ['active', null, 'idle']);
  // The gap clears prevKnown too, so a LATER active→idle inside the observed
  // stretch still reads done — only the claim across the gap is withheld.
  assert.deepEqual(deriveDone(['active', null, 'active', 'idle']), ['active', null, 'active', 'done']);
  // A gap that interrupts an EXISTING done-run also ends it.
  assert.deepEqual(deriveDone(['active', 'idle', null, 'idle']), ['active', 'done', null, 'idle']);
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
  for (const s of ['active', 'idle', 'stuck', 'pattern_matched', 'done', 'capture_failed']) {
    assert.ok(stateGlyph(s).length > 0, `${s} has a glyph`);
    assert.ok(stateLabel(s).length > 0, `${s} has a label`);
  }
});
test('KNOWN_STATES no longer carries the substring-guess names (WARDEN-1368)', () => {
  // The three classifier guesses are re-encoded in selectStateCells; the legend +
  // glyph maps' single source of truth must not list them as renderable states.
  for (const retired of ['erroring', 'blocked', 'waiting']) {
    assert.ok(!KNOWN_STATES.includes(retired), `${retired} is out of KNOWN_STATES`);
  }
  assert.ok(KNOWN_STATES.includes('pattern_matched'), 'pattern_matched is the one neutral encoding');
});
test('null (unobserved) -> empty glyph + "unknown" label', () => {
  assert.equal(stateGlyph(null), '');
  assert.ok(stateLabel(null).includes('unknown'));
});
test('a future/unknown server state degrades gracefully (glyph + verbatim label)', () => {
  assert.ok(stateGlyph('future_state').length > 0, 'unknown state gets a neutral glyph');
  assert.equal(stateLabel('future_state'), 'future_state', 'label is the state verbatim');
});

console.log('\nWARDEN-1368 — substring-guess hours render the ONE neutral pattern_matched encoding');
test('LITMUS: erroring/waiting/blocked buckets re-encode to pattern_matched — non-health label, no health glyphs', () => {
  // The exact live-probe false positives from the ticket: a passing suite's
  // "0 errors" line classified erroring; a review prompt classified waiting;
  // blocked-dependency prose classified blocked. None of that is an agent
  // state, so the timeline renders the observable fact instead.
  const m = selectStateCells(
    series({ c1: { states: ['active', 'erroring', 'waiting', 'blocked', 'idle'] } }),
    [agent('c1')],
  );
  const rendered = m.rows[0].cells.map((c) => c.state);
  assert.deepEqual(rendered, ['active', PATTERN_MATCHED, PATTERN_MATCHED, PATTERN_MATCHED, 'idle']);
  for (const s of rendered) {
    if (s !== PATTERN_MATCHED) continue;
    const label = stateLabel(s);
    const glyph = stateGlyph(s);
    for (const banned of ['erroring', 'blocked', 'waiting']) {
      assert.ok(!label.toLowerCase().includes(banned), `label carries no "${banned}" claim: ${label}`);
    }
    assert.ok(!['✕', '■', '?'].includes(glyph), `glyph is not a health mark: ${glyph}`);
    assert.ok(label.includes('text-pattern'), `label names the FACT (the text-pattern match): ${label}`);
  }
  // The passing-suite hour no longer reads "erroring" anywhere on the timeline.
  assert.ok(!rendered.includes('erroring'), 'no erroring state survives rendering');
});

test('MUTATION-CHECK anchor: reverting the re-encode turns the litmus RED', () => {
  // This only holds BECAUSE selectStateCells re-encodes. Delete the
  // reencodePatternGuesses call in stateTimeline.ts and it fails — 'erroring'
  // would pass through raw as an agent-state claim again.
  const m = selectStateCells(series({ c1: { states: ['erroring'] } }), [agent('c1')]);
  assert.equal(m.rows[0].cells[0].state, PATTERN_MATCHED);
});

test('deriveDone interplay pinned: active -> [pattern_matched hour] -> idle does NOT read done', () => {
  // The neutral name must break a done-run exactly as the three guess names do —
  // re-encoding must not change what reads as a completion.
  assert.deepEqual(deriveDone(['active', PATTERN_MATCHED, 'idle']), ['active', PATTERN_MATCHED, 'idle']);
  // End-to-end: the RAW series still carries the classifier's name and the
  // break survives the re-encode.
  const m = selectStateCells(series({ c1: { states: ['active', 'erroring', 'idle'] } }, 3), [agent('c1')]);
  assert.deepEqual(m.rows[0].cells.map((c) => c.state), ['active', PATTERN_MATCHED, 'idle']);
});

test('countStateSegments interplay pinned: a pattern_matched cell still counts as a segment', () => {
  // active -> guess hours -> active = 3 segments — mechanically true (the
  // classifier's output changed), so the aria "N state changes" stays honest.
  const m = selectStateCells(
    series({ c1: { states: ['active', 'blocked', 'waiting', 'erroring', 'active'] } }),
    [agent('c1')],
  );
  const cells = m.rows[0].cells;
  assert.deepEqual(cells.map((c) => c.state), ['active', PATTERN_MATCHED, PATTERN_MATCHED, PATTERN_MATCHED, 'active']);
  assert.equal(countStateSegments(cells), 3);
  assert.equal(rowStateAriaLabel(cells), '2 state changes in the last 24 hours');
});

test('a genuinely-steady stuck/active row still renders exactly as today', () => {
  // The timeline's real job — oscillation — is untouched: active/idle/stuck/
  // done/capture_failed pass through byte-identically.
  const m = selectStateCells(series({ c1: { states: ['stuck', 'stuck', 'active', 'active', 'stuck'] } }), [agent('c1')]);
  assert.deepEqual(m.rows[0].cells.map((c) => c.state), ['stuck', 'stuck', 'active', 'active', 'stuck']);
});

test('single source of truth: the renderer tone + legend carry the neutral encoding, not the guesses', () => {
  // The .tsx cannot be imported by this DOM-free harness, so pin its two
  // encoding tables by source: STATE_BG / LEGEND_STATES must have dropped the
  // three guess states (no red/blue/sky agent-state claim) and carry the
  // neutral zinc encoding instead.
  const tsx = readFileSync(resolve(__dirname, 'src/components/FleetStateTimeline.tsx'), 'utf8');
  const bg = tsx.match(/const STATE_BG[^=]*= \{[\s\S]*?\n\};/)?.[0] ?? '';
  assert.ok(bg.length > 0, 'STATE_BG block found');
  assert.ok(bg.includes("pattern_matched: 'bg-zinc-500'"), 'pattern_matched uses the neutral zinc tone');
  for (const retired of ['waiting', 'blocked', 'erroring']) {
    assert.ok(!bg.includes(`${retired}:`), `STATE_BG dropped the ${retired} tone`);
  }
  assert.ok(!/bg-red-500|bg-blue-500|bg-sky-500/.test(bg), 'no red/blue/sky agent-state tone remains in STATE_BG');
  const legend = tsx.match(/const LEGEND_STATES = \[[\s\S]*?\] as const/)?.[0] ?? '';
  assert.ok(legend.length > 0, 'LEGEND_STATES block found');
  assert.ok(legend.includes("'pattern_matched'"), 'legend lists pattern_matched');
  for (const retired of ['waiting', 'blocked', 'erroring']) {
    assert.ok(!legend.includes(`'${retired}'`), `legend dropped '${retired}'`);
  }
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
