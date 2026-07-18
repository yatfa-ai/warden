// --- Resizable layout width clamps (WARDEN-183) ----------------------------
// Usable floors + caps for the two user-resizable panels, the reserved middle-
// pane column floor, and the fixed health-panel width. The drag handler, the
// window-resize listener, AND the persisted-width load all route through the
// clamp helpers below so a single source of truth governs every path: no panel
// can be crushed below a usable size, and two wide panels can never starve the
// middle pane column. These are layout *bounds* (tracked in px against mouse /
// viewport math), not inline visual styles — so WARDEN-68 Rule 2 (no magic-
// number inline px) does not apply to them; visual min-widths on inputs/tiles
// use Tailwind scale classes instead.
export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 400;
export const OBSERVER_MIN = 300;
export const OBSERVER_MAX = 600;
// Middle pane column floor — the anti-crush reserve. The clamps subtract it
// (plus the health panel when expanded) from the viewport so the sidebar and
// observer together can never leave the middle pane below this width.
export const PANE_MIN = 320;
export const HEALTH_WIDTH = 320;

export interface LayoutContext {
  windowWidth: number;
  healthCollapsed: boolean;
  // Collapse state for the shared re-clamp (clampLayoutWidths). A collapsed
  // panel is hidden — its flex column is width 0 — so it reserves NO shared
  // space and is never trimmed; only the *visible* panel(s) are clamped against
  // the space they actually occupy. The drag clamps already pass the OTHER panel
  // as 0 when it is collapsed (`dragOtherWidth = otherCollapsed ? 0 : other`),
  // so a panel can be dragged wide while its neighbor is hidden, storing a width
  // that only fits alone. The shared clamp must match that collapse-awareness so
  // a lone visible panel is never trimmed to reserve room for a hidden one, and
  // so the re-clamp that fires on the hidden panel's EXPAND trims the pair back
  // to fit (WARDEN-183 round 3). Optional: absent = visible (backward-compatible
  // with the load/drag callers that don't track collapse).
  sidebarCollapsed?: boolean;
  observerCollapsed?: boolean;
}

const clampN = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

// Viewport space the two resizable panels may share: viewport minus the middle-
// pane floor and the health panel (when expanded).
function sharedWidth(ctx: LayoutContext): number {
  return ctx.windowWidth - PANE_MIN - (ctx.healthCollapsed ? 0 : HEALTH_WIDTH);
}

// Clamp the sidebar width to [SIDEBAR_MIN, SIDEBAR_MAX], further capped so it
// can't crowd the middle pane below PANE_MIN given the observer's live width.
// Used by the sidebar drag handler — only the dragged panel is in motion, so
// the other panel's width is passed in (0 when collapsed).
export function clampSidebarWidth(requested: number, observerWidth: number, ctx: LayoutContext): number {
  const cap = Math.min(SIDEBAR_MAX, sharedWidth(ctx) - observerWidth);
  return clampN(requested, SIDEBAR_MIN, Math.max(SIDEBAR_MIN, cap));
}

// Symmetric clamp for the observer panel.
export function clampObserverWidth(requested: number, sidebarWidth: number, ctx: LayoutContext): number {
  const cap = Math.min(OBSERVER_MAX, sharedWidth(ctx) - sidebarWidth);
  return clampN(requested, OBSERVER_MIN, Math.max(OBSERVER_MIN, cap));
}

// Re-clamp BOTH panels together — for persisted-width load, window-resize, and
// any change in AVAILABLE/VISIBLE LAYOUT SPACE (health toggle, sidebar/observer
// collapse toggles), where neither panel is the active drag. A collapsed panel
// reserves no shared space and is never trimmed: widening one rail while the
// other is collapsed can store a width that only fits alone (the drag clamp
// treats a collapsed neighbor as 0), so the re-clamp that fires on the other
// rail's EXPAND is what trims the pair back to fit. Without it the middle pane
// column is crushed (WARDEN-183 round 3). If a stale pair or a shrunken viewport
// would together starve the middle (visible widths sum > shared space), each
// VISIBLE panel is trimmed toward its floor until they fit. The trim is
// deliberately ASYMMETRIC: the sidebar yields toward its floor first, and only
// once it can give no more does the observer give way — so a tighter layout
// shrinks the narrower, less-critical rail before the chat pane. Deterministic,
// not a sign of a bug; don't "fix" it toward symmetry without intent. At the
// 900px window floor there is always room for both minimums (180 + 300 + 320 =
// 800), so neither visible panel falls below its usable floor in practice.
export function clampLayoutWidths(
  requested: { sidebar: number; observer: number },
  ctx: LayoutContext,
): { sidebar: number; observer: number } {
  const sidebarVisible = !ctx.sidebarCollapsed;
  const observerVisible = !ctx.observerCollapsed;
  // Clamp each stored width into its own usable band regardless of visibility
  // (so a value stored while hidden is still in band when later expanded).
  let sidebar = clampN(requested.sidebar, SIDEBAR_MIN, SIDEBAR_MAX);
  let observer = clampN(requested.observer, OBSERVER_MIN, OBSERVER_MAX);
  // Only visible panels consume shared space; a hidden panel reserves none.
  const overshoot =
    (sidebarVisible ? sidebar : 0) + (observerVisible ? observer : 0) - sharedWidth(ctx);
  if (overshoot > 0) {
    // Trim visible panels toward their floors — sidebar yields first.
    if (sidebarVisible) {
      const sidebarTrim = Math.min(overshoot, Math.max(0, sidebar - SIDEBAR_MIN));
      sidebar -= sidebarTrim;
      const remaining = overshoot - sidebarTrim;
      if (remaining > 0 && observerVisible) {
        observer -= Math.min(remaining, Math.max(0, observer - OBSERVER_MIN));
      }
    } else if (observerVisible) {
      observer -= Math.min(overshoot, Math.max(0, observer - OBSERVER_MIN));
    }
  }
  return { sidebar, observer };
}
