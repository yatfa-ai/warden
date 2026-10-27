// Tests for web/src/lib/useAsyncConfirm.ts — the async-confirm state machine
// shared by the two fleet fan-out dialogs KillDialog / KeySendDialog
// (WARDEN-1017). This hook had ZERO references in any suite file (the
// web/src/lib hook layer is the suite's one structural blind spot); this pins
// the machine shut.
//
// WHY THESE LEGS: the hook governs whether a destructive fan-out can be
// dismissed mid-flight, and what the dialog looks like when it ends.
//   - `!enabled` guard inverted/dropped → a confirm whose `canX` predicate is
//     false still fans out (or a valid one silently does nothing).
//   - busy never set / never restored → no spinner, double-submit, or a button
//     stuck on its spinner after a rejected action (the `finally` leg).
//   - close moved into `finally` → a REJECTING action closes the dialog and
//     hides the failure.
//   - `await` dropped → the dialog closes and busy is restored before the
//     fan-out has finished.
//   - guardOpenChange not blocking while busy (or blocking while idle) → Esc /
//     overlay click abandons an in-flight destructive fan-out, or the dialog
//     can no longer be dismissed at all.
//   - reset-on-open broken → a previous attempt's spinner lingers on reopen.
//
// HARNESS (same seam-first shape as useConfirmTarget.test.mjs, WARDEN-1071):
// there is no React runner in this repo, so the REAL module is transpiled with
// vite's transformWithOxc and driven through a test-local
// useState/useEffect shim (render-on-set; effects flush after each render when
// their deps changed). The hook's only value import is `react`; its specifier
// is rewritten onto the shim. The rewrite is ASSERTED, not assumed: react IS
// installed in web/, so an unrewritten import would load the REAL react, whose
// hooks throw outside a renderer — a loud failure, never a silent false pass.
// Per WARDEN-997 the first legs prove the DRIVER really re-executes the hook on
// setState and really runs effects by deps before any behavior verdict is
// recorded. Hook callbacks are PER-RENDER closures: after every state flip the
// test re-grabs the callback off the fresh frame (driver.state).
//
// Run: node useAsyncConfirm.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));

const tmpDir = mkdtempSync(join(__dirname, '.use-async-confirm-test-'));

// react-shim.mjs — named exports (the transpiled code does
// `import { useEffect, useState } from './react-shim.mjs'`). A module-level
// CURRENT instance is aimed by the driver before every render. Render-on-set:
// a state write re-executes the mounted hook synchronously. Effects: queued
// during the render, flushed right after the hook body returns, and only when
// their deps differ (Object.is) from the previous run — the contract the
// hook's `[open]` dep array relies on.
writeFileSync(
  join(tmpDir, 'react-shim.mjs'),
  `
let current = null;
export const __aim = (inst) => { current = inst; };
export function useState(initial) {
  const self = current;
  const slot = self.cursor++;
  if (self.states.length <= slot) self.states.push(initial);
  const value = self.states[slot];
  return [value, (next) => {
    self.states[slot] = typeof next === 'function' ? next(self.states[slot]) : next;
    self.render();
  }];
}
export function useEffect(fn, deps) {
  const self = current;
  const slot = self.cursor++;
  const prev = self.effectDeps[slot];
  if (prev === undefined || deps === undefined || deps.some((d, i) => !Object.is(d, prev[i]))) {
    self.effectDeps[slot] = deps;
    self.pendingEffects.push(fn);
  }
}
`,
);

const hookPath = resolve(__dirname, 'src/lib/useAsyncConfirm.ts');
const { code } = await transformWithOxc(readFileSync(hookPath, 'utf8'), hookPath, {});
const rewritten = code
  .replaceAll('"react"', '"./react-shim.mjs"')
  .replaceAll("'react'", "'./react-shim.mjs'");
assert.ok(
  rewritten.includes('"./react-shim.mjs"'),
  'the react specifier rewrite must land — an unrewritten import would load the real react, whose hooks throw outside a renderer',
);
writeFileSync(join(tmpDir, 'useAsyncConfirm.mjs'), rewritten);

const { useAsyncConfirm } = await import(join(tmpDir, 'useAsyncConfirm.mjs'));
const { __aim: aimShim, useState: useStateShim, useEffect: useEffectShim } = await import(
  join(tmpDir, 'react-shim.mjs')
);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed += 1;
  console.log('  ok -', name);
};

// --- The driver --------------------------------------------------------------
const mountHook = (runHook) => {
  const inst = {
    states: [],
    effectDeps: [],
    pendingEffects: [],
    cursor: 0,
    renders: 0,
    state: null,
    render: null,
  };
  inst.render = () => {
    aimShim(inst);
    inst.cursor = 0;
    inst.renders += 1;
    inst.state = runHook();
    // Flush effects AFTER the frame is recorded: an effect's setState re-renders
    // (nested) and that inner frame is the final one.
    const effects = inst.pendingEffects;
    inst.pendingEffects = [];
    for (const fx of effects) fx();
    return inst.state;
  };
  inst.render();
  return inst;
};

