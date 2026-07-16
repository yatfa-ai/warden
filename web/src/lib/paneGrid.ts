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
