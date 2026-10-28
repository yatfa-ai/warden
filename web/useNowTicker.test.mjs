// Tests for web/src/lib/useNowTicker.ts — the shared once-per-second "now" clock
// behind both Observer live feeds (ActivityTimeline / DirectiveHistory, WARDEN-1419).
// Its two readers (`formatUpdatedAgo` and `dayBucket`) must agree, so the hook is
// the single clock; a regression silently freezes the "Updated Ns ago" label and the
// day-bucket headings, or leaks one interval per render. Nothing referenced it.
//
// LEGS: lazy seed (initializer runs once, first render is live Date.now()); exactly
// one setInterval(…, 1000) on mount; each tick publishes the CURRENT Date.now() (also
// after a wall-clock jump, i.e. not prev+1000); no update before a full second;
// re-render neither re-registers nor clears the interval (empty deps); unmount clears
// the very id it created and ticks stop.
//
// HARNESS (same seam-first shape as useWatchCatchup.test.mjs): the REAL hook is
// transpiled with vite's transformWithOxc and `react` is rewritten onto a slot-based
// useState/useEffect shim (the rewrite is ASSERTED — the real react's hooks throw
// outside a renderer, so a missed rewrite fails loudly). Date.now, setInterval and
// clearInterval are fake globals.
//
// Run: node useNowTicker.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tmpDir = mkdtempSync(join(__dirname, '.use-now-ticker-test-'));

writeFileSync(
  join(tmpDir, 'react-shim.mjs'),
  `
let current = null;
export const __aim = (inst) => { current = inst; };
const depsChanged = (deps, prev) =>
  prev === undefined || deps === undefined || deps.length !== prev.length || deps.some((d, i) => !Object.is(d, prev[i]));
export function useState(initial) {
  const self = current;
  const slot = self.cursor++;
  if (self.slots.length <= slot) {
    self.initializerCalls += typeof initial === 'function' ? 1 : 0;
    self.slots.push({ value: typeof initial === 'function' ? initial() : initial });
  }
  const cell = self.slots[slot];
  return [cell.value, (next) => {
    cell.value = typeof next === 'function' ? next(cell.value) : next;
    if (self.flushing) self.dirty = true;
    else self.render();
  }];
}
export function useEffect(fn, deps) {
  const self = current;
  const slot = self.cursor++;
  if (self.slots.length <= slot) self.slots.push({ deps: undefined, cleanup: null });
  const cell = self.slots[slot];
  if (depsChanged(deps, cell.deps)) {
    cell.deps = deps;
    self.pendingEffects.push(cell, fn);
  }
}
`,
);

