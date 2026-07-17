// Tests for chatWatch — the per-chat "watch" transition detector (WARDEN-378).
//
// The deterministic, non-LLM, per-chat, opt-in complement to the fleet-wide
// Attention desktop alert. The human marks a SPECIFIC chat "watch"; diffWatchAlerts
// decides WHEN that chat newly needs them (waiting / erroring / stuck / completed),
// firing on change-into-state ONLY — the near-zero-false-signal bar. Sibling of
// observer.js's diffAlerts (src/observer.js:383-418), lifted to the /api/agent-states
// row path.
//
// No front-end test runner in this repo, so (like desktopAlerts.test.mjs) this loads
// the REAL src/lib/chatWatch.ts (transpiled TS -> ESM via Vite's OXC transform) and
// exercises the PURE helpers with plain objects. `import type` is erased at
// transpile, so the emitted module is import-free and loads standalone.
//
// Auto-discovered by `npm test` (`node --test` runs every *.test.mjs in web/).
//
// Run: node chatWatch.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const helperPath = resolve(__dirname, 'src/lib/chatWatch.ts');

// --- Load the REAL chatWatch.ts (TS -> ESM via the OXC transform Vite bundles) ---
const src = readFileSync(helperPath, 'utf8');
const { code } = await transformWithOxc(src, helperPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-chat-watch-test-'));
const tmpFile = join(tmpDir, 'chatWatch.mjs');
writeFileSync(tmpFile, code);
const { diffWatchAlerts, detectWatchCompleted, indexByWatchKey, applyWatchCooldown, WATCH_PING_COOLDOWN_MS, currentWatchNeed, toggleWatchManyKeys } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// A /api/agent-states row, keyed by pane key. `state` is the only field the
// detector reads for the decision; `name` + `signal` ride along for the formatter.
const row = (key, state, extra = {}) => ({ id: key, key, name: key, state, ...extra });

console.log('\nfirst observation is a baseline — no fire (matches diffAlerts `if (!p) continue`)');
test('no prior for a watched key → no alert', () => {
  assert.equal(diffWatchAlerts({}, { a: row('a', 'waiting') }, ['a']).length, 0);
});
test('null prev → no alert', () => {
  assert.equal(diffWatchAlerts(null, { a: row('a', 'erroring') }, ['a']).length, 0);
});
test('null cur → no alert', () => {
  assert.equal(diffWatchAlerts({ a: row('a', 'active') }, null, ['a']).length, 0);
});

console.log('\ntransition into a needs-you state fires');
test('active → waiting fires (the watch\'s primary case)', () => {
  const [a] = diffWatchAlerts({ a: row('a', 'active') }, { a: row('a', 'waiting') }, ['a']);
  assert.equal(a.reason, 'waiting');
});
test('active → erroring fires', () => {
  const [a] = diffWatchAlerts({ a: row('a', 'active') }, { a: row('a', 'erroring') }, ['a']);
  assert.equal(a.reason, 'erroring');
});
test('active → stuck fires', () => {
  const [a] = diffWatchAlerts({ a: row('a', 'active') }, { a: row('a', 'stuck') }, ['a']);
  assert.equal(a.reason, 'stuck');
});
test('blocked → waiting fires (newly waiting, regardless of prior)', () => {
  const [a] = diffWatchAlerts({ a: row('a', 'blocked') }, { a: row('a', 'waiting') }, ['a']);
  assert.equal(a.reason, 'waiting');
});
test('active → idle fires completed (working→idle = detectCompleted fallback)', () => {
  const [a] = diffWatchAlerts({ a: row('a', 'active') }, { a: row('a', 'idle') }, ['a']);
  assert.equal(a.reason, 'completed');
});

console.log('\na transition fires ONCE across consecutive diffs (prev advances — never twice)');
test('active→waiting fires once, then waiting persists without re-firing', () => {
  let prev = {};
  const watched = ['a'];
  // poll 1: first observation — baseline, no fire
  let cur = { a: row('a', 'active') };
  assert.equal(diffWatchAlerts(prev, cur, watched).length, 0);
  prev = cur;
  // poll 2: transition active→waiting — fires exactly once
  cur = { a: row('a', 'waiting') };
  assert.equal(diffWatchAlerts(prev, cur, watched).length, 1);
  prev = cur;
  // poll 3: still waiting — no repeat (persistent state never re-fires)
  cur = { a: row('a', 'waiting') };
  assert.equal(diffWatchAlerts(prev, cur, watched).length, 0);
});

console.log('\npersistent state never re-fires');
test('waiting → waiting does NOT fire', () => {
  assert.equal(diffWatchAlerts({ a: row('a', 'waiting') }, { a: row('a', 'waiting') }, ['a']).length, 0);
});
test('erroring → erroring does NOT fire', () => {
  assert.equal(diffWatchAlerts({ a: row('a', 'erroring') }, { a: row('a', 'erroring') }, ['a']).length, 0);
});
test('stuck → stuck does NOT fire', () => {
  assert.equal(diffWatchAlerts({ a: row('a', 'stuck') }, { a: row('a', 'stuck') }, ['a']).length, 0);
});
test('idle → idle does NOT fire (no completed, no bare idle)', () => {
  assert.equal(diffWatchAlerts({ a: row('a', 'idle') }, { a: row('a', 'idle') }, ['a']).length, 0);
});

console.log('\nrecovery never fires');
test('waiting → active does NOT fire (recovery)', () => {
  assert.equal(diffWatchAlerts({ a: row('a', 'waiting') }, { a: row('a', 'active') }, ['a']).length, 0);
});
test('erroring → active does NOT fire (recovery)', () => {
  assert.equal(diffWatchAlerts({ a: row('a', 'erroring') }, { a: row('a', 'active') }, ['a']).length, 0);
});
test('stuck → idle fires completed (stuck is a working state → working→idle)', () => {
  // A stuck agent going idle resolved its loop — detectCompleted treats stuck as
  // working, so this fires 'completed', not bare idle. Documents the behavior.
  const [a] = diffWatchAlerts({ a: row('a', 'stuck') }, { a: row('a', 'idle') }, ['a']);
  assert.equal(a.reason, 'completed');
});

console.log('\nbare idle (non-working → idle) does NOT fire');
test('capture_failed → idle does NOT fire (capture_failed is not a working state)', () => {
  assert.equal(diffWatchAlerts({ a: row('a', 'capture_failed') }, { a: row('a', 'idle') }, ['a']).length, 0);
});
test('active → blocked does NOT fire (blocked is not a needs-you state)', () => {
  assert.equal(diffWatchAlerts({ a: row('a', 'active') }, { a: row('a', 'blocked') }, ['a']).length, 0);
});

console.log('\nonly WATCHED keys are considered');
test('a transition on an un-watched key produces no alert', () => {
  const prev = { a: row('a', 'active'), b: row('b', 'active') };
  const cur = { a: row('a', 'waiting'), b: row('b', 'waiting') };
  const alerts = diffWatchAlerts(prev, cur, ['a']);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].key, 'a');
});
test('an empty watched set produces no alerts', () => {
  assert.equal(diffWatchAlerts({ a: row('a', 'active') }, { a: row('a', 'waiting') }, []).length, 0);
});
test('a watched key absent this poll is skipped (no fire; caller keeps prior)', () => {
  assert.equal(diffWatchAlerts({ a: row('a', 'active') }, {}, ['a']).length, 0);
});
test('accepts a Set of watched keys (the hook passes the live set)', () => {
  const alerts = diffWatchAlerts({ a: row('a', 'active') }, { a: row('a', 'waiting') }, new Set(['a']));
  assert.equal(alerts.length, 1);
});

