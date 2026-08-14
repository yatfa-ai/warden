// Tests for the shared fan-out helpers in src/lib/fanout.ts (WARDEN-964,
// WARDEN-974) — both halves of every fleet-wide operation:
//
//   runFanout       — the impure POST-per-agent request loop (WARDEN-974)
//   summarizeFanout — the pure reducer over its Promise.allSettled output
//
// summarizeFanout is the SINGLE reducer behind all three fleet-wide operations —
// broadcast Send (summarizeBroadcast), batch Kill (summarizeKill) and batch
// Interrupt (summarizeKeySend) — so it is the accounting for every "N succeeded,
// M failed" toast a human sees when acting on multiple agents at once. It had no
// direct coverage: broadcast.test.mjs / kill.test.mjs / keysend.test.mjs load it
// only as a transpiled DEPENDENCY of the wrappers they test, and three of their
// comments (kill.test.mjs:246, kill.test.mjs:257, keysend.test.mjs:295)
// explicitly DEFER the defaultError + orphan-name fallbacks to "summarizeFanout"
// without ever asserting them. A silent regression here would mis-report results
// across all three operations at once, so the reducer's own branches are pinned
// here, at the shared seam, rather than three times over in the wrappers.
//
// Covered branches (the reducer has six error paths plus the name fallback):
//   1. fulfilled {ok:true}                    → counts as succeeded
//   2. fulfilled {ok:false, error}            → failure carrying that error
//   3. fulfilled {ok:false} (no error)        → failure carrying `defaultError`
//   4. rejected with an Error                 → reason.message
//   5. rejected with a non-Error              → String(reason)
//   6. rejected with a nullish reason         → 'unknown error'
//   + nameOf(id) ?? id (orphan/dead-id fallback) and total/succeeded/failed accounting.
//
// fanout.ts has NO runtime imports at all (its header notes only erased `import
// type`s), so the harness is the same transpile-to-temp-`.mjs` + dynamic
// `import()` pattern as broadcast.test.mjs — minus the dependency rewrite those
// files need for their `./fanout` specifier. The REAL module is loaded, not a
// hand-rolled re-implementation.
//
// Run: node fanout.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libDir = resolve(__dirname, 'src/lib');

