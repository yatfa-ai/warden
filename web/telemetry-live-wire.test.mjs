// Constructed live-wire integration tests (WARDEN-524). These prove the capstone
// wiring in electron/main.cjs actually moves a real base-tier signal to the wire:
// a source-built event flows source → record() → pipeline (resolveTier → redact →
// validate) → the REAL transport, which POSTs it via the injected fetchImpl seam.
//
// The construction mirrors main.cjs EXACTLY: the source's record sink is bound to
// a pipeline built with the CJS redact mirror + validateBaseEvent + SCHEMA_VERSION
// + the REAL src/telemetry-send.js transport, a consent resolver fed by the same
// prefs holder, and the endpoint pushed via setEndpoint. Only fetchImpl / sleepImpl
// are faked (the transport's injectable seam) so the assertions are wire-level —
// no real network, no standing up a receiver. This is the test shape the ticket's
// testing notes prescribe.
//
// Success criteria covered:
//   #1 — sends when opted in (base on + endpoint set): one POST, x-telemetry-schema=1.
//   #2 — no-ops when off OR unconfigured: zero fetchImpl calls.
//   #3 — runtime toggle starts/stops capture immediately (no restart).
//
// Auto-discovered by `npm test` in web/ (`node --test`).
//
// Run: node telemetry-live-wire.test.mjs   (from web/)
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// --- Load the REAL transport (ESM — dynamic import) --------------------------
const { send: realSend } = await import(resolve(__dirname, '..', 'src', 'telemetry-send.js'));

// --- Load the CJS modules main.cjs wires together ----------------------------
const { createTelemetrySource, SCHEMA_VERSION, validateBaseEvent } = require('../electron/telemetry-source.cjs');
const { createTelemetryPipeline } = require('../electron/telemetry-pipeline.cjs');
const { redact: redactCjs } = require('../electron/telemetry-redact.cjs');
const { resolveTelemetryTier } = require('../electron/telemetry-config.cjs');
const { createTransmissionLog } = require('../electron/telemetry-transmission-log.cjs');

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed += 1;
  console.log('  ok -', name);
};
const tick = () => new Promise((r) => setTimeout(r, 10));

const TS = 1719500000123;
const ENDPOINT = 'https://telemetry.example.selfhosted.net/v1/events';
const GH_TOKEN = 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789';

// --- fakes -------------------------------------------------------------------

// A minimal process-like emitter: the source attaches .on('uncaughtExceptionMonitor')
// and .on('unhandledRejection'); emit() drives the recorded handler synchronously.
function fakeEmitter() {
  const handlers = Object.create(null);
  return {
    on(evt, fn) { handlers[evt] = fn; },
    off(evt) { delete handlers[evt]; },
    emit(evt, ...args) { if (handlers[evt]) handlers[evt](...args); },
  };
}

// fetch recorder — every call captured as { url, opts }; returns a 2xx so the
// transport treats the batch as delivered.
function fetchRecorder() {
  const calls = [];
  const fn = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200 }; };
  fn.calls = calls;
  return fn;
}
// fetch that FAILS the test if called — for the no-op gates (zero calls expected).
function fetchMustNotBeCalled() {
  let count = 0;
  const fn = async () => { count += 1; throw new Error('fetchImpl must NOT be called from a gated no-op'); };
  fn.count = () => count;
  fn.calls = [];
  return fn;
}
// fetch mock serving a fixed response sequence (one per call) — reuses the last if
// over-served. { ok, status } for a response or { throw: err } for a network blip.
// Used for the dropped-outcome cases (persistent 5xx / network error) the real
// transport translates into a dropped batch.
function fetchSeq(responses) {
  let i = 0;
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    if (r.throw) throw r.throw;
    return { ok: r.ok, status: r.status };
  };
  fn.calls = calls;
  return fn;
}

