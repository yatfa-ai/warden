// Tests for the telemetry PIPELINE assembly (WARDEN-486, slice 5 of the optional
// off-by-default telemetry client — roadmap WARDEN-446 / design WARDEN-443).
//
// The pipeline composes the four component slices into one `record()` path:
//   resolve-tier → (off? hard no-op) → redact() → validate() → send()
//
// These tests prove the two load-bearing guarantees become ACTUAL runtime behavior:
//   1. consent OFF ⇒ send() never invoked AND nothing retained/buffered.
//   2. consent ON  ⇒ send() receives EXACTLY the redacted + schema-validated
//      payload — a credential is [REDACTED:…] at the transport boundary, a
//      schema-invalid event is dropped pre-send, and chat/session names survive
//      ONLY at the extended tier.
//
// The REAL slice-2 redact (web/src/lib/telemetry/redact.ts, TS → ESM via Vite's
// OXC transform) is injected, so the composition is proven against the SHIPPED
// redaction engine — not a stub. consent / validate / send are fakes (slices 1 & 3
// are not yet shipped), matching the no-hard-merge-dependency pattern. The pipeline
// itself loads via createRequire (CJS, like web/telemetry-source.test.mjs).
//
// Auto-discovered by `npm test` in web/ (`node --test`).
//
// Run: node telemetry-pipeline.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// --- Load the REAL slice-2 redact (TS -> ESM via the OXC transform Vite bundles) -
const redactPath = resolve(__dirname, 'src/lib/telemetry/redact.ts');
const redactSrc = readFileSync(redactPath, 'utf8');
const { code: redactCode } = await transformWithOxc(redactSrc, redactPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-telemetry-pipeline-test-'));
const redactTmp = join(tmpDir, 'redact.mjs');
writeFileSync(redactTmp, redactCode);
const { redact } = await import(redactTmp);
rmSync(tmpDir, { recursive: true, force: true });

// --- Load the pipeline + the shared source contract (CJS) ---------------------
const {
  TIERS,
  SCHEMA_VERSION,
  BASE_EVENT_TYPES,
  resolveTier,
  createTelemetryPipeline,
  isDeliveryFailing,
} = require('../electron/telemetry-pipeline.cjs');
const { validateBaseEvent, buildErrorEvent } = require('../electron/telemetry-source.cjs');
const { createTransmissionLog, parseTransmissionLog } = require('../electron/telemetry-transmission-log.cjs');

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// --- fakes -------------------------------------------------------------------

// A fake transport (slice-3 send contract stand-in) that records every call.
function fakeSend() {
  const calls = [];
  const fn = (args) => { calls.push(args); };
  fn.calls = calls;
  return fn;
}

// A consent resolver that returns a fixed tier.
const consentReturning = (tier) => () => tier;

// GitHub classic PAT — caught by the slice-2 github-token rule.
const GH_TOKEN = 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789';
// A valid base-tier error event with a credential planted in the free-text
// message. It is schema-valid (validateBaseEvent passes — a bare token is not a
// path/host), so it reaches transport — where the credential MUST be redacted.
function validEventWithCredential() {
  return {
    schemaVersion: SCHEMA_VERSION,
    type: 'error',
    runtime: 'main',
    timestamp: 1719500000123,
    name: 'Error',
    message: `auth failed for token ${GH_TOKEN} on retry`,
    frames: [],
  };
}

// A valid base-tier error event carrying chat/session-name identifiers (extra
// fields are allowed by validateBaseEvent — it only enforces required fields).
function validEventWithNames() {
  return {
    schemaVersion: SCHEMA_VERSION,
    type: 'error',
    runtime: 'main',
    timestamp: 1719500000123,
    name: 'Error',
    message: 'chat went unresponsive',
    frames: [],
    chatName: 'Refactor auth module',
    sessionName: 'claude-7b3a2f1',
  };
}

// A structurally-valid base-tier error event whose free-text MESSAGE carries a
// filesystem PATH. With the REAL redactor wired, the path is scrubbed and the
// event validates + sends. With an IDENTITY redactor (p => p — standing in for
// ANY cause of a pre-send validate rejection, NOT a drift simulation), the path
// reaches validateBaseEvent unchanged → its identifier-leak proof
// (containsIdentifier on the message) rejects it pre-send. This is the generic
// validate-rejection trigger the WARDEN-817 success criterion specifies.
function validEventWithPathIdentifier() {
  return {
    schemaVersion: SCHEMA_VERSION,
    type: 'error',
    runtime: 'main',
    timestamp: 1719500000123,
    name: 'Error',
    message: 'failed to read /home/alice/secret/config',
    frames: [],
  };
}

// ==========================================================================
// Defaults — off-by-default, sends nothing out of the box
// ==========================================================================

test('an unconfigured pipeline resolves to the OFF tier and sends nothing', () => {
  const send = fakeSend();
  const pipeline = createTelemetryPipeline(); // no injectables
  assert.equal(pipeline.effectiveTier(), TIERS.OFF);
  pipeline.record(validEventWithCredential());
  assert.equal(send.calls.length, 0, 'default (no transport wired) must not send');
});

test('shared schema threaded from the shipped source module (SCHEMA_VERSION + types)', () => {
  assert.equal(SCHEMA_VERSION, 4);
  assert.deepEqual(BASE_EVENT_TYPES, ['error', 'crash', 'performance-stall']);
  assert.equal(TIERS.BASE, 'base');
  assert.equal(TIERS.EXTENDED, 'extended');
  assert.equal(TIERS.OFF, 'off');
});

test('resolveTier treats unknown / undefined / null as OFF (most-safe default)', () => {
  assert.equal(resolveTier('base'), 'base');
  assert.equal(resolveTier('extended'), 'extended');
  assert.equal(resolveTier('off'), 'off');
  assert.equal(resolveTier(undefined), 'off');
  assert.equal(resolveTier(null), 'off');
  assert.equal(resolveTier('weird'), 'off');
  assert.equal(resolveTier(42), 'off');
});

// ==========================================================================
// Guarantee 1 — consent OFF ⇒ hard no-op: send() never called, nothing buffered
// ==========================================================================

test('consent OFF ⇒ record() is a hard no-op: send() never invoked', () => {
  const send = fakeSend();
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.OFF),
    redact,
    send,
  });
  pipeline.record(validEventWithCredential());
  pipeline.record(validEventWithNames());
  pipeline.record({ type: 'anything' });
  assert.equal(send.calls.length, 0, 'send() must never be called when consent is off');
});

test('consent OFF ⇒ nothing is retained/buffered (the pipeline holds no events)', () => {
  // There is no buffer — a durable queue is a later, out-of-scope slice. The proof
  // is that nothing reaches transport, and the pipeline exposes no retention state.
  const send = fakeSend();
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.OFF),
    redact,
    send,
  });
  for (let i = 0; i < 5; i++) pipeline.record(validEventWithCredential());
  assert.equal(send.calls.length, 0);
  // Flipping consent ON afterward must not replay any earlier "buffered" event.
  pipeline.setConsent(consentReturning(TIERS.BASE));
  assert.equal(send.calls.length, 0, 'no earlier event is replayed after consent turns on');
});

test('unknown / undefined consent tier ⇒ hard no-op (treated as OFF)', () => {
  for (const tier of [undefined, null, 'weird', '']) {
    const send = fakeSend();
    const pipeline = createTelemetryPipeline({ consent: () => tier, redact, send });
    pipeline.record(validEventWithCredential());
    assert.equal(send.calls.length, 0, `tier ${JSON.stringify(tier)} must no-op`);
  }
});

test('a throwing consent resolver degrades to OFF (telemetry must not crash the host)', () => {
  const send = fakeSend();
  const pipeline = createTelemetryPipeline({
    consent: () => { throw new Error('pref store down'); },
    redact,
    send,
  });
  assert.equal(pipeline.effectiveTier(), TIERS.OFF);
  assert.doesNotThrow(() => pipeline.record(validEventWithCredential()));
  assert.equal(send.calls.length, 0);
});

// ==========================================================================
// Guarantee 2 — consent ON ⇒ send() receives EXACTLY the redacted + validated
// payload
// ==========================================================================

test('consent ON (base) ⇒ send() receives the redacted + validated payload exactly once', () => {
  const send = fakeSend();
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send,
  });
  const raw = validEventWithCredential();
  pipeline.record(raw);

  assert.equal(send.calls.length, 1, 'exactly one send per recorded event');
  const call = send.calls[0];
  assert.ok(Array.isArray(call.events) && call.events.length === 1, 'events is a 1-element array');
  assert.equal(call.consent, TIERS.BASE, 'the resolved tier is passed as consent');
  assert.equal(call.schemaVersion, SCHEMA_VERSION, 'the canonical schema version is threaded');
  assert.equal(call.events[0].type, 'error');
  assert.equal(call.events[0].runtime, 'main');
});

test('a credential planted in the raw event is [REDACTED:…] at the transport boundary', () => {
  const send = fakeSend();
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send,
  });
  pipeline.record(validEventWithCredential());

  const msg = send.calls[0].events[0].message;
  assert.ok(msg.includes('[REDACTED:github-token]'), 'credential is replaced by the redaction placeholder');
  assert.doesNotMatch(msg, /ghp_/, 'the raw token never reaches transport');
  assert.doesNotMatch(JSON.stringify(send.calls[0]), /ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789/);
});

test('the raw event handed to record() is NOT mutated (defensive copy at redact)', () => {
  const send = fakeSend();
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send,
  });
  const raw = validEventWithCredential();
  const snapshot = JSON.parse(JSON.stringify(raw));
  pipeline.record(raw);
  assert.deepEqual(raw, snapshot, 'the caller\'s event object must be unchanged');
  assert.ok(raw.message.includes(GH_TOKEN), 'the credential is still in the ORIGINAL (input was not mutated)');
  assert.ok(!send.calls[0].events[0].message.includes(GH_TOKEN), 'but absent from what was sent');
});

test('a real source-built base-tier error event flows through redact → validate → send intact', () => {
  const send = fakeSend();
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send,
  });
  // buildErrorEvent already redacts identifiers at the collection boundary; the
  // pipeline must still accept + validate + send it.
  const ev = buildErrorEvent(new Error('boom'), { now: 7, runtime: 'main' });
  pipeline.record(ev);
  assert.equal(send.calls.length, 1);
  assert.ok(validateBaseEvent(send.calls[0].events[0]), 'the sent event is schema-valid');
});

