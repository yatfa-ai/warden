import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePaneColRatios, usePaneRowRatios, useSetPaneColRatios, useSetPaneRowRatios } from '@/lib/uiStore';
import {
  equalRatios,
  effectiveRatios,
  redistributeRatios,
  resolveJunctionAxis,
  gutterCenters,
  PANE_COL_FLOOR_REM,
  PANE_ROW_FLOOR_REM,
} from '@/lib/paneGrid';

// WARDEN-660: one drag session fields both axes (only one gutter is dragged at
// a time). Held in a ref so the shared pointermove/up handlers — attached once
// per handle — read live geometry without re-binding. `last` stashes the most
// recent ratio array so pointerUp commits the exact final value (React state
// may not have flushed by the time pointerUp fires synchronously after the last
// move).
export type DragAxis = 'col' | 'row';
interface DragSession {
  axis: DragAxis;
  g: number;           // LEFT track index of the resized pair
  startClient: number; // clientX (col) / clientY (row) at pointer down
  t0: number;          // measured px width of the left track at drag start
  t1: number;          // measured px width of the right track at drag start
  floorPx: number;     // minimum track width in px (floor rem × root font size)
  last: number[];      // most recent ratio array produced during the drag
}

// WARDEN-660: a crossing-pad grab BEFORE its axis is resolved. A pad sits at a
// col-gutter × row-gutter intersection where BOTH axes are valid, so it can't
// commit to one at pointer down — it stashes both pair indices + the start x/y
// and lets the shared move handler pick the axis from the pointer's initial
// direction (|dx|>=|dy| → columns, else rows) before seeding a DragSession.
interface PendingJunction {
  gCol: number;     // col-gutter index (left track of the resized col pair)
  gRow: number;     // row-gutter index (top track of the resized row pair)
  startX: number;   // clientX at pointer down
  startY: number;   // clientY at pointer down
}

// WARDEN-660: the invisible gutter hit area is wider than the visual gap so it's
// easy to grab (it straddles the two adjacent panes); the 1px visible line sits
// centered inside it. A constant — not a Tailwind class — because it sizes a
// style.left/style.width offset (WARDEN-68 Rule 2 covers magic px in *visual*
// classes, not hit-area geometry derived from a measured gutter center).
export const HANDLE_W_PX = 10;
export const HANDLE_HALF_PX = HANDLE_W_PX / 2;

// WARDEN-660: a crossing pad waits for the pointer to travel at least this far
// before committing to an axis, so a hair-trigger jitter (or a still click)
// doesn't mis-route a junction grab. Small enough to feel instant, large enough
// to rise above sub-pixel noise — and it's what lets a plain click land cleanly
// so the pad's onDoubleClick can fire unmolested.
const JUNCTION_THRESH_PX = 3;

export interface PaneGridResizeArgs {
  cols: number;
  rows: number;
  gridMounted: boolean;
  effectiveMax: string | null;
  showGutters: boolean;
}

