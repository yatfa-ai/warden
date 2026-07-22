import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * HTTP integration tests for the Observer model/provider config (WARDEN-350).
 *
 * Extends the /api/config wire-contract coverage in server-config.test.js to the
 * new `llm` object: GET must return model/baseUrl/maxTokens and MASK the auth
 * token (authTokenSet + authTokenTail only — never the cleartext secret); PUT
 * must persist model/baseUrl/maxTokens and NO-CLOBBER the auth token when the
 * field is omitted or empty (the UI never seeds the password field, so an
 * unchanged save must not blank the stored secret).
 *
 * Runs against the REAL Express app from src/server.js, with HOME redirected to
 * a temp dir whose config.json is seeded with a token BEFORE the server loads —
 * so the GET-masking test has a real secret to mask. (Each test file runs in its
 * own process, so server.js's module-load `cfg = load()` reads our seeded file.)
 */
describe('/api/config llm (Observer model — WARDEN-350)', () => {
  let httpServer;
  let baseUrl;
  let originalHome;
  let tempHome;
  let configPath;

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-llm-config-'));
    process.env.HOME = tempHome;
    const wardenDir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wardenDir, { recursive: true });
    configPath = path.join(wardenDir, 'config.json');
    // Seed a pre-existing token so the GET-masking test has a secret to mask.
    fs.writeFileSync(configPath, JSON.stringify({
      hosts: [],
      llm: { authToken: 'sk-secret-1234', model: 'seeded-model' },
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
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('GET /api/config exposes llm.model and never returns the cleartext authToken', async () => {
    const res = await fetch(`${baseUrl}/api/config`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(body.llm, 'llm object must be present on GET');
    assert.strictEqual(body.llm.model, 'seeded-model', 'seeded model round-trips');
    // The cleartext token must NEVER be on the wire — only the masked indicator.
    assert.ok(!('authToken' in body.llm), 'cleartext authToken must not be returned');
    assert.strictEqual(body.llm.authTokenSet, true, 'authTokenSet reflects a stored token');
    assert.strictEqual(body.llm.authTokenTail, '1234', 'authTokenTail is the last 4 chars');
    // Defense-in-depth: the cleartext secret must not appear anywhere in the body.
    assert.ok(!JSON.stringify(body).includes('sk-secret-1234'), 'cleartext token must not leak anywhere in the response');
  });

  it('PUT persists llm.model/baseUrl/maxTokens and a subsequent GET reflects them', async () => {
    const res = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ llm: { model: 'glm-5.2', baseUrl: 'https://gateway.example.com', maxTokens: 8192 } }),
    });
    assert.strictEqual(res.status, 200);
    const after = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.strictEqual(after.llm.model, 'glm-5.2');
    assert.strictEqual(after.llm.baseUrl, 'https://gateway.example.com');
    assert.strictEqual(after.llm.maxTokens, 8192);
  });

  it('PUT persists to config.json on disk (survives a restart)', async () => {
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(onDisk.llm.model, 'glm-5.2');
    assert.strictEqual(onDisk.llm.baseUrl, 'https://gateway.example.com');
    assert.strictEqual(onDisk.llm.maxTokens, 8192);
  });

  it('a saved model is used by the next llm.js resolveModel() call (live, no restart)', async () => {
    // The ticket's core "done" criterion: PUT /api/config writes config.json, and
    // llm.js's per-call resolver reads it on the next call — NO app restart. This
    // bridges the two halves (HTTP round-trip + per-call re-read) end-to-end.
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ llm: { model: 'live-applied-model[1m]' } }),
    });
    // Clear model env overrides so resolveModel() reads the config file we just
    // wrote (HOME is already tempHome, so ~/.claude/settings.json is absent).
    const envKeys = ['WARDEN_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_MODEL'];
    const saved = {};
    for (const k of envKeys) { saved[k] = process.env[k]; delete process.env[k]; }
    try {
      const { resolveModel } = await import('./llm.js');
      assert.strictEqual(resolveModel(), 'live-applied-model', 'PUT value is live on the next resolveModel() call');
    } finally {
      for (const k of envKeys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  });

  it('PUT with a new authToken updates the stored token (GET tail changes)', async () => {
    const res = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ llm: { authToken: 'sk-replaced-9999' } }),
    });
    assert.strictEqual(res.status, 200);
    const after = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.strictEqual(after.llm.authTokenSet, true);
    assert.strictEqual(after.llm.authTokenTail, '9999');
    assert.ok(!('authToken' in after.llm), 'still masked after an update');
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(onDisk.llm.authToken, 'sk-replaced-9999', 'new token persisted to disk');
  });

  it('PUT WITHOUT authToken does NOT clobber the stored token', async () => {
    // The UI never seeds the password field, so an unchanged save sends no
    // authToken. The stored secret must survive — this is the no-clobber rule
    // the whole masked-field design depends on.
    const res = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ llm: { model: 'another-model' } }),
    });
    assert.strictEqual(res.status, 200);
    const after = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.strictEqual(after.llm.authTokenSet, true, 'token still present after a no-authToken save');
    assert.strictEqual(after.llm.authTokenTail, '9999', 'same token tail — not blanked');
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(onDisk.llm.authToken, 'sk-replaced-9999', 'stored secret survives an unchanged save');
  });

  it('PUT with an empty authToken does NOT clobber the stored token', async () => {
    const res = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ llm: { authToken: '' } }),
    });
    assert.strictEqual(res.status, 200);
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(onDisk.llm.authToken, 'sk-replaced-9999', 'empty string must not blank the stored secret');
  });

  it('PUT with llm.authToken: null CLEARS the stored token (the Remove action — WARDEN-883)', async () => {
    const token = 'sk-clear-on-remove-4242';
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ llm: { authToken: token } }),
    });
    assert.strictEqual(
      (await (await fetch(`${baseUrl}/api/config`)).json()).llm.authTokenSet,
      true,
      'precondition: token is set',
    );
    // The Remove control sends the nested field as explicit null (NOT omitted, NOT '').
    const res = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ llm: { authToken: null } }),
    });
    assert.strictEqual(res.status, 200);
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(onDisk.llm.authToken, '', 'cleartext cleared on disk (nested path)');
    const after = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.strictEqual(after.llm.authTokenSet, false, 'GET reports the token as unset');
    assert.strictEqual(after.llm.authTokenTail, null, 'no tail once cleared');
    assert.ok(!('authToken' in after.llm), 'still no cleartext token in the GET response');
  });

  it('PUT with maxTokens: null clears the override (GET reports null / default)', async () => {
    const res = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ llm: { maxTokens: null } }),
    });
    assert.strictEqual(res.status, 200);
    const after = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.strictEqual(after.llm.maxTokens, null, 'null means "use the llm.js default (2048)"');
  });

  it('PUT with a non-positive maxTokens is ignored by the type guard (no mutation)', async () => {
    // First set a valid value.
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ llm: { maxTokens: 4096 } }),
    });
    // A malformed value must NOT overwrite it.
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ llm: { maxTokens: -5 } }),
    });
    const after = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.strictEqual(after.llm.maxTokens, 4096, 'left unchanged, not overwritten with a non-positive value');
  });
});
