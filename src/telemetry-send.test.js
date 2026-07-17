import { describe, it } from 'node:test';
import assert from 'node:assert';
import { send, makePayload, _INTERNALS } from './telemetry-send.js';

// Telemetry transport unit suite (WARDEN-461). All network + sleep is injected —
// ZERO real network calls, ZERO real milliseconds. Each done-criterion letter in
// the ticket maps to a describe block below.

const EVENTS = [
  { type: 'error', id: 'evt-1', message: 'boom' },
  { type: 'perf', id: 'evt-2', kind: 'event-loop-stall', ms: 820 },
];
const ENDPOINT = 'https://telemetry.example.selfhosted.net/ingest';
const SCHEMA = '1';

// fetch mock serving a fixed response sequence (one per call). Each response is
// { ok, status } (the transport reads only those) or { throw: err } for a network
// blip. Records every call's { url, opts } so tests assert destination/method/
// headers/body. Reuses the last response if called more times than provided
// (handy for "always 503" exhaustion cases) — but every exhaustion test also
// pins the call count so over-serving can't mask a runaway loop.
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
  fn.count = () => i;
  return fn;
}

// sleep recorder — resolves instantly and records every ms it was asked to wait,
// so backoff tests assert "backoff happened N times" without real time passing.
function sleepRec() {
  const calls = [];
  const fn = (ms) => { calls.push(ms); return Promise.resolve(); };
  return { fn, calls, count: () => calls.length };
}

// A fetch mock that FAIL the test if ever called — for the consent/endpoint
// no-op gates, where "zero fetchImpl calls" is the success criterion.
function fetchMustNotBeCalled() {
  let count = 0;
  const fn = async () => {
    count++;
    throw new Error('fetchImpl must NOT be called from a gated no-op');
  };
  fn.count = () => count;
  return fn;
}

// isConsentActive sequence — returns one boolean per call (re-using the last when
// the sequence is exhausted), so a test can flip consent OFF mid-loop — e.g.
// consentSeq([true, false]) is "active for attempt 1, revoked before attempt 2" —
// the exact "user hits Off while telemetry struggles during backoff" case. Records
// every value it returned.
function consentSeq(values) {
  let i = 0;
  const calls = [];
  const fn = () => {
    const v = values[Math.min(i, values.length - 1)];
    calls.push(v);
    i++;
    return v;
  };
  fn.calls = calls;
  fn.count = () => i;
  return fn;
}

describe('makePayload — the pure wire-payload seam', () => {
  it('sets Content-Type and X-Telemetry-Schema headers', () => {
    const { headers } = makePayload({ schemaVersion: SCHEMA, events: EVENTS });
    assert.strictEqual(headers['content-type'], 'application/json');
    assert.strictEqual(headers['x-telemetry-schema'], SCHEMA);
  });

  it('stringifies the schema version into the header', () => {
    const { headers } = makePayload({ schemaVersion: 2, events: [] });
    assert.strictEqual(headers['x-telemetry-schema'], '2');
  });

  it('produces a JSON body envelope of { schemaVersion, events }', () => {
    const { body } = makePayload({ schemaVersion: SCHEMA, events: EVENTS });
    const parsed = JSON.parse(body);
    assert.strictEqual(parsed.schemaVersion, SCHEMA);
    assert.deepStrictEqual(parsed.events, EVENTS);
  });

  it('does not embed any hardcoded SaaS host in headers or body', () => {
    const { headers, body } = makePayload({ schemaVersion: SCHEMA, events: EVENTS });
    const blob = JSON.stringify(headers) + body;
    assert.ok(!/sentry|posthog|amplitude|mixpanel|segment/i.test(blob), 'no third-party SaaS host anywhere');
  });

  it('includes an Authorization: Bearer header IFF a non-empty authToken is passed (WARDEN-569)', () => {
    const token = 'shared-secret-token';
    const { headers } = makePayload({ schemaVersion: SCHEMA, events: EVENTS, authToken: token });
    assert.strictEqual(headers['authorization'], `Bearer ${token}`);
    // The schema handshake headers are untouched alongside the auth header.
    assert.strictEqual(headers['content-type'], 'application/json');
    assert.strictEqual(headers['x-telemetry-schema'], SCHEMA);
  });

  it('OMITS the Authorization header when authToken is empty (works against an open receiver)', () => {
    const { headers } = makePayload({ schemaVersion: SCHEMA, events: EVENTS, authToken: '' });
    assert.ok(!('authorization' in headers), 'no auth header for an empty token');
  });

  it('OMITS the Authorization header when authToken is omitted entirely (backward-compatible)', () => {
    const { headers } = makePayload({ schemaVersion: SCHEMA, events: EVENTS });
    assert.ok(!('authorization' in headers), 'no auth header when authToken is not supplied');
  });
});