// Build the EXACT wiring shape main.cjs constructs. Returns a handle exposing the
// source's main emitter + an apply() that mirrors main.cjs's applyTelemetryConfig
// (update the prefs holder, arm/disarm the source, push the endpoint to the
// pipeline — the transport's last gate). The handle also exposes `log` — the
// transmission log main.cjs injects (WARDEN-583) — so the actual-outcome criteria
// assert on what the REAL transport produced.
function buildWire({ fetchImpl, transmissionLog, logCap, onRuntimeStatus } = {}) {
  const prefs = { telemetryBaseEnabled: false, telemetryExtendedEnabled: false, telemetryEndpoint: '' };
  const log = transmissionLog || createTransmissionLog({ clock: () => TS, cap: logCap });
  const pipeline = createTelemetryPipeline({
    consent: () => resolveTelemetryTier(prefs),
    redact: redactCjs,
    validate: validateBaseEvent,
    schemaVersion: SCHEMA_VERSION,
    send: realSend,
    fetchImpl,
    sleepImpl: () => Promise.resolve(),
    transmissionLog: log,
    onRuntimeStatus,
  });
  const source = createTelemetrySource({
    record: pipeline.record,
    now: () => TS,
    setInterval: () => null, // no real heartbeat timer in tests
    clearInterval: () => {},
  });
  const main = fakeEmitter();
  source.attachMain(main);
  const apply = (next) => {
    if (next && typeof next === 'object') {
      if (typeof next.telemetryBaseEnabled === 'boolean') prefs.telemetryBaseEnabled = next.telemetryBaseEnabled;
      if (typeof next.telemetryExtendedEnabled === 'boolean') prefs.telemetryExtendedEnabled = next.telemetryExtendedEnabled;
      if (typeof next.telemetryEndpoint === 'string') prefs.telemetryEndpoint = next.telemetryEndpoint;
    }
    source.setBaseConsent(prefs.telemetryBaseEnabled === true);
    pipeline.setEndpoint(prefs.telemetryEndpoint || '');
  };
  return { prefs, pipeline, source, main, apply, log };
}

// ==========================================================================
// Criterion #1 — sends when opted in (base on + endpoint set)
// ==========================================================================

await test('a real source error signal POSTs once with x-telemetry-schema=1 + a redacted JSON body', async () => {
  const fetch = fetchRecorder();
  const w = buildWire({ fetchImpl: fetch });
  w.apply({ telemetryBaseEnabled: true, telemetryExtendedEnabled: false, telemetryEndpoint: ENDPOINT });

  // Drive the source the way the live main process would: an uncaught error.
  w.main.emit('uncaughtExceptionMonitor', new Error(`auth token ${GH_TOKEN} leaked on /home/alice/secret`));
  await tick();

  assert.equal(fetch.calls.length, 1, 'exactly one POST for one source signal');
  const { url, opts } = fetch.calls[0];
  assert.equal(url, ENDPOINT, 'destination is exactly the configured endpoint');
  assert.equal(opts.method, 'POST');
  assert.equal(opts.headers['content-type'], 'application/json');
  assert.equal(opts.headers['x-telemetry-schema'], String(SCHEMA_VERSION), 'schema-version handshake header present and = SCHEMA_VERSION');
  const body = JSON.parse(opts.body);
  assert.equal(body.schemaVersion, SCHEMA_VERSION, 'schema version echoed in the body');
  assert.ok(Array.isArray(body.events) && body.events.length === 1);
  assert.equal(body.events[0].type, 'error');
  assert.equal(body.events[0].runtime, 'main');
  assert.equal(body.events[0].timestamp, TS, 'the source-supplied timestamp survives');
  // The credential planted in the raw error is [REDACTED:…] at the wire; neither
  // the token nor the file path survives anywhere in the POSTed body.
  assert.ok(body.events[0].message.includes('[REDACTED:github-token]'), 'credential redacted at the transport boundary');
  assert.doesNotMatch(JSON.stringify(body), /ghp_/, 'raw token never reaches the wire');
  assert.doesNotMatch(JSON.stringify(body), /\/home\/alice/, 'file path never reaches the wire');
});