console.log('\nmultiple alerts sort by urgency (erroring > stuck > completed > waiting)');
test('erroring sorts before waiting', () => {
  const prev = { a: row('a', 'active'), b: row('b', 'active') };
  const cur = { a: row('a', 'waiting'), b: row('b', 'erroring') };
  const alerts = diffWatchAlerts(prev, cur, ['a', 'b']);
  assert.equal(alerts[0].reason, 'erroring');
  assert.equal(alerts[1].reason, 'waiting');
});
test('stuck sorts before completed', () => {
  const prev = { a: row('a', 'active'), b: row('b', 'active') };
  const cur = { a: row('a', 'idle'), b: row('b', 'stuck') };
  const alerts = diffWatchAlerts(prev, cur, ['a', 'b']);
  assert.equal(alerts[0].reason, 'stuck');
  assert.equal(alerts[1].reason, 'completed');
});

console.log('\nthe alert carries the row + transition states (for the targeted formatter)');
test('alert carries name + signal + from/to', () => {
  const prev = { a: row('a', 'active') };
  const cur = { a: row('a', 'waiting', { name: 'warden-worker', signal: 'press enter to continue' }) };
  const [a] = diffWatchAlerts(prev, cur, ['a']);
  assert.equal(a.row.name, 'warden-worker');
  assert.equal(a.row.signal, 'press enter to continue');
  assert.equal(a.fromState, 'active');
  assert.equal(a.toState, 'waiting');
});

