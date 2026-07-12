// Single source of truth for the HTML5 drag-and-drop protocol shared between
// the write side (PaneTile, `setData`) and the read side (WorkspaceTabs,
// `getData`/`types.includes`). The two MUST be the same string: if they drift,
// the drop target's gate silently no-ops and panes stop moving with no error
// (the WARDEN-57/108 class of internally-consistent UI masking a broken round-
// trip). So both sites import it from here — never redefine it. WARDEN-256.
//
// Payload convention (WARDEN-108): the drag payload is always a stable pane id
// (or workspace id), never a filtered array index.
export const PANE_DRAG_MIME = 'application/x-warden-pane';