describe('(a) empty endpointUrl → zero fetchImpl calls', () => {
  it('no-ops (no fetch) when endpointUrl is an empty string', async () => {
    const fetchImpl = fetchMustNotBeCalled();
    const sleep = sleepRec();
    const r = await send({ events: EVENTS, consent: true, endpointUrl: '', schemaVersion: SCHEMA, fetchImpl, sleepImpl: sleep.fn });
    assert.strictEqual(fetchImpl.count(), 0, 'never called — gate closed by empty endpoint');
    assert.deepStrictEqual(r, { ok: false, dropped: false, attempts: 0, status: null });
    assert.strictEqual(sleep.count(), 0);
  });

  it('no-ops when endpointUrl is null/undefined (unconfigured default)', async () => {
    for (const endpointUrl of [null, undefined]) {
      const fetchImpl = fetchMustNotBeCalled();
      const r = await send({ events: EVENTS, consent: true, endpointUrl, schemaVersion: SCHEMA, fetchImpl });
      assert.deepStrictEqual(r, { ok: false, dropped: false, attempts: 0, status: null });
    }
  });
});

describe('(b) consent off/revoked → zero fetchImpl calls', () => {
  for (const consent of [false, null, undefined]) {
    it(`no-ops (no fetch) when consent is ${consent}`, async () => {
      const fetchImpl = fetchMustNotBeCalled();
      const sleep = sleepRec();
      const r = await send({ events: EVENTS, consent, endpointUrl: ENDPOINT, schemaVersion: SCHEMA, fetchImpl, sleepImpl: sleep.fn });
      assert.deepStrictEqual(r, { ok: false, dropped: false, attempts: 0, status: null });
      assert.strictEqual(sleep.count(), 0);
    });
  }
});

describe('(c) consent on + endpoint set + valid events → exactly ONE POST with header + JSON body', () => {
  it('POSTs once to the endpoint, 2xx, with X-Telemetry-Schema header and the event body', async () => {
    const fetchImpl = fetchSeq([{ ok: true, status: 200 }]);
    const sleep = sleepRec();
    const r = await send({ events: EVENTS, consent: true, endpointUrl: ENDPOINT, schemaVersion: SCHEMA, fetchImpl, sleepImpl: sleep.fn });

    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.attempts, 1);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(fetchImpl.count(), 1, 'exactly one POST on the happy path');
    assert.strictEqual(sleep.count(), 0, 'no backoff on success');

    const { url, opts } = fetchImpl.calls[0];
    assert.strictEqual(url, ENDPOINT, 'destination is exactly the configured endpoint');
    assert.strictEqual(opts.method, 'POST');
    assert.strictEqual(opts.headers['content-type'], 'application/json');
    assert.strictEqual(opts.headers['x-telemetry-schema'], SCHEMA, 'schema-version handshake header present');
    const body = JSON.parse(opts.body);
    assert.strictEqual(body.schemaVersion, SCHEMA);
    assert.deepStrictEqual(body.events, EVENTS, 'the redacted events are POSTed as JSON');
  });

  it('treats any 2xx as success (e.g. 201 Accepted)', async () => {
    const fetchImpl = fetchSeq([{ ok: true, status: 201 }]);
    const r = await send({ events: EVENTS, consent: true, endpointUrl: ENDPOINT, schemaVersion: SCHEMA, fetchImpl });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.status, 201);
    assert.strictEqual(fetchImpl.count(), 1);
  });
});

