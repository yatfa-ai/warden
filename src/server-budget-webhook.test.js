import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Budget breach → webhook dispatch (WARDEN-555). Symmetric counterpart to
// server-attention-webhook.test.js: it pins the attention sweep → dispatch
// wiring, this pins the budget sweep → dispatch wiring. Drives the REAL
// tickBudget over a planted ~/.claude transcript through the full
// cfg.webhookAlertBudget gate → localClaudeSessions → computeBudgetState →
// shouldFireBudgetAlert debounce → notify.dispatchWebhook chain, with an
// injected fetch recorder so there is ZERO real network. The pure pieces
// (shouldFireBudgetAlert, computeBudgetState, dispatchWebhook, sendWebhook) are
// pinned in budget.test.js / notify.test.js; THIS file pins the INTEGRATION
// glue in server.js: the routing gate, the prevBudgetState debounce advance,
// the transition → dispatch field mapping, and the destination/headers/body on
// the wire — acceptance criterion #1 ("a budget breach delivers a POST within
// one sweep"), which previously had ZERO automated verification.
//
// Same isolated-server pattern as server-budget.test.js / server-attention-
// webhook.test.js: an isolated HOME whose config has no remote hosts (so only
// '(local)' is probed — no SSH, fast, deterministic). Everything is enabled via
// the config FILE and sweeps are driven via the exported tickBudget(), so
// restartBudgetPoll never runs at startup (we listen on app directly, not via
// the module's startServer) and NO 120s/60s setInterval is created until a PUT.

let httpServer;
let baseUrl;
let originalHome;
let tempHome;
let tickBudget;

const URL = 'https://ntfy.example.selfhosted.net/warden-budget';
const SECRET = 'sec_budgettoken42';
const FLEET_THRESHOLD = 2_000_000;
const PER_SESSION_THRESHOLD = 1_000_000;
// A session under BOTH thresholds (primes the debounce non-alerted), and one
// over BOTH (the breach transition). 2.1M ≥ 1M per-session ⇒ perSessionBreached,
// so the dispatch builds the per-session reason variant (asserted below).
const UNDER_TOTAL = 100_000;
const BREACH_TOTAL = 2_100_000;
const UNDER_ID = 'budget-under-555';
const BREACH_ID = 'budget-breach-555';
const BREACH_CWD = `/tmp/${BREACH_ID}`;

// Plant (or overwrite) ~/.claude/projects/p555/<id>.jsonl — one cwd line (so
// localClaudeSessions keeps the row) + one assistant turn carrying the usage,
// which parseJsonlTokenUsage sums. mtime is "now" so it sits inside the 24h
// window (the in-window filter is exercised end-to-end by server-budget.test.js).
function writeTranscript(id, total) {
  const projDir = path.join(tempHome, '.claude', 'projects', 'p555');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, `${id}.jsonl`), [
    JSON.stringify({ cwd: `/tmp/${id}`, type: 'user', message: { content: `work on ${id}` } }),
    JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: total, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
  ].join('\n') + '\n');
  return path.join(projDir, `${id}.jsonl`);
}

function removeTranscript(id) {
  try { fs.rmSync(path.join(tempHome, '.claude', 'projects', 'p555', `${id}.jsonl`)); } catch { /* not present */ }
}

before(async () => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-budget-webhook-'));
  process.env.HOME = tempHome;
  const wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  // Enable BOTH the budget AND the webhook up front via the config FILE. No PUT
  // here ⇒ restartBudgetPoll/restartAttentionPoll never run at import, so NO
  // setInterval is created and the test drives every sweep itself via tickBudget.
  // webhookAlertBudget starts FALSE so the gate-isolation test (below) needs no
  // PUT at all; the lifecycle test flips it on. webhookAlertAttention is FALSE so
  // a later PUT (which always calls restartAttentionPoll) can never start the 60s
  // attention sweep — only the budget path is under test here.
  fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({
    hosts: [],
    tokenBudgetEnabled: true,
    tokenBudgetThresholdTokens: FLEET_THRESHOLD,
    tokenBudgetPerSessionThresholdTokens: PER_SESSION_THRESHOLD,
    tokenBudgetWindowHours: 24,
    webhookEnabled: true,
    webhookUrl: URL,
    webhookSecret: SECRET,
    webhookAlertBudget: false,
    webhookAlertAttention: false,
  }));

  // Start under threshold so the first sweep primes the debounce NON-alerted.
  writeTranscript(UNDER_ID, UNDER_TOTAL);

  const server = await import('./server.js');
  tickBudget = server.tickBudget;
  httpServer = server.app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    httpServer.once('listening', resolve);
    httpServer.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