await test('an unhandledRejection signal flows the same path (source → pipeline → transport)', async () => {
  const fetch = fetchRecorder();
  const w = buildWire({ fetchImpl: fetch });
  w.apply({ telemetryBaseEnabled: true, telemetryEndpoint: ENDPOINT });
  w.main.emit('unhandledRejection', new Error('rejected boom'));
  await tick();
  assert.equal(fetch.calls.length, 1);
  assert.equal(JSON.parse(fetch.calls[0].opts.body).events[0].type, 'error');
});

// ==========================================================================
// Criterion #2 — no-ops when off OR unconfigured (zero fetchImpl calls)
// ==========================================================================

await test('consent OFF ⇒ ZERO fetchImpl calls (source not armed; nothing emitted)', async () => {
  const fetch = fetchMustNotBeCalled();
  const w = buildWire({ fetchImpl: fetch });
  w.apply({ telemetryBaseEnabled: false, telemetryEndpoint: ENDPOINT }); // consent off
  w.main.emit('uncaughtExceptionMonitor', new Error(`token ${GH_TOKEN}`));
  await tick();
  assert.equal(fetch.count(), 0, 'the source subscribes to nothing with consent off');
});

await test('endpoint empty ⇒ ZERO fetchImpl calls (transport last gate, now actually reached)', async () => {
  const fetch = fetchMustNotBeCalled();
  const w = buildWire({ fetchImpl: fetch });
  // Base consent ON but no endpoint configured — the source IS armed and the
  // pipeline DOES process the event, but the transport's own final gate
  // (consent + endpoint) returns { attempts: 0 } without opening a connection.
  w.apply({ telemetryBaseEnabled: true, telemetryEndpoint: '' });
  w.main.emit('uncaughtExceptionMonitor', new Error('boom'));
  await tick();
  assert.equal(fetch.count(), 0, 'no-endpoint ⇒ transport no-ops (fetchImpl never called)');
});

await test('off-by-default: with no apply() at all, a signal sends nothing', async () => {
  const fetch = fetchMustNotBeCalled();
  const w = buildWire({ fetchImpl: fetch }); // prefs all-off / empty — the boot default
  w.main.emit('uncaughtExceptionMonitor', new Error('boom'));
  await tick();
  assert.equal(fetch.count(), 0);
});

// ==========================================================================
// Criterion #3 — runtime toggle starts/stops capture IMMEDIATELY (no restart)
// ==========================================================================

await test('flipping consent on at runtime starts capture on the next signal', async () => {
  const fetch = fetchRecorder();
  const w = buildWire({ fetchImpl: fetch });
  // Boot default: off + no endpoint. A signal sends nothing.
  w.apply({ telemetryBaseEnabled: false, telemetryExtendedEnabled: false, telemetryEndpoint: '' });
  w.main.emit('uncaughtExceptionMonitor', new Error('first'));
  await tick();
  assert.equal(fetch.calls.length, 0, 'no send while consent is off');

  // A live Settings flip (PUT /api/config forwarded over the fork's IPC channel)
  // turns base on + sets the endpoint — capture begins on the NEXT signal.
  w.apply({ telemetryBaseEnabled: true, telemetryEndpoint: ENDPOINT });
  w.main.emit('uncaughtExceptionMonitor', new Error('second'));
  await tick();
  assert.equal(fetch.calls.length, 1, 'capture starts immediately after the toggle');
  assert.equal(JSON.parse(fetch.calls[0].opts.body).events[0].type, 'error');
});

await test('revoking consent at runtime stops capture on the next signal', async () => {
  const fetch = fetchRecorder();
  const w = buildWire({ fetchImpl: fetch });
  w.apply({ telemetryBaseEnabled: true, telemetryEndpoint: ENDPOINT });
  w.main.emit('uncaughtExceptionMonitor', new Error('on'));
  await tick();
  assert.equal(fetch.calls.length, 1);

  // Flip base OFF — the source detaches its subscriptions; the next signal no-ops.
  w.apply({ telemetryBaseEnabled: false });
  w.main.emit('uncaughtExceptionMonitor', new Error('off'));
  await tick();
  assert.equal(fetch.calls.length, 1, 'capture stops immediately when consent is revoked');
});