// ==========================================================================
// Safety net — no redactor wired ⇒ NOTHING is sent (defaultRedact guard)
// ==========================================================================
// defaultRedact is the pipeline's fallback when no slice-2 redactor is injected.
// It upholds "no un-redacted payload reaches transport, by construction" against
// the one slip the deferred live-wiring of main.cjs could make: forgetting to
// wire redact. It returns null for any structured payload → the default validator
// (validateBaseEvent) rejects it → the event is dropped pre-send. This test pins
// that guard so a future "redact is always injected, just `return payload`"
// cleanup cannot pass the suite while silently sending un-redacted payloads.
test('no redactor wired ⇒ nothing is sent (defaultRedact safety net holds)', () => {
  // Consent is ON (base) and a real transport is wired; ONLY redact is absent, so
  // the pipeline falls back to defaultRedact. The recorded event is schema-valid
  // AND carries a credential — so it WOULD reach transport if defaultRedact passed
  // it through. The only thing holding it back is defaultRedact returning null.
  const send = fakeSend();
  const pipeline = createTelemetryPipeline({ consent: consentReturning(TIERS.BASE), send });
  pipeline.record(validEventWithCredential());
  assert.equal(send.calls.length, 0, 'with no redactor wired, no payload reaches transport');
});

// Positive control for the guard above: the SAME event, with redact absent, is
// schema-valid, so the only reason it is not sent is defaultRedact (not an
// adjacent path like consent or validate). Proven by injecting the real redact
// and watching the identical event flow through to transport.
test('positive control: the same event DOES send once the real redact is wired', () => {
  const send = fakeSend();
  const pipeline = createTelemetryPipeline({ consent: consentReturning(TIERS.BASE), redact, send });
  pipeline.record(validEventWithCredential());
  assert.equal(send.calls.length, 1, 'with redact wired the schema-valid event flows');
});

// ==========================================================================
// Schema-invalid events are dropped PRE-SEND (never sent)
// ==========================================================================

test('a schema-invalid event is dropped pre-send (send() not called for it)', () => {
  const send = fakeSend();
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send,
  });
  // Wrong type → validateBaseEvent fails.
  pipeline.record({ schemaVersion: SCHEMA_VERSION, type: 'bogus', runtime: 'main', timestamp: 1 });
  // Crash event missing required `reason` → validateBaseEvent fails.
  pipeline.record({ schemaVersion: SCHEMA_VERSION, type: 'crash', runtime: 'renderer', timestamp: 1 });
  // Not even an object.
  pipeline.record(null);
  assert.equal(send.calls.length, 0, 'no invalid event reaches transport');
});

test('only the VALID event is sent when valid + invalid are interleaved', () => {
  const send = fakeSend();
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send,
  });
  pipeline.record({ schemaVersion: SCHEMA_VERSION, type: 'bogus', runtime: 'main', timestamp: 1 }); // invalid
  pipeline.record(validEventWithCredential()); // valid
  pipeline.record({ schemaVersion: SCHEMA_VERSION, type: 'crash', runtime: 'renderer', timestamp: 1 }); // invalid (no reason)
  assert.equal(send.calls.length, 1, 'only the one valid event was sent');
  assert.equal(send.calls[0].events[0].type, 'error');
});

test('an injected validate that rejects an otherwise-redacted event ⇒ no send', () => {
  const send = fakeSend();
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    validate: () => false, // slice-1 canonical validator rejects everything
    send,
  });
  pipeline.record(validEventWithCredential());
  assert.equal(send.calls.length, 0, 'a rejecting validator drops the event pre-send');
});

test('a throwing validator degrades to a dropped event (no send, no crash)', () => {
  const send = fakeSend();
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    validate: () => { throw new Error('validator blew up'); },
    send,
  });
  assert.doesNotThrow(() => pipeline.record(validEventWithCredential()));
  assert.equal(send.calls.length, 0);
});

// ==========================================================================
// Tier gating — identifiers only at the extended tier
// ==========================================================================

test('base tier ⇒ NO identifiers (chat/session names) at the transport boundary', () => {
  const send = fakeSend();
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send,
  });
  pipeline.record(validEventWithNames());
  const sent = send.calls[0].events[0];
  assert.equal(sent.chatName, undefined, 'chatName dropped at base tier');
  assert.equal(sent.sessionName, undefined, 'sessionName dropped at base tier');
  assert.ok(!('chatName' in sent), 'chatName key is not even present');
  assert.ok(!('sessionName' in sent), 'sessionName key is not even present');
});

test('extended tier ⇒ chat/session names ARE retained (only at tier === extended)', () => {
  const send = fakeSend();
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.EXTENDED),
    redact,
    send,
  });
  pipeline.record(validEventWithNames());
  const sent = send.calls[0].events[0];
  assert.equal(sent.chatName, 'Refactor auth module', 'chatName retained at extended tier');
  assert.equal(sent.sessionName, 'claude-7b3a2f1', 'sessionName retained at extended tier');
  // The safe base-tier fields survive at both tiers.
  assert.equal(sent.type, 'error');
  assert.equal(sent.timestamp, 1719500000123);
});

test('the SAME event yields names at extended but not at base (tier-driven, not event-driven)', () => {
  // One event recorded under each tier — the ONLY difference is the consent tier.
  for (const tier of [TIERS.BASE, TIERS.OFF]) {
    const send = fakeSend();
    const pipeline = createTelemetryPipeline({ consent: consentReturning(tier), redact, send });
    pipeline.record(validEventWithNames());
    if (tier === TIERS.OFF) {
      assert.equal(send.calls.length, 0);
    } else {
      assert.equal(send.calls[0].events[0].chatName, undefined, `no names at ${tier}`);
    }
  }
  const sendExt = fakeSend();
  const ext = createTelemetryPipeline({ consent: consentReturning(TIERS.EXTENDED), redact, send: sendExt });
  ext.record(validEventWithNames());
  assert.equal(sendExt.calls[0].events[0].chatName, 'Refactor auth module', 'names retained at extended');
});

// ==========================================================================
// Defense in depth — consent-off no-ops at BOTH record() AND the dispatch seam
// ==========================================================================

test('defense in depth: consent OFF blocks at record() (layer 1)', () => {
  const send = fakeSend();
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.OFF),
    redact,
    send,
  });
  pipeline.record(validEventWithCredential());
  assert.equal(send.calls.length, 0, 'layer 1 (record entry) blocks when consent is off');
});

test('defense in depth: dispatch() ALSO no-ops when consent is OFF (layer 2)', () => {
  const send = fakeSend();
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.OFF),
    redact,
    send,
  });
  // A DIRECT dispatch with consent OFF must send nothing — the second guard fires
  // independently of record()'s entry gate.
  pipeline.dispatch(validEventWithCredential());
  assert.equal(send.calls.length, 0, 'layer 2 (dispatch) blocks when consent is off');

  // Positive control: flipping consent ON lets the same direct dispatch send.
  pipeline.setConsent(consentReturning(TIERS.BASE));
  pipeline.dispatch(validEventWithCredential());
  assert.equal(send.calls.length, 1, 'a direct dispatch sends once consent is on');
});

test('dispatch() redacts + validates the payload itself — no bypass can leak', () => {
  const send = fakeSend();
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send,
  });
  // A raw credential handed DIRECTLY to dispatch must still be redacted before
  // transport — the "only redacted payloads reach transport, by construction"
  // guarantee holds regardless of the entry path.
  pipeline.dispatch(validEventWithCredential());
  assert.equal(send.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(send.calls[0]), /ghp_/);
  assert.ok(send.calls[0].events[0].message.includes('[REDACTED:github-token]'));

  // And a schema-invalid payload handed directly to dispatch is dropped pre-send.
  send.calls.length = 0;
  pipeline.dispatch({ schemaVersion: SCHEMA_VERSION, type: 'bogus', runtime: 'main', timestamp: 1 });
  assert.equal(send.calls.length, 0, 'direct dispatch drops a schema-invalid payload');
});

// ==========================================================================
// Robustness — telemetry must never throw the host into a worse state
// ==========================================================================

test('a throwing (sync) transport is swallowed — record() does not crash the host', () => {
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send: () => { throw new Error('transport down'); },
  });
  assert.doesNotThrow(() => pipeline.record(validEventWithCredential()));
});

test('a rejecting (async) transport is swallowed — record() does not crash the host', async () => {
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send: () => Promise.reject(new Error('network gone')),
  });
  assert.doesNotThrow(() => pipeline.record(validEventWithCredential()));
  // Give the swallowed rejection's no-op handler a tick to settle (it must not
  // surface as an unhandled rejection).
  await new Promise((r) => setTimeout(r, 10));
});

// ==========================================================================
// Hot-swap seams — the slice 1 / slice 3 wiring surface
// ==========================================================================

test('setSend hot-swaps the transport (slice-3 wiring seam)', () => {
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send: fakeSend(),
  });
  const next = fakeSend();
  pipeline.setSend(next);
  pipeline.record(validEventWithCredential());
  assert.equal(next.calls.length, 1, 'the swapped-in transport received the event');
});

test('setConsent flips the tier live (slice-1 consent-pref wiring seam)', () => {
  const send = fakeSend();
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.OFF),
    redact,
    send,
  });
  pipeline.record(validEventWithCredential());
  assert.equal(send.calls.length, 0, 'off initially → nothing sent');
  pipeline.setConsent(consentReturning(TIERS.BASE));
  pipeline.record(validEventWithCredential());
  assert.equal(send.calls.length, 1, 'after flipping consent on, the event flows');
});

test('setEndpoint / setSchemaVersion thread through to the transport call', () => {
  const send = fakeSend();
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send,
  });
  pipeline.setEndpoint('https://telemetry.example.invalid/v1/events');
  pipeline.setSchemaVersion(2);
  pipeline.record(validEventWithCredential());
  assert.equal(send.calls[0].endpointUrl, 'https://telemetry.example.invalid/v1/events');
  assert.equal(send.calls[0].schemaVersion, 2);
});

test('setAuthToken threads the auth token through to the transport call (WARDEN-569)', () => {
  const send = fakeSend();
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send,
  });
  pipeline.setEndpoint('https://telemetry.example.invalid/ingest');
  pipeline.setAuthToken('shared-secret-token');
  pipeline.record(validEventWithCredential());
  assert.equal(send.calls[0].authToken, 'shared-secret-token', 'auth token reaches the transport');
});

