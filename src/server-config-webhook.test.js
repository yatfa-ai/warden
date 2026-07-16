import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Webhook push fields round-trip through /api/config (WARDEN-555). A pref that
// exists in config.js DEFAULTS but is missing from the GET safe-subset OR the
// PUT type-guarded writer is a silent no-op from the renderer's view (the
// WARDEN-115/WARDEN-131 dead-pref trap) — these pin all three links of the
// hand-maintained /api/config whitelist: config.js DEFAULTS, GET, and PUT.
//
// Also pins the secret-handling contract: GET NEVER returns cleartext (only
// webhookSecretSet + a tail), and an untouched password field on save is
// no-clobbered (mirrors llm.authToken) — so a Settings save that leaves the
// secret blank preserves the stored secret.
//
// Same isolated-server pattern as server-config-telemetry.test.js: unique temp
// HOME, own config.json, real Express app. node --test runs each file in its own
// process, so this never cross-talks with the other server-config-*.test.js.

let httpServer;
let baseUrl;
let originalHome;
let tempHome;
let configPath;

before(async () => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-cfg-webhook-'));
  process.env.HOME = tempHome;
  const wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  configPath = path.join(wardenDir, 'config.json');
  // No webhook fields on disk — DEFAULTS must supply the off-by-default values.
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

async function put(body) {
  return fetch(`${baseUrl}/api/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
async function get() {
  return (await (await fetch(`${baseUrl}/api/config`)).json());
}

describe('/api/config webhook fields — GET defaults (link 2 of the whitelist)', () => {
  it('exposes the webhook fields with off-by-default values', async () => {
    const body = await get();
    assert.strictEqual(body.webhookUrl, '', 'webhookUrl present + empty default');
    assert.strictEqual(body.webhookEnabled, false, 'webhookEnabled present + false default');
    assert.strictEqual(body.webhookSecretSet, false, 'webhookSecretSet present + false default');
    assert.strictEqual(body.webhookSecretTail, null, 'webhookSecretTail present + null default');
    assert.strictEqual(body.webhookAlertAttention, true, 'attention routing default true');
    assert.strictEqual(body.webhookAlertBudget, true, 'budget routing default true');
  });

  it('NEVER returns a cleartext webhookSecret field (write-only)', async () => {
    const body = await get();
    assert.ok(!('webhookSecret' in body), 'no cleartext secret in the GET safe-subset');
  });
});

describe('/api/config webhook fields — PUT round-trip + persistence (links 1+3)', () => {
  it('PUT webhookUrl (string) round-trips via GET and persists to config.json', async () => {
    const url = 'https://ntfy.selfhosted.example/alerts';
    assert.strictEqual((await put({ webhookUrl: url })).status, 200);
    assert.strictEqual((await get()).webhookUrl, url, 'GET/PUT whitelist is symmetric');
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(onDisk.webhookUrl, url, 'persisted to ~/.yatfa-warden/config.json');
  });

  it('PUT webhookUrl with an empty string clears it (back to sends-nothing)', async () => {
    await put({ webhookUrl: 'https://tmp.example/x' });
    await put({ webhookUrl: '' });
    assert.strictEqual((await get()).webhookUrl, '', 'empty string accepted — clears the url');
  });

  it('PUT webhookEnabled (boolean) round-trips', async () => {
    await put({ webhookEnabled: true });
    assert.strictEqual((await get()).webhookEnabled, true);
    await put({ webhookEnabled: false });
    assert.strictEqual((await get()).webhookEnabled, false);
  });

  it('PUT webhookAlertAttention / webhookAlertBudget (booleans) round-trip', async () => {
    await put({ webhookAlertAttention: false, webhookAlertBudget: false });
    const after = await get();
    assert.strictEqual(after.webhookAlertAttention, false);
    assert.strictEqual(after.webhookAlertBudget, false);
    await put({ webhookAlertAttention: true, webhookAlertBudget: true });
    const on = await get();
    assert.strictEqual(on.webhookAlertAttention, true);
    assert.strictEqual(on.webhookAlertBudget, true);
  });
});

describe('/api/config webhook secret — masking + no-clobber (acceptance #3)', () => {
  it('PUT a non-empty webhookSecret sets it; GET shows secretSet + tail, NEVER cleartext', async () => {
    const secret = 'sec_supersecret_1234';
    assert.strictEqual((await put({ webhookSecret: secret })).status, 200);
    const body = await get();
    assert.strictEqual(body.webhookSecretSet, true, 'secret is set');
    assert.strictEqual(body.webhookSecretTail, '1234', 'tail is the last 4 chars');
    assert.ok(!('webhookSecret' in body), 'still no cleartext secret after setting one');
    // And it persisted (read cleartext off disk directly — the only place it lives).
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(onDisk.webhookSecret, secret, 'persisted to config.json');
  });

  it('no-clobber: a save with NO webhookSecret field leaves the stored secret intact', async () => {
    const secret = 'sec_keepme_5678';
    await put({ webhookSecret: secret });
    // A Settings save that leaves the password field untouched sends no
    // webhookSecret at all (the field is write-only; GET never seeds it).
    await put({ webhookUrl: 'https://example.test/new', webhookEnabled: true });
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(onDisk.webhookSecret, secret, 'untouched secret survived the save');
    const body = await get();
    assert.strictEqual(body.webhookSecretSet, true);
    assert.strictEqual(body.webhookSecretTail, '5678');
  });

  it('no-clobber: an EMPTY webhookSecret string also does not blank the stored secret', async () => {
    const secret = 'sec_keepme_9012';
    await put({ webhookSecret: secret });
    // The renderer sends '' when the (unseeded) field is left blank; the guard
    // requires length > 0, so the empty string is ignored (mirrors llm.authToken).
    await put({ webhookSecret: '' });
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(onDisk.webhookSecret, secret, 'empty string did not clear the secret');
  });
});

describe('/api/config webhook fields — type guards (acceptance #6, no mutation)', () => {
  it('PUT a non-string webhookUrl is ignored (no mutation)', async () => {
    const url = 'https://valid.example/a';
    await put({ webhookUrl: url });
    await put({ webhookUrl: 12345 });
    assert.strictEqual((await get()).webhookUrl, url, 'left unchanged, not overwritten with a number');
  });

  it('PUT a non-boolean webhookEnabled is ignored (no mutation)', async () => {
    await put({ webhookEnabled: true });
    await put({ webhookEnabled: 'yes' });
    assert.strictEqual((await get()).webhookEnabled, true, 'left unchanged, not overwritten with a string');
  });
});

describe('POST /api/webhook-test — honors the on-the-wire gate (no real network)', () => {
  it('no-ops (attempts 0, no send) when the channel is disabled', async () => {
    // Disabled + no URL → dispatchWebhook is a strict no-op: fetchImpl is never
    // called, so this makes ZERO real network calls. The result mirrors the gate.
    await put({ webhookEnabled: false, webhookUrl: '' });
    const res = await fetch(`${baseUrl}/api/webhook-test`, { method: 'POST' });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body, { ok: false, dropped: false, attempts: 0, status: null });
  });

  it('no-ops (attempts 0) when enabled but no URL is configured', async () => {
    await put({ webhookEnabled: true, webhookUrl: '' });
    const body = await (await fetch(`${baseUrl}/api/webhook-test`, { method: 'POST' })).json();
    assert.deepStrictEqual(body, { ok: false, dropped: false, attempts: 0, status: null });
  });
});