await test('clearing the endpoint at runtime stops sends (consent still on)', async () => {
  const fetch = fetchRecorder();
  const w = buildWire({ fetchImpl: fetch });
  w.apply({ telemetryBaseEnabled: true, telemetryEndpoint: ENDPOINT });
  w.main.emit('uncaughtExceptionMonitor', new Error('one'));
  await tick();
  assert.equal(fetch.calls.length, 1);
  // Endpoint cleared to '' — the transport gate closes again (consent on, but no
  // destination), so the next signal sends nothing even though consent stayed on.
  w.apply({ telemetryEndpoint: '' });
  w.main.emit('uncaughtExceptionMonitor', new Error('two'));
  await tick();
  assert.equal(fetch.calls.length, 1, 'clearing the endpoint halts sends immediately');
});

// ==========================================================================
// Robustness — the live path never throws the host into a worse state
// ==========================================================================

await test('a source signal with consent on never rejects out of the pipeline', async () => {
  const fetch = fetchRecorder();
  const w = buildWire({ fetchImpl: fetch });
  w.apply({ telemetryBaseEnabled: true, telemetryEndpoint: ENDPOINT });
  // The pipeline swallows transport rejections; this just confirms the path
  // resolves cleanly (no unhandled rejection) on the happy path.
  assert.doesNotThrow(() => w.main.emit('uncaughtExceptionMonitor', new Error('ok')));
  await tick();
  assert.equal(fetch.calls.length, 1);
});

// ==========================================================================
// Transmission log — ACTUAL send outcomes (WARDEN-583, verifiability's third leg)
// ==========================================================================
// With the REAL transport wired (the exact main.cjs shape), prove the measurable
// success criteria:
//   (a) 2xx       → outcome:ok entry
//   (b) unreachable → outcome:dropped entry (a lost batch is now VISIBLE)
//   (c) disable    → no further entries (cessation IS the proof)
//   (d) entries are metadata-only (no payload / token / path)
//   (e) the live log is bounded

await test('(a) a successful 2xx send records an outcome:ok entry (attempts:1, status:200)', async () => {
  const fetch = fetchRecorder();
  const w = buildWire({ fetchImpl: fetch });
  w.apply({ telemetryBaseEnabled: true, telemetryEndpoint: ENDPOINT });
  w.main.emit('uncaughtExceptionMonitor', new Error(`token ${GH_TOKEN} leaked`));
  await tick();
  assert.equal(w.log.size(), 1, 'one ok entry for one successful send');
  const e = w.log.entries()[0];
  assert.equal(e.outcome, 'ok');
  assert.equal(e.attempts, 1);
  assert.equal(e.status, 200);
  assert.equal(e.endpointHost, 'telemetry.example.selfhosted.net', 'host only — no path/query');
  assert.equal(e.schemaVersion, SCHEMA_VERSION);
  assert.equal(e.eventCount, 1);
});

await test('(b) an unreachable receiver (persistent 503) records an outcome:dropped entry', async () => {
  const fetch = fetchSeq([{ ok: false, status: 503 }]); // always 503 → exhausts MAX_ATTEMPTS
  const w = buildWire({ fetchImpl: fetch });
  w.apply({ telemetryBaseEnabled: true, telemetryEndpoint: ENDPOINT });
  w.main.emit('uncaughtExceptionMonitor', new Error('boom'));
  await tick();
  assert.equal(w.log.size(), 1, 'the lost batch is recorded — today it would vanish silently');
  const e = w.log.entries()[0];
  assert.equal(e.outcome, 'dropped');
  assert.equal(e.attempts, 3, 'bounded — exhausted the retry cap');
  assert.equal(e.status, 503);
});