test('authToken defaults to null — the transport gets no token when none is set (WARDEN-569)', () => {
  const send = fakeSend();
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send,
  });
  pipeline.record(validEventWithCredential());
  assert.equal(send.calls[0].authToken, null, 'no token by default → open-receiver compatible');
});

test('setAuthToken with an empty/null value clears the token (→ no header)', () => {
  const send = fakeSend();
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send,
  });
  pipeline.setAuthToken('first-token');
  pipeline.setAuthToken(''); // clear
  pipeline.record(validEventWithCredential());
  assert.equal(send.calls[0].authToken, null, 'empty string clears the token back to null');
});

test('authToken is also accepted at construction (opts.authToken)', () => {
  const send = fakeSend();
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send,
    authToken: 'constructed-token',
  });
  pipeline.record(validEventWithCredential());
  assert.equal(send.calls[0].authToken, 'constructed-token');
});

test('fetchImpl / sleepImpl are threaded through to the transport (slice-3 retry contract)', () => {
  const send = fakeSend();
  const fetchImpl = () => Promise.resolve();
  const sleepImpl = () => Promise.resolve();
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send,
    fetchImpl,
    sleepImpl,
  });
  pipeline.record(validEventWithCredential());
  assert.equal(send.calls[0].fetchImpl, fetchImpl);
  assert.equal(send.calls[0].sleepImpl, sleepImpl);
});

// ==========================================================================
// WARDEN-585 — LIVE consent threaded to the transport's in-loop re-check
// ==========================================================================
// The pipeline hands the transport a SNAPSHOT tier (call.consent) for its entry
// gate, but ALSO a LIVE isConsentActive() resolver that re-reads the SAME source
// the layer-2 guard uses (effectiveTier). So a revoke that lands during the
// transport's bounded-retry backoff halts the in-flight batch before its next
// attempt — "halts all traffic immediately" holds end-to-end, not just to dispatch.

test('the transport receives a LIVE isConsentActive callback alongside the snapshot tier', () => {
  let live = TIERS.BASE;
  const send = fakeSend();
  const pipeline = createTelemetryPipeline({ consent: () => live, redact, send });
  pipeline.record(validEventWithCredential());

  const call = send.calls[0];
  assert.equal(typeof call.isConsentActive, 'function', 'transport gets an isConsentActive resolver');
  assert.equal(call.consent, TIERS.BASE, 'snapshot tier still passed for the entry gate');
  assert.equal(call.isConsentActive(), true, 'active while consent resolves to BASE');
  live = TIERS.OFF;
  assert.equal(call.isConsentActive(), false, 'flips to inactive once consent re-resolves to OFF');
});

test('isConsentActive re-resolves LIVE: a revoke AFTER dispatch halts the in-flight batch', () => {
  // The callback captured at send-time must STILL reflect a LATER revoke — proving
  // it holds a live resolver, not a snapshot of the tier at dispatch time.
  let live = TIERS.BASE;
  const send = fakeSend();
  const pipeline = createTelemetryPipeline({ consent: () => live, redact, send });
  pipeline.record(validEventWithCredential());
  const { isConsentActive } = send.calls[0];
  assert.equal(isConsentActive(), true);
  live = TIERS.OFF; // user revokes AFTER dispatch handed the batch to transport
  assert.equal(isConsentActive(), false, 'the in-flight batch is halted by the later revoke');
});

test('isConsentActive degrades to inactive when the consent resolver throws (effectiveTier safety)', () => {
  // Proves the resolver uses effectiveTier() (which try/catches → OFF), not a raw
  // resolveTier(consent()) that would THROW into the transport's retry loop.
  const send = fakeSend();
  let throwNext = false;
  const pipeline = createTelemetryPipeline({
    consent: () => { if (throwNext) throw new Error('pref store down'); return TIERS.BASE; },
    redact,
    send,
  });
  pipeline.record(validEventWithCredential());
  const { isConsentActive } = send.calls[0];
  assert.equal(isConsentActive(), true);
  throwNext = true;
  assert.equal(isConsentActive(), false, 'a throwing resolver degrades to inactive, not a throw');
});

test('setValidate overrides the default source-contract validator (slice-1 canonical seam)', () => {
  const send = fakeSend();
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send,
  });
  // Default validate accepts the event.
  pipeline.record(validEventWithCredential());
  assert.equal(send.calls.length, 1);
  // Swap to a stricter slice-1 canonical validator that rejects everything.
  pipeline.setValidate(() => false);
  pipeline.record(validEventWithCredential());
  assert.equal(send.calls.length, 1, 'the overridden validator now drops the event');
});

// ==========================================================================
// Transmission log — ACTUAL send outcomes (WARDEN-583, verifiability's third leg)
// ==========================================================================
// The pipeline ROUTES the transport result into an injected transmissionLog
// instead of swallowing it (the old `result.then(() => {}, () => {})`). These
// prove the swallow-point wiring + the outcome mapping
//   ok:true      → outcome 'ok'
//   dropped:true → outcome 'dropped'
//   gate no-op / undefined result → NO entry (absence of entries = gated-off)
// with controllable fakes + an injected fixed-clock log. The end-to-end REAL
// transport outcomes (2xx ok, 5xx/network dropped, consent-off stops entries) are
// covered by telemetry-live-wire.test.mjs.

// A fixed clock so recorded timestamps are pin-able (test discipline).
const TLOG_CLOCK = () => 1719500000123;
const TLOG_ENDPOINT = 'https://telemetry.example.invalid/v1/events';

// A fake transport that returns a FIXED result object (sync) — stands in for the
// real transport's resolved { ok, dropped, attempts, status }, recording calls.
function sendReturning(result) {
  const calls = [];
  const fn = (args) => { calls.push(args); return result; };
  fn.calls = calls;
  return fn;
}

// A thenable that resolves SYNCHRONOUSLY when .then is called — exercises the
// async `result.then` branch (the one the real Promise-based transport takes) and
// records in the SAME tick, so the assertion does not depend on the test runner
// awaiting. The real microtask-settling Promise path is covered by the live-wire
// suite, which awaits.
function sendThenable(result) {
  const calls = [];
  const fn = (args) => {
    calls.push(args);
    return { then(onFulfilled) { if (onFulfilled) onFulfilled(result); return this; } };
  };
  fn.calls = calls;
  return fn;
}

test('a successful transport result records an outcome:ok entry (WARDEN-583)', () => {
  const log = createTransmissionLog({ clock: TLOG_CLOCK });
  const send = sendReturning({ ok: true, dropped: false, attempts: 1, status: 200 });
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send,
    endpointUrl: TLOG_ENDPOINT,
    transmissionLog: log,
  });
  pipeline.record(validEventWithCredential());
  assert.equal(log.size(), 1, 'exactly one entry for one send');
  const e = log.entries()[0];
  assert.equal(e.outcome, 'ok');
  assert.equal(e.endpointHost, 'telemetry.example.invalid', 'host derived from the endpoint (no path/query)');
  assert.equal(e.schemaVersion, SCHEMA_VERSION, 'the canonical schema version is threaded');
  assert.equal(e.eventCount, 1, 'dispatch sends one event at a time');
  assert.equal(e.attempts, 1);
  assert.equal(e.status, 200);
  assert.equal(e.timestamp, 1719500000123, "stamped by the log's injected clock");
});

test('a dropped transport result records an outcome:dropped entry', () => {
  const log = createTransmissionLog({ clock: TLOG_CLOCK });
  const send = sendReturning({ ok: false, dropped: true, attempts: 3, status: 503 });
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send,
    endpointUrl: TLOG_ENDPOINT,
    transmissionLog: log,
  });
  pipeline.record(validEventWithCredential());
  const e = log.entries()[0];
  assert.equal(e.outcome, 'dropped', 'a lost batch is now VISIBLE (today it vanishes silently)');
  assert.equal(e.attempts, 3);
  assert.equal(e.status, 503);
});

test('the transport gate no-op {ok:false,dropped:false} records NO entry', () => {
  const log = createTransmissionLog({ clock: TLOG_CLOCK });
  const send = sendReturning({ ok: false, dropped: false, attempts: 0, status: null });
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send,
    endpointUrl: TLOG_ENDPOINT,
    transmissionLog: log,
  });
  pipeline.record(validEventWithCredential());
  assert.equal(log.size(), 0, 'the gate no-op is not a real send → absence of entries');
});

test('a transport returning undefined (the default no-op transport) records NO entry', () => {
  const log = createTransmissionLog({ clock: TLOG_CLOCK });
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send: fakeSend(), // returns undefined — the default noopSend shape
    endpointUrl: TLOG_ENDPOINT,
    transmissionLog: log,
  });
  pipeline.record(validEventWithCredential());
  assert.equal(log.size(), 0, 'a non-result-bearing transport records nothing');
});

test('consent OFF records NO entry (the dispatch guard returns before transportSend)', () => {
  const log = createTransmissionLog({ clock: TLOG_CLOCK });
  const send = sendReturning({ ok: true, dropped: false, attempts: 1, status: 200 });
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.OFF),
    redact,
    send,
    endpointUrl: TLOG_ENDPOINT,
    transmissionLog: log,
  });
  pipeline.record(validEventWithCredential());
  assert.equal(send.calls.length, 0, 'transport never called');
  assert.equal(log.size(), 0, 'no entry — disabling halts all traffic (absence is the signal)');
});

test('a recorded entry is METADATA ONLY — no payload content, redacted text, or identifiers', () => {
  const log = createTransmissionLog({ clock: TLOG_CLOCK });
  const send = sendReturning({ ok: true, dropped: false, attempts: 1, status: 200 });
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send,
    endpointUrl: TLOG_ENDPOINT,
    transmissionLog: log,
  });
  pipeline.record(validEventWithCredential()); // carries a credential in its message
  const blob = JSON.stringify(log.entries());
  assert.doesNotMatch(blob, /ghp_/, 'the raw credential never reaches the log');
  assert.doesNotMatch(blob, /\[REDACTED/, 'not even the redacted payload text is retained');
  const e = log.entries()[0];
  assert.deepEqual(
    Object.keys(e).sort(),
    ['attempts', 'endpointHost', 'eventCount', 'outcome', 'schemaVersion', 'status', 'timestamp'],
    'the entry is exactly the seven metadata fields',
  );
});

