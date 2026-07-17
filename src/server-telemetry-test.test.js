// End-to-end route test for POST /api/telemetry-test (WARDEN-595). Proves the
// Express wiring around the pure probeReceiverCapabilities composition: the route
// is registered, JSON bodies parse, the 400 guard fires on a missing endpoint, the
// verdict is passed through to the response, and the persisted cfg.telemetryAuthToken
// flows as the fallback token. Same isolated-server pattern as server-config-
// telemetry.test.js: unique temp HOME, own config.json, real Express app.
//
// The route's outbound GET /capabilities uses the global fetch, so globalThis.fetch
// is stubbed BEFORE the app is imported (and restored after). Requests to the LOCAL
// app go through node:http — never the stubbed fetch — so the two do not collide.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

let httpServer;
let baseUrl;
let originalHome;
let originalFetch;
let tempHome;
let configPath;
let probe; // the stubbed fetch's scriptable responder + call log

before(async () => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-cfg-tel-test-'));
  process.env.HOME = tempHome;
  const wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  configPath = path.join(wardenDir, 'config.json');
  // Seed a persisted telemetryAuthToken so the "fallback token" test can verify the
  // route reads cfg.telemetryAuthToken live (no PUT mid-test — consuming a PUT
  // response inline is fiddly, and the seed is enough).
  fs.writeFileSync(configPath, JSON.stringify({ hosts: [], telemetryAuthToken: 'persisted-tok' }));

  // Stub the global fetch the route uses for its outbound probe. Restored in after.
  originalFetch = globalThis.fetch;
  probe = makeProbe();
  globalThis.fetch = probe.fetchImpl;

  const { app } = await import('./server.js');
  httpServer = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    httpServer.once('listening', resolve);
    httpServer.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

after(async () => {
  if (httpServer) await new Promise((r) => httpServer.close(r));
  if (originalFetch === undefined) delete globalThis.fetch;
  else globalThis.fetch = originalFetch;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// POST a JSON body to the local app via node:http (NOT the stubbed fetch).
async function postTelemetryTest(body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${baseUrl}/api/telemetry-test`,
      { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, body: json });
        });
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

// A scriptable global-fetch stub: set `probe.next` to a { status, json } response
// or a `throwErr`, then call the route. Records every call's url + headers.
function makeProbe() {
  const calls = [];
  let next = { status: 200, json: { schemaVersion: 1, authRequired: false } };
  let throwErr = null;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (throwErr) { const e = throwErr; throwErr = null; throw e; }
    const { status, json } = next;
    return { status, ok: status >= 200 && status < 300, json: async () => json };
  };
  return {
    fetchImpl,
    calls,
    set next(value) { next = value; },
    set throw(value) { throwErr = value; },
    reset() { calls.length = 0; next = { status: 200, json: { schemaVersion: 1, authRequired: false } }; throwErr = null; },
  };
}

describe('POST /api/telemetry-test (WARDEN-595)', () => {
  it('returns 400 when no endpoint is provided (the route validates the body)', async () => {
    const { status, body } = await postTelemetryTest({});
    assert.equal(status, 400);
    assert.match(body.error, /endpoint is required/i);
  });

  it('returns a connected verdict when the probe reaches a schema-matched open receiver', async () => {
    probe.reset();
    probe.next = { status: 200, json: { schemaVersion: 1, authRequired: false } };
    const { status, body } = await postTelemetryTest({ endpoint: 'https://receiver.example/ingest' });
    assert.equal(status, 200);
    assert.equal(body.kind, 'connected');
    assert.equal(body.ok, true);
    assert.equal(probe.calls[0].url, 'https://receiver.example/capabilities');
  });

  it('probes the capabilities URL derived from the endpoint (path dropped, /capabilities used)', async () => {
    probe.reset();
    await postTelemetryTest({ endpoint: 'http://localhost:7421/ingest' });
    assert.equal(probe.calls[0].url, 'http://localhost:7421/capabilities');
  });

  it('uses the persisted cfg.telemetryAuthToken as the fallback token (no draft supplied)', async () => {
    // config.json was seeded with telemetryAuthToken: 'persisted-tok' in before();
    // the route reads cfg.telemetryAuthToken live.
    probe.reset();
    probe.next = { status: 200, json: { schemaVersion: 1, authRequired: true } };
    await postTelemetryTest({ endpoint: 'https://receiver.example/ingest' });
    assert.equal(
      probe.calls[0].init.headers.authorization,
      'Bearer persisted-tok',
      'the persisted token was used as the fallback when no draft was sent'
    );
  });

  it('a draft token from the body takes precedence over the persisted token', async () => {
    probe.reset();
    probe.next = { status: 200, json: { schemaVersion: 1, authRequired: true } };
    await postTelemetryTest({ endpoint: 'https://receiver.example/ingest', token: 'draft-tok' });
    assert.equal(probe.calls[0].init.headers.authorization, 'Bearer draft-tok');
  });

  it('returns an auth-required verdict when the probe gets a 401', async () => {
    probe.reset();
    probe.next = { status: 401, json: { error: 'unauthorized' } };
    const { body } = await postTelemetryTest({ endpoint: 'https://receiver.example/ingest', token: 'tok' });
    assert.equal(body.kind, 'auth-required');
    assert.equal(body.ok, false);
  });

  it('returns a schema-drift verdict when the receiver schemaVersion differs', async () => {
    probe.reset();
    probe.next = { status: 200, json: { schemaVersion: 2, authRequired: false } };
    const { body } = await postTelemetryTest({ endpoint: 'https://receiver.example/ingest' });
    assert.equal(body.kind, 'schema-drift');
  });

  it('returns a no-receiver verdict when the probe throws (network error) — never 500s', async () => {
    probe.reset();
    probe.throw = new Error('ECONNREFUSED');
    const { status, body } = await postTelemetryTest({ endpoint: 'https://receiver.example/ingest' });
    assert.equal(status, 200, 'a network error maps to a verdict, not a 500');
    assert.equal(body.kind, 'no-receiver');
  });
});
