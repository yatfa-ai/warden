// Tests for web/src/lib/usePaneGridResize.ts — the WARDEN-660 resize-gutter engine,
// extracted verbatim from PaneGrid by WARDEN-2002. The pure helpers it calls
// (redistributeRatios, resolveJunctionAxis, gutterCenters, equalRatios) are covered in
// paneGrid.test.mjs, and paneGridGutterContextMenu.test.mjs only reads the hook's file
// as TEXT; nothing executed the hook's ORCHESTRATION: the drag/junction lifecycle, the
// pointerUp-only commit, the shape-change reset, the external-push re-seed, the reset
// handlers and the geometry/scroll sync. This is the gesture whose persisted output was
// once corrupted (WARDEN-1095: zero/negative ratios wiped the saved layout).
//
// HARNESS (same seam-first shape as useNowTicker.test.mjs / useWatchCatchup.test.mjs):
// the REAL hook and the REAL paneGrid.ts are transpiled with vite's transformWithOxc;
// `react` is rewritten onto a slot-based shim (useState/useRef/useEffect/useLayoutEffect),
// `@/lib/uiStore` onto a stub that records commits, and `@/lib/paneGrid` onto the
// transpiled sibling. Every rewrite is ASSERTED (the real react's hooks throw outside a
// renderer, so a missed rewrite would fail loudly anyway). getComputedStyle,
// ResizeObserver and document are fake globals.
//
// Run: node usePaneGridResize.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tmpDir = mkdtempSync(join(__dirname, '.use-pane-grid-resize-test-'));

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
  if (self.slots.length <= slot) self.slots.push({ value: typeof initial === 'function' ? initial() : initial });
  const cell = self.slots[slot];
  return [cell.value, (next) => {
    const v = typeof next === 'function' ? next(cell.value) : next;
    if (Object.is(v, cell.value)) return;
    cell.value = v;
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
export const useLayoutEffect = useEffect;
`,
);

// The uiStore stub reads a mutable module-level "store" the test file owns, via globalThis.
writeFileSync(
  join(tmpDir, 'uiStore-stub.mjs'),
  `
export const usePaneColRatios = () => globalThis.__paneStore.col;
export const usePaneRowRatios = () => globalThis.__paneStore.row;
export const useSetPaneColRatios = () => globalThis.__paneStore.setCol;
export const useSetPaneRowRatios = () => globalThis.__paneStore.setRow;
`,
);

const transpile = async (rel, outName, rewrites) => {
  const srcPath = resolve(__dirname, rel);
  const { code } = await transformWithOxc(readFileSync(srcPath, 'utf8'), srcPath, {});
  let out = code;
  for (const [from, to] of rewrites) {
    const before = out;
    out = out.replaceAll(`"${from}"`, `"${to}"`).replaceAll(`'${from}'`, `'${to}'`);
    assert.notEqual(out, before, `${from} specifier rewrite did not land in ${rel}`);
    assert.ok(!out.includes(`from "${from}"`) && !out.includes(`from '${from}'`), `${rel} still imports ${from}`);
  }
  writeFileSync(join(tmpDir, outName), out);
};

await transpile('src/lib/paneGrid.ts', 'paneGrid.mjs', []);
await transpile('src/lib/usePaneGridResize.ts', 'usePaneGridResize.mjs', [
  ['react', './react-shim.mjs'],
  ['@/lib/uiStore', './uiStore-stub.mjs'],
  ['@/lib/paneGrid', './paneGrid.mjs'],
]);

const { usePaneGridResize } = await import(join(tmpDir, 'usePaneGridResize.mjs'));
const { __aim: aimShim } = await import(join(tmpDir, 'react-shim.mjs'));
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};
const r9 = (arr) => arr.map((v) => Math.round(v * 1e9) / 1e9);

// --- Fake DOM globals ----------------------------------------------------------
const ROOT_FONT_PX = 16;
const docEl = {};
globalThis.document = { documentElement: docEl, body: { style: { userSelect: '' } } };
globalThis.getComputedStyle = (el) => (el === docEl ? { fontSize: `${ROOT_FONT_PX}px` } : el.cs);
const observers = [];
globalThis.ResizeObserver = class {
  constructor(cb) {
    this.cb = cb;
    this.observed = [];
    this.disconnected = false;
    observers.push(this);
  }
  observe(el) { this.observed.push(el); }
  disconnect() { this.disconnected = true; }
};

const makeGrid = (over = {}) => {
  const listeners = [];
  const removed = [];
  return {
    clientWidth: 600,
    clientHeight: 400,
    scrollLeft: 0,
    scrollTop: 0,
    // Resolved by the fake getComputedStyle: 2 equal-ish columns / 2 rows by default.
    cs: { columnGap: '20px', rowGap: '20px', gridTemplateColumns: '200px 400px', gridTemplateRows: '100px 100px' },
    listeners,
    removed,
    addEventListener(type, fn, opts) { listeners.push({ type, fn, opts }); },
    removeEventListener(type, fn) { removed.push({ type, fn }); },
    ...over,
  };
};

// --- Store stub ----------------------------------------------------------------
const makeStore = (over = {}) => {
  const s = {
    col: [],
    row: [],
    colCalls: [],
    rowCalls: [],
    ...over,
  };
  s.setCol = (v) => { s.colCalls.push(v.slice()); };
  s.setRow = (v) => { s.rowCalls.push(v.slice()); };
  return s;
};

// --- Driver --------------------------------------------------------------------
// Effects flush after the render; the previous run's cleanup fires first. A state
// update during the flush marks the instance dirty and re-renders (like React).
const mountHook = (args, { grid = false } = {}) => {
  const inst = {
    slots: [], pendingEffects: [], cursor: 0, renders: 0, state: null,
    flushing: false, dirty: false, args,
  };
  inst.render = () => {
    do {
      inst.dirty = false;
      aimShim(inst);
      inst.cursor = 0;
      inst.renders += 1;
      inst.state = usePaneGridResize(inst.args);
      const queued = inst.pendingEffects;
      inst.pendingEffects = [];
      inst.flushing = true;
      try {
        for (let i = 0; i < queued.length; i += 2) {
          const cell = queued[i];
          if (typeof cell.cleanup === 'function') cell.cleanup();
          cell.cleanup = queued[i + 1]() ?? null;
        }
      } finally {
        inst.flushing = false;
      }
    } while (inst.dirty);
    return inst.state;
  };
  inst.unmount = () => {
    for (const cell of inst.slots) {
      if (cell && typeof cell.cleanup === 'function') { cell.cleanup(); cell.cleanup = null; }
    }
  };
  inst.render();
  if (grid) {
    // React attaches the node during commit, BEFORE layout effects; PaneGrid then flips
    // gridMounted (n > 0). Mimic: attach the ref, flip the dep, re-render.
    inst.grid = grid === true ? makeGrid() : grid;
    inst.state.gridRef.current = inst.grid;
    inst.args = { ...inst.args, gridMounted: true };
    inst.render();
  }
  return inst;
};

const baseArgs = () => ({ cols: 2, rows: 2, gridMounted: false, effectiveMax: null, showGutters: true });
let store;
const setup = ({ storeOver, argsOver, grid = true } = {}) => {
  store = makeStore(storeOver);
  globalThis.__paneStore = store;
  document.body.style.userSelect = '';
  observers.length = 0;
  return mountHook({ ...baseArgs(), ...argsOver }, { grid });
};

// A pointer event stub; counts preventDefault/stopPropagation and capture calls.
const ptr = (clientX, clientY, over = {}) => {
  const e = {
    button: 0, clientX, clientY, pointerId: 7,
    prevented: 0, stopped: 0, captured: [], released: [],
    preventDefault() { e.prevented += 1; },
    stopPropagation() { e.stopped += 1; },
    currentTarget: {
      setPointerCapture(id) { e.captured.push(id); },
      releasePointerCapture(id) { e.released.push(id); },
    },
    ...over,
  };
  return e;
};

// --- Tests ---------------------------------------------------------------------
test('mount seeds equal ratios, and seeds from persisted ratios only when the length matches; mount commits nothing', () => {
  let d = setup({ storeOver: { col: [], row: [] } });
  assert.deepEqual(d.state.colRatios, [1, 1]);
  assert.deepEqual(d.state.rowRatios, [1, 1]);
  d = setup({ storeOver: { col: [2, 1], row: [3, 1] } });
  assert.deepEqual(d.state.colRatios, [2, 1]);
  assert.deepEqual(d.state.rowRatios, [3, 1]);
  assert.notEqual(d.state.colRatios, store.col, 'seeded from a copy, not the store array');
  assert.deepEqual(store.colCalls, [], 'mount commits no column ratios');
  assert.deepEqual(store.rowCalls, [], 'mount commits no row ratios');
  d = setup({ storeOver: { col: [2, 1, 1], row: [1] } });
  assert.deepEqual(d.state.colRatios, [1, 1], 'length mismatch falls back to equal');
  assert.deepEqual(d.state.rowRatios, [1, 1]);
  assert.deepEqual(store.colCalls, []);
  assert.deepEqual(store.rowCalls, []);
});

test('column drag: moves re-template LOCALLY, pointerUp commits ONCE with the LAST move, restores userSelect, releases capture; a second pointerUp commits nothing', () => {
  const d = setup();
  const down = ptr(100, 50);
  d.state.beginDrag('col', 0)(down);
  assert.equal(down.prevented, 1);
  assert.equal(down.stopped, 1);
  assert.deepEqual(down.captured, [7]);
  assert.equal(document.body.style.userSelect, 'none');
  assert.equal(d.state.dragging, 'col');

  d.state.onHandlePointerMove(ptr(130, 50));
  assert.deepEqual(r9(d.state.colRatios), r9([(2 * 230) / 600, 2 - (2 * 230) / 600]));
  d.state.onHandlePointerMove(ptr(160, 50));
  const expected = r9([(2 * 260) / 600, 2 - (2 * 260) / 600]);
  assert.deepEqual(r9(d.state.colRatios), expected, 'redistribution is absolute from the start geometry');
  assert.equal(d.state.colTpl, d.state.colRatios.map((r) => `minmax(9rem, ${r}fr)`).join(' '), 'template follows local ratios');
  assert.deepEqual(store.colCalls, [], 'no store write during moves');
  assert.deepEqual(store.rowCalls, []);

  const up = ptr(160, 50);
  d.state.onHandlePointerUp(up);
  assert.equal(store.colCalls.length, 1, 'exactly one commit');
  assert.deepEqual(r9(store.colCalls[0]), expected, 'commits the LAST move');
  assert.deepEqual(store.rowCalls, []);
  assert.equal(document.body.style.userSelect, '');
  assert.deepEqual(up.released, [7]);
  assert.equal(d.state.dragging, null);

  d.state.onHandlePointerUp(ptr(160, 50));
  assert.equal(store.colCalls.length, 1, 'second pointerUp commits nothing');
  // A move after the drag ended is inert.
  d.state.onHandlePointerMove(ptr(300, 50));
  assert.deepEqual(r9(d.state.colRatios), expected);
});

test('row drag reads clientY and commits to the row setter only; uses both measured pair heights', () => {
  const d = setup({ grid: makeGrid({ cs: { columnGap: '20px', rowGap: '20px', gridTemplateColumns: '200px 400px', gridTemplateRows: '200px 400px' } }) });
  d.state.beginDrag('row', 0)(ptr(9999, 100));
  d.state.onHandlePointerMove(ptr(-5000, 160)); // clientX is wild and must be ignored
  const expected = r9([(2 * 260) / 600, 2 - (2 * 260) / 600]);
  assert.deepEqual(r9(d.state.rowRatios), expected);
  assert.deepEqual(d.state.colRatios, [1, 1], 'columns untouched');
  d.state.onHandlePointerUp(ptr(0, 160));
  assert.equal(store.rowCalls.length, 1);
  assert.deepEqual(r9(store.rowCalls[0]), expected);
  assert.deepEqual(store.colCalls, [], 'a row drag never hits the column setter');
});

test('redistribution uses BOTH measured pair widths (unequal 200px/400px tracks)', () => {
  const d = setup();
  d.state.beginDrag('col', 0)(ptr(0, 0));
  d.state.onHandlePointerMove(ptr(60, 0));
  // newLeft = pairSum * (t0 + dx) / (t0 + t1) = 2 * 260 / 600
  assert.deepEqual(r9(d.state.colRatios), r9([0.866666666666, 2 - 0.866666666666]));
  d.state.onHandlePointerUp(ptr(60, 0));
});

test('floor clamp stops the shrinking track at 9rem (144px)', () => {
  const d = setup();
  d.state.beginDrag('col', 0)(ptr(500, 0));
  d.state.onHandlePointerMove(ptr(-5000, 0)); // huge leftward drag
  // left track bottoms out at 144px: ratio = 2 * 144 / 600
  assert.deepEqual(r9(d.state.colRatios), r9([(2 * 144) / 600, 2 - (2 * 144) / 600]));
  d.state.onHandlePointerMove(ptr(5000, 0)); // huge rightward drag: right track bottoms out at 144
  assert.deepEqual(r9(d.state.colRatios), r9([(2 * (600 - 144)) / 600, 2 - (2 * (600 - 144)) / 600]));
  d.state.onHandlePointerUp(ptr(5000, 0));
  assert.ok(store.colCalls[0].every((v) => v > 0), 'committed ratios are positive');
});

test('beginDrag refusals (maximized, non-primary, no grid, bad index, track/ratio mismatch) leave no drag, no preventDefault, no userSelect change', () => {
  const refuse = (label, d, begin, e) => {
    begin(e);
    assert.equal(e.prevented, 0, `${label}: no preventDefault`);
    assert.equal(e.stopped, 0, `${label}: no stopPropagation`);
    assert.deepEqual(e.captured, [], `${label}: no pointer capture`);
    assert.equal(document.body.style.userSelect, '', `${label}: userSelect untouched`);
    assert.equal(d.state.dragging, null, `${label}: not dragging`);
    const before = d.state.colRatios;
    d.state.onHandlePointerMove(ptr(500, 500));
    assert.equal(d.state.colRatios, before, `${label}: a following move changes nothing`);
    d.state.onHandlePointerUp(ptr(500, 500));
    assert.deepEqual(store.colCalls, [], `${label}: nothing committed`);
    assert.deepEqual(store.rowCalls, [], `${label}: nothing committed`);
  };

  let d = setup({ argsOver: { effectiveMax: 'pane-1' } });
  refuse('maximized', d, d.state.beginDrag('col', 0), ptr(100, 100));

  d = setup();
  refuse('non-primary button', d, d.state.beginDrag('col', 0), ptr(100, 100, { button: 2 }));

  d = setup({ grid: false });
  refuse('no grid', d, d.state.beginDrag('col', 0), ptr(100, 100));

  d = setup();
  refuse('gutter index past the last pair', d, d.state.beginDrag('col', 1), ptr(100, 100));
  refuse('negative gutter index', d, d.state.beginDrag('col', -1), ptr(100, 100));

  d = setup({ grid: makeGrid({ cs: { columnGap: '0px', rowGap: '0px', gridTemplateColumns: '100px 100px 100px', gridTemplateRows: '100px 100px' } }) });
  refuse('track count != ratio length', d, d.state.beginDrag('col', 0), ptr(100, 100));
});

test('crossing pad: sub-threshold jitter and a still click commit nothing and leave dragging null', () => {
  const d = setup();
  const down = ptr(100, 100);
  d.state.beginJunctionDrag(0, 0)(down);
  assert.equal(down.prevented, 1);
  assert.equal(down.stopped, 1);
  assert.deepEqual(down.captured, [7]);
  assert.equal(document.body.style.userSelect, 'none');
  assert.equal(d.state.dragging, null, 'axis not resolved yet');
  d.state.onHandlePointerMove(ptr(102, 101)); // below the 3px threshold
  assert.equal(d.state.dragging, null);
  assert.deepEqual(d.state.colRatios, [1, 1]);
  const up = ptr(102, 101);
  d.state.onHandlePointerUp(up);
  assert.deepEqual(store.colCalls, []);
  assert.deepEqual(store.rowCalls, []);
  assert.equal(document.body.style.userSelect, '');
  assert.deepEqual(up.released, [7]);

  // A plain click (no move at all) is equally inert.
  d.state.beginJunctionDrag(0, 0)(ptr(100, 100));
  d.state.onHandlePointerUp(ptr(100, 100));
  assert.deepEqual(store.colCalls, []);
  assert.deepEqual(store.rowCalls, []);
});

test('crossing pad: the first decisive horizontal move => column drag; vertical => row drag; threshold is exactly 3px', () => {
  let d = setup();
  d.state.beginJunctionDrag(0, 0)(ptr(100, 100));
  d.state.onHandlePointerMove(ptr(102, 100)); // 2px: still pending
  assert.equal(d.state.dragging, null);
  d.state.onHandlePointerMove(ptr(103, 100)); // 3px: decisive
  assert.equal(d.state.dragging, 'col');
  assert.deepEqual(r9(d.state.colRatios), r9([(2 * 203) / 600, 2 - (2 * 203) / 600]), 'start x is the pad pointer-down x');
  assert.deepEqual(d.state.rowRatios, [1, 1]);
  d.state.onHandlePointerUp(ptr(103, 100));
  assert.equal(store.colCalls.length, 1);
  assert.deepEqual(store.rowCalls, []);

  d = setup({ grid: makeGrid({ cs: { columnGap: '20px', rowGap: '20px', gridTemplateColumns: '200px 400px', gridTemplateRows: '300px 300px' } }) });
  d.state.beginJunctionDrag(0, 0)(ptr(100, 100));
  d.state.onHandlePointerMove(ptr(101, 120));
  assert.equal(d.state.dragging, 'row');
  // Rows measured 300px/300px, dy = 20 from the pad's start y (100 -> 120).
  assert.deepEqual(r9(d.state.rowRatios), r9([(2 * 320) / 600, 2 - (2 * 320) / 600]));
  assert.deepEqual(d.state.colRatios, [1, 1]);
  d.state.onHandlePointerUp(ptr(101, 120));
  assert.equal(store.rowCalls.length, 1);
  assert.deepEqual(store.colCalls, []);
});

test('crossing pad: the jitter-then-decisive sequence still resolves, and a refused pad (maximized / non-primary) never starts', () => {
  let d = setup();
  d.state.beginJunctionDrag(0, 0)(ptr(100, 100));
  d.state.onHandlePointerMove(ptr(101, 101));
  d.state.onHandlePointerMove(ptr(140, 101));
  assert.equal(d.state.dragging, 'col', 'pending survives sub-threshold jitter');
  d.state.onHandlePointerUp(ptr(140, 101));

  const refuse = (label, d2, e) => {
    d2.state.beginJunctionDrag(0, 0)(e);
    assert.equal(e.prevented, 0, `${label}: no preventDefault`);
    assert.deepEqual(e.captured, [], `${label}: no capture`);
    assert.equal(document.body.style.userSelect, '', `${label}: userSelect untouched`);
    d2.state.onHandlePointerMove(ptr(400, 400));
    assert.equal(d2.state.dragging, null, `${label}: a big move starts nothing`);
    d2.state.onHandlePointerUp(ptr(400, 400));
    assert.deepEqual(store.colCalls, []);
    assert.deepEqual(store.rowCalls, []);
  };
  d = setup({ argsOver: { effectiveMax: 'pane-1' } });
  refuse('maximized', d, ptr(100, 100));
  d = setup();
  refuse('non-primary', d, ptr(100, 100, { button: 1 }));
});

test('shape change resets ONLY the changed axis to equal and commits it; mount and unchanged shape do not', () => {
  const d = setup({ storeOver: { col: [2, 1], row: [3, 1] } });
  assert.deepEqual(store.colCalls, []);
  assert.deepEqual(store.rowCalls, []);

  d.args = { ...d.args }; // re-render, same shape
  d.render();
  assert.deepEqual(store.colCalls, [], 'unchanged shape commits nothing');
  assert.deepEqual(store.rowCalls, []);

  d.args = { ...d.args, cols: 3 };
  d.render();
  assert.deepEqual(d.state.colRatios, [1, 1, 1]);
  assert.deepEqual(store.colCalls, [[1, 1, 1]]);
  assert.deepEqual(store.rowCalls, [], 'rows untouched');
  assert.deepEqual(d.state.rowRatios, [3, 1], 'row ratios keep their persisted split');

  d.args = { ...d.args, rows: 3 };
  d.render();
  assert.deepEqual(d.state.rowRatios, [1, 1, 1]);
  assert.deepEqual(store.rowCalls, [[1, 1, 1]]);
  assert.deepEqual(store.colCalls, [[1, 1, 1]], 'columns not re-committed');
});

test('external store wipe re-seeds equal; the echo of our own commit leaves local state as is', () => {
  const d = setup({ storeOver: { col: [2, 1], row: [3, 1] } });
  assert.deepEqual(d.state.colRatios, [2, 1]);

  // Own commit via a drag, then the store echoes the committed value back.
  d.state.beginDrag('col', 0)(ptr(0, 0));
  d.state.onHandlePointerMove(ptr(60, 0));
  d.state.onHandlePointerUp(ptr(60, 0));
  const committed = store.colCalls[0];
  const local = d.state.colRatios;
  store.col = committed.slice();
  d.render();
  assert.equal(d.state.colRatios, local, 'echo does not re-seed (same array identity)');

  // External wipe (a global pref reset writes []).
  store.col = [];
  store.row = [];
  d.render();
  assert.deepEqual(d.state.colRatios, [1, 1], 'column re-seeded equal');
  assert.deepEqual(d.state.rowRatios, [1, 1], 'row re-seeded equal');
  assert.equal(store.colCalls.length, 1, 'an external re-seed commits nothing back');
  assert.deepEqual(store.rowCalls, []);

  // External push of a valid array re-seeds to it (length matches).
  store.row = [1, 3];
  d.render();
  assert.deepEqual(d.state.rowRatios, [1, 3]);
});

test('applyResetAxis / applyResetBothAxes commit equal splits', () => {
  const d = setup({ argsOver: { cols: 3, rows: 2 }, storeOver: { col: [1, 2, 1], row: [3, 1] } });
  d.state.applyResetAxis('col');
  assert.deepEqual(d.state.colRatios, [1, 1, 1]);
  assert.deepEqual(store.colCalls, [[1, 1, 1]]);
  assert.deepEqual(store.rowCalls, []);
  assert.deepEqual(d.state.rowRatios, [3, 1]);

  d.state.applyResetAxis('row');
  assert.deepEqual(d.state.rowRatios, [1, 1]);
  assert.deepEqual(store.rowCalls, [[1, 1]]);

  // Re-establish skewed local ratios, then reset both at once.
  store.col = [];
  store.row = [];
  d.render();
  store.colCalls.length = 0;
  store.rowCalls.length = 0;
  d.state.applyResetBothAxes();
  assert.deepEqual(d.state.colRatios, [1, 1, 1]);
  assert.deepEqual(d.state.rowRatios, [1, 1]);
  assert.deepEqual(store.colCalls, [[1, 1, 1]]);
  assert.deepEqual(store.rowCalls, [[1, 1]]);
});

test('resetAxis / resetBothAxes wrappers stop propagation and commit the reset', () => {
  const d = setup({ storeOver: { col: [2, 1], row: [3, 1] } });
  const e1 = { stopped: 0, stopPropagation() { this.stopped += 1; } };
  d.state.resetAxis('col')(e1);
  assert.equal(e1.stopped, 1);
  assert.deepEqual(store.colCalls, [[1, 1]]);
  assert.deepEqual(store.rowCalls, []);

  const e2 = { stopped: 0, stopPropagation() { this.stopped += 1; } };
  d.state.resetAxis('row')(e2);
  assert.equal(e2.stopped, 1);
  assert.deepEqual(store.rowCalls, [[1, 1]]);

  const e3 = { stopped: 0, stopPropagation() { this.stopped += 1; } };
  d.state.resetBothAxes(e3);
  assert.equal(e3.stopped, 1);
  assert.equal(store.colCalls.length, 2);
  assert.equal(store.rowCalls.length, 2);
});

test('maximized => single-track templates; non-maximized => per-track minmax(9rem, Nfr) columns / minmax(0, Nfr) rows', () => {
  let d = setup({ storeOver: { col: [2, 1], row: [1, 3] } });
  assert.equal(d.state.colTpl, 'minmax(9rem, 2fr) minmax(9rem, 1fr)');
  assert.equal(d.state.rowTpl, 'minmax(0, 1fr) minmax(0, 3fr)');
  d = setup({ storeOver: { col: [2, 1], row: [1, 3] }, argsOver: { effectiveMax: 'pane-1' } });
  assert.equal(d.state.colTpl, 'minmax(9rem, 1fr)');
  assert.equal(d.state.rowTpl, 'minmax(0, 1fr)');
});

test('mounting the grid measures it and derives gutter centers (col from width+gap, row from height+gap); showGutters=false yields none', () => {
  let d = setup();
  // cols: distributable = 600 - 20 = 580 -> 290 + 10 = 300; rows: 400 - 20 = 380 -> 190 + 10 = 200
  assert.deepEqual(d.state.colCenters, [300]);
  assert.deepEqual(d.state.rowCenters, [200]);
  assert.equal(observers.length, 1, 'one ResizeObserver');
  assert.deepEqual(observers[0].observed, [d.grid]);

  // Resize: the observer callback re-reads geometry.
  d.grid.clientWidth = 1000;
  d.grid.clientHeight = 220;
  observers[0].cb();
  assert.deepEqual(d.state.colCenters, [500]);
  assert.deepEqual(d.state.rowCenters, [110]);

  d = setup({ argsOver: { showGutters: false } });
  assert.deepEqual(d.state.colCenters, []);
  assert.deepEqual(d.state.rowCenters, []);

  // Not mounted (no grid yet): geometry unknown => no centers, no observer.
  d = setup({ grid: false });
  assert.deepEqual(d.state.colCenters, []);
  assert.equal(observers.length, 0);
});

test('overlay scroll sync: initial transform via setOverlayRef, then on every scroll event', () => {
  const d = setup();
  d.grid.scrollLeft = 30;
  d.grid.scrollTop = 5;
  const ov = { style: { transform: '' } };
  d.state.setOverlayRef(ov);
  assert.equal(ov.style.transform, 'translate(-30px, -5px)');

  const scroll = d.grid.listeners.find((l) => l.type === 'scroll');
  assert.ok(scroll, 'a scroll listener is attached to the grid');
  assert.equal(scroll.opts.passive, true);
  d.grid.scrollLeft = 80;
  d.grid.scrollTop = 0;
  scroll.fn();
  assert.equal(ov.style.transform, 'translate(-80px, 0px)');

  // Detaching the overlay (el=null) is inert; a missing grid is inert too.
  assert.doesNotThrow(() => d.state.setOverlayRef(null));
  const d2 = setup({ grid: false });
  const ov2 = { style: { transform: '' } };
  d2.state.setOverlayRef(ov2);
  assert.equal(ov2.style.transform, '', 'no grid => no transform written');
});

test('unmount disconnects the observer and removes the very scroll listener it added; toggling gridMounted off cleans up too', () => {
  let d = setup();
  const added = d.grid.listeners[0];
  d.unmount();
  assert.equal(observers[0].disconnected, true);
  assert.equal(d.grid.removed.length, 1);
  assert.equal(d.grid.removed[0].type, 'scroll');
  assert.equal(d.grid.removed[0].fn, added.fn);

  d = setup();
  d.state.gridRef.current = null; // React clears the ref when the node unmounts
  d.args = { ...d.args, gridMounted: false };
  d.render();
  assert.equal(observers[0].disconnected, true);
  assert.equal(d.grid.removed.length, 1);
  assert.equal(observers.length, 1, 'no new observer is attached without a grid');

  // Re-mounting the grid re-attaches (the 0 -> positive transition).
  d.grid = makeGrid();
  d.state.gridRef.current = d.grid;
  d.args = { ...d.args, gridMounted: true };
  d.render();
  assert.equal(observers.length, 2);
  assert.equal(d.grid.listeners.length, 1);
});

console.log(`\n${passed} passed`);