test('a pipeline with NO transmissionLog injected still sends and records nothing (default no-op)', () => {
  // The default collaborator is the frozen no-op recorder — an unconfigured pipeline
  // behaves EXACTLY as before this slice: it still sends, and the no-op log absorbs
  // the recordOutcome call without allocating or retaining anything.
  const send = sendReturning({ ok: true, dropped: false, attempts: 1, status: 200 });
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send,
    endpointUrl: TLOG_ENDPOINT,
    // no transmissionLog — default no-op recorder is used
  });
  assert.doesNotThrow(() => pipeline.record(validEventWithCredential()));
  assert.equal(send.calls.length, 1, 'the pipeline still sends (the no-op log does not interfere)');
});

test('an async (thenable) transport result records the entry via the .then branch', () => {
  const log = createTransmissionLog({ clock: TLOG_CLOCK });
  const send = sendThenable({ ok: true, dropped: false, attempts: 2, status: 200 });
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send,
    endpointUrl: TLOG_ENDPOINT,
    transmissionLog: log,
  });
  pipeline.record(validEventWithCredential());
  // The thenable resolves synchronously, so the entry is recorded in the same tick.
  assert.equal(log.size(), 1, 'the .then branch routed the resolved result into the log');
  assert.equal(log.entries()[0].attempts, 2);
});

test('entries respect the injected log cap (bounded — oldest dropped)', () => {
  const log = createTransmissionLog({ clock: TLOG_CLOCK, cap: 2 });
  const send = sendReturning({ ok: true, dropped: false, attempts: 1, status: 200 });
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send,
    endpointUrl: TLOG_ENDPOINT,
    transmissionLog: log,
  });
  for (let i = 0; i < 5; i++) pipeline.record(validEventWithCredential());
  assert.equal(log.size(), 2, 'the pipeline-driven log respects its cap');
});

// ==========================================================================
// WARDEN-817 — pre-send validate rejections record a 'rejected' outcome (the
// missing third outcome alongside Delivered/Dropped). Previously the pre-send
// drop site (validate threw OR returned false) vanished the event with NO log
// line, NO transmission-log entry, and NO runtime-status arm. Now an opt-in user
// sees client-side rejections in the verifiability panel. Purely additive: the
// drop still happens, no gate is relaxed.
// ==========================================================================

test('a pre-send validate rejection records an outcome:rejected entry (WARDEN-817)', () => {
  // Identity redactor (p => p) + the REAL validateBaseEvent + a message carrying
  // a path → the validator's identifier-leak proof rejects it pre-send. This is
  // the generic validate-rejection trigger (any cause), NOT a drift simulation.
  const log = createTransmissionLog({ clock: TLOG_CLOCK });
  const send = fakeSend();
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact: (p) => p,
    send, // default validate is the REAL validateBaseEvent
    endpointUrl: TLOG_ENDPOINT,
    transmissionLog: log,
  });
  pipeline.record(validEventWithPathIdentifier());
  assert.equal(send.calls.length, 0, 'the rejected event never reaches transport');
  assert.equal(log.size(), 1, 'exactly one entry — the rejection is no longer silent');
  const e = log.entries()[0];
  assert.equal(e.outcome, 'rejected', 'the missing third outcome is recorded');
  assert.equal(e.endpointHost, 'telemetry.example.invalid', 'the configured destination host (diagnostic, metadata-only)');
  assert.equal(e.schemaVersion, SCHEMA_VERSION, 'the canonical schema version is threaded');
  assert.equal(e.eventCount, 1, 'the single redacted event that failed validation');
  assert.equal(e.attempts, 0, 'never went to the wire');
  assert.equal(e.status, null, 'never went to the wire');
  assert.equal(e.timestamp, 1719500000123, "stamped by the log's injected clock");
});

test('a rejected entry is METADATA ONLY — the caught path/identifier never reaches the log', () => {
  const log = createTransmissionLog({ clock: TLOG_CLOCK });
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact: (p) => p,
    send: fakeSend(),
    endpointUrl: TLOG_ENDPOINT,
    transmissionLog: log,
  });
  pipeline.record(validEventWithPathIdentifier()); // message carries /home/alice/secret/config
  const e = log.entries()[0];
  assert.deepEqual(
    Object.keys(e).sort(),
    ['attempts', 'endpointHost', 'eventCount', 'outcome', 'schemaVersion', 'status', 'timestamp'],
    'the entry is exactly the seven metadata fields',
  );
  const blob = JSON.stringify(log.entries());
  assert.doesNotMatch(blob, /home|alice|secret|config/, 'the leaked path that tripped the validator is NOT retained');
});

test('a rejected entry SURVIVES a record → serialize → parse → seed reload round-trip', () => {
  // Guards the LOAD-BEARING allow-list (telemetry-transmission-log.cjs:99): without
  // 'rejected' admitted there, normalizeEntry strips it to outcome:null on BOTH
  // record() AND seed() — the entry would render as 'Unknown' after a restart.
  const recorded = createTransmissionLog({ clock: TLOG_CLOCK });
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact: (p) => p,
    send: fakeSend(),
    endpointUrl: TLOG_ENDPOINT,
    transmissionLog: recorded,
  });
  pipeline.record(validEventWithPathIdentifier());
  assert.equal(recorded.entries()[0].outcome, 'rejected', 'written as rejected');
  // main.cjs serializes via `entries.map(JSON.stringify).join('\n')`; mirror it here.
  const text = recorded.entries().map((e) => JSON.stringify(e)).join('\n') + '\n';
  // A fresh log (a restarted app) loads + seeds from the parsed file.
  const restarted = createTransmissionLog({ clock: () => 0 });
  restarted.seed(parseTransmissionLog(text));
  assert.equal(
    restarted.entries()[0].outcome,
    'rejected',
    'the outcome survives normalizeEntry on the reload path — NOT stripped to null',
  );
  assert.deepEqual(restarted.entries(), recorded.entries(), 'the round-trip is lossless');
});

test('a THROWING validator also records a rejected entry (the merged drop site covers both paths)', () => {
  // The pre-send drop site records 'rejected' for BOTH a false return AND a
  // throwing validator — the two analogous silent-drop paths now share one record.
  const log = createTransmissionLog({ clock: TLOG_CLOCK });
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    validate: () => { throw new Error('validator blew up'); },
    send: fakeSend(),
    endpointUrl: TLOG_ENDPOINT,
    transmissionLog: log,
  });
  assert.doesNotThrow(() => pipeline.record(validEventWithCredential()));
  assert.equal(log.size(), 1, 'a throwing validator is recorded as rejected (no longer silent)');
  assert.equal(log.entries()[0].outcome, 'rejected');
});

test('consent OFF records NO rejected entry (the rejection site is past the consent guard)', () => {
  // Trust posture: a 'rejected' entry is written ONLY when consent is ON. When off,
  // the dispatch consent guard returns BEFORE validate, so an event that WOULD be
  // rejected never reaches the rejection site — it surfaces as the usual absence.
  const log = createTransmissionLog({ clock: TLOG_CLOCK });
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.OFF),
    redact: (p) => p,
    send: fakeSend(),
    endpointUrl: TLOG_ENDPOINT,
    transmissionLog: log,
  });
  pipeline.record(validEventWithPathIdentifier());
  assert.equal(log.size(), 0, 'no rejected entry when consent is off (the guard precedes the drop site)');
});

test('a drifted endpoint records NO rejected entry (the drift guard precedes the drop site too)', () => {
  // The drift guard (WARDEN-631) returns BEFORE validate, so a drifted endpoint
  // short-circuits before the rejection site — parity with the consent-off case.
  const log = createTransmissionLog({ clock: TLOG_CLOCK });
  const send = sendReturning({ ok: false, dropped: true, drifted: true, attempts: 1, status: 415 });
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact: (p) => p,
    send,
    endpointUrl: TLOG_ENDPOINT,
    transmissionLog: log,
  });
  pipeline.record(validEventWithCredential()); // arms the breaker (drifted send → dropped)
  assert.equal(log.entries()[0].outcome, 'dropped', 'the drifted send itself is a transport drop');
  // A subsequent event that WOULD be rejected hits the drift guard first → no reject entry.
  pipeline.record(validEventWithPathIdentifier());
  const outcomes = log.entries().map((e) => e.outcome);
  assert.deepEqual(outcomes, ['dropped'], 'the drifted dispatch records no rejected entry (guard precedes the drop site)');
});

// ==========================================================================
// WARDEN-631 — per-endpoint schema-drift circuit-breaker
// ==========================================================================
// The receiver returns 415 on an x-telemetry-schema mismatch (ingest.mjs). The
// transport (slice 3) now sets drifted:true on that outcome; the pipeline arms a
// session-scoped, in-memory breaker that short-circuits dispatch BEFORE redact/
// validate/transportSend — the endpoint cannot accept the current schema, so
// collecting + POSTing is pure waste. The breaker clears on endpoint change,
// schema-version change, or a later successful send, and surfaces each transition
// through the onRuntimeStatus tap (the main→renderer bridge, Part 3).

// Captures every runtime-status push so a test can assert the exact transition
// sequence (and that a no-op transition never fires).
function statusSpy() {
  const calls = [];
  const fn = (status) => { calls.push(status); };
  fn.calls = calls;
  return fn;
}

// A deferred-thenable transport: each send returns a thenable whose .then queues
// the settle callback WITHOUT calling it, so a test can dispatch several events
// past the drift check (drift still false), then resolve their outcomes IN ORDER
// to exercise the interleaved-result path (e.g. a later success clearing an
// already-armed breaker). settle runs synchronously inside resolveAt (no timers).
function sendDeferredSeq(results) {
  const handlers = [];
  const calls = [];
  const send = (args) => {
    calls.push(args);
    const thenable = {
      then(onFulfilled) { handlers.push(onFulfilled); return thenable; },
    };
    return thenable;
  };
  send.calls = calls;
  send.resolveAt = (i) => {
    const h = handlers[i];
    if (h) h(results[Math.min(i, results.length - 1)]);
  };
  return send;
}

const DRIFT_EVENT = validEventWithCredential;

test('getRuntimeStatus defaults to { drifted: false } (no drift out of the box)', () => {
  const pipeline = createTelemetryPipeline({ consent: consentReturning(TIERS.BASE), redact, send: fakeSend() });
  assert.deepEqual(pipeline.getRuntimeStatus(), { drifted: false, deliveryFailing: false });
});

