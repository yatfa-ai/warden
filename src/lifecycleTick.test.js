import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * createLifecycleTick (WARDEN-1669 moved it out of server.js) — pinned directly.
 *
 * The factory is constructed per test with `{ cfg }`, so every test gets a FRESH
 * closure (fresh prevSnapshot + lifecycleRunning) — no module-level state leaks
 * between tests, unlike the server.js-based suites. The fleet is local-only: real
 * tmux sessions listed in an isolated HOME's chats.json catalog flow through the
 * real discoverAll() path (same fixture style as server-lifecycle.test.js); the
 * done-webhook transport is exercised with an injected fetchImpl/sleepImpl so there
 * is ZERO real network and no real backoff sleeping.
 *
 * Each describe/it below names the behaviour it pins; the concurrency test asserts
 * on an UNRESOLVED first promise (never on timing sleeps), so it is not flaky.
 */

const URL = 'https://ntfy.example.selfhosted.net/warden';
const A = 'w1683a';
const B = 'w1683b';
const SESSIONS = [A, B];

describe('createLifecycleTick (WARDEN-1683)', () => {
  let createLifecycleTick;
  let originalHome, tempHome, catPath, activityPath, wdir;

  const entry = (session) => ({ kind: 'tmux', host: '(local)', session, name: session, cwd: '/tmp', cmd: 'claude' });
  function seedCatalog(sessions) {
    fs.writeFileSync(catPath, JSON.stringify(sessions.map(entry), null, 2) + '\n');
  }
  function events() {
    try {
      return fs.readFileSync(activityPath, 'utf8')
        .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch { return []; }
  }
  const types = () => events().map((e) => `${e.type}:${e.id}`);
  const newSession = (s) => {
    const r = spawnSync('tmux', ['new-session', '-d', '-s', s, '-x', '80', '-y', '24'], { stdio: 'ignore' });
    assert.strictEqual(r.status, 0, `fixture tmux session ${s} must start`);
  };
  const killSession = (s) => spawnSync('tmux', ['kill-session', '-t', s], { stdio: 'ignore' });
  function fetchRec(status = 200) {
    const calls = [];
    const fn = async (url, opts) => { calls.push({ url, opts }); return { ok: status >= 200 && status < 300, status }; };
    fn.calls = calls;
    fn.count = () => calls.length;
    return fn;
  }
  function sleepRec() {
    const calls = [];
    const fn = async (ms) => { calls.push(ms); };
    fn.calls = calls;
    return fn;
  }
  // Poll (bounded) for fire-and-forget webhook work to land — no fixed sleeps.
  async function until(pred, label) {
    for (let i = 0; i < 200; i++) {
      if (pred()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.fail(`timed out waiting for: ${label}`);
  }
  const flush = () => new Promise((r) => setTimeout(r, 30));
  function makeCfg(over = {}) {
    return { hosts: [], webhookEnabled: true, webhookUrl: URL, webhookAlertDone: true, ...over };
  }

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-lifetick-'));
    process.env.HOME = tempHome;
    wdir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wdir, { recursive: true });
    fs.writeFileSync(path.join(wdir, 'config.json'), JSON.stringify({ hosts: [] }) + '\n');
    catPath = path.join(wdir, 'chats.json');
    activityPath = path.join(wdir, 'activity.jsonl');
    // Dynamic import AFTER HOME is set → config/catalog/activity paths resolve under tempHome.
    ({ createLifecycleTick } = await import('./lifecycleTick.js'));
  });

  after(() => {
    for (const s of SESSIONS) killSession(s);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  beforeEach(() => {
    for (const s of SESSIONS) killSession(s);
    // activity.jsonl may be a directory left by the write-failure test.
    fs.rmSync(activityPath, { recursive: true, force: true });
    fs.writeFileSync(activityPath, '');
    seedCatalog([]);
  });

  afterEach(() => {
    for (const s of SESSIONS) killSession(s);
  });

  it('re-entrancy guard: a tick fired while one is in flight resolves undefined without sweeping (one agent_started)', async () => {
    newSession(A);
    seedCatalog([A]);
    const tick = createLifecycleTick({ cfg: makeCfg() });
    await tick(); // seed silently
    newSession(B);
    seedCatalog([A, B]);

    let p1Settled = false;
    const p1 = tick().then((v) => { p1Settled = true; return v; });
    const r2 = await tick(); // fired while #1 is still mid-sweep
    assert.strictEqual(r2, undefined, 'overlapping tick is a no-op that resolves undefined');
    assert.strictEqual(p1Settled, false, 'the overlapping tick resolved BEFORE the in-flight one settled (it did not run a second sweep)');
    await p1;
    assert.deepStrictEqual(types(), [`agent_started:(local):${B}`], 'exactly one agent_started — not one per overlapping tick');
  });

  it('re-entrancy guard re-arms: a tick after the in-flight one settled runs normally', async () => {
    newSession(A);
    seedCatalog([A]);
    const tick = createLifecycleTick({ cfg: makeCfg() });
    await tick();
    newSession(B);
    seedCatalog([A, B]);
    await tick();
    killSession(B);
    await tick(); // would be swallowed forever if lifecycleRunning were never reset
    assert.deepStrictEqual(types(), [`agent_started:(local):${B}`, `agent_session_down:(local):${B}`]);
  });

  it('a discoverAll failure is swallowed: the tick resolves, keeps the prior baseline, and the next tick still diffs against it', async () => {
    newSession(A);
    seedCatalog([A]);
    const cfg = makeCfg();
    const tick = createLifecycleTick({ cfg });
    await tick(); // seed {A}

    // hosts.length is truthy (passes the dormancy guard) but .map throws → discoverAll rejects.
    const goodHosts = cfg.hosts;
    cfg.hosts = { length: 1, map() { throw new Error('discovery boom'); } };
    const r = await tick();
    assert.strictEqual(r, undefined, 'a failing discovery resolves (does not reject)');
    assert.deepStrictEqual(events(), [], 'a failed discovery emits nothing');

    cfg.hosts = goodHosts;
    newSession(B);
    seedCatalog([A, B]);
    await tick();
    assert.deepStrictEqual(types(), [`agent_started:(local):${B}`], 'baseline survived the failed tick');
  });

  it('threads each tick\'s snapshot forward: started → down → up → idle emits each transition exactly once', async () => {
    newSession(A);
    seedCatalog([A]);
    const tick = createLifecycleTick({ cfg: makeCfg() });
    await tick();
    assert.deepStrictEqual(events(), [], 'first run seeds silently (no startup burst)');

    newSession(B);
    seedCatalog([A, B]);
    await tick();
    killSession(A);
    await tick();
    newSession(A);
    await tick();
    await tick(); // nothing changed
    assert.deepStrictEqual(types(), [
      `agent_started:(local):${B}`,
      `agent_session_down:(local):${A}`,
      `agent_session_up:(local):${A}`,
    ]);
  });

  it('awaits the append: the event is on disk by the time the tick resolves', async () => {
    newSession(A);
    seedCatalog([A]);
    const tick = createLifecycleTick({ cfg: makeCfg() });
    await tick();
    newSession(B);
    seedCatalog([A, B]);
    await tick();
    assert.deepStrictEqual(types(), [`agent_started:(local):${B}`], 'no delay between tick resolution and the read');
  });

  it('awaits the append on the drain path too: agent_ended is on disk when the draining tick resolves', async () => {
    newSession(A);
    seedCatalog([A]);
    const tick = createLifecycleTick({ cfg: makeCfg({ webhookAlertDone: false }) });
    await tick();
    seedCatalog([]);
    killSession(A);
    await tick();
    assert.deepStrictEqual(types(), [`agent_ended:(local):${A}`]);
  });

  it('a failing activity append never breaks the tick, and the done webhook still fires', async () => {
    newSession(A);
    seedCatalog([A]);
    const fetchImpl = fetchRec();
    const tick = createLifecycleTick({ cfg: makeCfg() });
    await tick({ fetchImpl });

    // activity.jsonl as a DIRECTORY → appendFile rejects with EISDIR (deterministic, even as root).
    fs.rmSync(activityPath, { force: true });
    fs.mkdirSync(activityPath);
    seedCatalog([]);
    killSession(A);
    await assert.doesNotReject(() => tick({ fetchImpl }), 'append failure is swallowed');
    await until(() => fetchImpl.count() === 1, 'done webhook after failed append');
    assert.strictEqual(fetchImpl.count(), 1);
  });

  describe('done webhook bridge', () => {
    it('does not fire for non-agent_ended events (agent_started with done routing on → 0 fetches)', async () => {
      newSession(A);
      seedCatalog([A]);
      const fetchImpl = fetchRec();
      const tick = createLifecycleTick({ cfg: makeCfg() });
      await tick({ fetchImpl });
      newSession(B);
      seedCatalog([A, B]);
      await tick({ fetchImpl });
      await flush();
      assert.deepStrictEqual(types(), [`agent_started:(local):${B}`], 'the event itself was emitted');
      assert.strictEqual(fetchImpl.count(), 0, 'only agent_ended is bridged to the done webhook');
    });

    it('does not fire when webhookAlertDone is off, even on agent_ended', async () => {
      newSession(A);
      seedCatalog([A]);
      const fetchImpl = fetchRec();
      const tick = createLifecycleTick({ cfg: makeCfg({ webhookAlertDone: false }) });
      await tick({ fetchImpl });
      seedCatalog([]);
      killSession(A);
      await tick({ fetchImpl });
      await flush();
      assert.strictEqual(types().length, 1);
      assert.strictEqual(fetchImpl.count(), 0);
    });

    it('agent_ended posts a positive done body with the ended agent identity and reason', async () => {
      newSession(A);
      seedCatalog([A]);
      const fetchImpl = fetchRec();
      const tick = createLifecycleTick({ cfg: makeCfg() });
      await tick({ fetchImpl });
      seedCatalog([]);
      killSession(A);
      await tick({ fetchImpl });
      await until(() => fetchImpl.count() === 1, 'done POST');
      const { url, opts } = fetchImpl.calls[0];
      assert.strictEqual(url, URL);
      const body = JSON.parse(opts.body);
      assert.strictEqual(body.event, 'done');
      assert.strictEqual(body.severity, 'info');
      assert.strictEqual(body.agent, `(local):${A}`);
      assert.strictEqual(body.reason, 'Agent finished (container ended)');
    });

    it('threads sleepImpl to the webhook transport: a 503 retries through the injected backoff seam', async () => {
      newSession(A);
      seedCatalog([A]);
      const fetchImpl = fetchRec(503);
      const sleepImpl = sleepRec();
      const tick = createLifecycleTick({ cfg: makeCfg() });
      await tick({ fetchImpl, sleepImpl });
      seedCatalog([]);
      killSession(A);
      await tick({ fetchImpl, sleepImpl });
      await until(() => fetchImpl.count() >= 2 && sleepImpl.calls.length >= 1, 'retry via injected sleepImpl');
      assert.ok(fetchImpl.count() >= 2, 'transient 503 is retried');
      assert.ok(sleepImpl.calls.length >= 1, 'backoff went through the injected sleepImpl');
    });

    it('the diff path (another agent still alive) threads deps: agent_ended uses the injected fetchImpl', async () => {
      newSession(A);
      newSession(B);
      seedCatalog([A, B]);
      const fetchImpl = fetchRec();
      const tick = createLifecycleTick({ cfg: makeCfg() });
      await tick({ fetchImpl }); // seed {A, B}
      killSession(A);
      seedCatalog([B]); // A vanishes from the fleet; B is still alive → diff path, not the empty-fleet drain
      await tick({ fetchImpl });
      await until(() => fetchImpl.count() === 1, 'done POST on the diff path');
      assert.deepStrictEqual(types(), [`agent_ended:(local):${A}`]);
      assert.strictEqual(JSON.parse(fetchImpl.calls[0].opts.body).agent, `(local):${A}`);
    });
  });
});
