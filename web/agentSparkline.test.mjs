// Tests for the pure per-agent sparkline join (WARDEN-299): buildAgentActivity +
// selectAgentSparkline (web/src/lib/agentSparkline.ts).
//
// No front-end test runner in this repo, so (like attentionRollup.test.mjs) this
// loads the REAL src/lib/agentSparkline.ts (transpiled TS -> ESM via Vite's OXC
// transform) and exercises it with plain objects. The `import type` in that file
// is erased at transpile time, so the emitted module is import-free and loads
// standalone.
//
// The case this file exists to lock down is selectAgentSparkline's THIRD branch:
// a container that is alive but had ZERO events in the window must yield a
// zero-filled series (→ <Sparkline> draws a flat baseline), NOT null. That is the
// idle-flat-line behavior criterion #1 requires, and the prior slice shipped it
// dead (an idle container was absent from the activity map and rendered nothing).
// The idle-container assertion below fails the moment that regresses.
//
// Run: node agentSparkline.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const helperPath = resolve(__dirname, 'src/lib/agentSparkline.ts');

// --- Load the REAL agentSparkline.ts (TS -> ESM via the OXC transform Vite bundles) ----
const src = readFileSync(helperPath, 'utf8');
const { code } = await transformWithOxc(src, helperPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-agentspark-test-'));
const tmpFile = join(tmpDir, 'agentSparkline.mjs');
writeFileSync(tmpFile, code);
const { buildAgentActivity, selectAgentSparkline } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// Builders so each case reads as "which agent / which series" not a wall of literals.
// `series` mirrors the wire ActivitySeries shape: parallel total/error arrays.
const bucket = (n, start) => Array.from({ length: n }, (_, i) => start + i); // placeholder epoch grid
const series = (entries, n = 5) => ({
  bucketMs: 3_600_000,
  buckets: bucket(n, 0),
  series: entries,
});
const activityEntry = (total, error) => ({ total, error: error ?? total.map(() => 0) });
const agent = (container) => ({ container });

console.log('\nbuildAgentActivity — wire series -> per-container pre-summed map');
test('null series -> empty map (loading state, no crash)', () => {
  const m = buildAgentActivity(null);
  assert.equal(m.size, 0);
});
test('empty series.series -> empty map', () => {
  const m = buildAgentActivity(series({}));
  assert.equal(m.size, 0);
});
test('each container -> its arrays + window sums', () => {
  const m = buildAgentActivity(series({
    c1: activityEntry([0, 2, 0, 3, 1], [0, 1, 0, 0, 0]),
    c2: activityEntry([0, 0, 1, 0, 0]),
  }));
  assert.deepEqual([...m.keys()].sort(), ['c1', 'c2']);
  const c1 = m.get('c1');
  assert.equal(c1.totalSum, 6); // 2 + 3 + 1
  assert.equal(c1.errorSum, 1);
  assert.equal(c1.values.length, 5);
});
test('non-numeric / missing counts are coerced to ints, never NaN', () => {
  // total[i] | 0 turns undefined/'x' into 0; mirrors the old inline memo.
  const m = buildAgentActivity(series({ c1: { total: [2, 'x'], error: [1, undefined] } }));
  const c1 = m.get('c1');
  assert.equal(c1.totalSum, 2); // 2 + 0
  assert.equal(c1.errorSum, 1); // 1 + 0
});

console.log('\ncase 1 — no container -> no sparkline (manual/tmux chats stay clean)');
test('container null -> null', () => {
  assert.equal(selectAgentSparkline(agent(null), new Map(), 5), null);
});
test('container undefined -> null', () => {
  assert.equal(selectAgentSparkline(agent(undefined), new Map(), 5), null);
});
test('container empty string -> null', () => {
  assert.equal(selectAgentSparkline(agent(''), new Map(), 5), null);
});

console.log('\ncase 2 — container with events -> its real per-bucket series + aria-label');
test('active agent -> real values/errors + counted aria-label', () => {
  const m = buildAgentActivity(series({
    c1: activityEntry([0, 2, 0, 3, 0], [0, 1, 0, 0, 0]),
  }));
  const sel = selectAgentSparkline(agent('c1'), m, 5);
  assert.ok(sel, 'active agent must produce a sparkline');
  assert.deepEqual(sel.values, [0, 2, 0, 3, 0]);
  assert.deepEqual(sel.errors, [0, 1, 0, 0, 0]);
  assert.equal(sel.ariaLabel, '5 events, 1 error in the last 24 hours');
});
test('aria-label is singular for exactly one event / one error', () => {
  const m = buildAgentActivity(series({ c1: activityEntry([0, 1, 0, 0, 0], [0, 1, 0, 0, 0]) }));
  const sel = selectAgentSparkline(agent('c1'), m, 5);
  assert.equal(sel.ariaLabel, '1 event, 1 error in the last 24 hours');
});
test('active agent with zero errors pluralizes events only', () => {
  const m = buildAgentActivity(series({ c1: activityEntry([0, 4, 0, 0, 0]) }));
  const sel = selectAgentSparkline(agent('c1'), m, 5);
  assert.equal(sel.ariaLabel, '4 events, 0 errors in the last 24 hours');
});

console.log('\ncase 3 — container with NO events (idle) -> zero-filled flat baseline');
console.log('  (THE blocker fix: an alive-but-quiet agent renders a flat line, not a blank)');
test('idle container -> zero-filled values spanning the bucket grid (flat line)', () => {
  // c-idle is a real yatfa container but had zero events, so it is ABSENT from the
  // activity map (getSeriesSince never creates a zero-event entry).
  const m = buildAgentActivity(series({ c1: activityEntry([0, 1, 0, 0, 0]) }));
  const sel = selectAgentSparkline(agent('c-idle'), m, 5);
  assert.ok(sel, 'idle container must still produce a sparkline (the flat line)');
  assert.equal(sel.values.length, 5, 'zero-fill spans every bucket column');
  assert.ok(sel.values.every((v) => v === 0), 'all buckets zero -> Sparkline hasData=false -> flat baseline');
  assert.deepEqual(sel.errors, sel.values, 'errors parallel the zero-fill');
  assert.equal(sel.ariaLabel, '0 events in the last 24 hours');
});
test('idle container while the series is still loading (bucketCount 0) -> null', () => {
  // No grid yet: render nothing rather than a widthless baseline, until the
  // series arrives. Brief — the hook fetches on mount.
  const sel = selectAgentSparkline(agent('c-idle'), new Map(), 0);
  assert.equal(sel, null);
});

console.log('\ncase precedence — a real entry wins over the idle fallback');
test('a container present in the map never falls through to zeros', () => {
  const m = buildAgentActivity(series({ c1: activityEntry([0, 2, 0, 0, 0]) }));
  const sel = selectAgentSparkline(agent('c1'), m, 5);
  assert.deepEqual(sel.values, [0, 2, 0, 0, 0]);
  assert.notDeepEqual(sel.values, [0, 0, 0, 0, 0]);
});

console.log(`\n✓ AGENT SPARKLINE TESTS PASS (${passed})`);
