import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  sendWebhook,
  makeWebhookPayload,
  dispatchWebhook,
  diffAttentionTransitions,
  diffDoneTransitions,
  attentionSeverity,
  attentionReason,
  doneSeverity,
  doneReason,
  doneEndedIdentity,
  _INTERNALS,
} from './notify.js';

// Webhook push transport unit suite (WARDEN-555). All network + sleep is
// injected — ZERO real network calls, ZERO real milliseconds. Mirrors
// src/telemetry-send.test.js's recorder pattern exactly. Each acceptance-
// criterion letter in the ticket maps to a describe block below.

const URL = 'https://ntfy.example.selfhosted.net/warden-alerts';
const SECRET = 'sec_abcdef123456';
const NOW = 1_700_000_000_000;

// fetch mock serving a fixed response sequence (one per call). Each response is
// { ok, status } (the transport reads only those) or { throw: err } for a
// network blip. Records every call's { url, opts } so tests assert destination/
// method/headers/body. Reuses the last response if called more times than
// provided (handy for "always 503" exhaustion cases) — but every exhaustion test
// also pins the call count so over-serving can't mask a runaway loop.
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

// A fetch mock that FAILS the test if ever called — for the disabled/empty-URL
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

describe('makeWebhookPayload — the pure wire-payload seam', () => {
  it('sets the Content-Type header', () => {
    const { headers } = makeWebhookPayload({ event: 'test', severity: 'info', ts: NOW });
    assert.strictEqual(headers['content-type'], 'application/json');
  });

  it('produces the { app, event, severity, agent, reason, ts } JSON body', () => {
    const { body } = makeWebhookPayload({
      event: 'attention-erroring',
      severity: 'critical',
      agent: 'worker on payments',
      reason: 'Erroring: TypeError: x is not a function',
      ts: NOW,
    });
    const parsed = JSON.parse(body);
    assert.strictEqual(parsed.app, 'warden');
    assert.strictEqual(parsed.event, 'attention-erroring');
    assert.strictEqual(parsed.severity, 'critical');
    assert.strictEqual(parsed.agent, 'worker on payments');
    assert.strictEqual(parsed.reason, 'Erroring: TypeError: x is not a function');
    assert.strictEqual(parsed.ts, NOW);
  });

  it('carries no signing secret in the body or base headers (secret is added at send time)', () => {
    const { headers, body } = makeWebhookPayload({ event: 'test', ts: NOW, reason: 'x' });
    const blob = JSON.stringify(headers) + body;
    assert.ok(!blob.includes(SECRET), 'no secret leaks into the payload seam');
    assert.ok(!/authorization|x-webhook-secret/i.test(JSON.stringify(headers)), 'no signing header at the pure seam');
  });

  it('does not embed any hardcoded SaaS host in headers or body', () => {
    const { headers, body } = makeWebhookPayload({ event: 'test', ts: NOW, reason: 'x' });
    const blob = JSON.stringify(headers) + body;
    assert.ok(!/hooks\.slack|discord\.com\/api\/webhooks|ntfy\.sh|api\.telegram|yatfa\.com/i.test(blob), 'no third-party SaaS host anywhere');
  });
});

describe('(a) empty url → zero fetchImpl calls', () => {
  it('no-ops (no fetch) when url is an empty string', async () => {
    const fetchImpl = fetchMustNotBeCalled();
    const sleep = sleepRec();
    const r = await sendWebhook({ event: 'test', enabled: true, url: '', secret: SECRET, fetchImpl, sleepImpl: sleep.fn });
    assert.strictEqual(fetchImpl.count(), 0, 'never called — gate closed by empty url');
    assert.deepStrictEqual(r, { ok: false, dropped: false, attempts: 0, status: null });
    assert.strictEqual(sleep.count(), 0);
  });

  it('no-ops when url is null/undefined (unconfigured default)', async () => {
    for (const url of [null, undefined]) {
      const fetchImpl = fetchMustNotBeCalled();
      const r = await sendWebhook({ event: 'test', enabled: true, url, secret: SECRET, fetchImpl });
      assert.deepStrictEqual(r, { ok: false, dropped: false, attempts: 0, status: null });
    }
  });
});