// --- Load the REAL fanout.ts (TS -> ESM via OXC) ----------------------------
const fanoutSrc = readFileSync(join(libDir, 'fanout.ts'), 'utf8');
const { code } = await transformWithOxc(fanoutSrc, join(libDir, 'fanout.ts'), {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-fanout-test-'));
const tmpFile = join(tmpDir, 'fanout.mjs');
writeFileSync(tmpFile, code);
const { summarizeFanout, runFanout } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// Promise.allSettled result builders — keep the test bodies honest about shape.
const fulfilled = (value) => ({ status: 'fulfilled', value });
const rejected = (reason) => ({ status: 'rejected', reason });
const ok = fulfilled({ ok: true });
const fail = (error) => fulfilled({ ok: false, error });
const nameOf = (id) => ({ a: 'agent-a', b: 'agent-b', c: 'agent-c' }[id] || id);

// ---------------------------------------------------------------------------
console.log('\nsummarizeFanout — succeeded/failed accounting');
// ---------------------------------------------------------------------------
test('all succeed → succeeded=N, no failures', () => {
  const s = summarizeFanout([ok, ok, ok], ['a', 'b', 'c'], nameOf);
  assert.equal(s.total, 3);
  assert.equal(s.succeeded, 3);
  assert.deepEqual(s.failed, []);
});
test('empty input → empty summary (no agents selected)', () => {
  const s = summarizeFanout([], [], nameOf);
  assert.equal(s.total, 0);
  assert.equal(s.succeeded, 0);
  assert.deepEqual(s.failed, []);
});
test('succeeded + failed.length always equals total (nothing is dropped)', () => {
  const s = summarizeFanout(
    [ok, fail('e'), rejected(new Error('x')), ok, fulfilled({ ok: false })],
    ['a', 'b', 'c', 'd', 'e'],
    nameOf,
  );
  assert.equal(s.total, 5);
  assert.equal(s.succeeded + s.failed.length, s.total);
});
test('total comes from the RESULTS length (the allSettled array), not from ids', () => {
  // Every settled promise is represented; `ids` is only the parallel attribution
  // list. A longer ids array (a caller bug) must not inflate the tally.
  const s = summarizeFanout([ok, fail('e')], ['a', 'b', 'c', 'd'], nameOf);
  assert.equal(s.total, 2);
  assert.equal(s.succeeded, 1);
  assert.equal(s.failed.length, 1);
});
test('partial failure does NOT abort siblings: 1 ok + 2 fail → succeeded=1, failed=2', () => {
  // The allSettled contract guarantees every promise is represented — this
  // asserts the reducer reports all of them rather than short-circuiting.
  const s = summarizeFanout(
    [ok, fail('down'), rejected(new Error('timeout'))],
    ['a', 'b', 'c'],
    nameOf,
  );
  assert.equal(s.total, 3);
  assert.equal(s.succeeded, 1);
  assert.deepEqual(s.failed.map((f) => f.id), ['b', 'c']);
  assert.deepEqual(s.failed.map((f) => f.error), ['down', 'timeout']);
});
test('order is preserved: results[i] ↔ ids[i] (allSettled ordering)', () => {
  // The attribution is positional — a shifted pairing would blame the wrong
  // agent in the toast, the worst failure mode this reducer has.
  const s = summarizeFanout([fail('e1'), ok, fail('e3')], ['a', 'b', 'c'], nameOf);
  assert.equal(s.succeeded, 1);
  assert.deepEqual(s.failed, [
    { id: 'a', name: 'agent-a', error: 'e1' },
    { id: 'c', name: 'agent-c', error: 'e3' },
  ]);
});
test('failures are listed in input order, not grouped by kind', () => {
  const s = summarizeFanout(
    [rejected(new Error('r1')), fail('f1'), rejected(new Error('r2'))],
    ['a', 'b', 'c'],
    nameOf,
  );
  assert.deepEqual(s.failed.map((f) => f.error), ['r1', 'f1', 'r2']);
});
test('does not mutate its inputs (pure reducer)', () => {
  const results = [ok, fail('boom')];
  const ids = ['a', 'b'];
  const snapshot = JSON.stringify({ results, ids });
  summarizeFanout(results, ids, nameOf);
  assert.equal(JSON.stringify({ results, ids }), snapshot);
});

// ---------------------------------------------------------------------------
console.log('\nsummarizeFanout — fulfilled-but-not-ok branches');
// ---------------------------------------------------------------------------
test('a fulfilled {ok:false} is a FAILURE (the 404/500 shape), not a success', () => {
  const s = summarizeFanout([ok, fail('session not found'), ok], ['a', 'b', 'c'], nameOf);
  assert.equal(s.succeeded, 2);
  assert.equal(s.failed.length, 1);
  assert.deepEqual(s.failed[0], { id: 'b', name: 'agent-b', error: 'session not found' });
});
test('a fulfilled {ok:false} with no error uses the caller-supplied defaultError', () => {
  // This is the branch kill.test.mjs:246 / keysend.test.mjs:284 explicitly defer
  // to summarizeFanout: it is unreachable through the real fan-outs (they always
  // supply an `HTTP {status}` string), so this is its only assertion anywhere.
  const s = summarizeFanout([fulfilled({ ok: false })], ['a'], nameOf, 'kill failed');
  assert.equal(s.failed[0].error, 'kill failed');
});
test('defaultError defaults to "operation failed" when the caller omits it', () => {
  // The three wrappers each pass their own ('send failed' / 'kill failed' /
  // 'key send failed'); the parameter default is what a NEW caller inherits.
  const s = summarizeFanout([fulfilled({ ok: false })], ['a'], nameOf);
  assert.equal(s.failed[0].error, 'operation failed');
});
test('an EMPTY error string also falls back to defaultError (never a blank reason)', () => {
  const s = summarizeFanout([fail('')], ['a'], nameOf, 'send failed');
  assert.equal(s.failed[0].error, 'send failed');
});
test('a fulfilled result with a nullish value is a failure, not a crash', () => {
  // res.value?.ok — a malformed/absent body must not throw inside the reducer,
  // or one bad response would take down the whole fleet-operation toast.
  const s = summarizeFanout(
    [fulfilled(undefined), fulfilled(null)],
    ['a', 'b'],
    nameOf,
    'send failed',
  );
  assert.equal(s.succeeded, 0);
  assert.equal(s.failed.length, 2);
  assert.deepEqual(s.failed.map((f) => f.error), ['send failed', 'send failed']);
});
test('only a strictly ok:true value counts as succeeded (a falsy ok is a failure)', () => {
  const s = summarizeFanout(
    [fulfilled({ ok: false }), fulfilled({})],
    ['a', 'b'],
    nameOf,
    'send failed',
  );
  assert.equal(s.succeeded, 0);
  assert.equal(s.failed.length, 2);
});

// ---------------------------------------------------------------------------
console.log('\nsummarizeFanout — rejected-promise branches');
// ---------------------------------------------------------------------------
test('a rejected promise reads reason.message (a network throw)', () => {
  const s = summarizeFanout([rejected(new Error('network down'))], ['a'], nameOf);
  assert.equal(s.succeeded, 0);
  assert.equal(s.failed.length, 1);
  assert.equal(s.failed[0].error, 'network down');
  assert.equal(s.failed[0].name, 'agent-a');
});
test('an Error SUBCLASS still reads .message (instanceof, not a constructor check)', () => {
  class TimeoutError extends Error {}
  const s = summarizeFanout([rejected(new TimeoutError('timed out'))], ['a'], nameOf);
  assert.equal(s.failed[0].error, 'timed out');
});
test('a rejected non-Error reason stringifies (does not print [object Object])', () => {
  const s = summarizeFanout([rejected('boom')], ['a'], nameOf);
  assert.equal(s.failed[0].error, 'boom');
  assert.equal(s.failed[0].name, 'agent-a');
});
test('a rejected non-Error object stringifies via its own toString', () => {
  const s = summarizeFanout([rejected({ toString: () => 'custom reason' })], ['a'], nameOf);
  assert.equal(s.failed[0].error, 'custom reason');
});
test('a rejected undefined reason falls back to a readable string', () => {
  const s = summarizeFanout([rejected(undefined)], ['a'], nameOf);
  assert.equal(s.failed[0].error, 'unknown error');
});
test('a rejected null reason also falls back to "unknown error"', () => {
  const s = summarizeFanout([rejected(null)], ['a'], nameOf);
  assert.equal(s.failed[0].error, 'unknown error');
});
test('a falsy-but-PRESENT reason is kept, not replaced (?? not ||)', () => {
  // The nullish coalescing matters: a reason of 0 or '' is a real (if terse)
  // reason and must not be laundered into the generic "unknown error".
  assert.equal(summarizeFanout([rejected(0)], ['a'], nameOf).failed[0].error, '0');
  assert.equal(summarizeFanout([rejected(false)], ['a'], nameOf).failed[0].error, 'false');
});
test('the rejected path ignores defaultError (it has a real reason already)', () => {
  const s = summarizeFanout([rejected(new Error('network down'))], ['a'], nameOf, 'kill failed');
  assert.equal(s.failed[0].error, 'network down');
});

// ---------------------------------------------------------------------------
console.log('\nsummarizeFanout — per-agent name attribution');
// ---------------------------------------------------------------------------
test('a failure carries the display name from nameOf', () => {
  const s = summarizeFanout([fail('x')], ['b'], nameOf);
  assert.equal(s.failed[0].name, 'agent-b');
  assert.equal(s.failed[0].id, 'b');
});
test('an id with no name mapping falls back to the raw id', () => {
  // This is the orphan-name branch kill.test.mjs:257 / keysend.test.mjs:295
  // defer here: nameOf returns undefined (dead/unknown agent) → the failure's
  // name is the raw id, never the string "undefined", so the target stays
  // identifiable in the toast.
  const s = summarizeFanout([fail('x')], ['orphan-id'], () => undefined);
  assert.equal(s.failed[0].name, 'orphan-id');
  assert.notEqual(s.failed[0].name, 'undefined');
});
test('nameOf is called with the id positionally paired to the result', () => {
  const seen = [];
  summarizeFanout([ok, fail('x')], ['a', 'b'], (id) => { seen.push(id); return nameOf(id); });
  // Only the FAILING entry needs a name — successes never appear in the toast,
  // so the reducer must not pay for a lookup it will not use.
  assert.deepEqual(seen, ['b']);
});
test('nameOf is not consulted at all when everything succeeds', () => {
  let calls = 0;
  const s = summarizeFanout([ok, ok], ['a', 'b'], () => { calls += 1; return 'x'; });
  assert.equal(calls, 0);
  assert.equal(s.succeeded, 2);
});

// ---------------------------------------------------------------------------
console.log('\nrunFanout — shared impure request loop (mocked fetch)');
// ---------------------------------------------------------------------------
// runFanout is the impure half of the fan-out (WARDEN-974): the POST-per-agent
// loop that PRODUCES the allSettled array summarizeFanout reduces. All three
// fleet actions (Send /api/send, Kill /api/kill, Interrupt /api/key) had a
// byte-identical copy; it now lives here once, so its branches are pinned here
// — url/payload threading, the ok/{ok:false}/`HTTP {status}` outcome mapping,
// and (load-bearing) the fact that a NETWORK failure REJECTS rather than
// fulfilling, because summarizeFanout reads those two through different
// branches (reason.message vs value.error).
//
// Same globalThis.fetch mock the wrapper suites use (kill.test.mjs:196) —
// records {url, method, headers, body} per call and drives each outcome. The
// real fetch is restored after the block so nothing leaks to later tests.

const realFetch = globalThis.fetch;
// outcomes: {ok:true} | {ok:false,error,status} | {reject:'msg'} (a thrown
// fetch) | {noJson:true} (a non-ok response whose body isn't JSON) | {delay:ms}.
const mockFetch = (outcomes) => {
  let i = 0;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({
      url,
      method: opts?.method,
      headers: opts?.headers,
      body: JSON.parse(opts?.body ?? '{}'),
    });
    const o = outcomes[i++] ?? { ok: true };
    if (o.delay) await new Promise((r) => setTimeout(r, o.delay));
    if (o.reject) throw new Error(o.reject);
    return {
      ok: !!o.ok,
      status: o.ok ? 200 : (o.status ?? 500),
      json: async () => {
        if (o.noJson) throw new SyntaxError('Unexpected token < in JSON');
        return { error: o.error };
      },
    };
  };
  return calls;
};

const testAsync = async (name, fn) => {
  await fn();
  passed += 1;
  console.log('  ok -', name);
};

await testAsync('POSTs the given url once per id, in id order', async () => {
  const calls = mockFetch([{ ok: true }, { ok: true }, { ok: true }]);
  const results = await runFanout('/api/send', ['a', 'b', 'c'], (id) => ({ id }));
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => c.url), ['/api/send', '/api/send', '/api/send']);
  assert.deepEqual(calls.map((c) => c.body.id), ['a', 'b', 'c']);
  assert.equal(results.length, 3);
});

