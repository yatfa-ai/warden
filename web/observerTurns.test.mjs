// Focused tests for `decideFailObserverTurn()` in src/lib/observerTurns.ts
// (WARDEN-217: retry-affordance coverage gap).
//
// A reviewer flagged that the Observer's retry affordance only attached to an
// *already-streaming* observer message — so a backend `error` during the
// "thinking" phase (before any observer text) or a dropped stream before the
// first token left the failed turn with no retry at all. decideFailObserverTurn
// is the pure decision of how a failure is shaped (mark an in-flight stream vs.
// synthesize an empty errored turn vs. no-op), extracted from React state so it
// can be pinned here. These tests assert each failure mode resolves to a retry
// anchor — especially the pre-text error path users actually hit.
//
// There is no front-end test runner in this repo, so this file loads the REAL
// module (transpiled TS -> ESM via Vite's OXC transform) — same pattern as
// utils.test.mjs (WARDEN-130).
//
// Run: node observerTurns.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modPath = resolve(__dirname, 'src/lib/observerTurns.ts');

const src = readFileSync(modPath, 'utf8');
const { code } = await transformWithOxc(src, modPath, {});
const tmpDir = mkdtempSync(join(__dirname, '.tmp-observerTurns-test-'));
const tmpFile = join(tmpDir, 'observerTurns.mjs');
writeFileSync(tmpFile, code);
let decideFailObserverTurn;
try {
  ({ decideFailObserverTurn } = await import(tmpFile));
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

// Tiny timeline builders — only the fields decideFailObserverTurn inspects.
const user = (id = 'u') => ({ id, kind: 'user' });
const obs = (id, { streaming = false, errored = false, text = 'x' } = {}) => ({
  id,
  kind: 'observer',
  streaming,
  errored,
  text,
});
const tool = (id = 't') => ({ id, kind: 'tool', name: 'read_chat' });
const meta = (id = 'me') => ({ id, kind: 'meta', text: 'err', tone: 'error' });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

console.log('\npre-text failure (the gap) -> synthesize an empty errored turn');
test('empty timeline -> synthesize', () => {
  assert.equal(decideFailObserverTurn([]).action, 'synthesize');
});
test('turn started, no observer text yet -> synthesize (backend error during thinking)', () => {
  // This is the primary failure mode users hit: the LLM call throws on the first
  // complete() before any text streamed. Previously the turn vanished with no retry.
  assert.equal(decideFailObserverTurn([user()]).action, 'synthesize');
});
test('user + tool call, still no observer text -> synthesize', () => {
  assert.equal(decideFailObserverTurn([user(), tool()]).action, 'synthesize');
});

console.log('\nmid-text drop -> mark the in-flight stream failed (existing behavior)');
test('streaming observer turn -> mark-streaming with its id', () => {
  const d = decideFailObserverTurn([user(), obs('o1', { streaming: true })]);
  assert.equal(d.action, 'mark-streaming');
  assert.equal(d.id, 'o1');
});
test('last streaming observer after tools -> mark-streaming', () => {
  const d = decideFailObserverTurn([user(), tool(), obs('o1', { streaming: true })]);
  assert.equal(d.action, 'mark-streaming');
  assert.equal(d.id, 'o1');
});

console.log('\nno stacking — a turn already marked failed is left alone');
test('errored observer turn -> none (already failed)', () => {
  assert.equal(decideFailObserverTurn([user(), obs('o1', { errored: true, text: '' })]).action, 'none');
});
test('errored observer followed by a meta error line -> none (error event + close)', () => {
  // The error path calls fail (synthesize) then pushes a meta line; a subsequent
  // socket close routes through fail again — must not stack a second anchor.
  assert.equal(
    decideFailObserverTurn([user(), obs('o1', { errored: true, text: '' }), meta()]).action,
    'none',
  );
});

console.log('\nconsecutive failed turns each get their own retry anchor');
test('prior failed turn + new user turn -> synthesize for the new turn', () => {
  const items = [user('u1'), obs('o1', { errored: true, text: '' }), meta(), user('u2')];
  assert.equal(decideFailObserverTurn(items).action, 'synthesize');
});
test('prior SUCCESSFUL turn + new user turn failing pre-text -> synthesize', () => {
  // The prior complete observer is NOT errored, so it must not block a new anchor.
  const items = [user('u1'), obs('o1', { streaming: false, errored: false, text: 'done' }), user('u2')];
  assert.equal(decideFailObserverTurn(items).action, 'synthesize');
});

console.log('\ndefensive: a failure after a completed turn still anchors');
test('complete (non-streaming, non-errored) observer as last item -> synthesize', () => {
  const items = [user(), obs('o1', { streaming: false, errored: false, text: 'done' })];
  assert.equal(decideFailObserverTurn(items).action, 'synthesize');
});

console.log(`\n✓ OBSERVERTURNS TESTS PASS (${passed})`);
