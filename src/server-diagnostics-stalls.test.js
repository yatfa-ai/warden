import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * HTTP integration tests for GET /api/diagnostics/stalls (WARDEN-977), run
 * against the REAL Express app from src/server.js.
 *
 * This endpoint is one of the three read channels for a server event-loop stall
 * (the others being ~/.yatfa-warden/stalls.jsonl itself and the `[warden:stall]`
 * stderr line). What is verified here is what makes it useful to the OWNER:
 *
 *   - it serves the DURABLE file, so evidence survives the restart between the
 *     stall and the moment somebody looks (an in-memory-only endpoint would be
 *     empty exactly when it is needed);
 *   - it names the log file path, so reading the raw evidence needs no guesswork;
 *   - a machine that has never stalled answers "no stalls" rather than an error;
 *   - and importing the app does NOT start the monitor or patch any builtin — the
 *     instrumentation belongs to the server child alone.
 *
 * HOME is redirected to a temp dir BEFORE importing server.js (server.js reads
 * config eagerly at module load), following src/server-config.test.js.
 */

let httpServer;
let baseUrl;
let originalHome;
let tempHome;
let wardenDir;
let stallLogPath;
let loopMonitor;
let originalCompanionEnv;

const STALL = (over = {}) => ({
  type: 'performance-stall',
  runtime: 'server',
  source: 'event-loop',
  timestamp: new Date().toISOString(),
  lagMs: 4200,
  heartbeatMs: 1000,
  thresholdMs: 1000,
  attribution: [{ label: 'sweep:lifecycle', overlapMs: 4100, open: true, durationMs: 4300 }],
  ...over,
});

before(async () => {
  originalCompanionEnv = process.env.WARDEN_COMPANION_TRANSPORT;
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-stall-http-'));
  process.env.HOME = tempHome;
  wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  stallLogPath = path.join(wardenDir, 'stalls.jsonl');
  fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: [] }));

  const { app } = await import('./server.js');
  ({ loopMonitor } = await import('./loop-monitor.js'));
  httpServer = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    httpServer.once('listening', resolve);
    httpServer.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

after(async () => {
  if (httpServer) await new Promise((r) => httpServer.close(r));
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalCompanionEnv === undefined) delete process.env.WARDEN_COMPANION_TRANSPORT;
  else process.env.WARDEN_COMPANION_TRANSPORT = originalCompanionEnv;
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('GET /api/diagnostics/stalls', () => {
  it('answers "no stalls" on a machine that has never stalled, and names the log file', async () => {
    // A missing log is the HEALTHY case — it must not read as an error, or the
    // owner cannot tell "nothing stalled" from "the surface is broken".
    assert.equal(fs.existsSync(stallLogPath), false);
    const res = await fetch(`${baseUrl}/api/diagnostics/stalls`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.stalls, []);
    assert.equal(body.logFile, stallLogPath, 'the durable log path is discoverable from the response');
    assert.equal(body.config.heartbeatMs, 1000);
    assert.equal(body.config.thresholdMs, 1000);
    assert.equal(body.stats.stalls, 0);
    assert.ok(Number.isFinite(body.timestamp));
  });

  it('serves the DURABLE file (so evidence survives a restart), newest first', async () => {
    // Written directly to the file — i.e. by a PREVIOUS run of the server, which
    // is the case that matters: the process that recorded the stall is gone.
    const older = STALL({ lagMs: 3000, timestamp: new Date(Date.now() - 60_000).toISOString() });
    const newer = STALL({
      lagMs: 9000,
      timestamp: new Date().toISOString(),
      attribution: [{ label: 'fs.readFileSync', overlapMs: 8900, open: false, durationMs: 8900 }],
    });
    fs.writeFileSync(stallLogPath, [older, newer].map((r) => JSON.stringify(r)).join('\n') + '\n');

    const body = await (await fetch(`${baseUrl}/api/diagnostics/stalls`)).json();
    assert.deepEqual(body.stalls.map((s) => s.lagMs), [9000, 3000]);
    assert.equal(body.stalls[0].attribution[0].label, 'fs.readFileSync',
      'the attribution — not just the duration — is what makes the record actionable');
    assert.equal(body.stalls[0].runtime, 'server');
  });

  it('honors ?limit and caps it', async () => {
    const many = Array.from({ length: 12 }, (_, i) => STALL({
      lagMs: 1000 + i, timestamp: new Date(Date.now() - (12 - i) * 1000).toISOString(),
    }));
    fs.writeFileSync(stallLogPath, many.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const limited = await (await fetch(`${baseUrl}/api/diagnostics/stalls?limit=3`)).json();
    assert.deepEqual(limited.stalls.map((s) => s.lagMs), [1011, 1010, 1009]);

    // A junk or oversized limit falls back to a sane bound rather than 500ing.
    for (const q of ['limit=abc', 'limit=-5', 'limit=99999', '']) {
      const res = await fetch(`${baseUrl}/api/diagnostics/stalls?${q}`);
      assert.equal(res.status, 200, `?${q} should still answer`);
      const body = await res.json();
      assert.ok(body.stalls.length <= 500);
    }
  });

  it('tolerates a torn final line in the log', async () => {
    fs.writeFileSync(stallLogPath, JSON.stringify(STALL({ lagMs: 7777 })) + '\n{"type":"perfo\n');
    const body = await (await fetch(`${baseUrl}/api/diagnostics/stalls`)).json();
    assert.deepEqual(body.stalls.map((s) => s.lagMs), [7777]);
  });
});

describe('request labeling (the attribution half, wired into the app)', () => {
  it('labels each request with method + route path for stall attribution', async () => {
    await fetch(`${baseUrl}/api/diagnostics/stalls`);
    // Give the response 'close' event a turn so the span is closed.
    await new Promise((r) => setTimeout(r, 20));
    const spans = loopMonitor._spans();
    const span = spans.find((s) => s.label === 'GET /api/diagnostics/stalls');
    assert.ok(span, `expected a labeled span; ring holds ${JSON.stringify(spans.map((s) => s.label))}`);
    assert.notEqual(span.end, null, 'the span closes when the response closes (no leak per request)');
    assert.ok(span.end >= span.start);
  });

  it('sanitizes and bounds the label so it can never carry arbitrary text', async () => {
    // Warden's routes are static, but the label is written to the stall log and
    // printed to stderr, so an unmatched path must not become a text channel.
    await fetch(`${baseUrl}/no such route/${'x'.repeat(120)}`);
    await new Promise((r) => setTimeout(r, 20));
    const labels = loopMonitor._spans().map((s) => s.label);
    const odd = labels.find((l) => l.startsWith('GET /no'));
    assert.ok(odd, `expected the unmatched request to be labeled; got ${JSON.stringify(labels)}`);
    assert.ok(!/ /.test(odd.slice(4)), `spaces must be collapsed: ${odd}`);
    assert.ok(odd.length <= 80, `label must stay bounded, got ${odd.length}`);
  });
});

describe('importing the app instruments nothing', () => {
  it('does not start the heartbeat or patch any builtin (that is the child\'s job)', () => {
    // startLoopMonitor() runs inside startServer()'s listen callback, not at
    // module scope, so a test, the CLI or a tool that imports `app` pays nothing
    // and no global fs member is left wrapped in this process.
    assert.equal(loopMonitor.started, false, 'no heartbeat timer from an import');
    assert.equal(loopMonitor.stats().stalls, 0);
    for (const m of ['readFileSync', 'statSync', 'existsSync']) {
      assert.equal(fs[m].__loopMonitorOriginal, undefined, `fs.${m} must not be patched by an import`);
    }
  });
});
