import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * WARDEN-788 (Finding 1) — the 60s server-side webhook sweep (`tickAttention`)
 * persists `state_changed` transitions into the activity log.
 *
 * The reviewer's fail_audit found that `tickAttention`'s INLINE classify (the one
 * that runs in production — `tickAttention()` is called bare, so `deps.pollAgentStates`
 * is undefined and the inline branch always runs) never called `logAgentState`, so
 * the only classifier that keeps running server-side when the dashboard is closed to
 * tray logged nothing — defeating the timeline's headline "what oscillated while I was
 * away" use case. These tests pin the fix: they drive the REAL `tickAttention` with the
 * webhook gate ENABLED (file-seeded config, not HTTP PUT) and do NOT inject
 * `deps.pollAgentStates`, so the inline classify branch runs — the exact production
 * path. Canned panes flow in through the new `deps.capturePanes` seam (mirroring
 * `pollAgentStates`'s own), so the suite runs ZERO SSH. The state_changed events it
 * writes are read back from the REAL store via `readEvents`.
 *
 * HOME-isolation + seed-then-dynamic-import mirrors state-transition.test.js.
 */

const STUCK_LINE = 'stuck loop repeating the same output line over and over again';
const stuckPane = Array(7).fill(STUCK_LINE).join('\n'); // last3 === prev3, >50 chars → stuck
const idlePane = '';                                       // no signal → idle

// A yatfa agent (container set) vs a manual/tmux chat (no container).
const yatfa = (key, container = key) => ({
  key, container, session: null, host: 'hostA', role: 'worker', project: 'p', name: key, active: true,
});
const manual = (key) => ({
  key, container: null, session: key, host: '(local)', role: null, name: key, active: true,
});

// Inject a capturePanes that serves `panesByKey` (key → pane content). A key ABSENT
// from the map → capture_failed (mirrors the real capturePanes drop). Same shape as
// state-transition.test.js's `capture`, adapted to tickAttention's 2-arg call.
const capture = (panesByKey) => async (_chats, _cfg) => panesByKey;

// fetch recorder — absorbs the fire-and-forget webhook dispatch so the logging test
// never touches the network. Returns ok; the dispatch's .catch swallows any error.
function fetchRec() {
  const calls = [];
  const fn = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200 }; };
  fn.count = () => calls.length;
  return fn;
}

