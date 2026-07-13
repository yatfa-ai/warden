// Focused tests for the pure observer-lifecycle decisions in
// src/lib/observerLifecycle.ts (WARDEN-332: wire up the dead "Auto-start
// Observer" + "Session Auto-stop" preferences).
//
// WARDEN-332 ships two preference-driven behaviors. Both decision cores were
// extracted from ObserverTabs React state into pure functions so they can be
// pinned here — the apply-side wiring (createNew / closeTab / refs / effects)
// lives in the component and is exercised by the build + type-check, while the
// *decisions* (dedup, idle selection) are unit-tested directly:
//
//   (a) hasBoundSession  — auto-start dedup: a focused chat spawns AT MOST ONE
//                          observer session (success criterion #1's "never a
//                          duplicate" half).
//   (c) selectIdleTabs   — auto-stop selection: an idle tab past N minutes is
//                          returned to close (success criterion #2).
//   (d) selectIdleTabs   — null timeout ⇒ never closes (success criterion #2).
//
// (b — "auto-start is a no-op when the pref is false") is an effect guard in the
// component (`if (!observerAutoStart) return`), not a pure decision, so it is
// not asserted here; the build/type-check covers the wiring.
//
// observerLifecycle.ts carries only a TYPE-ONLY `import type { SessionMeta }`,
// which Vite's OXC transform erases entirely (never reaches the emitted JS), so
// the same transpile-to-temp-`.mjs` + dynamic-`import()` harness used by
// observerTurns.test.mjs / chatDisplay.test.mjs works here (WARDEN-130).
//
// Run: node --test observerLifecycle.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modPath = resolve(__dirname, 'src/lib/observerLifecycle.ts');

const src = readFileSync(modPath, 'utf8');
const { code } = await transformWithOxc(src, modPath, {});
const tmpDir = mkdtempSync(join(__dirname, '.tmp-observerLifecycle-test-'));
const tmpFile = join(tmpDir, 'observerLifecycle.mjs');
writeFileSync(tmpFile, code);
let hasBoundSession, selectIdleTabs, IDLE_TICK_MS;
try {
  ({ hasBoundSession, selectIdleTabs, IDLE_TICK_MS } = await import(tmpFile));
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// Tiny session builders — only the fields the decisions inspect.
const session = (id, chatKey) => ({ id, name: id, ...(chatKey != null ? { chatKey } : {}) });
const MIN = 60_000; // one minute in ms

// ─── hasBoundSession (auto-start dedup) ───────────────────────────────────────

console.log('\nauto-start dedup — a focused chat spawns at most one observer session');
test('true when a session is already bound to the chatKey', () => {
  const sessions = [session('s1', 'chat-a'), session('s2', 'chat-b')];
  assert.equal(hasBoundSession(sessions, 'chat-a'), true);
  assert.equal(hasBoundSession(sessions, 'chat-b'), true);
});

test('false when no session is bound to the chatKey', () => {
  const sessions = [session('s1', 'chat-a')];
  assert.equal(hasBoundSession(sessions, 'chat-z'), false);
});

test('false against sessions that carry no chatKey (a manual/unbound session never blocks)', () => {
  // A session created without a focused chat has chatKey undefined/null — it must
  // NOT count as "bound" to any chat, so auto-start still spawns for that chat.
  const sessions = [session('s1'), session('s2', null)];
  assert.equal(hasBoundSession(sessions, 'chat-a'), false);
});

test('empty/null/undefined key never matches (nothing to bind)', () => {
  const sessions = [session('s1', 'chat-a')];
  assert.equal(hasBoundSession(sessions, ''), false);
  assert.equal(hasBoundSession(sessions, null), false);
  assert.equal(hasBoundSession(sessions, undefined), false);
});

test('empty session list never matches', () => {
  assert.equal(hasBoundSession([], 'chat-a'), false);
});

// ─── selectIdleTabs (auto-stop selection) ─────────────────────────────────────

console.log('\nauto-stop — an idle tab past N minutes is selected to close');
test('a tab idle past the timeout is selected to close', () => {
  const now = 1_000_000;
  const openIds = ['a', 'b'];
  // 'a' last active 31 min ago (just past a 30-min timeout); 'b' 5 min ago.
  const lastActivity = { a: now - 31 * MIN, b: now - 5 * MIN };
  assert.deepEqual(selectIdleTabs(openIds, lastActivity, 30, now), ['a']);
});

test('a tab active within the timeout is NOT selected', () => {
  const now = 1_000_000;
  const openIds = ['a'];
  const lastActivity = { a: now - 29 * MIN }; // under the 30-min threshold
  assert.deepEqual(selectIdleTabs(openIds, lastActivity, 30, now), []);
});

test('exactly at the threshold is NOT idle (strictly exceeds)', () => {
  // "exceeds N minutes" — a tab idle for exactly N minutes has not yet exceeded.
  const now = 1_000_000;
  const openIds = ['a'];
  const lastActivity = { a: now - 30 * MIN };
  assert.deepEqual(selectIdleTabs(openIds, lastActivity, 30, now), []);
});

test('multiple idle tabs are all returned, order preserved', () => {
  const now = 1_000_000;
  const openIds = ['a', 'b', 'c'];
  const lastActivity = {
    a: now - 60 * MIN, // idle
    b: now - 1 * MIN,  // fresh
    c: now - 45 * MIN, // idle
  };
  assert.deepEqual(selectIdleTabs(openIds, lastActivity, 30, now), ['a', 'c']);
});

test('a tab with NO recorded timestamp is treated as active (fail-safe)', () => {
  // The component seeds every open id with a timestamp, but if one is missing
  // we must NOT close it — closing requires a known-stale signal. Missing ⇒ keep.
  const now = 1_000_000;
  const openIds = ['a', 'b'];
  const lastActivity = { a: now - 999 * MIN }; // 'b' has no entry
  assert.deepEqual(selectIdleTabs(openIds, lastActivity, 30, now), ['a']);
});

test('empty openIds ⇒ empty result', () => {
  assert.deepEqual(selectIdleTabs([], {}, 30, 1_000_000), []);
});

console.log('\nauto-stop — a disabled timeout never closes');
test('null timeout ⇒ never closes', () => {
  const now = 1_000_000;
  const openIds = ['a', 'b'];
  const lastActivity = { a: now - 999 * MIN, b: now - 999 * MIN };
  assert.deepEqual(selectIdleTabs(openIds, lastActivity, null, now), []);
});

test('undefined timeout ⇒ never closes (treated as disabled)', () => {
  const now = 1_000_000;
  const openIds = ['a'];
  const lastActivity = { a: now - 999 * MIN };
  assert.deepEqual(selectIdleTabs(openIds, lastActivity, undefined, now), []);
});

test('non-positive timeout ⇒ never closes', () => {
  const now = 1_000_000;
  const openIds = ['a'];
  const lastActivity = { a: now - 999 * MIN };
  assert.deepEqual(selectIdleTabs(openIds, lastActivity, 0, now), []);
  assert.deepEqual(selectIdleTabs(openIds, lastActivity, -5, now), []);
});

console.log('\nshared tick cadence constant');
test('IDLE_TICK_MS is one minute (the documented tick cadence)', () => {
  assert.equal(IDLE_TICK_MS, 60_000);
});

console.log(`\n✓ OBSERVERLIFECYCLE TESTS PASS (${passed})`);