describe('(WARDEN-569) authToken threads onto the wire as Authorization: Bearer', () => {
  it('send() with a non-empty authToken POSTs the Authorization: Bearer header', async () => {
    const token = 'shared-secret-token';
    const fetchImpl = fetchSeq([{ ok: true, status: 202 }]);
    const r = await send({ events: EVENTS, consent: true, endpointUrl: ENDPOINT, schemaVersion: SCHEMA, authToken: token, fetchImpl });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(fetchImpl.calls[0].opts.headers['authorization'], `Bearer ${token}`, 'bearer header on the wire');
  });

  it('send() with an empty authToken POSTs NO Authorization header (open-receiver compatible)', async () => {
    const fetchImpl = fetchSeq([{ ok: true, status: 202 }]);
    await send({ events: EVENTS, consent: true, endpointUrl: ENDPOINT, schemaVersion: SCHEMA, authToken: '', fetchImpl });
    assert.ok(!('authorization' in fetchImpl.calls[0].opts.headers), 'no auth header for an empty token');
  });

  it('send() with authToken omitted defaults to no Authorization header (backward-compatible)', async () => {
    const fetchImpl = fetchSeq([{ ok: true, status: 202 }]);
    await send({ events: EVENTS, consent: true, endpointUrl: ENDPOINT, schemaVersion: SCHEMA, fetchImpl });
    assert.ok(!('authorization' in fetchImpl.calls[0].opts.headers), 'omitting authToken sends no auth header');
  });

  it('a 401 (auth reject from the receiver) is a non-retryable drop — never loops', async () => {
    // The receiver's auth gate returns 401; 401 is a 4xx (not 429/5xx), so the
    // client DROPS the batch immediately on the first attempt — it does not burn
    // the retry budget looping a misconfigured token. (WARDEN-569 fail-closed.)
    const fetchImpl = fetchSeq([{ ok: false, status: 401 }, { ok: true, status: 200 }]);
    const sleep = sleepRec();
    const r = await send({ events: EVENTS, consent: true, endpointUrl: ENDPOINT, schemaVersion: SCHEMA, authToken: 'wrong', fetchImpl, sleepImpl: sleep.fn });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.dropped, true, '401 drops the batch (fail-closed), never retries');
    assert.strictEqual(r.attempts, 1, 'dropped on the first attempt — no retry loop');
    assert.strictEqual(fetchImpl.count(), 1, 'only one fetch; the second response was never consumed');
    assert.strictEqual(sleep.count(), 0, 'no backoff — 401 is not retried');
  });
});

describe('(g) destination is exactly the configured endpoint, never a hardcoded SaaS host', () => {
  it('every fetch call targets endpointUrl verbatim (no rewrite, no hardcoded host)', async () => {
    const fetchImpl = fetchSeq([
      { ok: false, status: 503 },
      { ok: false, status: 503 },
      { ok: true, status: 200 },
    ]);
    await send({ events: EVENTS, consent: true, endpointUrl: ENDPOINT, schemaVersion: SCHEMA, fetchImpl, sleepImpl: sleepRec().fn });
    assert.ok(fetchImpl.count() >= 1);
    for (const c of fetchImpl.calls) {
      assert.strictEqual(c.url, ENDPOINT, 'every attempt hits exactly the configured endpoint');
    }
  });

  it('honors an arbitrary user-configured URL (self-hostable receiver)', async () => {
    const custom = 'http://localhost:9999/telemetry'; // non-default, user-chosen
    const fetchImpl = fetchSeq([{ ok: true, status: 200 }]);
    await send({ events: EVENTS, consent: true, endpointUrl: custom, schemaVersion: SCHEMA, fetchImpl });
    assert.strictEqual(fetchImpl.calls[0].url, custom);
  });
});

