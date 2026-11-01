import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * WARDEN-2069 — pins that the state_changed diff baseline (agentStatePoll.js
 * `logAgentState`) is keyed by the HOST-QUALIFIED chat id (`c.id`), not the bare
 * key. Two hosts running a SAME-NAMED container (WARDEN-1223) must keep
 * independent baselines; with a bare-key baseline, hostB's first observation is
 * deduped away (same state) or gets hostA's state as its `from` (differing state),
 * and differing-state hosts log a spurious transition on every poll.
 *
 * Harness mirrors state-transition.test.js: HOME-isolated, REAL pollAgentStates,
 * REAL activity store, capturePanes injected and keyed by the chat id.
 */
const STUCK_LINE = 'stuck loop repeating the same output line over and over again';
const stuckPane = Array(7).fill(STUCK_LINE).join('\n');
const idlePane = '';

// Same container/key on two hosts: `id` differs (host:key), `key` is identical.
const onHost = (host, key = 'worker-1') => ({
  id: `${host}:${key}`, key, container: key, session: null, host, role: 'worker', project: 'p', name: key, active: true,
});

describe('WARDEN-2069 — state_changed baseline is keyed by host-qualified id', () => {
  let originalHome, tempHome;
  let pollAgentStates, __resetLastLoggedStateForTest, readEvents, clearEvents;

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-state-host-baseline-'));
    process.env.HOME = tempHome;
    const wdir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wdir, { recursive: true });
    fs.writeFileSync(path.join(wdir, 'config.json'), JSON.stringify({ hosts: [] }) + '\n');
    fs.writeFileSync(path.join(wdir, 'activity.jsonl'), '', 'utf8');

    ({ pollAgentStates, __resetLastLoggedStateForTest } = await import('./server.js'));
    ({ readEvents, clearEvents } = await import('./activity.js'));
  });

  after(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  beforeEach(async () => {
    __resetLastLoggedStateForTest();
    await clearEvents();
  });

  const stateEvents = async () => (await readEvents()).filter((e) => e.type === 'state_changed');

  // capturePanes keyed by the HOST-QUALIFIED chat id → pane content.
  const capture = (panesById) => async (chats) => Object.fromEntries(chats
    .filter((c) => Object.prototype.hasOwnProperty.call(panesById, c.id))
    .map((c) => [c.id, panesById[c.id]]));

  const poll = (panesById) => pollAgentStates(
    [onHost('hostA'), onHost('hostB')], {}, { capturePanes: capture(panesById) });

  it('same container on two hosts in the SAME state → two from:null baselines, one per host', async () => {
    await poll({ 'hostA:worker-1': stuckPane, 'hostB:worker-1': stuckPane });
    const ev = await stateEvents();
    assert.strictEqual(ev.length, 2, 'each host gets its own baseline (hostB is not deduped against hostA)');
    for (const host of ['hostA', 'hostB']) {
      const e = ev.find((x) => x.host === host);
      assert.ok(e, `${host} has its own state_changed baseline`);
      assert.strictEqual(e.from, null);
      assert.strictEqual(e.to, 'stuck');
    }
  });

  it("hostB's first observation is from:null, not hostA's state", async () => {
    await poll({ 'hostA:worker-1': stuckPane, 'hostB:worker-1': idlePane });
    const ev = await stateEvents();
    const b = ev.find((x) => x.host === 'hostB');
    assert.ok(b, 'hostB logged an event');
    assert.strictEqual(b.from, null, "hostB's baseline must not inherit hostA's 'stuck'");
    assert.strictEqual(b.to, 'idle');
  });

  it('hostA stuck + hostB idle polled 3× → exactly 2 events, no spurious transitions', async () => {
    for (let i = 0; i < 3; i++) {
      await poll({ 'hostA:worker-1': stuckPane, 'hostB:worker-1': idlePane });
    }
    const ev = await stateEvents();
    assert.strictEqual(ev.length, 2, 'two baselines only — no per-poll stuck↔idle flapping across hosts');
    assert.ok(ev.every((e) => e.from === null), 'every event is a baseline');
  });
});