describe('WARDEN-788 — tickAttention (60s webhook sweep) logs state_changed', () => {
  let originalHome, tempHome;
  let tickAttention, pollAgentStates, __resetLastLoggedStateForTest, readEvents, clearEvents;

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-tick-attn-state-'));
    process.env.HOME = tempHome;
    const wdir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wdir, { recursive: true });
    // Webhook channel ON + attention routing ON so tickAttention's gate passes and the
    // sweep actually classifies. Seeded via the config file (load() = {...DEFAULTS, ...raw}),
    // NOT an HTTP PUT — no server is started, so the 60s attention interval never arms
    // (startAttentionPoll runs only out of startServer, which tests never invoke).
    fs.writeFileSync(
      path.join(wdir, 'config.json'),
      JSON.stringify({ hosts: [], webhookEnabled: true, webhookUrl: 'https://ntfy.example.local/x', webhookAlertAttention: true }) + '\n',
    );
    fs.writeFileSync(path.join(wdir, 'activity.jsonl'), '', 'utf8');

    const server = await import('./server.js');
    ({ tickAttention, pollAgentStates, __resetLastLoggedStateForTest } = server);
    ({ readEvents, clearEvents } = await import('./activity.js'));
  });

  after(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  beforeEach(() => {
    __resetLastLoggedStateForTest();
    clearEvents();
  });

  const stateEvents = async () => (await readEvents()).filter((e) => e.type === 'state_changed');

  it('first sweep writes a from:null baseline into the log via the INLINE classify', async () => {
    // NOTE: no deps.pollAgentStates → the inline classify branch runs (the production
    // path). Canned panes flow through deps.capturePanes. This is the exact path the
    // reviewer found was silent.
    await tickAttention({
      chats: [yatfa('sweep-a')],
      capturePanes: capture({ 'sweep-a': stuckPane }),
      fetchImpl: fetchRec(),
    });
    const ev = await stateEvents();
    assert.strictEqual(ev.length, 1, 'baseline logged on first observation');
    assert.strictEqual(ev[0].from, null, 'first observation is from:null (baseline)');
    assert.strictEqual(ev[0].to, 'stuck');
    assert.strictEqual(ev[0].container, 'sweep-a');
    assert.strictEqual(ev[0].host, 'hostA');
    assert.strictEqual(ev[0].role, 'worker');
  });

  it('a genuine transition across two sweeps appends EXACTLY one state_changed', async () => {
    // Sweep 1: stuck (baseline). Sweep 2: idle (transition stuck→idle).
    await tickAttention({ chats: [yatfa('sweep-b')], capturePanes: capture({ 'sweep-b': stuckPane }), fetchImpl: fetchRec() });
    await tickAttention({ chats: [yatfa('sweep-b')], capturePanes: capture({ 'sweep-b': idlePane }), fetchImpl: fetchRec() });
    const ev = await stateEvents();
    assert.strictEqual(ev.length, 2, 'baseline + one transition');
    // Assert by value (back-to-back writes can tie on the ms sort — see state-transition.test.js).
    assert.ok(ev.find((e) => e.from === null && e.to === 'stuck'), 'first sweep logged the stuck baseline');
    assert.ok(ev.find((e) => e.from === 'stuck' && e.to === 'idle'), 'second sweep logged exactly one stuck→idle transition');
  });

  it('a repeated same-state sweep appends NOTHING (no per-sweep spam)', async () => {
    await tickAttention({ chats: [yatfa('sweep-c')], capturePanes: capture({ 'sweep-c': stuckPane }), fetchImpl: fetchRec() });
    await tickAttention({ chats: [yatfa('sweep-c')], capturePanes: capture({ 'sweep-c': stuckPane }), fetchImpl: fetchRec() });
    await tickAttention({ chats: [yatfa('sweep-c')], capturePanes: capture({ 'sweep-c': stuckPane }), fetchImpl: fetchRec() });
    assert.strictEqual((await stateEvents()).length, 1, 'three same-state sweeps → only the baseline');
  });

  it('capture_failed is logged as a genuine state change (reachable → unreachable)', async () => {
    // Pane key absent from the capture result → capture_failed (host SSH failed).
    await tickAttention({ chats: [yatfa('sweep-d')], capturePanes: capture({}), fetchImpl: fetchRec() });
    const ev = await stateEvents();
    assert.strictEqual(ev.length, 1);
    assert.strictEqual(ev[0].to, 'capture_failed');
    assert.strictEqual(ev[0].from, null);
  });

  it('a manual/tmux chat (no container) writes NO state_changed event', async () => {
    await tickAttention({ chats: [manual('sweep-m')], capturePanes: capture({ 'sweep-m': stuckPane }), fetchImpl: fetchRec() });
    assert.strictEqual((await stateEvents()).length, 0, 'manual chats carry no timeline row → not logged');
  });

  it('shares the dedup map with pollAgentStates: a transition the dashboard poll logs is NOT re-logged by the webhook sweep (cross-path dedup)', async () => {
    // THE Finding 1 scenario: the dashboard's /api/agent-states (pollAgentStates) and
    // the 60s server-side sweep (tickAttention inline) both classify the SAME agent
    // while the window is open. They must share the key-keyed lastLoggedState map so a
    // transition observed by one is not re-logged by the other on its next tick.
    // pollAgentStates establishes the stuck baseline.
    await pollAgentStates([yatfa('sweep-e')], {}, { capturePanes: (async (_c, _cfg) => ({ 'sweep-e': stuckPane })) });
    // tickAttention's INLINE classify then sees the SAME agent in the SAME state.
    await tickAttention({ chats: [yatfa('sweep-e')], capturePanes: capture({ 'sweep-e': stuckPane }), fetchImpl: fetchRec() });
    assert.strictEqual((await stateEvents()).length, 1, 'pollAgentStates baseline only — the sweep did NOT double-log the same state');
  });

  it('when the dashboard is CLOSED (no client polls), the server-side sweep STILL records a transition — the headline use case', async () => {
    // The whole point of the fix: with the window closed to tray, pollAgentStates
    // (client-driven) never runs. tickAttention is the ONLY classifier still running.
    // Two sweeps — stuck then idle — must produce the baseline + the transition even
    // though pollAgentStates is never called.
    await tickAttention({ chats: [yatfa('sweep-f')], capturePanes: capture({ 'sweep-f': stuckPane }), fetchImpl: fetchRec() });
    await tickAttention({ chats: [yatfa('sweep-f')], capturePanes: capture({ 'sweep-f': idlePane }), fetchImpl: fetchRec() });
    const ev = await stateEvents();
    assert.strictEqual(ev.length, 2, 'closed-dashboard history is still recorded by the server-side sweep');
    assert.ok(ev.find((e) => e.from === null && e.to === 'stuck'));
    assert.ok(ev.find((e) => e.from === 'stuck' && e.to === 'idle'), 'the stuck→idle oscillation is visible in the log');
  });
});
