// Tests for web/src/lib/useWatchCatchup.ts — the React hook that owns the state of
// the per-chat watch "while you were away" catch-up (WARDEN-417/476/877). The PURE
// logic it calls (awayMisses / reconcileAwayMisses / withoutKey / the localStorage
// getters) is pinned by watchCatchup.test.mjs; the hook that WIRES them had ZERO
// references in any suite file (the web/src/lib hook layer is the suite's
// structural blind spot). This pins the wiring.
//
// WHY THESE LEGS (each is a user-visible regression if broken):
//   - lazy initial state: the FIRST render already carries recovered misses (an app
//     reopen shows the catch-up without a flash of empty).
//   - seen boundary / reconcile: the hook must read the ack boundary and reconcile
//     against the current states, or an acknowledged / recovered alert re-surfaces
//     as stale noise (Observer Job #1 false positives).
//   - visibilitychange: re-reads the durable log on return (visible), not on hide;
//     the listener is removed on unmount and NOT re-registered on every ~30s poll.
//   - [currentStates] effect: a poll that lands AFTER the synchronous visibility
//     recompute must re-reconcile (WARDEN-476), or the catch-up disagrees with the
//     live banner. The ref threading keeps callbacks reading the freshest snapshot.
//   - ackKey: empty-key guard + "nothing recorded" short-circuit (a routine openChat
//     must not pay a write/recompute), persists + recomputes, never advances seen.
//   - openMiss: deep-links with (key, signal) (WARDEN-877 anchor) BEFORE acking, acks
//     only that chat, still acks without onOpenChat, uses the latest onOpenChat.
//   - dismiss: stamps the seen boundary (log kept as history); later misses resurface.
//
// HARNESS (same seam-first shape as useStickToBottom.test.mjs): no React runner
// exists in this repo, so the REAL hook plus the REAL watchCatchup.ts and
// chatWatch.ts are transpiled with vite's transformWithOxc; the `react` and
// `@/lib/*` specifiers are rewritten onto a test-local useState/useRef/useCallback/
// useEffect shim and the sibling transpiled modules. The rewrites are ASSERTED, not
// assumed: react IS installed in web/, so an unrewritten import would load the REAL
// react, whose hooks throw outside a renderer — a loud failure, never a silent
// false pass. localStorage and document are fake globals. Per WARDEN-997 the first
// legs prove the DRIVER re-renders on setState, memoizes by deps and runs effects +
// cleanups by deps before any behavior verdict.
//
// Run: node useWatchCatchup.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tmpDir = mkdtempSync(join(__dirname, '.use-watch-catchup-test-'));

