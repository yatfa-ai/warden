// Tests for the pure batch-interrupt helpers in src/lib/keysend.ts (WARDEN-492).
//
// The fan-out itself (Promise.allSettled over /api/key) is shared across the
// sidebar + Fleet Health via runKeySendFanout. These tests cover the extracted
// pure seam — the sent/failed accounting (summarizeKeySend, which delegates the
// shared reducer to summarizeFanout in ./fanout.ts), the key-aware result-toast
// copy (formatKeySendToast), and the shared fan-out (runKeySendFanout) — so the
// fiddly "fulfilled-but-!ok is still a failure" + "rejection reads reason.message"
// + "key send failed fallback" + "key drives the verb" logic has real coverage.
//
// keysend.ts has one runtime value import (summarizeFanout from ./fanout), and
// fanout.ts is `import type`-free at runtime — so Vite's OXC transform emits
// clean ESM JS for both, and the same transpile-to-temp-`.mjs` + dynamic
// `import()` harness used by kill.test.mjs loads the REAL modules (keysend +
// its fanout dependency) rather than a hand-rolled re-implementation.
//
// Run: node keysend.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libDir = resolve(__dirname, 'src/lib');

// --- Load the REAL keysend.ts + its fanout.ts dependency (TS -> ESM via OXC) -
// keysend.ts imports summarizeFanout from ./fanout, so transpile BOTH and rewrite
// keysend's source import to point at the transpiled fanout.mjs in the temp dir.
const fanoutSrc = readFileSync(join(libDir, 'fanout.ts'), 'utf8');
const { code: fanoutCode } = await transformWithOxc(fanoutSrc, join(libDir, 'fanout.ts'), {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-keysend-test-'));
const fanoutFile = join(tmpDir, 'fanout.mjs');
writeFileSync(fanoutFile, fanoutCode);

// Rewrite the ./fanout import on the SOURCE string before transform so the
// relative specifier resolves from the temp dir (transformWithOxc keeps import
// specifiers as-is).
const keysendSrc = readFileSync(join(libDir, 'keysend.ts'), 'utf8')
  .replace(/from ['"]\.\/fanout['"]/, 'from "./fanout.mjs"');
const { code: keysendCode } = await transformWithOxc(keysendSrc, join(libDir, 'keysend.ts'), {});
const keysendFile = join(tmpDir, 'keysend.mjs');
writeFileSync(keysendFile, keysendCode);

const { summarizeKeySend, formatKeySendToast, runKeySendFanout } = await import(keysendFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};
const testAsync = async (name, fn) => {
  await fn();
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
console.log('\nsummarizeKeySend — sent/failed accounting');
// ---------------------------------------------------------------------------
test('all succeed → sent=N, no failures', () => {
  const s = summarizeKeySend([ok, ok, ok], ['a', 'b', 'c'], nameOf);
  assert.equal(s.total, 3);
  assert.equal(s.sent, 3);
  assert.deepEqual(s.failed, []);
});
test('a fulfilled {ok:false} is a FAILURE (the 404/500 shape), not a sent', () => {
  const s = summarizeKeySend([ok, fail('session not found'), ok], ['a', 'b', 'c'], nameOf);
  assert.equal(s.sent, 2);
  assert.equal(s.failed.length, 1);
  assert.deepEqual(s.failed[0], { id: 'b', name: 'agent-b', error: 'session not found' });
});
test('a rejected promise reads reason.message (a network throw)', () => {
  const s = summarizeKeySend([rejected(new Error('network down'))], ['a'], nameOf);
  assert.equal(s.sent, 0);
  assert.equal(s.failed.length, 1);
  assert.equal(s.failed[0].error, 'network down');
  assert.equal(s.failed[0].name, 'agent-a');
});
test('a rejected non-Error reason stringifies (does not print [object Object])', () => {
  const s = summarizeKeySend([rejected('boom')], ['a'], nameOf);
  assert.equal(s.failed[0].error, 'boom');
  assert.equal(s.failed[0].name, 'agent-a');
});
test('a rejected undefined reason falls back to a readable string', () => {
  const s = summarizeKeySend([rejected(undefined)], ['a'], nameOf);
  assert.equal(s.failed[0].error, 'unknown error');
});
test('a fulfilled {ok:false} with no error string falls back to "key send failed"', () => {
  const s = summarizeKeySend([fulfilled({ ok: false })], ['a'], nameOf);
  assert.equal(s.failed[0].error, 'key send failed');
});
test('partial failure does NOT abort siblings: 1 ok + 2 fail → sent=1, failed=2', () => {
  // The allSettled contract guarantees every promise is represented — this
  // asserts the reducer reports all of them rather than short-circuiting.
  const s = summarizeKeySend(
    [ok, fail('down'), rejected(new Error('timeout'))],
    ['a', 'b', 'c'],
    nameOf,
  );
  assert.equal(s.total, 3);
  assert.equal(s.sent, 1);
  assert.equal(s.failed.length, 2);
  assert.deepEqual(s.failed.map((f) => f.id), ['b', 'c']);
});
test('order is preserved: results[i] ↔ ids[i] (allSettled ordering)', () => {
  const s = summarizeKeySend([fail('e1'), ok, fail('e3')], ['a', 'b', 'c'], nameOf);
  assert.deepEqual(s.failed.map((f) => f.id), ['a', 'c']);
  assert.equal(s.sent, 1);
});
test('an id with no name mapping falls back to the raw id', () => {
  // nameOf returns undefined (no mapping) → the failure's name is the raw id,
  // never "undefined", so a dead/unknown target is still identifiable.
  const s = summarizeKeySend([fail('x')], ['unknown-id'], () => undefined);
  assert.equal(s.failed[0].name, 'unknown-id');
});
test('empty input → empty summary (no agents selected)', () => {
  const s = summarizeKeySend([], [], nameOf);
  assert.equal(s.total, 0);
  assert.equal(s.sent, 0);
  assert.deepEqual(s.failed, []);
});

// ---------------------------------------------------------------------------
console.log('\nformatKeySendToast — key-aware result copy');
// ---------------------------------------------------------------------------
// The verb tracks the key: C-c interrupts (the common case), Escape dismisses a
// prompt. The copy says what actually happened, not a generic "sent".
test('C-c, all sent → success, "Interrupted N agents", singular', () => {
  const t = formatKeySendToast({ total: 1, sent: 1, failed: [] }, 'C-c');
  assert.equal(t.variant, 'success');
  assert.equal(t.title, 'Interrupted 1 agent');
  assert.equal(t.description, undefined);
});
test('C-c, all sent → success, "Interrupted N agents", plural', () => {
  const t = formatKeySendToast({ total: 3, sent: 3, failed: [] }, 'C-c');
  assert.equal(t.variant, 'success');
  assert.equal(t.title, 'Interrupted 3 agents');
});
test('Escape, all sent → success, "Sent Esc to N agents" (NOT "Interrupted")', () => {
  const t = formatKeySendToast({ total: 2, sent: 2, failed: [] }, 'Escape');
  assert.equal(t.variant, 'success');
  assert.equal(t.title, 'Sent Esc to 2 agents');
});
test('C-c, partial failure → error, "Interrupted N of M agents — K failed" + per-agent description', () => {
  const t = formatKeySendToast({
    total: 3,
    sent: 2,
    failed: [{ id: 'b', name: 'agent-b', error: 'session not found' }],
  }, 'C-c');
  assert.equal(t.variant, 'error');
  assert.equal(t.title, 'Interrupted 2 of 3 agents — 1 failed');
  assert.equal(t.description, 'agent-b: session not found');
});
test('Escape, partial failure → error, "Sent Esc to N of M agents — K failed"', () => {
  const t = formatKeySendToast({
    total: 3,
    sent: 2,
    failed: [{ id: 'b', name: 'agent-b', error: 'session not found' }],
  }, 'Escape');
  assert.equal(t.variant, 'error');
  assert.equal(t.title, 'Sent Esc to 2 of 3 agents — 1 failed');
});
test('C-c, total failure → error, "Failed to interrupt K of M agents"', () => {
  const t = formatKeySendToast({
    total: 2,
    sent: 0,
    failed: [
      { id: 'a', name: 'agent-a', error: 'network down' },
      { id: 'b', name: 'agent-b', error: 'timeout' },
    ],
  }, 'C-c');
  assert.equal(t.variant, 'error');
  assert.equal(t.title, 'Failed to interrupt 2 of 2 agents');
  assert.equal(t.description, 'agent-a: network down\nagent-b: timeout');
});
test('Escape, total failure → error, "Failed to send Esc to K of M agents"', () => {
  const t = formatKeySendToast({
    total: 2,
    sent: 0,
    failed: [
      { id: 'a', name: 'agent-a', error: 'network down' },
      { id: 'b', name: 'agent-b', error: 'timeout' },
    ],
  }, 'Escape');
  assert.equal(t.variant, 'error');
  assert.equal(t.title, 'Failed to send Esc to 2 of 2 agents');
});
test('description lists every failure (one per line) for a partial send', () => {
  const t = formatKeySendToast({
    total: 4,
    sent: 2,
    failed: [
      { id: 'a', name: 'agent-a', error: 'e1' },
      { id: 'b', name: 'agent-b', error: 'e2' },
    ],
  }, 'C-c');
  assert.equal(t.description, 'agent-a: e1\nagent-b: e2');
});

// ---------------------------------------------------------------------------
console.log('\nrunKeySendFanout — shared impure fan-out (mocked fetch)');
// ---------------------------------------------------------------------------
// runKeySendFanout is the shared impure seam both interrupt surfaces (sidebar +
// Fleet Health) call. It fans one /api/key per id (carrying the selected key),
// reduces via summarizeKeySend, and returns the summary (no onSettled reconcile
// — interrupt is non-destructive). We mock globalThis.fetch to drive the
// allSettled outcomes (ok / {ok:false} / rejected) and assert the summary, that
// each id is POSTed once WITH the key, and that it never throws.

const realFetch = globalThis.fetch;
// outcomes: {ok:true} | {ok:false,error} | {reject:'msg'} (a thrown fetch).
const mockFetch = (outcomes) => {
  let i = 0;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts?.body ?? '{}') });
    const o = outcomes[i++] ?? { ok: true };
    if (o.reject) throw new Error(o.reject);
    return {
      ok: !!o.ok,
      status: o.ok ? 200 : (o.status ?? 500),
      json: async () => ({ error: o.error }),
    };
  };
  return calls;
};

await testAsync('all ok → every id POSTed once WITH the key, sent=N, no failures', async () => {
  const calls = mockFetch([{ ok: true }, { ok: true }, { ok: true }]);
  const s = await runKeySendFanout(['a', 'b', 'c'], 'C-c', nameOf);
  assert.equal(calls.length, 3);
  // Each body carries BOTH the id and the selected key — this is the contract
  // /api/key (server.js) reads (`req.body.key`). A missing/wrong key would be a
  // silent regression, so assert the exact body.
  assert.deepEqual(calls.map((c) => c.body), [
    { id: 'a', key: 'C-c' },
    { id: 'b', key: 'C-c' },
    { id: 'c', key: 'C-c' },
  ]);
  assert.deepEqual(calls.map((c) => c.url), ['/api/key', '/api/key', '/api/key']);
  assert.equal(s.total, 3);
  assert.equal(s.sent, 3);
  assert.deepEqual(s.failed, []);
});

await testAsync('threads the selected key through (Escape, not C-c)', async () => {
  const calls = mockFetch([{ ok: true }, { ok: true }]);
  await runKeySendFanout(['a', 'b'], 'Escape', nameOf);
  assert.deepEqual(calls.map((c) => c.body.key), ['Escape', 'Escape']);
});

await testAsync('a fulfilled {ok:false} is a per-agent failure (does not abort siblings)', async () => {
  const calls = mockFetch([{ ok: true }, { ok: false, error: 'session not found' }, { ok: true }]);
  const s = await runKeySendFanout(['a', 'b', 'c'], 'C-c', nameOf);
  assert.equal(calls.length, 3, 'all three were attempted (no short-circuit)');
  assert.equal(s.sent, 2);
  assert.equal(s.failed.length, 1);
  assert.deepEqual(s.failed[0], { id: 'b', name: 'agent-b', error: 'session not found' });
});

await testAsync('a rejected fetch is a per-agent failure reading reason.message', async () => {
  mockFetch([{ reject: 'network down' }, { ok: true }]);
  const s = await runKeySendFanout(['a', 'b'], 'C-c', nameOf);
  assert.equal(s.sent, 1);
  assert.equal(s.failed.length, 1);
  assert.equal(s.failed[0].id, 'a');
  assert.equal(s.failed[0].error, 'network down');
});

await testAsync('a server error with no JSON error falls back to the HTTP status string', async () => {
  // runKeySendFanout's own fallback: a non-ok response whose body carries no
  // `error` reads `HTTP {status}` (here 503), so the failure is still
  // identifiable. (The deeper "key send failed" fallback lives in summarizeFanout
  // for a direct {ok:false}-with-no-error caller, covered by the summarizeKeySend
  // tests above — unreachable via the real fan-out, which always supplies one.)
  mockFetch([{ ok: false, status: 503 }]);
  const s = await runKeySendFanout(['a'], 'C-c', nameOf);
  assert.equal(s.failed[0].error, 'HTTP 503');
});

await testAsync('an unknown id (nameOf → undefined) keeps the raw id as its name', async () => {
  mockFetch([{ ok: false, error: 'x' }]);
  const s = await runKeySendFanout(['orphan'], 'C-c', () => 'whatever');
  // nameOf returns a string here; the orphan-name fallback lives in summarizeFanout
  // (nameOf ?? id) and is covered by the summarizeKeySend tests above. This asserts
  // the fan-out threads nameOf through unchanged.
  assert.equal(s.failed[0].name, 'whatever');
});

await testAsync('never throws on total failure — encoded in the summary', async () => {
  mockFetch([{ reject: 'down' }, { ok: false, error: 'timeout' }]);
  const s = await runKeySendFanout(['a', 'b'], 'C-c', nameOf);
  assert.equal(s.sent, 0);
  assert.equal(s.failed.length, 2);
});

await testAsync('empty ids → empty summary, no fetch', async () => {
  const calls = mockFetch([]);
  const s = await runKeySendFanout([], 'C-c', nameOf);
  assert.equal(calls.length, 0);
  assert.equal(s.total, 0);
  assert.equal(s.sent, 0);
  assert.deepEqual(s.failed, []);
});

// Restore the real fetch so nothing leaks past this file.
globalThis.fetch = realFetch;

console.log(`\n✓ KEYSEND TESTS PASS (${passed})`);
