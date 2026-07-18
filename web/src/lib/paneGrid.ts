// Pure derivation of which grid tiles are visible, given the (possibly stale)
// maximized pane id and the workspace's open tiles. Extracted from PaneGrid so
// the stale-maximized contract is unit-testable against the real function.
//
// Maximize is a single piece of UI state holding the maximized pane's id. The
// grid renders `visible` — normally every open tile, but just the maximized one
// when something is maximized. The hazard: when the maximized pane is closed,
// killed, or dragged into another workspace, App removes it from the open-tile
// list but (pre-WARDEN-521) did NOT clear the maximized id. The id then pointed
// at a tile no longer in the grid, `tiles.filter(t => t.id === maximized)`
// produced an empty array, and the whole grid went blank until a workspace
// switch reset the id. App now clears the id at every removal site, but this
// guard makes the grid robust to any path that leaves a stale id behind: a
// maximized id whose tile is gone behaves as "not maximized", so the grid can
// never blank — it falls back to the normal multi-tile view.
//
// Returns the effective maximized id (null when the stored id is stale or there
// is nothing maximized) and the tiles to render. PaneGrid also uses effectiveMax
// to decide the grid template (1×1 while a real pane is maximized, else the
// reflowed cols×rows) and the per-tile "maximized" flag, so a stale id can never
// pin the grid to a single column either.

export function resolveVisibleTiles<T extends { id: string }>(
  maximized: string | null,
  tiles: T[],
): { effectiveMax: string | null; visible: T[] } {
  const effectiveMax =
    maximized && tiles.some((t) => t.id === maximized) ? maximized : null;
  const visible = effectiveMax ? tiles.filter((t) => t.id === effectiveMax) : tiles;
  return { effectiveMax, visible };
}

// --- Draggable resize gutters (WARDEN-660) -----------------------------------
//
// The grid lays out its panes in a CSS grid whose column/row track COUNT comes
// from gridShape() and whose track SIZES come from a per-axis ratio array
// (unitless `fr` weights: gridTemplateColumns = `${ratio}fr`). Equal split =
// all 1s (today's uniform grid, bit-for-bit). Dragging an internal gutter
// redistributes the combined weight of its two adjacent tracks between them;
// double-clicking a gutter resets that axis to equal.
//
// Floors are enforced by clamping the drag (redistributeRatios), NOT by CSS
// minmax on every track — the column template still carries a `minmax(9rem,…)`
// safety net matching the pre-resize floor, but rows use `minmax(0,…)` so the
// grid reflows at any height (the row floor is a drag limit, not a layout
// limit). This keeps the floor a property of the *gesture* (you can't drag a
// pane below it) while the *layout* stays fluid.

// Column floor in rem — matches the historic `minmax(9rem, 1fr)` minimum a pane
// could never be crushed below (PaneGrid.tsx pre-WARDEN-660). The drag clamps
// at this many rem × the root font size.
export const PANE_COL_FLOOR_REM = 9;
// Row floor in rem — "a few terminal lines". Rows have no pre-resize CSS floor
// (they were `minmax(0, 1fr)`), so this floor exists only as a drag limit: you
// can't drag a row shorter than roughly this before the gutter clamps.
export const PANE_ROW_FLOOR_REM = 6;

export type PaneLayoutShape = 'auto' | 'stacked' | 'side-by-side';

// Resolve the grid's column/row COUNT for a pane count + layout mode. 'auto'
// reproduces the historic square-ish grid (cols = ceil(sqrt(n))); 'stacked'
// forces a single column; 'side-by-side' forces a single row. Extracted from
// PaneGrid (where it was inline `colsFor` + an if/else) so the resize-gutter
// shape logic — reset-on-shape-change, "which gutters exist" — is unit-testable
// against the real function. n === 0 yields cols ≥ 1 / rows 0 (PaneGrid renders
// its empty-state message instead of the grid, so the template is unused then).
export function gridShape(layout: PaneLayoutShape, n: number): { cols: number; rows: number } {
  if (layout === 'stacked') return { cols: 1, rows: n };
  if (layout === 'side-by-side') return { cols: n, rows: n > 0 ? 1 : 0 };
  const cols = n <= 1 ? 1 : Math.ceil(Math.sqrt(n));
  return { cols, rows: n > 0 ? Math.ceil(n / cols) : 0 };
}

// A fresh equal-split ratio array for `count` tracks (all 1s). count <= 0 → []
// (no tracks). The default before any drag, and the reset target when the grid
// shape changes (stale ratios from a 4-pane grid must not distort a 2-pane one).
export function equalRatios(count: number): number[] {
  return count > 0 ? new Array(count).fill(1) : [];
}

// The ratios actually applied to the grid: the persisted array when its length
// matches the current track count, otherwise a fresh equal split. A length
// mismatch happens after a shape change (persisted ratios for a different
// shape) or before any drag — both fall through to equal. Pure: no DOM/React.
export function effectiveRatios(persisted: number[], count: number): number[] {
  return count > 0 && persisted.length === count ? persisted.slice() : equalRatios(count);
}