// WARDEN-2002: the WARDEN-660 resize-gutter engine, moved out of PaneGrid verbatim.
export function usePaneGridResize({ cols, rows, gridMounted, effectiveMax, showGutters }: PaneGridResizeArgs) {
  // WARDEN-1433 (roadmap WARDEN-1204 slice 14): the draggable resize-gutter
  // ratios (WARDEN-660) come from the same store on the same terms — the pair
  // of persisted values AND the pair of commit callbacks, each keeping the
  // exact local name the Props destructure used, so the ephemeral drag working
  // copies (colRatios/rowRatios below), the pointerUp commit sites, the
  // template/equalize/reset-reorder paths, and the external-push effect all
  // read the same identifiers with the same change-identity semantics. The
  // setters are zustand actions (stable identities — the same property the
  // WARDEN-16 handler convention asked of the React setters they replace), and
  // the persisted write follows via App's snapshot into the ONE saveUi effect.
  const paneColRatios = usePaneColRatios();
  const paneRowRatios = usePaneRowRatios();
  const onPaneColRatiosChange = useSetPaneColRatios();
  const onPaneRowRatiosChange = useSetPaneRowRatios();
  // WARDEN-660: working ratio arrays for the grid's column / row tracks. LOCAL
  // state so a drag re-templates the grid at 60fps without a localStorage write
  // per pointermove (the persisted pref on the shared uiStore is committed on
  // pointerUp only). Seeded from the persisted store value when its length
  // matches the current shape, else equal split. Always length === cols / rows
  // while the shape is stable (the reset effect restores that invariant on any
  // shape change).
  const [colRatios, setColRatios] = useState<number[]>(() => effectiveRatios(paneColRatios, cols));
  const [rowRatios, setRowRatios] = useState<number[]>(() => effectiveRatios(paneRowRatios, rows));

  // The last ratios PaneGrid committed to the store. Lets the sync effect tell
  // a SELF-commit (the store value echoes what we just sent → local already
  // matches, so skip — avoids a redundant render on every drag commit) from an
  // EXTERNAL change (a global pref reset wipes the store value to [] → re-seed
  // local).
  const pushedRef = useRef<{ col: number[]; row: number[] }>({
    col: paneColRatios.slice(),
    row: paneRowRatios.slice(),
  });
  // The shape we last reset ratios for. A cols/rows COUNT change (pane
  // add/remove/close, layout-mode switch) resets that axis to equal for the new
  // shape and commits the reset, so stale ratios can't distort the new shape or
  // resurrect on reload. Seeded to the initial shape so the effect skips mount.
  const shapeRef = useRef({ cols, rows });

  // The active drag session (null when idle), plus a state flag (`dragging`)
  // that toggles the grid's `transition-all` OFF during a drag so the dragged
  // edge tracks the pointer 1:1 instead of lagging behind the transition.
  const dragRef = useRef<DragSession | null>(null);
  // WARDEN-660: a crossing-pad grab whose axis hasn't been resolved yet (null
  // unless a junction pad is actively pressed but the pointer hasn't moved
  // decisively). Kept in a ref — not state — because the shared move/up handlers
  // read it live without re-binding, exactly like dragRef.
  const pendingRef = useRef<PendingJunction | null>(null);
  const [dragging, setDragging] = useState<DragAxis | null>(null);
  // The grid container — measured (content box + resolved gap) via a
  // ResizeObserver to position the overlay drag handles over the visual gutters
  // without a per-pointermove layout query.
  const gridRef = useRef<HTMLDivElement>(null);
  // The gutter overlay — translated by the grid's scroll offset (see the scroll
  // listener in the layout effect) so handles stay aligned over their gutters
  // when the grid scrolls horizontally (side-by-side + many panes overflow).
  const overlayRef = useRef<HTMLDivElement>(null);
  const [gridGeom, setGridGeom] = useState({ w: 0, h: 0, colGap: 0, rowGap: 0, rootFontPx: 16 });

  // WARDEN-660 sync: when the persisted store value changes OUT from under us
  // (an external push by ANY other store writer — in practice a global reset —
  // e.g. resetUiPrefsPreservingWorkspace wipes it to []), re-seed local. A
  // store value equal to what we last committed is our own write echoing back —
  // local already matches, so skip (avoids a redundant render on every drag
  // commit). Skips mount (pushedRef seeded to the store value).
  useEffect(() => {
    const same = (a: number[], b: number[]) =>
      a.length === b.length && a.every((v, i) => v === b[i]);
    if (!same(paneColRatios, pushedRef.current.col)) {
      pushedRef.current.col = paneColRatios.slice();
      setColRatios(effectiveRatios(paneColRatios, cols));
    }
    if (!same(paneRowRatios, pushedRef.current.row)) {
      pushedRef.current.row = paneRowRatios.slice();
      setRowRatios(effectiveRatios(paneRowRatios, rows));
    }
  }, [paneColRatios, paneRowRatios, cols, rows]);

  // WARDEN-660 reset-on-shape-change: when the non-maximized cols/rows COUNT
  // changes (pane added/removed/closed, layout-mode switch), reset that axis to
  // equal for the new shape and commit the reset, so stale ratios can't distort
  // the new shape or resurrect on reload. Skips mount (shapeRef seeded to the
  // initial shape) and skips maximize (cols/rows are the non-maximized shape).
  useEffect(() => {
    if (shapeRef.current.cols !== cols) {
      shapeRef.current.cols = cols;
      const eq = equalRatios(cols);
      pushedRef.current.col = eq;
      setColRatios(eq);
      onPaneColRatiosChange(eq);
    }
    if (shapeRef.current.rows !== rows) {
      shapeRef.current.rows = rows;
      const eq = equalRatios(rows);
      pushedRef.current.row = eq;
      setRowRatios(eq);
      onPaneRowRatiosChange(eq);
    }
  }, [cols, rows, onPaneColRatiosChange, onPaneRowRatiosChange]);

  // WARDEN-660: measure the grid's content box + resolved gap once (and on
  // resize) to position the overlay drag handles. The handle positions are then
  // derived in render from the live ratios + this geometry (gutterCenters), so a
  // 60fps drag recomputes positions in the same render that updates the template
  // — no per-pointermove layout query, no second render. useLayoutEffect reads
  // before paint so handles aren't misplaced on the first frame. Also syncs the
  // overlay to the grid's scroll offset so handles track their gutters when the
  // grid scrolls horizontally (overflow-x-auto: side-by-side + many panes) —
  // direct DOM transform, no re-render per scroll frame.
  //
  // Dep is `[gridMounted]` (i.e. `n > 0`), NOT `[]`: PaneGrid is ALWAYS mounted
  // (its keydown handler needs it), but the grid div is conditionally rendered —
  // only when there are panes (n > 0) does the `n === 0 ? empty-state : <grid div>`
  // branch below actually mount the node `gridRef` points at. If PaneGrid mounts
  // with 0 open panes (first run, or empty state — exactly where the "click a chat
  // to open a live pane" affordance invites a click), gridRef.current is null
  // here, the guard below bails, and the ResizeObserver never attaches; with `[]`
  // deps the effect would never re-run, so the click-to-open path that opens panes
  // AFTER mount would leave gridGeom at {0,0} → gutterCenters returns [] → no
  // overlay → the feature is invisible until a reload happens to restore panes on
  // mount. `[gridMounted]` re-runs the effect (reattaching the observer + reading
  // geometry) exactly on the 0→positive transition when the grid appears, and
  // cleans up on the positive→0 transition when it disappears. It does NOT re-run
  // for n: 1→2→3→4 — the already-attached ResizeObserver handles that reflow.
  useLayoutEffect(() => {
    const gridEl = gridRef.current;
    if (!gridEl) return;
    const read = () => {
      const cs = getComputedStyle(gridEl);
      // Root font size drives the column floor in px (9rem × rootFontPx) so the
      // handle overlays can model the `minmax(9rem, …)` distribution. Read here
      // (once + on resize) rather than per-render: ctrl+plus zoom and any
      // root-font change resize the grid, so the ResizeObserver refreshes it.
      const rootFontPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setGridGeom({
        w: gridEl.clientWidth,
        h: gridEl.clientHeight,
        colGap: parseFloat(cs.columnGap) || 0,
        rowGap: parseFloat(cs.rowGap) || 0,
        rootFontPx,
      });
    };
    const syncScroll = () => {
      const ov = overlayRef.current;
      if (ov) ov.style.transform = `translate(${-gridEl.scrollLeft}px, ${-gridEl.scrollTop}px)`;
    };
    read();
    syncScroll();
    const ro = new ResizeObserver(read);
    ro.observe(gridEl);
    gridEl.addEventListener('scroll', syncScroll, { passive: true });
    return () => {
      ro.disconnect();
      gridEl.removeEventListener('scroll', syncScroll);
    };
    // re-run when the grid div mounts/unmounts (0→positive transition) — see note above
  }, [gridMounted]);

  // WARDEN-660 drag handlers. startAxisDrag measures the grabbed pair's pixel
  // widths + the floor in px (so the px→ratio redistribution is exact regardless
  // of CSS minmax floors, with no per-move layout query) and stashes a
  // DragSession. It's shared by the single-axis gutter strips (beginDrag — axis
  // known at pointer down) AND the crossing pads (beginJunctionDrag — axis
  // resolved from the first decisive move). move/up are attached to every handle
  // and read the live session from dragRef. The redistribution is ABSOLUTE —
  // each move recomputes the pair's ratios from the fixed start geometry + the
  // current dx — so a stale closure (multiple pointermoves before a re-render)
  // still produces the correct result (pairSum is conserved, non-pair tracks are
  // invariant during the drag). Only the primary button starts a drag;
  // double-click is a separate gesture whose intervening pointerdown/up moves
  // ~0px and commits the unchanged ratios, so the reset wins.
  const floorPxFor = (axis: DragAxis): number => {
    const rem = axis === 'col' ? PANE_COL_FLOOR_REM : PANE_ROW_FLOOR_REM;
    const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    return rem * rootPx;
  };

  // Seed dragRef for a known axis/pair. Returns false (so the caller skips, no
  // preventDefault) when the shape is mid-transition or the index is out of
  // range — the same guards the inline version had. Split out so a crossing pad
  // can call it AFTER resolving its axis from the pointer's initial direction.
  const startAxisDrag = (axis: DragAxis, g: number, startClient: number): boolean => {
    const gridEl = gridRef.current;
    if (!gridEl) return false;
    const cs = getComputedStyle(gridEl);
    const tracks = (axis === 'col' ? cs.gridTemplateColumns : cs.gridTemplateRows)
      .split(/\s+/).filter(Boolean).map(parseFloat);
    if (g < 0 || g >= tracks.length - 1) return false;
    const ratios = axis === 'col' ? colRatios : rowRatios;
    if (ratios.length !== tracks.length) return false; // shape mid-transition — bail
    dragRef.current = {
      axis, g, startClient,
      t0: tracks[g], t1: tracks[g + 1],
      floorPx: floorPxFor(axis),
      last: ratios.slice(),
    };
    return true;
  };

  const beginDrag = (axis: DragAxis, g: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (effectiveMax) return; // no gutters while maximized (none render anyway)
    if (e.button !== 0) return; // primary button only
    const startClient = axis === 'col' ? e.clientX : e.clientY;
    if (!startAxisDrag(axis, g, startClient)) return;
    e.preventDefault();
    e.stopPropagation();
    setDragging(axis);
    // Suppress text selection globally for the drag so an accidental selection
    // doesn't fight the pointermove. Cleared on pointerUp.
    document.body.style.userSelect = 'none';
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* best-effort */ }
  };

  // WARDEN-660 crossing pad: at every col-gutter × row-gutter intersection both
  // axes are valid, so the pad can't commit to one at pointer down. It stashes a
  // PendingJunction (both pair indices + the pointer's start x/y) and lets the
  // shared move handler resolve the axis from the first decisive movement before
  // startAxisDrag runs. This is the fix for the 2×2 dead-center grab: previously
  // the row strip (rendered above the col strip) universally captured the
  // crossing, so a horizontal drag there — which the row strip ignores — was a
  // silent no-op at the most natural grab point. The pad sits ON TOP of both
  // strips at the crossing (it's rendered last), so neither strip can pre-empt
  // it; away from crossings the strips are the only thing under the pointer and
  // keep their direct single-axis behavior. `dragging` is intentionally NOT set
  // here — no ratios change until the axis resolves, so the transition can stay
  // on through the pending phase; the move handler sets it (batched with the
  // first ratio change) the instant the axis is picked.
  const beginJunctionDrag = (gCol: number, gRow: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (effectiveMax) return; // no gutters while maximized (none render anyway)
    if (e.button !== 0) return; // primary button only
    e.preventDefault();
    e.stopPropagation();
    pendingRef.current = { gCol, gRow, startX: e.clientX, startY: e.clientY };
    document.body.style.userSelect = 'none';
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* best-effort */ }
  };

  const onHandlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    // Resolve a pending junction grab on the first decisive move: pick the axis
    // the pointer is mostly traveling along, seed its DragSession, then fall
    // through to apply this move like any single-axis drag. Until the move is
    // decisive (sub-threshold jitter, or a plain click) nothing happens — which
    // is what lets a double-click on a pad fire onDoubleClick unmolested.
    const p = pendingRef.current;
    if (p) {
      const pdx = e.clientX - p.startX;
      const pdy = e.clientY - p.startY;
      const axis = resolveJunctionAxis(pdx, pdy, JUNCTION_THRESH_PX);
      if (!axis) return; // sub-threshold jitter / a still click — no drag yet
      const g = axis === 'col' ? p.gCol : p.gRow;
      const startClient = axis === 'col' ? p.startX : p.startY;
      pendingRef.current = null;
      if (!startAxisDrag(axis, g, startClient)) return; // shape mid-transition — bail
      setDragging(axis);
    }
    const d = dragRef.current;
    if (!d) return;
    const cur = d.axis === 'col' ? e.clientX : e.clientY;
    const dx = cur - d.startClient;
    const ratios = d.axis === 'col' ? colRatios : rowRatios;
    const next = redistributeRatios(ratios, d.g, d.t0, d.t1, dx, d.floorPx);
    if (!next) return;
    if (d.axis === 'col') setColRatios(next);
    else setRowRatios(next);
    d.last = next; // stash exact final array for pointerUp to commit
  };

  const onHandlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    // A pending junction that never resolved (plain click, or sub-threshold
    // jitter) commits nothing — only a resolved session does.
    const wasPending = pendingRef.current !== null;
    pendingRef.current = null;
    const d = dragRef.current;
    dragRef.current = null;
    setDragging(null);
    document.body.style.userSelect = '';
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* best-effort */ }
    if (wasPending || !d) return;
    // Commit the final ratios to the store (App's snapshot carries them into
    // the one saveUi effect) — ONE write per drag, not one per pointermove (the
    // per-move updates were local-only).
    if (d.axis === 'col') {
      pushedRef.current.col = d.last.slice();
      onPaneColRatiosChange(d.last);
    } else {
      pushedRef.current.row = d.last.slice();
      onPaneRowRatiosChange(d.last);
    }
  };

  // Double-click a gutter → reset that whole axis (cols or rows) to equal split.
  // WARDEN-1770: the reset logic is split from the event wrapper so the gutter
  // context menu's onSelect (no event) and the double-click handler (which keeps
  // its stopPropagation) share ONE path that commits + persists the ratios.
  const applyResetAxis = (axis: DragAxis) => {
    if (axis === 'col') {
      const eq = equalRatios(cols);
      pushedRef.current.col = eq;
      setColRatios(eq);
      onPaneColRatiosChange(eq);
    } else {
      const eq = equalRatios(rows);
      pushedRef.current.row = eq;
      setRowRatios(eq);
      onPaneRowRatiosChange(eq);
    }
  };
  const resetAxis = (axis: DragAxis) => (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    applyResetAxis(axis);
  };

  // Double-click a crossing pad → reset BOTH axes to equal. A pad sits on both a
  // col and a row gutter, so committing to a single axis would be arbitrary;
  // resetting both matches "reset what you can see diverging" and stays the
  // symmetric counterpart to the single-axis strips (a col strip resets cols, a
  // row strip resets rows). Same pushedRef + commit pattern as resetAxis so the
  // reset survives the sync effect and reload.
  const applyResetBothAxes = () => {
    const eqCol = equalRatios(cols);
    const eqRow = equalRatios(rows);
    pushedRef.current.col = eqCol;
    pushedRef.current.row = eqRow;
    setColRatios(eqCol);
    setRowRatios(eqRow);
    onPaneColRatiosChange(eqCol);
    onPaneRowRatiosChange(eqRow);
  };
  const resetBothAxes = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    applyResetBothAxes();
  };

  // WARDEN-660: ref callback for the gutter overlay. On mount it stashes the
  // node AND applies the grid's current scroll offset, so handles line up with
  // their gutters immediately when the overlay (re)mounts (e.g. un-maximize
  // while horizontally scrolled) rather than waiting for the next scroll event.
  // Ongoing scroll is handled by the scroll listener in the layout effect above.
  const setOverlayRef = (el: HTMLDivElement | null) => {
    overlayRef.current = el;
    const gridEl = gridRef.current;
    if (el && gridEl) {
      el.style.transform = `translate(${-gridEl.scrollLeft}px, ${-gridEl.scrollTop}px)`;
    }
  };

  // WARDEN-660: per-track templates driven by the ratio arrays. Columns keep the
  // historic `minmax(9rem,…)` floor as a CSS safety net (a window narrower than
  // the floors overflows horizontally via overflow-x-auto rather than crushing
  // panes); rows keep `minmax(0,…)` so the grid reflows at any height (the row
  // floor is a drag limit, enforced in beginDrag, not a layout limit). Equal
  // ratios (all 1) reduce these to today's exact `repeat(n, minmax(…,1fr))`.
  // Maximize collapses to a single track and shows no gutters.
  const colTpl = effectiveMax
    ? 'minmax(9rem, 1fr)'
    : colRatios.map((r) => `minmax(9rem, ${r}fr)`).join(' ');
  const rowTpl = effectiveMax
    ? 'minmax(0, 1fr)'
    : rowRatios.map((r) => `minmax(0, ${r}fr)`).join(' ');
  // Internal-gutter center positions (px from the grid's content-box left/top),
  // derived from the live ratios + the measured geometry. Empty while maximized
  // or when fewer than 2 tracks exist on an axis (no internal gutters). The
  // column call passes the 9rem floor in px so the centers model the template's
  // `minmax(9rem, …)` distribution and track the RENDERED gutters even when the
  // floor binds (a narrow window after a drag, or side-by-side overflow) —
  // without it the handles drift off the visual gutters and go ungrabbable. The
  // row call omits the floor: rows are `minmax(0, …)` (no CSS floor), so the
  // pure-fr math is exact there (gutterCenters' default floorPx = 0).
  const colFloorPx = PANE_COL_FLOOR_REM * gridGeom.rootFontPx;
  const colCenters = showGutters ? gutterCenters(colRatios, gridGeom.w, gridGeom.colGap, colFloorPx) : [];
  const rowCenters = showGutters ? gutterCenters(rowRatios, gridGeom.h, gridGeom.rowGap) : [];

  return {
    colTpl, rowTpl, colCenters, rowCenters, dragging, gridRef, setOverlayRef,
    beginDrag, beginJunctionDrag, onHandlePointerMove, onHandlePointerUp,
    resetAxis, resetBothAxes, applyResetAxis, applyResetBothAxes,
    colRatios, rowRatios,
  };
}
