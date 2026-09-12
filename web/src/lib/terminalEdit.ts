// Terminal-surface EDIT decisions (WARDEN-1356): what Edit ▸ Select All and
// Edit ▸ Cut mean on the agent-pane (xterm) surface, and where each command
// routes in the renderer.
//
// WHY THIS EXISTS. The Edit menu's stock roles execute flawlessly against the
// focused webContents and still do nothing on a terminal pane: xterm registers
// clipboard listeners for copy and paste ONLY (0 `cut`, 0 `selectall` in the
// installed dist), and the helper textarea it keeps focused is EMPTY — so the
// browser-native select-all and cut act on an empty element and produce
// nothing. The roles are not broken (they are exactly why Settings fields
// work); the pane is simply a surface the roles cannot see. WARDEN-1356 makes
// both items lead somewhere real on that surface:
//
//   - Cut keeps `role: 'cut'` in the template. `webContents.cut()` DOES reach
//     the renderer as a native DOM `cut` event at the focused element (verified
//     live: target 'xterm-helper-textarea'), so the pane can claim it in the
//     capture phase — the WARDEN-1338 paste shape — and perform the one honest
//     reading of "cut" on a read-only terminal: COPY the selection to the
//     clipboard, then CLEAR the selection. A pane's scrollback cannot be
//     excised (there is no deleting the past out of a terminal buffer), so
//     copy-then-clear is what the item can truthfully do there; an event at a
//     Settings input is never claimed, so fields keep the native cut
//     byte-for-byte.
//
//   - Select All CANNOT be intercepted: `webContents.selectAll()` fires no DOM
//     event at all (verified live: zero events at the pane while a real <input>
//     in the same run emitted selectionchange/selectstart). The renderer is
//     structurally blind to the role path, so the template item is a WIRED
//     click instead (main pushes 'menu:select-all' — the WARDEN-1280 bridge
//     shape), and the renderer routes by REAL DOM focus:
//
//       terminal → the focused pane's xterm textarea is the active element;
//                  the pane itself confirms identity (`activeElement ===
//                  term.textarea`) and calls term.selectAll();
//       editable → an ordinary field (Settings input) has focus;
//                  document.execCommand('selectAll') reproduces the role's
//                  native behaviour there;
//       none     → nothing editable has focus; a no-op, same as the role's
//                  select-nothing today.
//
// The DOM-focus checks — not App's "focused pane" state — are what protect
// Settings: App's focusedChat can still point at a pane while a Settings
// search field actually holds keyboard focus, and the role this replaces acted
// on real focus too. Pure and structural on purpose: Node tests exercise both
// decisions with plain structurally-typed arguments (no DOM), the same
// contract as shouldRouteNativePasteToTerminal in lib/pasteImage.ts.

/** CustomEvent name the App-level select-all handler broadcasts to the panes. */
export const TERMINAL_SELECT_ALL_EVENT = 'warden:menu-select-all';

/** What the renderer should do with the menu's Select All push. */
export type MenuSelectAllRoute = 'terminal' | 'editable' | 'none';

/**
 * The members of document.activeElement the routing decision reads. Structural
 * so tests can pass plain objects; every field is optional because a host can
 * hand us less than a full HTMLElement.
 */
export interface ActiveElementLike {
  tagName?: string;
  isContentEditable?: boolean;
  classList?: { contains?: (name: string) => boolean };
}

/** The one structural tell that keyboard focus is inside an xterm pane. */
function isTerminalTextarea(el: ActiveElementLike | null | undefined): boolean {
  try {
    return !!el?.classList?.contains?.('xterm-helper-textarea');
  } catch {
    return false;
  }
}

/** The structural tells of an ordinary editable field (input/textarea/contenteditable). */
function isEditableField(el: ActiveElementLike | null | undefined): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  return tag === 'INPUT' || tag === 'TEXTAREA';
}

/**
 * Decide where the menu's Select All push should land, from REAL DOM focus.
 *
 * Order is load-bearing: the terminal check runs FIRST, because xterm's helper
 * textarea is itself a <textarea> — an editable-field check would claim the
 * pane too and route a pane-focused Select All into execCommand (which acts on
 * the empty helper textarea and changes nothing — today's defect, resurrected).
 */
export function routeMenuSelectAll(activeElement: ActiveElementLike | null | undefined): MenuSelectAllRoute {
  if (isTerminalTextarea(activeElement)) return 'terminal';
  if (isEditableField(activeElement)) return 'editable';
  return 'none';
}

/**
 * Decide whether a native DOM `cut` event should be claimed by THIS pane and
 * performed as copy-then-clear-selection.
 *
 * The two claim conditions are both load-bearing, mirroring
 * shouldRouteNativePasteToTerminal:
 *
 *   - `target` must be THIS pane's xterm helper textarea — the precise "this
 *     terminal has keyboard focus" test (a cut event always targets the
 *     focused element). A cut aimed at a Settings input is NEVER claimed; the
 *     Edit roles must keep cutting natively everywhere outside the terminal.
 *
 *   - the pane must HAVE a selection. Cut with nothing selected is a no-op on
 *     every surface; letting the event fall through keeps that honestly empty
 *     instead of manufacturing a clipboard write from a non-selection.
 *
 * Pure and structural on purpose: it is the unit-tested guard for the PaneTile
 * capture wiring, and Node tests can exercise it with plain structurally-typed
 * arguments (no DOM).
 */
export function shouldRouteNativeCutToTerminal(
  target: unknown,
  termTextarea: unknown,
  hasSelection: boolean,
): boolean {
  if (target !== termTextarea) return false;
  return !!hasSelection;
}
