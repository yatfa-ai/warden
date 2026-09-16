// Tests for web/src/lib/paneLatency.ts (WARDEN-1385) — the RENDERER half of the
// pane-input latency measurement.
//
// Pinned here:
//   • the correlation contract — noteInput opens ONE pending entry per pane
//     (latest keystroke wins), frame() consumes it exactly once, streaming
//     frames with no pending input cost nothing, and a stale pending input
//     (> PENDING_INPUT_MAX_AGE_MS) is dropped, NOT folded as a monster sample;
//   • the two echo legs — e2e folds at frame arrival (delivery is a fact the
//     moment the frame lands), paint folds in the write callback (xterm
//     processes writes asynchronously);
//   • long-task folding;
//   • the bounded fold — fixed bucket count, MAX_PER_WINDOW cap (a paste storm
//     drops, never grows), no rows retained (footprint constant in N);
//   • the wire shape — the flushed window is an M1-aggregator-shaped object
//     whose operation names satisfy the schema validator's kebab-case pattern
//     (the structural hard-exclusion proof: no pane key can ride the channel);
//   • flush() closes AND resets (two windows never double-count).
//
// The browser-side singleton wiring is deliberately NOT exercised here (no DOM);
// the pure core is the contract.
//
// Run: node --test pane-latency.test.mjs   (from web/)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libPath = resolve(__dirname, 'src/lib/paneLatency.ts');

// --- Load the REAL paneLatency.ts (TS -> ESM via the OXC transform Vite bundles)
const src = readFileSync(libPath, 'utf8');
const { code } = await transformWithOxc(src, libPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-panelatency-test-'));
const tmpFile = join(tmpDir, 'paneLatency.mjs');
writeFileSync(tmpFile, code);
const mod = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });
const {
  createPaneLatencySampler,
  PANE_LATENCY_OPS,
  PANE_LATENCY_BOUNDARIES_MS,
  PENDING_INPUT_MAX_AGE_MS,
  MAX_PER_WINDOW,
} = mod;

