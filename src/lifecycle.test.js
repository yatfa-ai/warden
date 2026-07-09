import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildSnapshot, diffLifecycles } from './lifecycle.js';

// Helpers — build raw chat objects (the shape discoverAll() returns) and
// snapshot rows. Tests construct snapshots directly so the DIFF logic is
// exercised in isolation, then a separate group drives the full
// buildSnapshot→diffLifecycles pipeline for the cross-cutting failure scenario.

function chat(id, { host = 'hostA', container = id, role = 'worker', project = 'p', active = true } = {}) {
  return { id, host, container, role, project, active };
}
function row(id, { host = 'hostA', container = id, role = 'worker', project = 'p', active = true, ok = true } = {}) {
  return { id, host, container, role, project, active, ok };
}
const map = (...rows) => new Map(rows.map((r) => [r.id, r]));
const types = (events) => events.map((e) => e.type);

describe('diffLifecycles — appeared / disappeared', () => {
  it('emits agent_started when a chat appears', () => {
    const prev = map(row('hostA:c1'));
    const next = map(row('hostA:c1'), row('hostB:c2', { host: 'hostB' }));
    const events = diffLifecycles(prev, next);
    assert.deepStrictEqual(types(events), ['agent_started']);
    assert.strictEqual(events[0].id, 'hostB:c2');
    assert.strictEqual(events[0].host, 'hostB');
    assert.strictEqual(events[0].container, 'hostB:c2');
    assert.strictEqual(events[0].role, 'worker');
  });

  it('emits agent_ended when a chat disappears and its host is reachable', () => {
    const prev = map(row('hostA:c1'), row('hostB:c2', { host: 'hostB' }));
    const next = map(row('hostA:c1'));
    const events = diffLifecycles(prev, next);
    assert.deepStrictEqual(types(events), ['agent_ended']);
    assert.strictEqual(events[0].id, 'hostB:c2');
  });

  it('does NOT emit agent_ended for a chat whose host is failing (ok:false carry-forward)', () => {
    // hostB failed this tick → its chat is carried forward into `next` with
    // ok:false (exactly what buildSnapshot produces). It must NOT vanish.
    const prev = map(row('hostA:c1'), row('hostB:c2', { host: 'hostB', ok: true }));
    const next = map(row('hostA:c1'), row('hostB:c2', { host: 'hostB', ok: false }));
    const events = diffLifecycles(prev, next);
    // host_error (ok flipped), but NO agent_ended for c2.
    assert.ok(!types(events).includes('agent_ended'), 'must not emit agent_ended during host failure');
    assert.ok(types(events).includes('host_error'));
  });

  it('emits nothing when snapshots are identical', () => {
    const snap = map(row('hostA:c1'), row('hostA:c2'));
    assert.deepStrictEqual(diffLifecycles(snap, snap), []);
  });
});

describe('diffLifecycles — tmux session up/down (active flip)', () => {
  it('emits agent_session_down when active goes true → false', () => {
    const prev = map(row('hostA:c1', { active: true }));
    const next = map(row('hostA:c1', { active: false }));
    assert.deepStrictEqual(types(diffLifecycles(prev, next)), ['agent_session_down']);
  });

  it('emits agent_session_up when active goes false → true', () => {
    const prev = map(row('hostA:c1', { active: false }));
    const next = map(row('hostA:c1', { active: true }));
    assert.deepStrictEqual(types(diffLifecycles(prev, next)), ['agent_session_up']);
  });

  it('does NOT flip on an ok:false carry-forward (prior active retained during outage)', () => {
    // hostB failing: row carried forward with ok:false and the SAME active.
    // Even though ok flipped, no session event must fire (state is unknown).
    const prev = map(row('hostB:c1', { host: 'hostB', active: true, ok: true }));
    const next = map(row('hostB:c1', { host: 'hostB', active: true, ok: false }));
    const events = diffLifecycles(prev, next);
    assert.ok(!types(events).includes('agent_session_up'), 'no session event during outage');
    assert.ok(!types(events).includes('agent_session_down'));
    assert.ok(types(events).includes('host_error'));
  });
});

describe('diffLifecycles — host reachability transitions', () => {
  it('emits host_error ONCE per failing host, regardless of agent count', () => {
    // hostB has 3 agents; discovery fails → all 3 carried forward ok:false.
    const prev = map(
      row('hostA:c1'),
      row('hostB:c1', { host: 'hostB', ok: true }),
      row('hostB:c2', { host: 'hostB', ok: true }),
      row('hostB:c3', { host: 'hostB', ok: true }),
    );
    const next = map(
      row('hostA:c1'),
      row('hostB:c1', { host: 'hostB', ok: false }),
      row('hostB:c2', { host: 'hostB', ok: false }),
      row('hostB:c3', { host: 'hostB', ok: false }),
    );
    const errs = diffLifecycles(prev, next).filter((e) => e.type === 'host_error');
    assert.strictEqual(errs.length, 1, 'one host_error per failing host');
    assert.strictEqual(errs[0].host, 'hostB');
    assert.strictEqual(errs[0].container, undefined, 'host-level event has no container');
  });

  it('emits host_ok ONCE when a host recovers', () => {
    const prev = map(row('hostB:c1', { host: 'hostB', ok: false }));
    const next = map(row('hostB:c1', { host: 'hostB', ok: true }));
    const events = diffLifecycles(prev, next);
    assert.deepStrictEqual(types(events), ['host_ok']);
    assert.strictEqual(events[0].host, 'hostB');
  });

  it('does not re-emit host_error while a host stays failing', () => {
    const failing = map(row('hostB:c1', { host: 'hostB', ok: false }));
    assert.deepStrictEqual(diffLifecycles(failing, failing), []);
  });
});

