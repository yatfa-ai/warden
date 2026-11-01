import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pollUntil } from './testWait.js';

/**
 * Pins the one branch of `wireStallSink` (src/loopWiring.js) no other spec
 * drives: the durable stalls.jsonl append REJECTING (WARDEN-2076).
 *
 * Contract: a failing append is warned (`could not append to`), never thrown and
 * never an unhandledRejection (fatal in this repo — WARDEN-944 / WARDEN-1652),
 * and it must not stop the `[warden:stall]` stderr line or the telemetry fold.
 *
 * The journal path is made a DIRECTORY so the append rejects with EISDIR —
 * portable, no chmod / root dependence. HOME is redirected before the first
 * `stallLogFile()` call (it resolves os.homedir() lazily).
 */

const STALL = {
  type: 'performance-stall',
  runtime: 'server',
  source: 'event-loop',
  timestamp: new Date().toISOString(),
  lagMs: 4200,
  heartbeatMs: 1000,
  thresholdMs: 1000,
  attribution: [],
  syncTotals: [],
};

describe('wireStallSink — stalls.jsonl append failure', () => {
  let originalHome;
  let originalUserProfile;
  let tempHome;
  let loopMonitor;
  let origWarn;
  let origError;
  const warns = [];
  const errs = [];
  const recorded = [];
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);

  before(async () => {
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-loopwiring-append-'));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    fs.mkdirSync(path.join(tempHome, '.yatfa-warden', 'stalls.jsonl'), { recursive: true });

    ({ loopMonitor } = await import('./loop-monitor.js'));
    const { createLoopWiring } = await import('./loopWiring.js');
    createLoopWiring({
      getServerStallTelemetry: () => ({ recordStall: (r) => recorded.push(r) }),
    }).wireStallSink();

    origWarn = console.warn;
    origError = console.error;
    console.warn = (...a) => { warns.push(a.join(' ')); };
    console.error = (...a) => { errs.push(a.join(' ')); };
    process.on('unhandledRejection', onUnhandled);
  });

  after(() => {
    console.warn = origWarn;
    console.error = origError;
    process.removeListener('unhandledRejection', onUnhandled);
    loopMonitor.setOnStall(null);
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalUserProfile;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('warns on a failing append, still prints the stderr line and folds the stall into telemetry, with no unhandledRejection', async () => {
    assert.doesNotThrow(() => loopMonitor._deliverStall(STALL));

    await pollUntil(() => warns.some((w) => w.includes('could not append to')), {
      what: 'the "could not append to" warn',
    });
    // Give any (buggy) unhandled rejection a turn to surface before asserting its absence.
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(warns.some((w) => w.includes('could not append to')), 'append failure is warned');
    assert.ok(errs.some((e) => e.includes('[warden:stall]')), 'stderr line still printed');
    assert.equal(recorded.length, 1, 'telemetry fold still ran');
    assert.deepEqual(unhandled, [], 'no unhandledRejection');
  });
});
