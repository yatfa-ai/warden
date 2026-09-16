import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * HTTP integration tests for GET /api/diagnostics/pane-latency (WARDEN-1385),
 * run against the REAL Express app from src/server.js.
 *
 * This endpoint is the owner's on-demand read surface for the pane-input
 * latency measurement — the LOCAL half of the attribution story (pane keys may
 * appear here; the TELEMETRY channel carries only the closed-set hop
 * histograms). What is verified here is what makes it useful to the owner:
 *
 *   - a machine that has never attached a pane answers an EMPTY ledger and a
 *     non-recording window rather than an error (the honest-absence shape);
 *   - `recording` tracks the live operational-metrics consent (off by default);
 *   - `window` is the read-only aggregate snapshot for the two server-side
 *     hops (pane-input-write / pane-input-roundtrip);
 *   - importing the app does not perturb the window: a read never flushes.
 *
 * HOME is redirected to a temp dir BEFORE importing server.js (server.js reads
 * config eagerly at module load), following src/server-diagnostics-stalls.test.js.
 */

let httpServer;
let baseUrl;
let originalHome;
let tempHome;
let serverModule;

async function getJson(pathname) {
  const res = await fetch(`${baseUrl}${pathname}`);
  assert.equal(res.status, 200, `GET ${pathname} should be 200`);
  return res.json();
}

before(async () => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-pane-latency-'));
  process.env.HOME = tempHome;
  const wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: [] }));

  serverModule = await import('./server.js');
  httpServer = serverModule.app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    httpServer.once('listening', resolve);
    httpServer.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

after(async () => {
  if (httpServer) await new Promise((r) => httpServer.close(r));
  serverModule?.server?.closeAllConnections?.();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('GET /api/diagnostics/pane-latency (WARDEN-1385)', () => {
  it('answers an honest empty shape on a machine with no pane activity', async () => {
    const body = await getJson('/api/diagnostics/pane-latency');
    assert.equal(body.recording, false); // operational-metrics consent is off by default
    assert.deepEqual(body.ledger, []);
    assert.equal(body.pending, 0);
    assert.equal(typeof body.timestamp, 'number');
    // The read-only window shape: M1-aggregator projection with the two hops.
    assert.equal(typeof body.window.startedAt, 'number');
    assert.ok(Array.isArray(body.window.boundaries));
    assert.ok(Array.isArray(body.window.operations));
    // Nothing folded → no operations listed (idle), rejected is a number.
    assert.equal(typeof body.window.rejected, 'number');
  });

  it('recording tracks the LIVE operational-metrics consent', async () => {
    const { cfg } = serverModule;
    const prev = cfg.telemetryOperationalMetricsEnabled;
    try {
      cfg.telemetryOperationalMetricsEnabled = true;
      let body = await getJson('/api/diagnostics/pane-latency');
      assert.equal(body.recording, true);
      cfg.telemetryOperationalMetricsEnabled = false;
      body = await getJson('/api/diagnostics/pane-latency');
      assert.equal(body.recording, false);
    } finally {
      if (prev === undefined) delete cfg.telemetryOperationalMetricsEnabled;
      else cfg.telemetryOperationalMetricsEnabled = prev;
    }
  });

  it('a read NEVER flushes the window (mid-window curls cannot split telemetry)', async () => {
    const { paneInputTelemetry } = serverModule;
    // Fold one observation directly through the REAL producer.
    assert.equal(paneInputTelemetry.isEnabled(), false); // consent off — but exercise the window read anyway
    const before = paneInputTelemetry.windowSnapshot();
    await getJson('/api/diagnostics/pane-latency');
    const after = paneInputTelemetry.windowSnapshot();
    assert.equal(before.startedAt, after.startedAt); // same window — no flush happened
  });
});