const srcPath = resolve(__dirname, 'src/lib/useNowTicker.ts');
const { code } = await transformWithOxc(readFileSync(srcPath, 'utf8'), srcPath, {});
const rewritten = code.replaceAll('"react"', '"./react-shim.mjs"').replaceAll("'react'", "'./react-shim.mjs'");
assert.notEqual(rewritten, code, 'react specifier rewrite did not land in useNowTicker.ts');
assert.ok(!/from ['"]react['"]/.test(rewritten), 'useNowTicker still imports the real react');
writeFileSync(join(tmpDir, 'useNowTicker.mjs'), rewritten);

const { useNowTicker } = await import(join(tmpDir, 'useNowTicker.mjs'));
const { __aim: aimShim } = await import(join(tmpDir, 'react-shim.mjs'));
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// --- Fake clock + timers -----------------------------------------------------
const clock = { now: 1_000_000, nowCalls: 0 };
const timers = { nextId: 100, active: new Map(), set: [], cleared: [] };
const reset = () => {
  clock.now = 1_000_000;
  clock.nowCalls = 0;
  timers.nextId = 100;
  timers.active = new Map();
  timers.set = [];
  timers.cleared = [];
};
Date.now = () => {
  clock.nowCalls += 1;
  return clock.now;
};
globalThis.setInterval = (fn, ms) => {
  const id = timers.nextId++;
  timers.active.set(id, { fn, ms });
  timers.set.push({ id, ms });
  return id;
};
globalThis.clearInterval = (id) => {
  timers.cleared.push(id);
  timers.active.delete(id);
};
// Fire every live interval once (a "second" elapsing is the caller's job via clock.now).
const fireTimers = () => {
  for (const t of [...timers.active.values()]) t.fn();
};

// --- Driver (effects flush after the frame; cleanup of the previous run first) ---
const mountHook = (runHook) => {
  const inst = {
    slots: [],
    pendingEffects: [],
    cursor: 0,
    renders: 0,
    initializerCalls: 0,
    state: null,
    flushing: false,
    dirty: false,
    render: null,
    unmount: null,
  };
  inst.render = () => {
    do {
      inst.dirty = false;
      aimShim(inst);
      inst.cursor = 0;
      inst.renders += 1;
      inst.state = runHook();
      const queued = inst.pendingEffects;
      inst.pendingEffects = [];
      inst.flushing = true;
      try {
        for (let i = 0; i < queued.length; i += 2) {
          const cell = queued[i];
          const fn = queued[i + 1];
          if (typeof cell.cleanup === 'function') cell.cleanup();
          cell.cleanup = fn() ?? null;
        }
      } finally {
        inst.flushing = false;
      }
    } while (inst.dirty);
    return inst.state;
  };
  inst.unmount = () => {
    for (const cell of inst.slots) {
      if (cell && typeof cell.cleanup === 'function') {
        cell.cleanup();
        cell.cleanup = null;
      }
    }
  };
  inst.render();
  return inst;
};

test('lazy seed: the first render returns the live Date.now() and the initializer runs exactly once', () => {
  reset();
  clock.now = 1_234_567;
  const d = mountHook(useNowTicker);
  assert.equal(d.state, 1_234_567);
  assert.equal(d.initializerCalls, 1, 'useState received a lazy initializer, called once');
  assert.equal(clock.nowCalls, 1, 'Date.now sampled once for the seed (not at module load, not per render)');
  clock.now += 5000;
  d.render();
  assert.equal(d.initializerCalls, 1, 'a re-render does not re-run the initializer');
  assert.equal(d.state, 1_234_567, 'a re-render alone does not re-sample the clock');
});

test('mounting registers exactly one 1000ms interval', () => {
  reset();
  mountHook(useNowTicker);
  assert.equal(timers.set.length, 1);
  assert.equal(timers.set[0].ms, 1000);
  assert.equal(timers.active.size, 1);
});

test('each tick publishes the current Date.now(), including after a wall-clock jump (not prev+1000)', () => {
  reset();
  const d = mountHook(useNowTicker);
  clock.now += 1000;
  fireTimers();
  assert.equal(d.state, 1_001_000);
  clock.now += 3_600_000; // sleep/resume: the wall clock leapt an hour
  fireTimers();
  assert.equal(d.state, 4_601_000, 'tick reads live Date.now(), so a resumed laptop does not show a stale clock');
});

test('no update is published before a tick fires', () => {
  reset();
  const d = mountHook(useNowTicker);
  const seeded = d.state;
  const rendersBefore = d.renders;
  clock.now += 999;
  assert.equal(d.state, seeded);
  assert.equal(d.renders, rendersBefore, 'no re-render without a tick');
});

test('a re-render does not re-register or clear the interval (effect runs once)', () => {
  reset();
  const d = mountHook(useNowTicker);
  d.render();
  d.render();
  clock.now += 1000;
  fireTimers(); // the tick's own re-render must not churn the interval either
  assert.equal(timers.set.length, 1, 'still exactly one setInterval');
  assert.deepEqual(timers.cleared, [], 'nothing cleared while mounted');
  assert.equal(timers.active.size, 1);
});

test('unmount clears the very interval id it created and ticks stop', () => {
  reset();
  const d = mountHook(useNowTicker);
  const createdId = timers.set[0].id;
  d.unmount();
  assert.deepEqual(timers.cleared, [createdId]);
  assert.equal(timers.active.size, 0);
  const frozen = d.state;
  clock.now += 5000;
  fireTimers();
  assert.equal(d.state, frozen, 'no ticks after unmount');
});

console.log(`\n${passed} passed`);
