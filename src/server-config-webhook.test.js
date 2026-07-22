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
let originalFetch;
let tempHome;
let configPath;
let webhookProbe; // delegating global-fetch stub: local app calls → real fetch, outbound webhook → scripted

before(async () => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-cfg-webhook-'));
  process.env.HOME = tempHome;
  const wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  configPath = path.join(wardenDir, 'config.json');
  // No webhook fields on disk — DEFAULTS must supply the off-by-default values.
  fs.writeFileSync(configPath, JSON.stringify({ hosts: [] }));

  // Capture the real fetch BEFORE installing the stub. The stub delegates any
  // call to the LOCAL app (baseUrl) to the real fetch, so get()/put() and the
  // webhook-test POSTs below keep hitting the real Express server; any OUTBOUND
  // webhook call (to a draft/persisted webhook URL) hits the scripted responder
  // instead, so the draft-body cases make ZERO real network calls. The route
  // resolves globalThis.fetch at request time, so installing it here covers every
  // test. (Same delegating trick telemetry-test uses, adapted because this file
  // calls the local app via fetch rather than node:http.)
  originalFetch = globalThis.fetch;

  const { app } = await import('./server.js');
  httpServer = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    httpServer.once('listening', resolve);
    httpServer.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  webhookProbe = makeWebhookProbe(originalFetch, () => baseUrl);
  globalThis.fetch = webhookProbe.fetchImpl;
});