// react-shim.mjs — slot-based hooks over a module-level CURRENT instance the driver
// aims before every render. State writes re-render the mounted hook (batched while
// effects are flushing, like React). useCallback/useRef are memoized per slot;
// useEffect queues during render and the driver flushes after the frame (cleanup of
// the previous run first) only when deps changed.
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
    self.slots.push({ value: typeof initial === 'function' ? initial() : initial });
  }
  const cell = self.slots[slot];
  return [cell.value, (next) => {
    cell.value = typeof next === 'function' ? next(cell.value) : next;
    if (self.flushing) self.dirty = true;
    else self.render();
  }];
}
export function useRef(initial) {
  const self = current;
  const slot = self.cursor++;
  if (self.slots.length <= slot) self.slots.push({ ref: { current: initial } });
  return self.slots[slot].ref;
}
export function useCallback(fn, deps) {
  const self = current;
  const slot = self.cursor++;
  const cell = self.slots[slot];
  if (cell === undefined) {
    self.slots.push({ fn, deps });
    return fn;
  }
  if (depsChanged(deps, cell.deps)) {
    cell.fn = fn;
    cell.deps = deps;
  }
  return cell.fn;
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

// Transpile a real src/lib module, rewriting specifiers per `map`; assert every
// rewrite landed (a missed one would resolve '@/lib/…' against nothing and crash,
// or 'react' against the real package and silently misbehave).
const emit = async (srcRel, outName, map) => {
  const p = resolve(__dirname, srcRel);
  const { code } = await transformWithOxc(readFileSync(p, 'utf8'), p, {});
  let out = code;
  for (const [from, to] of Object.entries(map)) {
    const before = out;
    out = out.replaceAll(`"${from}"`, `"${to}"`).replaceAll(`'${from}'`, `'${to}'`);
    if (before === out) assert.fail(`specifier rewrite ${from} -> ${to} did not land in ${srcRel}`);
  }
  assert.ok(!/from ['"]@\//.test(out), `${srcRel} still has an unrewritten @/ import`);
  assert.ok(!/from ['"]react['"]/.test(out), `${srcRel} still imports the real react`);
  writeFileSync(join(tmpDir, outName), out);
};
await emit('src/lib/chatWatch.ts', 'chatWatch.mjs', {});
await emit('src/lib/watchCatchup.ts', 'watchCatchup.mjs', {});
await emit('src/lib/useWatchCatchup.ts', 'useWatchCatchup.mjs', {
  react: './react-shim.mjs',
  '@/lib/watchCatchup': './watchCatchup.mjs',
  '@/lib/chatWatch': './chatWatch.mjs',
});

const { useWatchCatchup } = await import(join(tmpDir, 'useWatchCatchup.mjs'));
const {
  __aim: aimShim,
  useState: useStateShim,
  useCallback: useCallbackShim,
  useEffect: useEffectShim,
} = await import(join(tmpDir, 'react-shim.mjs'));
const { WATCH_MISS_LOG_KEY, WATCH_MISS_SEEN_KEY } = await import(join(tmpDir, 'watchCatchup.mjs'));
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// --- Fake platform globals ---------------------------------------------------
const NOW = 1_000_000;
const env = { store: new Map(), setItemCalls: 0, visibility: 'visible', listeners: [], added: 0, removed: 0 };
const resetEnv = () => {
  env.store = new Map();
  env.setItemCalls = 0;
  env.visibility = 'visible';
  env.listeners = [];
  env.added = 0;
  env.removed = 0;
};
globalThis.localStorage = {
  getItem: (k) => (env.store.has(k) ? env.store.get(k) : null),
  setItem: (k, v) => {
    env.setItemCalls += 1;
    env.store.set(k, String(v));
  },
};
globalThis.document = {
  get visibilityState() {
    return env.visibility;
  },
  addEventListener(type, fn) {
    env.added += 1;
    env.listeners.push({ type, fn });
  },
  removeEventListener(type, fn) {
    env.removed += 1;
    env.listeners = env.listeners.filter((l) => !(l.type === type && l.fn === fn));
  },
};
Date.now = () => NOW;
// The human returns / hides: flip visibility and fire every visibilitychange listener.
const setVisibility = (v) => {
  env.visibility = v;
  for (const l of [...env.listeners].filter((x) => x.type === 'visibilitychange')) l.fn();
};

const miss = (key, reason, firedAt, extra = {}) => ({ key, name: `chat-${key}`, reason, firedAt, ...extra });
const writeLog = (log) => env.store.set(WATCH_MISS_LOG_KEY, JSON.stringify(log));
const readLog = () => JSON.parse(env.store.get(WATCH_MISS_LOG_KEY) ?? '[]');
const row = (key, state, extra = {}) => ({ key, id: key, name: `chat-${key}`, state, ...extra });
const keys = (ms) => ms.map((m) => m.key);

// --- The driver --------------------------------------------------------------
// Effects run after the frame (cleanup of the previous run first); state writes
// made while flushing are batched into one follow-up render, like React.
const mountHook = (runHook) => {
  const inst = {
    slots: [],
    pendingEffects: [],
    cursor: 0,
    renders: 0,
    state: null,
    frames: [], // every frame's returned bag, in order
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
      inst.frames.push(inst.state);
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

// Mount useWatchCatchup(args.onOpenChat, args.states). `driver.set({...})` changes
// the props and re-renders (a parent re-render).
const mount = (initial = {}) => {
  const args = { onOpenChat: undefined, states: undefined, ...initial };
  const driver = mountHook(() => useWatchCatchup(args.onOpenChat, args.states));
  driver.set = (patch) => {
    Object.assign(args, patch);
    driver.render();
  };
  return driver;
};

const recorder = () => {
  const fn = (...a) => {
    fn.calls.push(a);
  };
  fn.calls = [];
  return fn;
};

// ─── driver preconditions (WARDEN-997) ───────────────────────────────────────
console.log('\ndriver preconditions — the shim really drives hooks (WARDEN-997)');
test('a state write re-renders; lazy initial state is evaluated once; callbacks memoize by deps', () => {
  let inits = 0;
  let setN;
  const cbs = [];
  let dep = 'a';
  const driver = mountHook(() => {
    const [n, set] = useStateShim(() => {
      inits += 1;
      return 5;
    });
    setN = set;
    cbs.push(useCallbackShim(() => n, [dep]));
    return { n };
  });
  assert.equal(driver.state.n, 5);
  setN((p) => p + 1);
  assert.equal(driver.state.n, 6, 'functional update yields a fresh frame');
  assert.equal(inits, 1, 'lazy initializer runs once');
  assert.equal(cbs[0], cbs[1], 'same deps → same function');
  dep = 'b';
  driver.render();
  assert.notEqual(cbs[1], cbs[2], 'changed deps → new function');
});
test('effects run on first render, re-run only when deps change, clean up before re-running and on unmount', () => {
  const log = [];
  let dep = 1;
  const driver = mountHook(() => {
    useEffectShim(() => {
      log.push(`run${dep}`);
      return () => log.push(`clean${dep}`);
    }, [dep]);
    return {};
  });
  assert.deepEqual(log, ['run1']);
  driver.render();
  assert.deepEqual(log, ['run1'], 'unchanged deps → no re-run');
  dep = 2;
  driver.render();
  assert.deepEqual(log, ['run1', 'clean2', 'run2'], 'cleanup of the previous run precedes the next run');
  driver.unmount();
  assert.equal(log.at(-1), 'clean2');
});
test('state written inside an effect is batched into one follow-up render', () => {
  let setX;
  const driver = mountHook(() => {
    const [x, set] = useStateShim(0);
    setX = set;
    useEffectShim(() => {
      set(1);
      set(2);
    }, []);
    return { x };
  });
  assert.equal(driver.state.x, 2);
  assert.equal(driver.renders, 2, 'initial render + exactly one batched follow-up');
  assert.ok(setX);
});

// ─── lazy initial state + the away window ────────────────────────────────────
console.log('\ninitial state, seen boundary, reconcile');
test('the FIRST frame already carries the recovered misses (lazy initial state, before any effect)', () => {
  resetEnv();
  writeLog([miss('a', 'stuck', NOW - 10)]);
  const d = mount();
  assert.deepEqual(keys(d.frames[0].misses), ['a']);
});
test('empty / absent log → empty misses; a corrupt log does not throw', () => {
  resetEnv();
  assert.deepEqual(mount().state.misses, []);
  resetEnv();
  env.store.set(WATCH_MISS_LOG_KEY, '{not json');
  assert.deepEqual(mount().state.misses, []);
});
test('the seen boundary is read: misses before it are excluded, at/after it kept', () => {
  resetEnv();
  env.store.set(WATCH_MISS_SEEN_KEY, '500');
  writeLog([miss('old', 'stuck', 499), miss('edge', 'stuck', 500), miss('new', 'stuck', 501)]);
  const d = mount();
  assert.deepEqual(keys(d.frames[0].misses).sort(), ['edge', 'new']);
  assert.deepEqual(keys(d.state.misses).sort(), ['edge', 'new']);
});
test('misses are deduped to the newest per key and urgency-ranked (stuck above completed)', () => {
  resetEnv();
  writeLog([
    miss('c', 'completed', 300),
    miss('s', 'stuck', 100),
    miss('s', 'stuck', 200),
  ]);
  const d = mount();
  assert.deepEqual(keys(d.state.misses), ['s', 'c']);
  assert.equal(d.state.misses[0].firedAt, 200, 'newest entry for the key wins');
});
test('reconcile on mount: a chat whose current state recovered is suppressed; stuck / no-snapshot / completed / customMatch are kept', () => {
  resetEnv();
  writeLog([
    miss('recovered', 'stuck', 10),
    miss('stillStuck', 'stuck', 11),
    miss('unknown', 'stuck', 12),
    miss('done', 'completed', 13),
    miss('pattern', 'custom', 14),
  ]);
  const states = [
    row('recovered', 'active'),
    row('stillStuck', 'stuck'),
    row('done', 'idle'),
    row('pattern', 'active', { customMatch: { line: 'ERR' } }),
  ];
  const d = mount({ states });
  assert.equal(keys(d.frames[0].misses).includes('recovered'), false, 'suppressed already on the first frame');
  assert.deepEqual(keys(d.state.misses).sort(), ['done', 'pattern', 'stillStuck', 'unknown']);
});
test('null / undefined currentStates suppress nothing (the safe pre-poll default)', () => {
  resetEnv();
  writeLog([miss('a', 'stuck', 10)]);
  assert.deepEqual(keys(mount({ states: null }).state.misses), ['a']);
  assert.deepEqual(keys(mount({ states: undefined }).state.misses), ['a']);
});

// ─── visibilitychange ────────────────────────────────────────────────────────
console.log('\nvisibilitychange');
test('mount registers exactly one visibilitychange listener', () => {
  resetEnv();
  mount();
  assert.equal(env.listeners.length, 1);
  assert.equal(env.listeners[0].type, 'visibilitychange');
  assert.equal(env.added, 1);
});
test('→ visible re-reads the durable log (a miss recorded while away appears on return)', () => {
  resetEnv();
  const d = mount();
  assert.deepEqual(d.state.misses, []);
  writeLog([miss('away', 'stuck', NOW - 5)]);
  assert.deepEqual(d.state.misses, [], 'not re-read until the visibility event');
  setVisibility('visible');
  assert.deepEqual(keys(d.state.misses), ['away']);
});
test('→ hidden does NOT re-read the log', () => {
  resetEnv();
  const d = mount();
  writeLog([miss('away', 'stuck', NOW - 5)]);
  const before = d.renders;
  setVisibility('hidden');
  assert.deepEqual(d.state.misses, []);
  assert.equal(d.renders, before, 'no render at all on hidden');
});
test('only the literal "visible" state re-reads (any other state, e.g. prerender, does not)', () => {
  resetEnv();
  const d = mount();
  writeLog([miss('away', 'stuck', NOW - 5)]);
  setVisibility('prerender');
  assert.deepEqual(d.state.misses, []);
});
test('unmount removes the very listener that was added', () => {
  resetEnv();
  const d = mount();
  const registered = env.listeners[0].fn;
  d.unmount();
  assert.equal(env.removed, 1);
  assert.equal(env.listeners.length, 0);
  assert.ok(registered);
});
test('a currentStates change does NOT re-register the listener (compute identity is stable)', () => {
  resetEnv();
  const d = mount({ states: [row('a', 'stuck')] });
  d.set({ states: [row('a', 'stuck')] });
  d.set({ states: [row('a', 'active')] });
  assert.equal(env.added, 1, 'registered once');
  assert.equal(env.removed, 0, 'never torn down by a poll');
});

// ─── [currentStates] re-reconcile ────────────────────────────────────────────
console.log('\n[currentStates] re-reconcile (WARDEN-476)');
test('a fresh poll landing after mount suppresses a chat that recovered, and un-suppresses it if it re-sticks (log untouched)', () => {
  resetEnv();
  writeLog([miss('a', 'stuck', NOW - 5)]);
  const d = mount({ states: null });
  assert.deepEqual(keys(d.state.misses), ['a']);
  d.set({ states: [row('a', 'active')] });
  assert.deepEqual(d.state.misses, [], 'recovered → suppressed by the [currentStates] effect');
  assert.equal(readLog().length, 1, 'the durable log is never mutated by reconcile');
  d.set({ states: [row('a', 'stuck')] });
  assert.deepEqual(keys(d.state.misses), ['a'], 'still in the log → resurfaces when stuck again');
});
test('the poll path agrees with the return path: visibility recompute uses the latest states', () => {
  resetEnv();
  writeLog([miss('a', 'stuck', NOW - 5)]);
  const d = mount();
  d.set({ states: [row('a', 'active')] });
  assert.deepEqual(d.state.misses, []);
  setVisibility('visible');
  assert.deepEqual(d.state.misses, [], 'the stable compute reads the freshest snapshot via the ref');
});
test('an unrelated re-render with the SAME currentStates reference does not recompute', () => {
  resetEnv();
  const states = [row('a', 'stuck')];
  writeLog([miss('a', 'stuck', NOW - 5)]);
  const d = mount({ states });
  const frame = d.state;
  const renders = d.renders;
  d.set({ onOpenChat: recorder() });
  assert.equal(d.renders, renders + 1, 'only the parent re-render itself');
  assert.equal(d.state.misses, frame.misses, 'misses array identity unchanged → no setMisses');
});
test('callbacks keep a stable identity across currentStates changes', () => {
  resetEnv();
  const onOpen = recorder();
  const d = mount({ onOpenChat: onOpen, states: [row('a', 'stuck')] });
  const first = d.state;
  d.set({ states: [row('a', 'active')] });
  assert.equal(d.state.ackKey, first.ackKey);
  assert.equal(d.state.dismiss, first.dismiss);
  assert.equal(d.state.openMiss, first.openMiss);
});
test('a STALE ackKey from the first frame still reconciles against the latest states (ref threading)', () => {
  resetEnv();
  writeLog([miss('a', 'stuck', NOW - 5), miss('b', 'stuck', NOW - 4)]);
  const d = mount({ states: null });
  const staleAck = d.state.ackKey;
  d.set({ states: [row('a', 'active'), row('b', 'stuck')] });
  assert.deepEqual(keys(d.state.misses), ['b']);
  staleAck('b');
  assert.deepEqual(d.state.misses, [], 'b acked; a stays suppressed — a stale null snapshot would resurrect it');
});

// ─── ackKey ──────────────────────────────────────────────────────────────────
console.log('\nackKey');
test('empty key is a no-op: no write, no render', () => {
  resetEnv();
  writeLog([miss('a', 'stuck', NOW - 5)]);
  const d = mount();
  const writes = env.setItemCalls;
  const renders = d.renders;
  d.state.ackKey('');
  assert.equal(env.setItemCalls, writes);
  assert.equal(d.renders, renders);
  assert.equal(readLog().length, 1);
});
test('empty key never matches a recorded miss that itself has an empty key (toWatchMiss can yield "")', () => {
  resetEnv();
  writeLog([miss('', 'stuck', NOW - 5)]);
  const d = mount();
  d.state.ackKey('');
  assert.equal(readLog().length, 1, 'the guard fires before the log is consulted');
});
test('a key with nothing recorded short-circuits: no write, no recompute', () => {
  resetEnv();
  writeLog([miss('a', 'stuck', NOW - 5)]);
  const d = mount();
  const writes = env.setItemCalls;
  const renders = d.renders;
  d.state.ackKey('not-watched');
  assert.equal(env.setItemCalls, writes, 'no redundant localStorage write');
  assert.equal(d.renders, renders, 'no redundant recompute');
});
test('acking a recorded key persists the log without it, keeps other chats, and recomputes', () => {
  resetEnv();
  writeLog([miss('a', 'stuck', NOW - 5), miss('a', 'completed', NOW - 3), miss('b', 'stuck', NOW - 4)]);
  const d = mount();
  assert.deepEqual(keys(d.state.misses).sort(), ['a', 'b']);
  d.state.ackKey('a');
  assert.deepEqual(readLog().map((m) => m.key), ['b'], 'every entry for the key is dropped, others persist');
  assert.deepEqual(keys(d.state.misses), ['b']);
});
test('ackKey does NOT advance the seen boundary', () => {
  resetEnv();
  writeLog([miss('a', 'stuck', NOW - 5)]);
  const d = mount();
  d.state.ackKey('a');
  assert.equal(env.store.has(WATCH_MISS_SEEN_KEY), false);
});
test('ackKey is idempotent: the second call short-circuits', () => {
  resetEnv();
  writeLog([miss('a', 'stuck', NOW - 5)]);
  const d = mount();
  d.state.ackKey('a');
  const writes = env.setItemCalls;
  const renders = d.renders;
  d.state.ackKey('a');
  assert.equal(env.setItemCalls, writes);
  assert.equal(d.renders, renders);
});

// ─── openMiss ────────────────────────────────────────────────────────────────
console.log('\nopenMiss');
test('deep-links with exactly (key, signal) — the WARDEN-877 scrollback anchor', () => {
  resetEnv();
  const onOpen = recorder();
  writeLog([miss('a', 'custom', NOW - 5, { signal: 'ERR boom' })]);
  const d = mount({ onOpenChat: onOpen });
  d.state.openMiss(d.state.misses[0]);
  assert.deepEqual(onOpen.calls, [['a', 'ERR boom']]);
});
test('a miss with no signal passes undefined as the anchor (focus-only open)', () => {
  resetEnv();
  const onOpen = recorder();
  writeLog([miss('a', 'stuck', NOW - 5)]);
  const d = mount({ onOpenChat: onOpen });
  d.state.openMiss(d.state.misses[0]);
  assert.equal(onOpen.calls.length, 1);
  assert.equal(onOpen.calls[0][0], 'a');
  assert.equal(onOpen.calls[0][1], undefined);
});
test('opens BEFORE acking: the log still holds the key when onOpenChat runs', () => {
  resetEnv();
  writeLog([miss('a', 'stuck', NOW - 5)]);
  let logAtOpen = null;
  const d = mount({
    onOpenChat: () => {
      logAtOpen = readLog().map((m) => m.key);
    },
  });
  d.state.openMiss(d.state.misses[0]);
  assert.deepEqual(logAtOpen, ['a'], 'deep-link first');
  assert.deepEqual(readLog(), [], 'ack happened after');
});
test('acks ONLY the opened chat; other chats remain', () => {
  resetEnv();
  writeLog([miss('a', 'stuck', NOW - 5), miss('b', 'stuck', NOW - 4)]);
  const d = mount({ onOpenChat: recorder() });
  d.state.openMiss(d.state.misses.find((m) => m.key === 'a'));
  assert.deepEqual(readLog().map((m) => m.key), ['b']);
  assert.deepEqual(keys(d.state.misses), ['b']);
  assert.equal(env.store.has(WATCH_MISS_SEEN_KEY), false, 'per-key ack never stamps seen');
});
test('still acks (and does not throw) when onOpenChat is absent', () => {
  resetEnv();
  writeLog([miss('a', 'stuck', NOW - 5)]);
  const d = mount();
  d.state.openMiss(d.state.misses[0]);
  assert.deepEqual(d.state.misses, []);
  assert.deepEqual(readLog(), []);
});
test('uses the LATEST onOpenChat after the parent re-renders with a new one', () => {
  resetEnv();
  const first = recorder();
  const second = recorder();
  writeLog([miss('a', 'stuck', NOW - 5)]);
  const d = mount({ onOpenChat: first });
  d.set({ onOpenChat: second });
  d.state.openMiss(d.state.misses[0]);
  assert.equal(first.calls.length, 0);
  assert.equal(second.calls.length, 1);
});

// ─── dismiss ─────────────────────────────────────────────────────────────────
console.log('\ndismiss');
test('stamps the seen boundary at now, clears the surface, and keeps the log as history', () => {
  resetEnv();
  writeLog([miss('a', 'stuck', NOW - 5), miss('b', 'completed', NOW - 4)]);
  const d = mount();
  assert.equal(d.state.misses.length, 2);
  d.state.dismiss();
  assert.equal(env.store.get(WATCH_MISS_SEEN_KEY), String(NOW));
  assert.deepEqual(d.state.misses, []);
  assert.equal(readLog().length, 2, 'log entries remain (bounded ring-buffer history)');
});
test('a miss recorded after the dismissal resurfaces on return; one fired at the boundary instant is kept (>=)', () => {
  resetEnv();
  writeLog([miss('a', 'stuck', NOW - 5)]);
  const d = mount();
  d.state.dismiss();
  writeLog([...readLog(), miss('fresh', 'stuck', NOW + 1), miss('edge', 'stuck', NOW)]);
  setVisibility('visible');
  assert.deepEqual(keys(d.state.misses).sort(), ['edge', 'fresh']);
});
test('dismissed misses do not come back on a later visibility return or poll', () => {
  resetEnv();
  writeLog([miss('a', 'stuck', NOW - 5)]);
  const d = mount({ states: [row('a', 'stuck')] });
  d.state.dismiss();
  setVisibility('visible');
  d.set({ states: [row('a', 'stuck')] });
  assert.deepEqual(d.state.misses, []);
});

console.log(`\n${passed} passed`);