describe('(b) disabled → zero fetchImpl calls', () => {
  for (const enabled of [false, null, undefined]) {
    it(`no-ops (no fetch) when enabled is ${enabled}`, async () => {
      const fetchImpl = fetchMustNotBeCalled();
      const sleep = sleepRec();
      const r = await sendWebhook({ event: 'test', enabled, url: URL, secret: SECRET, fetchImpl, sleepImpl: sleep.fn });
      assert.deepStrictEqual(r, { ok: false, dropped: false, attempts: 0, status: null });
      assert.strictEqual(sleep.count(), 0);
    });
  }
});

describe('(c) enabled + url set → exactly ONE POST with signing headers + JSON body', () => {
  it('POSTs once to the url, 2xx, with Authorization + X-Webhook-Secret headers and the alert body', async () => {
    const fetchImpl = fetchSeq([{ ok: true, status: 200 }]);
    const sleep = sleepRec();
    const r = await sendWebhook({
      event: 'attention-waiting', severity: 'warning', agent: 'planner', reason: 'Waiting for your input',
      enabled: true, url: URL, secret: SECRET, ts: NOW, fetchImpl, sleepImpl: sleep.fn,
    });

    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.attempts, 1);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(fetchImpl.count(), 1, 'exactly one POST on the happy path');
    assert.strictEqual(sleep.count(), 0, 'no backoff on success');

    const { url, opts } = fetchImpl.calls[0];
    assert.strictEqual(url, URL, 'destination is exactly the configured url');
    assert.strictEqual(opts.method, 'POST');
    assert.strictEqual(opts.headers['content-type'], 'application/json');
    assert.strictEqual(opts.headers.authorization, `Bearer ${SECRET}`, 'Bearer signing header present');
    assert.strictEqual(opts.headers['x-webhook-secret'], SECRET, 'X-Webhook-Secret signing header present');
    const body = JSON.parse(opts.body);
    assert.strictEqual(body.app, 'warden');
    assert.strictEqual(body.event, 'attention-waiting');
    assert.strictEqual(body.severity, 'warning');
    assert.strictEqual(body.agent, 'planner');
    assert.strictEqual(body.reason, 'Waiting for your input');
    assert.strictEqual(body.ts, NOW);
  });

  it('omits signing headers entirely when no secret is configured', async () => {
    const fetchImpl = fetchSeq([{ ok: true, status: 200 }]);
    await sendWebhook({ event: 'test', enabled: true, url: URL, ts: NOW, fetchImpl });
    const opts = fetchImpl.calls[0].opts;
    assert.ok(!('authorization' in opts.headers), 'no Authorization header without a secret');
    assert.ok(!('x-webhook-secret' in opts.headers), 'no X-Webhook-Secret header without a secret');
  });

  it('treats any 2xx as success (e.g. 201 Created)', async () => {
    const fetchImpl = fetchSeq([{ ok: true, status: 201 }]);
    const r = await sendWebhook({ event: 'test', enabled: true, url: URL, ts: NOW, fetchImpl });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.status, 201);
    assert.strictEqual(fetchImpl.count(), 1);
  });
});

describe('(g) destination is exactly the configured url, never a hardcoded SaaS host', () => {
  it('every fetch call targets url verbatim (no rewrite, no hardcoded host)', async () => {
    const fetchImpl = fetchSeq([
      { ok: false, status: 503 },
      { ok: false, status: 503 },
      { ok: true, status: 200 },
    ]);
    await sendWebhook({ event: 'test', enabled: true, url: URL, ts: NOW, fetchImpl, sleepImpl: sleepRec().fn });
    assert.ok(fetchImpl.count() >= 1);
    for (const c of fetchImpl.calls) {
      assert.strictEqual(c.url, URL, 'every attempt hits exactly the configured url');
    }
  });

  it('honors an arbitrary user-configured URL (ntfy / Discord / Slack / self-hosted)', async () => {
    for (const custom of [
      'https://ntfy.sh/my-secret-topic',
      'http://homeassistant.local:8123/api/webhook/warden',
      'https://discord.com/api/webhooks/123/abc',
    ]) {
      const fetchImpl = fetchSeq([{ ok: true, status: 200 }]);
      await sendWebhook({ event: 'test', enabled: true, url: custom, ts: NOW, fetchImpl });
      assert.strictEqual(fetchImpl.calls[0].url, custom);
    }
  });
});

