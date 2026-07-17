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
  assert.equal(SCHEMA_VERSION, 1);
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

console.log(`\n✓ TELEMETRY PIPELINE TESTS PASS (${passed})`);