console.log('\ndetectWatchCompleted: the detectCompleted fallback (src/observer.js:366)');
test('active → idle is completed', () => {
  assert.equal(detectWatchCompleted('active', 'idle'), true);
});
test('waiting → idle is completed (waiting is a working state)', () => {
  assert.equal(detectWatchCompleted('waiting', 'idle'), true);
});
test('idle → idle is NOT completed (idle is not working)', () => {
  assert.equal(detectWatchCompleted('idle', 'idle'), false);
});
test('capture_failed → idle is NOT completed (not working)', () => {
  assert.equal(detectWatchCompleted('capture_failed', 'idle'), false);
});
test('null prior → not completed', () => {
  assert.equal(detectWatchCompleted(null, 'idle'), false);
});

console.log('\nindexByWatchKey: rows keyed by pane key (fallback id)');
test('indexes rows by key', () => {
  const idx = indexByWatchKey([row('a', 'active'), row('b', 'erroring')]);
  assert.equal(idx.a.state, 'active');
  assert.equal(idx.b.state, 'erroring');
});
test('falls back to id when key is absent', () => {
  const idx = indexByWatchKey([{ id: 'only-id', state: 'stuck' }]);
  assert.equal(idx['only-id'].state, 'stuck');
});
test('null / empty rows → empty index (no crash)', () => {
  assert.deepEqual(indexByWatchKey(null), {});
  assert.deepEqual(indexByWatchKey([]), {});
});

// --- applyWatchCooldown (WARDEN-452) -----------------------------------------
// The per-key cooldown gate: a flapping watched chat produces ONE ping per need-
// episode (escalations override + reset), closing the live-channel false-positive
// vector. applyWatchCooldown reads only `key` + `reason` off each alert, so a minimal
// WatchAlert suffices (the row + transition states ride along for the fire site).
const walert = (key, reason) => ({ key, reason, row: row(key, reason), fromState: 'active', toState: reason });

console.log('\napplyWatchCooldown (WARDEN-452): one ping per flapping need-episode');
test('WATCH_PING_COOLDOWN_MS defaults to ~5 min', () => {
  assert.equal(WATCH_PING_COOLDOWN_MS, 5 * 60 * 1000);
});

test('first fire (no prior) fires + anchors the window at now', () => {
  const { fire, lastFired } = applyWatchCooldown([walert('a', 'waiting')], {}, 1000, 5000);
  assert.equal(fire.length, 1);
  assert.equal(fire[0].key, 'a');
  assert.equal(lastFired.a.reason, 'waiting');
  assert.equal(lastFired.a.firedAt, 1000);
});

test('null lastFired → every alert fires (first-fire baseline)', () => {
  const { fire, lastFired } = applyWatchCooldown([walert('a', 'waiting'), walert('b', 'erroring')], null, 1000, 5000);
  assert.equal(fire.length, 2);
  assert.equal(lastFired.a.firedAt, 1000);
  assert.equal(lastFired.b.firedAt, 1000);
});

test('same key + same reason re-entered WITHIN the window is SUPPRESSED', () => {
  const prev = { a: { reason: 'waiting', firedAt: 1000 } };
  const { fire, lastFired } = applyWatchCooldown([walert('a', 'waiting')], prev, 3000, 5000);
  assert.equal(fire.length, 0);
  // the anchor is NOT advanced — the window stays measured from the first fire
  assert.equal(lastFired.a.firedAt, 1000);
  assert.equal(lastFired.a.reason, 'waiting');
});

