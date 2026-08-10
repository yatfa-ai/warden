// Regression test for WARDEN-920: the un-coalesced xterm fit→resize storm that
// made agent terminal panes jump, mis-render and lag after a workspace switch
// (only a hard reload recovered them).
//
// PaneTile drove FitAddon straight from a ResizeObserver callback and shipped a
// {type:'resize'} to the PTY on EVERY cols/rows change. A workspace switch
// remounts each pane (WARDEN-372's unmount model) into a container that is still
// settling under the grid's `transition-all duration-200`, so the pane walked a
// run of intermediate dimensions and tmux redrew the prompt once per transient →
// the input line hopped. On top of that, @xterm/addon-fit@0.11 does NOT reject a
// zero-size container: proposeDimensions() clamps to Math.max(2, …) x Math.max(1, …)
// and reports SUCCESS, so a not-yet-laid-out pane fitted itself to 2x1 — the
// `try/catch {}` never saw a throw because nothing threw.
//
// There is no FE test runner with a DOM in this repo (node --test, no jsdom —
// WARDEN-130), and the storm lives on timers inside a React component, so the fix
// extracted the timing contract into a pure, injectable-env seam
// (src/lib/paneFit.ts). This test loads the REAL module (TS -> ESM via Vite's OXC
// transform, the same harness paneAttach.test.mjs / visiblePoller.test.mjs use)
// and drives the actual workspace-switch storm through it with a hand-stepped
// fake clock.
//
// It fails if the fit is ever un-coalesced (N observer callbacks in a frame →
// N fits), if the container guard is dropped (a 0x0 container fits to 2x1), or
// if the PTY is told anything other than the settled size exactly once.
//
// Run: node paneFit.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const corePath = resolve(__dirname, 'src/lib/paneFit.ts');

// --- Load the REAL paneFit.ts -------------------------------------------------
// The module's only non-pure export is `browserFitEnv`, whose initializer just
// closes over `window` inside arrow bodies — never evaluated at import time — so
// the module loads fine under bare Node with no DOM.
const src = readFileSync(corePath, 'utf8');
const { code } = await transformWithOxc(src, corePath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-panefit-test-'));
const tmpFile = join(tmpDir, 'paneFit.mjs');
writeFileSync(tmpFile, code);
const {
  createFitScheduler,
  isFittableRect,
  shouldAnnounceSize,
  MIN_FIT_PX,
  FIT_SETTLE_MS,
  FIT_RETRY_MS,
  FIT_MAX_RETRIES,
} = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

// --- A hand-stepped fake of the frame/timer surface ---------------------------
// Frames and timers are separate queues so a test can prove that a fit happens
// on the NEXT FRAME (fast, visual) while the announce waits out a REAL DELAY
// (slow, PTY) — the asymmetry that is the whole point of the fix.
function makeEnv() {
  let nextId = 1;
  const frames = new Map();   // id -> cb
  const timers = new Map();   // id -> { fn, at }
  let now = 0;
  return {
    env: {
      requestAnimationFrame: (cb) => { const id = nextId++; frames.set(id, cb); return id; },
      cancelAnimationFrame: (id) => { frames.delete(id); },
      setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: now + ms }); return id; },
      clearTimeout: (id) => { timers.delete(id); },
    },
    /** Run every frame callback currently queued (one paint). */
    frame() {
      const due = [...frames.entries()];
      frames.clear();
      for (const [, cb] of due) cb();
    },
    /** Advance the clock, firing every timer that comes due (in due order). */
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at);
        if (!due.length) break;
        const [id, t] = due[0];
        timers.delete(id);
        now = t.at;
        t.fn();
      }
      now = target;
    },
    pendingFrames: () => frames.size,
    pendingTimers: () => timers.size,
  };
}

