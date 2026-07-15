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
let companionEnvOverriddenAtBoot;
let originalCompanionEnv;

before(async () => {
  // WARDEN-439: capture the ambient WARDEN_COMPANION_TRANSPORT BEFORE importing
  // server.js — server.js snapshots the operator-override flag AND, when not
  // overridden, writes the gate ('0'/'1') at import time, so reading it after
  // the import would always see it set. Also restore it in after() so the value
  // server.js writes here never leaks to other test files in this process.
  originalCompanionEnv = process.env.WARDEN_COMPANION_TRANSPORT;
  companionEnvOverriddenAtBoot = originalCompanionEnv !== undefined;

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
  if (originalCompanionEnv === undefined) delete process.env.WARDEN_COMPANION_TRANSPORT;
  else process.env.WARDEN_COMPANION_TRANSPORT = originalCompanionEnv;
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

describe('/api/config companion transport toggle (WARDEN-439)', () => {
  it('GET exposes companionTransportEnabled defaulting to false + the override flag', async () => {
    const body = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.ok('companionTransportEnabled' in body, 'toggle field present in GET');
    assert.strictEqual(body.companionTransportEnabled, false, 'safe default is OFF (experimental)');
    assert.strictEqual(
      body.companionTransportOverridden,
      companionEnvOverriddenAtBoot,
      'override flag mirrors the boot-time env snapshot',
    );
  });

  it('PUT companionTransportEnabled: true flips the live gate AND persists', async () => {
    const res = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ companionTransportEnabled: true }),
    });
    assert.strictEqual(res.status, 200);
    // GET round-trips the whitelisted value.
    const after = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.strictEqual(after.companionTransportEnabled, true);
    // It persisted to disk (survives a restart).
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(onDisk.companionTransportEnabled, true);
    // The live env-var gate flipped (the routing sites read this) — UNLESS the
    // operator overrode it at boot, in which case the override wins and the
    // toggle is inert by design.
    if (!companionEnvOverriddenAtBoot) {
      assert.strictEqual(process.env.WARDEN_COMPANION_TRANSPORT, '1', 'live gate is ON');
    } else {
      // Operator set the var before boot → it's '1' or '0' but NOT driven here.
      assert.ok(['1', '0'].includes(process.env.WARDEN_COMPANION_TRANSPORT));
    }
  });

  it('PUT companionTransportEnabled: false restores the live gate to OFF', async () => {
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ companionTransportEnabled: true }),
    });
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ companionTransportEnabled: false }),
    });
    const after = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.strictEqual(after.companionTransportEnabled, false);
    if (!companionEnvOverriddenAtBoot) {
      assert.strictEqual(process.env.WARDEN_COMPANION_TRANSPORT, '0', 'live gate is OFF');
    }
  });

  it('PUT with a non-boolean is ignored by the type guard (no mutation)', async () => {
    // Seed ON first so the guard's "left unchanged" is observable.
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ companionTransportEnabled: true }),
    });
    const res = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ companionTransportEnabled: 'true' }),
    });
    assert.strictEqual(res.status, 200);
    const after = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.strictEqual(after.companionTransportEnabled, true, 'left unchanged, not overwritten by a string');
  });
});