describe('(d) transient failure → retried ≤ cap with backoff then dropped; never loops', () => {
  it('retries a 503 up to the cap then drops (attempts == MAX_ATTEMPTS, never more)', async () => {
    const fetchImpl = fetchSeq([{ ok: false, status: 503 }]); // always 503
    const sleep = sleepRec();
    const r = await send({ events: EVENTS, consent: true, endpointUrl: ENDPOINT, schemaVersion: SCHEMA, fetchImpl, sleepImpl: sleep.fn });

    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.dropped, true);
    assert.strictEqual(r.status, 503);
    assert.strictEqual(r.attempts, _INTERNALS.MAX_ATTEMPTS, 'bounded — stops exactly at the cap');
    assert.ok(fetchImpl.count() <= _INTERNALS.MAX_ATTEMPTS, 'never exceeds the cap (no infinite loop)');
    // Backoff fires BETWEEN attempts: 3 attempts → 2 sleeps, and never after the last.
    assert.strictEqual(sleep.count(), _INTERNALS.MAX_ATTEMPTS - 1, 'backoff slept once per retry, not after the final attempt');
  });

  it('retries a network error (fetch throws) up to the cap then drops', async () => {
    const fetchImpl = fetchSeq([{ throw: new Error('fetch failed: ECONNRESET') }]);
    const sleep = sleepRec();
    const r = await send({ events: EVENTS, consent: true, endpointUrl: ENDPOINT, schemaVersion: SCHEMA, fetchImpl, sleepImpl: sleep.fn });

    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.dropped, true);
    assert.strictEqual(r.status, null, 'no response status on a network error');
    assert.strictEqual(r.attempts, _INTERNALS.MAX_ATTEMPTS);
    assert.strictEqual(sleep.count(), _INTERNALS.MAX_ATTEMPTS - 1);
  });

  it('recovers after a transient then succeeds (503 → 200): backoff once, two attempts', async () => {
    const fetchImpl = fetchSeq([
      { ok: false, status: 503 },
      { ok: true, status: 200 },
    ]);
    const sleep = sleepRec();
    const r = await send({ events: EVENTS, consent: true, endpointUrl: ENDPOINT, schemaVersion: SCHEMA, fetchImpl, sleepImpl: sleep.fn });

    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.attempts, 2);
    assert.strictEqual(sleep.count(), 1, 'one backoff between the two attempts');
  });

  it('recovers after a network blip then succeeds (ECONNRESET → 200)', async () => {
    const fetchImpl = fetchSeq([
      { throw: new Error('fetch failed: ETIMEDOUT') },
      { ok: true, status: 200 },
    ]);
    const r = await send({ events: EVENTS, consent: true, endpointUrl: ENDPOINT, schemaVersion: SCHEMA, fetchImpl, sleepImpl: sleepRec().fn });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.attempts, 2);
  });

  it('caps attempts at 3 even when 503s would otherwise loop forever (bounded)', async () => {
    // The sequence over-serves 503s indefinitely; the transport MUST stop at the cap.
    const fetchImpl = fetchSeq(Array.from({ length: 20 }, () => ({ ok: false, status: 503 })));
    const r = await send({ events: EVENTS, consent: true, endpointUrl: ENDPOINT, schemaVersion: SCHEMA, fetchImpl, sleepImpl: sleepRec().fn });
    assert.strictEqual(fetchImpl.count(), _INTERNALS.MAX_ATTEMPTS, 'hard-stopped at the cap');
    assert.strictEqual(r.dropped, true);
  });
});

