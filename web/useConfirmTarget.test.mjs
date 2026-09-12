// Tests for web/src/lib/useConfirmTarget.ts — the pending-target confirmation
// state machine shared by App.tsx's three destructive-action dialogs
// (force-kill / kill-chat / close-workspace), WARDEN-1239. This hook had ZERO
// references in any suite file (the web/src/lib hook layer is the suite's one
// structural blind spot); this pins the machine shut.
//
// WHY THESE LEGS: a regression here is not cosmetic — it changes what happens
// when a user confirms a kill.
//   - Gate leg inverted or dropped → force-kill / kill-chat fire immediately
//     with no dialog, or the "Confirm before destructive actions" power-user
//     opt-out stops working and destroys the wrong pane.
//   - Clear-before-act reordered → the module header's own contract breaks:
//     the dialog must close even if the action throws synchronously, and no
//     later re-render may resurrect the id. A throwing action would leave a
//     wedged-open dialog.
//   - Snapshot leg broken → confirm acts on a stale or resurrected id.
//
// HARNESS (WARDEN-1071 §3/§3d): there is no React runner in this repo, so the
// REAL module is transpiled with vite's transformWithOxc and driven seam-first
// through a test-local useState/useCallback shim (render-on-set, memo-by-deps
// — faithful for a hook with no effects/refs/DOM, which this one is). The
// hook's only value import is `react`; its specifier is rewritten onto the
// shim. The rewrite is ASSERTED, not assumed: react IS installed in web/, so
// an unrewritten import would load the REAL react, whose hooks throw outside
// a renderer — a loud failure, never a silent false pass. Per WARDEN-997 the
// first legs prove the DRIVER actually re-executes the hook on setState
// before any behavior verdict is recorded. Hook callbacks are PER-RENDER
// closures: after every state flip the test re-grabs the callback off the
// fresh render's bag (driver.state), which is the frame React would show.
//
// Run: node useConfirmTarget.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Emit the shim + the REAL transpiled hook into a temp dir inside web/ ----
// Inside web/ so the transpiled module's relative import of the shim resolves.
// Nothing else is loaded: useConfirmTarget.ts has exactly ONE value import.
const tmpDir = mkdtempSync(join(__dirname, '.use-confirm-target-test-'));