describe('diffLifecycles — first run (empty prev)', () => {
  it('emits agent_started for every discovered chat when prev is empty', () => {
    // Documents the burst the server SUPPRESSES by seeding prevSnapshot from the
    // first discovery without emitting (see startLifecyclePoll in server.js).
    const next = map(row('hostA:c1'), row('hostB:c2', { host: 'hostB' }));
    const events = diffLifecycles(new Map(), next);
    assert.deepStrictEqual(types(events), ['agent_started', 'agent_started']);
  });
});

describe('buildSnapshot', () => {
  it('maps discovered chats with ok:true and coerces active to boolean', () => {
    const snap = buildSnapshot(new Map(), [
      chat('hostA:c1', { active: 1 }),
      chat('hostA:c2', { active: 0 }),
    ], new Set());
    assert.strictEqual(snap.size, 2);
    assert.strictEqual(snap.get('hostA:c1').ok, true);
    assert.strictEqual(snap.get('hostA:c2').ok, true);
    assert.strictEqual(snap.get('hostA:c1').active, true);
    assert.strictEqual(snap.get('hostA:c2').active, false);
  });

  it('carries forward chats on FAILING hosts with ok:false', () => {
    const prev = map(
      row('hostA:c1'),
      row('hostB:c1', { host: 'hostB' }),
    );
    // This tick: only hostA discovered; hostB failed.
    const snap = buildSnapshot(prev, [chat('hostA:c1')], new Set(['hostB']));
    assert.ok(snap.has('hostB:c1'), 'failing-host chat carried forward');
    assert.strictEqual(snap.get('hostB:c1').ok, false, 'carried-forward row is ok:false');
    assert.strictEqual(snap.get('hostA:c1').ok, true);
  });

  it('does NOT carry forward chats when their host is reachable', () => {
    const prev = map(row('hostB:gone', { host: 'hostB' }));
    // hostB reachable this tick but the chat vanished → must NOT be carried.
    const snap = buildSnapshot(prev, [chat('hostA:c1')], new Set());
    assert.ok(!snap.has('hostB:gone'), 'real disappearance is not rescued');
  });

  it('does not duplicate a chat that is both discovered and on a failing host set', () => {
    // Defensive: if a host somehow appears in failingHosts yet a chat was still
    // discovered, the discovered (ok:true) row wins.
    const prev = map(row('hostA:c1'));
    const snap = buildSnapshot(prev, [chat('hostA:c1')], new Set(['hostA']));
    assert.strictEqual(snap.get('hostA:c1').ok, true);
    assert.strictEqual(snap.size, 1);
  });

  it('first-run (empty prev) just maps discovered chats — nothing to carry forward', () => {
    const snap = buildSnapshot(new Map(), [chat('hostA:c1'), chat('hostA:c2')], new Set(['hostB']));
    assert.strictEqual(snap.size, 2);
    for (const r of snap.values()) assert.strictEqual(r.ok, true);
  });
});

// End-to-end pipeline: this is the exact sequence src/server.js runs each tick.
// Pins down the critical "transient SSH failure emits no false agent_ended"
// behavior across the buildSnapshot → diffLifecycles boundary.
describe('pipeline (buildSnapshot → diffLifecycles) — transient host failure', () => {
  it('does not record agent_ended when a host blips down then recovers', () => {
    // Tick 1: hostA + hostB both up, one agent each. Seed silently (server does).
    const seed = buildSnapshot(new Map(), [
      chat('hostA:c1'),
      chat('hostB:c1', { host: 'hostB' }),
    ], new Set());
    let prev = seed;
    assert.deepStrictEqual(diffLifecycles(new Map(), seed).filter((e) => e.type === 'agent_started').length, 2,
      'baseline seed would burst (server suppresses)');

    // Tick 2: hostB SSH fails (errors: ['hostB']). Its chat is absent from chats.
    const nextDown = buildSnapshot(prev, [chat('hostA:c1')], new Set(['hostB']));
    const downEvents = diffLifecycles(prev, nextDown);
    assert.ok(!types(downEvents).includes('agent_ended'), 'hostB agent must NOT end on a blip');
    assert.ok(types(downEvents).includes('host_error'), 'hostB failure is surfaced');
    prev = nextDown;

    // Tick 3: hostB recovers, agent still running.
    const nextUp = buildSnapshot(prev, [
      chat('hostA:c1'),
      chat('hostB:c1', { host: 'hostB' }),
    ], new Set());
    const upEvents = diffLifecycles(prev, nextUp);
    assert.ok(!types(upEvents).includes('agent_ended'), 'still no false end on recovery');
    assert.ok(!types(upEvents).includes('agent_started'), 'carried-forward chat does not "re-start"');
    assert.ok(types(upEvents).includes('host_ok'), 'recovery is surfaced');
  });

  it('records agent_ended only when the agent is genuinely gone', () => {
    const prev = buildSnapshot(new Map(), [
      chat('hostA:c1'),
      chat('hostB:c1', { host: 'hostB' }),
    ], new Set());
    // hostB reachable, but its container was removed → real disappearance.
    const next = buildSnapshot(prev, [chat('hostA:c1')], new Set());
    const events = diffLifecycles(prev, next);
    assert.deepStrictEqual(types(events), ['agent_ended']);
    assert.strictEqual(events[0].id, 'hostB:c1');
  });
});