describe('(d) transient failure → retried ≤ cap with backoff then dropped; never loops', () => {
  it('retries a 503 up to the cap then drops (attempts == MAX_ATTEMPTS, never more)', async () => {
    const fetchImpl = fetchSeq([{ ok: false, status: 503 }]); // always 503
    const sleep = sleepRec();
    const r = await sendWebhook({ event: 'test', enabled: true, url: URL, ts: NOW, fetchImpl, sleepImpl: sleep.fn });

    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.dropped, true);
    assert.strictEqual(r.status, 503);
    assert.strictEqual(r.attempts, _INTERNALS.MAX_ATTEMPTS, 'bounded — stops exactly at the cap');
    assert.ok(fetchImpl.count() <= _INTERNALS.MAX_ATTEMPTS, 'never exceeds the cap (no infinite loop)');
    // Backoff fires BETWEEN attempts: 3 attempts → 2 sleeps, never after the last.
    assert.strictEqual(sleep.count(), _INTERNALS.MAX_ATTEMPTS - 1, 'backoff slept once per retry, not after the final attempt');
  });

  it('retries a network error (fetch throws) up to the cap then drops', async () => {
    const fetchImpl = fetchSeq([{ throw: new Error('fetch failed: ECONNRESET') }]);
    const sleep = sleepRec();
    const r = await sendWebhook({ event: 'test', enabled: true, url: URL, ts: NOW, fetchImpl, sleepImpl: sleep.fn });

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
    const r = await sendWebhook({ event: 'test', enabled: true, url: URL, ts: NOW, fetchImpl, sleepImpl: sleep.fn });

    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.attempts, 2);
    assert.strictEqual(sleep.count(), 1, 'one backoff between the two attempts');
  });

  it('caps attempts at 3 even when 503s would otherwise loop forever (bounded)', async () => {
    const fetchImpl = fetchSeq(Array.from({ length: 20 }, () => ({ ok: false, status: 503 })));
    const r = await sendWebhook({ event: 'test', enabled: true, url: URL, ts: NOW, fetchImpl, sleepImpl: sleepRec().fn });
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
    const r = await sendWebhook({ event: 'test', enabled: true, url: URL, ts: NOW, fetchImpl, sleepImpl: sleep.fn });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.attempts, 2);
    assert.strictEqual(sleep.count(), 1, '429 backed off once before the retry');
  });
});

describe('(e) non-retryable 4xx (≠429) → no retry, alert dropped', () => {
  for (const status of [400, 401, 403, 404, 410, 422]) {
    it(`fails fast on ${status}: one attempt, dropped, NO backoff`, async () => {
      const fetchImpl = fetchSeq([{ ok: false, status }]);
      const sleep = sleepRec();
      const r = await sendWebhook({ event: 'test', enabled: true, url: URL, ts: NOW, fetchImpl, sleepImpl: sleep.fn });

      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.dropped, true, '4xx drops the alert');
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
    const r = await sendWebhook({ event: 'test', enabled: true, url: URL, ts: NOW, fetchImpl, sleepImpl: sleepRec().fn });
    assert.strictEqual(r.dropped, true);
  });

  it('resolves (not rejects) on a non-retryable 4xx', async () => {
    const fetchImpl = fetchSeq([{ ok: false, status: 400 }]);
    const r = await sendWebhook({ event: 'test', enabled: true, url: URL, ts: NOW, fetchImpl });
    assert.strictEqual(r.dropped, true);
  });

  it('resolves (not rejects) when fetch always throws a network error', async () => {
    const fetchImpl = fetchSeq([{ throw: new Error('fetch failed: ENOTFOUND') }]);
    const r = await sendWebhook({ event: 'test', enabled: true, url: URL, ts: NOW, fetchImpl, sleepImpl: sleepRec().fn });
    assert.strictEqual(r.dropped, true);
  });
});

