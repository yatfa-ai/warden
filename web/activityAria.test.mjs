// Tests for the shared Fleet Health activity aria-label formatter (WARDEN-1080):
// activityAriaLabel (web/src/lib/activityAria.ts), plus — the reason this file
// exists — a CROSS-PRODUCER PARITY test.
//
// Two widgets on one Fleet Health page announce this sentence: the heatmap row
// (heatmap.ts rowAriaLabel, via FleetActivityHeatmap) and the per-agent sparkline
// (agentSparkline.ts selectAgentSparkline, via HealthDashboard). They each used to
// hand-write the template and drifted — at zero errors the row said "5 events in
// the last 24 hours" while the sparkline said "5 events, 0 errors in the last 24
// hours". heatmap.test.mjs and agentSparkline.test.mjs each locked in their own
// string, so neither suite could see the contradiction; only a test that calls BOTH
// producers can. The parity block below is that test: same (total, error) in, byte
// -identical string out. Re-inline the template at either site and it fails.
//
// No front-end test runner in this repo, so (like storage.test.mjs) this transpiles
// all three modules into ONE tmp dir and rewrites the bare `@/lib/activityAria`
// specifier so both consumers resolve the SAME emitted formatter module.
//
// Run: node activityAria.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ariaPath = resolve(__dirname, 'src/lib/activityAria.ts');
const heatmapPath = resolve(__dirname, 'src/lib/heatmap.ts');
const sparkPath = resolve(__dirname, 'src/lib/agentSparkline.ts');

const emit = async (path) => (await transformWithOxc(readFileSync(path, 'utf8'), path, {})).code;
const [ariaCode, heatmapCode, sparkCode] = await Promise.all([ariaPath, heatmapPath, sparkPath].map(emit));

const tmpDir = mkdtempSync(join(tmpdir(), 'warden-activityaria-test-'));
const rewrite = (code) => code.replaceAll('@/lib/activityAria', './activityAria.mjs');
writeFileSync(join(tmpDir, 'activityAria.mjs'), ariaCode);
writeFileSync(join(tmpDir, 'heatmap.mjs'), rewrite(heatmapCode));
writeFileSync(join(tmpDir, 'agentSparkline.mjs'), rewrite(sparkCode));
const { activityAriaLabel } = await import(join(tmpDir, 'activityAria.mjs'));
const { rowAriaLabel } = await import(join(tmpDir, 'heatmap.mjs'));
const { buildAgentActivity, selectAgentSparkline } = await import(join(tmpDir, 'agentSparkline.mjs'));
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

console.log('\nactivityAriaLabel — the one grammar');
test('plural events, no errors -> errors clause suppressed', () => {
  assert.equal(activityAriaLabel(5, 0), '5 events in the last 24 hours');
});
test('singular event, no errors', () => {
  assert.equal(activityAriaLabel(1, 0), '1 event in the last 24 hours');
});
test('zero events (idle) -> "0 events", no errors clause', () => {
  assert.equal(activityAriaLabel(0, 0), '0 events in the last 24 hours');
});
test('singular error is appended when error > 0', () => {
  assert.equal(activityAriaLabel(2, 1), '2 events, 1 error in the last 24 hours');
});
test('plural errors are appended when error > 0', () => {
  assert.equal(activityAriaLabel(2, 3), '2 events, 3 errors in the last 24 hours');
});
test('an error count can exceed the event count without breaking plurality', () => {
  assert.equal(activityAriaLabel(1, 2), '1 event, 2 errors in the last 24 hours');
});

console.log('\ncross-producer parity — heatmap row vs agent sparkline (THE anti-drift assertion)');
// Drive each producer through its OWN public entry point with its own input shape:
// the heatmap sums HeatmapCell[], the sparkline sums the wire series. Only the
// emitted sentence is compared, so this catches a re-inlined template at either
// site — not just a divergence in the shared helper.
const rowLabel = (total, error) => rowAriaLabel([{ total, error }]);
const sparkLabel = (total, error) => {
  const activity = buildAgentActivity({
    bucketMs: 3_600_000,
    buckets: [0],
    series: { c1: { total: [total], error: [error] } },
  });
  return selectAgentSparkline({ container: 'c1' }, activity, 1).ariaLabel;
};

// (total, error) pairs spanning every branch: zero/one/many events × zero/one/many
// errors — including the (4, 0) case the two widgets actually disagreed on.
const PAIRS = [[0, 0], [1, 0], [4, 0], [5, 0], [1, 1], [2, 1], [2, 3], [6, 0], [10, 10]];
for (const [total, error] of PAIRS) {
  test(`(total=${total}, error=${error}) -> identical strings from both producers`, () => {
    const expected = activityAriaLabel(total, error);
    assert.equal(rowLabel(total, error), expected, 'heatmap rowAriaLabel drifted from the shared formatter');
    assert.equal(sparkLabel(total, error), expected, 'selectAgentSparkline drifted from the shared formatter');
  });
}

test('the regression case: 4 events / 0 errors announces the same sentence in both widgets', () => {
  // Pre-WARDEN-1080 this was '4 events in the last 24 hours' vs
  // '4 events, 0 errors in the last 24 hours' — heard back to back on one page.
  assert.equal(rowLabel(4, 0), '4 events in the last 24 hours');
  assert.equal(sparkLabel(4, 0), '4 events in the last 24 hours');
});

test('the sparkline idle branch (no map entry) also matches the shared formatter', () => {
  // Case 3: container present, absent from the activity map -> zero-filled series.
  const sel = selectAgentSparkline({ container: 'c-idle' }, new Map(), 5);
  assert.equal(sel.ariaLabel, activityAriaLabel(0, 0));
  assert.equal(sel.ariaLabel, rowLabel(0, 0));
});

console.log(`\n✓ ACTIVITY ARIA TESTS PASS (${passed})`);