// (WARDEN-585) LIVE consent re-check INSIDE the retry loop. The entry gate checks
// consent ONCE with a snapshot; once past it, the bounded-retry loop used to call
// fetchImpl up to 3× with backoff sleeps and NO consent re-check — so a user who
// revoked telemetry during the backoff window could watch the in-flight batch POST
// anyway. send() now takes an optional isConsentActive() resolver, re-checked
// before every attempt (the first included, as defense-in-depth); a mid-loop revoke
// halts the batch cleanly — no further fetch, no further sleep — and returns a
// result DISTINGUISHABLE from a transient-exhaustion drop.
describe('(WARDEN-585) live consent re-check inside the retry loop', () => {
  it('revoking during a backoff sleep halts the batch: ZERO further fetchImpl AND zero further sleep', async () => {
    const fetchImpl = fetchSeq([{ ok: false, status: 503 }]); // always transient
    const sleep = sleepRec();
    // Active for attempt 1, then flipped OFF during the backoff before attempt 2.
    const isConsentActive = consentSeq([true, false]);
    const r = await send({ events: EVENTS, consent: true, endpointUrl: ENDPOINT, schemaVersion: SCHEMA, fetchImpl, sleepImpl: sleep.fn, isConsentActive });

    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.revoked, true, 'halted by revocation, not by exhaustion');
    assert.strictEqual(r.dropped, false, 'a revoked batch is NOT a drop');
    assert.strictEqual(r.attempts, 1, 'exactly one attempt happened before the revoke');
    assert.strictEqual(fetchImpl.count(), 1, 'no further fetchImpl call after the revoke');
    assert.strictEqual(sleep.count(), 1, 'only the backoff that was in flight; no further sleep after the revoke');
  });

  it('revoking before the FIRST attempt → zero fetchImpl (defense-in-depth: snapshot said yes, live says no)', async () => {
    const fetchImpl = fetchMustNotBeCalled();
    const sleep = sleepRec();
    // consent snapshot is true (passes the entry gate), but LIVE consent is OFF.
    const isConsentActive = consentSeq([false]);
    const r = await send({ events: EVENTS, consent: true, endpointUrl: ENDPOINT, schemaVersion: SCHEMA, fetchImpl, sleepImpl: sleep.fn, isConsentActive });

    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.revoked, true);
    assert.strictEqual(r.dropped, false);
    assert.strictEqual(r.attempts, 0, 'never attempted — revoked before the first fetchImpl');
    assert.strictEqual(fetchImpl.count(), 0);
    assert.strictEqual(sleep.count(), 0);
  });

  it('a revoked result is DISTINGUISHABLE from a transient-exhaustion drop', async () => {
    const sleep = () => Promise.resolve();
    // Same failing receiver (always 503). Left: consent holds → exhausted → dropped.
    // Right: consent flips off after attempt 1 → halted → revoked.
    const dropped = await send({ events: EVENTS, consent: true, endpointUrl: ENDPOINT, schemaVersion: SCHEMA, fetchImpl: fetchSeq([{ ok: false, status: 503 }]), sleepImpl: sleep });
    const revoked = await send({ events: EVENTS, consent: true, endpointUrl: ENDPOINT, schemaVersion: SCHEMA, fetchImpl: fetchSeq([{ ok: false, status: 503 }]), sleepImpl: sleep, isConsentActive: consentSeq([true, false]) });

    // Both are non-ok, but MUST differ: a drop discards a batch we gave up on; a
    // revoke halts a batch the user stopped. The flag keeps them distinct so a
    // revoked send is never mislabeled a drop (the WARDEN-583 transmission log can
    // eventually record "revoked before send" honestly).
    assert.strictEqual(dropped.ok, false);
    assert.strictEqual(revoked.ok, false);
    assert.strictEqual(dropped.dropped, true);
    assert.strictEqual(dropped.revoked, undefined, 'exhaustion carries no revoked flag');
    assert.strictEqual(revoked.revoked, true);
    assert.strictEqual(revoked.dropped, false, 'revoked is NOT mislabeled a drop');
    assert.notStrictEqual(dropped.dropped, revoked.dropped);
  });

  it('omitting isConsentActive (default → always active) leaves the retry loop unchanged', async () => {
    // Backward-compat: with no live resolver injected, the loop behaves exactly as
    // before — runs to exhaustion, drops, never revokes. Existing callers/tests
    // that do not pass isConsentActive are unaffected.
    const fetchImpl = fetchSeq([{ ok: false, status: 503 }]);
    const sleep = sleepRec();
    const r = await send({ events: EVENTS, consent: true, endpointUrl: ENDPOINT, schemaVersion: SCHEMA, fetchImpl, sleepImpl: sleep.fn });
    assert.strictEqual(r.revoked, undefined, 'default (no live resolver) never revokes');
    assert.strictEqual(r.dropped, true);
    assert.strictEqual(r.attempts, _INTERNALS.MAX_ATTEMPTS);
    assert.strictEqual(fetchImpl.count(), _INTERNALS.MAX_ATTEMPTS);
    assert.strictEqual(sleep.count(), _INTERNALS.MAX_ATTEMPTS - 1);
  });

  it('a successful send is unaffected when consent stays active throughout', async () => {
    const fetchImpl = fetchSeq([{ ok: true, status: 200 }]);
    const sleep = sleepRec();
    const isConsentActive = consentSeq([true]);
    const r = await send({ events: EVENTS, consent: true, endpointUrl: ENDPOINT, schemaVersion: SCHEMA, fetchImpl, sleepImpl: sleep.fn, isConsentActive });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.attempts, 1);
    assert.strictEqual(r.revoked, undefined);
    assert.strictEqual(fetchImpl.count(), 1);
  });
});

