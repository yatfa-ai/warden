// Tests for buildAttentionRollup — the pure aggregator behind the header
// AttentionBadge's count (WARDEN-228).
//
// No front-end test runner in this repo, so (like gitStateSummary.test.mjs) this
// loads the REAL src/lib/attentionRollup.ts (transpiled TS -> ESM via Vite's OXC
// transform) and exercises it with plain objects. The `import type` in that file
// is erased at transpile time, so the emitted module is import-free and loads
// standalone.
//
// Formula under test: total = critical + warning agents + pending directives +
// recent errors. The caller (useAttentionRollup) already windowed the activity
// counts via the `after=` query param, so here we only verify aggregation — that
// each bucket contributes to the count, zero aggregates to nothing (badge hidden),
// and null/partial/missing inputs degrade gracefully instead of crashing.
//
// Run: node attentionRollup.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const helperPath = resolve(__dirname, 'src/lib/attentionRollup.ts');

// --- Load the REAL attentionRollup.ts (TS -> ESM via the OXC transform Vite bundles) ----
const src = readFileSync(helperPath, 'utf8');
const { code } = await transformWithOxc(src, helperPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-attention-test-'));
const tmpFile = join(tmpDir, 'attentionRollup.mjs');
writeFileSync(tmpFile, code);
const { buildAttentionRollup, EMPTY_ATTENTION_ROLLUP } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// Builders so each case reads as "which agents / counts" not a wall of literals.
const agent = (id, extra = {}) => ({ id, key: id, name: id, ...extra });
const health = (groups) => ({ groups: { healthy: [], warning: [], critical: [], idle: [], unknown: [], ...groups } });
const stats = (s) => ({ total: 0, directive_proposed: 0, attached: 0, ended: 0, error: 0, ...s });
const roll = (h, s) => buildAttentionRollup(h ?? null, s ?? null);

console.log('\nzero state → hidden (total 0, empty buckets)');
test('all-healthy fleet + no activity → total 0', () => {
  const r = roll(health({ healthy: [agent('a1'), agent('a2')] }), stats());
  assert.equal(r.total, 0);
  assert.deepEqual(r.critical, []);
  assert.deepEqual(r.warning, []);
  assert.equal(r.directives, 0);
  assert.equal(r.errors, 0);
});

console.log('\neach bucket contributes to the total');
test('a critical agent → total 1', () => {
  const r = roll(health({ critical: [agent('a1')] }), stats());
  assert.equal(r.total, 1);
});
test('a warning agent → total 1', () => {
  const r = roll(health({ warning: [agent('a1')] }), stats());
  assert.equal(r.total, 1);
});
test('3 pending directives → total 3', () => {
  const r = roll(health(), stats({ directive_proposed: 3 }));
  assert.equal(r.total, 3);
  assert.equal(r.directives, 3);
});
test('2 recent errors → total 2', () => {
  const r = roll(health(), stats({ error: 2 }));
  assert.equal(r.total, 2);
  assert.equal(r.errors, 2);
});

console.log('\nfull formula: critical + warning + directives + errors');
test('mixed buckets sum exactly', () => {
  const r = roll(
    health({ critical: [agent('c1'), agent('c2')], warning: [agent('w1')] }),
    stats({ directive_proposed: 4, error: 5 }),
  );
  assert.equal(r.total, 2 + 1 + 4 + 5);
  assert.equal(r.critical.length, 2);
  assert.equal(r.warning.length, 1);
  assert.equal(r.directives, 4);
  assert.equal(r.errors, 5);
});

console.log('\ncritical/warning expose the GROUP ARRAYS (for deep-link rows), not just counts');
test('critical agents are returned in order for row rendering', () => {
  const c = [agent('c1'), agent('c2')];
  const r = roll(health({ critical: c }), stats());
  assert.deepEqual(r.critical, c);
});

console.log('\nhealthy/idle/unknown agents never count (only critical + warning are attention)');
test('a healthy agent contributes nothing even with errors elsewhere', () => {
  const r = roll(health({ healthy: [agent('h1')], idle: [agent('i1')], unknown: [agent('u1')] }), stats());
  assert.equal(r.total, 0);
});

console.log('\nnull / partial inputs degrade gracefully (no crash — AC: error/empty/loading states)');
test('null health + null stats → empty rollup', () => {
  const r = roll(null, null);
  assert.equal(r.total, 0);
  assert.deepEqual(r.critical, []);
});
test('health present, stats null → only health buckets counted', () => {
  const r = roll(health({ critical: [agent('c1')] }), null);
  assert.equal(r.total, 1);
  assert.equal(r.directives, 0);
  assert.equal(r.errors, 0);
});
test('stats present, health null → only activity counted', () => {
  const r = roll(null, stats({ directive_proposed: 2, error: 1 }));
  assert.equal(r.total, 3);
});
test('health missing the groups object entirely → empty buckets, no throw', () => {
  const r = buildAttentionRollup({}, stats({ error: 1 }));
  assert.equal(r.total, 1);
  assert.deepEqual(r.critical, []);
});
test('health with groups but no critical/warning keys → empty buckets, no throw', () => {
  const r = buildAttentionRollup({ groups: { healthy: [agent('h1')] } }, stats());
  assert.equal(r.total, 0);
});

console.log('\nmissing/non-numeric activity counts are quiet, never NaN');
test('stats missing directive_proposed/error keys → treated as 0', () => {
  const r = buildAttentionRollup(health(), {});
  assert.equal(r.directives, 0);
  assert.equal(r.errors, 0);
  assert.equal(r.total, 0);
});
test('NaN / string counts cannot reach the total', () => {
  const r = buildAttentionRollup(health(), { directive_proposed: NaN, error: 'oops' });
  assert.equal(r.directives, 0);
  assert.equal(r.errors, 0);
  assert.equal(r.total, 0);
});
test('numeric strings ARE coerced (defensive, matches Number(x) || 0)', () => {
  const r = buildAttentionRollup(health(), { directive_proposed: '3', error: 0 });
  assert.equal(r.directives, 3);
  assert.equal(r.total, 3);
});

console.log('\nEMPTY_ATTENTION_ROLLUP constant is a valid hidden zero state');
test('EMPTY_ATTENTION_ROLLUP has total 0 and empty arrays', () => {
  assert.equal(EMPTY_ATTENTION_ROLLUP.total, 0);
  assert.deepEqual(EMPTY_ATTENTION_ROLLUP.critical, []);
  assert.deepEqual(EMPTY_ATTENTION_ROLLUP.warning, []);
});

console.log(`\n✓ ATTENTION ROLLUP TESTS PASS (${passed})`);
