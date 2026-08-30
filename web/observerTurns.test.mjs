// Focused tests for `decideFailObserverTurn()` and the transport-failure
// description helpers in src/lib/observerTurns.ts (WARDEN-217 retry-affordance
// coverage gap; WARDEN-1163 failure-cause capture).
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
// WARDEN-1163 added the *cause*: describeCloseCode / describeSocketFailure turn
// a CloseEvent into the sentence the chat shows. Those are pinned here too — the
// never-established vs. dropped-mid-generation split and the 1006 mapping are
// the whole point of the ticket, so they are asserted on the text itself.
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
let describeCloseCode;
let describeSocketFailure;
let GENERIC_OBSERVER_FAILURE;
try {
  ({ decideFailObserverTurn, describeCloseCode, describeSocketFailure, GENERIC_OBSERVER_FAILURE } =
    await import(tmpFile));
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

// Tiny timeline builders — only the fields decideFailObserverTurn inspects.
const user = (id = 'u') => ({ id, kind: 'user' });
const obs = (id, { streaming = false, failure = undefined, text = 'x' } = {}) => ({
  id,
  kind: 'observer',
  streaming,
  failure,
  text,
});
// A representative carried cause, for the "already failed" cases.
const cause = (message = 'Observer connection lost mid-generation: …') => ({ message });
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
test('failed observer turn -> none (already failed)', () => {
  assert.equal(
    decideFailObserverTurn([user(), obs('o1', { failure: cause(), text: '' })]).action,
    'none',
  );
});
test('failed observer followed by a meta error line -> none (error event + close)', () => {
  // The error path calls fail (synthesize) then pushes a meta line; a subsequent
  // socket close routes through fail again — must not stack a second anchor.
  // This is the WARDEN-653 single-report behavior, preserved across the carrier
  // change: `failure` is now an object, so the "already failed" test is presence,
  // not truthiness.
  assert.equal(
    decideFailObserverTurn([user(), obs('o1', { failure: cause(), text: '' }), meta()]).action,
    'none',
  );
});

console.log('\nconsecutive failed turns each get their own retry anchor');
test('prior failed turn + new user turn -> synthesize for the new turn', () => {
  const items = [user('u1'), obs('o1', { failure: cause(), text: '' }), meta(), user('u2')];
  assert.equal(decideFailObserverTurn(items).action, 'synthesize');
});
test('prior SUCCESSFUL turn + new user turn failing pre-text -> synthesize', () => {
  // The prior complete observer has NO failure, so it must not block a new anchor.
  const items = [user('u1'), obs('o1', { streaming: false, text: 'done' }), user('u2')];
  assert.equal(decideFailObserverTurn(items).action, 'synthesize');
});

console.log('\ndefensive: a failure after a completed turn still anchors');
test('complete (non-streaming, un-failed) observer as last item -> synthesize', () => {
  const items = [user(), obs('o1', { streaming: false, text: 'done' })];
  assert.equal(decideFailObserverTurn(items).action, 'synthesize');
});

// ─── WARDEN-1163: the cause a transport failure now carries ────────────────

console.log('\nclose codes map to meaning, not a bare number');
test('1006 describes an abnormal closure with no close frame (server down / dropped)', () => {
  const meaning = describeCloseCode(1006);
  assert.match(meaning, /abnormal closure/i);
  assert.match(meaning, /no close frame/i);
});
test('1006 does NOT read like a clean close, and 1000 does NOT read like an abnormal one', () => {
  // The ticket's explicit bar: these two must not render the same.
  assert.notEqual(describeCloseCode(1006), describeCloseCode(1000));
  assert.match(describeCloseCode(1000), /normally/i);
  assert.doesNotMatch(describeCloseCode(1000), /abnormal/i);
});
test('1008 describes a policy/auth rejection, distinct from both 1000 and 1006', () => {
  const policy = describeCloseCode(1008);
  assert.match(policy, /polic/i);
  assert.notEqual(policy, describeCloseCode(1000));
  assert.notEqual(policy, describeCloseCode(1006));
});
test('an unmapped code still names itself instead of producing an empty clause', () => {
  const meaning = describeCloseCode(4321);
  assert.notEqual(meaning.trim(), '');
  assert.match(meaning, /4321/);
});

console.log('\nnever-established vs. dropped-mid-generation are worded differently');
test('a socket that never opened is described as unable to establish, not as lost', () => {
  const { message } = describeSocketFailure({ code: 1006, reason: '', wasClean: false, hadOpened: false });
  assert.match(message, /could not be established/i);
  assert.doesNotMatch(message, /mid-generation/i);
});
test('a socket that had opened is described as lost mid-generation, not as unable to connect', () => {
  const { message } = describeSocketFailure({ code: 1006, reason: '', wasClean: false, hadOpened: true });
  assert.match(message, /lost mid-generation/i);
  assert.doesNotMatch(message, /could not be established/i);
});
test('the same close code produces DIFFERENT text for opened vs. never-opened', () => {
  const never = describeSocketFailure({ code: 1006, reason: '', wasClean: false, hadOpened: false });
  const dropped = describeSocketFailure({ code: 1006, reason: '', wasClean: false, hadOpened: true });
  assert.notEqual(never.message, dropped.message);
});

console.log('\nthe chat line is legible on its own (1006 carries an empty reason)');
test('1006 with an empty reason still renders a non-empty explanation and the code', () => {
  // A bare reason passthrough would render nothing at all here — this is the
  // exact case the ticket calls out.
  const { message } = describeSocketFailure({ code: 1006, reason: '', wasClean: false, hadOpened: false });
  assert.match(message, /abnormal closure/i);
  assert.match(message, /1006/);
});
test('a close frame reason is quoted into the message when the server sent one', () => {
  const { message } = describeSocketFailure({
    code: 1008,
    reason: 'unknown session',
    wasClean: true,
    hadOpened: false,
  });
  assert.match(message, /unknown session/);
});
test('a whitespace-only reason is not quoted as an empty fragment', () => {
  const { message } = describeSocketFailure({ code: 1006, reason: '   ', wasClean: false, hadOpened: false });
  assert.doesNotMatch(message, /said/i);
});

console.log('\nthe DevTools detail carries the raw diagnostic facts');
test('detail reports path, close code, reason, wasClean and hadOpened', () => {
  const { detail } = describeSocketFailure({
    code: 1011,
    reason: 'boom',
    wasClean: true,
    hadOpened: true,
  });
  assert.deepEqual(detail, {
    path: 'close',
    hadOpened: true,
    code: 1011,
    reason: 'boom',
    wasClean: true,
  });
});
test('a 1006 detail preserves the empty reason and wasClean=false verbatim', () => {
  const { detail } = describeSocketFailure({ code: 1006, reason: '', wasClean: false, hadOpened: false });
  assert.equal(detail.reason, '');
  assert.equal(detail.wasClean, false);
  assert.equal(detail.hadOpened, false);
});

console.log('\nthe backend-error path keeps its existing wording (non-regression)');
test('the generic fallback is still "Generation failed." and carries no transport detail', () => {
  // A `{type:'error'}` message renders its REAL text as a meta line; the turn
  // itself must not be rewritten into a transport-sounding string.
  assert.equal(GENERIC_OBSERVER_FAILURE.message, 'Generation failed.');
  assert.equal(GENERIC_OBSERVER_FAILURE.detail, undefined);
});
test('a turn failed with the generic fallback still counts as failed for no-stacking', () => {
  const items = [user(), obs('o1', { failure: GENERIC_OBSERVER_FAILURE, text: '' }), meta()];
  assert.equal(decideFailObserverTurn(items).action, 'none');
});

console.log(`\n✓ OBSERVERTURNS TESTS PASS (${passed})`);