test('same key + same reason re-entered AFTER the window fires + re-anchors', () => {
  const prev = { a: { reason: 'waiting', firedAt: 1000 } };
  const { fire, lastFired } = applyWatchCooldown([walert('a', 'waiting')], prev, 7000, 5000);
  assert.equal(fire.length, 1);
  assert.equal(lastFired.a.firedAt, 7000);
});

test('waiting → erroring WITHIN the window is an ESCALATION → fires + resets timer', () => {
  // lower priority number = more urgent: erroring(0) < waiting(3)
  const prev = { a: { reason: 'waiting', firedAt: 1000 } };
  const { fire, lastFired } = applyWatchCooldown([walert('a', 'erroring')], prev, 3000, 5000);
  assert.equal(fire.length, 1);
  assert.equal(lastFired.a.reason, 'erroring');
  assert.equal(lastFired.a.firedAt, 3000); // reset
});

test('escalation RESETS the timer: a later same-reason re-entry is suppressed vs the NEW anchor', () => {
  // fire waiting@1000; escalate erroring@3000 (resets anchor to 3000); re-enter
  // erroring@7000. From the RESET anchor: 7000-3000=4000 < 5000 → suppressed. From
  // the original t=1000 it would be 6000 >= 5000 → fire. The suppress proves reset.
  let lastFired = {};
  let pings = 0;
  const step = (alerts, now) => {
    const r = applyWatchCooldown(alerts, lastFired, now, 5000);
    lastFired = r.lastFired;
    pings += r.fire.length;
  };
  step([walert('a', 'waiting')], 1000);  // fires (1)
  step([walert('a', 'erroring')], 3000); // escalation → fires + resets to 3000 (2)
  step([walert('a', 'erroring')], 7000); // 7000-3000=4000 < 5000 → suppressed
  assert.equal(pings, 2);
});

test('erroring → waiting WITHIN the window is LOWER urgency → suppressed', () => {
  const prev = { a: { reason: 'erroring', firedAt: 1000 } };
  const { fire } = applyWatchCooldown([walert('a', 'waiting')], prev, 3000, 5000);
  assert.equal(fire.length, 0);
});

test('waiting → completed WITHIN the window fires (completed outranks waiting on the urgency ladder)', () => {
  // Documents the deliberate WARDEN-452 choice: `completed` participates in the uniform
  // priority rule, not special-cased. completed(2) < waiting(3) → escalation → fires/reset.
  // A finished task is genuinely new, actionable info; suppressing it risks a false negative.
  const prev = { a: { reason: 'waiting', firedAt: 1000 } };
  const { fire, lastFired } = applyWatchCooldown([walert('a', 'completed')], prev, 3000, 5000);
  assert.equal(fire.length, 1);
  assert.equal(lastFired.a.reason, 'completed');
});

test('a flapping key (erroring → active → erroring each poll) → ONE ping per episode window', () => {
  const cooldown = WATCH_PING_COOLDOWN_MS;
  let lastFired = {};
  let pings = 0;
  const step = (alerts, now) => {
    const r = applyWatchCooldown(alerts, lastFired, now, cooldown);
    lastFired = r.lastFired;
    pings += r.fire.length;
  };
  // episode window [0, 5min): several re-entries into erroring
  step([walert('a', 'erroring')], 0);            // first erroring → fires (1)
  step([walert('a', 'erroring')], 60_000);       // re-entry within window → suppressed
  step([walert('a', 'erroring')], 120_000);      // suppressed
  step([walert('a', 'erroring')], 240_000);      // suppressed
  assert.equal(pings, 1);
  // after the window elapses, a re-entry fires again (a new episode)
  step([walert('a', 'erroring')], cooldown + 60_000);
  assert.equal(pings, 2);
});

test('different keys are independent (no cross-key cooldown)', () => {
  const prev = { a: { reason: 'waiting', firedAt: 1000 } };
  // key a same-reason within window → suppressed; key b no prior → fires
  const { fire } = applyWatchCooldown([walert('a', 'waiting'), walert('b', 'waiting')], prev, 3000, 5000);
  assert.equal(fire.length, 1);
  assert.equal(fire[0].key, 'b');
});