after(async () => {
  if (httpServer) await new Promise((r) => httpServer.close(r));
  if (originalFetch === undefined) delete globalThis.fetch;
  else globalThis.fetch = originalFetch;
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

// A delegating global-fetch stub for the draft-body tests (WARDEN-775). Calls to
// the LOCAL app (baseUrl) pass through to the real fetch so get()/put() and the
// webhook-test POSTs hit the real Express server; any OUTBOUND webhook call (to
// a draft/persisted webhook URL) hits the scripted { status } responder and is
// recorded in `calls` so a test can assert WHICH url/secret the backend used.
// `getBaseUrl` is a thunk because baseUrl is assigned in before(), after this
// factory is referenced.
function makeWebhookProbe(realFetch, getBaseUrl) {
  const calls = [];
  let next = { status: 200 };
  const fetchImpl = async (url, init) => {
    if (typeof url === 'string' && url.startsWith(getBaseUrl())) return realFetch(url, init);
    calls.push({ url, init });
    const status = next.status;
    return { status, ok: status >= 200 && status < 300, json: async () => ({}) };
  };
  return {
    fetchImpl,
    calls,
    set next(value) { next = value; },
    reset() { calls.length = 0; next = { status: 200 }; },
  };
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

  it('explicit null CLEARS the stored webhookSecret (the Remove action — WARDEN-883)', async () => {
    const secret = 'sec_remove_me_3456';
    await put({ webhookSecret: secret });
    assert.strictEqual((await get()).webhookSecretSet, true, 'precondition: secret is set');
    // The Remove control sends the field as explicit null (NOT omitted, NOT '').
    await put({ webhookSecret: null });
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(onDisk.webhookSecret, '', 'cleartext cleared on disk');
    const body = await get();
    assert.strictEqual(body.webhookSecretSet, false, 'GET reports the secret as unset');
    assert.strictEqual(body.webhookSecretTail, null, 'no tail once cleared');
    assert.ok(!('webhookSecret' in body), 'still no cleartext secret in the GET response');
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

describe('POST /api/webhook-test — URL gate (no real network)', () => {
  it('no-ops (attempts 0, no send) when no URL is resolved (neither draft nor persisted)', async () => {
    // The test endpoint forces webhookEnabled (it is the sanctioned explicit-send
    // path — see the draft-body block below), so the only remaining no-op is an
    // EMPTY resolved URL: no draft in the body and none persisted. sendWebhook's
    // URL gate then closes, fetchImpl is never called, and ZERO real network is
    // made. The result mirrors the gate.
    webhookProbe.reset();
    await put({ webhookEnabled: false, webhookUrl: '' });
    const res = await fetch(`${baseUrl}/api/webhook-test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body, { ok: false, dropped: false, attempts: 0, status: null });
    assert.strictEqual(webhookProbe.calls.length, 0, 'no outbound POST was made');
  });
});

describe('POST /api/webhook-test — tests the DRAFT url/secret from the body (WARDEN-775)', () => {
  // These cases script the outbound fetch via webhookProbe so ZERO real network
  // calls are made: a 200 responder means dispatchWebhook delivered, and
  // webhookProbe.calls captures the outbound URL + headers so each test asserts
  // WHICH url/secret the backend actually used (draft vs persisted) — the
  // property the ticket's acceptance criteria hinge on.

  it('dispatches to the body webhookUrl, NOT the persisted one (acceptance #1, the typo-fix case)', async () => {
    // Persisted URL is the "old" destination; the body carries the draft (new) URL
    // a user typed but has NOT yet saved. The test must go to the draft.
    await put({ webhookEnabled: true, webhookUrl: 'https://persisted.example/old' });
    webhookProbe.reset();
    webhookProbe.next = { status: 200 };
    const res = await fetch(`${baseUrl}/api/webhook-test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ webhookUrl: 'https://draft.example/new' }),
    });
    const body = await res.json();
    assert.strictEqual(body.ok, true, 'delivered (2xx from the scripted responder)');
    assert.strictEqual(body.attempts, 1);
    assert.strictEqual(webhookProbe.calls.length, 1, 'exactly one outbound POST');
    assert.strictEqual(webhookProbe.calls[0].url, 'https://draft.example/new', 'went to the DRAFT url, not the persisted one');
  });

  it('falls back to the persisted webhookUrl when the body sends none (acceptance #2, unchanged behavior)', async () => {
    await put({ webhookEnabled: true, webhookUrl: 'https://persisted.example/kept' });
    webhookProbe.reset();
    webhookProbe.next = { status: 200 };
    await (await fetch(`${baseUrl}/api/webhook-test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })).json();
    assert.strictEqual(webhookProbe.calls.length, 1);
    assert.strictEqual(webhookProbe.calls[0].url, 'https://persisted.example/kept', 'fell back to the persisted url');
  });

  it('uses the draft webhookSecret when supplied (signed on the outbound POST)', async () => {
    await put({ webhookEnabled: true, webhookUrl: 'https://dest.example/x', webhookSecret: 'sec_persisted' });
    webhookProbe.reset();
    webhookProbe.next = { status: 200 };
    await (await fetch(`${baseUrl}/api/webhook-test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ webhookUrl: 'https://dest.example/x', webhookSecret: 'sec_draft' }),
    })).json();
    assert.strictEqual(webhookProbe.calls[0].init.headers.authorization, 'Bearer sec_draft', 'used the DRAFT secret');
    assert.strictEqual(webhookProbe.calls[0].init.headers['x-webhook-secret'], 'sec_draft', 'signed under both header names');
  });

  it('uses the persisted webhookSecret when the body sends none (acceptance #3, no-clobber)', async () => {
    await put({ webhookEnabled: true, webhookUrl: 'https://dest.example/x', webhookSecret: 'sec_persisted' });
    webhookProbe.reset();
    webhookProbe.next = { status: 200 };
    await (await fetch(`${baseUrl}/api/webhook-test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ webhookUrl: 'https://dest.example/x' }),
    })).json();
    assert.strictEqual(webhookProbe.calls[0].init.headers.authorization, 'Bearer sec_persisted', 'fell back to the persisted secret');
  });

  it('forces webhookEnabled for the explicit test send even when persisted disabled (first-time-setup, WARDEN-775 design note)', async () => {
    // Persisted enabled=false, but the human clicked the explicit test button
    // with a URL typed — the test is the sanctioned explicit-send path, so it
    // still dispatches (parity with /api/telemetry-test, which has no enable
    // gate). The off-by-default invariant still holds for every AUTOMATIC path
    // (budget/attention/finished hooks dispatch via persisted cfg directly).
    await put({ webhookEnabled: false, webhookUrl: 'https://dest.example/x' });
    webhookProbe.reset();
    webhookProbe.next = { status: 200 };
    const body = await (await fetch(`${baseUrl}/api/webhook-test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ webhookUrl: 'https://dest.example/x' }),
    })).json();
    assert.strictEqual(body.ok, true, 'explicit test send bypasses the persisted enable gate');
    assert.strictEqual(webhookProbe.calls.length, 1);
  });
});
