import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * HTTP integration tests for POST /api/config/reset (WARDEN-889), run against
 * the REAL Express app from src/server.js. Same isolated-server pattern as
 * server-config.test.js: unique temp HOME, own config.json, the server set up
 * once in before() and shared across the describe (the module caches `cfg`).
 *
 * WARDEN-889 gave the backend /api/config a reset-to-defaults path. Until it,
 * the Settings danger zone had exactly ONE reset action and it touched ONLY
 * client-side UI prefs — the consequential backend settings (webhook /
 * telemetry / observer / hosts / …) had no reset path, and the write-only
 * secrets a GET masks could not be cleared via the UI at all. These pin the new
 * path end-to-end:
 *
 *   - a confirm-gated POST restores a seeded non-default backend state to the
 *     deriveDefaults() output, read back via GET (webhook/observer/telemetry);
 *   - the write-only secrets (webhook / telemetry / observer auth tokens) are
 *     CLEARED — the load-bearing reason resetConfig bypasses applyConfigPut's
 *     secret no-clobber;
 *   - the reset round-trips through save (survives a restart — read from disk);
 *   - the live side-effects fire (the companion env gate flips back to OFF via
 *     afterSave → applyCompanionToggle, exactly as a PUT would);
 *   - internal USER DATA (pinned chats / notes / session tags) survives — a
 *     backend-config reset must not wipe them.
 *
 * The per-field restoration correctness is already guaranteed by reusing
 * deriveDefaults (unit-pinned in config-schema.test.js); this file pins the
 * wire contract + the persist/live-apply path.
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
  // server.js (it snapshots the override + writes the gate at import time).
  // Restore in after() so the value written here never leaks to other files.
  originalCompanionEnv = process.env.WARDEN_COMPANION_TRANSPORT;
  companionEnvOverriddenAtBoot = originalCompanionEnv !== undefined;

  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-config-reset-'));
  process.env.HOME = tempHome;
  const wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  configPath = path.join(wardenDir, 'config.json');
  // Seed USER DATA on disk (internal fields, managed by their own endpoints —
  // NOT settings) so we can assert a backend-config reset preserves them. No
  // backend preferences on disk → defaults merge supplies them.
  fs.writeFileSync(configPath, JSON.stringify({
    hosts: [],
    pins: ['pinned-chat-1', 'pinned-chat-2'],
    agentNotes: { 'agent-x': 'important note' },
    sessionTags: { 'sess-1': ['deploy', 'review'] },
  }));

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