// react-shim.mjs — named exports (transpiled code does
// `import { useState, useCallback } from './react-shim.mjs'`, so a factory
// export would not resolve — WARDEN-1071 §3d), read from a module-level
// CURRENT instance that the driver aims before every render. Render-on-set: a
// state write re-executes the mounted hook synchronously, so the bag a test
// reads after an event handler returns is the NEW frame. Memo-by-deps:
// useCallback hands back the same function while deps are Object.is-equal and
// a fresh one otherwise — the exact contract the hook's dep arrays rely on.
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
export function useCallback(fn, deps) {
  const self = current;
  const slot = self.cursor++;
  const prev = self.memos[slot];
  if (prev === undefined || deps.some((d, i) => !Object.is(d, prev[i]))) {
    self.memos[slot] = deps;
    self.values[slot] = fn;
  }
  return self.values[slot];
}
`,
);

const hookPath = resolve(__dirname, 'src/lib/useConfirmTarget.ts');
const { code } = await transformWithOxc(readFileSync(hookPath, 'utf8'), hookPath, {});
const rewritten = code
  .replaceAll('"react"', '"./react-shim.mjs"')
  .replaceAll("'react'", "'./react-shim.mjs'");
assert.ok(
  rewritten.includes('"./react-shim.mjs"'),
  'the react specifier rewrite must land — an unrewritten import would load the real react, whose hooks throw outside a renderer',
);
writeFileSync(join(tmpDir, 'useConfirmTarget.mjs'), rewritten);

const { useConfirmTarget } = await import(join(tmpDir, 'useConfirmTarget.mjs'));
// The shim's useState/useCallback are also used directly by the two driver
// precondition legs (WARDEN-997), which mount a counter hook through the SAME
// primitives the real hook runs on.
const { __aim: aimShim, useState: useStateShim, useCallback: useCallbackShim } = await import(
  join(tmpDir, 'react-shim.mjs')
);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// --- The driver --------------------------------------------------------------
// mountHook(useHook) executes useHook() as ONE component instance. Every
// render re-aims the shim at this instance, resets the hook-call cursor, and
// stores the returned bag in .state — the frame React would show. A state
// write inside any callback re-renders synchronously (render-on-set), so
// after an event handler returns, driver.state is already the fresh frame.
// driver.render() with no event stands in for a parent re-render.
const mountHook = (runHook) => {
  const inst = {
    states: [], // useState slots, per instance
    memos: [], // useCallback dep lists, per slot
    values: [], // useCallback memoized fns, per slot
    cursor: 0, // hook-call order within the current render
    renders: 0, // how many times the hook body has run
    state: null, // the latest frame's bag
    render: null,
  };
  inst.render = () => {
    aimShim(inst);
    inst.cursor = 0;
    inst.renders += 1;
    inst.state = runHook();
    return inst.state;
  };
  inst.render();
  return inst;
};

// A recording action: pushes every id it is called with onto .calls.
const recordingAction = () => {
  const action = (id) => {
    action.calls.push(id);
  };
  action.calls = [];
  return action;
};

// ─── driver preconditions (WARDEN-997): prove the harness drives the hook ────
// No behavior verdict below means anything unless the driver really
// re-executes the hook body on setState and really memoizes by deps.
console.log('\ndriver preconditions — the shim re-executes the hook on setState (WARDEN-997)');
test('a state write re-executes the hook and yields a NEW frame carrying the new state (functional update)', () => {
  const driver = mountHook(() => {
    const [n, setN] = useStateShim(0);
    return { n, bump: () => setN((x) => x + 1) };
  });
  assert.equal(driver.renders, 1);
  assert.equal(driver.state.n, 0);
  const firstFrame = driver.state;
  firstFrame.bump();
  assert.equal(driver.renders, 2, 'the setter must re-execute the hook, not just mutate a variable');
  assert.notEqual(driver.state, firstFrame, 'the test must be reading a NEW frame after the update');
  assert.equal(driver.state.n, 1);
  driver.state.bump();
  assert.equal(driver.renders, 3);
  assert.equal(driver.state.n, 2);
});
test('useCallback returns the same function while deps are unchanged — and a NEW one when they change', () => {
  let dep = 'a';
  const driver = mountHook(() => ({ fn: useCallbackShim(() => dep, [dep]) }));
  const first = driver.state.fn;
  driver.render();
  assert.equal(driver.state.fn, first, 'same deps → same identity (the stability the hook promises)');
  dep = 'b';
  driver.render();
  assert.notEqual(driver.state.fn, first, 'changed deps → NEW identity (the stability must not be fake)');
});

// ─── leg 1 — the gate leg, predicate TRUE ────────────────────────────────────
console.log('\nleg 1 — gated + predicate TRUE: the dialog opens, the action does NOT fire');
test('request opens the dialog with the id; the action is not called — and stays uncalled across re-renders', () => {
  const action = recordingAction();
  const driver = mountHook(() => useConfirmTarget(action, () => true));
  driver.state.request('pane-7');
  // Callbacks are per-render closures: read the target off the FRESH frame.
  assert.equal(driver.state.target, 'pane-7');
  assert.deepEqual(action.calls, [], 'an open dialog must not have fired the action');
  // The open dialog survives unrelated re-renders, still without firing.
  driver.render();
  driver.render();
  assert.equal(driver.state.target, 'pane-7');
  assert.deepEqual(action.calls, []);
});

// ─── leg 2 — the gate leg, predicate FALSE (the power-user opt-out) ──────────
console.log('\nleg 2 — gated + predicate FALSE: the action fires immediately, no dialog');
test('request fires the action with the id, target stays null, and no dialog render happens', () => {
  const action = recordingAction();
  let answer = false;
  const driver = mountHook(() => useConfirmTarget(action, () => answer));
  const rendersAtOpen = driver.renders;
  driver.state.request('pane-9');
  assert.deepEqual(action.calls, ['pane-9'], 'the opt-out must fire the action immediately');
  assert.equal(driver.state.target, null, 'no dialog is opened on the opt-out path');
  assert.equal(driver.renders, rendersAtOpen, 'the opt-out path needs no render at all');
});

test('the predicate is consulted PER REQUEST, not captured at mount: flip it and the next request opens instead', () => {
  const action = recordingAction();
  let answer = false;
  const driver = mountHook(() => useConfirmTarget(action, () => answer));
  driver.state.request('pane-11');
  assert.deepEqual(action.calls, ['pane-11']);
  answer = true; // same predicate fn identity → same request closure…
  driver.state.request('pane-12'); // …consulted fresh: this one OPENS
  assert.deepEqual(action.calls, ['pane-11'], 'the gated request must not fire the action');
  assert.equal(driver.state.target, 'pane-12');
  // …and the dialog is now the only way through:
  driver.state.confirm();
  assert.deepEqual(action.calls, ['pane-11', 'pane-12']);
  assert.equal(driver.state.target, null);
});

// ─── leg 3 — the ungated machine (close-workspace shape) ─────────────────────
console.log('\nleg 3 — no predicate: request ALWAYS opens; the action is reachable only via confirm');
test('without a predicate, request never fires directly — re-targets included — and confirm is the only path', () => {
  const action = recordingAction();
  const driver = mountHook(() => useConfirmTarget(action));
  driver.state.request('ws-1');
  assert.equal(driver.state.target, 'ws-1');
  assert.deepEqual(action.calls, []);
  driver.state.request('ws-2'); // re-targeting still never fires directly
  assert.equal(driver.state.target, 'ws-2');
  assert.deepEqual(action.calls, []);
  driver.state.confirm();
  assert.deepEqual(action.calls, ['ws-2'], 'confirm is the ONLY route to the action');
  assert.equal(driver.state.target, null);
});

// ─── leg 4 — clear BEFORE acting (the docstring's observable contract) ───────
console.log('\nleg 4 — confirm clears BEFORE acting: a throwing action still closes the dialog');
test('confirm clears the target, THEN acts: a synchronously throwing action leaves the dialog closed (order recorded)', () => {
  const order = [];
  const action = (id) => {
    order.push(`action:${id}`);
    throw new Error('boom');
  };
  action.calls = [];
  const current = { action };
  const driver = mountHook(() => {
    const bag = useConfirmTarget(current.action, () => true);
    order.push(`render:${bag.target}`); // every re-render becomes a log line
    return bag;
  });
  driver.state.request('pane-3');
  assert.deepEqual(order, ['render:null', 'render:pane-3']);
  assert.throws(() => driver.state.confirm(), /boom/, 'the synchronous throw must be observed, not swallowed');
  // THE ORDER IS THE CONTRACT: the null render — the dialog closing — happens
  // strictly BEFORE the action runs. A mutant that moves the clear after the
  // action loses the null render (the throw preempts it) AND leaves the id set.
  assert.deepEqual(
    order,
    ['render:null', 'render:pane-3', 'render:null', 'action:pane-3'],
    'the clear must render before the action runs',
  );
  assert.equal(driver.state.target, null, 'the dialog must be closed despite the throw');
});

// ─── leg 5 — the snapshot leg ────────────────────────────────────────────────
console.log('\nleg 5 — confirm acts on the pending snapshot, once, and never resurrects it');
test('confirm acts on the id pending AT confirm time — once — and no later re-render resurrects it', () => {
  const action = recordingAction();
  const driver = mountHook(() => useConfirmTarget(action, () => true));
  driver.state.request('a');
  driver.state.request('b'); // re-target while open: 'b' is what is pending
  assert.equal(driver.state.target, 'b');
  driver.state.confirm();
  assert.deepEqual(action.calls, ['b'], 'acts on the snapshot pending at confirm time, exactly once');
  driver.state.confirm(); // nothing pending anymore
  assert.deepEqual(action.calls, ['b'], 'a second confirm must be a no-op');
  driver.render();
  driver.render(); // later re-renders…
  assert.equal(driver.state.target, null, '…must never resurrect the cleared id');
  assert.deepEqual(action.calls, ['b'], '…must never re-fire the action');
});

// ─── leg 6 — cancel clears only; identities are stable exactly as deps say ───
console.log('\nleg 6 — cancel clears only; identity stability matches the dep arrays');
test('cancel clears the target and NEVER calls the action', () => {
  const action = recordingAction();
  const driver = mountHook(() => useConfirmTarget(action, () => true));
  driver.state.request('pane-4');
  driver.state.cancel();
  assert.equal(driver.state.target, null);
  assert.deepEqual(action.calls, []);
});
test('cancel identity is stable across renders AND across target changes (empty deps, like every hand-written copy)', () => {
  const action = recordingAction();
  const driver = mountHook(() => useConfirmTarget(action, () => true));
  const cancel1 = driver.state.cancel;
  driver.render();
  assert.equal(driver.state.cancel, cancel1, 'stable across a plain re-render');
  driver.state.request('x');
  assert.equal(driver.state.cancel, cancel1, 'stable across a state-driven re-render');
  driver.state.cancel();
  driver.render();
  assert.equal(driver.state.cancel, cancel1);
});
test('request identity is stable while its deps (action, shouldConfirm) are unchanged', () => {
  const action = recordingAction();
  const shouldConfirm = () => true;
  const driver = mountHook(() => useConfirmTarget(action, shouldConfirm));
  const request1 = driver.state.request;
  driver.render(); // parent re-render, same props
  assert.equal(driver.state.request, request1);
  driver.state.request('t'); // a state-driven re-render
  driver.render();
  assert.equal(driver.state.request, request1);
});
test('request identity CHANGES when the action changes — memo-by-deps is real, and the new request uses the new action', () => {
  const action1 = recordingAction();
  const action2 = recordingAction();
  // Both deps hoisted: an inline `() => true` in the mount closure would mint a
  // fresh predicate identity EVERY render, and under real memo-by-deps
  // semantics request would legitimately be rebuilt each render. Stability is
  // claimed only while the deps are genuinely unchanged.
  const current = { action: action1, shouldConfirm: () => true };
  const driver = mountHook(() => useConfirmTarget(current.action, current.shouldConfirm));
  const request1 = driver.state.request;
  driver.render();
  assert.equal(driver.state.request, request1);
  current.action = action2; // new prop identity → new dep → new memo
  driver.render();
  assert.notEqual(driver.state.request, request1, 'a changed dep must produce a NEW request');
  driver.state.request('pane-5');
  driver.state.confirm();
  assert.deepEqual(action2.calls, ['pane-5'], 'the new request must be wired to the new action end-to-end');
  assert.deepEqual(action1.calls, []);
});

console.log(`\n✓ USE CONFIRM TARGET TESTS PASS (${passed})`);