// --- A fake pane: a container whose size we control, and a terminal whose
//     cols/rows follow from it (mirroring what FitAddon actually does) ---------
function makePane(clock, { cellW = 8, cellH = 17 } = {}) {
  const state = {
    rect: { width: 0, height: 0 },   // container extent in CSS px
    size: { cols: 80, rows: 24 },    // xterm's constructor defaults
    rendererReady: true,             // false models "webfont still loading"
    fits: 0,                         // how many times fit() actually applied
    announced: [],                   // what the PTY was told, in order
  };
  const scheduler = createFitScheduler({
    measure: () => state.rect,
    fit: () => {
      if (!state.rendererReady) return false;   // FitAddon.proposeDimensions() -> undefined
      state.fits += 1;
      // The real FitAddon clamp — Math.max(2, …) x Math.max(1, …). Reproduced
      // faithfully so a test that removes the container guard shows the 2x1
      // degenerate result rather than a convenient zero.
      const cols = Math.max(2, Math.floor(state.rect.width / cellW));
      const rows = Math.max(1, Math.floor(state.rect.height / cellH));
      if (cols !== state.size.cols || rows !== state.size.rows) {
        state.size = { cols, rows };
        scheduler.noteResize();   // xterm fires onResize only on a real change
      }
      return true;
    },
    currentSize: () => state.size,
    announce: (s) => state.announced.push(`${s.cols}x${s.rows}`),
  }, clock.env);
  return { state, scheduler };
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

console.log('paneFit — WARDEN-920 fit/resize coalescing');

// === The guard: FitAddon's degenerate success on an unlaid-out container ======

test('isFittableRect rejects the containers that fit to a degenerate 2x1', () => {
  assert.equal(isFittableRect({ width: 0, height: 0 }), false, 'a freshly remounted tile');
  assert.equal(isFittableRect({ width: 900, height: 0 }), false, 'zero HEIGHT is as fatal as zero width');
  assert.equal(isFittableRect({ width: 0, height: 600 }), false, 'zero width');
  assert.equal(isFittableRect({ width: NaN, height: 600 }), false, 'NaN from a value-less computed style');
  assert.equal(isFittableRect(null), false, 'no measurement at all (ref not attached)');
  assert.equal(isFittableRect(undefined), false);
  assert.equal(isFittableRect({ width: MIN_FIT_PX - 1, height: 600 }), false, 'just under the floor');
});

test('isFittableRect accepts real panes, including small ones', () => {
  assert.equal(isFittableRect({ width: MIN_FIT_PX, height: MIN_FIT_PX }), true, 'exactly at the floor');
  assert.equal(isFittableRect({ width: 900, height: 600 }), true);
});

test('a 0x0 container is never fitted — no degenerate 2x1 reaches the terminal', () => {
  const clock = makeEnv();
  const { state, scheduler } = makePane(clock);
  state.rect = { width: 0, height: 0 };        // mid-remount, not laid out yet
  scheduler.request();
  clock.frame();
  assert.equal(state.fits, 0, 'fit() must not run against an unmeasured container');
  assert.deepEqual(state.size, { cols: 80, rows: 24 }, 'terminal keeps its defaults, NOT 2x1');
  clock.advance(FIT_SETTLE_MS * 4);
  assert.deepEqual(state.announced, [], 'and the PTY is told nothing');
});

// === The fit half: coalesced to one per frame, but still live ================

test('a burst of observer callbacks in one frame collapses to a single fit', () => {
  const clock = makeEnv();
  const { state, scheduler } = makePane(clock);
  state.rect = { width: 800, height: 408 };
  // The grid transition + gutter layout can call the observer several times
  // before the browser paints.
  for (let i = 0; i < 12; i += 1) scheduler.request();
  assert.equal(clock.pendingFrames(), 1, 'only ONE frame is ever queued');
  clock.frame();
  assert.equal(state.fits, 1, 'twelve requests, one fit');
});

test('the fit is still LIVE across frames — a gutter drag reflows every frame (WARDEN-660)', () => {
  const clock = makeEnv();
  const { state, scheduler } = makePane(clock);
  const widths = [800, 760, 720, 680, 640];
  for (const width of widths) {
    state.rect = { width, height: 408 };
    scheduler.request();
    clock.frame();       // one paint per pointermove
  }
  assert.equal(state.fits, widths.length, 'every frame during the drag re-fits — no visual freeze');
  assert.deepEqual(state.size, { cols: 80, rows: 24 }, '640/8 = 80 cols at the end of the drag');
});

// === The announce half: the PTY learns the SETTLED size, once ================

test('the workspace-switch storm announces the settled size exactly once', () => {
  const clock = makeEnv();
  const { state, scheduler } = makePane(clock);
  // A remounted pane whose container grows through the 200ms grid transition.
  // Pre-fix this produced one resize message per step.
  const steps = [
    { width: 0, height: 0 },
    { width: 120, height: 60 },
    { width: 340, height: 170 },
    { width: 560, height: 280 },
    { width: 780, height: 390 },
    { width: 900, height: 476 },
  ];
  for (const rect of steps) {
    state.rect = rect;
    scheduler.request();
    clock.frame();
    clock.advance(16);        // ~one frame of wall-clock between steps
  }
  assert.equal(state.announced.length, 0, 'nothing is announced while the layout is still moving');
  clock.advance(FIT_SETTLE_MS);
  assert.deepEqual(state.announced, ['112x28'], 'exactly one resize, carrying the settled geometry');
  assert.deepEqual(state.size, { cols: 112, rows: 28 });
});

test('a pane that settles back to the size the PTY already has stays silent', () => {
  const clock = makeEnv();
  const { state, scheduler } = makePane(clock);
  // The attach message carried this geometry, so the PTY already knows it.
  scheduler.markAnnounced({ cols: 100, rows: 25 });
  state.rect = { width: 800, height: 425 };    // 800/8 = 100 cols, 425/17 = 25 rows
  scheduler.request();
  clock.frame();
  clock.advance(FIT_SETTLE_MS * 2);
  assert.deepEqual(state.announced, [], 'no redundant resize → tmux has no reason to redraw the prompt');
});

test('back-and-forth switching announces only the sizes that actually differ', () => {
  const clock = makeEnv();
  const { state, scheduler } = makePane(clock);
  const settle = (rect) => {
    state.rect = rect;
    scheduler.request();
    clock.frame();
    clock.advance(FIT_SETTLE_MS * 2);
  };
  settle({ width: 800, height: 425 });   // 100x25
  settle({ width: 400, height: 425 });   // 50x25
  settle({ width: 800, height: 425 });   // back to 100x25
  settle({ width: 800, height: 425 });   // switch away and back, same geometry
  assert.deepEqual(state.announced, ['100x25', '50x25', '100x25'],
    'one announce per genuine settled geometry; the no-op switch adds nothing');
});

test('shouldAnnounceSize rejects repeats and nonsense geometries', () => {
  assert.equal(shouldAnnounceSize(null, { cols: 100, rows: 25 }), true, 'first announce');
  assert.equal(shouldAnnounceSize({ cols: 100, rows: 25 }, { cols: 100, rows: 25 }), false, 'identical repeat');
  assert.equal(shouldAnnounceSize({ cols: 100, rows: 25 }, { cols: 100, rows: 26 }), true, 'rows changed');
  assert.equal(shouldAnnounceSize({ cols: 100, rows: 25 }, { cols: 99, rows: 25 }), true, 'cols changed');
  assert.equal(shouldAnnounceSize(null, { cols: 0, rows: 25 }), false, 'zero cols is not a terminal');
  assert.equal(shouldAnnounceSize(null, { cols: NaN, rows: 25 }), false, 'NaN never reaches the PTY');
});

// === Readiness retry: the case a ResizeObserver can never re-fire for ========

test('a fit blocked by unready cell metrics retries until the renderer is ready', () => {
  const clock = makeEnv();
  const { state, scheduler } = makePane(clock);
  state.rect = { width: 800, height: 425 };
  state.rendererReady = false;              // webfont still loading
  scheduler.request();
  clock.frame();
  assert.equal(state.fits, 0);
  clock.advance(FIT_RETRY_MS); clock.frame();   // retry #1 — still not ready
  assert.equal(state.fits, 0);
  state.rendererReady = true;
  clock.advance(FIT_RETRY_MS); clock.frame();   // retry #2 — now it lands
  assert.equal(state.fits, 1, 'the pane reaches its correct size with no further reflow');
  clock.advance(FIT_SETTLE_MS);
  assert.deepEqual(state.announced, ['100x25']);
});

test('retries are bounded — a permanently unfittable pane does not spin forever', () => {
  const clock = makeEnv();
  const { state, scheduler } = makePane(clock);
  state.rect = { width: 0, height: 0 };     // e.g. a collapsed track
  scheduler.request();
  clock.frame();
  for (let i = 0; i < FIT_MAX_RETRIES + 5; i += 1) { clock.advance(FIT_RETRY_MS); clock.frame(); }
  assert.equal(state.fits, 0);
  assert.equal(clock.pendingTimers(), 0, 'the retry chain terminates');
  assert.equal(clock.pendingFrames(), 0);
});

test('the retry budget is restored after a successful fit', () => {
  const clock = makeEnv();
  const { state, scheduler } = makePane(clock);
  state.rect = { width: 0, height: 0 };
  scheduler.request();
  clock.frame();
  for (let i = 0; i < FIT_MAX_RETRIES + 5; i += 1) { clock.advance(FIT_RETRY_MS); clock.frame(); }
  // The pane finally gets laid out and fits...
  state.rect = { width: 800, height: 425 };
  scheduler.request(); clock.frame();
  assert.equal(state.fits, 1);
  // ...so a LATER unready spell gets a full budget again, rather than inheriting
  // an exhausted counter from the pane's first moments.
  state.rendererReady = false;
  state.rect = { width: 400, height: 425 };
  scheduler.request(); clock.frame();
  assert.equal(clock.pendingTimers() > 0, true, 'a fresh retry is armed');
  state.rendererReady = true;
  clock.advance(FIT_RETRY_MS); clock.frame();
  assert.equal(state.fits, 2, 'the later fit still lands');
});

// === Lifecycle: an unmounted pane must go completely quiet ===================

test('dispose cancels the pending frame and the pending announce', () => {
  const clock = makeEnv();
  const { state, scheduler } = makePane(clock);
  state.rect = { width: 800, height: 425 };
  scheduler.request();
  clock.frame();                       // fit ran, settle timer armed
  assert.equal(state.fits, 1);
  scheduler.request();                 // a frame is queued...
  scheduler.dispose();                 // ...and the pane unmounts (workspace switch)
  clock.frame();
  clock.advance(FIT_SETTLE_MS * 4);
  assert.equal(state.fits, 1, 'no fit runs against a disposed pane');
  assert.deepEqual(state.announced, [], 'no resize is sent for a pane that is detaching');
  assert.equal(clock.pendingFrames(), 0);
  assert.equal(clock.pendingTimers(), 0);
});

test('requests after dispose are inert', () => {
  const clock = makeEnv();
  const { state, scheduler } = makePane(clock);
  state.rect = { width: 800, height: 425 };
  scheduler.dispose();
  scheduler.request();
  scheduler.fitNow();
  scheduler.noteResize();
  clock.frame();
  clock.advance(FIT_SETTLE_MS * 4);
  assert.equal(state.fits, 0);
  assert.deepEqual(state.announced, []);
});

// === fitNow: the attach path, which must read cols/rows in the same tick =====

test('fitNow fits synchronously so the attach message can carry real dimensions', () => {
  const clock = makeEnv();
  const { state, scheduler } = makePane(clock);
  state.rect = { width: 800, height: 425 };
  scheduler.fitNow();
  assert.equal(state.fits, 1, 'no frame wait — attach reads the size in this tick');
  assert.deepEqual(state.size, { cols: 100, rows: 25 });
});

test('fitNow honors the container guard on a not-yet-laid-out pane', () => {
  const clock = makeEnv();
  const { state, scheduler } = makePane(clock);
  state.rect = { width: 0, height: 0 };
  scheduler.fitNow();
  assert.equal(state.fits, 0, 'attach must never bind the PTY to a degenerate 2x1');
  assert.deepEqual(state.size, { cols: 80, rows: 24 });
});

console.log(`\n${passed} passed`);
