// Unit tests for the pure token-spend budget logic (WARDEN-415).
//
// computeBudgetState: window filter (active sessions only) + lifetime-total
// summation + fleet/per-session threshold check + top-offender selection.
// shouldFireBudgetAlert: the fire-once-per-crossing debounce.
//
// Pure + dependency-free, so this loads the REAL src/budget.js under `node
// --test src` with no fixtures/SSH. Mirrors the contract documented in budget.js:
//   - the window filters SESSIONS (mtime within now-windowMs), but each
//     contributes its FULL lifetime total (approximation (a) per the ticket);
//   - sessions with no usage (tokenUsage null) contribute 0 and can't be the
//     offender;
//   - fleetBreached || perSessionBreached → alerted;
//   - shouldFireBudgetAlert fires ONLY on !prev.alerted → next.alerted.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBudgetState,
  shouldFireBudgetAlert,
  resolveBudgetConfig,
  DEFAULT_TOKEN_BUDGET_THRESHOLD,
  DEFAULT_TOKEN_BUDGET_PER_SESSION_THRESHOLD,
  DEFAULT_TOKEN_BUDGET_WINDOW_HOURS,
} from './budget.js';

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const WIN_24H = DEFAULT_TOKEN_BUDGET_WINDOW_HOURS * HOUR;

// A window-active session: mtime = now (just touched). `old` shifts mtime outside
// the window so it's excluded from the sum.
const sess = (id, total, opts = {}) => ({
  id,
  host: opts.host || 'h1',
  cwd: opts.cwd || '/p',
  summary: opts.summary || id,
  mtime: opts.old ? NOW - WIN_24H - HOUR : opts.mtime ?? NOW,
  tokenUsage: total == null ? null : { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total },
});

const compute = (sessions, over = {}) => computeBudgetState(sessions, {
  now: NOW,
  windowMs: WIN_24H,
  threshold: DEFAULT_TOKEN_BUDGET_THRESHOLD,
  perSessionThreshold: DEFAULT_TOKEN_BUDGET_PER_SESSION_THRESHOLD,
  ...over,
});

describe('computeBudgetState — window filter + summation', () => {
  it('sums the lifetime totals of sessions active in the window', () => {
    const b = compute([sess('a', 500_000), sess('b', 300_000), sess('c', 200_000)]);
    assert.equal(b.fleetSpent, 1_000_000);
    assert.equal(b.sessionCount, 3);
    assert.equal(b.fleetBreached, false); // 1M < 2M default
    assert.equal(b.alerted, false);
  });

  it('excludes sessions whose mtime is outside the window', () => {
    // c is old (outside 24h) — even with a huge total it must NOT count.
    const b = compute([sess('a', 500_000), sess('c', 9_000_000, { old: true })]);
    assert.equal(b.fleetSpent, 500_000);
    assert.equal(b.sessionCount, 1);
  });

  it('treats a session active exactly at the cutoff boundary as in-window', () => {
    const b = compute([sess('a', 2_500_000, { mtime: NOW - WIN_24H })]);
    assert.equal(b.sessionCount, 1);
    assert.equal(b.fleetSpent, 2_500_000);
  });

  it('skips sessions with null/absent usage (contribute 0, never the offender)', () => {
    const b = compute([sess('noUsage', null), sess('a', 400_000)]);
    assert.equal(b.fleetSpent, 400_000);
    assert.equal(b.sessionCount, 2); // both active, both counted as rows
    assert.equal(b.topOffender.id, 'a');
  });

  it('is defensive against null/empty/non-array input', () => {
    for (const input of [null, undefined, [], [null, undefined]]) {
      const b = compute(input);
      assert.equal(b.fleetSpent, 0);
      assert.equal(b.alerted, false);
      assert.equal(b.topOffender, null);
    }
  });
});

describe('computeBudgetState — thresholds + offender', () => {
  it('flags fleetBreached when aggregate spend crosses the fleet threshold', () => {
    const b = compute([sess('a', 1_200_000), sess('b', 900_000)]); // 2.1M >= 2M
    assert.equal(b.fleetSpent, 2_100_000);
    assert.equal(b.fleetBreached, true);
    assert.equal(b.alerted, true);
  });

  it('flags perSessionBreached when one session crosses the per-session threshold', () => {
    // Fleet is under 2M, but one session burned 1.1M >= 1M → the specific runaway.
    const b = compute([sess('runaway', 1_100_000), sess('b', 300_000)]);
    assert.equal(b.fleetBreached, false);
    assert.equal(b.perSessionBreached, true);
    assert.equal(b.alerted, true);
    assert.equal(b.topOffender.id, 'runaway');
    assert.equal(b.topOffender.total, 1_100_000);
  });

  it('selects the single heaviest active session as the offender (stable on ties)', () => {
    const b = compute([sess('a', 100_000), sess('b', 900_000), sess('c', 500_000)]);
    assert.equal(b.topOffender.id, 'b');
    // Ties resolve to first-seen.
    const tied = compute([sess('first', 800_000), sess('second', 800_000)]);
    assert.equal(tied.topOffender.id, 'first');
  });

  it('disables the per-session alarm when its threshold is 0/null', () => {
    const b = compute([sess('huge', 50_000_000)], { perSessionThreshold: 0 });
    assert.equal(b.perSessionBreached, false);
    // fleet threshold still applies (50M >= 2M).
    assert.equal(b.fleetBreached, true);
    assert.equal(b.alerted, true);
  });

  it('disables the fleet alarm when its threshold is 0', () => {
    const b = compute([sess('a', 1_000_000)], { threshold: 0, perSessionThreshold: 0 });
    assert.equal(b.fleetBreached, false);
    assert.equal(b.perSessionBreached, false);
    assert.equal(b.alerted, false);
  });

  it('stamps evaluatedAt + echoes the resolved config', () => {
    const b = compute([sess('a', 100)], { threshold: 7, perSessionThreshold: 9 });
    assert.equal(b.evaluatedAt, NOW);
    assert.equal(b.threshold, 7);
    assert.equal(b.perSessionThreshold, 9);
    assert.equal(b.windowMs, WIN_24H);
  });
});

