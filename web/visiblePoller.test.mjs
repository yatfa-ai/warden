// Pure tests for the Page-Visibility poller gate (WARDEN-753) — the contract
// that was hand-copied across 7 effects and forgotten 3x (WARDEN-609/661/668).
//
// Like timelinePacing.test.mjs, there is no FE test runner (no jsdom/vitest) in
// this repo, so this loads the REAL src/lib/visiblePoller.ts (transpiled TS ->
// ESM via Vite's OXC transform) and exercises createVisiblePoller — the pure
// core the useVisiblePoller hook delegates to — with a fully mocked env (fake
// setInterval, a recorded visibilitychange listener, a controllable
// visibilityState). This is the FIRST test to assert the gate contract; before
// it, nothing locked the visibility-gate behavior, which is exactly why nothing
// failed when the gate was dropped three times.
//
// Run: node visiblePoller.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const corePath = resolve(__dirname, 'src/lib/visiblePoller.ts');

// --- Load the REAL visiblePoller.ts (TS -> ESM via the OXC transform) ----------
const src = readFileSync(corePath, 'utf8');
const { code } = await transformWithOxc(src, corePath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-visible-poller-test-'));
const tmpFile = join(tmpDir, 'visiblePoller.mjs');
writeFileSync(tmpFile, code);
const { createVisiblePoller } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

// --- Test env: a fully controllable fake of the browser surface ---------------
// One fresh env per test so call counts never leak between cases.
function makeEnv(initialVisibility = 'visible') {
  let visState = initialVisibility;
  let tickHandler = null;
  let visHandler = null;
  let intervalId = null;
  let nextId = 1;
  let intervalCleared = false;
  let listenerRemoved = false;
  const env = {
    setInterval: (h) => {
      tickHandler = h;
      intervalId = nextId++;
      return intervalId;
    },
    clearInterval: (id) => {
      if (id === intervalId) {
        tickHandler = null;
        intervalCleared = true;
      }
    },
    addEventListener: (_type, h) => {
      visHandler = h;
    },
    removeEventListener: (_type, h) => {
      if (h === visHandler) {
        visHandler = null;
        listenerRemoved = true;
      }
    },
    visibilityState: () => visState,
  };
  return {
    env,
    setVis: (s) => {
      visState = s;
    },
    // Drive one interval tick (what setInterval(ms) would fire).
    tick: () => {
      if (tickHandler) tickHandler();
    },
    // Dispatch a visibilitychange event (the browser fires this on any transition).
    dispatchVisibilityChange: () => {
      if (visHandler) visHandler();
    },
    intervalCleared: () => intervalCleared,
    listenerRemoved: () => listenerRemoved,
  };
}

// Records every fn() invocation; read via fn.count.
function recorder() {
  let n = 0;
  const fn = () => {
    n += 1;
  };
  Object.defineProperty(fn, 'count', { get: () => n });
  return fn;
}

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

console.log('\nmount-poll: fn() called once on setup by default');
test('fn called once on setup when mountPoll is default', () => {
  const { env } = makeEnv();
  const fn = recorder();
  createVisiblePoller(fn, 100, undefined, env);
  assert.equal(fn.count, 1);
});
test('mount-poll fires even when the tab starts hidden (mount-poll is unconditional)', () => {
  const { env } = makeEnv('hidden');
  const fn = recorder();
  createVisiblePoller(fn, 100, undefined, env);
  assert.equal(fn.count, 1);
});

console.log('\nmountPoll:false: fn() NOT called on setup');
test('mountPoll:false skips the setup call (App.tsx interval-only poll)', () => {
  const { env } = makeEnv();
  const fn = recorder();
  createVisiblePoller(fn, 100, { mountPoll: false }, env);
  assert.equal(fn.count, 0);
});

console.log('\ninterval tick: gated on visibility');
test('tick while hidden does NOT call fn', () => {
  const { env, tick } = makeEnv('hidden');
  const fn = recorder();
  createVisiblePoller(fn, 100, undefined, env); // mount-poll = 1
  tick();
  assert.equal(fn.count, 1, 'no extra call while hidden');
});
test('tick while visible DOES call fn', () => {
  const { env, tick } = makeEnv('visible');
  const fn = recorder();
  createVisiblePoller(fn, 100, undefined, env); // mount-poll = 1
  tick();
  assert.equal(fn.count, 2);
});

console.log('\nvisibilitychange: immediate refresh only on transition INTO visible');
test('visibilitychange while visible calls fn (state may be stale)', () => {
  const { env, dispatchVisibilityChange } = makeEnv('visible');
  const fn = recorder();
  createVisiblePoller(fn, 100, undefined, env); // mount-poll = 1
  dispatchVisibilityChange();
  assert.equal(fn.count, 2);
});
test('visibilitychange while hidden does NOT call fn', () => {
  const { env, setVis, dispatchVisibilityChange } = makeEnv('visible');
  const fn = recorder();
  createVisiblePoller(fn, 100, undefined, env); // mount-poll = 1
  setVis('hidden');
  dispatchVisibilityChange();
  assert.equal(fn.count, 1, 'no refresh on a transition that is not into visible');
});

console.log('\nrunWhileHidden: relaxes the TICK gate only');
test('runWhileHidden:true bypasses the tick gate (calls fn while hidden)', () => {
  const { env, tick } = makeEnv('hidden');
  const fn = recorder();
  createVisiblePoller(fn, 100, { runWhileHidden: () => true }, env); // mount-poll = 1
  tick();
  assert.equal(fn.count, 2, 'WARDEN-259 away-alert poller keeps ticking while hidden');
});
test('runWhileHidden:false does NOT bypass the tick gate', () => {
  const { env, tick } = makeEnv('hidden');
  const fn = recorder();
  createVisiblePoller(fn, 100, { runWhileHidden: () => false }, env); // mount-poll = 1
  tick();
  assert.equal(fn.count, 1);
});
test('runWhileHidden does NOT relax the visibilitychange handler (still visible-only)', () => {
  const { env, setVis, dispatchVisibilityChange } = makeEnv('hidden');
  const fn = recorder();
  createVisiblePoller(fn, 100, { runWhileHidden: () => true }, env); // mount-poll = 1
  // hidden + runWhileHidden true: the handler must still NOT fire on a
  // visibilitychange that is not a transition into visible.
  setVis('hidden');
  dispatchVisibilityChange();
  assert.equal(fn.count, 1, 'handler ignores runWhileHidden');
  // ...but a transition INTO visible still fires it.
  setVis('visible');
  dispatchVisibilityChange();
  assert.equal(fn.count, 2);
});

console.log('\ncleanup: clears the interval + removes the listener');
test('cleanup clears the interval and removes the listener', () => {
  const { env, intervalCleared, listenerRemoved } = makeEnv();
  const fn = recorder();
  const cleanup = createVisiblePoller(fn, 100, undefined, env); // mount-poll = 1
  cleanup();
  assert.equal(intervalCleared(), true, 'interval cleared');
  assert.equal(listenerRemoved(), true, 'listener removed');
});
test('after cleanup, no further fn calls and a dispatch does not throw', () => {
  const { env, tick, dispatchVisibilityChange } = makeEnv('visible');
  const fn = recorder();
  const cleanup = createVisiblePoller(fn, 100, undefined, env); // mount-poll = 1
  cleanup();
  tick(); // interval handler removed -> no-op
  dispatchVisibilityChange(); // listener removed -> no-op, must not throw
  assert.equal(fn.count, 1, 'no calls after cleanup');
});

console.log(`\n✓ VISIBLE POLLER TESTS PASS (${passed})`);
