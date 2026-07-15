// Tests for watchCatchup — the durable in-app catch-up for per-chat "watch" pings
// that fired while the human was AWAY (WARDEN-417). The false-NEGATIVE half of the
// Observer Job #1 trust bar: WARDEN-390 closed the false-positive half; this closes
// the miss half for WARDEN-378's single-channel OS ping.
//
// No front-end test runner in this repo, so (like chatWatch.test.mjs /
// desktopAlerts.test.mjs / whatsNew.test.mjs) this loads the REAL
// src/lib/watchCatchup.ts (transpiled TS -> ESM via Vite's OXC transform) and
// exercises the PURE helpers with plain objects. `import type` is erased at
// transpile, so the emitted module is import-free and loads standalone.
//
// The localStorage I/O helpers (load/save/record/stamp) use a minimal in-memory
// shim; the "never throws on quota" path is covered by a shim whose setItem throws.
//
// Auto-discovered by `npm test` (`node --test` runs every *.test.mjs in web/).
//
// Run: node watchCatchup.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libPath = resolve(__dirname, 'src/lib/watchCatchup.ts');

// --- Load the REAL watchCatchup.ts (TS -> ESM via the OXC transform Vite bundles) -
const src = readFileSync(libPath, 'utf8');
const { code } = await transformWithOxc(src, libPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-watch-catchup-test-'));
const tmpFile = join(tmpDir, 'watchCatchup.mjs');
writeFileSync(tmpFile, code);
const {
  WATCH_MISS_LOG_KEY,
  WATCH_MISS_SEEN_KEY,
  WATCH_MISS_LOG_MAX,
  toWatchMiss,
  appendWatchMiss,
  withoutKey,
  inAwayWindow,
  awayMisses,
  reconcileAwayMisses,
  formatWatchMiss,
  formatCatchupSummary,
  loadWatchMissLog,
  saveWatchMissLog,
  getWatchSeen,
  stampWatchSeen,
  recordWatchMiss,
  shouldRecordMiss,
} = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

// --- Minimal localStorage shim (getItem/setItem/removeItem) -------------------
// Backed by a Map; reset before each I/O section so tests are independent. A
// second, quota-throwing variant is swapped in for the "never throws" tests.
const store = new Map();
const resetStore = () => store.clear();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

// Row + miss builders so cases read as scenarios, not walls of literals. `row`
// mirrors the AgentStateRow shape the fire site passes (key, id, name, state,
// signal). `miss` builds a WatchMiss directly for the pure helpers.
const row = (id, over = {}) => ({
  id,
  key: over.key ?? id,
  name: over.name ?? id,
  state: over.state ?? 'waiting',
  signal: Object.prototype.hasOwnProperty.call(over, 'signal') ? over.signal : 'press enter',
});
const miss = (key, over = {}) => ({
  key,
  reason: over.reason ?? 'waiting',
  name: over.name ?? key,
  signal: Object.prototype.hasOwnProperty.call(over, 'signal') ? over.signal : undefined,
  firedAt: over.firedAt ?? 1000,
});

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// ---------------------------------------------------------------------------
console.log('toWatchMiss: captures {name, signal} the lost OS ping would have shown');

test('builds a miss with key/name/reason/signal/firedAt', () => {
  const m = toWatchMiss(row('a', { name: 'Agent A', signal: 'press enter' }), 'waiting', 5000);
  assert.equal(m.key, 'a');
  assert.equal(m.name, 'Agent A');
  assert.equal(m.reason, 'waiting');
  assert.equal(m.signal, 'press enter');
  assert.equal(m.firedAt, 5000);
});
test('key falls back to id when key is absent', () => {
  const m = toWatchMiss({ id: 'only-id', state: 'stuck', name: 'X' }, 'stuck', 1);
  assert.equal(m.key, 'only-id');
});
test('name falls back to key then id', () => {
  assert.equal(toWatchMiss({ id: 'i', key: 'k', state: 'waiting' }, 'waiting', 1).name, 'k');
  assert.equal(toWatchMiss({ id: 'i', state: 'waiting' }, 'waiting', 1).name, 'i');
});
test('a blank signal becomes undefined (no empty-string quote)', () => {
  assert.equal(toWatchMiss(row('a', { signal: '' }), 'waiting', 1).signal, undefined);
  assert.equal(toWatchMiss(row('a', { signal: null }), 'waiting', 1).signal, undefined);
});

// ---------------------------------------------------------------------------
console.log('\nappendWatchMiss: bounded ring buffer (oldest evicted)');

test('appends to an empty log', () => {
  assert.deepEqual(appendWatchMiss([], miss('a')), [miss('a')]);
});
test('evicts the OLDEST when over the cap (FIFO)', () => {
  const cap = 3;
  const log = [miss('a', { firedAt: 1 }), miss('b', { firedAt: 2 }), miss('c', { firedAt: 3 })];
  const next = appendWatchMiss(log, miss('d', { firedAt: 4 }), cap);
  assert.equal(next.length, 3);
  assert.deepEqual(next.map((m) => m.key), ['b', 'c', 'd']); // 'a' evicted
});
test('the default cap is WATCH_MISS_LOG_MAX', () => {
  const log = Array.from({ length: WATCH_MISS_LOG_MAX }, (_, i) => miss(`k${i}`, { firedAt: i }));
  const next = appendWatchMiss(log, miss('new', { firedAt: 9999 }));
  assert.equal(next.length, WATCH_MISS_LOG_MAX);
  assert.equal(next[next.length - 1].key, 'new'); // newest kept
  assert.equal(next[0].key, 'k1'); // k0 evicted (oldest)
});
test('does not mutate the input log (immutable)', () => {
  const log = [miss('a')];
  appendWatchMiss(log, miss('b'));
  assert.equal(log.length, 1); // unchanged
});
test('never throws when persisting fails (quota) — recordWatchMiss', () => {
  resetStore();
  const realSet = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = () => { throw new Error('QuotaExceeded'); };
  let threw = false;
  try {
    recordWatchMiss(row('a'), 'waiting', 1);
  } catch {
    threw = true;
  }
  globalThis.localStorage.setItem = realSet;
  assert.equal(threw, false);
});

// ---------------------------------------------------------------------------
console.log('\ninAwayWindow: at/after the boundary counts; strictly-before does not');

test('a miss AT the boundary counts (>=)', () => {
  assert.equal(inAwayWindow(miss('a', { firedAt: 100 }), 100), true);
});
test('a miss AFTER the boundary counts', () => {
  assert.equal(inAwayWindow(miss('a', { firedAt: 150 }), 100), true);
});
test('a miss strictly BEFORE the boundary does not count', () => {
  assert.equal(inAwayWindow(miss('a', { firedAt: 99 }), 100), false);
});
test('boundary 0 (never acked) includes every recorded miss', () => {
  assert.equal(inAwayWindow(miss('a', { firedAt: 1 }), 0), true);
});

// ---------------------------------------------------------------------------
console.log('\nawayMisses: filter + dedup newest-per-key + newest-first');

test('filters to the away window only', () => {
  const log = [miss('a', { firedAt: 50 }), miss('b', { firedAt: 150 })];
  const out = awayMisses(log, 100);
  assert.deepEqual(out.map((m) => m.key), ['b']); // 'a' (50) is strictly before
});
test('dedupes to the NEWEST miss per key (a flapping chat surfaces once)', () => {
  const log = [
    miss('a', { reason: 'waiting', firedAt: 100 }),
    miss('a', { reason: 'erroring', firedAt: 200 }), // later, more actionable
  ];
  const out = awayMisses(log, 0);
  assert.equal(out.length, 1);
  assert.equal(out[0].reason, 'erroring'); // newest wins
});
test('orders newest-first across keys', () => {
  const log = [
    miss('old', { firedAt: 10 }),
    miss('newest', { firedAt: 300 }),
    miss('mid', { firedAt: 200 }),
  ];
  const out = awayMisses(log, 0);
  assert.deepEqual(out.map((m) => m.key), ['newest', 'mid', 'old']);
});
test('empty log → empty surface', () => {
  assert.deepEqual(awayMisses([], 0), []);
});

// ---------------------------------------------------------------------------
console.log('\nawayMisses urgency ranking: erroring > stuck > completed > waiting [WARDEN-476]');
//
// The sort changed from purely firedAt-desc to URGENCY (WATCH_REASON_PRIORITY) with a
// firedAt-desc tiebreak (WARDEN-476 goal #2: a live "erroring" no longer ranks below a
// trivial "finished a task"). Same-reason inputs still fall back to firedAt-desc, so the
// prior newest-first behaviour is preserved for an equal-reason set.

test('ranks a live erroring ABOVE a trivial completed (the goal #2 example)', () => {
  const log = [
    miss('done', { reason: 'completed', firedAt: 300 }), // later, but lower urgency
    miss('err', { reason: 'erroring', firedAt: 100 }),   // earlier, but most urgent
  ];
  assert.deepEqual(awayMisses(log, 0).map((m) => m.key), ['err', 'done']);
});
test('full urgency order across reasons: erroring, stuck, completed, waiting', () => {
  const log = [
    miss('w', { reason: 'waiting', firedAt: 500 }),
    miss('c', { reason: 'completed', firedAt: 400 }),
    miss('s', { reason: 'stuck', firedAt: 300 }),
    miss('e', { reason: 'erroring', firedAt: 200 }),
  ];
  assert.deepEqual(awayMisses(log, 0).map((m) => m.key), ['e', 's', 'c', 'w']);
});
test('same reason → firedAt-desc tiebreak (newest first) is preserved', () => {
  const log = [
    miss('old', { reason: 'erroring', firedAt: 10 }),
    miss('new', { reason: 'erroring', firedAt: 300 }),
    miss('mid', { reason: 'erroring', firedAt: 200 }),
  ];
  assert.deepEqual(awayMisses(log, 0).map((m) => m.key), ['new', 'mid', 'old']);
});

// ---------------------------------------------------------------------------
console.log('\nreconcileAwayMisses: suppress recovered, keep completed + no-snapshot [WARDEN-476]');
//
// The read-time reconciliation against the chats' CURRENT states: a watched chat that
// needed the human while away but has since recovered does NOT appear as a current need.
// 'completed' is exempt (it always lands on idle — the healthy state — so a naive
// needs-you suppress would drop every completed miss); a key with no current snapshot is
// kept (suppressing without confirming recovery would risk a false negative).

// currentByKey builder: a key→AgentStateRow index of the watched chats' current states.
const states = (entries) => Object.fromEntries(entries.map(([k, state]) => [k, row(k, { state })]));

test('suppresses a miss whose chat recovered (current state no longer needs-you)', () => {
  const misses = [miss('a', { reason: 'erroring', firedAt: 100 })];
  assert.deepEqual(reconcileAwayMisses(misses, states([['a', 'active']])).map((m) => m.key), []);
});
test('KEEPS a miss whose chat is STILL needs-you (erroring → now waiting)', () => {
  const misses = [miss('a', { reason: 'erroring', firedAt: 100 })];
  assert.deepEqual(reconcileAwayMisses(misses, states([['a', 'waiting']])).map((m) => m.key), ['a']);
});
test('KEEPS a miss whose key has NO current snapshot (cannot confirm recovery)', () => {
  const misses = [miss('a', { reason: 'erroring', firedAt: 100 })];
  assert.deepEqual(reconcileAwayMisses(misses, states([['b', 'active']])).map((m) => m.key), ['a']);
});
test('KEEPS a completed miss though its landing state idle is not needs-you', () => {
  const misses = [miss('a', { reason: 'completed', firedAt: 100 })];
  assert.deepEqual(reconcileAwayMisses(misses, states([['a', 'idle']])).map((m) => m.key), ['a']);
});
test('null currentByKey is a no-op (keeps everything — the pre-poll default)', () => {
  const misses = [miss('a', { reason: 'erroring' }), miss('b', { reason: 'waiting' })];
  assert.equal(reconcileAwayMisses(misses, null).length, 2);
});
test('empty currentByKey keeps everything (every key absent → keep)', () => {
  assert.equal(reconcileAwayMisses([miss('a', { reason: 'erroring' })], {}).length, 1);
});
test('mixed: drops only the recovered one and preserves the urgency order', () => {
  // awayMisses would urgency-rank these erroring(0) < completed(2) < waiting(3); feed
  // them pre-ranked and assert reconcile drops ONLY the recovered chat, preserving order.
  const misses = [
    miss('err', { reason: 'erroring', firedAt: 100 }),  // still erroring → keep
    miss('done', { reason: 'completed', firedAt: 200 }), // completed → keep (lands idle)
    miss('wait', { reason: 'waiting', firedAt: 300 }),   // recovered to active → drop
  ];
  const cur = states([['err', 'erroring'], ['done', 'idle'], ['wait', 'active']]);
  assert.deepEqual(reconcileAwayMisses(misses, cur).map((m) => m.key), ['err', 'done']);
});
test('does not mutate the input array', () => {
  const misses = [miss('a', { reason: 'erroring' })];
  reconcileAwayMisses(misses, states([['a', 'active']]));
  assert.equal(misses.length, 1);
});

// ---------------------------------------------------------------------------
console.log('\nwithoutKey: per-key ack-on-open (drop one chat, keep the rest)');

test('drops only the named key', () => {
  const log = [miss('a', { firedAt: 1 }), miss('b', { firedAt: 2 }), miss('a', { firedAt: 3 })];
  const out = withoutKey(log, 'a');
  assert.deepEqual(out.map((m) => m.key), ['b']); // both 'a' entries gone
});
test('does not mutate the input log', () => {
  const log = [miss('a'), miss('b')];
  withoutKey(log, 'a');
  assert.equal(log.length, 2);
});

// ---------------------------------------------------------------------------
console.log('\nformatWatchMiss: names the chat + quotes the reason/signal (WARDEN-68 bar)');

test('name · reason — quoted signal when present', () => {
  assert.equal(
    formatWatchMiss(miss('a', { name: 'Agent A', reason: 'waiting', signal: 'press enter' })),
    "Agent A · waiting for your input — 'press enter'",
  );
});
test('no trailing quote when signal is absent', () => {
  assert.equal(
    formatWatchMiss(miss('a', { name: 'Agent A', reason: 'erroring', signal: undefined })),
    'Agent A · erroring',
  );
});
test('name falls back to key when name missing', () => {
  assert.equal(formatWatchMiss(miss('k', { name: 'k', reason: 'stuck' })), 'k · stuck (repeating output)');
});
test('completed reason phrasing', () => {
  assert.equal(formatWatchMiss(miss('a', { name: 'A', reason: 'completed' })), 'A · finished a task');
});

// ---------------------------------------------------------------------------
console.log('\nformatCatchupSummary: exact pluralization, empty → ""');

test('one miss → singular', () => {
  assert.equal(formatCatchupSummary([miss('a')]), '1 watched chat needed you while you were away');
});
test('three misses → plural', () => {
  assert.equal(
    formatCatchupSummary([miss('a'), miss('b'), miss('c')]),
    '3 watched chats needed you while you were away',
  );
});
test('empty → empty string (caller hides the surface)', () => {
  assert.equal(formatCatchupSummary([]), '');
});

// ---------------------------------------------------------------------------
console.log('\nack path: a seen/opened alert is not re-surfaced');

test('dismiss (advance seen boundary) excludes every prior miss', () => {
  const log = [miss('a', { firedAt: 100 }), miss('b', { firedAt: 200 })];
  const before = awayMisses(log, 0);
  assert.equal(before.length, 2);
  // ack: stamp past the newest firedAt
  const seen = 300;
  assert.equal(awayMisses(log, seen).length, 0); // none re-surface
});
test('a miss fired AFTER the ack boundary re-surfaces (fresh away period)', () => {
  const log = [miss('a', { firedAt: 100 }), miss('b', { firedAt: 400 })];
  assert.deepEqual(awayMisses(log, 300).map((m) => m.key), ['b']); // only the post-ack one
});
test('open-one (withoutKey) drops only that chat — the other still surfaces', () => {
  const log = [miss('a', { firedAt: 100 }), miss('b', { firedAt: 200 })];
  const afterOpen = withoutKey(log, 'a');
  assert.deepEqual(awayMisses(afterOpen, 0).map((m) => m.key), ['b']);
});

// ---------------------------------------------------------------------------
console.log('\nlocalStorage I/O: round-trip + absent/corrupt safety');

test('loadWatchMissLog returns [] when absent', () => {
  resetStore();
  assert.deepEqual(loadWatchMissLog(), []);
});
test('loadWatchMissLog returns [] when corrupt (never throws)', () => {
  resetStore();
  store.set(WATCH_MISS_LOG_KEY, '{not json');
  assert.deepEqual(loadWatchMissLog(), []);
});
test('loadWatchMissLog returns [] when not an array', () => {
  resetStore();
  store.set(WATCH_MISS_LOG_KEY, JSON.stringify({ nope: true }));
  assert.deepEqual(loadWatchMissLog(), []);
});
test('save → load round-trips the log', () => {
  resetStore();
  const log = [miss('a', { firedAt: 1 }), miss('b', { firedAt: 2 })];
  saveWatchMissLog(log);
  const back = loadWatchMissLog();
  assert.equal(back.length, 2);
  assert.equal(back[0].key, 'a');
  assert.equal(back[1].firedAt, 2);
});
test('getWatchSeen is 0 when never set', () => {
  resetStore();
  assert.equal(getWatchSeen(), 0);
});
test('stampWatchSeen writes a parseable epoch and getWatchSeen reads it', () => {
  resetStore();
  stampWatchSeen(4242);
  assert.equal(getWatchSeen(), 4242);
  assert.equal(store.get(WATCH_MISS_SEEN_KEY), '4242');
});
test('saveWatchMissLog never throws on quota (console.warn)', () => {
  resetStore();
  const realSet = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = () => { throw new Error('QuotaExceeded'); };
  let threw = false;
  try {
    saveWatchMissLog([miss('a')]);
  } catch {
    threw = true;
  }
  globalThis.localStorage.setItem = realSet;
  assert.equal(threw, false);
});
test('recordWatchMiss appends + persists (load sees it)', () => {
  resetStore();
  recordWatchMiss(row('a', { name: 'A', signal: 'hi' }), 'waiting', 9001);
  const back = loadWatchMissLog();
  assert.equal(back.length, 1);
  assert.equal(back[0].key, 'a');
  assert.equal(back[0].name, 'A');
  assert.equal(back[0].signal, 'hi');
  assert.equal(back[0].firedAt, 9001);
});
test('recordWatchMiss respects the ring-buffer cap (never grows unbounded)', () => {
  resetStore();
  for (let i = 0; i < WATCH_MISS_LOG_MAX + 5; i++) recordWatchMiss(row(`k${i}`), 'waiting', i);
  const back = loadWatchMissLog();
  assert.equal(back.length, WATCH_MISS_LOG_MAX);
  assert.equal(back[back.length - 1].key, `k${WATCH_MISS_LOG_MAX + 4}`); // newest kept
});

// ---------------------------------------------------------------------------
console.log('\nshouldRecordMiss: the recording gate (OS channel lost OR human away) [WARDEN-417]');
//
// The recording decision that carries BOTH measurable outcomes of WARDEN-417:
// "recover the miss" (record when the OS lost it OR the human is away) and
// "no stale noise" (do NOT record a ping the OS delivered to a present human).
// Extracted PURE so the gate — previously untested inline logic at the fire site
// (the gap Issue 3 flagged) — is exercised directly across all four quadrants.

test('OS delivered + present (visible) → NOT recorded (human saw it; no stale noise)', () => {
  assert.equal(shouldRecordMiss(true, 'visible'), false);
});
test('OS lost (not delivered) + present → recorded (catch-up is the only channel)', () => {
  assert.equal(shouldRecordMiss(false, 'visible'), true);
});
test('OS delivered + away (hidden) → recorded (may yet be cleared/DND — the "cleared" case)', () => {
  assert.equal(shouldRecordMiss(true, 'hidden'), true);
});
test('OS lost + away → recorded (both arms agree)', () => {
  assert.equal(shouldRecordMiss(false, 'hidden'), true);
});
test('the away arm is what recovers the success-criterion "cleared" case', () => {
  // A Notification that constructed (delivered=true) but was cleared / DND'd while the
  // human was away is still recorded via the away arm — fireWatchNotification returns
  // true (it constructed) yet the ping may be unseen, so only the away arm recovers it.
  assert.equal(shouldRecordMiss(true, 'hidden'), true);
});
test('present-and-delivered is the ONE combination never recorded (not a second channel)', () => {
  // This is the converse of the success criterion: a ping the OS delivered to a human
  // who is present is never recorded, so it can never re-surface as stale catch-up.
  assert.equal(shouldRecordMiss(true, 'visible'), false);
});
test('walked-away-visible + OS lost IS recovered (the !delivered arm, not gated on hidden)', () => {
  // Blocker 2's recoverable subcase: the human walked away leaving Warden visible, and
  // the OS channel failed. The !delivered arm records it (visibility !== 'hidden' yet
  // recorded) — the pure-hidden gate the first attempt shipped would have discarded it.
  assert.equal(shouldRecordMiss(false, 'visible'), true);
});

console.log(`\n✓ WATCH CATCHUP TESTS PASS (${passed})`);
