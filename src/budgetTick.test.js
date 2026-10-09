import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBudgetTick } from './budgetTick.js';

// Direct spec for createBudgetTick (WARDEN-1688 moved it verbatim out of
// server.js; WARDEN-1711 pins it). The 7 suites that reach it through server.js
// assert the happy-path breach/POST and the window filter, but never the disabled
// self-gate, the re-entrancy guard, the sessionCache fan-out arguments, the
// reason/agent text branches, deps threading or failure retention. This file
// drives the factory with NO server import, NO network and NO timers: a fake
// sessionCache.snapshot, a fake live cfg, an injected stopSweep counter and an
// injected fetchImpl/sleepImpl.

const URL = 'https://ntfy.example.selfhosted.net/warden-budget';
const HOUR = 3_600_000;

function row(overrides = {}) {
  return { id: 's1', cwd: '/tmp/s1', summary: 'x', mtime: Date.now() - 1000, tokenUsage: { total: 100 }, ...overrides };
}

function makeCfg(overrides = {}) {
  return {
    hosts: ['remote-a'],
    tokenBudgetEnabled: true,
    tokenBudgetThresholdTokens: 1000,
    tokenBudgetPerSessionThresholdTokens: 0,
    tokenBudgetWindowHours: 24,
    webhookEnabled: true,
    webhookUrl: URL,
    webhookSecret: '',
    webhookAlertBudget: true,
    ...overrides,
  };
}

// A scripted sessionCache: each snapshot() call returns the next scripted entry
// (the last one repeats). Entries are `[{host, sessions, pending?}]` arrays.
function makeCache(...script) {
  const calls = [];
  return {
    calls,
    snapshot: async (hosts, limit, opts) => {
      calls.push({ hosts, limit, opts });
      const i = Math.min(calls.length - 1, script.length - 1);
      return script[i];
    },
  };
}

function fetchRec() {
  const calls = [];
  const fn = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200 }; };
  fn.calls = calls;
  return fn;
}

function setup({ cfg = makeCfg(), script, fetchImpl = fetchRec() } = {}) {
  const sessionCache = makeCache(...script);
  const stops = { count: 0 };
  const tick = createBudgetTick({
    cfg,
    sessionCache,
    local: '(local)',
    stopSweep: () => { stops.count += 1; },
  });
  return { cfg, sessionCache, stops, tick, fetchImpl, deps: { fetchImpl, sleepImpl: async () => {} } };
}

const quiet = [{ host: '(local)', sessions: [row({ tokenUsage: { total: 10 } })] }];
const bodyOf = (fetchImpl, i = 0) => JSON.parse(fetchImpl.calls[i].opts.body);

// Prime a non-alerted baseline, then swap in a breaching snapshot and tick once.
async function breach(script, cfgOverrides = {}) {
  const ctx = setup({ cfg: makeCfg(cfgOverrides), script: [quiet, script] });
  await ctx.tick.tickBudget(ctx.deps);
  assert.equal(ctx.fetchImpl.calls.length, 0, 'priming sweep fires nothing');
  await ctx.tick.tickBudget(ctx.deps);
  assert.equal(ctx.fetchImpl.calls.length, 1, 'the breach transition dispatches exactly one POST');
  return ctx;
}

describe('createBudgetTick — disabled self-gate', () => {
  it('stops the sweep once, nulls the cache and never touches sessionCache when disabled', async () => {
    const ctx = setup({ script: [quiet] });
    await ctx.tick.tickBudget(ctx.deps);
    assert.ok(ctx.tick.getBudgetState(), 'enabled tick populated the cache');
    assert.equal(ctx.stops.count, 0, 'enabled → stopSweep not called');
    assert.equal(ctx.sessionCache.calls.length, 1);

    ctx.cfg.tokenBudgetEnabled = false; // live cfg mutated in place, like server.js does
    await ctx.tick.tickBudget(ctx.deps);
    assert.equal(ctx.stops.count, 1, 'disabled → stopSweep called exactly once');
    assert.equal(ctx.tick.getBudgetState(), null, 'disabled → stale cache cleared');
    assert.equal(ctx.sessionCache.calls.length, 1, 'disabled → no further snapshot');
    assert.equal(ctx.tick.isRunning(), false);
  });
});