await testAsync('payloadOf builds each body from its id (multi-field payloads thread through)', async () => {
  // The keysend/broadcast shape: a per-id field PLUS an operation-wide one. A
  // dropped `key`/`text` would be a silent regression — the request would
  // succeed and do the wrong thing — so assert the exact body.
  const calls = mockFetch([{ ok: true }, { ok: true }]);
  await runFanout('/api/key', ['a', 'b'], (id) => ({ id, key: 'C-c' }));
  assert.deepEqual(calls.map((c) => c.body), [
    { id: 'a', key: 'C-c' },
    { id: 'b', key: 'C-c' },
  ]);
});

await testAsync('payloadOf is called once per id, with that id', async () => {
  mockFetch([{ ok: true }, { ok: true }]);
  const seen = [];
  await runFanout('/api/send', ['a', 'b'], (id) => { seen.push(id); return { id }; });
  assert.deepEqual(seen, ['a', 'b']);
});

await testAsync('each request is a JSON POST (the shape all three routes require)', async () => {
  const calls = mockFetch([{ ok: true }]);
  await runFanout('/api/kill', ['a'], (id) => ({ id }));
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].headers, { 'Content-Type': 'application/json' });
});

await testAsync('an ok response fulfills as {ok:true} (the success summarizeFanout counts)', async () => {
  mockFetch([{ ok: true }]);
  const [res] = await runFanout('/api/send', ['a'], (id) => ({ id }));
  assert.equal(res.status, 'fulfilled');
  assert.deepEqual(res.value, { ok: true });
});