describe('dispatchWebhook — config-reading wrapper', () => {
  it('reads enabled/url/secret off cfg and delegates to sendWebhook', async () => {
    const fetchImpl = fetchSeq([{ ok: true, status: 200 }]);
    const r = await dispatchWebhook({
      event: 'budget-breached', severity: 'critical', agent: 'fleet', reason: 'over budget',
      cfg: { webhookEnabled: true, webhookUrl: URL, webhookSecret: SECRET },
      now: NOW, fetchImpl,
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(fetchImpl.calls[0].url, URL);
    assert.strictEqual(fetchImpl.calls[0].opts.headers.authorization, `Bearer ${SECRET}`);
    assert.strictEqual(JSON.parse(fetchImpl.calls[0].opts.body).event, 'budget-breached');
  });

  it('no-ops when cfg.webhookEnabled is false (the auto-dispatch gate)', async () => {
    const fetchImpl = fetchMustNotBeCalled();
    const r = await dispatchWebhook({
      event: 'test', cfg: { webhookEnabled: false, webhookUrl: URL, webhookSecret: SECRET }, now: NOW, fetchImpl,
    });
    assert.deepStrictEqual(r, { ok: false, dropped: false, attempts: 0, status: null });
  });

  it('no-ops when cfg.webhookUrl is empty (unconfigured)', async () => {
    const fetchImpl = fetchMustNotBeCalled();
    const r = await dispatchWebhook({
      event: 'test', cfg: { webhookEnabled: true, webhookUrl: '', webhookSecret: SECRET }, now: NOW, fetchImpl,
    });
    assert.deepStrictEqual(r, { ok: false, dropped: false, attempts: 0, status: null });
  });

  it('enabled must be strictly true (a missing/truthy-non-boolean does not send)', async () => {
    const fetchImpl = fetchMustNotBeCalled();
    // webhookEnabled missing entirely → treated as off (defensive; the field is a boolean).
    await dispatchWebhook({ event: 'test', cfg: { webhookUrl: URL }, now: NOW, fetchImpl });
    assert.strictEqual(fetchImpl.count(), 0);
  });
});

describe('diffAttentionTransitions — the pure newly-needy diff', () => {
  it('baseline-primed: an empty prevStates (first sweep) fires nothing', () => {
    const agents = [{ key: 'a', state: 'erroring', signal: 'boom', name: 'worker' }];
    assert.deepStrictEqual(diffAttentionTransitions(new Map(), agents), []);
    assert.deepStrictEqual(diffAttentionTransitions(null, agents), []);
  });

  it('fires on a transition from a non-attention state into an attention state', () => {
    const prev = new Map([['a', 'active'], ['b', 'idle']]);
    const agents = [
      { key: 'a', state: 'erroring', signal: 'TypeError', name: 'worker', host: 'h1' },
      { key: 'b', state: 'idle', signal: null, name: 'reviewer', host: 'h1' },
    ];
    const out = diffAttentionTransitions(prev, agents);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].key, 'a');
    assert.strictEqual(out[0].state, 'erroring');
    assert.strictEqual(out[0].signal, 'TypeError');
  });

  it('fires on a NEWLY-seen key that is already in an attention state', () => {
    const prev = new Map([['a', 'active']]);
    const agents = [
      { key: 'a', state: 'active' },
      { key: 'new', state: 'waiting', signal: 'press enter', name: 'planner' },
    ];
    const out = diffAttentionTransitions(prev, agents);
    assert.deepStrictEqual(out.map((t) => t.key), ['new']);
  });

  it('does NOT re-fire for an agent already in an attention state (waiting → erroring is not new)', () => {
    const prev = new Map([['a', 'waiting']]);
    const agents = [{ key: 'a', state: 'erroring', signal: 'boom' }];
    assert.deepStrictEqual(diffAttentionTransitions(prev, agents), []);
  });

  it('re-arms after recovery: attention → idle → attention fires again', () => {
    // sweep 1: priming (empty prev) → seed, no fire
    let prev = new Map();
    const sweep1 = [{ key: 'a', state: 'erroring', signal: 'boom' }];
    assert.deepStrictEqual(diffAttentionTransitions(prev, sweep1), []);
    prev = new Map(sweep1.map((a) => [a.key, a.state]));
    // sweep 2: recovered to idle → no fire, prev now idle
    const sweep2 = [{ key: 'a', state: 'idle' }];
    assert.deepStrictEqual(diffAttentionTransitions(prev, sweep2), []);
    prev = new Map(sweep2.map((a) => [a.key, a.state]));
    // sweep 3: erroring AGAIN → fires (was idle last sweep)
    const sweep3 = [{ key: 'a', state: 'erroring', signal: 'boom2' }];
    const out = diffAttentionTransitions(prev, sweep3);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].signal, 'boom2');
  });

  it('ignores active / idle / capture_failed states and non-string states', () => {
    const prev = new Map([['a', 'active']]);
    const agents = [
      { key: 'a', state: 'active' },
      { key: 'b', state: 'idle' },
      { key: 'c', state: 'capture_failed' },
      { key: 'd', state: undefined },
    ];
    assert.deepStrictEqual(diffAttentionTransitions(prev, agents), []);
  });

  it('handles all four attention states', () => {
    const prev = new Map([['s', 'idle'], ['e', 'idle'], ['w', 'idle'], ['b', 'idle']]);
    const agents = [
      { key: 's', state: 'stuck', signal: 'loop' },
      { key: 'e', state: 'erroring', signal: 'err' },
      { key: 'w', state: 'waiting', signal: 'press enter' },
      { key: 'b', state: 'blocked', signal: 'depends on' },
    ];
    const out = diffAttentionTransitions(prev, agents);
    assert.deepStrictEqual(out.map((t) => t.state).sort(), ['blocked', 'erroring', 'stuck', 'waiting']);
  });
});

