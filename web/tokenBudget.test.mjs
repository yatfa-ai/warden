// Tests for the pure token-spend budget helpers (WARDEN-415).
//
// No front-end test runner in this repo, so (like attentionRollup.test.mjs) this
// loads the REAL src/lib/tokenBudget.ts (transpiled TS -> ESM via Vite's OXC
// transform) and exercises the PURE helpers with plain objects. The module has
// NO runtime imports (only types, erased at transpile), so the emitted module
// loads standalone.
//
// Under test: shouldFireBudgetAlert (the crossing debounce), budgetProgress /
// budgetOverPercent (spent/threshold math), offenderHostLabel, and
// formatBudgetMessageWith (the single wording source for toast + desktop).
//
// Run: node tokenBudget.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const helperPath = resolve(__dirname, 'src/lib/tokenBudget.ts');

// --- Load the REAL tokenBudget.ts (TS -> ESM via the OXC transform Vite bundles) ----
const src = readFileSync(helperPath, 'utf8');
const { code } = await transformWithOxc(src, helperPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-tokenbudget-test-'));
const tmpFile = join(tmpDir, 'tokenBudget.mjs');
writeFileSync(tmpFile, code);
const {
  shouldFireBudgetAlert,
  pickBudgetChannel,
  budgetProgress,
  budgetOverPercent,
  offenderHostLabel,
  formatBudgetMessageWith,
  EMPTY_BUDGET,
} = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// Builders so each case reads as the state it represents, not a wall of literals.
const b = (over = {}) => ({
  enabled: true,
  threshold: 2_000_000,
  perSessionThreshold: 1_000_000,
  windowHours: 24,
  fleetSpent: 0,
  sessionCount: 0,
  fleetBreached: false,
  perSessionBreached: false,
  topOffender: null,
  alerted: false,
  evaluatedAt: 1_700_000_000_000,
  ...over,
});
// Identity formatter so assertions read exact strings (independent of formatTokens).
const fmt = (n) => (n ? `${n} tok` : '');

console.log('\nshouldFireBudgetAlert: fires ONLY on the crossing into alerted');
test('fires on false → true', () => {
  assert.equal(shouldFireBudgetAlert(b({ alerted: false }), b({ alerted: true })), true);
});
test('does NOT fire while persistently over (debounce)', () => {
  assert.equal(shouldFireBudgetAlert(b({ alerted: true }), b({ alerted: true })), false);
});
test('does NOT fire on recovery', () => {
  assert.equal(shouldFireBudgetAlert(b({ alerted: true }), b({ alerted: false })), false);
});
test('does NOT fire on first observation (baseline priming)', () => {
  assert.equal(shouldFireBudgetAlert(null, b({ alerted: true })), false);
  assert.equal(shouldFireBudgetAlert(b({ alerted: false }), null), false);
});

console.log('\npickBudgetChannel: the no-double-fire visibility split');
test('VISIBLE → toast (the human is at Warden)', () => {
  // Opted in or not, a visible tab always gets the in-app sonner — never desktop.
  assert.equal(pickBudgetChannel(true, true), 'toast');
  assert.equal(pickBudgetChannel(true, false), 'toast');
});
test('HIDDEN + opted-in → desktop (the human stepped away)', () => {
  assert.equal(pickBudgetChannel(false, true), 'desktop');
});
test('HIDDEN + not-opted → none (deferred to the focus-regain catch-up)', () => {
  // No channel fires now; useTokenBudget surfaces the toast on return instead.
  assert.equal(pickBudgetChannel(false, false), 'none');
});
test('toast and desktop are mutually exclusive (never both at once)', () => {
  // No (visible, optedIn) combination returns both channels — the split is the
  // "no double fire" guarantee: an away human gets the OS notification, and the
  // in-app toast is caught up on focus-regain, never fired alongside it.
  for (const visible of [true, false]) {
    for (const opted of [true, false]) {
      const ch = pickBudgetChannel(visible, opted);
      assert.ok(ch === 'toast' || ch === 'desktop' || ch === 'none', `bad channel ${ch}`);
    }
  }
});

console.log('\nbudgetProgress: clamped 0..1 bar fraction');
test('halfway', () => {
  assert.equal(budgetProgress(1_000_000, 2_000_000), 0.5);
});
test('clamps over-budget to 1 (bar can never overflow)', () => {
  assert.equal(budgetProgress(3_600_000, 2_000_000), 1);
});
test('0 when there is no threshold', () => {
  assert.equal(budgetProgress(500_000, 0), 0);
});

console.log('\nbudgetOverPercent: UNclamped whole percent (can exceed 100)');
test('180% reads honestly past 100', () => {
  assert.equal(budgetOverPercent(3_600_000, 2_000_000), 180);
});
test('rounds to a whole percent', () => {
  assert.equal(budgetOverPercent(500_000, 3_000_000), 17); // 16.67 → 17
});
test('0 when there is no threshold', () => {
  assert.equal(budgetOverPercent(500_000, 0), 0);
});

console.log('\noffenderHostLabel: (local) reads as "this machine"');
test('local host', () => {
  assert.equal(offenderHostLabel('(local)'), 'this machine');
});
test('remote host verbatim', () => {
  assert.equal(offenderHostLabel('build-host'), 'build-host');
});
// WARDEN-490 — per-host display labels reach the offender line. Zero-regression:
// an absent/empty label keeps "this machine" (local) / raw host (remote).
test('labeled local host → the label', () => {
  assert.equal(offenderHostLabel('(local)', { '(local)': 'my mac' }), 'my mac');
});
test('labeled remote host → the label', () => {
  assert.equal(offenderHostLabel('ec2-1-2-3', { 'ec2-1-2-3': 'CI runner' }), 'CI runner');
});
test('empty/whitespace label → falls back to unlabeled (zero regression)', () => {
  assert.equal(offenderHostLabel('(local)', { '(local)': '  ' }), 'this machine');
  assert.equal(offenderHostLabel('ec2-1-2-3', { 'ec2-1-2-3': '' }), 'ec2-1-2-3');
});
test('host with no entry in the map → raw host', () => {
  assert.equal(offenderHostLabel('build-host', { '(local)': 'my mac' }), 'build-host');
});

console.log('\nformatBudgetMessageWith: single wording source (toast + desktop)');
test('per-session breach names the offending session', () => {
  const m = formatBudgetMessageWith(b({
    perSessionBreached: true,
    fleetBreached: false,
    alerted: true,
    topOffender: { id: 'abc', host: '(local)', cwd: '/repo', summary: 'fix the bug', total: 1_100_000 },
  }), fmt);
  assert.ok(m.title.includes('runaway'), `title names runaway: ${m.title}`);
  assert.ok(m.body.includes('fix the bug'), `body names session: ${m.body}`);
  assert.ok(m.body.includes('this machine'), `body localizes host: ${m.body}`);
  assert.ok(m.body.includes('1100000 tok'), `body shows offender total: ${m.body}`);
});
test('fleet-only breach frames as aggregate drift (no offender named)', () => {
  const m = formatBudgetMessageWith(b({
    fleetBreached: true,
    fleetSpent: 2_500_000,
    alerted: true,
  }), fmt);
  assert.equal(m.title, 'Token budget breached');
  assert.ok(m.body.includes('2500000 tok'), `body shows fleet spend: ${m.body}`);
  assert.ok(m.body.includes('2000000 tok'), `body shows threshold: ${m.body}`);
  assert.ok(!m.body.includes('runaway'));
});
test('window hours render as days when >= 24', () => {
  const m = formatBudgetMessageWith(b({ fleetBreached: true, fleetSpent: 2_500_000, alerted: true, windowHours: 48 }), fmt);
  assert.ok(m.body.includes('2d'), `48h renders as 2d: ${m.body}`);
});
test('window hours render as hours when < 24', () => {
  const m = formatBudgetMessageWith(b({ fleetBreached: true, fleetSpent: 2_500_000, alerted: true, windowHours: 6 }), fmt);
  assert.ok(m.body.includes('6h'), `6h renders as 6h: ${m.body}`);
});
// WARDEN-490 — the offender line localizes the host via the label map.
test('per-session breach localizes the offender host via labels', () => {
  const m = formatBudgetMessageWith(b({
    perSessionBreached: true,
    fleetBreached: false,
    alerted: true,
    topOffender: { id: 'abc', host: 'ec2-1-2-3', cwd: '/repo', summary: 'fix the bug', total: 1_100_000 },
  }), fmt, { 'ec2-1-2-3': 'CI runner' });
  assert.ok(m.body.includes('CI runner'), `body uses the label: ${m.body}`);
  assert.ok(!m.body.includes('ec2-1-2-3'), `body hides the raw host: ${m.body}`);
});
test('per-session breach with NO label map keeps the raw host (zero regression)', () => {
  const m = formatBudgetMessageWith(b({
    perSessionBreached: true,
    fleetBreached: false,
    alerted: true,
    topOffender: { id: 'abc', host: 'ec2-1-2-3', cwd: '/repo', summary: 'fix the bug', total: 1_100_000 },
  }), fmt);
  assert.ok(m.body.includes('ec2-1-2-3'), `body shows raw host: ${m.body}`);
});

console.log('\nEMPTY_BUDGET: a safe disabled default');
test('is disabled + zeroed + not alerted', () => {
  assert.equal(EMPTY_BUDGET.enabled, false);
  assert.equal(EMPTY_BUDGET.alerted, false);
  assert.equal(EMPTY_BUDGET.fleetSpent, 0);
  assert.equal(EMPTY_BUDGET.threshold, 0);
});

console.log(`\n${passed} passed`);
process.exitCode = 0;
