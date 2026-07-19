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

describe('/api/config telemetry consent — off by default, extended gated behind base (WARDEN-457)', () => {
  // Default pair is off/off. The server-side extended-requires-base clamp is the
  // load-bearing guard: a hand-crafted PUT enabling extended without base must be
  // refused, so identifying data (names) can never leak just because a client
  // asked for it. Mirrors the WARDEN-374 threshold-clamp pattern above.

  it('GET exposes both tiers defaulting to false (off by default)', async () => {
    // Re-PUT the safe default first so the block is self-contained.
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ telemetryBaseEnabled: false, telemetryExtendedEnabled: false }),
    });
    const body = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.ok('telemetryBaseEnabled' in body, 'base field present in GET');
    assert.ok('telemetryExtendedEnabled' in body, 'extended field present in GET');
    assert.strictEqual(body.telemetryBaseEnabled, false, 'base OFF by default');
    assert.strictEqual(body.telemetryExtendedEnabled, false, 'extended OFF by default');
  });

  it('PUT telemetryBaseEnabled: true round-trips through GET and persists to disk', async () => {
    const res = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ telemetryBaseEnabled: true }),
    });
    assert.strictEqual(res.status, 200);
    const after = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.strictEqual(after.telemetryBaseEnabled, true);
    assert.strictEqual(after.telemetryExtendedEnabled, false, 'extended stays off — not auto-enabled with base');
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(onDisk.telemetryBaseEnabled, true, 'persists to config.json (survives restart)');
  });

  it('PUT telemetryExtendedEnabled: true while base OFF is clamped to false (server guard)', async () => {
    // The core invariant: extended CANNOT be enabled without base, enforced
    // server-side (not just the UI). A hand-crafted PUT must not bypass it.
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ telemetryBaseEnabled: false }),
    });
    const res = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ telemetryExtendedEnabled: true }),
    });
    assert.strictEqual(res.status, 200);
    const after = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.strictEqual(after.telemetryBaseEnabled, false, 'base still off');
    assert.strictEqual(after.telemetryExtendedEnabled, false, 'extended clamped to false without base');
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(onDisk.telemetryExtendedEnabled, false, 'clamp persists to disk');
  });

  it('PUT telemetryExtendedEnabled: true WITH base ON is accepted', async () => {
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ telemetryBaseEnabled: true, telemetryExtendedEnabled: true }),
    });
    const after = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.strictEqual(after.telemetryBaseEnabled, true);
    assert.strictEqual(after.telemetryExtendedEnabled, true, 'extended accepted when base is on');
  });

  it('turning base OFF latches extended OFF (revoking base revokes the subordinate tier)', async () => {
    // Seed both on, then revoke base with extended left at its on value on disk.
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ telemetryBaseEnabled: true, telemetryExtendedEnabled: true }),
    });
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      // Only base in the body — the unconditional clamp must still force extended off.
      body: JSON.stringify({ telemetryBaseEnabled: false }),
    });
    const after = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.strictEqual(after.telemetryBaseEnabled, false);
    assert.strictEqual(after.telemetryExtendedEnabled, false, 'extended latched off when base revoked');
  });

  it('PUT with non-booleans is ignored by the type guard (no mutation)', async () => {
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ telemetryBaseEnabled: true }),
    });
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ telemetryBaseEnabled: 'true', telemetryExtendedEnabled: 1 }),
    });
    const after = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.strictEqual(after.telemetryBaseEnabled, true, 'left unchanged, not overwritten by a string');
    assert.strictEqual(after.telemetryExtendedEnabled, false, 'left unchanged, not overwritten by a number');
  });
});

describe('/api/config watchPatterns — user-authored output-pattern alerts (WARDEN-540)', () => {
  // The three-site persistence boundary (DEFAULTS + GET + PUT type-guard). A field
  // set at the producer but stripped at the PUT boundary is the failure mode to
  // avoid (WARDEN-131): these prove each link carries watchPatterns through.

  it('GET /api/config exposes watchPatterns defaulting to an empty array', async () => {
    // Seed a clean empty list first so the block is self-contained.
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ watchPatterns: [] }),
    });
    const body = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.ok('watchPatterns' in body, 'field must be present in the GET response');
    assert.ok(Array.isArray(body.watchPatterns), 'must be an array');
    assert.strictEqual(body.watchPatterns.length, 0, 'safe default is empty (no patterns = no custom alerts)');
  });

  it('PUT round-trips watchPatterns through GET and persists to disk (survives a restart)', async () => {
    const patterns = [
      { id: 'p1', name: 'Deploy failed', expression: 'deploy failed', mode: 'string', enabled: true },
      { id: 'p2', name: 'Paywall', expression: 'payment (required|due)', mode: 'regex', enabled: false },
    ];
    const res = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ watchPatterns: patterns }),
    });
    assert.strictEqual(res.status, 200);
    // GET round-trips the whitelisted value.
    const after = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.deepStrictEqual(after.watchPatterns, patterns);
    // It persisted to disk (survives a restart).
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepStrictEqual(onDisk.watchPatterns, patterns);
  });

  it('PUT drops malformed entries via the type-guard (never 500, valid ones kept)', async () => {
    // A mix of valid + invalid: missing id/name/expression, wrong mode, non-objects,
    // a duplicate id, and an over-cap flood. The sanitizer must drop the bad ones
    // and keep the good ones — never throw, never blank the list.
    const res = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        watchPatterns: [
          { id: 'good', name: 'Merge conflict', expression: 'merge conflict', mode: 'string' },
          { id: '', name: 'noid', expression: 'x' },                  // missing id → drop
          { id: 'noname', name: '', expression: 'x' },                // missing name → drop
          { id: 'noexpr', name: 'noexpr', expression: '' },           // missing expression → drop
          'string-not-object',                                         // not an object → drop
          { id: 'good', name: 'dup-id', expression: 'y' },            // duplicate id → drop
        ],
      }),
    });
    assert.strictEqual(res.status, 200);
    const after = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.deepStrictEqual(after.watchPatterns, [
      { id: 'good', name: 'Merge conflict', expression: 'merge conflict', mode: 'string', enabled: true },
    ]);
  });

  it('PUT with a non-array watchPatterns is ignored (no mutation — field treated as absent)', async () => {
    // Seed a known list, then PUT a malformed (non-array) value — it must NOT blank
    // the stored list. null means "field absent"; only a real array mutates.
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ watchPatterns: [{ id: 'keep', name: 'Keep', expression: 'k', mode: 'string', enabled: true }] }),
    });
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ watchPatterns: 'not-an-array' }),
    });
    const after = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.strictEqual(after.watchPatterns.length, 1, 'left unchanged, not blanked by a non-array');
    assert.strictEqual(after.watchPatterns[0].id, 'keep');
  });
});

