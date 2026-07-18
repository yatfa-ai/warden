// Tests for the config-time receiver verification backend (WARDEN-595).
// mapCapabilitiesVerdict + capabilitiesUrlFromEndpoint are PURE — exercised here
// with no network, no fetch mock. Plus a DRIFT assertion that the inlined
// CLIENT_SCHEMA_VERSION equals the canonical web/src/lib/telemetry/schema.ts value,
// so the backend copy cannot fall out of sync silently (the discipline the
// warden-telemetry repo's drift.test.mjs applies to the vendored copy).
//
// Run: node --test src/telemetry-capabilities.test.js   (auto-discovered by `npm test`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  CLIENT_SCHEMA_VERSION,
  CAPABILITIES_PATH,
  capabilitiesUrlFromEndpoint,
  mapCapabilitiesVerdict,
  probeReceiverCapabilities,
} from './telemetry-capabilities.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CANONICAL_SCHEMA_PATH = resolve(__dirname, '../web/src/lib/telemetry/schema.ts');

// ── DRIFT: the backend's inlined version tracks the canonical schema.ts ─────────
// src/ cannot import web/'s schema.ts at runtime (Node 22, no strip-types flag),
// so the version is inlined here. This reads the canonical file and asserts the
// two match, so a schema bump in schema.ts can't ship with a stale backend probe.
test('CLIENT_SCHEMA_VERSION matches the canonical web/src/lib/telemetry/schema.ts SCHEMA_VERSION (no silent drift)', () => {
  const src = readFileSync(CANONICAL_SCHEMA_PATH, 'utf8');
  const m = src.match(/export\s+const\s+SCHEMA_VERSION\s*=\s*(\d+)\s*;/);
  assert.ok(m, 'canonical schema.ts defines `export const SCHEMA_VERSION = <n>;`');
  assert.equal(
    CLIENT_SCHEMA_VERSION,
    Number(m[1]),
    'the backend inlined version must equal the canonical client schema version'
  );
});

test('CAPABILITIES_PATH is the receiver capabilities route (mirrors warden-telemetry)', () => {
  assert.equal(CAPABILITIES_PATH, '/capabilities');
});

// ── capabilitiesUrlFromEndpoint — origin derivation (mirrors destination.ts) ─────

test('capabilitiesUrlFromEndpoint derives origin + /capabilities from a full /ingest URL (path dropped)', () => {
  assert.equal(
    capabilitiesUrlFromEndpoint('https://receiver.example/ingest'),
    'https://receiver.example/capabilities'
  );
});

test('capabilitiesUrlFromEndpoint preserves the host + port (http://host:7421/ingest)', () => {
  assert.equal(
    capabilitiesUrlFromEndpoint('http://localhost:7421/ingest'),
    'http://localhost:7421/capabilities'
  );
});

test('capabilitiesUrlFromEndpoint accepts a bare host (lenient https:// retry for a scheme-less input)', () => {
  assert.equal(
    capabilitiesUrlFromEndpoint('receiver.example'),
    'https://receiver.example/capabilities'
  );
});

test('capabilitiesUrlFromEndpoint accepts an origin with no path', () => {
  assert.equal(
    capabilitiesUrlFromEndpoint('https://receiver.example'),
    'https://receiver.example/capabilities'
  );
});

test('capabilitiesUrlFromEndpoint drops a query string (the /capabilities probe carries none)', () => {
  assert.equal(
    capabilitiesUrlFromEndpoint('https://receiver.example/ingest?foo=bar'),
    'https://receiver.example/capabilities'
  );
});

test('capabilitiesUrlFromEndpoint trims whitespace before parsing', () => {
  assert.equal(
    capabilitiesUrlFromEndpoint('  https://receiver.example/ingest  '),
    'https://receiver.example/capabilities'
  );
});

test('capabilitiesUrlFromEndpoint returns null for empty/blank (no guess — caller reports no-receiver)', () => {
  assert.equal(capabilitiesUrlFromEndpoint(''), null);
  assert.equal(capabilitiesUrlFromEndpoint('   '), null);
  assert.equal(capabilitiesUrlFromEndpoint(null), null);
  assert.equal(capabilitiesUrlFromEndpoint(undefined), null);
});

// ── mapCapabilitiesVerdict — the four states ────────────────────────────────────

test('connected: 200 + matching schemaVersion + authRequired:false → ok, open-receiver copy', () => {
  const v = mapCapabilitiesVerdict({ status: 200, body: { schemaVersion: CLIENT_SCHEMA_VERSION, authRequired: false } });
  assert.equal(v.kind, 'connected');
  assert.equal(v.ok, true);
  assert.match(v.message, /reachable and schema-matched/);
});

test('connected: 200 + matching schemaVersion + authRequired:true → ok, token-accepted copy', () => {
  const v = mapCapabilitiesVerdict({ status: 200, body: { schemaVersion: CLIENT_SCHEMA_VERSION, authRequired: true } });
  assert.equal(v.kind, 'connected');
  assert.equal(v.ok, true);
  assert.match(v.message, /token was accepted/);
});

