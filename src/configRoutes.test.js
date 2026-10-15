// Unit-level spec for createConfigRouter (src/configRoutes.js), moved out of
// server.js by WARDEN-1810. The eight server-importing suites reach these routes
// only indirectly; this file pins the route glue they never assert: the
// webhook-test alert envelope + draft trimming/fallback, the telemetry-test
// endpoint/token sanitising, both 500 error channels, the GET companion flag
// threading, and the save-before-afterSave ordering of PUT and reset.
//
// Isolation: a bare express app mounting the router with injected fakes. No
// server.js import, no HOME writes, no real network — globalThis.fetch is a
// delegating stub (the local app's own URL goes to the real fetch; every
// outbound call is recorded and answered with a canned response).

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createConfigRouter } from './configRoutes.js';
import { CLIENT_SCHEMA_VERSION } from './telemetry-capabilities.js';

let httpServer;
let baseUrl;
let originalFetch;
let realFetch;
let outbound; // recorded non-local fetch calls
let cfg;
let events; // ordered log of save/afterSave lifecycle events
let afterSaveCalls;
let nextSchemaVersion = CLIENT_SCHEMA_VERSION;

function makeAfterSaveDeps() {
  const record = (name) => (...args) => { events.push(name); afterSaveCalls.push({ name, args }); };
  return {
    companionOverridden: false,
    forwardTelemetryConfig: record('forwardTelemetryConfig'),
    applyCompanionToggle: record('applyCompanionToggle'),
    applyCompanionExclusions: record('applyCompanionExclusions'),
    restartBudgetPoll: record('restartBudgetPoll'),
  };
}

// An async save with a short delay that records WHEN it completed, so the
// ordering test can tell "afterSave ran after save finished" from "afterSave ran
// right after save was merely called".
let saveCount;
async function save() {
  saveCount += 1;
  events.push('save:start');
  await new Promise((r) => setTimeout(r, 15));
  events.push('save:done');
}

before(async () => {
  realFetch = globalThis.fetch;
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith(baseUrl)) return realFetch(url, init);
    outbound.push({ url: String(url), init });
    return {
      status: 200,
      ok: true,
      json: async () => ({ schemaVersion: nextSchemaVersion, authRequired: false }),
    };
  };

  const app = express();
  app.use(express.json());
  cfg = {};
  app.use(createConfigRouter({
    cfg,
    save: (c) => save(c),
    companionEnvOverridden: true,
    afterSaveDeps: makeAfterSaveDeps(),
  }));
  httpServer = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    httpServer.once('listening', resolve);
    httpServer.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

after(async () => {
  if (httpServer) await new Promise((r) => httpServer.close(r));
  if (originalFetch === undefined) delete globalThis.fetch;
  else globalThis.fetch = originalFetch;
});

beforeEach(() => {
  outbound = [];
  events = [];
  afterSaveCalls = [];
  saveCount = 0;
  nextSchemaVersion = CLIENT_SCHEMA_VERSION;
});