test('a key with a prior anchor but no alert this diff KEEPS its anchor (carry-forward)', () => {
  const prev = { a: { reason: 'waiting', firedAt: 1000 }, b: { reason: 'erroring', firedAt: 2000 } };
  const { fire, lastFired } = applyWatchCooldown([], prev, 3000, 5000);
  assert.equal(fire.length, 0);
  assert.equal(lastFired.a.firedAt, 1000); // preserved
  assert.equal(lastFired.b.firedAt, 2000); // preserved
});

test('the input lastFired map is NOT mutated (immutability)', () => {
  const prev = { a: { reason: 'waiting', firedAt: 1000 } };
  const { lastFired } = applyWatchCooldown([walert('a', 'waiting')], prev, 3000, 5000);
  assert.equal(prev.a.firedAt, 1000);      // input unchanged
  assert.equal(lastFired.a.firedAt, 1000); // suppressed → anchor retained
  assert.notEqual(lastFired, prev);        // a new map is returned
});

test('composes with diffWatchAlerts: a flapping chat pings once per window end-to-end', () => {
  const cooldown = 5 * 60 * 1000;
  let statePrev = {};
  let lastFired = {};
  let pings = 0;
  const watched = ['a'];
  const poll = (curState, now) => {
    const cur = { a: row('a', curState) };
    const alerts = diffWatchAlerts(statePrev, cur, watched);
    statePrev = cur;
    const r = applyWatchCooldown(alerts, lastFired, now, cooldown);
    lastFired = r.lastFired;
    pings += r.fire.length;
  };
  poll('active', 0);                                   // baseline (no alert)
  poll('erroring', 60_000);                            // active→erroring → fires (1)
  poll('active', 120_000);                             // recovery (no alert)
  poll('erroring', 180_000);                           // re-entry within window → suppressed
  poll('active', 240_000);                             // recovery
  poll('erroring', 300_000);                           // suppressed (1)
  assert.equal(pings, 1);
  // after the window from the first fire (t=60_000) elapses, a re-entry fires
  poll('active', 60_000 + cooldown + 10_000);
  poll('erroring', 60_000 + cooldown + 20_000);        // fires (2)
  assert.equal(pings, 2);
});

console.log('\ncurrentWatchNeed (WARDEN-514): current state → persistent needs-you reason');
test('waiting → waiting', () => {
  assert.equal(currentWatchNeed(row('a', 'waiting')), 'waiting');
});
test('erroring → erroring', () => {
  assert.equal(currentWatchNeed(row('a', 'erroring')), 'erroring');
});
test('stuck → stuck', () => {
  assert.equal(currentWatchNeed(row('a', 'stuck')), 'stuck');
});
test('blocked → blocked (parity with the AttentionBadge; NOT a transition ping)', () => {
  assert.equal(currentWatchNeed(row('a', 'blocked')), 'blocked');
});
test('active → null (neutral — a working chat does not need you right now)', () => {
  assert.equal(currentWatchNeed(row('a', 'active')), null);
});
test('idle → null (a finished chat is idle, never persistent "completed")', () => {
  assert.equal(currentWatchNeed(row('a', 'idle')), null);
});
test('unrecognized state (e.g. capture_failed) → null', () => {
  assert.equal(currentWatchNeed(row('a', 'capture_failed')), null);
});
test('guards a row with no state', () => {
  assert.equal(currentWatchNeed({}), null);
  assert.equal(currentWatchNeed({ state: undefined }), null);
});
test('blocked is NOT a transition ping reason (current-state only, WARDEN-514)', () => {
  // diffWatchAlerts fires change-into waiting/erroring/stuck (WATCH_DIRECT_STATES) but
  // NOT blocked — blocked is a persistent needs-you state surfaced only by
  // currentWatchNeed on the row, never a once-per-transition OS ping.
  assert.equal(diffWatchAlerts({ a: row('a', 'active') }, { a: row('a', 'blocked') }, ['a']).length, 0);
});

// ─── user-authored output-pattern alerts (WARDEN-540) ─────────────────────────
//
// diffWatchAlerts fires a 'custom' ping when a watched key NEWLY carries a
// customMatch (a user pattern matched this poll). Sibling of the state-transition
// branches: change-into only, first-observation-is-baseline, never twice.
const match = (pattern, line) => ({ pattern, line });