describe('createBudgetTick — sessionCache fan-out', () => {
  it('snapshots [local, ...cfg.hosts] at the 100-row ceiling in wait mode', async () => {
    const ctx = setup({ cfg: makeCfg({ hosts: ['remote-a', 'remote-b'] }), script: [quiet] });
    await ctx.tick.tickBudget(ctx.deps);
    assert.equal(ctx.sessionCache.calls.length, 1);
    const [{ hosts, limit, opts }] = ctx.sessionCache.calls;
    assert.deepEqual(hosts, ['(local)', 'remote-a', 'remote-b']);
    assert.equal(limit, 100);
    assert.deepEqual(opts, { wait: true });
  });

  it('excludes pending hosts from the fleet spend math', async () => {
    const ctx = setup({
      script: [[
        { host: '(local)', sessions: [row({ tokenUsage: { total: 9 } })] },
        { host: 'remote-a', pending: true, sessions: [row({ id: 'p', tokenUsage: { total: 700 } })] },
      ]],
    });
    await ctx.tick.tickBudget(ctx.deps);
    assert.equal(ctx.tick.getBudgetState().fleetSpent, 9, 'the truncated pending slot contributes nothing');
    assert.equal(ctx.tick.getBudgetState().sessionCount, 1);
  });

  it('feeds cfg thresholds and window into the cached state', async () => {
    const ctx = setup({
      cfg: makeCfg({ tokenBudgetThresholdTokens: 5000, tokenBudgetPerSessionThresholdTokens: 3000, tokenBudgetWindowHours: 6 }),
      script: [quiet],
    });
    const before = Date.now();
    await ctx.tick.tickBudget(ctx.deps);
    const st = ctx.tick.getBudgetState();
    assert.equal(st.threshold, 5000);
    assert.equal(st.perSessionThreshold, 3000);
    assert.equal(st.windowMs, 6 * HOUR);
    assert.ok(st.evaluatedAt >= before && st.evaluatedAt <= Date.now(), 'evaluatedAt is current epoch ms');
  });
});

describe('createBudgetTick — re-entrancy guard', () => {
  it('makes a concurrent tick a no-op, reports isRunning, and allows a later tick', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const ctx = setup({ script: [quiet] });
    let n = 0;
    ctx.sessionCache.snapshot = async (hosts, limit, opts) => {
      ctx.sessionCache.calls.push({ hosts, limit, opts });
      n += 1;
      if (n === 1) await gate;
      return quiet;
    };

    const first = ctx.tick.tickBudget(ctx.deps);
    assert.equal(ctx.tick.isRunning(), true, 'running while the sweep is in flight');
    const second = ctx.tick.tickBudget(ctx.deps);
    await second;
    assert.equal(ctx.sessionCache.calls.length, 1, 'the overlapping tick did not start a second sweep');
    assert.equal(ctx.tick.isRunning(), true);

    release();
    await first;
    assert.equal(ctx.tick.isRunning(), false, 'finally resets the guard');
    await ctx.tick.tickBudget(ctx.deps);
    assert.equal(ctx.sessionCache.calls.length, 2, 'a later tick runs again');
  });
});

describe('createBudgetTick — failure retention', () => {
  it('a throwing tick does not reject, keeps the previous state by identity and resets running', async () => {
    const ctx = setup({ script: [quiet] });
    await ctx.tick.tickBudget(ctx.deps);
    const good = ctx.tick.getBudgetState();
    assert.ok(good);

    ctx.cfg.hosts = null; // `[local, ...null]` throws inside the try
    await assert.doesNotReject(ctx.tick.tickBudget(ctx.deps));
    assert.equal(ctx.tick.getBudgetState(), good, 'previous cache retained, not blanked');
    assert.equal(ctx.tick.isRunning(), false);
  });

  it('clearBudgetState nulls the cache', async () => {
    const ctx = setup({ script: [quiet] });
    await ctx.tick.tickBudget(ctx.deps);
    assert.ok(ctx.tick.getBudgetState());
    ctx.tick.clearBudgetState();
    assert.equal(ctx.tick.getBudgetState(), null);
  });
});