// Mount useAsyncConfirm with mutable props; onOpenChange calls are recorded
// together with the busy value visible on the CURRENT frame at call time.
const mountDialog = ({ open = true } = {}) => {
  const props = { open };
  const closes = [];
  let driver;
  const onOpenChange = (next) => {
    closes.push({ next, busyAtCall: driver.state.busy });
  };
  driver = mountHook(() => useAsyncConfirm(props.open, (n) => props.onOpenChange(n)));
  props.onOpenChange = onOpenChange;
  return {
    driver,
    props,
    closes,
    get bag() {
      return driver.state;
    },
    setOpen(next) {
      props.open = next;
      driver.render();
    },
  };
};

// A controllable async action.
const deferredAction = () => {
  let resolve_;
  let reject_;
  const promise = new Promise((res, rej) => {
    resolve_ = res;
    reject_ = rej;
  });
  const action = () => {
    action.calls += 1;
    return promise;
  };
  action.calls = 0;
  action.resolve = resolve_;
  action.reject = reject_;
  return action;
};

// ─── driver preconditions (WARDEN-997) ───────────────────────────────────────
console.log('\ndriver preconditions — the shim re-executes the hook and runs effects by deps (WARDEN-997)');
await test('a state write re-executes the hook and yields a NEW frame carrying the new state', () => {
  const driver = mountHook(() => {
    const [n, setN] = useStateShim(0);
    return { n, bump: () => setN((x) => x + 1) };
  });
  const first = driver.state;
  first.bump();
  assert.equal(driver.renders, 2);
  assert.notEqual(driver.state, first);
  assert.equal(driver.state.n, 1);
});
await test('useEffect runs on mount, re-runs only when a dep changes, and not on an unrelated re-render', () => {
  let dep = 'a';
  let runs = 0;
  const driver = mountHook(() => {
    useEffectShim(() => {
      runs += 1;
    }, [dep]);
    return {};
  });
  assert.equal(runs, 1, 'effect runs on mount');
  driver.render();
  assert.equal(runs, 1, 'same deps → no re-run');
  dep = 'b';
  driver.render();
  assert.equal(runs, 2, 'changed dep → re-run');
});

// ─── leg 1 — idle state ──────────────────────────────────────────────────────
console.log('\nleg 1 — idle: busy starts false');
await test('mounts idle (busy=false) when open', () => {
  const d = mountDialog({ open: true });
  assert.equal(d.bag.busy, false);
});
await test('mounts idle (busy=false) when closed', () => {
  const d = mountDialog({ open: false });
  assert.equal(d.bag.busy, false);
});

// ─── leg 2 — the enabled gate ────────────────────────────────────────────────
console.log('\nleg 2 — run(action, false) is a complete no-op');
await test('enabled=false: action not called, busy never set, dialog not closed', async () => {
  const d = mountDialog();
  // Already-resolved action: a regressed guard must fail the asserts below
  // rather than hang the file on a never-settling top-level await.
  const action = deferredAction();
  action.resolve();
  const rendersBefore = d.driver.renders;
  await d.bag.run(action, false);
  assert.equal(action.calls, 0, 'a disabled confirm must not fan out');
  assert.equal(d.bag.busy, false);
  assert.deepEqual(d.closes, [], 'a disabled confirm must not close the dialog');
  assert.equal(d.driver.renders, rendersBefore, 'a disabled confirm must not even re-render');
});

// ─── leg 3 — the happy path ──────────────────────────────────────────────────
console.log('\nleg 3 — run(action, true): busy during flight, close only after resolve');
await test('busy flips true synchronously, the action runs exactly once, close fires only after resolve', async () => {
  const d = mountDialog();
  const action = deferredAction();
  const pending = d.bag.run(action, true);
  assert.equal(d.bag.busy, true, 'busy must be visible on the fresh frame while in flight');
  assert.equal(action.calls, 1, 'action runs exactly once');
  // Let microtasks drain: the action is still pending, so nothing may close.
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(d.closes, [], 'the dialog must not close until the action resolves');
  assert.equal(d.bag.busy, true);
  action.resolve('done');
  await pending;
  assert.equal(action.calls, 1);
  assert.deepEqual(
    d.closes.map((c) => c.next),
    [false],
    'exactly one close request, and it is onOpenChange(false)',
  );
  assert.equal(d.bag.busy, false, 'busy is restored once the run settles');
});
await test('ordering: the close request is observed while busy is still true; busy clears AFTER (the in-source "do not simplify" note)', async () => {
  const d = mountDialog();
  const action = deferredAction();
  const pending = d.bag.run(action, true);
  action.resolve();
  await pending;
  assert.equal(d.closes.length, 1);
  assert.equal(
    d.closes[0].busyAtCall,
    true,
    'setBusy(false) must run AFTER onOpenChange(false), in the finally',
  );
  assert.equal(d.bag.busy, false);
});