describe('(f) 429 → retried with backoff', () => {
  it('treats 429 as transient and retries, then succeeds', async () => {
    const fetchImpl = fetchSeq([
      { ok: false, status: 429 },
      { ok: true, status: 200 },
    ]);
    const sleep = sleepRec();
    const r = await send({ events: EVENTS, consent: true, endpointUrl: ENDPOINT, schemaVersion: SCHEMA, fetchImpl, sleepImpl: sleep.fn });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.attempts, 2);
    assert.strictEqual(sleep.count(), 1, '429 backed off once before the retry');
  });

  it('drops after exhausting retries on persistent 429 (does not spin)', async () => {
    const fetchImpl = fetchSeq([{ ok: false, status: 429 }]);
    const r = await send({ events: EVENTS, consent: true, endpointUrl: ENDPOINT, schemaVersion: SCHEMA, fetchImpl, sleepImpl: sleepRec().fn });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.dropped, true);
    assert.strictEqual(r.status, 429);
    assert.strictEqual(r.attempts, _INTERNALS.MAX_ATTEMPTS);
  });
});

describe('(e) non-retryable 4xx (≠429) → no retry, batch dropped', () => {
  for (const status of [400, 401, 403, 404, 422]) {
    it(`fails fast on ${status}: one attempt, dropped, NO backoff`, async () => {
      const fetchImpl = fetchSeq([{ ok: false, status }]);
      const sleep = sleepRec();
      const r = await send({ events: EVENTS, consent: true, endpointUrl: ENDPOINT, schemaVersion: SCHEMA, fetchImpl, sleepImpl: sleep.fn });

      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.dropped, true, '4xx drops the batch');
      assert.strictEqual(r.status, status);
      assert.strictEqual(r.attempts, 1, 'no retry on a permanent client error');
      assert.strictEqual(fetchImpl.count(), 1);
      assert.strictEqual(sleep.count(), 0, 'no backoff — fails immediately');
    });
  }
});

// (WARDEN-631) A 415 is a schema-version mismatch — a permanent rejection DISTINCT
// from a generic 4xx drop. The transport still DROPS the batch (the identical body
// + schema header would be rejected again, so it is not retried — same one attempt,
// no backoff as any other non-retryable 4xx), but it ALSO sets `drifted:true` so the
// pipeline can circuit-break further sends to this endpoint instead of silently
// losing every subsequent event to the same version mismatch. `drifted` is present
// ONLY on the 415 outcome; the other non-retryable 4xx (asserted above) leave it
// undefined, so the result shapes stay distinguishable end-to-end.
describe('(WARDEN-631) 415 schema-drift → dropped AND drifted:true (distinct signal)', () => {
  it('a 415 drops the batch AND sets drifted:true (one attempt, no backoff)', async () => {
    const fetchImpl = fetchSeq([{ ok: false, status: 415 }]);
    const sleep = sleepRec();
    const r = await send({ events: EVENTS, consent: true, endpointUrl: ENDPOINT, schemaVersion: SCHEMA, fetchImpl, sleepImpl: sleep.fn });

    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.dropped, true, 'a 415 still drops the bad batch');
    assert.strictEqual(r.drifted, true, 'a 415 sets the distinct drift flag');
    assert.strictEqual(r.status, 415);
    assert.strictEqual(r.attempts, 1, 'schema drift is non-retryable — one attempt only');
    assert.strictEqual(fetchImpl.count(), 1);
    assert.strictEqual(sleep.count(), 0, 'no backoff — 415 fails immediately like any non-retryable 4xx');
  });

  it('other non-retryable 4xx do NOT set drifted (the flag is 415-specific)', async () => {
    // 400/401/403/404/422 are generic drops — `drifted` is absent (undefined), so a
    // generic auth/route/validation failure is never misread as a schema mismatch.
    for (const status of [400, 401, 403, 404, 422]) {
      const fetchImpl = fetchSeq([{ ok: false, status }]);
      const r = await send({ events: EVENTS, consent: true, endpointUrl: ENDPOINT, schemaVersion: SCHEMA, fetchImpl });
      assert.strictEqual(r.drifted, undefined, `${status} carries no drift flag`);
      assert.strictEqual(r.dropped, true);
    }
  });

  it('a successful send, a transient, a revoke, and the gate no-op all leave drifted undefined', async () => {
    // success
    let r = await send({ events: EVENTS, consent: true, endpointUrl: ENDPOINT, schemaVersion: SCHEMA, fetchImpl: fetchSeq([{ ok: true, status: 200 }]) });
    assert.strictEqual(r.drifted, undefined, 'success is never drifted');
    // transient (will exhaust + drop)
    r = await send({ events: EVENTS, consent: true, endpointUrl: ENDPOINT, schemaVersion: SCHEMA, fetchImpl: fetchSeq([{ ok: false, status: 503 }]), sleepImpl: sleepRec().fn });
    assert.strictEqual(r.drifted, undefined, 'an exhausted-transient drop is not drift');
    assert.strictEqual(r.dropped, true);
    // revoke mid-loop
    r = await send({ events: EVENTS, consent: true, endpointUrl: ENDPOINT, schemaVersion: SCHEMA, fetchImpl: fetchSeq([{ ok: false, status: 503 }]), sleepImpl: sleepRec().fn, isConsentActive: consentSeq([true, false]) });
    assert.strictEqual(r.drifted, undefined, 'a revoke is not drift');
    assert.strictEqual(r.revoked, true);
    // gate no-op
    r = await send({ events: EVENTS, consent: false, endpointUrl: ENDPOINT, schemaVersion: SCHEMA, fetchImpl: fetchMustNotBeCalled() });
    assert.strictEqual(r.drifted, undefined, 'the gate no-op is not drift');
    assert.deepStrictEqual(r, { ok: false, dropped: false, attempts: 0, status: null }, 'the gate no-op shape is unchanged');
  });
});