test('connected tracks the client schema version (a future bump is reflected, no parallel literal)', () => {
  const v = mapCapabilitiesVerdict({
    status: 200,
    body: { schemaVersion: 999, authRequired: false },
    clientSchemaVersion: 999,
  });
  assert.equal(v.kind, 'connected');
  assert.equal(v.ok, true);
});

test('schema-drift: 200 + a different schemaVersion → not ok, names BOTH versions', () => {
  // A version the client does NOT speak (one ahead of the current contract).
  const remote = CLIENT_SCHEMA_VERSION + 1;
  const v = mapCapabilitiesVerdict({ status: 200, body: { schemaVersion: remote, authRequired: false } });
  assert.equal(v.kind, 'schema-drift');
  assert.equal(v.ok, false);
  assert.match(v.message, new RegExp(`v${CLIENT_SCHEMA_VERSION}`)); // the client's version
  assert.match(v.message, new RegExp(`v${remote}`)); // the receiver's version
  assert.match(v.message, /415/); // the consequence (rejected at /ingest)
});

test('schema-drift message names the configured client version vs a much older receiver', () => {
  const v = mapCapabilitiesVerdict({
    status: 200,
    body: { schemaVersion: 1, authRequired: false },
    clientSchemaVersion: 3,
  });
  assert.equal(v.kind, 'schema-drift');
  assert.match(v.message, /v3.*v1|v1.*v3/); // both versions appear
});

test('auth-required: 401 with NO token sent → "a token is required" copy', () => {
  const v = mapCapabilitiesVerdict({ status: 401, tokenSent: false });
  assert.equal(v.kind, 'auth-required');
  assert.equal(v.ok, false);
  assert.match(v.message, /requires an auth token/i);
});

test('auth-required: 401 WITH a token sent → "token was rejected" copy', () => {
  const v = mapCapabilitiesVerdict({ status: 401, tokenSent: true });
  assert.equal(v.kind, 'auth-required');
  assert.equal(v.ok, false);
  assert.match(v.message, /rejected/i);
});

test('no-receiver: a fetch error (host unreachable) → not ok, no-receiver copy', () => {
  const v = mapCapabilitiesVerdict({ fetchError: true });
  assert.equal(v.kind, 'no-receiver');
  assert.equal(v.ok, false);
});

test('no-receiver: status == null (no response produced) → no-receiver', () => {
  const v = mapCapabilitiesVerdict({ status: null });
  assert.equal(v.kind, 'no-receiver');
  assert.equal(v.ok, false);
});

test('no-receiver: 200 but the body is not a capabilities payload (not a warden-telemetry receiver)', () => {
  const v = mapCapabilitiesVerdict({ status: 200, body: { hello: 'world' } });
  assert.equal(v.kind, 'no-receiver');
  assert.equal(v.ok, false);
});

test('no-receiver: 200 with a non-object body (e.g. an HTML landing page)', () => {
  const v = mapCapabilitiesVerdict({ status: 200, body: '<!doctype html>' });
  assert.equal(v.kind, 'no-receiver');
  assert.equal(v.ok, false);
});

test('no-receiver: a non-200, non-401 status (404/500/…) → no-receiver, names the status', () => {
  const v = mapCapabilitiesVerdict({ status: 404 });
  assert.equal(v.kind, 'no-receiver');
  assert.equal(v.ok, false);
  assert.match(v.message, /404/);
});

test('a 200 body whose schemaVersion is an object/string is treated as not-a-receiver (not drift)', () => {
  // A malformed schemaVersion must not produce a misleading "drift" message.
  const v = mapCapabilitiesVerdict({ status: 200, body: { schemaVersion: { weird: true } } });
  assert.equal(v.kind, 'no-receiver');
  assert.equal(v.ok, false);
});

test('every verdict has the { kind, ok, message } shape the UI renders', () => {
  const cases = [
    { status: 200, body: { schemaVersion: 1, authRequired: false } },
    { status: 200, body: { schemaVersion: 2 } },
    { status: 401 },
    { status: 404 },
    { fetchError: true },
  ];
  for (const c of cases) {
    const v = mapCapabilitiesVerdict(c);
    assert.ok(typeof v.kind === 'string' && v.kind.length > 0, 'kind is a non-empty string');
    assert.equal(typeof v.ok, 'boolean');
    assert.equal(typeof v.message, 'string');
    assert.ok(v.message.length > 0, 'message is non-empty');
  }
});

