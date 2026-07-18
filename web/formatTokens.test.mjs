// Pure tests for the shared formatTokens helper (WARDEN-659): the compact,
// model-agnostic token formatter behind every token-usage surface in the app —
// the sidebar host-token-total (ChatSidebar.tsx), Fleet Health per-agent cost
// (HealthDashboard.tsx), and the fleet-budget tooltip + spent/threshold readout
// (OpenChatBrowserPage.tsx / useTokenBudget.ts).
//
// Like formatTimestamp.test.mjs, there is no FE test runner in this repo, so this
// loads the REAL src/lib/formatTokens.ts (transpiled TS -> ESM via Vite's OXC
// transform) and exercises the pure export. formatTokens has no wall-clock
// branch, so — unlike formatTimestamp — no Date.now pinning is needed; it is
// fully deterministic.
//
// Run: node formatTokens.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const helperPath = resolve(__dirname, 'src/lib/formatTokens.ts');

// --- Load the REAL formatTokens.ts (TS -> ESM via the OXC transform) ---------
const src = readFileSync(helperPath, 'utf8');
const { code } = await transformWithOxc(src, helperPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-fmttok-test-'));
const tmpFile = join(tmpDir, 'formatTokens.mjs');
writeFileSync(tmpFile, code);
const { formatTokens } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// Graceful-empty contract: a no-usage row renders no badge at all rather than a
// misleading "0 tok" / "NaN tok". The guard at formatTokens.ts:11 collapses
// null / undefined / non-finite / 0 / negative to ''. Easy to regress to "0 tok".
console.log('\nformatTokens: graceful-empty — nullish / non-finite / 0 / negative -> ""');
test('null -> ""', () => assert.equal(formatTokens(null), ''));
test('undefined -> ""', () => assert.equal(formatTokens(undefined), ''));
test('NaN -> ""', () => assert.equal(formatTokens(NaN), ''));
test('Infinity -> ""', () => assert.equal(formatTokens(Infinity), ''));
test('-Infinity -> ""', () => assert.equal(formatTokens(-Infinity), ''));
test('0 -> "" (never a misleading "0 tok")', () => assert.equal(formatTokens(0), ''));
test('negative -> ""', () => assert.equal(formatTokens(-5), ''));

// Raw sub-1k tier (formatTokens.ts:12): a token count under a thousand is the
// most precise and rare enough to spell out — `${n} tok`.
console.log('\nformatTokens: raw sub-1k tier -> `${n} tok`');
test('1 -> "1 tok"', () => assert.equal(formatTokens(1), '1 tok'));
test('500 -> "500 tok"', () => assert.equal(formatTokens(500), '500 tok'));
test('999 -> "999 tok"', () => assert.equal(formatTokens(999), '999 tok'));

// k tier + compact1 rounding (formatTokens.ts:13 + :19). compact1 rounds to one
// decimal and drops a trailing ".0" via String(): 1.0 -> "1", 1.234 -> "1.2".
console.log('\nformatTokens: k tier + compact1 rounding (trailing ".0" dropped)');
test('1000 -> "1k tok"', () => assert.equal(formatTokens(1000), '1k tok'));
test('1234 -> "1.2k tok" (one decimal)', () => assert.equal(formatTokens(1234), '1.2k tok'));
test('12000 -> "12k tok" (trailing ".0" dropped, not "12.0k")', () =>
  assert.equal(formatTokens(12000), '12k tok'));
// Boundary pin: the < 1_000_000 gate is on the RAW n before scaling, so 999_999
// renders as "1000k tok" — NOT "1M". A "tidy this up" refactor that scales first
// would silently relabel a 999k-token session as 1M.
test('999999 -> "1000k tok" (boundary pin: NOT "1M" — gate is on raw n)', () =>
  assert.equal(formatTokens(999999), '1000k tok'));

// M tier + compact1 rounding (formatTokens.ts:14 + :19). Same one-decimal-then-
// drop rule applied to millions.
console.log('\nformatTokens: M tier + compact1 rounding');
test('1_000_000 -> "1M tok"', () => assert.equal(formatTokens(1_000_000), '1M tok'));
test('1_200_000 -> "1.2M tok" (one decimal)', () =>
  assert.equal(formatTokens(1_200_000), '1.2M tok'));
test('23_500_000 -> "23.5M tok" (one decimal)', () =>
  assert.equal(formatTokens(23_500_000), '23.5M tok'));
test('12_000_000 -> "12M tok" (trailing ".0" dropped, not "12.0M")', () =>
  assert.equal(formatTokens(12_000_000), '12M tok'));

console.log(`\n✓ FORMAT TOKENS TESTS PASS (${passed})`);