describe('best-effort: a failed send NEVER throws to the caller', () => {
  it('resolves (not rejects) on exhausted transient retries', async () => {
    const fetchImpl = fetchSeq([{ ok: false, status: 503 }]);
    // No assert.rejects — send() must RESOLVE. A throw here would block the app.
    const r = await send({ events: EVENTS, consent: true, endpointUrl: ENDPOINT, schemaVersion: SCHEMA, fetchImpl, sleepImpl: sleepRec().fn });
    assert.strictEqual(r.dropped, true);
  });

  it('resolves (not rejects) on a non-retryable 4xx', async () => {
    const fetchImpl = fetchSeq([{ ok: false, status: 400 }]);
    const r = await send({ events: EVENTS, consent: true, endpointUrl: ENDPOINT, schemaVersion: SCHEMA, fetchImpl });
    assert.strictEqual(r.dropped, true);
  });

  it('resolves (not rejects) when fetch always throws a network error', async () => {
    const fetchImpl = fetchSeq([{ throw: new Error('fetch failed: ENOTFOUND') }]);
    const r = await send({ events: EVENTS, consent: true, endpointUrl: ENDPOINT, schemaVersion: SCHEMA, fetchImpl, sleepImpl: sleepRec().fn });
    assert.strictEqual(r.dropped, true);
  });
});

describe('backoff growth is exponential (interval increases per retry)', () => {
  it('sleeps in increasing order across the retry sequence', async () => {
    // Three 503s → two backoffs. base doubles per attempt so the second sleep is
    // larger than the first (jitter is bounded at ±25%, so ordering is stable).
    const fetchImpl = fetchSeq([{ ok: false, status: 503 }]);
    const sleep = sleepRec();
    await send({ events: EVENTS, consent: true, endpointUrl: ENDPOINT, schemaVersion: SCHEMA, fetchImpl, sleepImpl: sleep.fn });
    assert.ok(sleep.calls.length >= 2, 'need >=2 sleeps to assert growth');
    assert.ok(sleep.calls[1] > sleep.calls[0], `backoff grows: ${sleep.calls[1]} > ${sleep.calls[0]}`);
    assert.ok(sleep.calls[0] > 0, 'real backoff, not a zero wait');
  });
});