await testAsync('a non-ok response fulfills as {ok:false} carrying the body error', async () => {
  mockFetch([{ ok: false, error: 'session not found' }]);
  const [res] = await runFanout('/api/kill', ['a'], (id) => ({ id }));
  assert.equal(res.status, 'fulfilled');
  assert.deepEqual(res.value, { ok: false, error: 'session not found' });
});

await testAsync('a non-ok response with no body error falls back to `HTTP {status}`', async () => {
  mockFetch([{ ok: false, status: 503 }]);
  const [res] = await runFanout('/api/kill', ['a'], (id) => ({ id }));
  assert.deepEqual(res.value, { ok: false, error: 'HTTP 503' });
});

await testAsync('an EMPTY body error also falls back to `HTTP {status}` (never a blank reason)', async () => {
  mockFetch([{ ok: false, status: 500, error: '' }]);
  const [res] = await runFanout('/api/kill', ['a'], (id) => ({ id }));
  assert.deepEqual(res.value, { ok: false, error: 'HTTP 500' });
});

await testAsync('a non-ok response whose body is NOT JSON still yields `HTTP {status}`', async () => {
  // The `.catch(() => ({}))` branch: an HTML error page / proxy 502 makes
  // r.json() throw. Without the catch the whole per-agent promise would reject
  // with a JSON parse error, reporting "Unexpected token <" as the agent's
  // failure reason instead of the status.
  mockFetch([{ ok: false, status: 502, noJson: true }]);
  const [res] = await runFanout('/api/send', ['a'], (id) => ({ id }));
  assert.equal(res.status, 'fulfilled');
  assert.deepEqual(res.value, { ok: false, error: 'HTTP 502' });
});