async function putConfig(body) {
  const res = await fetch(`${baseUrl}/api/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.strictEqual(res.status, 200, `PUT /api/config failed: ${res.status}`);
}

async function resetConfigHttp() {
  const res = await fetch(`${baseUrl}/api/config/reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.strictEqual(res.status, 200, `POST /api/config/reset failed: ${res.status}`);
  assert.strictEqual((await res.json()).ok, true);
}

async function getConfig() {
  const res = await fetch(`${baseUrl}/api/config`);
  assert.strictEqual(res.status, 200);
  return res.json();
}

describe('POST /api/config/reset — restores a configured backend to defaults', () => {
  it('clears a configured webhook setup back to unconfigured (sends nothing)', async () => {
    // Seed a fully-configured webhook channel + observer model + telemetry, then
    // reset and confirm GET reflects the defaults across every exposure class.
    await putConfig({
      webhookUrl: 'https://hooks.example/notify',
      webhookEnabled: true,
      webhookAlertAttention: false,
      webhookAlertBudget: false,
      webhookAlertDone: false,
      llm: { model: 'glm-5.2', baseUrl: 'https://api.x.example', maxTokens: 9000 },
      observerAutoStart: true,
      observerConfirmMode: 'auto-safe',
      telemetryBaseEnabled: true,
      telemetryExtendedEnabled: true,
      telemetryEndpoint: 'https://receiver.example/ingest',
      tokenBudgetEnabled: true,
      hideOfflineHosts: true,
    });
    await resetConfigHttp();
    const after = await getConfig();
    // Webhook reverted to off / unconfigured.
    assert.strictEqual(after.webhookUrl, '', 'webhookUrl cleared');
    assert.strictEqual(after.webhookEnabled, false, 'webhookEnabled back to off');
    assert.strictEqual(after.webhookAlertAttention, true, 'routing toggle back to default true');
    assert.strictEqual(after.webhookAlertBudget, true);
    assert.strictEqual(after.webhookAlertDone, true);
    // Observer LLM config reverted to empty (llm.js owns its own fallbacks).
    assert.strictEqual(after.llm.model, '', 'observer model cleared');
    assert.strictEqual(after.llm.baseUrl, '');
    assert.strictEqual(after.llm.maxTokens, null);
    // Observer knobs + telemetry + display prefs reverted.
    assert.strictEqual(after.observerAutoStart, false);
    assert.strictEqual(after.observerConfirmMode, 'always');
    assert.strictEqual(after.telemetryBaseEnabled, false, 'telemetry base back to off-by-default');
    assert.strictEqual(after.telemetryExtendedEnabled, false);
    assert.strictEqual(after.telemetryEndpoint, '', 'telemetry endpoint cleared');
    assert.strictEqual(after.tokenBudgetEnabled, false);
    assert.strictEqual(after.hideOfflineHosts, false);
  });

  it('CLEARS the write-only secrets a GET masks (no other UI path clears them)', async () => {
    // The load-bearing case: the auth tokens are write-only (GET never returns
    // cleartext), so a user cannot blank them via a normal Save — the secret
    // no-clobber preserves an untouched field. Reset MUST clear them.
    await putConfig({
      webhookSecret: 'sec-WXYZ',
      telemetryAuthToken: 'tok-ABCD',
      llm: { authToken: 'sk-EFGH' },
    });
    // Sanity: the seeded secrets show as Set before the reset.
    const before = await getConfig();
    assert.strictEqual(before.webhookSecretSet, true);
    assert.strictEqual(before.telemetryAuthTokenSet, true);
    assert.strictEqual(before.llm.authTokenSet, true);

    await resetConfigHttp();
    const after = await getConfig();
    // Cleared on the wire: Set=false, Tail=null.
    assert.strictEqual(after.webhookSecretSet, false, 'webhook secret cleared');
    assert.strictEqual(after.webhookSecretTail, null);
    assert.strictEqual(after.telemetryAuthTokenSet, false, 'telemetry auth token cleared');
    assert.strictEqual(after.telemetryAuthTokenTail, null);
    assert.strictEqual(after.llm.authTokenSet, false, 'observer auth token cleared');
    assert.strictEqual(after.llm.authTokenTail, null);
    // And cleared on disk (the cleartext is gone from config.json).
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(onDisk.webhookSecret, '', 'cleartext webhookSecret gone from disk');
    assert.strictEqual(onDisk.telemetryAuthToken, '', 'cleartext telemetryAuthToken gone from disk');
    assert.deepStrictEqual(onDisk.llm, {}, 'llm (incl. authToken) gone from disk');
  });

  it('round-trips through config.json — the defaults survive a restart', async () => {
    // Seed, reset, read disk: the persisted file is the deriveDefaults() set
    // (the "it round-trips through save" success criterion), not the seeded
    // non-default state.
    await putConfig({ webhookUrl: 'https://hooks.example/x', webhookEnabled: true, connectTimeout: 60 });
    await resetConfigHttp();
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(onDisk.webhookUrl, '', 'webhookUrl default persisted');
    assert.strictEqual(onDisk.webhookEnabled, false, 'webhookEnabled default persisted');
    assert.strictEqual(onDisk.connectTimeout, 10, 'connectTimeout default persisted');
  });

  it('fires the live side-effects via afterSave (companion gate flips back to OFF)', async () => {
    // afterSave re-applies applyCompanionToggle on the reset path, exactly as a
    // PUT would. Seed companion ON (gate → '1' when not operator-overridden),
    // reset (default is OFF → gate back to '0'), and assert the live gate
    // flipped — proving the reset takes effect live, not just on restart.
    await putConfig({ companionTransportEnabled: true });
    if (!companionEnvOverriddenAtBoot) {
      assert.strictEqual(process.env.WARDEN_COMPANION_TRANSPORT, '1', 'gate ON after seed');
    }
    await resetConfigHttp();
    const after = await getConfig();
    assert.strictEqual(after.companionTransportEnabled, false, 'companion back to default OFF');
    if (!companionEnvOverriddenAtBoot) {
      assert.strictEqual(process.env.WARDEN_COMPANION_TRANSPORT, '0',
        'live gate flipped back to OFF via afterSave — reset is live, not restart-only');
    }
  });

  it('PRESERVES pinned chats / notes / session tags (internal user data, not settings)', async () => {
    // internal fields are managed by their own endpoints; a backend-config reset
    // must not wipe them. They were seeded on disk in before(); after a reset
    // they must still be on disk (and the live cfg).
    await putConfig({ webhookUrl: 'https://hooks.example/y' }); // touch a setting
    await resetConfigHttp();
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepStrictEqual(onDisk.pins, ['pinned-chat-1', 'pinned-chat-2'], 'pins preserved');
    assert.deepStrictEqual(onDisk.agentNotes, { 'agent-x': 'important note' }, 'agentNotes preserved');
    assert.deepStrictEqual(onDisk.sessionTags, { 'sess-1': ['deploy', 'review'] }, 'sessionTags preserved');
  });

  it('is idempotent — resetting an already-default config is a no-op', async () => {
    // Resetting twice in a row leaves the config at defaults (a second reset
    // changes nothing) — the danger-zone action is safe to repeat.
    await putConfig({ webhookUrl: 'https://hooks.example/z' });
    await resetConfigHttp();
    const first = await getConfig();
    await resetConfigHttp();
    const second = await getConfig();
    assert.deepStrictEqual(first, second, 'a second reset is a no-op (already at defaults)');
  });
});
