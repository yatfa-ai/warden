import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Integration test for the SERVER-STALL telemetry channel (WARDEN-1278), driven
 * through the REAL `setOnStall` callback src/server.js wires in startLoopMonitor.
 *
 * The unit suites (web/telemetry-stalls.test.mjs, web/serverStallTelemetry
 * .test.mjs) prove the fold and the consent gate in isolation. What can only be
 * proven HERE, against the real wiring, is the property this slice is riskiest
 * on:
 *
 *   THE OWNER'S THREE LOCAL CHANNELS ARE BYTE-UNTOUCHED.
 *
 * stalls.jsonl, the `[warden:stall]` stderr line, and GET /api/diagnostics/
 * stalls are the surfaces someone consults when the app just froze. They are on
 * by default and require no opt-in; telemetry is opt-in and off by default, and
 * it is being added BESIDE them, not in front of them. A regression here — a
 * throwing producer swallowing the append, a reordering that lets a telemetry
 * failure take out the stderr line — would trade a working diagnostic for an
 * optional one. So the local channels are asserted with the producer ON, with it
 * OFF, and with it THROWING.
 *
 * HOME is redirected to a temp dir BEFORE importing server.js (server.js reads
 * config eagerly at module load), following src/server-diagnostics-stalls.test.js.
 */

let httpServer;
let baseUrl;
let originalHome;
let originalCompanionEnv;
let tempHome;
let wardenDir;
let stallLogPath;
let loopMonitor;
let serverStallTelemetry;
let cfg;

const STALL = (over = {}) => ({
  type: 'performance-stall',
  runtime: 'server',
  source: 'event-loop',
  timestamp: new Date().toISOString(),
  lagMs: 4200,
  heartbeatMs: 1000,
  thresholdMs: 1000,
  attribution: [{ label: 'sweep:attention', overlapMs: 4100, open: true, durationMs: 4300 }],
  syncTotals: [],
  ...over,
});