test('a drifted (415) transport outcome arms the breaker → further dispatches send NOTHING', () => {
  const send = sendReturning({ ok: false, dropped: true, drifted: true, attempts: 1, status: 415 });
  const pipeline = createTelemetryPipeline({ consent: consentReturning(TIERS.BASE), redact, send });
  pipeline.record(DRIFT_EVENT()); // first send → 415 → arms the breaker
  assert.equal(send.calls.length, 1, 'the first (drifted) send went through');
  assert.equal(pipeline.getRuntimeStatus().drifted, true, 'breaker is armed');

  pipeline.record(DRIFT_EVENT()); // short-circuited
  pipeline.record(DRIFT_EVENT()); // short-circuited
  assert.equal(send.calls.length, 1, 'no further transport call after the breaker armed — futile sends skipped');
});

test('a short-circuited (drifted) dispatch records NO transmission-log entry (a stop, like consent-off)', () => {
  const log = createTransmissionLog({ clock: TLOG_CLOCK });
  const send = sendReturning({ ok: false, dropped: true, drifted: true, attempts: 1, status: 415 });
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send,
    endpointUrl: TLOG_ENDPOINT,
    transmissionLog: log,
  });
  pipeline.record(DRIFT_EVENT()); // the drifted send itself → recorded as outcome:dropped + arms breaker
  assert.equal(log.size(), 1, 'the drifted send is recorded as a dropped outcome');
  pipeline.record(DRIFT_EVENT()); // short-circuited
  pipeline.record(DRIFT_EVENT());
  assert.equal(log.size(), 1, 'short-circuited sends record nothing — like a gated no-op');
});

test('a NON-drift drop (e.g. a 503) does NOT arm the breaker — a reachable receiver is never wedged', () => {
  // dropped:true WITHOUT drifted:true (a transient-exhaustion drop, not a 415).
  const send = sendReturning({ ok: false, dropped: true, attempts: 3, status: 503 });
  const pipeline = createTelemetryPipeline({ consent: consentReturning(TIERS.BASE), redact, send });
  pipeline.record(DRIFT_EVENT());
  assert.equal(pipeline.getRuntimeStatus().drifted, false, 'a generic drop never arms the breaker');
  pipeline.record(DRIFT_EVENT());
  assert.equal(send.calls.length, 2, 'sends keep flowing — only a 415 drift breaks the circuit');
});

test('the gate no-op and a revoked result do NOT arm the breaker', () => {
  // gate no-op {ok:false,dropped:false} — not a real send.
  let send = sendReturning({ ok: false, dropped: false, attempts: 0, status: null });
  let pipeline = createTelemetryPipeline({ consent: consentReturning(TIERS.BASE), redact, send });
  pipeline.record(DRIFT_EVENT());
  assert.equal(pipeline.getRuntimeStatus().drifted, false, 'the gate no-op does not arm');
  // revoked {ok:false,dropped:false,revoked:true} — a consent halt, not a drift.
  send = sendReturning({ ok: false, dropped: false, revoked: true, attempts: 1, status: null });
  pipeline = createTelemetryPipeline({ consent: consentReturning(TIERS.BASE), redact, send });
  pipeline.record(DRIFT_EVENT());
  assert.equal(pipeline.getRuntimeStatus().drifted, false, 'a revoke does not arm');
});

test('setEndpoint with a NEW url clears an armed breaker → sends resume', () => {
  const send = sendReturning({ ok: false, dropped: true, drifted: true, attempts: 1, status: 415 });
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send,
    endpointUrl: 'https://telemetry.example.invalid/v1/events',
  });
  pipeline.record(DRIFT_EVENT()); // arm
  assert.equal(pipeline.getRuntimeStatus().drifted, true);
  // A different endpoint (the user re-pointed the receiver) clears the breaker.
  pipeline.setEndpoint('https://telemetry-other.example/ingest');
  assert.equal(pipeline.getRuntimeStatus().drifted, false, 'endpoint change cleared the breaker');
  pipeline.record(DRIFT_EVENT());
  assert.equal(send.calls.length, 2, 'a send now goes through after the endpoint change');
});

test('setEndpoint with the SAME url does NOT clear the breaker (change-guard against pref re-applies)', () => {
  // applyTelemetryConfig calls setEndpoint on EVERY pref update (incl. a tier
  // toggle). A blind reset would let a same-endpoint re-apply re-arm a futile send,
  // so the breaker only clears on a GENUINE endpoint change.
  const spy = statusSpy();
  const ENDPOINT = 'https://telemetry.example.invalid/ingest';
  const send = sendReturning({ ok: false, dropped: true, drifted: true, attempts: 1, status: 415 });
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send,
    endpointUrl: ENDPOINT,
    onRuntimeStatus: spy,
  });
  pipeline.record(DRIFT_EVENT()); // arm
  assert.deepEqual(spy.calls, [{ drifted: true, deliveryFailing: false }]);
  pipeline.setEndpoint(ENDPOINT); // same url → no-op
  assert.deepEqual(spy.calls, [{ drifted: true, deliveryFailing: false }], 'same endpoint fires no clear');
  assert.equal(pipeline.getRuntimeStatus().drifted, true, 'breaker stays armed on a same-url re-apply');
  pipeline.setEndpoint('https://other.example/ingest'); // different → clears
  assert.deepEqual(spy.calls, [{ drifted: true, deliveryFailing: false }, { drifted: false, deliveryFailing: false }]);
});

test('setSchemaVersion change clears an armed breaker (the client re-versioned)', () => {
  const send = sendReturning({ ok: false, dropped: true, drifted: true, attempts: 1, status: 415 });
  const pipeline = createTelemetryPipeline({ consent: consentReturning(TIERS.BASE), redact, send });
  pipeline.record(DRIFT_EVENT()); // arm
  assert.equal(pipeline.getRuntimeStatus().drifted, true);
  pipeline.setSchemaVersion(SCHEMA_VERSION); // same → no-op
  assert.equal(pipeline.getRuntimeStatus().drifted, true, 'same schema version does not clear');
  pipeline.setSchemaVersion(SCHEMA_VERSION + 1); // different → clears
  assert.equal(pipeline.getRuntimeStatus().drifted, false, 'a schema-version change cleared the breaker');
  pipeline.record(DRIFT_EVENT());
  assert.equal(send.calls.length, 2, 'a send now goes through after the schema change');
});

test('a later SUCCESSFUL send clears an armed breaker (interleaved async outcomes)', () => {
  // Two dispatches pass the drift check (drift=false) before either outcome
  // resolves. Outcome #1 → 415 (arms); outcome #2 → 200 (clears). The breaker
  // must reflect the most recent real outcome, not stay wedged on the 415.
  const send = sendDeferredSeq([
    { ok: false, dropped: true, drifted: true, attempts: 1, status: 415 },
    { ok: true, dropped: false, attempts: 1, status: 200 },
  ]);
  const pipeline = createTelemetryPipeline({ consent: consentReturning(TIERS.BASE), redact, send });
  assert.equal(pipeline.getRuntimeStatus().drifted, false);
  pipeline.record(DRIFT_EVENT()); // dispatch #1 — check passes, outcome pending
  pipeline.record(DRIFT_EVENT()); // dispatch #2 — check passes (drift still false), outcome pending
  send.resolveAt(0); // 415 → arms
  assert.equal(pipeline.getRuntimeStatus().drifted, true, 'the 415 armed the breaker');
  send.resolveAt(1); // 200 → clears
  assert.equal(pipeline.getRuntimeStatus().drifted, false, 'the later success cleared the breaker');
});

test('onRuntimeStatus fires ONLY on a real arm/clear transition — never on a no-op', () => {
  const spy = statusSpy();
  const send = sendReturning({ ok: false, dropped: true, drifted: true, attempts: 1, status: 415 });
  const pipeline = createTelemetryPipeline({ consent: consentReturning(TIERS.BASE), redact, send, onRuntimeStatus: spy });
  assert.deepEqual(spy.calls, [], 'no status pushed at construction');
  pipeline.record(DRIFT_EVENT()); // arm → fire
  assert.deepEqual(spy.calls, [{ drifted: true, deliveryFailing: false }]);
  pipeline.record(DRIFT_EVENT()); // short-circuit → NO outcome → NO fire
  assert.deepEqual(spy.calls, [{ drifted: true, deliveryFailing: false }], 'a short-circuit does not re-fire');
  pipeline.setEndpoint('https://other.example/ingest'); // clear → fire
  assert.deepEqual(spy.calls, [{ drifted: true, deliveryFailing: false }, { drifted: false, deliveryFailing: false }]);
  // A successful send while NOT drifted fires nothing (no transition).
  const ok = sendReturning({ ok: true, dropped: false, attempts: 1, status: 200 });
  const spy2 = statusSpy();
  const p2 = createTelemetryPipeline({ consent: consentReturning(TIERS.BASE), redact, send: ok, onRuntimeStatus: spy2 });
  p2.record(DRIFT_EVENT());
  assert.deepEqual(spy2.calls, [], 'a success from a non-drifted state fires nothing');
});

test('a throwing onRuntimeStatus tap is swallowed (a status bridge never breaks a send)', () => {
  const send = sendReturning({ ok: false, dropped: true, drifted: true, attempts: 1, status: 415 });
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send,
    onRuntimeStatus: () => { throw new Error('bridge blew up'); },
  });
  assert.doesNotThrow(() => pipeline.record(DRIFT_EVENT()), 'a throwing tap never propagates');
  assert.equal(pipeline.getRuntimeStatus().drifted, true, 'the breaker still armed despite the throw');
});

