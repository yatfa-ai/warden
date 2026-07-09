import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * HTTP integration tests for the /api/pins feature (WARDEN-57).
 *
 * These exercise the REAL Express app from src/server.js against a throwaway
 * HOME, so the live `cfg` and its persisted config.json are temp files. Coverage:
 *
 *   - GET returns 200 + { pins: [...] } seeded from the config on disk
 *   - PUT with an array echoes it back and updates the live in-memory config
 *   - PUT persists to config.json (the "survives app restarts" criterion)
 *   - PUT with a non-array body 400s and does NOT mutate config
 *   - PUT replaces (not merges) the list — an empty array clears all pins
 *
 * The read/write seam round-tripped here is exactly what broke when the frontend
 * saved bare `c.key` values instead of host-prefixed `c.id`s: the backend stores
 * whatever ids it receives verbatim, so these tests pin down the wire contract.
 */

describe('/api/pins HTTP endpoint (real Express app from server.js)', () => {
  let httpServer;
  let baseUrl;
  let originalHome;
  let tempHome;
  let configPath;

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-pins-'));
    process.env.HOME = tempHome;
    const wardenDir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wardenDir, { recursive: true });
    configPath = path.join(wardenDir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ hosts: [], pins: ['(local):existing-agent'] }),
    );

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

  it('GET /api/pins returns 200 + { pins: [...] } seeded from config', async () => {
    const res = await fetch(`${baseUrl}/api/pins`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'application/json; charset=utf-8');
    const body = await res.json();
    assert.ok(Array.isArray(body.pins), 'body must be { pins: [...] }');
    assert.deepStrictEqual(body.pins, ['(local):existing-agent']);
  });

  it('PUT /api/pins with an array returns 200, echoes the pins, and updates the live config', async () => {
    const newPins = ['(local):aaa-agent', '(local):zzz-agent'];
    const res = await fetch(`${baseUrl}/api/pins`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pins: newPins }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    assert.deepStrictEqual(body.pins, newPins);

    // The live in-memory cfg is updated — a subsequent GET reflects it.
    const after = await (await fetch(`${baseUrl}/api/pins`)).json();
    assert.deepStrictEqual(after.pins, newPins);
  });

  it('PUT persists the pins to config.json (survives an app restart)', async () => {
    // Written by the previous PUT. Read straight from disk — this is the
    // "persists across app restarts" success criterion.
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.ok(Array.isArray(onDisk.pins), 'config.json must store a pins array');
    assert.deepStrictEqual(onDisk.pins, ['(local):aaa-agent', '(local):zzz-agent']);
  });

  it('PUT /api/pins with a non-array body returns 400 and does not mutate config', async () => {
    const before = await (await fetch(`${baseUrl}/api/pins`)).json();
    const res = await fetch(`${baseUrl}/api/pins`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pins: 'not-an-array' }),
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.ok(body.error, '400 must carry an error message');

    const after = await (await fetch(`${baseUrl}/api/pins`)).json();
    assert.deepStrictEqual(after.pins, before.pins, 'rejected PUT must not change pins');
  });

  it('PUT replaces (not merges) the pin list — an empty array clears all pins', async () => {
    const res = await fetch(`${baseUrl}/api/pins`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pins: [] }),
    });
    assert.strictEqual(res.status, 200);
    const after = await (await fetch(`${baseUrl}/api/pins`)).json();
    assert.deepStrictEqual(after.pins, []);
  });
});