describe('attentionSeverity / attentionReason — formatting helpers', () => {
  it('maps broken states to critical and needs-human states to warning', () => {
    assert.strictEqual(attentionSeverity('stuck'), 'critical');
    assert.strictEqual(attentionSeverity('erroring'), 'critical');
    assert.strictEqual(attentionSeverity('waiting'), 'warning');
    assert.strictEqual(attentionSeverity('blocked'), 'warning');
  });

  it('builds a one-line reason, appending the signal when present', () => {
    assert.strictEqual(attentionReason('waiting', 'press enter to continue'), 'Waiting for your input: press enter to continue');
    assert.strictEqual(attentionReason('erroring', null), 'Erroring');
    assert.strictEqual(attentionReason('stuck', '  '), 'Stuck (repeating output)');
    assert.strictEqual(attentionReason('blocked', 'waiting for the reviewer'), 'Blocked on a dependency: waiting for the reviewer');
  });
});

describe('diffDoneTransitions — the pure positive "finished" diff (WARDEN-575)', () => {
  it('baseline-primed: an empty prevStates (first sweep) fires nothing', () => {
    const agents = [{ key: 'a', state: 'idle', signal: null, name: 'worker' }];
    assert.deepStrictEqual(diffDoneTransitions(new Map(), agents), []);
    assert.deepStrictEqual(diffDoneTransitions(null, agents), []);
  });

  it('fires on active→idle after sustained recent activity (the primary completion signal)', () => {
    const prev = new Map([['a', 'active'], ['b', 'idle']]);
    const agents = [
      { key: 'a', state: 'idle', signal: null, name: 'worker', host: 'h1' },
      { key: 'b', state: 'idle', signal: null, name: 'reviewer', host: 'h1' },
    ];
    const out = diffDoneTransitions(prev, agents);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].key, 'a');
    assert.strictEqual(out[0].state, 'done');
    assert.strictEqual(out[0].name, 'worker');
    assert.strictEqual(out[0].host, 'h1');
  });

  it('fires on a working→idle flip for every working state, not just active', () => {
    // Mirrors chatWatch's WORKING_STATES: any of active/stuck/erroring/blocked/
    // waiting → idle is a "finished after needing attention" completion.
    const prev = new Map([
      ['a', 'active'], ['s', 'stuck'], ['e', 'erroring'], ['w', 'waiting'], ['b', 'blocked'],
    ]);
    const agents = [
      { key: 'a', state: 'idle' }, { key: 's', state: 'idle' }, { key: 'e', state: 'idle' },
      { key: 'w', state: 'idle' }, { key: 'b', state: 'idle' },
    ];
    const out = diffDoneTransitions(prev, agents);
    assert.deepStrictEqual(out.map((t) => t.key).sort(), ['a', 'b', 'e', 's', 'w']);
    for (const t of out) assert.strictEqual(t.state, 'done');
  });

  it('does NOT fire on idle→idle (dormant) or a newly-seen idle pane (no prior activity)', () => {
    const prev = new Map([['a', 'idle']]); // dormant last sweep
    const agents = [
      { key: 'a', state: 'idle' }, // idle→idle: dormant, no fire
      { key: 'new', state: 'idle' }, // newly seen, idle: no prior working activity, no fire
    ];
    assert.deepStrictEqual(diffDoneTransitions(prev, agents), []);
  });

  it('does NOT fire on absence (a working agent missing from the current sweep)', () => {
    // Absence is intentionally NOT treated as "finished" here — the attention sweep
    // is not carry-forward-protected, so a host blip / pane detach / capture_failed
    // must never read as a burst of done pings. A container GENUINELY ending is the
    // lifecycle sweep's SSH-cleaned agent_ended event, bridged separately in server.js.
    const prev = new Map([['a', 'active'], ['b', 'stuck']]);
    const agents = [{ key: 'c', state: 'idle' }]; // a + b absent this sweep
    assert.deepStrictEqual(diffDoneTransitions(prev, agents), []);
  });

  it('does NOT fire on recovery or no-change into a non-idle state', () => {
    const prev = new Map([['a', 'erroring'], ['b', 'active']]);
    const agents = [
      { key: 'a', state: 'active' }, // erroring→active (recovery, still working): no done fire
      { key: 'b', state: 'waiting' }, // active→waiting (still working): no done fire
    ];
    assert.deepStrictEqual(diffDoneTransitions(prev, agents), []);
  });

  it('re-arms after going active again: working→idle→active→idle fires on each finish', () => {
    let prev = new Map();
    // sweep 1: prime (active)
    const s1 = [{ key: 'a', state: 'active' }];
    assert.deepStrictEqual(diffDoneTransitions(prev, s1), []);
    prev = new Map(s1.map((a) => [a.key, a.state]));
    // sweep 2: active→idle → fires
    const s2 = [{ key: 'a', state: 'idle' }];
    assert.strictEqual(diffDoneTransitions(prev, s2).length, 1);
    prev = new Map(s2.map((a) => [a.key, a.state]));
    // sweep 3: idle→idle → no fire (dormant)
    assert.deepStrictEqual(diffDoneTransitions(prev, s2), []);
    prev = new Map(s2.map((a) => [a.key, a.state]));
    // sweep 4: idle→active (started again) → no done fire
    const s4 = [{ key: 'a', state: 'active' }];
    assert.deepStrictEqual(diffDoneTransitions(prev, s4), []);
    prev = new Map(s4.map((a) => [a.key, a.state]));
    // sweep 5: active→idle → fires again (re-armed)
    assert.strictEqual(diffDoneTransitions(prev, s2).length, 1);
  });
});

