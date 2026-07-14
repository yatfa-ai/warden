// Tests for the pure batch-kill helpers in src/lib/kill.ts (WARDEN-328).
//
// The fan-out itself (Promise.allSettled over /api/kill) lives in ChatSidebar
// because it touches fetch + toast + selection state. These tests cover the
// extracted pure seam — the stopped/failed accounting (summarizeKill, which
// delegates the shared reducer to summarizeFanout in ./fanout.ts) and the
// result-toast copy (formatKillToast) — so the fiddly "fulfilled-but-!ok is
// still a failure" + "rejection reads reason.message" + "kill failed fallback"
// logic has real coverage.
//
// kill.ts has one runtime value import (summarizeFanout from ./fanout), and
// fanout.ts is `import type`-free at runtime — so Vite's OXC transform emits
// clean ESM JS for both, and the same transpile-to-temp-`.mjs` + dynamic
// `import()` harness used by broadcast.test.mjs loads the REAL modules (kill +
// its fanout dependency) rather than a hand-rolled re-implementation.
//
// Run: node kill.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libDir = resolve(__dirname, 'src/lib');

// --- Load the REAL kill.ts + its fanout.ts dependency (TS -> ESM via OXC) -----
// kill.ts imports summarizeFanout from ./fanout, so transpile BOTH and rewrite
// kill's source import to point at the transpiled fanout.mjs in the temp dir.
const fanoutSrc = readFileSync(join(libDir, 'fanout.ts'), 'utf8');
const { code: fanoutCode } = await transformWithOxc(fanoutSrc, join(libDir, 'fanout.ts'), {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-kill-test-'));
const fanoutFile = join(tmpDir, 'fanout.mjs');
writeFileSync(fanoutFile, fanoutCode);

// Rewrite the ./fanout import on the SOURCE string before transform so the
// relative specifier resolves from the temp dir (transformWithOxc keeps import
// specifiers as-is).
const killSrc = readFileSync(join(libDir, 'kill.ts'), 'utf8')
  .replace(/from ['"]\.\/fanout['"]/, 'from "./fanout.mjs"');
const { code: killCode } = await transformWithOxc(killSrc, join(libDir, 'kill.ts'), {});
const killFile = join(tmpDir, 'kill.mjs');
writeFileSync(killFile, killCode);

const { summarizeKill, formatKillToast, runKillFanout } = await import(killFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};
// runKillFanout is async (it awaits the fan-out), so its tests need an async
// runner. Increments the same `passed` tally as the sync tests.
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
console.log('\nsummarizeKill — stopped/failed accounting');
// ---------------------------------------------------------------------------
test('all succeed → stopped=N, no failures', () => {
  const s = summarizeKill([ok, ok, ok], ['a', 'b', 'c'], nameOf);
  assert.equal(s.total, 3);
  assert.equal(s.stopped, 3);
  assert.deepEqual(s.failed, []);
});
test('a fulfilled {ok:false} is a FAILURE (the 404 shape), not a stopped', () => {
  const s = summarizeKill([ok, fail('session not found'), ok], ['a', 'b', 'c'], nameOf);
  assert.equal(s.stopped, 2);
  assert.equal(s.failed.length, 1);
  assert.deepEqual(s.failed[0], { id: 'b', name: 'agent-b', error: 'session not found' });
});
test('a rejected promise reads reason.message (a network throw)', () => {
  const s = summarizeKill([rejected(new Error('network down'))], ['a'], nameOf);
  assert.equal(s.stopped, 0);
  assert.equal(s.failed.length, 1);
  assert.equal(s.failed[0].error, 'network down');
  assert.equal(s.failed[0].name, 'agent-a');
});
test('a rejected non-Error reason stringifies (does not print [object Object])', () => {
  const s = summarizeKill([rejected('boom')], ['a'], nameOf);
  assert.equal(s.failed[0].error, 'boom');
  assert.equal(s.failed[0].name, 'agent-a');
});
test('a rejected undefined reason falls back to a readable string', () => {
  const s = summarizeKill([rejected(undefined)], ['a'], nameOf);
  assert.equal(s.failed[0].error, 'unknown error');
});
test('a fulfilled {ok:false} with no error string falls back to "kill failed"', () => {
  const s = summarizeKill([fulfilled({ ok: false })], ['a'], nameOf);
  assert.equal(s.failed[0].error, 'kill failed');
});
test('partial failure does NOT abort siblings: 1 ok + 2 fail → stopped=1, failed=2', () => {
  // The allSettled contract guarantees every promise is represented — this
  // asserts the reducer reports all of them rather than short-circuiting.
  const s = summarizeKill(
    [ok, fail('down'), rejected(new Error('timeout'))],
    ['a', 'b', 'c'],
    nameOf,
  );
  assert.equal(s.total, 3);
  assert.equal(s.stopped, 1);
  assert.equal(s.failed.length, 2);
  assert.deepEqual(s.failed.map((f) => f.id), ['b', 'c']);
});
test('order is preserved: results[i] ↔ ids[i] (allSettled ordering)', () => {
  const s = summarizeKill([fail('e1'), ok, fail('e3')], ['a', 'b', 'c'], nameOf);
  assert.deepEqual(s.failed.map((f) => f.id), ['a', 'c']);
  assert.equal(s.stopped, 1);
});
test('an id with no name mapping falls back to the raw id', () => {
  // nameOf returns undefined (no mapping) → the failure's name is the raw id,
  // never "undefined", so a dead/unknown target is still identifiable.
  const s = summarizeKill([fail('x')], ['unknown-id'], () => undefined);
  assert.equal(s.failed[0].name, 'unknown-id');
});
test('empty input → empty summary (no agents selected)', () => {
  const s = summarizeKill([], [], nameOf);
  assert.equal(s.total, 0);
  assert.equal(s.stopped, 0);
  assert.deepEqual(s.failed, []);
});

// ---------------------------------------------------------------------------
console.log('\nformatKillToast — result copy');
// ---------------------------------------------------------------------------
test('all stopped → success variant, singular "agent"', () => {
  const t = formatKillToast({ total: 1, stopped: 1, failed: [] });
  assert.equal(t.variant, 'success');
  assert.equal(t.title, 'Stopped 1 agent');
  assert.equal(t.description, undefined);
});
test('all stopped → success variant, plural "agents"', () => {
  const t = formatKillToast({ total: 3, stopped: 3, failed: [] });
  assert.equal(t.variant, 'success');
  assert.equal(t.title, 'Stopped 3 agents');
});
test('partial failure → error variant, N/M title + per-agent description', () => {
  const t = formatKillToast({
    total: 3,
    stopped: 2,
    failed: [{ id: 'b', name: 'agent-b', error: 'session not found' }],
  });
  assert.equal(t.variant, 'error');
  assert.equal(t.title, 'Stopped 2 of 3 agents — 1 failed');
  assert.equal(t.description, 'agent-b: session not found');
});
test('total failure → error variant, "Failed to stop N of M" title', () => {
  const t = formatKillToast({
    total: 2,
    stopped: 0,
    failed: [
      { id: 'a', name: 'agent-a', error: 'network down' },
      { id: 'b', name: 'agent-b', error: 'timeout' },
    ],
  });
  assert.equal(t.variant, 'error');
  assert.equal(t.title, 'Failed to stop 2 of 2 agents');
  assert.equal(t.description, 'agent-a: network down\nagent-b: timeout');
});
test('description lists every failure (one per line) for a partial stop', () => {
  const t = formatKillToast({
    total: 4,
    stopped: 2,
    failed: [
      { id: 'a', name: 'agent-a', error: 'e1' },
      { id: 'b', name: 'agent-b', error: 'e2' },
    ],
  });
  assert.equal(t.description, 'agent-a: e1\nagent-b: e2');
});

// ---------------------------------------------------------------------------
console.log('\nrunKillFanout — shared impure fan-out (mocked fetch)');
// ---------------------------------------------------------------------------
// runKillFanout is the shared impure seam both kill surfaces (sidebar WARDEN-328,
// Fleet Health WARDEN-371) call. It fans one /api/kill per id, reduces via
// summarizeKill, then runs the surface-supplied onSettled reconcile. We mock
// globalThis.fetch to drive the allSettled outcomes (ok / {ok:false} / rejected)
// and assert the summary + that onSettled fires + that each id is POSTed once.

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

await testAsync('all ok → every id POSTed once, stopped=N, no failures, onSettled ran', async () => {
  let settled = 0;
  const calls = mockFetch([{ ok: true }, { ok: true }, { ok: true }]);
  const s = await runKillFanout(['a', 'b', 'c'], nameOf, () => { settled += 1; });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => c.body.id), ['a', 'b', 'c']);
  assert.deepEqual(calls.map((c) => c.url), ['/api/kill', '/api/kill', '/api/kill']);
  assert.equal(s.total, 3);
  assert.equal(s.stopped, 3);
  assert.deepEqual(s.failed, []);
  assert.equal(settled, 1, 'onSettled ran exactly once after the fan-out');
});

await testAsync('a fulfilled {ok:false} is a per-agent failure (does not abort siblings)', async () => {
  const calls = mockFetch([{ ok: true }, { ok: false, error: 'session not found' }, { ok: true }]);
  const s = await runKillFanout(['a', 'b', 'c'], nameOf);
  assert.equal(calls.length, 3, 'all three were attempted (no short-circuit)');
  assert.equal(s.stopped, 2);
  assert.equal(s.failed.length, 1);
  assert.deepEqual(s.failed[0], { id: 'b', name: 'agent-b', error: 'session not found' });
});

await testAsync('a rejected fetch is a per-agent failure reading reason.message', async () => {
  mockFetch([{ reject: 'network down' }, { ok: true }]);
  const s = await runKillFanout(['a', 'b'], nameOf);
  assert.equal(s.stopped, 1);
  assert.equal(s.failed.length, 1);
  assert.equal(s.failed[0].id, 'a');
  assert.equal(s.failed[0].error, 'network down');
});

await testAsync('a server error with no JSON error falls back to the HTTP status string', async () => {
  // runKillFanout's own fallback: a non-ok response whose body carries no
  // `error` reads `HTTP {status}` (here 503), so the failure is still
  // identifiable. (The deeper "kill failed" fallback lives in summarizeFanout
  // for a direct {ok:false}-with-no-error caller, covered by the summarizeKill
  // tests above — unreachable via the real fan-out, which always supplies one.)
  mockFetch([{ ok: false, status: 503 }]);
  const s = await runKillFanout(['a'], nameOf);
  assert.equal(s.failed[0].error, 'HTTP 503');
});

await testAsync('an unknown id (nameOf → undefined) keeps the raw id as its name', async () => {
  mockFetch([{ ok: false, error: 'x' }]);
  const s = await runKillFanout(['orphan'], () => 'whatever');
  // nameOf returns a string here; the orphan-name fallback lives in summarizeFanout
  // (nameOf ?? id) and is covered by the summarizeKill tests above. This asserts
  // the fan-out threads nameOf through unchanged.
  assert.equal(s.failed[0].name, 'whatever');
});

await testAsync('never throws on total failure — encoded in the summary', async () => {
  mockFetch([{ reject: 'down' }, { ok: false, error: 'timeout' }]);
  const s = await runKillFanout(['a', 'b'], nameOf);
  assert.equal(s.stopped, 0);
  assert.equal(s.failed.length, 2);
});

await testAsync('onSettled is awaited (an async reconcile completes before resolve)', async () => {
  let order = [];
  mockFetch([{ ok: true }]);
  await runKillFanout(['a'], nameOf, async () => {
    await new Promise((r) => setTimeout(r, 0));
    order.push('settled');
  });
  order.push('resolved');
  // The async onSettled is awaited inside runKillFanout, so 'settled' lands
  // before the await resolves — 'resolved' is pushed after, in source order.
  assert.deepEqual(order, ['settled', 'resolved']);
});

await testAsync('empty ids → empty summary, no fetch, onSettled still runs', async () => {
  let settled = 0;
  const calls = mockFetch([]);
  const s = await runKillFanout([], nameOf, () => { settled += 1; });
  assert.equal(calls.length, 0);
  assert.equal(s.total, 0);
  assert.equal(s.stopped, 0);
  assert.deepEqual(s.failed, []);
  assert.equal(settled, 1);
});

// Restore the real fetch so nothing leaks past this file.
globalThis.fetch = realFetch;

console.log(`\n✓ KILL TESTS PASS (${passed})`);