console.log('\ncustom-pattern match: newly-present fires once (change-into only)');
test('no prior customMatch → newly-present customMatch fires "custom"', () => {
  const prev = { a: row('a', 'active') };
  const cur = { a: row('a', 'active', { customMatch: match('Deploy', 'deploy failed') }) };
  const alerts = diffWatchAlerts(prev, cur, ['a']);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].reason, 'custom');
  // The alert's row carries the match so formatWatchMessage can name the pattern.
  assert.deepEqual(alerts[0].row.customMatch, match('Deploy', 'deploy failed'));
});
test('first observation (no prior) is a baseline — customMatch present but NO fire', () => {
  // A freshly-watched chat already matching should not immediately ping (the same
  // first-observation-is-baseline rule the state path follows).
  const alerts = diffWatchAlerts({}, { a: row('a', 'active', { customMatch: match('D', 'x') }) }, ['a']);
  assert.equal(alerts.length, 0);
});
test('persistent customMatch (both have it) does NOT re-fire', () => {
  const prev = { a: row('a', 'active', { customMatch: match('D', 'x') }) };
  const cur = { a: row('a', 'active', { customMatch: match('D', 'x') }) };
  assert.equal(diffWatchAlerts(prev, cur, ['a']).length, 0);
});
test('a custom match that CLEARS (had it, now gone) does NOT fire', () => {
  // Recovery is not a needs-you signal — only the new-APPEARANCE fires.
  const prev = { a: row('a', 'active', { customMatch: match('D', 'x') }) };
  const cur = { a: row('a', 'active') };
  assert.equal(diffWatchAlerts(prev, cur, ['a']).length, 0);
});

console.log('\ncustom takes the single per-key slot when both it + a state transition newly appear');
test('custom wins precedence over an erroring onset (one alert, reason "custom")', () => {
  // Both newly appear this tick: state flipped active→erroring AND a customMatch
  // appeared. Precedence emits ONE alert (custom) — the user explicitly opted into
  // the pattern, so its specific signal is the more useful ping. The erroring STATE
  // is still on the row (the badge shows it); only the PING label is custom. This
  // ADDS a signal without relaxing the erroring detection.
  const prev = { a: row('a', 'active') };
  const cur = { a: row('a', 'erroring', { customMatch: match('Deploy', 'deploy failed') }) };
  const alerts = diffWatchAlerts(prev, cur, ['a']);
  assert.equal(alerts.length, 1, 'exactly one alert per key per diff');
  assert.equal(alerts[0].reason, 'custom');
  assert.equal(alerts[0].row.state, 'erroring', 'the erroring state still flows on the row');
});
test('a pure state transition (no customMatch) still fires the state reason, unchanged', () => {
  // Regression guard: custom precedence must not swallow a normal erroring ping when
  // no pattern matched. Behavior identical to pre-WARDEN-540.
  const alerts = diffWatchAlerts({ a: row('a', 'active') }, { a: row('a', 'erroring') }, ['a']);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].reason, 'erroring');
});

console.log('\ncustom participates in the cooldown (a flapping match collapses to one ping/episode)');
test('a re-matching custom within the cooldown window is suppressed (flap collapse)', () => {
  // Tick 1 fired custom; tick 2 cleared; tick 3 re-matched within 5 min → suppressed.
  const now = 1_000_000;
  const a1 = { key: 'a', reason: 'custom', row: row('a', 'active', { customMatch: match('D', 'x') }), fromState: 'active', toState: 'active' };
  const { fire, lastFired } = applyWatchCooldown([a1], { a: { reason: 'custom', firedAt: now - 60_000 } }, now);
  assert.equal(fire.length, 0, 'same-reason re-match within the window is suppressed');
  assert.equal(lastFired.a.firedAt, now - 60_000, 'anchor not advanced (window measured from the real fire)');
});
test('a custom re-match AFTER the cooldown window re-fires (new episode)', () => {
  const now = 1_000_000;
  const a1 = { key: 'a', reason: 'custom', row: row('a', 'active', { customMatch: match('D', 'x') }), fromState: 'active', toState: 'active' };
  const { fire } = applyWatchCooldown([a1], { a: { reason: 'custom', firedAt: now - WATCH_PING_COOLDOWN_MS - 1 } }, now);
  assert.equal(fire.length, 1, 'a new episode re-fires once the window elapsed');
});

