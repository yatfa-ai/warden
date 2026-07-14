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
const { diffWatchAlerts, detectWatchCompleted, indexByWatchKey } = await import(tmpFile);
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

console.log(`\n✓ CHAT WATCH TESTS PASS (${passed})`);