describe('computeBudgetState — per-session usage map (WARDEN-466)', () => {
  it('returns the per-session usage entries it previously computed and discarded', () => {
    // The whole point of WARDEN-466: this distribution was summed into fleetSpent
    // + reduced to the single topOffender, then thrown away. Now it comes back so
    // /api/health can join each live agent's total to its row.
    const b = compute([sess('a', 500_000, { cwd: '/p/a' }), sess('b', 300_000, { cwd: '/p/b' })]);
    assert.deepEqual(b.sessionUsage, [
      { id: 'a', host: 'h1', cwd: '/p/a', total: 500_000 },
      { id: 'b', host: 'h1', cwd: '/p/b', total: 300_000 },
    ]);
  });

  it('excludes out-of-window and zero-usage sessions (only real, active spend joins)', () => {
    // 'old' is outside the 24h window; 'zero' has null usage. Neither can produce
    // a chip, so neither appears — bounding the payload to joinable rows.
    const b = compute([
      sess('a', 400_000),
      sess('old', 9_000_000, { old: true }),
      sess('zero', null),
    ]);
    assert.deepEqual(b.sessionUsage, [{ id: 'a', host: 'h1', cwd: '/p', total: 400_000 }]);
  });

  it('keeps every usage-bearing session even on a cwd+host collision', () => {
    // Two roles on one repo+host share cwd+host (the path-A collision). The map
    // returns BOTH entries — the max rollup is the /api/health join's job, not
    // the pure helper's. (The chat→session join keeps the heaviest.)
    const b = compute([
      sess('worker', 700_000, { cwd: '/repo', host: 'h1' }),
      sess('reviewer', 300_000, { cwd: '/repo', host: 'h1' }),
    ]);
    assert.equal(b.sessionUsage.length, 2);
    assert.deepEqual(b.sessionUsage.map((u) => u.id), ['worker', 'reviewer']);
  });

  it('is additive — existing fleetSpent / topOffender / breach fields are unchanged', () => {
    const b = compute([sess('a', 1_200_000), sess('b', 900_000)]);
    assert.equal(b.fleetSpent, 2_100_000);
    assert.equal(b.fleetBreached, true);
    assert.equal(b.alerted, true);
    assert.equal(b.topOffender.id, 'a');
    assert.equal(b.topOffender.total, 1_200_000);
    assert.equal(b.sessionUsage.length, 2);
  });

  it('is defensive against null/empty/non-array input', () => {
    for (const input of [null, undefined, [], [null, undefined]]) {
      const b = compute(input);
      assert.deepEqual(b.sessionUsage, []);
    }
  });
});

describe('shouldFireBudgetAlert — fire-once-per-crossing', () => {
  const st = (alerted) => ({ alerted });
  it('fires on the transition into an alerted state', () => {
    assert.equal(shouldFireBudgetAlert(st(false), st(true)), true);
  });
  it('does NOT fire while persistently over (the debounce)', () => {
    assert.equal(shouldFireBudgetAlert(st(true), st(true)), false);
  });
  it('does NOT fire on recovery', () => {
    assert.equal(shouldFireBudgetAlert(st(true), st(false)), false);
  });
  it('does NOT fire when nothing changed off', () => {
    assert.equal(shouldFireBudgetAlert(st(false), st(false)), false);
  });
  it('does NOT fire on the first observation (baseline priming)', () => {
    assert.equal(shouldFireBudgetAlert(null, st(true)), false);
    assert.equal(shouldFireBudgetAlert(st(false), null), false);
  });
});

describe('resolveBudgetConfig — defaults + window math', () => {
  it('resolves a fully-set config verbatim', () => {
    const r = resolveBudgetConfig({
      tokenBudgetThresholdTokens: 5_000_000,
      tokenBudgetPerSessionThresholdTokens: 2_500_000,
      tokenBudgetWindowHours: 12,
    });
    assert.equal(r.threshold, 5_000_000);
    assert.equal(r.perSessionThreshold, 2_500_000);
    assert.equal(r.windowHours, 12);
    assert.equal(r.windowMs, 12 * HOUR);
  });
  it('falls back to defaults for missing/invalid keys', () => {
    const r = resolveBudgetConfig({});
    assert.equal(r.threshold, DEFAULT_TOKEN_BUDGET_THRESHOLD);
    assert.equal(r.windowHours, DEFAULT_TOKEN_BUDGET_WINDOW_HOURS);
    // per-session default is 0 (opt-in), NOT the constant — the constant is the
    // config.js DEFAULT; resolveBudgetConfig treats absent as "off".
    assert.equal(r.perSessionThreshold, 0);
  });
  it('treats non-positive / NaN values as missing', () => {
    const r = resolveBudgetConfig({
      tokenBudgetThresholdTokens: -1,
      tokenBudgetWindowHours: NaN,
      tokenBudgetPerSessionThresholdTokens: 'big',
    });
    assert.equal(r.threshold, DEFAULT_TOKEN_BUDGET_THRESHOLD);
    assert.equal(r.windowHours, DEFAULT_TOKEN_BUDGET_WINDOW_HOURS);
    assert.equal(r.perSessionThreshold, 0);
  });
});