/** Read the durable JSONL journal (the owner's channel #1). */
function readJournal() {
  if (!fs.existsSync(stallLogPath)) return [];
  return fs.readFileSync(stallLogPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** Capture stderr while running `fn` (the owner's channel #2). */
async function captureStderr(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => { lines.push(args.join(' ')); };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines;
}

/** Settle the async appendStall write the callback fires and forgets. */
const settle = () => new Promise((r) => setTimeout(r, 50));

before(async () => {
  originalCompanionEnv = process.env.WARDEN_COMPANION_TRANSPORT;
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-stall-telemetry-'));
  process.env.HOME = tempHome;
  wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  stallLogPath = path.join(wardenDir, 'stalls.jsonl');
  // incidents ON so the producer is live for most of the suite; the OFF case
  // flips it back mid-suite (cfg is mutated in place, exactly as PUT /api/config
  // does, so the LIVE consent resolution is what is under test).
  fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({
    hosts: [], telemetryIncidentsEnabled: true,
  }));

  const server = await import('./server.js');
  ({ loopMonitor } = await import('./loop-monitor.js'));
  serverStallTelemetry = server.serverStallTelemetry;
  cfg = server.cfg;
  httpServer = server.app.listen(0, '127.0.0.1');
  await new Promise((r) => httpServer.once('listening', r));
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;

  // Arm the REAL setOnStall callback. startLoopMonitor() would also start the
  // heartbeat timer and patch the fs builtins process-wide; the callback is the
  // part under test, so it is wired here without those side effects.
  server.__startLoopMonitorForTest();
});

after(async () => {
  if (httpServer) await new Promise((r) => httpServer.close(r));
  loopMonitor.setOnStall(null);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalCompanionEnv === undefined) delete process.env.WARDEN_COMPANION_TRANSPORT;
  else process.env.WARDEN_COMPANION_TRANSPORT = originalCompanionEnv;
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('server-stall telemetry through the REAL setOnStall callback (WARDEN-1278)', () => {
  it('folds N stalls into ONE window carrying count / totalMs / maxMs / histogram / culprits', async () => {
    cfg.telemetryIncidentsEnabled = true;
    serverStallTelemetry.flushNow(); // start from a clean window

    await captureStderr(async () => {
      // Deliver two real stall records through the PRODUCTION sink.
      loopMonitor._deliverStall(STALL({ lagMs: 1500 }));
      loopMonitor._deliverStall(STALL({
        lagMs: 6000,
        attribution: [{ label: 'GET /api/claude-sessions', overlapMs: 5900, open: false, durationMs: 5900 }],
        syncTotals: [{ label: 'fs.readFileSync', calls: 812, totalMs: 5800 }],
      }));
      await settle();
    });

    const window = serverStallTelemetry.flushNow();
    assert.ok(window, 'the window closed with content');
    assert.equal(window.count, 2, 'TWO stalls, ONE aggregate — not one row each');
    assert.equal(window.totalMs, 7500);
    assert.equal(window.maxMs, 6000);
    assert.equal(window.buckets.reduce((a, b) => a + b, 0), 2, 'both landed in the histogram');
    const keys = window.culprits.map((c) => c.culprit);
    assert.ok(keys.includes('sweep-attention'), 'the sweep is named');
    assert.ok(keys.includes('get-api-claude-sessions'), 'the route is named by PATTERN');
    assert.ok(keys.includes('fs-read-file-sync'), 'and the sync aggregate is named');
  });

  it('maps a request label carrying user data to a route pattern — never the data', async () => {
    // The real trap: server.js builds the span label from req.path, and
    // requestLabelPath only collapses unsafe chars — an agent name survives it
    // verbatim. Driven through the REAL callback with the REAL live route set.
    cfg.telemetryIncidentsEnabled = true;
    serverStallTelemetry.flushNow();
    await captureStderr(async () => {
      loopMonitor._deliverStall(STALL({
        attribution: [{ label: 'GET /api/chats/myproject-researcher', overlapMs: 4000, open: false, durationMs: 4000 }],
      }));
      await settle();
    });
    const window = serverStallTelemetry.flushNow();
    const serialized = JSON.stringify(window);
    assert.ok(!serialized.includes('myproject'), 'the agent name is nowhere in the window');
    assert.ok(!serialized.includes('researcher'), 'the agent name is nowhere in the window');
    for (const c of window.culprits) {
      assert.match(c.culprit, /^[a-z0-9][a-z0-9-]{0,63}$/, `${c.culprit} is wire-safe`);
    }
  });

  it('consent OFF — the window is dropped and nothing is retained', async () => {
    cfg.telemetryIncidentsEnabled = false;
    serverStallTelemetry.flushNow();
    await captureStderr(async () => {
      loopMonitor._deliverStall(STALL({ lagMs: 9000 }));
      await settle();
    });
    assert.equal(serverStallTelemetry.flushNow(), null, 'nothing was collected');
    // And nothing was PARKED either: re-enabling must not resurrect it.
    cfg.telemetryIncidentsEnabled = true;
    assert.equal(serverStallTelemetry.flushNow(), null, 'the off-window left no residue');
  });
});

describe('the owner\'s three LOCAL channels are untouched by the telemetry fold', () => {
  it('the stderr line and the durable append still fire with the producer ON', async () => {
    cfg.telemetryIncidentsEnabled = true;
    const before = readJournal().length;
    const record = STALL({ lagMs: 4200 });
    const lines = await captureStderr(async () => {
      loopMonitor._deliverStall(record);
      await settle();
    });
    assert.equal(lines.length, 1, 'exactly one stderr line, as before');
    assert.match(lines[0], /^\[warden:stall\] server event loop blocked 4200ms/);
    assert.match(lines[0], /recorded in .*stalls\.jsonl/, 'and it still names the durable file');

    const journal = readJournal();
    assert.equal(journal.length, before + 1, 'the durable append still happened');
    // The RECORD ITSELF is unchanged — the telemetry fold reads it, it does not
    // rewrite it. A field added or dropped here would change what the owner sees.
    assert.deepEqual(journal[journal.length - 1], JSON.parse(JSON.stringify(record)));
    serverStallTelemetry.flushNow();
  });

  it('the same two channels fire IDENTICALLY with the producer OFF', async () => {
    cfg.telemetryIncidentsEnabled = false;
    const before = readJournal().length;
    const record = STALL({ lagMs: 4200 });
    const lines = await captureStderr(async () => {
      loopMonitor._deliverStall(record);
      await settle();
    });
    assert.equal(lines.length, 1, 'consent has no effect on the local channels');
    assert.match(lines[0], /^\[warden:stall\] server event loop blocked 4200ms/);
    const journal = readJournal();
    assert.equal(journal.length, before + 1);
    assert.deepEqual(journal[journal.length - 1], JSON.parse(JSON.stringify(record)));
  });

  it('a THROWING telemetry producer cannot take out the local channels', async () => {
    // The ordering guarantee: stderr and the durable append run FIRST, and the
    // fold is wrapped. A diagnostic must never be the reason the diagnostic is
    // lost — which would be the worst possible outcome of this slice.
    cfg.telemetryIncidentsEnabled = true;
    const original = serverStallTelemetry.recordStall;
    serverStallTelemetry.recordStall = () => { throw new Error('producer exploded'); };
    try {
      const before = readJournal().length;
      const lines = await captureStderr(async () => {
        loopMonitor._deliverStall(STALL({ lagMs: 7777 }));
        await settle();
      });
      assert.equal(lines.length, 1, 'the stderr line still fired');
      assert.match(lines[0], /blocked 7777ms/);
      assert.equal(readJournal().length, before + 1, 'and the durable append still landed');
    } finally {
      serverStallTelemetry.recordStall = original;
    }
  });

  it('GET /api/diagnostics/stalls still serves the durable file unchanged', async () => {
    const res = await fetch(`${baseUrl}/api/diagnostics/stalls`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.logFile, stallLogPath, 'still names the durable file');
    assert.ok(Array.isArray(body.stalls), 'still serves the file contents');
    assert.ok(body.stalls.length > 0, 'the stalls this suite recorded are readable');
    assert.ok(body.config && typeof body.config.thresholdMs === 'number', 'still carries the monitor config');
    assert.ok(body.stats && typeof body.stats.ticks === 'number', 'still carries the monitor stats');
    // The response shape carries NO telemetry field — the owner's read surface is
    // about stalls, not about what was reported to whom.
    assert.deepEqual(
      Object.keys(body).sort(),
      ['config', 'logFile', 'session', 'stalls', 'stats', 'timestamp'],
      'the response shape is unchanged by this slice',
    );
  });
});
