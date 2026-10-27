// Tests for web/src/lib/useStickToBottom.ts — the chat-list / Follow
// stick-to-bottom scroll hook shared by ObserverPanel (always-on) and
// FileViewer's Follow toggle (`enabled`). This hook had ZERO references in any
// suite file (the web/src/lib hook layer is the suite's structural blind spot).
//
// WHY THESE LEGS (each is a real user-visible regression if broken):
//   - threshold: `distance < 24` is STRICT — 23px still counts as pinned, 24px
//     does not. A `<=`/larger/smaller threshold either fights the user or
//     drops auto-follow on sub-pixel drift.
//   - synchronous follow flag: updated in the scroll handler, so a scroll-up is
//     respected by stickIfPinned / content growth even BEFORE a re-render.
//   - content growth pins immediately and coalesces a burst to ONE rAF
//     follow-up; the frame clears its handle so a later burst reschedules;
//     growth after a scroll-up never yanks the user back.
//   - scrollToBottom: target scrollHeight, default 'auto', prefers-reduced-motion
//     downgrades 'smooth', and it re-engages follow + atBottom.
//   - enabled gate: false attaches nothing and leaves atBottom true (no phantom
//     jump button); false→true attaches, true→false tears down.
//   - attach shape + teardown: passive scroll listener, ResizeObserver on the
//     viewport AND its content child, MutationObserver {childList, subtree,
//     characterData}, an initial measure; teardown removes the listener,
//     disconnects both observers, cancels a pending frame and nulls the viewport.
//
// HARNESS (same seam-first shape as useAsyncConfirm.test.mjs, WARDEN-1960):
// no React runner exists in this repo, so the REAL module is transpiled with
// vite's transformWithOxc and its only value import (`react`) is rewritten onto
// a test-local useState/useRef/useCallback/useLayoutEffect shim. The rewrite is
// ASSERTED, not assumed: react IS installed in web/, so an unrewritten import
// would load the REAL react, whose hooks throw outside a renderer — a loud
// failure, never a silent false pass. DOM pieces (viewport, ResizeObserver,
// MutationObserver, rAF, matchMedia) are fake globals. Per WARDEN-997 the first
// legs prove the DRIVER really re-renders on setState, memoizes by deps, and
// runs layout effects + cleanups by deps before any behavior verdict.
//
// Run: node useStickToBottom.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tmpDir = mkdtempSync(join(__dirname, '.use-stick-to-bottom-test-'));

