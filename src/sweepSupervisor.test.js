// Direct spec for createSweepSupervisor (WARDEN-1169/1610, ticket WARDEN-1624).
// Before this file the factory was only covered incidentally through server.js's
// budget/lifecycle sweeps, so its start/stop/restart/settled semantics were
// unpinned. Every test names the specific behavior it asserts; mock timers mean
// nothing waits in real time.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createSweepSupervisor } from './sweepSupervisor.js';
import { loopMonitor } from './loop-monitor.js';

const INTERVAL = 1000;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function setup(t, opts = {}) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const calls = { tick: 0, onEnable: 0, onDisable: 0 };
  const sup = createSweepSupervisor({
    name: 'unit',
    intervalMs: INTERVAL,
    tick: async () => { calls.tick += 1; },
    ...opts,
  });
  return { sup, calls };
}

describe('start() / stop()', () => {
  test('start arms the interval and kicks once immediately; each interval ticks again', (t) => {
    const { sup, calls } = setup(t);
    sup.start();
    assert.equal(calls.tick, 1, 'seed kick runs immediately');
    t.mock.timers.tick(INTERVAL);
    assert.equal(calls.tick, 2);
    t.mock.timers.tick(INTERVAL);
    assert.equal(calls.tick, 3);
    sup.stop();
  });

  test('the interval cadence is exactly intervalMs (not a multiple of it)', (t) => {
    const { sup, calls } = setup(t);
    sup.start();
    t.mock.timers.tick(INTERVAL - 1);
    assert.equal(calls.tick, 1, 'nothing fires before the interval elapses');
    t.mock.timers.tick(1);
    assert.equal(calls.tick, 2, 'fires at intervalMs');
    sup.stop();
  });

  test('stop clears the interval so no further ticks run', (t) => {
    const { sup, calls } = setup(t);
    sup.start();
    sup.stop();
    t.mock.timers.tick(INTERVAL * 5);
    assert.equal(calls.tick, 1, 'only the seed kick ran');
  });

  test('stop then start re-arms the interval and kicks again', (t) => {
    const { sup, calls } = setup(t);
    sup.start();
    sup.stop();
    sup.start();
    assert.equal(calls.tick, 2, 'start after stop re-kicks');
    t.mock.timers.tick(INTERVAL);
    assert.equal(calls.tick, 3, 'and the interval is live again');
    sup.stop();
  });

  test('a double start (non-once) arms exactly ONE interval but re-kicks', (t) => {
    const { sup, calls } = setup(t);
    sup.start();
    sup.start();
    assert.equal(calls.tick, 2, 'each start re-kicks');
    t.mock.timers.tick(INTERVAL);
    assert.equal(calls.tick, 3, 'one interval, not two');
    sup.stop();
    t.mock.timers.tick(INTERVAL * 3);
    assert.equal(calls.tick, 3, 'a single stop clears everything (no leaked interval)');
  });

  test('stop on a never-started supervisor is a harmless no-op', (t) => {
    const { sup, calls } = setup(t);
    sup.stop();
    t.mock.timers.tick(INTERVAL * 2);
    assert.equal(calls.tick, 0);
  });
});

describe('startOnce', () => {
  test('a second start with a live timer is a no-op (no re-kick, no second interval)', (t) => {
    const { sup, calls } = setup(t, { startOnce: true });
    sup.start();
    sup.start();
    assert.equal(calls.tick, 1, 'second start must not re-kick a live sweep');
    t.mock.timers.tick(INTERVAL);
    assert.equal(calls.tick, 2, 'still exactly one interval');
    sup.stop();
  });

  test('the first start of a startOnce supervisor does start', (t) => {
    const { sup, calls } = setup(t, { startOnce: true });
    sup.start();
    assert.equal(calls.tick, 1);
    sup.stop();
  });

  test('after stop(), a startOnce supervisor starts again', (t) => {
    const { sup, calls } = setup(t, { startOnce: true });
    sup.start();
    sup.stop();
    sup.start();
    assert.equal(calls.tick, 2, 'timer was nulled by stop, so the guard lets start through');
    t.mock.timers.tick(INTERVAL);
    assert.equal(calls.tick, 3);
    sup.stop();
  });
});