// Controllable fake clock.
function makeClock() {
  let t = 0;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

// The schema validator's operation-name pattern (mirrored from
// src/lib/telemetry/schema.ts OPERATION_NAME_RE).
const OP_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const opOf = (snapshot, name) => snapshot.operations.find((o) => o.operation === name);

test('correlates keystroke→frame once; later frames find nothing pending', () => {
  const clock = makeClock();
  const s = createPaneLatencySampler({ now: clock.now });
  s.noteInput('p1');
  clock.advance(87.5);
  const f = s.frame('p1');
  assert.ok(f, 'frame handle for the pending input');
  f.painted();
  assert.equal(s.frame('p1'), null, 'consumed — streaming output is not an echo');
  const snap = s.snapshot();
  const e2e = opOf(snap, PANE_LATENCY_OPS.E2E);
  const paint = opOf(snap, PANE_LATENCY_OPS.PAINT);
  assert.equal(e2e.count, 1);
  assert.ok(Math.abs(e2e.avg - 87.5) < 1e-9, `e2e is the felt 87.5ms, got ${e2e.avg}`);
  assert.ok(paint.count >= 0 && paint.count <= 1);
});

test('latest keystroke per pane wins (typing bursts coalesce to one observation)', () => {
  const clock = makeClock();
  const s = createPaneLatencySampler({ now: clock.now });
  s.noteInput('p1');
  clock.advance(300);
  s.noteInput('p1'); // second keystroke overwrites
  clock.advance(40);
  s.frame('p1');
  const e2e = opOf(s.snapshot(), PANE_LATENCY_OPS.E2E);
  assert.equal(e2e.count, 1);
  assert.ok(Math.abs(e2e.avg - 40) < 1e-9);
});

test('stale pending input is dropped, NOT folded as a monster sample', () => {
  const clock = makeClock();
  const s = createPaneLatencySampler({ now: clock.now });
  s.noteInput('p1');
  clock.advance(PENDING_INPUT_MAX_AGE_MS + 1);
  assert.equal(s.frame('p1'), null);
  const e2e = opOf(s.snapshot(), PANE_LATENCY_OPS.E2E);
  assert.equal(e2e.count, 0);
  assert.equal(s.snapshot().rejected, 1, 'the drop is disclosed as rejected');
});

test('frames with no pending input cost one probe and fold nothing', () => {
  const clock = makeClock();
  const s = createPaneLatencySampler({ now: clock.now });
  for (let i = 0; i < 100; i += 1) s.frame('p1');
  const snap = s.snapshot();
  assert.equal(opOf(snap, PANE_LATENCY_OPS.E2E).count, 0);
  assert.equal(snap.rejected, 0);
});

test('paint leg folds through the write callback (xterm async)', () => {
  const clock = makeClock();
  const s = createPaneLatencySampler({ now: clock.now });
  s.noteInput('p1');
  clock.advance(60);
  const f = s.frame('p1');
  clock.advance(12); // xterm processed the write 12ms later
  f.painted();
  const paint = opOf(s.snapshot(), PANE_LATENCY_OPS.PAINT);
  assert.equal(paint.count, 1);
  assert.ok(Math.abs(paint.avg - 12) < 1e-9);
});

test('long tasks fold into their own operation', () => {
  const clock = makeClock();
  const s = createPaneLatencySampler({ now: clock.now });
  s.noteLongTask(64);
  s.noteLongTask(150);
  s.noteLongTask(-3); // rejected, not folded
  const lt = opOf(s.snapshot(), PANE_LATENCY_OPS.LONG_TASK);
  assert.equal(lt.count, 2);
  assert.equal(lt.max, 150);
  assert.equal(s.snapshot().rejected, 1);
});

test('bounded fold: bucket count is fixed; MAX_PER_WINDOW drops rather than grows', () => {
  const clock = makeClock();
  const s = createPaneLatencySampler({ now: clock.now });
  for (let i = 0; i < MAX_PER_WINDOW + 500; i += 1) {
    s.noteInput('p1');
    clock.advance(30);
    s.frame('p1');
  }
  const snap = s.snapshot();
  const e2e = opOf(snap, PANE_LATENCY_OPS.E2E);
  assert.equal(e2e.count, MAX_PER_WINDOW, 'capped at the window bound');
  assert.equal(e2e.buckets.length, PANE_LATENCY_BOUNDARIES_MS.length + 1, 'fixed buckets + overflow');
  // Footprint is constant in N: same accumulator, same bucket array length.
  for (const op of snap.operations) assert.equal(op.buckets.length, PANE_LATENCY_BOUNDARIES_MS.length + 1);
});

test('wire shape: M1 window, schema-valid kebab operation literals, no pane keys', () => {
  const clock = makeClock();
  const s = createPaneLatencySampler({ now: clock.now });
  s.noteInput('agent-totally-real-pane-key');
  clock.advance(45);
  s.frame('agent-totally-real-pane-key');
  s.noteLongTask(80);
  const snap = s.snapshot();
  assert.equal(typeof snap.startedAt, 'number');
  assert.equal(typeof snap.endedAt, 'number');
  assert.ok(Array.isArray(snap.boundaries));
  assert.ok(snap.boundaries[0] <= 50, 'resolves down to the ~50ms jank users feel');
  assert.deepEqual(snap.operations.map((o) => o.operation).sort(),
    ['pane-echo-e2e', 'pane-echo-paint', 'renderer-long-task'].sort());
  for (const op of snap.operations) {
    assert.match(op.operation, OP_NAME_RE);
    for (const key of ['count', 'okCount', 'failCount', 'min', 'avg', 'max', 'buckets']) {
      assert.ok(key in op, `${key} present (OperationalMetricOperation shape)`);
    }
  }
  // The pane key appears NOWHERE in the window.
  assert.equal(JSON.stringify(snap).includes('agent-totally-real-pane-key'), false);
});

test('flush() closes AND resets — two windows never double-count', () => {
  const clock = makeClock();
  const s = createPaneLatencySampler({ now: clock.now });
  s.noteInput('p1');
  clock.advance(70);
  s.frame('p1');
  const w1 = s.flush();
  assert.equal(opOf(w1, PANE_LATENCY_OPS.E2E).count, 1);
  const w2 = s.snapshot();
  assert.equal(opOf(w2, PANE_LATENCY_OPS.E2E).count, 0, 'window reset');
  assert.equal(w2.startedAt, w1.endedAt, 'next window starts where this one ended');
});

test('per-pane independence', () => {
  const clock = makeClock();
  const s = createPaneLatencySampler({ now: clock.now });
  s.noteInput('a');
  s.noteInput('b');
  clock.advance(100);
  s.frame('b');
  clock.advance(3);
  s.frame('a');
  const e2e = opOf(s.snapshot(), PANE_LATENCY_OPS.E2E);
  assert.equal(e2e.count, 2);
  assert.equal(e2e.min, 100);
  assert.equal(e2e.max, 103);
});