after(async () => {
  // The lifecycle test's PUT flipped webhookAlertBudget on, which made
  // restartBudgetPoll start the 120s budget setInterval. node v20 --test does NOT
  // force-exit on a pending setInterval, so disabling the budget here clears that
  // timer (restartBudgetPoll's else branch) — same teardown discipline as
  // server-attention-webhook.test.js. Best-effort: the suite must not hang.
  if (baseUrl) {
    try {
      await fetch(`${baseUrl}/api/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tokenBudgetEnabled: false, webhookEnabled: false, webhookUrl: '' }),
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

// Flush the fire-and-forget dispatchWebhook microtask chain (tickBudget does not
// await it) so the recorder has observed the POST before we assert.
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('tickBudget — webhook routing gate (ZERO network on a real transition)', () => {
  it('does NOT dispatch when webhookAlertBudget is off, even on a !alerted → alerted transition', async () => {
    // webHookAlertBudget is false (config file). Drive a genuine under → over
    // transition so shouldFireBudgetAlert WOULD fire — then prove the routing
    // gate suppresses it. This is the mutation guard the leaf tests cannot
    // provide: removing the `cfg.webhookAlertBudget &&` from the guard in
    // server.js would dispatch here and fail this assertion.
    const fetchImpl = fetchRec();

    // Sweep A: under only → primes prevBudgetState NON-alerted (deterministic
    // regardless of any prior state; shouldFireBudgetAlert is false on a non-
    // transition anyway, so this is a no-dispatch warm-up).
    await tickBudget({ fetchImpl });
    await flush();
    assert.strictEqual(fetchImpl.count(), 0, 'under-threshold sweep dispatches nothing');

    // Sweep B: add the breach → a real !alerted → alerted transition. The routing
    // gate (cfg.webhookAlertBudget === false) must keep this off the wire.
    writeTranscript(BREACH_ID, BREACH_TOTAL);
    await tickBudget({ fetchImpl });
    await flush();
    assert.strictEqual(fetchImpl.count(), 0, 'routing off → zero POST even on a breach transition');
    // prevBudgetState is now alerted; the lifecycle test re-arms it back under.
  });
});

describe('tickBudget — fires one POST on the breach transition (debounce + payload)', () => {
  it('primes silently, dispatches exactly one budget-breached POST on the transition, and does not re-fire while persistently over', async () => {
    // Enable budget routing. (The PUT also restarts the budget poll, whose seed
    // sweep computes the still-breached state but does not dispatch — prevBudgetState
    // is already alerted from the gate test above, so shouldFireBudgetAlert is
    // false. The seed's side effect is irrelevant: sweep 1 below re-establishes
    // prevBudgetState deterministically by driving back under threshold.)
    await put({ webhookAlertBudget: true });
    const fetchImpl = fetchRec();

    // Re-arm the debounce: remove the breach so the next sweep sees under-threshold
    // spend → prevBudgetState goes NON-alerted.
    removeTranscript(BREACH_ID);

    // Sweep 1 (prime / re-arm): under threshold → NO dispatch (criterion #b part 1:
    // does not fire on the priming sweep).
    await tickBudget({ fetchImpl });
    await flush();
    assert.strictEqual(fetchImpl.count(), 0, 'priming sweep fires nothing');

    // Sweep 2 (transition): breach → exactly one POST (criterion #a).
    writeTranscript(BREACH_ID, BREACH_TOTAL);
    await tickBudget({ fetchImpl });
    await flush();
    assert.strictEqual(fetchImpl.count(), 1, 'one POST on the !alerted → alerted transition');

    // Destination + signing headers + body contract (criterion #c).
    const { url, opts } = fetchImpl.calls[0];
    assert.strictEqual(url, URL, 'destination is exactly the configured url');
    assert.strictEqual(opts.method, 'POST');
    assert.strictEqual(opts.headers.authorization, `Bearer ${SECRET}`, 'signing header on the wire');
    assert.strictEqual(opts.headers['x-webhook-secret'], SECRET);
    const body = JSON.parse(opts.body);
    assert.strictEqual(body.app, 'warden');
    assert.strictEqual(body.event, 'budget-breached');
    assert.strictEqual(body.severity, 'critical');
    assert.strictEqual(body.agent, BREACH_CWD, 'agent is the offender cwd (never transcript content)');
    assert.ok(body.reason.includes('token budget exceeded'), 'reason carries the breach label');
    assert.ok(body.reason.includes(String(BREACH_TOTAL)), 'reason carries the offender token total');
    assert.ok(body.reason.includes(BREACH_CWD), 'reason identifies the offender');
    assert.strictEqual(typeof body.ts, 'number', 'ts is epoch ms');

    // Sweep 3 (persistent): still over → NO additional dispatch (criterion #b part
    // 2: does not re-fire while persistently over — the debounce one-shot).
    await tickBudget({ fetchImpl });
    await flush();
    assert.strictEqual(fetchImpl.count(), 1, 'a persistent breach does not re-fire');
  });
});