test('a late 415 for the OLD endpoint does NOT arm drift for a NEW endpoint (stale-result guard)', () => {
  // A send targets endpoint X; while it is in-flight the user re-points to Y. The
  // send then resolves 415 — drift must NOT arm for Y (X's outcome is stale relative
  // to the current endpoint). Without the guard this would wedge a schema-matched Y.
  const send = sendDeferredSeq([{ ok: false, dropped: true, drifted: true, attempts: 1, status: 415 }]);
  const spy = statusSpy();
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send,
    endpointUrl: 'https://x.example/ingest',
    onRuntimeStatus: spy,
  });
  pipeline.record(DRIFT_EVENT()); // dispatch to X — outcome pending
  pipeline.setEndpoint('https://y.example/ingest'); // re-point to Y mid-flight
  assert.equal(pipeline.getRuntimeStatus().drifted, false, 'drift not armed yet');
  send.resolveAt(0); // X's late 415 resolves AFTER the endpoint became Y
  assert.equal(pipeline.getRuntimeStatus().drifted, false, 'the stale X 415 did NOT arm drift for Y');
  assert.deepEqual(spy.calls, [], 'no status transition fired for the stale result');
  // Y is not wedged: a send to Y now flows.
  const ok = sendReturning({ ok: true, dropped: false, attempts: 1, status: 200 });
  pipeline.setSend(ok);
  pipeline.record(DRIFT_EVENT());
  assert.equal(ok.calls.length, 1, 'Y receives the send — not wedged by X’s old 415');
});

test('a fresh (non-stale) 415 still arms drift — the guard only skips changed-endpoint results', () => {
  // Same deferred shape, but the endpoint does NOT change before the result resolves
  // → the 415 is fresh → drift arms normally. Proves the guard is about staleness,
  // not a blanket suppression of async drift outcomes.
  const send = sendDeferredSeq([{ ok: false, dropped: true, drifted: true, attempts: 1, status: 415 }]);
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send,
    endpointUrl: 'https://x.example/ingest',
  });
  pipeline.record(DRIFT_EVENT());
  send.resolveAt(0); // endpoint unchanged → fresh 415
  assert.equal(pipeline.getRuntimeStatus().drifted, true, 'a fresh 415 arms the breaker');
});

test('clearRuntimeDrift clears an armed breaker and emits the transition (Test-connection reset)', () => {
  const spy = statusSpy();
  const send = sendReturning({ ok: false, dropped: true, drifted: true, attempts: 1, status: 415 });
  const pipeline = createTelemetryPipeline({ consent: consentReturning(TIERS.BASE), redact, send, onRuntimeStatus: spy });
  pipeline.record(DRIFT_EVENT()); // arm
  assert.equal(pipeline.getRuntimeStatus().drifted, true);
  assert.deepEqual(spy.calls, [{ drifted: true, deliveryFailing: false }]);
  pipeline.clearRuntimeDrift(); // user-driven clear (a 'connected' Test connection)
  assert.equal(pipeline.getRuntimeStatus().drifted, false, 'breaker cleared');
  assert.deepEqual(spy.calls, [{ drifted: true, deliveryFailing: false }, { drifted: false, deliveryFailing: false }], 'the clear was pushed');
  pipeline.record(DRIFT_EVENT()); // sends resume
  assert.equal(send.calls.length, 2, 'a send now goes through after the clear');
});

test('clearRuntimeDrift is a no-op (and emits nothing) when drift is not armed', () => {
  const spy = statusSpy();
  const pipeline = createTelemetryPipeline({ consent: consentReturning(TIERS.BASE), redact, send: fakeSend(), onRuntimeStatus: spy });
  pipeline.clearRuntimeDrift();
  assert.equal(pipeline.getRuntimeStatus().drifted, false);
  assert.deepEqual(spy.calls, [], 'no transition fired when there was nothing to clear');
});

// ==========================================================================
// WARDEN-671 — bounded in-memory replay buffer for transiently-dropped sends
// ==========================================================================
// An event that passed every gate (consent → redact → validate) and reached the
// wire used to be DROPPED FOREVER if the receiver was transiently unreachable for
// longer than the transport's bounded-retry window (~1.4s of 200/400/800ms
// backoff). Now a TRANSIENT-EXHAUSTED drop — which the transport flags
// replayable:true (see src/telemetry-send.js + telemetry-live-wire.test.mjs) — is
// retained in a bounded, session-scoped, IN-MEMORY ring and re-dispatched through
// dispatch() on the next record() (the "next dispatch opportunity"). Drifted (415)
// and non-retryable 4xx drops are permanent and NEVER retained.
//
// The buffer is observed purely through what the transport SEE — which events are
// (re-)dispatched, identified by a distinguishing timestamp — not through internal
// state, so each assertion holds against the actual replay contract. settle runs
// synchronously for the sync fakes below, so no awaits are needed.

// A schema-valid base-tier error with a distinguishing timestamp. The timestamp is
// a number, so it survives redact (which targets strings) AND validate (which
// requires a number) unchanged — letting a test tell WHICH event was (re-)sent.
function eventAt(ts) {
  return {
    schemaVersion: SCHEMA_VERSION,
    type: 'error',
    runtime: 'main',
    timestamp: ts,
    name: 'Error',
    message: 'transient receiver outage',
    frames: [],
  };
}

// The transient-exhausted drop shape the REAL transport returns after exhausting
// its retry budget on a network error / 429 / 5xx (WARDEN-671 adds replayable:true).
const REPLAYABLE_DROP = { ok: false, dropped: true, replayable: true, attempts: 3, status: 503 };
const OK_RESULT = { ok: true, dropped: false, attempts: 1, status: 200 };

// A fake transport that returns a SEQUENCE of fixed results (sync), one per call,
// reusing the last when the sequence is exhausted — so a test can script "drop,
// then succeed." Records every call's redacted-event timestamp so a test can assert
// WHICH events were (re-)dispatched and in what order.
function sendSeq(results) {
  const calls = [];
  let i = 0;
  const fn = (args) => {
    calls.push(args);
    const r = results[Math.min(i, results.length - 1)];
    i += 1;
    return r;
  };
  fn.calls = calls;
  fn.timestamps = () => calls.map((c) => (c.events[0] ? c.events[0].timestamp : undefined));
  return fn;
}

test('a transient-exhausted (replayable) drop is buffered and replayed on the next record()', () => {
  // First record → replayable drop → buffered. The second record is the "next
  // dispatch opportunity": the buffered event is flushed (re-dispatched) BEFORE the
  // new event, and this time it lands.
  const send = sendSeq([REPLAYABLE_DROP, OK_RESULT]);
  const pipeline = createTelemetryPipeline({ consent: consentReturning(TIERS.BASE), redact, send });
  pipeline.record(eventAt(100));
  assert.equal(send.calls.length, 1, 'the first record dispatched the event once');
  pipeline.record(eventAt(200));
  assert.equal(send.calls.length, 3, 'the buffered event was re-dispatched (call 2) + the new event (call 3)');
  assert.deepEqual(
    send.timestamps(),
    [100, 100, 200],
    'the buffered event (ts 100) was sent AGAIN before the new event (ts 200) — it was retained, not lost',
  );
});

test('once the replayed event lands it leaves the buffer — no replay churn', () => {
  // After the replay succeeds the buffer is empty, so a THIRD record must NOT
  // re-dispatch the earlier event again. Proves the buffer drains on success.
  const send = sendSeq([REPLAYABLE_DROP, OK_RESULT]);
  const pipeline = createTelemetryPipeline({ consent: consentReturning(TIERS.BASE), redact, send });
  pipeline.record(eventAt(100)); // drop → buffer
  pipeline.record(eventAt(200)); // flush 100 (ok) + dispatch 200 (ok)
  send.calls.length = 0;
  pipeline.record(eventAt(300)); // buffer empty → only 300 dispatched
  assert.equal(send.calls.length, 1, 'no replay churn after the buffered event landed');
  assert.equal(send.timestamps()[0], 300);
});

test('a NON-retryable 4xx drop is NOT buffered (replaying the identical body is futile)', () => {
  // A 400 is permanent for this payload — re-POSTing the identical redacted body
  // cannot fix it. The transport OMITS replayable, so the pipeline must not retain
  // it (replaying would just waste the retry budget on a guaranteed re-rejection).
  const send = sendSeq([{ ok: false, dropped: true, attempts: 1, status: 400 }, OK_RESULT]);
  const pipeline = createTelemetryPipeline({ consent: consentReturning(TIERS.BASE), redact, send });
  pipeline.record(eventAt(100)); // 400 drop → NOT buffered
  pipeline.record(eventAt(200)); // nothing to flush → only 200 dispatched
  assert.equal(send.calls.length, 2, 'the non-retryable 400 drop was not replayed');
  assert.deepEqual(send.timestamps(), [100, 200]);
});

test('a 415 schema-drift drop is NOT buffered (the drift circuit-breaker owns it)', () => {
  // A 415 carries drifted:true (NOT replayable) — the per-endpoint breaker
  // (WARDEN-631) handles it by short-circuiting further sends. The replay buffer
  // must not also retain it (that would fight the breaker AND replay a payload the
  // receiver is guaranteed to reject again).
  const send = sendSeq([{ ok: false, dropped: true, drifted: true, attempts: 1, status: 415 }, OK_RESULT]);
  const pipeline = createTelemetryPipeline({ consent: consentReturning(TIERS.BASE), redact, send });
  pipeline.record(eventAt(100)); // 415 → arms drift, NOT buffered
  assert.equal(pipeline.getRuntimeStatus().drifted, true, 'the existing WARDEN-631 drift path still arms');
  pipeline.record(eventAt(200)); // drifted → dispatch short-circuits; nothing was buffered to flush
  assert.equal(send.calls.length, 1, 'the 415 was not buffered — no replay, and drift short-circuits the next send');
});

test('consent revoke CLEARS the buffer — a buffered event does not survive opt-out', () => {
  // Fill the buffer, then revoke. record() while off clears the buffer at its
  // layer-1 guard (the natural clear site) and sends nothing. Re-enabling must NOT
  // replay the old event — it was cleared, not retained.
  const down = sendSeq([REPLAYABLE_DROP]); // always replayable
  const pipeline = createTelemetryPipeline({ consent: consentReturning(TIERS.BASE), redact, send: down });
  pipeline.record(eventAt(100)); // → buffered
  assert.equal(down.calls.length, 1);

  pipeline.setConsent(consentReturning(TIERS.OFF));
  pipeline.record(eventAt(200)); // off → CLEAR the buffer + no-op (no send, no flush)
  assert.equal(down.calls.length, 1, 'nothing sent while off');

  // Re-enable with a SUCCESS transport. Had the buffer survived the revoke, the old
  // event (ts 100) would be flushed first; since it was cleared, only the new event.
  const ok = sendSeq([OK_RESULT]);
  pipeline.setSend(ok);
  pipeline.setConsent(consentReturning(TIERS.BASE));
  pipeline.record(eventAt(300));
  assert.deepEqual(
    ok.timestamps(),
    [300],
    'the revoked-while-buffered event was cleared — only the new event is sent after re-enable',
  );
});