describe('restart()', () => {
  test('with an enabled gate returning true: arms, fires onEnable, and kicks now', (t) => {
    const flag = { on: true };
    const calls = { onEnable: 0, onDisable: 0 };
    const { sup, calls: c } = setup(t, {
      enabled: () => flag.on,
      onEnable: () => { calls.onEnable += 1; },
      onDisable: () => { calls.onDisable += 1; },
    });
    sup.restart();
    assert.equal(calls.onEnable, 1);
    assert.equal(calls.onDisable, 0);
    assert.equal(c.tick, 1, 'enable kicks a sweep immediately');
    t.mock.timers.tick(INTERVAL);
    assert.equal(c.tick, 2, 'and the interval is armed');
    sup.stop();
  });

  test('restart while already armed does not arm a second interval', (t) => {
    const { sup, calls } = setup(t, { enabled: () => true });
    sup.restart();
    sup.restart();
    assert.equal(calls.tick, 2, 'each restart kicks');
    t.mock.timers.tick(INTERVAL);
    assert.equal(calls.tick, 3, 'but only one interval exists');
    sup.stop();
  });

  test('disable leg with a live timer disarms and fires onDisable once', (t) => {
    const flag = { on: true };
    const calls = { onEnable: 0, onDisable: 0 };
    const { sup, calls: c } = setup(t, {
      enabled: () => flag.on,
      onEnable: () => { calls.onEnable += 1; },
      onDisable: () => { calls.onDisable += 1; },
    });
    sup.restart();
    flag.on = false;
    sup.restart();
    assert.equal(calls.onDisable, 1);
    assert.equal(calls.onEnable, 1, 'onEnable does not fire on the disable leg');
    t.mock.timers.tick(INTERVAL * 3);
    assert.equal(c.tick, 1, 'timer was cleared — no ticks after disable');
  });

  test('disable leg with NO timer fires nothing (onDisable is not repeated)', (t) => {
    const calls = { onEnable: 0, onDisable: 0 };
    const { sup, calls: c } = setup(t, {
      enabled: () => false,
      onEnable: () => { calls.onEnable += 1; },
      onDisable: () => { calls.onDisable += 1; },
    });
    sup.restart();
    sup.restart();
    assert.equal(calls.onDisable, 0);
    assert.equal(calls.onEnable, 0);
    assert.equal(c.tick, 0, 'a disabled sweep never kicks nor arms');
    t.mock.timers.tick(INTERVAL * 2);
    assert.equal(c.tick, 0);
  });

  test('onDisable fires only on the transition: enable, disable, disable', (t) => {
    const flag = { on: true };
    const calls = { onDisable: 0 };
    const { sup } = setup(t, {
      enabled: () => flag.on,
      onDisable: () => { calls.onDisable += 1; },
    });
    sup.restart();
    flag.on = false;
    sup.restart();
    sup.restart();
    assert.equal(calls.onDisable, 1);
  });

  test('re-enable after disable re-arms the interval (disarm nulled the timer)', (t) => {
    const flag = { on: true };
    const { sup, calls } = setup(t, { enabled: () => flag.on });
    sup.restart();
    flag.on = false;
    sup.restart();
    flag.on = true;
    sup.restart();
    assert.equal(calls.tick, 2, 'enable kicks again');
    t.mock.timers.tick(INTERVAL);
    assert.equal(calls.tick, 3, 'interval live again');
    sup.stop();
  });

  test('with no enabled gate, restart always enables (arm + onEnable + kick)', (t) => {
    const calls = { onEnable: 0, onDisable: 0 };
    const { sup, calls: c } = setup(t, {
      onEnable: () => { calls.onEnable += 1; },
      onDisable: () => { calls.onDisable += 1; },
    });
    sup.restart();
    assert.equal(calls.onEnable, 1);
    assert.equal(calls.onDisable, 0);
    assert.equal(c.tick, 1);
    t.mock.timers.tick(INTERVAL);
    assert.equal(c.tick, 2);
    sup.stop();
  });

  test('missing onEnable/onDisable callbacks are tolerated on both legs', (t) => {
    const flag = { on: true };
    const { sup } = setup(t, { enabled: () => flag.on });
    sup.restart();
    flag.on = false;
    assert.doesNotThrow(() => sup.restart());
  });
});