async function call(method, route, body) {
  const res = await realFetch(`${baseUrl}${route}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// The router receives `cfg` by value at construction, so the live object is the
// one assigned in before(); mutate it in place per test via this helper.
function setCfg(values) {
  for (const k of Object.keys(cfg)) delete cfg[k];
  Object.assign(cfg, values);
}

describe('createConfigRouter — POST /api/webhook-test', () => {
  it('sends the exact test-alert envelope (app/event/severity/agent/reason) to the persisted URL', async () => {
    setCfg({ webhookUrl: 'https://hooks.example/persisted', webhookSecret: '' });
    const { status, body } = await call('POST', '/api/webhook-test', {});
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(outbound.length, 1);
    assert.equal(outbound[0].url, 'https://hooks.example/persisted');
    const sent = JSON.parse(outbound[0].init.body);
    assert.equal(sent.app, 'warden');
    assert.equal(sent.event, 'test');
    assert.equal(sent.severity, 'info');
    assert.equal(sent.agent, 'Warden');
    assert.equal(sent.reason, 'Test alert from Warden — your webhook is configured correctly.');
    assert.equal(typeof sent.ts, 'number');
  });

  it('sends even when persisted webhookEnabled is false (the button is the opt-in)', async () => {
    setCfg({ webhookUrl: 'https://hooks.example/persisted', webhookEnabled: false });
    await call('POST', '/api/webhook-test', {});
    assert.equal(outbound.length, 1);
  });

  it('trims a padded draft webhookUrl and sends to the trimmed destination', async () => {
    setCfg({ webhookUrl: 'https://hooks.example/persisted' });
    await call('POST', '/api/webhook-test', { webhookUrl: '   https://hooks.example/draft  \n' });
    assert.equal(outbound.length, 1);
    assert.equal(outbound[0].url, 'https://hooks.example/draft');
  });

  it('falls back to the persisted URL for a whitespace-only draft URL (no 500)', async () => {
    setCfg({ webhookUrl: 'https://hooks.example/persisted' });
    const { status } = await call('POST', '/api/webhook-test', { webhookUrl: '   ' });
    assert.equal(status, 200);
    assert.equal(outbound[0].url, 'https://hooks.example/persisted');
  });

  it('falls back to the persisted URL for a non-string draft URL (no 500)', async () => {
    setCfg({ webhookUrl: 'https://hooks.example/persisted' });
    const { status } = await call('POST', '/api/webhook-test', { webhookUrl: 12345 });
    assert.equal(status, 200);
    assert.equal(outbound[0].url, 'https://hooks.example/persisted');
  });

  it('sends a typed draft secret, but an empty-string draft secret does not blank the persisted one', async () => {
    setCfg({ webhookUrl: 'https://hooks.example/persisted', webhookSecret: 'persisted-secret' });
    await call('POST', '/api/webhook-test', { webhookSecret: '' });
    assert.equal(outbound[0].init.headers.authorization, 'Bearer persisted-secret');
    assert.equal(outbound[0].init.headers['x-webhook-secret'], 'persisted-secret');

    outbound = [];
    await call('POST', '/api/webhook-test', { webhookSecret: 'draft-secret' });
    assert.equal(outbound[0].init.headers.authorization, 'Bearer draft-secret');
  });

  it('answers 500 {error: <message>} when reading the config throws', async () => {
    setCfg({});
    Object.defineProperty(cfg, 'webhookUrl', {
      configurable: true,
      enumerable: true,
      get() { throw new Error('webhook-boom'); },
    });
    try {
      const { status, body } = await call('POST', '/api/webhook-test', {});
      assert.equal(status, 500);
      assert.deepEqual(body, { error: 'webhook-boom' });
      assert.equal(outbound.length, 0);
    } finally {
      delete cfg.webhookUrl;
    }
  });
});

describe('createConfigRouter — POST /api/telemetry-test', () => {
  it('answers 400 "endpoint is required" with no outbound probe for a whitespace-only endpoint', async () => {
    setCfg({});
    const { status, body } = await call('POST', '/api/telemetry-test', { endpoint: '   ' });
    assert.equal(status, 400);
    assert.deepEqual(body, { error: 'endpoint is required' });
    assert.equal(outbound.length, 0);
  });

  it('answers 400 with no outbound probe for a non-string endpoint', async () => {
    setCfg({});
    const { status, body } = await call('POST', '/api/telemetry-test', { endpoint: 42 });
    assert.equal(status, 400);
    assert.deepEqual(body, { error: 'endpoint is required' });
    assert.equal(outbound.length, 0);
  });

  it('answers 400 with no outbound probe when the body is absent', async () => {
    setCfg({});
    const { status, body } = await call('POST', '/api/telemetry-test', {});
    assert.equal(status, 400);
    assert.deepEqual(body, { error: 'endpoint is required' });
    assert.equal(outbound.length, 0);
  });

  it('trims a padded endpoint before probing its /capabilities URL', async () => {
    setCfg({});
    const { status } = await call('POST', '/api/telemetry-test', { endpoint: '  https://receiver.example/ingest \n' });
    assert.equal(status, 200);
    assert.equal(outbound.length, 1);
    assert.equal(outbound[0].url, 'https://receiver.example/capabilities');
  });

  it('sends the body token as the bearer, taking precedence over the persisted token', async () => {
    setCfg({ telemetryAuthToken: 'persisted-tok' });
    await call('POST', '/api/telemetry-test', { endpoint: 'https://receiver.example/ingest', token: 'draft-tok' });
    assert.equal(outbound[0].init.headers.authorization, 'Bearer draft-tok');
  });

  it('falls back to the persisted token for a blank body token', async () => {
    setCfg({ telemetryAuthToken: 'persisted-tok' });
    await call('POST', '/api/telemetry-test', { endpoint: 'https://receiver.example/ingest', token: '   ' });
    assert.equal(outbound[0].init.headers.authorization, 'Bearer persisted-tok');
  });

  it('sends no authorization when neither a body nor a persisted token exists', async () => {
    setCfg({});
    await call('POST', '/api/telemetry-test', { endpoint: 'https://receiver.example/ingest' });
    assert.equal(outbound[0].init.headers.authorization, undefined);
  });

  it('returns the probe verdict as the response body (string kind, boolean ok)', async () => {
    setCfg({});
    const { status, body } = await call('POST', '/api/telemetry-test', { endpoint: 'https://receiver.example/ingest' });
    assert.equal(status, 200);
    assert.equal(typeof body.kind, 'string');
    assert.equal(typeof body.ok, 'boolean');
    assert.equal(body.kind, 'connected');
    assert.equal(body.ok, true);
  });

  it('passes a non-connected verdict through unchanged (schema drift is not coerced to connected)', async () => {
    setCfg({});
    nextSchemaVersion = CLIENT_SCHEMA_VERSION + 1;
    const { status, body } = await call('POST', '/api/telemetry-test', { endpoint: 'https://receiver.example/ingest' });
    assert.equal(status, 200);
    assert.equal(body.kind, 'schema-drift');
    assert.equal(body.ok, false);
  });

  it('answers 500 {error: <message>} when reading the persisted token throws', async () => {
    setCfg({});
    Object.defineProperty(cfg, 'telemetryAuthToken', {
      configurable: true,
      enumerable: true,
      get() { throw new Error('telemetry-boom'); },
    });
    try {
      const { status, body } = await call('POST', '/api/telemetry-test', { endpoint: 'https://receiver.example/ingest' });
      assert.equal(status, 500);
      assert.deepEqual(body, { error: 'telemetry-boom' });
      assert.equal(outbound.length, 0);
    } finally {
      delete cfg.telemetryAuthToken;
    }
  });
});

describe('createConfigRouter — GET /api/config', () => {
  it('threads the injected companionEnvOverridden flag into companionTransportOverridden', async () => {
    setCfg({});
    const { status, body } = await call('GET', '/api/config');
    assert.equal(status, 200);
    assert.equal(body.companionTransportOverridden, true);
  });
});

describe('createConfigRouter — PUT /api/config', () => {
  it('answers {ok:true, refused:{}} for a clean body', async () => {
    setCfg({});
    const { status, body } = await call('PUT', '/api/config', {});
    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true, refused: {} });
  });

  it('runs afterSave only after the async save has completed', async () => {
    setCfg({});
    await call('PUT', '/api/config', {});
    assert.equal(saveCount, 1);
    assert.ok(afterSaveCalls.length > 0, 'afterSave side-effects fired');
    const saveDone = events.indexOf('save:done');
    assert.ok(saveDone >= 0, 'save completed');
    const firstAfterSave = events.findIndex((e) => e !== 'save:start' && e !== 'save:done');
    assert.ok(firstAfterSave > saveDone, `afterSave ran after save:done (events: ${events.join(',')})`);
  });
});

describe('createConfigRouter — POST /api/config/reset', () => {
  it('answers exactly {ok:true}, saves once, and fires afterSave after the save completed', async () => {
    setCfg({ webhookUrl: 'https://hooks.example/persisted', webhookSecret: 'sekrit' });
    const { status, body } = await call('POST', '/api/config/reset');
    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true });
    assert.equal(saveCount, 1);
    assert.ok(afterSaveCalls.length > 0, 'afterSave side-effects fired');
    const saveDone = events.indexOf('save:done');
    const firstAfterSave = events.findIndex((e) => e !== 'save:start' && e !== 'save:done');
    assert.ok(saveDone >= 0 && firstAfterSave > saveDone, `afterSave ran after save:done (events: ${events.join(',')})`);
    assert.equal(cfg.webhookSecret, '', 'reset blanked the persisted secret');
  });
});