describe('createBudgetTick — webhook payload', () => {
  it('fleet breach: exact reason with spend and window hours, agent falls back to the offender cwd', async () => {
    const ctx = await breach(
      [{ host: '(local)', sessions: [row({ id: 'a', cwd: '/tmp/a', tokenUsage: { total: 800 } }), row({ id: 'b', cwd: '/tmp/b', tokenUsage: { total: 450 } })] }],
      { tokenBudgetWindowHours: 6 },
    );
    const body = bodyOf(ctx.fetchImpl);
    assert.equal(body.event, 'budget-breached');
    assert.equal(body.severity, 'critical');
    assert.equal(body.agent, '/tmp/a');
    assert.equal(body.reason, 'Fleet token budget exceeded: 1250 tokens spent across active sessions in the last 6h window.');
  });

  it('per-session breach: exact reason with the offender total and cwd', async () => {
    const ctx = await breach(
      [{ host: '(local)', sessions: [row({ id: 'a', cwd: '/tmp/a', tokenUsage: { total: 4000 } })] }],
      { tokenBudgetThresholdTokens: 1_000_000, tokenBudgetPerSessionThresholdTokens: 3000 },
    );
    const body = bodyOf(ctx.fetchImpl);
    assert.equal(body.agent, '/tmp/a');
    assert.equal(body.reason, 'Per-session token budget exceeded: top session at 4000 tokens (/tmp/a).');
  });

  it('per-session breach without a cwd falls back to the session id for both agent and label', async () => {
    const ctx = await breach(
      [{ host: '(local)', sessions: [row({ id: 'sess-9', cwd: undefined, tokenUsage: { total: 4000 } })] }],
      { tokenBudgetThresholdTokens: 1_000_000, tokenBudgetPerSessionThresholdTokens: 3000 },
    );
    const body = bodyOf(ctx.fetchImpl);
    assert.equal(body.agent, 'sess-9');
    assert.equal(body.reason, 'Per-session token budget exceeded: top session at 4000 tokens (sess-9).');
  });

  it('per-session breach with neither cwd nor id uses the "fleet" agent and "unknown" label', async () => {
    const ctx = await breach(
      [{ host: '(local)', sessions: [row({ id: undefined, cwd: undefined, tokenUsage: { total: 4000 } })] }],
      { tokenBudgetThresholdTokens: 1_000_000, tokenBudgetPerSessionThresholdTokens: 3000 },
    );
    const body = bodyOf(ctx.fetchImpl);
    assert.equal(body.agent, 'fleet');
    assert.equal(body.reason, 'Per-session token budget exceeded: top session at 4000 tokens (unknown).');
  });

  it('stamps ts with the current epoch ms and posts to the configured url', async () => {
    const before = Date.now();
    const ctx = await breach([{ host: '(local)', sessions: [row({ tokenUsage: { total: 5000 } })] }]);
    const body = bodyOf(ctx.fetchImpl);
    assert.equal(ctx.fetchImpl.calls[0].url, URL);
    assert.equal(typeof body.ts, 'number');
    assert.ok(body.ts >= before && body.ts <= Date.now(), 'ts is current epoch ms');
  });

  it('does not dispatch when webhookAlertBudget routing is off, yet still advances the debounce', async () => {
    const ctx = setup({
      cfg: makeCfg({ webhookAlertBudget: false }),
      script: [quiet, [{ host: '(local)', sessions: [row({ tokenUsage: { total: 5000 } })] }]],
    });
    await ctx.tick.tickBudget(ctx.deps);
    await ctx.tick.tickBudget(ctx.deps);
    assert.equal(ctx.fetchImpl.calls.length, 0);
    assert.equal(ctx.tick.getBudgetState().alerted, true);
  });

  it('does not re-fire while persistently over the threshold', async () => {
    const ctx = await breach([{ host: '(local)', sessions: [row({ tokenUsage: { total: 5000 } })] }]);
    await ctx.tick.tickBudget(ctx.deps);
    assert.equal(ctx.fetchImpl.calls.length, 1);
  });

  it('threads deps.sleepImpl into the webhook transport (a 503 backs off through the injected sleep)', async () => {
    const sleeps = [];
    const fetchImpl = async () => ({ ok: false, status: 503 });
    const ctx = setup({
      script: [quiet, [{ host: '(local)', sessions: [row({ tokenUsage: { total: 5000 } })] }]],
      fetchImpl,
    });
    const deps = { fetchImpl, sleepImpl: async (ms) => { sleeps.push(ms); } };
    await ctx.tick.tickBudget(deps);
    await ctx.tick.tickBudget(deps);
    // The dispatch is fire-and-forget; let its retry loop drain on the microtask queue.
    for (let i = 0; i < 20 && sleeps.length < 2; i++) await new Promise((r) => setImmediate(r));
    assert.ok(sleeps.length >= 1, 'the injected sleepImpl was used for backoff, not a real timer');
  });

  it('a no-arg tickBudget() (production call shape) still dispatches through globalThis.fetch', async () => {
    const realFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200 }; };
    try {
      const ctx = setup({
        script: [quiet, [{ host: '(local)', sessions: [row({ tokenUsage: { total: 5000 } })] }]],
      });
      await ctx.tick.tickBudget();
      await ctx.tick.tickBudget();
      assert.equal(calls.length, 1, 'default deps = {} must not throw inside the try');
      assert.equal(calls[0].url, URL);
      assert.ok(ctx.tick.getBudgetState().alerted);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