describe('guardKick', () => {
  test('default: a rejecting tick is swallowed — no unhandledRejection, settled() resolves', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const unhandled = [];
    const onUnhandled = (err) => { unhandled.push(err); };
    process.on('unhandledRejection', onUnhandled);
    t.after(() => process.off('unhandledRejection', onUnhandled));
    const sup = createSweepSupervisor({
      name: 'rejecting',
      intervalMs: INTERVAL,
      tick: async () => { throw new Error('boom'); },
    });
    sup.start();
    await sup.settled();
    // Let the event loop deliver any would-be unhandledRejection.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(unhandled, []);
    sup.stop();
  });

  test('guardKick:false: the kick is a bare trace — rejection identity is preserved', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const err = new Error('raw');
    const returned = [];
    const orig = loopMonitor.trace.bind(loopMonitor);
    t.mock.method(loopMonitor, 'trace', (label, fn) => {
      const p = orig(label, fn);
      // Swallow on a branch so the test process never sees an unhandled rejection;
      // the kick's own returned promise is what we inspect.
      p.catch(() => {});
      returned.push(p);
      return p;
    });
    const sup = createSweepSupervisor({
      name: 'raw',
      intervalMs: INTERVAL,
      guardKick: false,
      tick: async () => { throw err; },
    });
    sup.start();
    assert.equal(returned.length, 1);
    await assert.rejects(returned[0], (e) => e === err, 'same rejection identity, no .catch attached by the kick');
    sup.stop();
  });

  test('guardKick:false has no in-flight handle: settled() does not await the kicked tick', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const d = deferred();
    const sup = createSweepSupervisor({
      name: 'noflight',
      intervalMs: INTERVAL,
      guardKick: false,
      tick: () => d.promise,
    });
    sup.start();
    let settled = false;
    sup.settled().then(() => { settled = true; });
    await new Promise((r) => setImmediate(r));
    assert.equal(settled, true);
    d.resolve();
    sup.stop();
  });

  test('guardKick default is ON: a rejecting tick does not reject the traced kick', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const sup = createSweepSupervisor({
      name: 'default-guard',
      intervalMs: INTERVAL,
      tick: async () => { throw new Error('x'); },
    });
    sup.start();
    await assert.doesNotReject(sup.settled());
    sup.stop();
  });
});

describe('trace label', () => {
  test('kicks are traced under sweep:<name> (guarded arm)', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const labels = [];
    t.mock.method(loopMonitor, 'trace', (label, fn) => { labels.push(label); return Promise.resolve(fn()); });
    const sup = createSweepSupervisor({ name: 'alpha', intervalMs: INTERVAL, tick: async () => {} });
    sup.start();
    t.mock.timers.tick(INTERVAL);
    assert.deepEqual(labels, ['sweep:alpha', 'sweep:alpha']);
    sup.stop();
  });

  test('kicks are traced under sweep:<name> (unguarded arm)', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const labels = [];
    t.mock.method(loopMonitor, 'trace', (label, fn) => { labels.push(label); return Promise.resolve(fn()); });
    const sup = createSweepSupervisor({ name: 'beta', intervalMs: INTERVAL, guardKick: false, tick: async () => {} });
    sup.start();
    assert.deepEqual(labels, ['sweep:beta']);
    sup.stop();
  });
});

describe('settled()', () => {
  test('resolves immediately when nothing is in flight', async (t) => {
    const { sup } = setup(t);
    await sup.settled();
  });

  test('awaits the in-flight kicked tick', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const d = deferred();
    const sup = createSweepSupervisor({ name: 's', intervalMs: INTERVAL, tick: () => d.promise });
    sup.start();
    let settled = false;
    sup.settled().then(() => { settled = true; });
    await new Promise((r) => setImmediate(r));
    assert.equal(settled, false, 'still pending while the tick runs');
    d.resolve();
    await sup.settled();
    await new Promise((r) => setImmediate(r));
    assert.equal(settled, true);
    sup.stop();
  });

  test('spins while isRunning() stays true, then resolves once it clears', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const state = { running: true };
    const sup = createSweepSupervisor({
      name: 'spin',
      intervalMs: INTERVAL,
      tick: async () => {},
      isRunning: () => state.running,
    });
    let settled = false;
    sup.settled().then(() => { settled = true; });
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
    assert.equal(settled, false, 'blocked by the tick-owned re-entrancy flag');
    state.running = false;
    for (let i = 0; i < 3; i += 1) await new Promise((r) => setImmediate(r));
    assert.equal(settled, true);
  });

  test('overlapping kicks: an older kick finishing must not clear the newer in-flight handle', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const first = deferred();
    const second = deferred();
    const queue = [first, second];
    const sup = createSweepSupervisor({
      name: 'overlap',
      intervalMs: INTERVAL,
      tick: () => queue.shift().promise,
    });
    sup.start();
    sup.start();
    first.resolve();
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
    let settled = false;
    sup.settled().then(() => { settled = true; });
    await new Promise((r) => setImmediate(r));
    assert.equal(settled, false, 'still waiting on the second kick');
    second.resolve();
    await sup.settled();
    await new Promise((r) => setImmediate(r));
    assert.equal(settled, true);
    sup.stop();
  });
});