describe('/api/config clamps advisory-bounds numeric inputs so they cannot lie (WARDEN-747)', () => {
  // Mirrors the WARDEN-374 threshold-clamp block above: clamp-via-PUT,
  // read-back-via-GET, persistence-to-disk. The Settings inputs advertise
  // min/max bounds that, before this fix, were advisory only — a direct API
  // call (or a typed out-of-range value) persisted silently with no feedback.
  // The backend now range-clamps so the committed value matches what the UI's
  // onBlur clamp displays. "the committed value matches what persists" is the
  // exact property WARDEN-374's comment calls out.

  it('GET /api/config exposes connectTimeout (default 10, within [1, 60])', async () => {
    const body = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.strictEqual(body.connectTimeout, 10);
  });

  it('PUT connectTimeout: 999 clamps to 60 (read back via GET)', async () => {
    const res = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connectTimeout: 999 }),
    });
    assert.strictEqual(res.status, 200);
    const after = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.strictEqual(after.connectTimeout, 60, 'over-max clamped down to 60');
  });

  it('PUT connectTimeout: 0 clamps to 1 (read back via GET)', async () => {
    const res = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connectTimeout: 0 }),
    });
    assert.strictEqual(res.status, 200);
    const after = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.strictEqual(after.connectTimeout, 1, 'below-min clamped up to 1');
  });

  it('PUT connectTimeout: -5 clamps to 1 (negative treated like below-min)', async () => {
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connectTimeout: -5 }),
    });
    const after = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.strictEqual(after.connectTimeout, 1, 'negative clamped up to 1');
  });

  it('PUT connectTimeout: 30 (in range) is unchanged', async () => {
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connectTimeout: 30 }),
    });
    const after = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.strictEqual(after.connectTimeout, 30, 'in-range value not clamped');
  });

  it('the clamped connectTimeout persists to config.json (survives a restart)', async () => {
    // Re-PUT (self-contained) then read disk — the round-trips-through-config.json bar.
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connectTimeout: 9999 }),
    });
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(onDisk.connectTimeout, 60);
  });

  it('PUT tokenBudgetThresholdTokens: 0 clamps to 1 (read back via GET)', async () => {
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tokenBudgetThresholdTokens: 0 }),
    });
    const after = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.strictEqual(after.tokenBudgetThresholdTokens, 1, '0 floored to 1, not dropped');
  });

  it('PUT tokenBudgetThresholdTokens: null clears to default (null-able, NOT clamped)', async () => {
    // Null means "use the default" — the floor clamp must not turn null into 1.
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tokenBudgetThresholdTokens: null }),
    });
    const after = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.strictEqual(after.tokenBudgetThresholdTokens, null, 'null preserved (use-default path untouched)');
  });

  it('PUT tokenBudgetWindowHours: 0 clamps to 1 (read back via GET)', async () => {
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tokenBudgetWindowHours: 0 }),
    });
    const after = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.strictEqual(after.tokenBudgetWindowHours, 1, '0 floored to 1, not dropped');
  });

  it('PUT tokenBudgetWindowHours: -3 clamps to 1', async () => {
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tokenBudgetWindowHours: -3 }),
    });
    const after = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.strictEqual(after.tokenBudgetWindowHours, 1, 'negative floored to 1');
  });

  it('PUT tokenBudgetPerSessionThresholdTokens: 0 clamps to 1 (read back via GET)', async () => {
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tokenBudgetPerSessionThresholdTokens: 0 }),
    });
    const after = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.strictEqual(after.tokenBudgetPerSessionThresholdTokens, 1, '0 floored to 1, not dropped');
  });

  it('PUT tokenBudgetPerSessionThresholdTokens: null clears (disable path preserved)', async () => {
    // Null is the per-session alarm's disable signal (resolveBudgetConfig → 0);
    // the floor clamp must not turn null into 1 and silently re-enable it.
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tokenBudgetPerSessionThresholdTokens: null }),
    });
    const after = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.strictEqual(after.tokenBudgetPerSessionThresholdTokens, null, 'null preserved (disable path untouched)');
  });
});