await testAsync('a network failure REJECTS — it does not fulfill as {ok:false}', async () => {
  // Load-bearing (WARDEN-974 constraint): summarizeFanout reads a rejected
  // result via reason.message and a fulfilled one via value.error. Rerouting
  // this loop through api.ts's postJson would convert this rejection into a
  // fulfilled {ok:false} and silently move every network failure onto the other
  // branch, so pin the settle KIND, not just the resulting string.
  mockFetch([{ reject: 'network down' }]);
  const [res] = await runFanout('/api/send', ['a'], (id) => ({ id }));
  assert.equal(res.status, 'rejected');
  assert.equal(res.reason.message, 'network down');
});

await testAsync('partial failure does not abort siblings — every id is attempted', async () => {
  const calls = mockFetch([{ reject: 'down' }, { ok: false, error: 'timeout' }, { ok: true }]);
  const results = await runFanout('/api/kill', ['a', 'b', 'c'], (id) => ({ id }));
  assert.equal(calls.length, 3, 'all three were attempted (allSettled, not all)');
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'fulfilled', 'fulfilled']);
});

await testAsync('results[i] pairs with ids[i] even when responses settle out of order', async () => {
  // summarizeFanout attributes failures POSITIONALLY, so a reordered result
  // array would blame the wrong agent. allSettled preserves input order
  // regardless of completion order — pin that with a slow FIRST request.
  mockFetch([{ ok: false, error: 'slow-a', delay: 20 }, { ok: false, error: 'fast-b' }]);
  const results = await runFanout('/api/send', ['a', 'b'], (id) => ({ id }));
  assert.deepEqual(results.map((r) => r.value.error), ['slow-a', 'fast-b']);
});

await testAsync('empty ids → no request at all, empty results (nothing selected)', async () => {
  const calls = mockFetch([]);
  const results = await runFanout('/api/send', [], (id) => ({ id }));
  assert.equal(calls.length, 0);
  assert.deepEqual(results, []);
});

await testAsync('never throws: total failure is encoded in the settled array', async () => {
  mockFetch([{ reject: 'down' }, { reject: 'down' }]);
  const results = await runFanout('/api/kill', ['a', 'b'], (id) => ({ id }));
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected']);
});

await testAsync('runFanout output feeds summarizeFanout directly (the two halves compose)', async () => {
  // The end-to-end seam this module exists to own: the loop's output IS the
  // reducer's input, with no adapter in between.
  mockFetch([{ ok: true }, { ok: false, error: 'session not found' }, { reject: 'network down' }]);
  const results = await runFanout('/api/kill', ['a', 'b', 'c'], (id) => ({ id }));
  const s = summarizeFanout(results, ['a', 'b', 'c'], nameOf, 'kill failed');
  assert.equal(s.total, 3);
  assert.equal(s.succeeded, 1);
  assert.deepEqual(s.failed, [
    { id: 'b', name: 'agent-b', error: 'session not found' },
    { id: 'c', name: 'agent-c', error: 'network down' },
  ]);
});

globalThis.fetch = realFetch;

console.log(`\n✓ FANOUT TESTS PASS (${passed})`);
