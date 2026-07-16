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
