import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * Lifecycle agent_ended → positive done webhook (WARDEN-575). The genuine
 * container-ended signal — already SSH-noise-cleaned by buildSnapshot's
 * carry-forward — is bridged to the SAME positive done dispatch the attention sweep
 * uses for working→idle. Drives the REAL tickLifecycle({ fetchImpl }) over a local
 * catalog tmux chat through the full seed → drain path with an injected fetch
 * recorder, so the bridge is exercised with ZERO real network.
 *
 * Own file (not folded into server-lifecycle.test.js) so it gets a FRESH process:
 * node --test runs each file in its own process, keeping the module-level
 * prevSnapshot + cfg isolated from the WARDEN-147 drain regression suite (mirrors
 * how server-attention-webhook / server-budget-webhook are each their own file).
 */

const URL = 'https://ntfy.example.selfhosted.net/warden';

describe('lifecycle agent_ended → positive done webhook (WARDEN-575)', () => {
  let httpServer, tickLifecycle;
  let originalHome, tempHome, catPath, activityPath, baseUrl;
  const SESSION = 'w575done';

  function seedCatalog(entries) {
    fs.writeFileSync(catPath, JSON.stringify(entries, null, 2) + '\n');
  }
  function readActivity() {
    try {
      return fs.readFileSync(activityPath, 'utf8')
        .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch { return []; }
  }
  async function put(body) {
    const res = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.strictEqual(res.status, 200);
  }
  function fetchRec() {
    const calls = [];
    const fn = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200 }; };
    fn.calls = calls;
    fn.count = () => calls.length;
    return fn;
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-life-done-'));
    process.env.HOME = tempHome;
    const wdir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wdir, { recursive: true });
    fs.writeFileSync(path.join(wdir, 'config.json'), JSON.stringify({ hosts: [] }) + '\n');
    catPath = path.join(wdir, 'chats.json');
    activityPath = path.join(wdir, 'activity.jsonl');
    seedCatalog([]);
    fs.writeFileSync(activityPath, '');

    spawnSync('tmux', ['kill-session', '-t', SESSION], { stdio: 'ignore' });
    const spawned = spawnSync('tmux', ['new-session', '-d', '-s', SESSION, '-x', '80', '-y', '24'], { stdio: 'ignore' });
    assert.strictEqual(spawned.status, 0, 'fixture tmux session must start');

    const { app, tickLifecycle: tick } = await import('./server.js');
    tickLifecycle = tick;
    httpServer = app.listen(0, '127.0.0.1');
    await new Promise((res, rej) => { httpServer.once('listening', res); httpServer.once('error', rej); });
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  });

  after(async () => {
    // Disable the webhook channel so restartAttentionPoll clears its interval.
    if (baseUrl) {
      try {
        await fetch(`${baseUrl}/api/config`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ webhookEnabled: false, webhookUrl: '' }),
        });
      } catch { /* best-effort teardown */ }
    }
    spawnSync('tmux', ['kill-session', '-t', SESSION], { stdio: 'ignore' });
    if (httpServer) await new Promise((r) => httpServer.close(r));
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('dispatches a positive done POST when a tracked chat drains (agent_ended)', async () => {
    await put({ webhookEnabled: true, webhookUrl: URL, webhookAlertDone: true });
    const fetchImpl = fetchRec();

    // 1. Seed: catalog has the active chat. First tick seeds prevSnapshot silently.
    seedCatalog([{ kind: 'tmux', host: '(local)', session: SESSION, name: SESSION, cwd: '/tmp', cmd: 'claude' }]);
    await tickLifecycle({ fetchImpl });
    await flush();
    assert.strictEqual(fetchImpl.count(), 0, 'seeding sweep fires no done POST');

    // 2. Empty the catalog + tear down the session → the fleet is empty.
    seedCatalog([]);
    spawnSync('tmux', ['kill-session', '-t', SESSION], { stdio: 'ignore' });

    // 3. Drain tick: agent_ended is emitted AND bridged to a positive done POST.
    await tickLifecycle({ fetchImpl });
    await flush();
    // The agent_ended event was appended to the activity log at all (regression
    // anchor) AND bridged to exactly one done POST.
    const ended = readActivity().filter((e) => e.type === 'agent_ended');
    assert.strictEqual(ended.length, 1, 'agent_ended still appended to the activity log');
    assert.strictEqual(fetchImpl.count(), 1, 'one done POST bridged from agent_ended');
    const { url, opts } = fetchImpl.calls[0];
    assert.strictEqual(url, URL, 'destination is exactly the configured url');
    const body = JSON.parse(opts.body);
    assert.strictEqual(body.event, 'done', 'positive done event (not a problem attention-* event)');
    assert.strictEqual(body.severity, 'info', 'non-alarming positive severity');
    assert.ok(body.agent && body.agent.includes(SESSION), 'agent identity derived from the ended event');
    assert.ok(typeof body.reason === 'string' && body.reason.length > 0, 'carries a positive reason');
  });

  it('respects the webhookAlertDone gate: done routing off → no done POST on agent_ended', async () => {
    await put({ webhookEnabled: true, webhookUrl: URL, webhookAlertDone: false });
    const fetchImpl = fetchRec();
    // Re-seed the session + catalog, then drain again with done routing off.
    spawnSync('tmux', ['new-session', '-d', '-s', SESSION, '-x', '80', '-y', '24'], { stdio: 'ignore' });
    seedCatalog([{ kind: 'tmux', host: '(local)', session: SESSION, name: SESSION, cwd: '/tmp', cmd: 'claude' }]);
    await tickLifecycle({ fetchImpl }); // seed
    seedCatalog([]);
    spawnSync('tmux', ['kill-session', '-t', SESSION], { stdio: 'ignore' });
    await tickLifecycle({ fetchImpl }); // drain → agent_ended, but done routing off
    await flush();
    assert.strictEqual(fetchImpl.count(), 0, 'done routing off → no done POST even on agent_ended');
  });
});