// Redistribute one gutter's drag between its two adjacent tracks. Given the
// current ratios, the LEFT track index `g` of the pair, the pair's measured
// pixel widths at drag start (t0, t1), the pointer delta `dx` in px (positive
// enlarges the left track), and the minimum track width `floorPx`: returns a
// NEW ratio array with the pair's combined weight (ratios[g] + ratios[g+1])
// reallocated — left track grows by dx, right shrinks by dx — CLAMPED so
// neither track falls below floorPx. Non-adjacent tracks are untouched.
// Returns null when the inputs are unusable (caller treats null as "no change"),
// so a measurement glitch or a stale-shape mismatch can never produce NaN/neg.
export function redistributeRatios(
  ratios: number[],
  g: number,
  t0: number,
  t1: number,
  dx: number,
  floorPx: number,
): number[] | null {
  if (!Array.isArray(ratios) || g < 0 || g >= ratios.length - 1) return null;
  if (!(t0 > 0) || !(t1 > 0)) return null; // need real, positive measured widths
  const pairSum = ratios[g] + ratios[g + 1];
  if (!(pairSum > 0)) return null;
  // Clamp dx so each track stays >= its floor: left can't shrink below floor
  // (minDx), right can't shrink below floor either (maxDx). A drag always
  // starts from a valid layout (both tracks >= floor), so minDx <= 0 <= maxDx
  // initially and the clamp is well-ordered.
  const minDx = floorPx - t0; // left track hits its floor
  const maxDx = t1 - floorPx; // right track hits its floor
  const clamped = Math.max(minDx, Math.min(maxDx, dx));
  const newLeft = (pairSum * (t0 + clamped)) / (t0 + t1);
  const next = ratios.slice();
  next[g] = newLeft;
  next[g + 1] = pairSum - newLeft;
  return next;
}

// Resolve each track's pixel width on one axis under a CSS
// `minmax(floorPx, r fr)` distribution: each track's fr-share of the
// distributable space, clamped to floorPx, with the deficit redistributed
// proportionally among the still-unclamped tracks — iterated to a fixed point
// so a redistribution that pushes another track below floorPx re-clamps it.
// This mirrors how CSS Grid resolves `minmax(floor, Xfr)` track sizes, so the
// predicted track widths (and thus the predicted gutter centers) track the
// RENDERED layout even when the floor binds: a narrow window after a drag, or
// more columns than the width can fit (side-by-side overflow). With floorPx = 0
// it reduces bit-for-bit to a pure `fr` distribution, which is why the ROW axis
// (template `minmax(0, …)`, no floor) was already exact and stays a pure-fr call.
//
// Pure: no DOM/React — unit-testable against the browser's resolved layout.
// `distributable` is the axis size already minus the (n-1) gaps; the caller
// (gutterCenters) owns the gap subtraction so this helper stays about tracks.
export function resolveTrackWidths(
  ratios: number[],
  distributable: number,
  floorPx: number,
): number[] {
  const n = ratios.length;
  if (n === 0) return [];
  const total = ratios.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return new Array(n).fill(0);
  // fr-share of the distributable space for each track (the pure-fr layout).
  let widths = ratios.map((r) => (r / total) * distributable);
  if (!(floorPx > 0)) return widths; // no floor → pure fr (rows)
  // Iteratively pin sub-floor tracks at floorPx and redistribute the deficit.
  // Each pass pins at least one more track (or breaks), so at most n passes
  // converge to the CSS minmax fixed point. `clamped` is sticky: once a track
  // is pinned at its floor it is never deficit-redistributed away from it.
  const clamped = new Array<boolean>(n).fill(false);
  for (let pass = 0; pass < n; pass++) {
    let pinned = false;
    for (let i = 0; i < n; i++) {
      if (!clamped[i] && widths[i] < floorPx) {
        clamped[i] = true;
        pinned = true;
      }
    }
    if (!pinned) break; // no track below floor → fixed point reached
    const pinnedCount = clamped.filter(Boolean).length;
    const remaining = distributable - pinnedCount * floorPx;
    const freeTotal = ratios.reduce((a, r, i) => a + (clamped[i] ? 0 : r), 0);
    if (freeTotal <= 0) {
      // Every track is pinned (or has zero ratio) → all at floor; the grid
      // overflows its container (more tracks than the width fits), which
      // PaneGrid handles via overflow-x-auto. Centers still place the handles
      // over the rendered gutters (equally spaced at floorPx + gap).
      widths = clamped.map((c) => (c ? floorPx : 0));
      break;
    }
    widths = ratios.map((r, i) => (clamped[i] ? floorPx : (r / freeTotal) * remaining));
  }
  return widths;
}

// Pixel centers (relative to the grid's content box) of each internal gutter on
// one axis, given that axis's ratio array, the grid's content size on that axis,
// the gap between tracks, and (optionally) the per-track floor in px. Used to
// position the overlay drag handles over the visual gutters without a per-
// pointermove layout query. gutter i sits between track i and i+1; its center =
// (sum of track[0..i] widths) + (i + 0.5) * gap.
//
// `floorPx` models the column template's `minmax(9rem, …)` floor so predicted
// centers track the RENDERED gutters even when the floor binds (a track pinned
// at 9rem by a narrow window, or by side-by-side overflow) — without it the
// handle overlays drift off the visual gutters and become ungrabbable right
// after a window resize. Pass 0 (the default) for an axis with no CSS floor:
// rows use `minmax(0, …)`, the pure-fr math is exact there, and the default is
// correct. PaneGrid passes the column floor for colCenters and omits it for
// rowCenters.
//
// Returns [] when there are fewer than 2 tracks (no internal gutters) or the
// size is unknown (first paint) — PaneGrid renders no handles in that case.
export function gutterCenters(ratios: number[], size: number, gap: number, floorPx = 0): number[] {
  const n = ratios.length;
  if (n <= 1 || !(size > 0)) return [];
  const total = ratios.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return [];
  const distributable = Math.max(0, size - (n - 1) * gap);
  const widths = resolveTrackWidths(ratios, distributable, floorPx);
  const out: number[] = [];
  let cumTrack = 0; // running sum of track[0..i] widths
  for (let i = 0; i < n - 1; i++) {
    cumTrack += widths[i];
    out.push(cumTrack + (i + 0.5) * gap);
  }
  return out;
}
