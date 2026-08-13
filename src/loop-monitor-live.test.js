import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createLoopMonitor, instrumentSyncIo } from './loop-monitor.js';

/**
 * LIVE verification of the server stall monitor (WARDEN-977) — real timers, a
 * real synchronous block of this process's event loop, and the real `fs` module
 * object patched by instrumentSyncIo.
 *
 * src/loop-monitor.test.js proves the decision logic against an injected clock.
 * That is necessary but not sufficient: this ticket's success criterion is that a
 * DELIBERATELY INDUCED multi-second block is observed with a plausible duration
 * and attribution, and that normal operation produces no stall noise. A fake
 * clock cannot make that claim — it never touches setInterval, never contends
 * with the real loop, and never proves the builtin patch takes effect. So this
 * suite blocks the loop for real and reads the record that comes out.
 *
 * Safe to run in CI: the blocks are ~1.2s, the whole file is a few seconds, and
 * the fs patch is process-local (node --test gives each file its own process)
 * and restored in after().
 */

// Block the event loop for real, without burning CPU in a spin loop: a
// zero-timeout-free Atomics.wait on a SharedArrayBuffer parks the thread, which
// is exactly what a synchronous fs/child_process call does to it.
function blockLoop(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let tempDir;
let bigFile;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-stall-live-'));
  bigFile = path.join(tempDir, 'big.bin');
  // Big enough that a synchronous read is measurable (a few ms at least), so the
  // sync-I/O probe has a real call to attribute.
  fs.writeFileSync(bigFile, Buffer.alloc(8 * 1024 * 1024, 7));
});

