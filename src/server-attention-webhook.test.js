import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Server-side attention sweep → webhook dispatch (WARDEN-555). Drives the REAL
// tickAttention with an injected pane source + a fetch recorder, so it exercises
// the full gate → diffAttentionTransitions → dispatchWebhook wiring with ZERO
// real pane capture and ZERO real network. The pure pieces (diffAttentionTransitions,
// dispatchWebhook, sendWebhook) are pinned in notify.test.js; this pins the
// INTEGRATION glue in server.js: the self-gate, the baseline-prime, the
// transition → dispatch field mapping, and the destination/headers on the wire.
//
// Same isolated-server pattern as server-config-webhook.test.js.

let httpServer;
let baseUrl;
let originalHome;
let tempHome;
let tickAttention;

const URL = 'https://ntfy.example.selfhosted.net/warden';
const SECRET = 'sec_testtoken99';

before(async () => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-attn-webhook-'));
  process.env.HOME = tempHome;
  const wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: [] }));

  ({ tickAttention } = await import('./server.js'));
  const { app } = await import('./server.js');
  httpServer = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    httpServer.once('listening', resolve);
    httpServer.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

after(async () => {
  // Disable the webhook channel so restartAttentionPoll clears the 60s attention
  // sweep interval. node v20 --test does NOT force-exit on a pending setInterval,
  // so leaving the channel enabled would hang the process after the suite.
  if (baseUrl) {
    try {
      await fetch(`${baseUrl}/api/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ webhookEnabled: false, webhookUrl: '' }),
      });
    } catch { /* best-effort teardown */ }
  }
  if (httpServer) await new Promise((r) => httpServer.close(r));
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
});

async function put(body) {
  const res = await fetch(`${baseUrl}/api/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.strictEqual(res.status, 200);
}

// fetch recorder — returns 2xx, records every call's { url, opts }.
function fetchRec() {
  const calls = [];
  const fn = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200 }; };
  fn.calls = calls;
  fn.count = () => calls.length;
  return fn;
}

// A pollAgentStates sequence: serves responses[index] on the index-th call, then
// the last thereafter. Each response is the agent-states row array tickAttention
// diffs. Used so sweep 1 primes (idle) and sweep 2 transitions (→ erroring).
function agentSeq(responses) {
  let i = 0;
  const fn = async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return r;
  };
  fn.count = () => i;
  return fn;
}

// Flush the fire-and-forget dispatchWebhook microtask chain (tickAttention does
// not await it) so the recorder has observed the POST before we assert.
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

const STUB_CHATS = [{ key: 'k1', id: 'c1', name: 'worker', host: '(local)' }];

describe('tickAttention — gated off (ZERO pane capture, ZERO network)', () => {
  it('no-ops without calling pollAgentStates or fetch when the channel is disabled', async () => {
    await put({ webhookEnabled: false, webhookUrl: '' });
    let polled = 0;
    const fetchImpl = fetchRec();
    await tickAttention({
      chats: STUB_CHATS,
      pollAgentStates: async () => { polled++; return []; },
      fetchImpl,
    });
    assert.strictEqual(polled, 0, 'pane capture never runs while the channel is off');
    assert.strictEqual(fetchImpl.count(), 0, 'no webhook POST while off');
  });

  it('no-ops when BOTH attention + done routing are off (sweep idle: zero capture, zero network)', async () => {
    // WARDEN-575: the sweep serves two independent routings (attention + done) and
    // runs while EITHER is on. With both off it is fully idle — zero pane capture,
    // zero network — matching the original "routing off → no sweep" intent.
    await put({ webhookEnabled: true, webhookUrl: URL, webhookAlertAttention: false, webhookAlertDone: false });
    let polled = 0;
    const fetchImpl = fetchRec();
    await tickAttention({
      chats: STUB_CHATS,
      pollAgentStates: async () => { polled++; return []; },
      fetchImpl,
    });
    assert.strictEqual(polled, 0, 'both routings off → sweep does not run');
    assert.strictEqual(fetchImpl.count(), 0);
  });

  it('runs for DONE even when attention routing is off (the two routings are independent)', async () => {
    // WARDEN-575: a human can opt into "tell me when an agent finishes" with the
    // problem pings OFF. The sweep runs (done routing on) but dispatches NO
    // attention-* event — only a done event on a working→idle transition.
    await put({ webhookEnabled: true, webhookUrl: URL, webhookAlertAttention: false, webhookAlertDone: true });
    const fetchImpl = fetchRec();
    const poll = agentSeq([
      [{ key: 'k1', state: 'active', signal: null, name: 'worker', host: '(local)' }], // prime (active)
      [{ key: 'k1', state: 'idle', signal: null, name: 'worker', host: '(local)' }],   // active→idle = done
    ]);
    await tickAttention({ chats: STUB_CHATS, pollAgentStates: poll, fetchImpl }); await flush();
    await tickAttention({ chats: STUB_CHATS, pollAgentStates: poll, fetchImpl }); await flush();
    assert.strictEqual(fetchImpl.count(), 1, 'one done POST on the working→idle transition');
    const body = JSON.parse(fetchImpl.calls[0].opts.body);
    assert.strictEqual(body.event, 'done', 'no attention-* event — only the positive done event');
    assert.strictEqual(body.severity, 'info', 'non-alarming positive severity');
    assert.strictEqual(body.agent, 'worker');
    assert.ok(body.reason.includes('Finished a task'), 'positive reason wording');
  });
});

describe('tickAttention — baseline-prime then fire on a new transition', () => {
  it('priming sweep (empty baseline) fires nothing; the next new transition dispatches one POST', async () => {
    // Enable + a clean baseline prime (the PUT handler's restartAttentionPoll
    // resets prevAttentionStates on enable).
    await put({ webhookEnabled: true, webhookUrl: URL, webhookAlertAttention: true, webhookSecret: SECRET });
    const fetchImpl = fetchRec();

    // Sweep 1: agent idle → baseline-prime (empty prev) → no fire.
    const poll = agentSeq([
      [{ key: 'k1', state: 'idle', signal: null, name: 'worker', host: '(local)' }],
      [{ key: 'k1', state: 'erroring', signal: 'TypeError: x', name: 'worker', host: '(local)' }],
    ]);
    await tickAttention({ chats: STUB_CHATS, pollAgentStates: poll, fetchImpl });
    await flush();
    assert.strictEqual(fetchImpl.count(), 0, 'priming sweep fires nothing');

    // Sweep 2: idle → erroring is a NEW transition → exactly one POST.
    await tickAttention({ chats: STUB_CHATS, pollAgentStates: poll, fetchImpl });
    await flush();
    assert.strictEqual(fetchImpl.count(), 1, 'one POST on the new attention transition');

    const { url, opts } = fetchImpl.calls[0];
    assert.strictEqual(url, URL, 'destination is exactly the configured url');
    assert.strictEqual(opts.method, 'POST');
    assert.strictEqual(opts.headers.authorization, `Bearer ${SECRET}`, 'signing header on the wire');
    assert.strictEqual(opts.headers['x-webhook-secret'], SECRET);
    const body = JSON.parse(opts.body);
    assert.strictEqual(body.app, 'warden');
    assert.strictEqual(body.event, 'attention-erroring');
    assert.strictEqual(body.severity, 'critical');
    assert.strictEqual(body.agent, 'worker');
    assert.ok(body.reason.includes('Erroring'), 'reason carries the attention label');
    assert.ok(body.reason.includes('TypeError: x'), 'reason carries the triggering signal');
  });

  it('does NOT re-fire while the agent stays in the same attention state (no spam)', async () => {
    await put({ webhookEnabled: true, webhookUrl: URL, webhookAlertAttention: true });
    const fetchImpl = fetchRec();
    const poll = agentSeq([
      [{ key: 'k2', state: 'idle' }],          // prime
      [{ key: 'k2', state: 'waiting', signal: 'press enter', name: 'planner' }], // fire
      [{ key: 'k2', state: 'waiting', signal: 'press enter', name: 'planner' }], // same → no fire
    ]);
    await tickAttention({ chats: STUB_CHATS, pollAgentStates: poll, fetchImpl }); await flush();
    await tickAttention({ chats: STUB_CHATS, pollAgentStates: poll, fetchImpl }); await flush();
    assert.strictEqual(fetchImpl.count(), 1, 'fired once on the transition');
    await tickAttention({ chats: STUB_CHATS, pollAgentStates: poll, fetchImpl }); await flush();
    assert.strictEqual(fetchImpl.count(), 1, 'still one — a persistent state does not re-fire');
    assert.strictEqual(JSON.parse(fetchImpl.calls[0].opts.body).event, 'attention-waiting');
  });
});

describe('tickAttention — positive done transition (WARDEN-575)', () => {
  it('priming sweep fires nothing; active→idle after activity dispatches one positive done POST', async () => {
    await put({ webhookEnabled: true, webhookUrl: URL, webhookAlertAttention: true, webhookAlertDone: true });
    const fetchImpl = fetchRec();
    const poll = agentSeq([
      [{ key: 'k1', state: 'active', signal: 'implementing WARDEN-575', name: 'worker', host: '(local)' }],
      [{ key: 'k1', state: 'idle', signal: null, name: 'worker', host: '(local)' }],
    ]);
    // Sweep 1: prime (active). No done POST (no prior working→idle transition yet).
    await tickAttention({ chats: STUB_CHATS, pollAgentStates: poll, fetchImpl }); await flush();
    assert.strictEqual(fetchImpl.count(), 0, 'priming sweep fires nothing');

    // Sweep 2: active→idle = the agent finished → exactly one done POST.
    await tickAttention({ chats: STUB_CHATS, pollAgentStates: poll, fetchImpl }); await flush();
    assert.strictEqual(fetchImpl.count(), 1, 'one done POST on the working→idle transition');
    const body = JSON.parse(fetchImpl.calls[0].opts.body);
    assert.strictEqual(body.event, 'done');
    assert.strictEqual(body.severity, 'info');
    assert.strictEqual(body.agent, 'worker');
    assert.ok(body.reason.includes('Finished a task'));
  });

  it('does NOT fire on idle→idle (dormant), a dormant newly-seen idle pane, or recovery', async () => {
    await put({ webhookEnabled: true, webhookUrl: URL, webhookAlertDone: true });
    const fetchImpl = fetchRec();
    const poll = agentSeq([
      // prime: one idle agent (dormant)
      [{ key: 'k1', state: 'idle', signal: null, name: 'worker', host: '(local)' }],
      // idle→idle (still dormant): no fire
      [{ key: 'k1', state: 'idle', signal: null, name: 'worker', host: '(local)' }],
      // active (started working): no done fire (this is recovery/start, not finish)
      [{ key: 'k1', state: 'active', signal: null, name: 'worker', host: '(local)' }],
    ]);
    await tickAttention({ chats: STUB_CHATS, pollAgentStates: poll, fetchImpl }); await flush();
    await tickAttention({ chats: STUB_CHATS, pollAgentStates: poll, fetchImpl }); await flush();
    await tickAttention({ chats: STUB_CHATS, pollAgentStates: poll, fetchImpl }); await flush();
    assert.strictEqual(fetchImpl.count(), 0, 'idle→idle and idle→active never fire a done ping');
  });

  it('respects the webhookAlertDone gate: done routing off → no done POST even on active→idle', async () => {
    await put({ webhookEnabled: true, webhookUrl: URL, webhookAlertAttention: false, webhookAlertDone: false });
    const fetchImpl = fetchRec();
    const poll = agentSeq([
      [{ key: 'k1', state: 'active', signal: null, name: 'worker', host: '(local)' }],
      [{ key: 'k1', state: 'idle', signal: null, name: 'worker', host: '(local)' }],
    ]);
    await tickAttention({ chats: STUB_CHATS, pollAgentStates: poll, fetchImpl }); await flush();
    await tickAttention({ chats: STUB_CHATS, pollAgentStates: poll, fetchImpl }); await flush();
    assert.strictEqual(fetchImpl.count(), 0, 'done routing off → no done POST');
  });
});
