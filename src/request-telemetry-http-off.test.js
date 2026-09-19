import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * The CONSENT-OFF companion boot for the WARDEN-1292 request telemetry (the
 * default posture). Runs in its own process — node --test runs each file
 * separately — with the telemetryOperationalMetricsEnabled category left at
 * its default OFF, so the single server.js import reads an out-of-consent
 * config.
 *
 * Pinned here: hitting real /api routes with the category off produces ZERO
 * events and ZERO retention — record() refuses, flushNow() DROPS the window
 * without sending (not even retained in memory), and nothing reaches the IPC
 * channel (captured here with a temporary process.send so a forward could
 * not happen silently).
 */

let httpServer;
let baseUrl;
let originalHome;
let tempHome;
let requestTelemetry;
const sent = [];

before(async () => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-reqtel-off-home-'));
  process.env.HOME = tempHome;

  const wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  // Consent LEFT OFF — the default. No telemetry keys written at all.
  fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: [] }));

  // Capture anything that would be forwarded to the Electron main process —
  // in this bare test process process.send is undefined (no IPC fork), so a
  // temporary capture makes a silent forward OBSERVABLE rather than inert.
  process.send = (msg) => sent.push(msg);

  const mod = await import('./server.js');
  requestTelemetry = mod.requestTelemetry;
  httpServer = mod.app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    httpServer.once('listening', resolve);
    httpServer.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

after(async () => {
  if (httpServer) await new Promise((r) => httpServer.close(r));
  delete process.send;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('/api request telemetry with consent OFF (the default)', () => {
  it('real /api traffic produces zero events and zero retention', async () => {
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    const garbage = await fetch(`${baseUrl}/api/garbage-NOT-a-route`);
    assert.equal(garbage.status, 404);

    // The flush DROPS the window: nothing sent, nothing retained — a second
    // flush cannot resurrect the dropped observations either.
    assert.equal(requestTelemetry.flushNow(), null);
    assert.equal(requestTelemetry.flushNow(), null);
    assert.deepEqual(sent, [], 'no telemetry-metrics window may reach the IPC channel while the category is off');
  });
});
