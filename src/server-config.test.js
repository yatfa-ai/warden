import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * HTTP integration tests for the "Confirm before destructive actions" config
 * preference (WARDEN-137).
 *
 * /api/config is a hand-maintained whitelist on BOTH ends (GET returns a curated
 * subset; PUT destructures + type-guards a curated set before save). A preference
 * that exists in DEFAULTS and renders in Settings can still be a silent no-op if
 * either whitelist link is missing — see WARDEN-131. These tests pin down the
 * full wire contract end-to-end against the REAL Express app from src/server.js:
 *
 *   - GET exposes confirmDestructiveActions and it defaults to true
 *   - PUT with a boolean flips the live config and a subsequent GET reflects it
 *   - PUT persists to config.json (the "survives app restarts" criterion)
 *   - PUT with a non-boolean is rejected by the type guard (no mutation)
 */
describe('/api/config confirmDestructiveActions (real Express app from server.js)', () => {
  let httpServer;
  let baseUrl;
  let originalHome;
  let tempHome;
  let configPath;

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-config-'));
    process.env.HOME = tempHome;
    const wardenDir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wardenDir, { recursive: true });
    configPath = path.join(wardenDir, 'config.json');
    // No confirmDestructiveActions on disk — defaults merge must supply it.
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

  it('GET /api/config exposes confirmDestructiveActions, defaulting to true', async () => {
    const res = await fetch(`${baseUrl}/api/config`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok('confirmDestructiveActions' in body, 'field must be present in the GET response');
    assert.strictEqual(body.confirmDestructiveActions, true, 'safe default is ON');
  });

  it('PUT with confirmDestructiveActions: false updates the live config', async () => {
    const res = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmDestructiveActions: false }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).ok, true);

    // A subsequent GET reflects the opt-out — the GET/PUT whitelist is symmetric.
    const after = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.strictEqual(after.confirmDestructiveActions, false);
  });

  it('PUT persists confirmDestructiveActions to config.json (survives a restart)', async () => {
    // Written by the previous PUT. Read straight from disk — this is the
    // "round-trips through ~/.yatfa-warden/config.json" success criterion.
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(onDisk.confirmDestructiveActions, false);
  });

  it('PUT with a non-boolean is ignored by the type guard (no mutation)', async () => {
    // A malformed body must NOT blank out the preference — the boolean guard is
    // what keeps a bad payload from corrupting the saved config.
    const res = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmDestructiveActions: 'false' }),
    });
    assert.strictEqual(res.status, 200);
    const after = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.strictEqual(after.confirmDestructiveActions, false, 'left unchanged, not overwritten with a string');
  });
});