await test('(b) a network error (fetch throws) records a dropped entry with status null', async () => {
  const fetch = fetchSeq([{ throw: new Error('fetch failed: ECONNREFUSED') }]);
  const w = buildWire({ fetchImpl: fetch });
  w.apply({ telemetryBaseEnabled: true, telemetryEndpoint: ENDPOINT });
  w.main.emit('uncaughtExceptionMonitor', new Error('boom'));
  await tick();
  assert.equal(w.log.size(), 1);
  const e = w.log.entries()[0];
  assert.equal(e.outcome, 'dropped');
  assert.equal(e.status, null, 'no response status on a network error');
});

await test('(c) consent OFF records NO entries (disabling halts all traffic)', async () => {
  const fetch = fetchMustNotBeCalled();
  const w = buildWire({ fetchImpl: fetch });
  w.apply({ telemetryBaseEnabled: false, telemetryEndpoint: ENDPOINT }); // consent off
  w.main.emit('uncaughtExceptionMonitor', new Error('boom'));
  await tick();
  assert.equal(w.log.size(), 0, 'no entries while consent is off');
});

await test('(c) revoking consent stops new entries — the cessation IS the proof', async () => {
  const fetch = fetchRecorder();
  const w = buildWire({ fetchImpl: fetch });
  w.apply({ telemetryBaseEnabled: true, telemetryEndpoint: ENDPOINT });
  w.main.emit('uncaughtExceptionMonitor', new Error('on'));
  await tick();
  assert.equal(w.log.size(), 1, 'one ok entry while on');
  w.apply({ telemetryBaseEnabled: false }); // revoke
  w.main.emit('uncaughtExceptionMonitor', new Error('off'));
  await tick();
  assert.equal(w.log.size(), 1, 'no further entry after revoke — entries STOPPED');
});