// ── probeReceiverCapabilities — the route's probe composition (injectable fetch) ─
// The route handler in server.js delegates here. fetchImpl is INJECTED so the
// composition (URL derivation + auth header + verdict mapping) is exercised with a
// capturing stub — ZERO real network, mirroring telemetry-send.js's fetchImpl.
// A fake fetch records the URL + headers it was called with and returns a scripted
// Response-shaped object ({ status, ok, json() }).
function fakeFetch({ status = 200, json = {}, ok = status >= 200 && status < 300, throwErr } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (throwErr) throw throwErr;
    return { status, ok, json: async () => json };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('probe: 200 + matching schema → connected, probes origin + /capabilities from the /ingest endpoint', async () => {
  const fetchImpl = fakeFetch({ status: 200, json: { schemaVersion: CLIENT_SCHEMA_VERSION, authRequired: false } });
  const v = await probeReceiverCapabilities({
    endpoint: 'https://receiver.example/ingest',
    fetchImpl,
  });
  assert.equal(v.kind, 'connected');
  assert.equal(v.ok, true);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, 'https://receiver.example/capabilities', 'path is /capabilities, derived from origin');
  assert.equal(fetchImpl.calls[0].init.method, 'GET');
});

test('probe: a draft token is sent as Authorization: Bearer', async () => {
  const fetchImpl = fakeFetch({ status: 200, json: { schemaVersion: CLIENT_SCHEMA_VERSION, authRequired: true } });
  await probeReceiverCapabilities({ endpoint: 'https://r.example/ingest', token: 'draft-tok', fetchImpl });
  assert.equal(fetchImpl.calls[0].init.headers.authorization, 'Bearer draft-tok');
});

test('probe: with no draft token, the fallback (persisted) token is sent as Bearer', async () => {
  const fetchImpl = fakeFetch({ status: 200, json: { schemaVersion: CLIENT_SCHEMA_VERSION, authRequired: true } });
  await probeReceiverCapabilities({ endpoint: 'https://r.example/ingest', fallbackToken: 'saved-tok', fetchImpl });
  assert.equal(fetchImpl.calls[0].init.headers.authorization, 'Bearer saved-tok');
});

test('probe: a draft token takes precedence over the fallback token', async () => {
  const fetchImpl = fakeFetch({ status: 200, json: { schemaVersion: CLIENT_SCHEMA_VERSION, authRequired: true } });
  await probeReceiverCapabilities({
    endpoint: 'https://r.example/ingest',
    token: 'draft-tok',
    fallbackToken: 'saved-tok',
    fetchImpl,
  });
  assert.equal(fetchImpl.calls[0].init.headers.authorization, 'Bearer draft-tok');
});

test('probe: with no draft AND no fallback, NO Authorization header is sent (open receiver)', async () => {
  const fetchImpl = fakeFetch({ status: 200, json: { schemaVersion: CLIENT_SCHEMA_VERSION, authRequired: false } });
  await probeReceiverCapabilities({ endpoint: 'https://r.example/ingest', fetchImpl });
  assert.ok(!('authorization' in fetchImpl.calls[0].init.headers), 'no auth header for a token-less probe');
});

test('probe: a 401 with a token sent → auth-required, rejected copy', async () => {
  const fetchImpl = fakeFetch({ status: 401, ok: false, json: { error: 'unauthorized' } });
  const v = await probeReceiverCapabilities({ endpoint: 'https://r.example/ingest', token: 'tok', fetchImpl });
  assert.equal(v.kind, 'auth-required');
  assert.match(v.message, /rejected/i);
});

test('probe: a 401 with no token → auth-required, "a token is required" copy (tokenSent derives from fallback too)', async () => {
  const fetchImpl = fakeFetch({ status: 401, ok: false, json: { error: 'unauthorized' } });
  const v = await probeReceiverCapabilities({ endpoint: 'https://r.example/ingest', fetchImpl });
  assert.equal(v.kind, 'auth-required');
  assert.match(v.message, /requires an auth token/i);
});

test('probe: a 200 with a mismatched schemaVersion → schema-drift', async () => {
  const fetchImpl = fakeFetch({ status: 200, json: { schemaVersion: CLIENT_SCHEMA_VERSION + 1, authRequired: false } });
  const v = await probeReceiverCapabilities({ endpoint: 'https://r.example/ingest', fetchImpl });
  assert.equal(v.kind, 'schema-drift');
});

test('probe: a fetch throw (network error) → no-receiver (never throws to the caller)', async () => {
  const fetchImpl = fakeFetch({ throwErr: new Error('ECONNREFUSED') });
  const v = await probeReceiverCapabilities({ endpoint: 'https://r.example/ingest', fetchImpl });
  assert.equal(v.kind, 'no-receiver');
  assert.equal(v.ok, false);
});

test('probe: a 200 with a non-JSON body → no-receiver (not a warden-telemetry receiver)', async () => {
  // A fake fetch whose json() throws (HTML body / empty body).
  const fetchImpl = async () => ({ status: 200, ok: true, json: async () => { throw new Error('not JSON'); } });
  const v = await probeReceiverCapabilities({ endpoint: 'https://r.example/ingest', fetchImpl });
  assert.equal(v.kind, 'no-receiver');
});

test('probe: an unparseable endpoint → no-receiver, fetchImpl is NEVER called (no guess)', async () => {
  let called = 0;
  const fetchImpl = async () => { called += 1; };
  const v = await probeReceiverCapabilities({ endpoint: '   ', fetchImpl });
  assert.equal(v.kind, 'no-receiver');
  assert.equal(called, 0, 'no fetch attempted for an unparseable origin');
});