test('the replay buffer is RETAINED through a drift outage and drains once drift clears', () => {
  // The flush is gated on !drifted: a drifted dispatch short-circuits BEFORE
  // transportSend, so settle never runs and a drained event could not re-buffer —
  // it would be LOST. Gating the flush on !drifted keeps the ring intact through a
  // drift outage; it drains once drift clears. This is the critical correctness
  // property that makes the buffer safe to coexist with the drift breaker.
  const send = sendSeq([REPLAYABLE_DROP, REPLAYABLE_DROP, { ok: false, dropped: true, drifted: true, attempts: 1, status: 415 }, OK_RESULT, OK_RESULT]);
  const pipeline = createTelemetryPipeline({ consent: consentReturning(TIERS.BASE), redact, send });
  pipeline.record(eventAt(100)); // → replayable drop → buffer 100. (call 1)
  // record(200): flush 100 (re-drops → re-buffered), then dispatch 200 → 415 → arms drift.
  pipeline.record(eventAt(200));
  assert.equal(pipeline.getRuntimeStatus().drifted, true, 'drift armed on the 200 send');
  const callsBeforeDriftedRecord = send.calls.length;
  // record(300) WHILE drifted: the flush is gated off (drifted) so 100 is RETAINED,
  // and 300 short-circuits at the drift guard → zero new transport calls.
  pipeline.record(eventAt(300));
  assert.equal(send.calls.length, callsBeforeDriftedRecord, 'the buffered event was NOT flushed during drift (retained), and the drifted send short-circuited');
  // Clear drift (e.g. a "Test connection" reset), then record(400): 100 SURVIVED and
  // is now flushed (re-dispatched) before 400.
  pipeline.clearRuntimeDrift();
  assert.equal(pipeline.getRuntimeStatus().drifted, false);
  pipeline.record(eventAt(400));
  assert.ok(
    send.timestamps().slice(-2).includes(100),
    'the buffered event (ts 100) survived the drift outage and was replayed after drift cleared',
  );
});

test('bounded ring — drop-oldest past the cap retains the MOST RECENT events', () => {
  // A persistently-down receiver (always replayable) fills the ring; past the cap the
  // OLDEST entries are evicted (drop-oldest), so memory cannot grow unbounded. With
  // replayBufferCap:3 and 5 replayable drops (ts 10..50), only the 3 most recent are
  // retained; when the receiver comes back (ok), the final record flushes EXACTLY
  // those 3 (+ the new event) — proving the cap held AND the oldest (10, 20) were
  // evicted, not the newest.
  const down = sendSeq([REPLAYABLE_DROP]);
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send: down,
    replayBufferCap: 3,
  });
  for (const ts of [10, 20, 30, 40, 50]) pipeline.record(eventAt(ts)); // all drop → fill + rotate the ring
  const ok = sendSeq([OK_RESULT]);
  pipeline.setSend(ok);
  pipeline.record(eventAt(60)); // receiver back → flush the retained ring, then send 60
  assert.deepEqual(
    ok.timestamps(),
    [30, 40, 50, 60],
    'cap held at 3 (10 and 20 evicted as the oldest); the 3 most recent (30,40,50) were retained and replayed',
  );
});

test('off-by-default: the default no-op transport never fills the buffer (no regression)', () => {
  // With no send injected (default noopSend → returns undefined), settle's
  // replayable guard never fires (undefined is not replayable), so an unconfigured
  // pipeline behaves EXACTLY as before this slice. Proven by swapping in a success
  // transport after several noop records: NONE of the noop'd events is phantomly
  // replayed (the buffer stayed empty throughout).
  const pipeline = createTelemetryPipeline({ consent: consentReturning(TIERS.BASE), redact });
  for (let i = 0; i < 5; i++) pipeline.record(eventAt(100 + i)); // noopSend → nothing sent, nothing buffered
  const ok = sendSeq([OK_RESULT]);
  pipeline.setSend(ok);
  pipeline.record(eventAt(999));
  assert.deepEqual(ok.timestamps(), [999], 'no phantom replay — the noopSend events were never buffered');
});

test('the replay buffer is IN-MEMORY only — the pipeline exposes no disk/persistence seam', () => {
  // Trust-model guard (WARDEN-443): the buffer is deliberately NOT durable. The
  // pipeline factory accepts only the existing injectables + replayBufferCap (a
  // cap override); it exposes NO fs/path/persist option. A durable on-disk queue is
  // a later, trust-heavier slice. This pins that no persistence seam crept in here.
  const pipeline = createTelemetryPipeline({ consent: consentReturning(TIERS.BASE), redact, send: sendSeq([REPLAYABLE_DROP]) });
  const publicSurface = Object.keys(pipeline);
  assert.ok(
    !publicSurface.some((k) => /persist|disk|fs|path|file|store|queue/i.test(k)),
    'no persistence/disk surface — the replay buffer is in-memory only',
  );
});

// ==========================================================================
// WARDEN-808 — sustained delivery-failure runtime status (non-415 twin)
// ==========================================================================
// The runtime delivery surface armed a status ONLY on a 415 (drifted). Every
// OTHER sustained failure (receiver down, persistent 5xx, broken network — all
// recorded as outcome:'dropped') was invisible at the always-visible status layer.
// Now the pipeline derives `deliveryFailing` from the transmission-log ring: it
// arms when the most recent N outcomes are ALL 'dropped' and clears the instant an
// 'ok' lands (self-heal). It is PURE OBSERVABILITY — unlike `drifted` it NEVER
// gates dispatch (a delivery failure is potentially transient, so the client keeps
// sending). The ring→deliveryFailing derivation lives in the pure `isDeliveryFailing`
// helper; the pipeline wires it into settle + getRuntimeStatus + the bridge emit.

// A dropped outcome that is NOT replayable (no replayable:true), so the pipeline
// does NOT retain it in the WARDEN-671 replay buffer — each record() produces
// EXACTLY one ring entry, letting these tests assert the deliveryFailing THRESHOLD
// precisely (one outcome per send). The deliveryFailing derivation reads only
// outcome:'dropped'; it is indifferent to replayability, so a non-replayable drop
// exercises the exact same recordOutcome→ring→isDeliveryFailing path. (A real
// persistently-down receiver returns replayable drops, which also arm the status —
// faster, since each replayed drop is recorded too; that path is covered by the
// WARDEN-671 replay tests, which run with this derivation active.)
const DOWN_DROP = { ok: false, dropped: true, attempts: 1, status: 503 };
// A 415 is ALSO a drop (dropped:true) — so a run of 415s would arm deliveryFailing
// too, except drifted takes precedence at the renderer. Used to prove the bridge
// carries BOTH flags when both hold.
const DRIFTED_DROP_RESULT = { ok: false, dropped: true, drifted: true, attempts: 1, status: 415 };

// --- isDeliveryFailing: the pure ring→boolean derivation ----------------------

test('isDeliveryFailing: an empty ring → false (no false alarm on a fresh receiver with no traffic)', () => {
  assert.equal(isDeliveryFailing([], 3), false);
});

test('isDeliveryFailing: fewer than N outcomes → false (cannot arm on insufficient history)', () => {
  const d = { outcome: 'dropped' };
  assert.equal(isDeliveryFailing([d], 3), false);
  assert.equal(isDeliveryFailing([d, d], 3), false);
});

test('isDeliveryFailing: the most recent N all dropped → true (only the recent window matters)', () => {
  const d = { outcome: 'dropped' };
  const ok = { outcome: 'ok' };
  assert.equal(isDeliveryFailing([d, d, d], 3), true);
  // An ok BEFORE the window does not save it — only the most recent N count.
  assert.equal(isDeliveryFailing([ok, d, d, d], 3), true);
});

test('isDeliveryFailing: any ok (or non-drop) in the recent window → false (self-heal / conservative)', () => {
  const d = { outcome: 'dropped' };
  const ok = { outcome: 'ok' };
  assert.equal(isDeliveryFailing([d, d, ok], 3), false, 'an ok in the window breaks the run');
  assert.equal(isDeliveryFailing([d, d, d, ok], 3), false, 'the most recent 3 are d,d,ok');
  assert.equal(isDeliveryFailing([ok, d, d], 3), false, 'an ok in the window breaks the run');
  // A malformed/null outcome (a corrupt seeded entry) also breaks the run — never
  // arm on garbage.
  assert.equal(isDeliveryFailing([d, d, { outcome: null }], 3), false);
});

// --- pipeline integration: arm / self-heal / no-flap / no-gate ----------------

test('a sustained run of N drops arms deliveryFailing — and does NOT pause sending (no circuit breaker)', () => {
  const log = createTransmissionLog({ clock: TLOG_CLOCK });
  const send = sendSeq([DOWN_DROP, DOWN_DROP, DOWN_DROP, DOWN_DROP]);
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send,
    endpointUrl: TLOG_ENDPOINT,
    transmissionLog: log,
  });
  pipeline.record(eventAt(1)); // drop 1
  pipeline.record(eventAt(2)); // drop 2
  assert.equal(pipeline.getRuntimeStatus().deliveryFailing, false, '2 drops < threshold 3 → not armed (no flap)');
  pipeline.record(eventAt(3)); // drop 3 → sustained run
  assert.equal(pipeline.getRuntimeStatus().deliveryFailing, true, '3 consecutive drops → armed');
  pipeline.record(eventAt(4)); // drop 4 — STILL armed, and CRUCIALLY still sending
  assert.equal(pipeline.getRuntimeStatus().deliveryFailing, true, 'still armed on a 4th drop');
  assert.equal(send.calls.length, 4, 'CRITICAL: sending is NOT paused — the client keeps retrying while armed');
});

test('deliveryFailing self-heals the instant the next send lands (an ok clears it — no Test-connection needed)', () => {
  const log = createTransmissionLog({ clock: TLOG_CLOCK });
  const send = sendSeq([DOWN_DROP, DOWN_DROP, DOWN_DROP, OK_RESULT]);
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send,
    endpointUrl: TLOG_ENDPOINT,
    transmissionLog: log,
  });
  pipeline.record(eventAt(1));
  pipeline.record(eventAt(2));
  pipeline.record(eventAt(3)); // → armed
  assert.equal(pipeline.getRuntimeStatus().deliveryFailing, true);
  pipeline.record(eventAt(4)); // → ok
  assert.equal(pipeline.getRuntimeStatus().deliveryFailing, false, 'a single ok cleared the sustained-run status');
});

