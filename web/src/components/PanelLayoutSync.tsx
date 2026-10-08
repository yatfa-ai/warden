import { useEffect } from 'react';
import { useRecordOnExpand } from '@/lib/useRecordOnExpand';
import { useSidebarCollapsed, useObserverCollapsed, useHealthCollapsed, useReclampPanelWidths } from '@/lib/uiStore';

// WARDEN-1645 (client-state slice 42): the panel-collapse side effects, extracted
// from App.tsx so a collapse toggle re-renders only this null-rendering component,
// not all of App. It must stay continuously mounted (App renders it OUTSIDE the
// settings ternary): the header/<main> unmount while Settings is open, and
// useRecordOnExpand seeds its previous-value ref from the MOUNT value, so living
// here keeps expand ticks exact across a Settings round-trip; the resize listener
// and the space-shape re-clamp also keep running while Settings is open.
export function PanelLayoutSync() {
  const sidebarCollapsed = useSidebarCollapsed();
  const observerCollapsed = useObserverCollapsed();
  const healthCollapsed = useHealthCollapsed();
  const reclampPanelWidths = useReclampPanelWidths();

  // WARDEN-1494: count panel expands on the state edge so every path (button,
  // Alt+S/Alt+O, openActivityTab) records exactly once. (The health button ticks
  // 'panel-expand-health' itself, in PanelToggleButtons — deliberately not here.)
  useRecordOnExpand(sidebarCollapsed, 'panel-expand-sidebar');
  useRecordOnExpand(observerCollapsed, 'panel-expand-observer');

  // The single re-clamp entry point for every change in AVAILABLE/VISIBLE LAYOUT
  // SPACE (WARDEN-183). The clamp itself is a store action (reclampPanelWidths)
  // that reads the widths and collapse flags from the store; the three flags are
  // deliberate effect triggers (deps) so it re-fires on each toggle.
  const applyLayoutClamp = () => reclampPanelWidths(window.innerWidth);

  // (1) Window resize: a smaller viewport shrinks the space the two panels share.
  useEffect(() => {
    window.addEventListener('resize', applyLayoutClamp);
    return () => window.removeEventListener('resize', applyLayoutClamp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reclampPanelWidths]);

  // (2) Space-shape changes: the health toggle AND the sidebar/observer collapse
  // toggles all change how much shared width the VISIBLE panels may occupy.
  // Health expanding reserves HEALTH_WIDTH (−320px). Expanding a side panel
  // re-introduces a width that may have been dragged wide while the OTHER panel
  // was collapsed — the drag clamp treats a collapsed neighbor as width 0
  // (ResizableRail captures the neighbour as `otherCollapsed ? 0 : other` at
  // mousedown), so a wide drag there stores a value that only fits when that
  // neighbor is hidden. Without re-clamping on the expand, both visible panels
  // keep their full stored widths and the middle pane column is crushed (to ~0 at
  // the 900px floor). Collapsing only frees space (a no-op clamp); the EXPAND
  // direction is the one that needs this. Also fires once on mount.
  // REQUIRED for the middle-pane invariant: removing it re-introduces the
  // WARDEN-183 crush (see layout.test.mjs, "expand re-clamp").
  useEffect(() => {
    reclampPanelWidths(window.innerWidth);
  }, [reclampPanelWidths, healthCollapsed, sidebarCollapsed, observerCollapsed]);

  return null;
}