console.log('\ncurrentWatchNeed: a currently-matching pattern is a persistent needs-you signal');
test('a row with customMatch → "custom" (precedence over the pane state)', () => {
  assert.equal(currentWatchNeed(row('a', 'idle', { customMatch: match('D', 'x') })), 'custom');
  // Even an erroring pane with a custom match surfaces 'custom' on the row glyph —
  // the user's pattern is the specific signal worth showing at a glance.
  assert.equal(currentWatchNeed(row('a', 'erroring', { customMatch: match('D', 'x') })), 'custom');
});
test('a row with no customMatch falls through to the pane state (unchanged)', () => {
  assert.equal(currentWatchNeed(row('a', 'erroring')), 'erroring');
  assert.equal(currentWatchNeed(row('a', 'idle')), null);
});

// ---------------------------------------------------------------------------
// toggleWatchManyKeys — the WARDEN-581 bulk setter (multi-select Watch/Unwatch).
// on=true ADDS exactly the selected keys (union, order-preserving); on=false
// REMOVES exactly them (difference). Idempotent for already-watched /
// already-unwatched keys (never a duplicate, never an error).
// ---------------------------------------------------------------------------
console.log('\ntoggleWatchManyKeys (WARDEN-581): bulk watch/unwatch setter');
test('on=true: adds exactly the selected keys to an empty watched set', () => {
  assert.deepEqual(toggleWatchManyKeys([], ['a', 'b', 'c'], true), ['a', 'b', 'c']);
});
test('on=true: union preserves existing watches in order, appends new keys', () => {
  // 'a' already watched; 'b','c' new → result keeps a first, then b, c.
  assert.deepEqual(toggleWatchManyKeys(['a'], ['b', 'c'], true), ['a', 'b', 'c']);
});
test('on=true: idempotent for already-watched keys — no duplicate, no error', () => {
  const once = toggleWatchManyKeys(['a'], ['b', 'c'], true);
  const twice = toggleWatchManyKeys(once, ['b', 'c'], true);
  assert.deepEqual(twice, ['a', 'b', 'c']);
});
test('on=true: a selected key already present is not re-added (no duplicate entry)', () => {
  assert.deepEqual(toggleWatchManyKeys(['a', 'b'], ['a', 'c'], true), ['a', 'b', 'c']);
});
test('on=false: removes exactly the selected keys', () => {
  assert.deepEqual(toggleWatchManyKeys(['a', 'b', 'c'], ['b'], false), ['a', 'c']);
});
test('on=false: removes every selected key (multi)', () => {
  assert.deepEqual(toggleWatchManyKeys(['a', 'b', 'c', 'd'], ['a', 'c'], false), ['b', 'd']);
});
test('on=false: idempotent for already-unwatched keys — no error, others preserved', () => {
  // 'zzz' isn't watched; removing it is a no-op; 'a' is removed.
  assert.deepEqual(toggleWatchManyKeys(['a'], ['a', 'zzz'], false), []);
});
test('on=false on an empty watched set returns an empty array', () => {
  assert.deepEqual(toggleWatchManyKeys([], ['a'], false), []);
});
test('empty key list returns a shallow copy (no change) for on=true and on=false', () => {
  const prev = ['a', 'b'];
  const onT = toggleWatchManyKeys(prev, [], true);
  const onF = toggleWatchManyKeys(prev, [], false);
  assert.deepEqual(onT, ['a', 'b']);
  assert.deepEqual(onF, ['a', 'b']);
});
test('does not mutate the input array (returns a new array)', () => {
  const prev = ['a', 'b'];
  const out = toggleWatchManyKeys(prev, ['c'], true);
  assert.notEqual(out, prev);
  assert.deepEqual(prev, ['a', 'b']); // input untouched
  assert.deepEqual(out, ['a', 'b', 'c']);
});
test('round-trip: watch a group then unwatch it returns to the original set', () => {
  const start = ['x'];
  const watched = toggleWatchManyKeys(start, ['a', 'b'], true);
  assert.deepEqual(watched, ['x', 'a', 'b']);
  const back = toggleWatchManyKeys(watched, ['a', 'b'], false);
  assert.deepEqual(back, ['x']);
});

console.log(`\n✓ CHAT WATCH TESTS PASS (${passed})`);