after(() => {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('live: a real multi-second block is observed with a plausible duration', () => {
  it('reports the induced block, and reports NOTHING for the quiet period after it', async () => {
    const stalls = [];
    // Faster cadence than production (100ms/200ms instead of 1s/1s) so the test
    // takes seconds, not minutes. The decision rule is identical.
    const monitor = createLoopMonitor({
      heartbeatMs: 100,
      thresholdMs: 200,
      syncFloorMs: 1,
      onStall: (r) => stalls.push(r),
    });
    monitor.start();
    try {
      // --- quiet period BEFORE the block: normal, yielding operation ---------
      for (let i = 0; i < 8; i++) {
        const span = monitor.begin('GET /api/config');
        await sleep(40);           // async work yields the loop, as a healthy path does
        monitor.end(span);
      }
      assert.deepEqual(stalls, [], 'yielding work must produce no stall noise');

      // --- the induced block ------------------------------------------------
      const span = monitor.begin('GET /api/config');
      blockLoop(1200);
      monitor.end(span);
      // Let the late heartbeat tick actually run.
      await sleep(250);

      assert.ok(stalls.length >= 1, 'a 1200ms block of the loop must be reported');
      assert.equal(stalls.length, 1, `exactly one stall expected, got ${stalls.length}`);
      const [record] = stalls;

      // PLAUSIBLE DURATION: the reported lag is the overdue gap (block minus the
      // expected 100ms cadence), so ~1100ms. Bounded generously on both sides —
      // this asserts "plausible", not a scheduler-exact number.
      assert.ok(
        record.lagMs >= 800 && record.lagMs <= 2000,
        `lagMs ${record.lagMs} should be a plausible reading of a 1200ms block`,
      );
      // ATTRIBUTION: the work that was open across the block is named.
      assert.equal(record.type, 'performance-stall');
      assert.equal(record.runtime, 'server');
      assert.equal(record.source, 'event-loop');
      assert.equal(record.pid, process.pid);
      assert.ok(Number.isFinite(new Date(record.timestamp).getTime()), 'timestamp is a real instant');
      const labels = record.attribution.map((a) => a.label);
      assert.ok(
        labels.includes('GET /api/config'),
        `expected the open request in the attribution, got ${JSON.stringify(labels)}`,
      );

      // --- quiet period AFTER the block: still silent ------------------------
      const before = stalls.length;
      for (let i = 0; i < 10; i++) {
        const s = monitor.begin('sweep:attention');
        await sleep(40);
        monitor.end(s);
      }
      assert.equal(stalls.length, before, 'normal operation after a stall must add no records');
    } finally {
      monitor.stop();
    }
  });
});

describe('live: the sync-I/O probe attributes a stall to the real blocking call', () => {
  it('names fs.readFileSync when a real synchronous read runs inside the blocked window', async () => {
    const stalls = [];
    const monitor = createLoopMonitor({
      heartbeatMs: 100,
      thresholdMs: 200,
      syncFloorMs: 1, // a big readFileSync is only a few ms; production uses 100ms
      onStall: (r) => stalls.push(r),
    });
    // Patch the REAL fs module object — the same object every src/ module reaches
    // through `import fs from 'node:fs'`, which is what makes one patch cover
    // every remaining synchronous site.
    const restore = instrumentSyncIo(monitor, { fs });
    monitor.start();
    try {
      const span = monitor.begin('sweep:attention');
      // Real synchronous file I/O — the shape this ticket is hunting — plus a
      // parked block so the total reliably exceeds the threshold regardless of
      // how fast the test machine's page cache is.
      const buf = fs.readFileSync(bigFile);
      assert.equal(buf.length, 8 * 1024 * 1024, 'the instrumented read returns real contents');
      blockLoop(900);
      monitor.end(span);
      await sleep(250);

      assert.ok(stalls.length >= 1, 'the blocked window must be reported');
      const labels = stalls[0].attribution.map((a) => a.label);
      assert.ok(
        labels.includes('sweep:attention'),
        `expected the sweep in ${JSON.stringify(labels)}`,
      );
      // The read is recorded as a span by the real patch. It only appears in THIS
      // stall's attribution if it landed inside the blocked window, so assert on
      // the ring (proof the builtin patch fired) rather than on scheduling luck.
      const recorded = monitor._spans().map((s) => s.label);
      assert.ok(
        recorded.includes('fs.readFileSync'),
        `the real fs patch must record the read; ring holds ${JSON.stringify(recorded)}`,
      );
    } finally {
      monitor.stop();
      restore();
    }
    // The patch is fully reverted: a post-restore read records nothing.
    const spansBefore = monitor._spans().length;
    fs.readFileSync(bigFile);
    assert.equal(monitor._spans().length, spansBefore, 'restore() left no instrumentation behind');
  });

  it('names the fd-level primitives (openSync/readSync/closeSync) a windowed read is built from', async () => {
    // REGRESSION GUARD. The first cut of SYNC_FS_METHODS covered only path-level
    // members, so the hand-rolled windowed reads — claudeSessions.js reading up
    // to 400KB of transcript with openSync+readSync on a per-REQUEST route,
    // server.js's archive header scan, observer.js's transcript tail — recorded
    // NOTHING. Their one instrumented call was a microsecond `statSync`, so a
    // stall on those paths produced an attribution with no `fs.*` entry and read
    // as "synchronous I/O was not involved" on the ticket's own named leads.
    // This exercises the exact call shape against the REAL fs module object.
    const stalls = [];
    const monitor = createLoopMonitor({
      heartbeatMs: 100, thresholdMs: 200, syncFloorMs: 0,
      onStall: (r) => stalls.push(r),
    });
    const restore = instrumentSyncIo(monitor, { fs });
    monitor.start();
    try {
      const span = monitor.begin('GET /api/claude-sessions/transcript');
      // The claudeSessions.js shape, verbatim: stat for size, then open, a
      // bounded positional read, close.
      const size = fs.statSync(bigFile).size;
      const fd = fs.openSync(bigFile, 'r');
      const buf = Buffer.alloc(400_000);
      fs.readSync(fd, buf, 0, 400_000, Math.max(0, size - 400_000));
      fs.closeSync(fd);
      assert.equal(buf[0], 7, 'the instrumented positional read returns real bytes');
      blockLoop(900);
      monitor.end(span);
      await sleep(250);

      assert.ok(stalls.length >= 1, 'the blocked window must be reported');
      const recorded = monitor._spans().map((s) => s.label);
      for (const label of ['fs.openSync', 'fs.readSync', 'fs.closeSync']) {
        assert.ok(recorded.includes(label), `${label} must be timed; ring holds ${JSON.stringify(recorded)}`);
      }
      // And the aggregate names them too, with real call counts — this is the
      // half that survives when each individual call is under the ring floor.
      const totals = stalls[0].syncTotals.map((s) => s.label);
      for (const label of ['fs.openSync', 'fs.readSync', 'fs.closeSync']) {
        assert.ok(totals.includes(label), `${label} missing from syncTotals ${JSON.stringify(totals)}`);
      }
    } finally {
      monitor.stop();
      restore();
    }
  });
});