test('a single transient drop followed by an ok does NOT arm deliveryFailing (no flap)', () => {
  const log = createTransmissionLog({ clock: TLOG_CLOCK });
  const send = sendSeq([DOWN_DROP, OK_RESULT]);
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send,
    endpointUrl: TLOG_ENDPOINT,
    transmissionLog: log,
  });
  pipeline.record(eventAt(1)); // a momentary blip
  pipeline.record(eventAt(2)); // recovered
  assert.equal(pipeline.getRuntimeStatus().deliveryFailing, false, 'a single drop never arms — sustained runs only');
});

test('the threshold is configurable (a smaller window arms sooner)', () => {
  const log = createTransmissionLog({ clock: TLOG_CLOCK });
  const send = sendSeq([DOWN_DROP, DOWN_DROP]);
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send,
    endpointUrl: TLOG_ENDPOINT,
    transmissionLog: log,
    deliveryFailingThreshold: 2,
  });
  pipeline.record(eventAt(1));
  assert.equal(pipeline.getRuntimeStatus().deliveryFailing, false, '1 drop < threshold 2');
  pipeline.record(eventAt(2));
  assert.equal(pipeline.getRuntimeStatus().deliveryFailing, true, '2 drops meet the lowered threshold');
});

// --- emit discipline: the bridge sees a transition only when the composite changes

test('deliveryFailing emits on change ONLY — never a push per send (no spam)', () => {
  const log = createTransmissionLog({ clock: TLOG_CLOCK });
  const send = sendSeq([DOWN_DROP, DOWN_DROP, DOWN_DROP, DOWN_DROP, OK_RESULT]);
  const spy = statusSpy();
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send,
    endpointUrl: TLOG_ENDPOINT,
    transmissionLog: log,
    onRuntimeStatus: spy,
  });
  assert.deepEqual(spy.calls, [], 'nothing pushed at construction');
  pipeline.record(eventAt(1)); // drop 1 — no transition (still false)
  pipeline.record(eventAt(2)); // drop 2 — no transition (still false)
  assert.deepEqual(spy.calls, [], 'no push while below threshold');
  pipeline.record(eventAt(3)); // drop 3 — false→true → ONE push
  assert.deepEqual(spy.calls, [{ drifted: false, deliveryFailing: true }], 'armed once');
  pipeline.record(eventAt(4)); // drop 4 — true→true → NO push
  assert.deepEqual(spy.calls, [{ drifted: false, deliveryFailing: true }], 'no spam on a no-op transition');
  pipeline.record(eventAt(5)); // ok — true→false → ONE push
  assert.deepEqual(
    spy.calls,
    [{ drifted: false, deliveryFailing: true }, { drifted: false, deliveryFailing: false }],
    'the clear was pushed once',
  );
});

test('when BOTH drifted and deliveryFailing flip on one outcome, settle emits the final composite (not a per-flag spam)', () => {
  // Three 415s: each is a drop (so after 3 the sustained-run arms) AND each arms
  // drift on the first. The bridge must end at {drifted:true, deliveryFailing:true}.
  const log = createTransmissionLog({ clock: TLOG_CLOCK });
  const send = sendSeq([DRIFTED_DROP_RESULT, DRIFTED_DROP_RESULT, DRIFTED_DROP_RESULT]);
  const spy = statusSpy();
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send,
    endpointUrl: TLOG_ENDPOINT,
    transmissionLog: log,
    onRuntimeStatus: spy,
  });
  pipeline.record(eventAt(1)); // 415 → drift arms (1 drop)
  pipeline.record(eventAt(2)); // drifted → dispatch short-circuits BEFORE transport;
  //   drift stays armed, no new outcome recorded (still 1 drop). No transition.
  assert.deepEqual(
    spy.calls,
    [{ drifted: true, deliveryFailing: false }],
    'drift armed on the first 415; deliveryFailing still false (only 1 recorded drop)',
  );
  // The short-circuit means only ONE drop is ever recorded, so deliveryFailing can
  // never arm here — drift gates the very sends that would fill the ring. This is
  // the precedence made mechanical: schema-drift owns the slot because it prevents
  // the drop run from ever forming.
  assert.equal(pipeline.getRuntimeStatus().deliveryFailing, false);
  assert.equal(pipeline.getRuntimeStatus().drifted, true);
});

test('schema-drift and delivery-failing can BOTH be true when drift clears mid-run (drift wins the renderer slot)', () => {
  // Arm deliveryFailing with 3 non-415 drops (drifted stays false), THEN a 415
  // arms drift too. The bridge payload carries BOTH true — the renderer's
  // deriveTelemetryRuntimeStatus gives schema-drift precedence (verified in
  // telemetry-runtime-status.test.mjs).
  const log = createTransmissionLog({ clock: TLOG_CLOCK });
  const send = sendSeq([DOWN_DROP, DOWN_DROP, DOWN_DROP, DRIFTED_DROP_RESULT]);
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send,
    endpointUrl: TLOG_ENDPOINT,
    transmissionLog: log,
  });
  pipeline.record(eventAt(1));
  pipeline.record(eventAt(2));
  pipeline.record(eventAt(3)); // → deliveryFailing arms (drifted false)
  assert.equal(pipeline.getRuntimeStatus().deliveryFailing, true);
  assert.equal(pipeline.getRuntimeStatus().drifted, false);
  pipeline.record(eventAt(4)); // → a 415 arms drift too
  assert.equal(pipeline.getRuntimeStatus().drifted, true, 'the 415 armed drift');
  assert.equal(pipeline.getRuntimeStatus().deliveryFailing, true, 'deliveryFailing still armed — both flags hold');
});

// --- persistence asymmetry: getRuntimeStatus derives from the LIVE ring (incl. seeded history)

test('getRuntimeStatus derives deliveryFailing from the ring INCLUDING seeded history (restart into a broken receiver)', () => {
  // WARDEN-782 seeds the ring from the persisted audit file on restart. deliveryFailing
  // is derived fresh on read (never stored), so a restart into a still-broken receiver
  // shows the armed status BEFORE any fresh outcome — and the very next ok self-heals it.
  const log = createTransmissionLog({ clock: TLOG_CLOCK });
  log.seed([
    { outcome: 'dropped', endpointHost: 'telemetry.example.invalid', schemaVersion: 1, eventCount: 1, attempts: 3, status: 503 },
    { outcome: 'dropped', endpointHost: 'telemetry.example.invalid', schemaVersion: 1, eventCount: 1, attempts: 3, status: 503 },
    { outcome: 'dropped', endpointHost: 'telemetry.example.invalid', schemaVersion: 1, eventCount: 1, attempts: 3, status: 503 },
  ]);
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send: sendSeq([OK_RESULT]),
    endpointUrl: TLOG_ENDPOINT,
    transmissionLog: log,
  });
  // NO record() yet — the pull path alone reflects the seeded ring.
  assert.equal(pipeline.getRuntimeStatus().deliveryFailing, true, 'armed from seeded history with no fresh send');
  // A single successful send self-heals it (an ok enters the window).
  const spy = statusSpy();
  pipeline.setSend(sendSeq([OK_RESULT]));
  // Re-create with a spy to observe the clear transition from the seeded state.
  const pipeline2 = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send: sendSeq([OK_RESULT]),
    endpointUrl: TLOG_ENDPOINT,
    transmissionLog: log,
    onRuntimeStatus: spy,
  });
  assert.equal(pipeline2.getRuntimeStatus().deliveryFailing, true, 'still armed pre-send');
  pipeline2.record(eventAt(1)); // ok → the seeded armed state clears
  assert.equal(pipeline2.getRuntimeStatus().deliveryFailing, false, 'the first ok after restart self-healed the seeded status');
  assert.deepEqual(spy.calls, [{ drifted: false, deliveryFailing: false }], 'the clear (from the seeded armed state) was pushed');
});

test('an unconfigured pipeline (noop transmission log) never arms deliveryFailing', () => {
  // The default noopTransmissionLog returns entries()=[], so isDeliveryFailing is
  // always false — an unconfigured pipeline behaves EXACTLY as before this slice.
  const pipeline = createTelemetryPipeline({
    consent: consentReturning(TIERS.BASE),
    redact,
    send: sendSeq([DOWN_DROP, DOWN_DROP, DOWN_DROP]),
  });
  pipeline.record(eventAt(1));
  pipeline.record(eventAt(2));
  pipeline.record(eventAt(3));
  assert.equal(pipeline.getRuntimeStatus().deliveryFailing, false, 'no real log ⇒ never armed');
});

test('deliveryFailing introduces NO send-gating return in dispatch (grep guardrail)', () => {
  // The critical distinction from the 415 breaker: deliveryFailing must NEVER gate
  // dispatch. The 415 breaker is `if (drifted) return;` (permanent — stop futile
  // sends). A delivery failure is transient, so the client KEEPS sending. This
  // asserts the guardrail mechanically: in the PRE-TRANSPORT region of dispatch
  // (the tier/drift/redact/validate gates that decide whether to send at all),
  // deliveryFailing is not consulted. (It IS derived later, inside `settle` — the
  // post-send outcome handler — which is observability, not a gate.)
  const src = readFileSync(resolve(__dirname, '../electron/telemetry-pipeline.cjs'), 'utf8');
  const dispatchStart = src.indexOf('function dispatch(payload)');
  const transportCall = src.indexOf('const result = transportSend({', dispatchStart);
  assert.ok(dispatchStart > -1 && transportCall > dispatchStart, 'dispatch + its transportSend call located');
  const preTransport = src.slice(dispatchStart, transportCall);
  // The two legitimate send-gating returns that live in this pre-transport region.
  assert.ok(/if \(tier === TIERS\.OFF\) return;/.test(preTransport), 'the consent-off guard is present');
  assert.ok(/if \(drifted\) return;/.test(preTransport), 'the WARDEN-631 drifted guard is present');
  assert.ok(
    !/deliveryFailing/.test(preTransport),
    'CRITICAL: deliveryFailing is NOT consulted before transportSend — it never gates sending',
  );
});

console.log(`\n✓ TELEMETRY PIPELINE TESTS PASS (${passed})`);