// ─── leg 4 — a rejecting action ──────────────────────────────────────────────
console.log('\nleg 4 — a REJECTING action: busy restored by finally, dialog stays open, run rejects');
await test('rejection restores busy, does not close the dialog, and propagates to the caller', async () => {
  const d = mountDialog();
  const action = deferredAction();
  const pending = d.bag.run(action, true);
  assert.equal(d.bag.busy, true);
  const boom = new Error('boom');
  action.reject(boom);
  await assert.rejects(pending, (err) => err === boom, 'run must surface the action failure');
  assert.equal(d.bag.busy, false, 'the finally must restore the footer button');
  assert.deepEqual(d.closes, [], 'a failed fan-out must not close the dialog');
});
await test('a synchronously-throwing action also restores busy and does not close', async () => {
  const d = mountDialog();
  const boom = new Error('sync');
  await assert.rejects(
    d.bag.run(() => {
      throw boom;
    }, true),
    (err) => err === boom,
  );
  assert.equal(d.bag.busy, false);
  assert.deepEqual(d.closes, []);
});

// ─── leg 5 — the dismissal guard ─────────────────────────────────────────────
console.log('\nleg 5 — guardOpenChange: forwards when idle, swallows while busy');
await test('idle: forwards both true and false to onOpenChange verbatim', () => {
  const d = mountDialog();
  d.bag.guardOpenChange(false);
  d.bag.guardOpenChange(true);
  assert.deepEqual(
    d.closes.map((c) => c.next),
    [false, true],
  );
});
await test('busy: swallows dismissal (false) AND open (true); resumes forwarding once the run settles', async () => {
  const d = mountDialog();
  const action = deferredAction();
  const pending = d.bag.run(action, true);
  // Read the guard off the FRESH busy frame — it is a per-render closure.
  d.bag.guardOpenChange(false);
  d.bag.guardOpenChange(true);
  assert.deepEqual(d.closes, [], 'Esc/overlay must not dismiss an in-flight fan-out');
  action.resolve();
  await pending;
  // The run's own close is the only call so far.
  assert.deepEqual(
    d.closes.map((c) => c.next),
    [false],
  );
  d.bag.guardOpenChange(false);
  assert.deepEqual(
    d.closes.map((c) => c.next),
    [false, false],
    'after settle the guard forwards again',
  );
});
await test('a stale pre-busy guard closure is not what the dialog uses: the fresh frame blocks', () => {
  const d = mountDialog();
  const idleGuard = d.bag.guardOpenChange;
  d.bag.run(deferredAction(), true);
  idleGuard(false); // the old closure legitimately sees busy=false…
  assert.equal(d.closes.length, 1);
  d.bag.guardOpenChange(false); // …the fresh one must block.
  assert.equal(d.closes.length, 1, 'the guard on the fresh frame must block while busy');
});

// ─── leg 6 — reset on open ───────────────────────────────────────────────────
console.log('\nleg 6 — reset-on-open: a previous attempt\'s spinner does not linger');
await test('close mid-flight then reopen clears busy', () => {
  const d = mountDialog({ open: true });
  d.bag.run(deferredAction(), true);
  assert.equal(d.bag.busy, true);
  d.setOpen(false);
  assert.equal(d.bag.busy, true, 'closing (open→false) must not itself reset busy');
  d.setOpen(true);
  assert.equal(d.bag.busy, false, 'reopening must start fresh');
});
await test('an unrelated re-render while open does NOT clear in-flight busy (effect keyed on [open])', () => {
  const d = mountDialog({ open: true });
  d.bag.run(deferredAction(), true);
  d.driver.render();
  d.driver.render();
  assert.equal(d.bag.busy, true);
});
await test('open staying true across a prop re-set does not reset busy', () => {
  const d = mountDialog({ open: true });
  d.bag.run(deferredAction(), true);
  d.setOpen(true);
  assert.equal(d.bag.busy, true);
});
await test('mounting closed then opening yields idle', () => {
  const d = mountDialog({ open: false });
  d.setOpen(true);
  assert.equal(d.bag.busy, false);
});

// ─── leg 7 — latest onOpenChange ─────────────────────────────────────────────
console.log('\nleg 7 — the latest onOpenChange prop is the one used');
await test('run and guardOpenChange call the onOpenChange passed on the most recent render', async () => {
  let current = null;
  const first = [];
  const second = [];
  const handlers = { cb: (n) => first.push(n) };
  const driver = mountHook(() => useAsyncConfirm(true, handlers.cb));
  current = driver;
  handlers.cb = (n) => second.push(n);
  driver.render();
  current.state.guardOpenChange(false);
  await current.state.run(async () => {}, true);
  assert.deepEqual(first, []);
  assert.deepEqual(second, [false, false]);
});

console.log(`\n${passed} passed`);
