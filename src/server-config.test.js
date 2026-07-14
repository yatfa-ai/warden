import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * HTTP integration tests for /api/config, run against the REAL Express app from
 * src/server.js. The server is set up once (top-level before/after) and shared by
 * every describe block — `const cfg = load()` at server.js:30 is eager and the
 * module is cached, so a second import() in the same file cannot get a fresh
 * config. The blocks test independent fields so shared state never cross-talks.
 *
 *   - confirmDestructiveActions (WARDEN-137): GET exposes it (defaults true),
 *     PUT flips it, it persists to config.json, non-booleans are type-guarded.
 *   - health threshold ordering (WARDEN-374): an inverted pair (warning >
 *     critical) PUT through /api/config is clamped so the persisted config stays
 *     well-ordered (warning <= critical) and a silently-failing agent can never
 *     read HEALTHY from a mis-ordered saved config.
 *
 * /api/config is a hand-maintained whitelist on BOTH ends (GET returns a curated
 * subset; PUT destructures + type-guards a curated set before save). A preference
 * that exists in DEFAULTS and renders in Settings can still be a silent no-op if
 * either whitelist link is missing — see WARDEN-131.
 */
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
  // No config fields on disk — defaults merge must supply them (thresholds 5/30,
  // confirmDestructiveActions true).
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

describe('/api/config confirmDestructiveActions (WARDEN-137)', () => {
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

describe('/api/config clamps an inverted threshold pair so it cannot lie (WARDEN-374)', () => {
  // Default pair (5/30) is well-ordered — the clamp must be a no-op there.
  it('GET /api/config exposes the default well-ordered pair (warning 5, critical 30)', async () => {
    const body = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.strictEqual(body.healthWarningThresholdMin, 5);
    assert.strictEqual(body.healthCriticalThresholdMin, 30);
  });

  it('PUT of an inverted pair {60,30} clamps warning to critical (read back via GET)', async () => {
    // Acceptance criterion: PUT {warning:60, critical:30} persists warning=30.
    // Without the clamp, the inverted 60 would swallow the WARNING/CRITICAL range
    // and a 40-min-silent agent would read HEALTHY from the saved config.
    const res = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ healthWarningThresholdMin: 60, healthCriticalThresholdMin: 30 }),
    });
    assert.strictEqual(res.status, 200);
    const after = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.strictEqual(after.healthWarningThresholdMin, 30, 'warning clamped down to critical');
    assert.strictEqual(after.healthCriticalThresholdMin, 30, 'critical left intact');
    assert.ok(
      after.healthWarningThresholdMin <= after.healthCriticalThresholdMin,
      'persisted pair must be well-ordered (warning <= critical)',
    );
  });

  it('the clamped warning persists to config.json (survives a restart)', async () => {
    // Re-PUT (self-contained — no reliance on the previous test) then read disk.
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ healthWarningThresholdMin: 60, healthCriticalThresholdMin: 30 }),
    });
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(onDisk.healthWarningThresholdMin, 30);
    assert.strictEqual(onDisk.healthCriticalThresholdMin, 30);
  });

  it('a well-ordered pair is NOT clamped (warning stays below critical)', async () => {
    const res = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ healthWarningThresholdMin: 15, healthCriticalThresholdMin: 120 }),
    });
    assert.strictEqual(res.status, 200);
    const after = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.strictEqual(after.healthWarningThresholdMin, 15, 'no clamp when already well-ordered');
    assert.strictEqual(after.healthCriticalThresholdMin, 120);
  });
});