await test('(d) recorded entries are METADATA ONLY — no payload, token, or file path', async () => {
  const fetch = fetchRecorder();
  const w = buildWire({ fetchImpl: fetch });
  w.apply({ telemetryBaseEnabled: true, telemetryExtendedEnabled: true, telemetryEndpoint: ENDPOINT });
  // The raw error carries a credential AND a file path; both are redacted before
  // transport, and the log re-collects NEITHER (it is a pure metadata consumer).
  w.main.emit('uncaughtExceptionMonitor', new Error(`token ${GH_TOKEN} leaked on /home/alice/secret`));
  await tick();
  const blob = JSON.stringify(w.log.entries());
  assert.doesNotMatch(blob, /ghp_/, 'the raw token never reaches the log');
  assert.doesNotMatch(blob, /\/home\/alice/, 'the file path never reaches the log');
  assert.doesNotMatch(blob, /\[REDACTED/, 'not even redacted payload text is retained');
  const e = w.log.entries()[0];
  assert.deepEqual(
    Object.keys(e).sort(),
    ['attempts', 'endpointHost', 'eventCount', 'outcome', 'schemaVersion', 'status', 'timestamp'],
    'exactly the seven metadata fields',
  );
});

await test('(e) the live log is bounded — many sends never grow it past the cap', async () => {
  const fetch = fetchRecorder();
  const w = buildWire({ fetchImpl: fetch, logCap: 3 });
  w.apply({ telemetryBaseEnabled: true, telemetryEndpoint: ENDPOINT });
  for (let i = 0; i < 6; i++) {
    w.main.emit('uncaughtExceptionMonitor', new Error(`evt ${i}`));
    await tick();
  }
  assert.equal(w.log.size(), 3, 'cap held at 3 across 6 sends (oldest dropped)');
  assert.ok(w.log.entries().every((e) => e.outcome === 'ok'), 'remaining entries are all ok');
});

// ==========================================================================
// WARDEN-631 — runtime schema-drift circuit-breaker (END-TO-END with the REAL transport)
// ==========================================================================
// The receiver returns 415 on an x-telemetry-schema mismatch (ingest.mjs). With the
// real transport wired (the exact main.cjs shape), prove the success criterion from
// the ticket's Observation point: a 415 → drifted → the pipeline's dispatch short-
// circuits so NO further network attempt fires for the rest of the session (verifiable
// via the injected fetchImpl recorder), and the runtime-status bridge tap surfaces it.

await test('a runtime 415 (schema drift) arms the breaker → a SECOND signal makes ZERO further fetch calls', async () => {
  const fetch = fetchSeq([{ ok: false, status: 415 }]); // always 415
  const w = buildWire({ fetchImpl: fetch });
  w.apply({ telemetryBaseEnabled: true, telemetryEndpoint: ENDPOINT });
  w.main.emit('uncaughtExceptionMonitor', new Error('first'));
  await tick();
  assert.equal(fetch.calls.length, 1, 'the first signal POSTed and hit the 415');
  assert.equal(w.pipeline.getRuntimeStatus().drifted, true, 'the 415 armed the runtime drift breaker');

  // A SECOND signal — the receiver already rejected the current schema, so the
  // pipeline short-circuits BEFORE redact/validate/transport. No further fetch.
  w.main.emit('uncaughtExceptionMonitor', new Error('second'));
  w.main.emit('uncaughtExceptionMonitor', new Error('third'));
  await tick();
  assert.equal(fetch.calls.length, 1, 'NO further fetch after the first 415 — futile sends skipped');
  assert.equal(w.pipeline.getRuntimeStatus().drifted, true, 'breaker stays armed for the session');
});

await test('a schema-MATCHED receiver (200) never arms the breaker — legitimate traffic is unaffected', async () => {
  const fetch = fetchRecorder(); // always 200
  const w = buildWire({ fetchImpl: fetch });
  w.apply({ telemetryBaseEnabled: true, telemetryEndpoint: ENDPOINT });
  for (let i = 0; i < 3; i++) {
    w.main.emit('uncaughtExceptionMonitor', new Error(`evt ${i}`));
    await tick();
  }
  assert.equal(fetch.calls.length, 3, 'every signal POSTs — the breaker adds a stop condition, relaxes nothing');
  assert.equal(w.pipeline.getRuntimeStatus().drifted, false, 'a schema-matched receiver never 415s');
});

await test('re-pointing the receiver at runtime clears the breaker → sends resume to the new endpoint', async () => {
  const fetch = fetchSeq([{ ok: false, status: 415 }, { ok: true, status: 200 }]);
  const w = buildWire({ fetchImpl: fetch });
  w.apply({ telemetryBaseEnabled: true, telemetryEndpoint: ENDPOINT });
  w.main.emit('uncaughtExceptionMonitor', new Error('drift'));
  await tick();
  assert.equal(w.pipeline.getRuntimeStatus().drifted, true, 'drifted on the first endpoint');
  // Change to a different receiver that accepts the current schema.
  w.apply({ telemetryEndpoint: 'https://telemetry-fixed.example/ingest' });
  assert.equal(w.pipeline.getRuntimeStatus().drifted, false, 'the endpoint change cleared the breaker');
  w.main.emit('uncaughtExceptionMonitor', new Error('ok'));
  await tick();
  assert.equal(fetch.calls.length, 2, 'the new receiver was attempted after the clear');
  assert.equal(fetch.calls[1].url, 'https://telemetry-fixed.example/ingest', 'aimed at the new endpoint');
});

await test('the runtime-status bridge tap fires on a live 415 arm and on its clear', async () => {
  const statuses = [];
  const fetch = fetchSeq([{ ok: false, status: 415 }, { ok: true, status: 200 }]);
  const w = buildWire({ fetchImpl: fetch, onRuntimeStatus: (s) => statuses.push(s) });
  w.apply({ telemetryBaseEnabled: true, telemetryEndpoint: ENDPOINT });
  w.main.emit('uncaughtExceptionMonitor', new Error('drift'));
  await tick();
  assert.deepEqual(statuses, [{ drifted: true, deliveryFailing: false }], 'the 415 pushed a drift-arm status to the bridge');
  w.apply({ telemetryEndpoint: 'https://telemetry-fixed.example/ingest' });
  assert.deepEqual(statuses, [{ drifted: true, deliveryFailing: false }, { drifted: false, deliveryFailing: false }], 'the endpoint change pushed a clear');
});

console.log(`\n✓ TELEMETRY LIVE-WIRE INTEGRATION TESTS PASS (${passed})`);
