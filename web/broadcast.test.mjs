// Tests for the pure broadcast-send helpers in src/lib/broadcast.ts (WARDEN-292).
//
// The fan-out itself (Promise.allSettled over /api/send) lives in ChatSidebar
// because it touches fetch + toast + selection state. These tests cover the
// extracted pure seam — the sent/failed accounting (summarizeBroadcast) and the
// result-toast copy (formatBroadcastToast) — so the fiddly "fulfilled-but-!ok is
// still a failure" + "rejection reads reason.message" logic has real coverage.
//
// broadcast.ts is `import type`-free at runtime (no value imports), so Vite's OXC
// transform emits clean ESM JS and the same transpile-to-temp-`.mjs` + dynamic
// `import()` harness used by chatDisplay.test.mjs / gitStateSummary.test.mjs
// loads the REAL module (not a hand-rolled re-implementation).
//
// Run: node broadcast.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libPath = resolve(__dirname, 'src/lib/broadcast.ts');

// --- Load the REAL broadcast.ts (TS -> ESM via the OXC transform Vite bundles)
const src = readFileSync(libPath, 'utf8');
const { code } = await transformWithOxc(src, libPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-broadcast-test-'));
const tmpFile = join(tmpDir, 'broadcast.mjs');
writeFileSync(tmpFile, code);
const { summarizeBroadcast, formatBroadcastToast } = await import(tmpFile);
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
console.log('\nsummarizeBroadcast — sent/failed accounting');
// ---------------------------------------------------------------------------
test('all succeed → sent=N, no failures', () => {
  const s = summarizeBroadcast([ok, ok, ok], ['a', 'b', 'c'], nameOf);
  assert.equal(s.total, 3);
  assert.equal(s.sent, 3);
  assert.deepEqual(s.failed, []);
});
test('a fulfilled {ok:false} is a FAILURE (the 404/500 shape), not a sent', () => {
  const s = summarizeBroadcast([ok, fail('session not found'), ok], ['a', 'b', 'c'], nameOf);
  assert.equal(s.sent, 2);
  assert.equal(s.failed.length, 1);
  assert.deepEqual(s.failed[0], { id: 'b', name: 'agent-b', error: 'session not found' });
});
test('a rejected promise reads reason.message (a network throw)', () => {
  const s = summarizeBroadcast([rejected(new Error('network down'))], ['a'], nameOf);
  assert.equal(s.sent, 0);
  assert.equal(s.failed.length, 1);
  assert.equal(s.failed[0].error, 'network down');
  assert.equal(s.failed[0].name, 'agent-a');
});
test('a rejected non-Error reason stringifies (does not print [object Object])', () => {
  const s = summarizeBroadcast([rejected('boom')], ['a'], nameOf);
  assert.equal(s.failed[0].error, 'boom');
  assert.equal(s.failed[0].name, 'agent-a');
});
test('a rejected undefined reason falls back to a readable string', () => {
  const s = summarizeBroadcast([rejected(undefined)], ['a'], nameOf);
  assert.equal(s.failed[0].error, 'unknown error');
});
test('a fulfilled {ok:false} with no error string falls back to "send failed"', () => {
  const s = summarizeBroadcast([fulfilled({ ok: false })], ['a'], nameOf);
  assert.equal(s.failed[0].error, 'send failed');
});
test('partial failure does NOT abort siblings: 1 ok + 2 fail → sent=1, failed=2', () => {
  // The allSettled contract guarantees every promise is represented — this
  // asserts the reducer reports all of them rather than short-circuiting.
  const s = summarizeBroadcast(
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
  const s = summarizeBroadcast([fail('e1'), ok, fail('e3')], ['a', 'b', 'c'], nameOf);
  assert.deepEqual(s.failed.map((f) => f.id), ['a', 'c']);
  assert.equal(s.sent, 1);
});
test('an id with no name mapping falls back to the raw id', () => {
  // nameOf returns undefined (no mapping) → the failure's name is the raw id,
  // never "undefined", so a dead/unknown target is still identifiable.
  const s = summarizeBroadcast([fail('x')], ['unknown-id'], () => undefined);
  assert.equal(s.failed[0].name, 'unknown-id');
});
test('empty input → empty summary (no agents selected)', () => {
  const s = summarizeBroadcast([], [], nameOf);
  assert.equal(s.total, 0);
  assert.equal(s.sent, 0);
  assert.deepEqual(s.failed, []);
});

// ---------------------------------------------------------------------------
console.log('\nformatBroadcastToast — result copy');
// ---------------------------------------------------------------------------
test('all sent → success variant, singular "agent"', () => {
  const t = formatBroadcastToast({ total: 1, sent: 1, failed: [] });
  assert.equal(t.variant, 'success');
  assert.equal(t.title, 'Sent to 1 agent');
  assert.equal(t.description, undefined);
});
test('all sent → success variant, plural "agents"', () => {
  const t = formatBroadcastToast({ total: 3, sent: 3, failed: [] });
  assert.equal(t.variant, 'success');
  assert.equal(t.title, 'Sent to 3 agents');
});
test('partial failure → error variant, N/M title + per-agent description', () => {
  const t = formatBroadcastToast({
    total: 3,
    sent: 2,
    failed: [{ id: 'b', name: 'agent-b', error: 'session not found' }],
  });
  assert.equal(t.variant, 'error');
  assert.equal(t.title, 'Sent to 2 of 3 agents — 1 failed');
  assert.equal(t.description, 'agent-b: session not found');
});
test('total failure → error variant, "Failed to reach N of M" title', () => {
  const t = formatBroadcastToast({
    total: 2,
    sent: 0,
    failed: [
      { id: 'a', name: 'agent-a', error: 'network down' },
      { id: 'b', name: 'agent-b', error: 'timeout' },
    ],
  });
  assert.equal(t.variant, 'error');
  assert.equal(t.title, 'Failed to reach 2 of 2 agents');
  assert.equal(t.description, 'agent-a: network down\nagent-b: timeout');
});
test('description lists every failure (one per line) for a partial send', () => {
  const t = formatBroadcastToast({
    total: 4,
    sent: 2,
    failed: [
      { id: 'a', name: 'agent-a', error: 'e1' },
      { id: 'b', name: 'agent-b', error: 'e2' },
    ],
  });
  assert.equal(t.description, 'agent-a: e1\nagent-b: e2');
});

console.log(`\n✓ BROADCAST TESTS PASS (${passed})`);