describe('doneSeverity / doneReason / doneEndedIdentity — positive formatting (WARDEN-575)', () => {
  it('doneSeverity is the non-alarming info tone (never critical/warning)', () => {
    assert.strictEqual(doneSeverity(), 'info');
  });

  it('doneReason uses the shared "Finished a task" wording, appending the signal when present', () => {
    assert.strictEqual(doneReason(null), 'Finished a task');
    assert.strictEqual(doneReason('  '), 'Finished a task');
    assert.strictEqual(doneReason('implemented WARDEN-575'), 'Finished a task: implemented WARDEN-575');
  });

  it('doneEndedIdentity derives an agent + reason from a lifecycle agent_ended event', () => {
    const event = { type: 'agent_ended', id: '(local):worker', host: '(local)', container: 'payments-worker', role: 'worker', project: 'payments' };
    const { agent, reason } = doneEndedIdentity(event);
    assert.strictEqual(agent, 'payments-worker', 'prefers the container (most pane-specific handle)');
    assert.ok(reason.includes('ended'), 'conveys the container-genuinely-ended signal');

    // No container → falls back to the unique id (host:session), NOT the generic
    // role/project which identify nothing on a phone ping.
    assert.strictEqual(doneEndedIdentity({ id: '(local):s1', project: 'billing', role: 'worker' }).agent, '(local):s1');
    assert.strictEqual(doneEndedIdentity({ id: 'only-id' }).agent, 'only-id');
  });

  it('DONE_WORKING_STATES is exactly the working set shared with the frontend watch subsystem', () => {
    assert.deepStrictEqual(
      [..._INTERNALS.DONE_WORKING_STATES].sort(),
      ['active', 'blocked', 'erroring', 'stuck', 'waiting'],
    );
  });
});
