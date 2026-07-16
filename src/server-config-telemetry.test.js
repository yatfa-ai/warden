import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// telemetryEndpoint round-trips through /api/config (WARDEN-461). The transport
// (telemetry-send.js) is the last gate, but the endpoint must be EDITABLE for the
// gate to ever open — so the pref must survive all three links of the hand-
// maintained /api/config whitelist: config.js DEFAULTS (default empty), the GET
// safe-subset return, and the PUT type-guarded writer. A pref that exists in
// DEFAULTS but is missing from GET or PUT is a silent no-op from the renderer's
// view (WARDEN-131 class of bug) — these pin all three links.
//
// Same isolated-server pattern as server-config.test.js: unique temp HOME, own
// config.json, real Express app. node --test runs each file in its own process,
// so this never cross-talks with the other server-config-*.test.js files.

let httpServer;
let baseUrl;
let originalHome;
let tempHome;
let configPath;

before(async () => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-cfg-telemetry-'));
  process.env.HOME = tempHome;
  const wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  configPath = path.join(wardenDir, 'config.json');
  // No telemetryEndpoint on disk — DEFAULTS must supply the empty default.
  fs.writeFileSync(configPath, JSON.stringify({ hosts: [] }));

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
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('/api/config telemetryEndpoint (WARDEN-461)', () => {
  it('GET exposes telemetryEndpoint, defaulting to empty (unconfigured = sends nothing)', async () => {
    const body = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.ok('telemetryEndpoint' in body, 'field present in GET (link 2 of the whitelist)');
    assert.strictEqual(body.telemetryEndpoint, '', 'default empty — off by default');
  });

  it('PUT with a string endpoint updates the live config and round-trips via GET', async () => {
    const endpoint = 'https://receiver.selfhosted.example/ingest';
    const res = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ telemetryEndpoint: endpoint }),
    });
    assert.strictEqual(res.status, 200);
    const after = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.strictEqual(after.telemetryEndpoint, endpoint, 'GET/PUT whitelist is symmetric');
  });

  it('PUT persists telemetryEndpoint to config.json (survives a restart)', async () => {
    const endpoint = 'https://other.selfhosted.example/ingest';
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ telemetryEndpoint: endpoint }),
    });
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(onDisk.telemetryEndpoint, endpoint, 'persisted to ~/.yatfa-warden/config.json');
  });

  it('PUT with a non-string is ignored by the type guard (no mutation)', async () => {
    // Set a known value first.
    const endpoint = 'https://receiver.selfhosted.example/ingest';
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ telemetryEndpoint: endpoint }),
    });
    // A malformed body (number) must NOT corrupt the pref.
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ telemetryEndpoint: 12345 }),
    });
    const after = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.strictEqual(after.telemetryEndpoint, endpoint, 'left unchanged, not overwritten with a number');
  });

  it('PUT with an empty string clears the endpoint (back to sends-nothing)', async () => {
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ telemetryEndpoint: 'https://tmp.example/ingest' }),
    });
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ telemetryEndpoint: '' }),
    });
    const after = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.strictEqual(after.telemetryEndpoint, '', 'empty string accepted — clears the endpoint');
  });
});

// telemetryAuthToken is a SECRET (WARDEN-569), so it does NOT mirror
// telemetryEndpoint's cleartext round-trip. Instead it follows the existing
// secret pattern (llm.authToken / webhookSecret): GET masks it (set + last-4
// tail only — NEVER cleartext), and PUT is NO-CLOBBER (only a non-empty string
// overwrites the stored secret, so an untouched password field preserves it).
// These pin the SECRET shape of all three whitelist links.
describe('/api/config telemetryAuthToken (WARDEN-569) — secret, write-only', () => {
  it('GET never returns cleartext: only telemetryAuthTokenSet (default false) + tail (null)', async () => {
    const body = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.strictEqual(body.telemetryAuthTokenSet, false, 'default unset');
    assert.strictEqual(body.telemetryAuthTokenTail, null, 'no tail when unset');
    assert.ok(!('telemetryAuthToken' in body), 'cleartext NEVER in the GET response');
  });

  it('PUT with a non-empty token persists it; GET reflects the masked indicator (set + tail), never cleartext', async () => {
    const token = 'cpy-super-secret-bearer-token-569';
    const res = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ telemetryAuthToken: token }),
    });
    assert.strictEqual(res.status, 200);
    const after = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.strictEqual(after.telemetryAuthTokenSet, true, 'set indicator reflects the stored token');
    assert.strictEqual(after.telemetryAuthTokenTail, token.slice(-4), 'tail is the last 4');
    assert.ok(!('telemetryAuthToken' in after), 'cleartext STILL never in the GET response after setting it');
  });

  it('PUT persists the cleartext token to config.json (the transport needs it server-side)', async () => {
    const token = 'on-disk-cleartext-token-569';
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ telemetryAuthToken: token }),
    });
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(onDisk.telemetryAuthToken, token, 'cleartext persisted server-side');
  });

  it('PUT with an empty string is NO-CLOBBER: an untouched field preserves the stored token', async () => {
    const token = 'preserved-across-empty-save-569';
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ telemetryAuthToken: token }),
    });
    // A save that omits the field (empty password input) must NOT clear the token.
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ telemetryAuthToken: '' }),
    });
    const after = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.strictEqual(after.telemetryAuthTokenSet, true, 'token still set after an empty PUT');
    assert.strictEqual(after.telemetryAuthTokenTail, token.slice(-4), 'still the same token');
  });

  it('PUT with the field omitted entirely is NO-CLOBBER (the UI sends it only when non-empty)', async () => {
    const token = 'preserved-across-omitted-save-569';
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ telemetryAuthToken: token }),
    });
    // A PUT that does not mention telemetryAuthToken at all (an untouched field).
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ telemetryBaseEnabled: false }),
    });
    const after = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.strictEqual(after.telemetryAuthTokenSet, true, 'token preserved when the field is omitted');
  });

  it('PUT with a non-string is ignored by the type guard (no mutation, no crash)', async () => {
    const token = 'guard-me-569';
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ telemetryAuthToken: token }),
    });
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ telemetryAuthToken: 12345 }),
    });
    const after = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.strictEqual(after.telemetryAuthTokenSet, true, 'left unchanged, not overwritten with a number');
    assert.strictEqual(after.telemetryAuthTokenTail, token.slice(-4));
  });

  it('the cleartext token never leaks into ANY GET /api/config response field', async () => {
    const token = 'never-leak-this-cleartext-569';
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ telemetryAuthToken: token }),
    });
    const text = await (await fetch(`${baseUrl}/api/config`)).text();
    assert.ok(!text.includes(token), 'the full cleartext token must not appear anywhere in the GET body');
  });
});