// react-shim.mjs — slot-based hooks over a module-level CURRENT instance that
// the driver aims before every render. Render-on-set (state writes re-execute
// the mounted hook synchronously). useCallback/useRef are memoized per slot;
// useLayoutEffect queues during render, and the driver flushes after the frame
// (cleanup of the previous run first) only when deps changed.
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
  if (self.slots.length <= slot) self.slots.push({ value: initial });
  const cell = self.slots[slot];
  return [cell.value, (next) => {
    cell.value = typeof next === 'function' ? next(cell.value) : next;
    self.render();
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
export function useLayoutEffect(fn, deps) {
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

const hookPath = resolve(__dirname, 'src/lib/useStickToBottom.ts');
const { code } = await transformWithOxc(readFileSync(hookPath, 'utf8'), hookPath, {});
const rewritten = code
  .replaceAll('"react"', '"./react-shim.mjs"')
  .replaceAll("'react'", "'./react-shim.mjs'");
assert.ok(
  rewritten.includes('"./react-shim.mjs"'),
  'the react specifier rewrite must land — an unrewritten import would load the real react, whose hooks throw outside a renderer',
);
writeFileSync(join(tmpDir, 'useStickToBottom.mjs'), rewritten);

const { useStickToBottom } = await import(join(tmpDir, 'useStickToBottom.mjs'));
const {
  __aim: aimShim,
  useState: useStateShim,
  useCallback: useCallbackShim,
  useLayoutEffect: useLayoutEffectShim,
} = await import(join(tmpDir, 'react-shim.mjs'));
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed += 1;
  console.log('  ok -', name);
};

// --- Fake DOM / platform globals ---------------------------------------------
const env = {
  reducedMotion: false,
  mediaQueries: [],
  frames: new Map(), // handle -> callback
  nextHandle: 1,
  cancelled: [],
  requested: 0,
  resizeObservers: [],
  mutationObservers: [],
};
const resetEnv = () => {
  env.reducedMotion = false;
  env.mediaQueries = [];
  env.frames = new Map();
  env.nextHandle = 1;
  env.cancelled = [];
  env.requested = 0;
  env.resizeObservers = [];
  env.mutationObservers = [];
};

globalThis.requestAnimationFrame = (cb) => {
  const handle = env.nextHandle++;
  env.requested += 1;
  env.frames.set(handle, cb);
  return handle;
};
globalThis.cancelAnimationFrame = (handle) => {
  env.cancelled.push(handle);
  env.frames.delete(handle);
};
// Run every pending frame (a frame callback may schedule more — only the
// frames pending at call time run).
const runFrames = () => {
  const pending = [...env.frames.entries()];
  for (const [handle, cb] of pending) {
    env.frames.delete(handle);
    cb();
  }
};
globalThis.window = {
  matchMedia: (query) => {
    env.mediaQueries.push(query);
    return { matches: env.reducedMotion };
  },
};
globalThis.ResizeObserver = class {
  constructor(cb) {
    this.cb = cb;
    this.observed = [];
    this.disconnected = 0;
    env.resizeObservers.push(this);
  }
  observe(el) {
    this.observed.push(el);
  }
  disconnect() {
    this.disconnected += 1;
  }
};
globalThis.MutationObserver = class {
  constructor(cb) {
    this.cb = cb;
    this.observed = [];
    this.disconnected = 0;
    env.mutationObservers.push(this);
  }
  observe(el, opts) {
    this.observed.push({ el, opts });
  }
  disconnect() {
    this.disconnected += 1;
  }
};

// A fake Radix viewport: mutable geometry + recorded listeners / scrollTo.
const makeViewport = ({ scrollHeight = 1000, clientHeight = 400, scrollTop = 600, content = {} } = {}) => {
  const vp = {
    scrollHeight,
    clientHeight,
    scrollTop,
    firstElementChild: content,
    listeners: [],
    removed: [],
    scrollToCalls: [],
    addEventListener(type, fn, opts) {
      vp.listeners.push({ type, fn, opts });
    },
    removeEventListener(type, fn) {
      vp.removed.push({ type, fn });
    },
    scrollTo(opts) {
      vp.scrollToCalls.push(opts);
    },
    // Fire the scroll handler(s) the hook registered.
    fireScroll() {
      for (const l of vp.listeners.filter((x) => x.type === 'scroll')) l.fn();
    },
    // Place the viewport `px` above the bottom and fire a scroll event.
    scrollAwayFromBottom(px) {
      vp.scrollTop = vp.scrollHeight - vp.clientHeight - px;
      vp.fireScroll();
    },
  };
  return vp;
};
const makeRoot = (vp) => {
  const root = {
    selectors: [],
    querySelector(sel) {
      root.selectors.push(sel);
      return vp;
    },
  };
  return root;
};

// --- The driver --------------------------------------------------------------
const mountHook = (runHook, beforeEffects) => {
  const inst = {
    slots: [],
    pendingEffects: [],
    cursor: 0,
    renders: 0,
    state: null,
    render: null,
    unmount: null,
  };
  inst.render = () => {
    aimShim(inst);
    inst.cursor = 0;
    inst.renders += 1;
    inst.state = runHook();
    if (beforeEffects) beforeEffects(inst.state);
    const queued = inst.pendingEffects;
    inst.pendingEffects = [];
    for (let i = 0; i < queued.length; i += 2) {
      const cell = queued[i];
      const fn = queued[i + 1];
      if (typeof cell.cleanup === 'function') cell.cleanup();
      cell.cleanup = fn() ?? null;
    }
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

// Mount useStickToBottom against a fake viewport. The rootRef is attached BEFORE
// layout effects run (as React does for refs). `viewport: null` mounts with no
// root element at all; `noViewport: true` gives a root whose querySelector misses.
const mount = ({ enabled = true, vp = makeViewport(), noRoot = false, noViewport = false } = {}) => {
  resetEnv();
  const props = { enabled };
  const root = noViewport
    ? {
        selectors: [],
        querySelector(sel) {
          root.selectors.push(sel);
          return null;
        },
      }
    : makeRoot(vp);
  const driver = mountHook(
    () => useStickToBottom(props.enabled),
    (state) => {
      if (!noRoot && state.rootRef.current !== root) state.rootRef.current = root;
    },
  );
  return {
    driver,
    vp,
    root,
    get bag() {
      return driver.state;
    },
    setEnabled(next) {
      props.enabled = next;
      driver.render();
    },
    // Invoke the ResizeObserver / MutationObserver callbacks (content growth).
    grow() {
      env.resizeObservers.at(-1).cb();
    },
    mutate() {
      env.mutationObservers.at(-1).cb();
    },
  };
};

// ─── driver preconditions (WARDEN-997) ───────────────────────────────────────
console.log('\ndriver preconditions — the shim re-renders, memoizes by deps, runs layout effects + cleanups (WARDEN-997)');
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
await test('useCallback is stable while deps are unchanged and refreshes when they change', () => {
  let dep = 'a';
  const driver = mountHook(() => ({ cb: useCallbackShim(() => dep, [dep]) }));
  const first = driver.state.cb;
  driver.render();
  assert.equal(driver.state.cb, first, 'same deps → same identity');
  dep = 'b';
  driver.render();
  assert.notEqual(driver.state.cb, first, 'changed deps → new identity');
  assert.equal(driver.state.cb(), 'b');
});
await test('useLayoutEffect runs on mount, runs the previous cleanup before re-running on a dep change, and cleans up on unmount', () => {
  const log = [];
  let dep = 1;
  const driver = mountHook(() => {
    useLayoutEffectShim(() => {
      const mine = dep;
      log.push(`run${mine}`);
      return () => log.push(`clean${mine}`);
    }, [dep]);
    return {};
  });
  assert.deepEqual(log, ['run1']);
  driver.render();
  assert.deepEqual(log, ['run1'], 'same deps → no re-run');
  dep = 2;
  driver.render();
  assert.deepEqual(log, ['run1', 'clean1', 'run2']);
  driver.unmount();
  assert.deepEqual(log, ['run1', 'clean1', 'run2', 'clean2']);
});

// ─── leg 1 — the strict 24px threshold ───────────────────────────────────────
console.log('\nleg 1 — distance < 24 is STRICT');
await test('23px from the bottom still counts as pinned; 24px does not', () => {
  const m = mount();
  m.vp.scrollAwayFromBottom(23);
  assert.equal(m.bag.atBottom, true, '23px is within the threshold');
  m.vp.scrollAwayFromBottom(24);
  assert.equal(m.bag.atBottom, false, '24px is NOT pinned (strict <)');
  m.vp.scrollAwayFromBottom(25);
  assert.equal(m.bag.atBottom, false);
  m.vp.scrollAwayFromBottom(0);
  assert.equal(m.bag.atBottom, true);
});
await test('the threshold also governs the follow flag: at 23px stickIfPinned pins, at 24px it does not', () => {
  const m = mount();
  m.vp.scrollAwayFromBottom(23);
  m.bag.stickIfPinned();
  assert.equal(m.vp.scrollTop, m.vp.scrollHeight, '23px → still following → pinned to scrollHeight');
  m.vp.scrollAwayFromBottom(24);
  const before = m.vp.scrollTop;
  m.bag.stickIfPinned();
  assert.equal(m.vp.scrollTop, before, '24px → not following → untouched');
});

// ─── leg 2 — the synchronous follow flag ─────────────────────────────────────
console.log('\nleg 2 — follow flag is synchronous: a scroll-up is respected before any re-render');
await test('after a scroll-up, a stale stickIfPinned reference never yanks the user back', () => {
  const m = mount();
  const staleStick = m.bag.stickIfPinned; // grabbed BEFORE the scroll
  const rendersBefore = m.driver.renders;
  m.vp.scrollAwayFromBottom(300);
  const awayTop = m.vp.scrollTop;
  staleStick();
  assert.equal(m.vp.scrollTop, awayTop, 'the ref flag, not a lagging render, gates the pin');
  // atBottom state did flip to false on the same event.
  assert.ok(m.driver.renders > rendersBefore);
  assert.equal(m.bag.atBottom, false);
});
await test('scrolling back near the bottom re-engages follow', () => {
  const m = mount();
  m.vp.scrollAwayFromBottom(300);
  m.vp.scrollAwayFromBottom(5);
  m.bag.stickIfPinned();
  assert.equal(m.vp.scrollTop, m.vp.scrollHeight);
});
await test('stickIfPinned with no viewport (never attached) is a harmless no-op', () => {
  const m = mount({ noRoot: true });
  assert.doesNotThrow(() => m.bag.stickIfPinned());
});

// ─── leg 3 — content growth ──────────────────────────────────────────────────
console.log('\nleg 3 — content growth: pin now, coalesce a burst to one frame, respect a scroll-up');
await test('growth while pinned pins to the NEW scrollHeight immediately (no frame needed)', () => {
  const m = mount();
  m.vp.scrollHeight = 1500;
  m.grow();
  assert.equal(m.vp.scrollTop, 1500);
  m.vp.scrollHeight = 1800;
  m.mutate();
  assert.equal(m.vp.scrollTop, 1800, 'the MutationObserver callback grows the same way');
});
await test('a burst of growth events schedules exactly ONE rAF; the frame re-pins to the settled height', () => {
  const m = mount();
  const requestedBefore = env.requested;
  m.vp.scrollHeight = 1100;
  m.grow();
  m.vp.scrollHeight = 1200;
  m.grow();
  m.mutate();
  assert.equal(env.requested - requestedBefore, 1, 'burst coalesced to a single follow-up frame');
  m.vp.scrollHeight = 1300; // further settling before the frame
  runFrames();
  assert.equal(m.vp.scrollTop, 1300, 'the frame catches the settling the immediate pin missed');
});
await test('the frame clears its handle: a LATER burst schedules a fresh frame', () => {
  const m = mount();
  const requestedBefore = env.requested;
  m.grow();
  runFrames();
  assert.equal(env.requested - requestedBefore, 1);
  m.grow();
  assert.equal(env.requested - requestedBefore, 2, 'second burst must reschedule');
  runFrames();
  m.grow();
  assert.equal(env.requested - requestedBefore, 3);
});
await test('growth after a scroll-up does NOT pin — neither immediately nor in the follow-up frame', () => {
  const m = mount();
  m.vp.scrollAwayFromBottom(300);
  const awayTop = m.vp.scrollTop;
  m.vp.scrollHeight = 2000;
  m.grow();
  assert.equal(m.vp.scrollTop, awayTop, 'immediate re-pin must respect the scroll-up');
  runFrames();
  assert.equal(m.vp.scrollTop, awayTop, 'the follow-up frame must respect it too');
});

// ─── leg 4 — scrollToBottom ──────────────────────────────────────────────────
console.log('\nleg 4 — scrollToBottom');
await test('scrolls to scrollHeight with behavior defaulting to "auto"', () => {
  const m = mount();
  m.bag.scrollToBottom();
  assert.deepEqual(m.vp.scrollToCalls, [{ top: 1000, behavior: 'auto' }]);
});
await test('passes "smooth" through when the user has not asked for reduced motion', () => {
  const m = mount();
  m.bag.scrollToBottom('smooth');
  assert.deepEqual(m.vp.scrollToCalls, [{ top: 1000, behavior: 'smooth' }]);
  assert.deepEqual(env.mediaQueries, ['(prefers-reduced-motion: reduce)']);
});
await test('prefers-reduced-motion downgrades "smooth" to "auto"', () => {
  const m = mount();
  env.reducedMotion = true;
  m.bag.scrollToBottom('smooth');
  assert.deepEqual(m.vp.scrollToCalls, [{ top: 1000, behavior: 'auto' }]);
});
await test('re-engages follow AND atBottom after the user had scrolled away', () => {
  const m = mount();
  m.vp.scrollAwayFromBottom(300);
  assert.equal(m.bag.atBottom, false);
  m.bag.scrollToBottom();
  assert.equal(m.bag.atBottom, true, 'jump button disappears');
  // scrollTo is a fake that does not move scrollTop, so follow is re-engaged
  // by the flag, not by a scroll event.
  m.vp.scrollHeight = 1400;
  m.grow();
  assert.equal(m.vp.scrollTop, 1400, 'growth now follows again');
});
await test('with no viewport attached it is a no-op: no throw, no scrollTo', () => {
  const m = mount({ enabled: false });
  assert.doesNotThrow(() => m.bag.scrollToBottom('smooth'));
  assert.deepEqual(m.vp.scrollToCalls, []);
});

// ─── leg 5 — the enabled gate ────────────────────────────────────────────────
console.log('\nleg 5 — enabled gate');
await test('enabled=false attaches nothing and leaves atBottom true (no phantom jump button)', () => {
  const m = mount({ enabled: false });
  assert.equal(m.bag.atBottom, true);
  assert.deepEqual(m.root.selectors, [], 'the viewport is not even looked up');
  assert.deepEqual(m.vp.listeners, []);
  assert.equal(env.resizeObservers.length, 0);
  assert.equal(env.mutationObservers.length, 0);
});
await test('enabled=false never auto-pins: stickIfPinned has no viewport to scroll', () => {
  const m = mount({ enabled: false, vp: makeViewport({ scrollTop: 0 }) });
  m.bag.stickIfPinned();
  assert.equal(m.vp.scrollTop, 0);
});
await test('false→true attaches and measures; true→false tears everything down', () => {
  const m = mount({ enabled: false, vp: makeViewport({ scrollTop: 100 }) });
  m.setEnabled(true);
  assert.equal(m.vp.listeners.length, 1);
  assert.equal(env.resizeObservers.length, 1);
  assert.equal(env.mutationObservers.length, 1);
  assert.equal(m.bag.atBottom, false, 'the initial measure on attach sees the scrolled-up viewport');
  m.setEnabled(false);
  assert.equal(m.vp.removed.length, 1);
  assert.equal(env.resizeObservers[0].disconnected, 1);
  assert.equal(env.mutationObservers[0].disconnected, 1);
  // Detached: stickIfPinned can no longer scroll.
  m.vp.scrollTop = 7;
  m.bag.stickIfPinned();
  assert.equal(m.vp.scrollTop, 7);
});
await test('re-enabling re-attaches fresh observers (Follow toggled off and on)', () => {
  const m = mount();
  m.setEnabled(false);
  m.setEnabled(true);
  assert.equal(env.resizeObservers.length, 2);
  assert.equal(env.mutationObservers.length, 2);
  assert.equal(m.vp.listeners.length, 2);
});
await test('an unrelated re-render does not re-attach (effect keyed on stable measure/onGrow/enabled)', () => {
  const m = mount();
  m.driver.render();
  m.driver.render();
  assert.equal(m.vp.listeners.length, 1);
  assert.equal(env.resizeObservers.length, 1);
  assert.equal(env.mutationObservers.length, 1);
});

// ─── leg 6 — attach shape ────────────────────────────────────────────────────
console.log('\nleg 6 — attach shape');
await test('looks the viewport up by the Radix data-slot selector', () => {
  const m = mount();
  assert.deepEqual(m.root.selectors, ['[data-slot="scroll-area-viewport"]']);
});
await test('registers exactly one PASSIVE scroll listener', () => {
  const m = mount();
  assert.equal(m.vp.listeners.length, 1);
  assert.equal(m.vp.listeners[0].type, 'scroll');
  assert.deepEqual(m.vp.listeners[0].opts, { passive: true });
});
await test('ResizeObserver watches the viewport AND its content child (the element that actually grows)', () => {
  const content = { tag: 'content' };
  const vp = makeViewport({ content });
  mount({ vp });
  assert.equal(env.resizeObservers.length, 1);
  assert.deepEqual(env.resizeObservers[0].observed, [vp, content]);
});
await test('a viewport with no content child observes only the viewport', () => {
  const vp = makeViewport({ content: null });
  mount({ vp });
  assert.deepEqual(env.resizeObservers[0].observed, [vp]);
});
await test('MutationObserver watches the viewport for childList + subtree + characterData', () => {
  const vp = makeViewport();
  mount({ vp });
  assert.equal(env.mutationObservers.length, 1);
  assert.deepEqual(env.mutationObservers[0].observed, [
    { el: vp, opts: { childList: true, subtree: true, characterData: true } },
  ]);
});
await test('an initial measure runs on attach: a viewport mounted scrolled-up starts with atBottom=false and follow off', () => {
  const m = mount({ vp: makeViewport({ scrollTop: 100 }) });
  assert.equal(m.bag.atBottom, false);
  m.bag.stickIfPinned();
  assert.equal(m.vp.scrollTop, 100, 'follow flag was measured, not left at its initial true');
});
await test('a viewport mounted at the bottom starts atBottom=true', () => {
  const m = mount({ vp: makeViewport({ scrollTop: 600 }) });
  assert.equal(m.bag.atBottom, true);
});
await test('no root element / no viewport in the root → nothing attached, no throw', () => {
  const a = mount({ noRoot: true });
  assert.equal(a.bag.atBottom, true);
  assert.equal(env.resizeObservers.length, 0);
  const b = mount({ noViewport: true });
  assert.equal(b.bag.atBottom, true);
  assert.deepEqual(b.root.selectors, ['[data-slot="scroll-area-viewport"]']);
  assert.equal(env.resizeObservers.length, 0);
  assert.equal(env.mutationObservers.length, 0);
});

// ─── leg 7 — teardown ────────────────────────────────────────────────────────
console.log('\nleg 7 — teardown on unmount');
await test('removes the SAME scroll listener it added and disconnects both observers', () => {
  const m = mount();
  const added = m.vp.listeners[0];
  m.driver.unmount();
  assert.equal(m.vp.removed.length, 1);
  assert.equal(m.vp.removed[0].type, 'scroll');
  assert.equal(m.vp.removed[0].fn, added.fn, 'must remove the identical handler reference');
  assert.equal(env.resizeObservers[0].disconnected, 1);
  assert.equal(env.mutationObservers[0].disconnected, 1);
});
await test('cancels a pending rAF follow-up and does not run it', () => {
  const m = mount();
  m.grow(); // schedules handle
  const [pendingHandle] = [...env.frames.keys()];
  assert.ok(pendingHandle != null);
  m.driver.unmount();
  assert.deepEqual(env.cancelled, [pendingHandle]);
  assert.equal(env.frames.size, 0);
});
await test('with no pending frame, teardown cancels nothing', () => {
  const m = mount();
  m.grow();
  runFrames();
  m.driver.unmount();
  assert.deepEqual(env.cancelled, []);
});
await test('a cancelled frame handle is cleared: after re-enable, growth schedules a fresh frame', () => {
  const m = mount();
  m.grow();
  m.setEnabled(false); // teardown cancels the frame
  m.setEnabled(true);
  const requestedBefore = env.requested;
  m.grow();
  assert.equal(env.requested - requestedBefore, 1, 'stale handle must not suppress the new frame');
});
await test('nulls the viewport: after teardown scrollToBottom and stickIfPinned are inert', () => {
  const m = mount();
  const scrollTo = m.vp.scrollToCalls.length;
  m.driver.unmount();
  m.vp.scrollTop = 3;
  m.bag.stickIfPinned();
  m.bag.scrollToBottom();
  assert.equal(m.vp.scrollTop, 3);
  assert.equal(m.vp.scrollToCalls.length, scrollTo);
});

console.log(`\n${passed} passed`);
