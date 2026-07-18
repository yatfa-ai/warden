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
} = require('../electron/telemetry-pipeline.cjs');
const { validateBaseEvent, buildErrorEvent } = require('../electron/telemetry-source.cjs');
const { createTransmissionLog } = require('../electron/telemetry-transmission-log.cjs');

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
  assert.equal(SCHEMA_VERSION, 2);
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
  assert.deepEqual(pipeline.getRuntimeStatus(), { drifted: false });
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
  assert.deepEqual(spy.calls, [{ drifted: true }]);
  pipeline.setEndpoint(ENDPOINT); // same url → no-op
  assert.deepEqual(spy.calls, [{ drifted: true }], 'same endpoint fires no clear');
  assert.equal(pipeline.getRuntimeStatus().drifted, true, 'breaker stays armed on a same-url re-apply');
  pipeline.setEndpoint('https://other.example/ingest'); // different → clears
  assert.deepEqual(spy.calls, [{ drifted: true }, { drifted: false }]);
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
  assert.deepEqual(spy.calls, [{ drifted: true }]);
  pipeline.record(DRIFT_EVENT()); // short-circuit → NO outcome → NO fire
  assert.deepEqual(spy.calls, [{ drifted: true }], 'a short-circuit does not re-fire');
  pipeline.setEndpoint('https://other.example/ingest'); // clear → fire
  assert.deepEqual(spy.calls, [{ drifted: true }, { drifted: false }]);
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
  assert.deepEqual(spy.calls, [{ drifted: true }]);
  pipeline.clearRuntimeDrift(); // user-driven clear (a 'connected' Test connection)
  assert.equal(pipeline.getRuntimeStatus().drifted, false, 'breaker cleared');
  assert.deepEqual(spy.calls, [{ drifted: true }, { drifted: false }], 'the clear was pushed');
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

console.log(`\n✓ TELEMETRY PIPELINE TESTS PASS (${passed})`);
