// Pure descriptor for FileViewer's header toolbar (WARDEN-1019).
//
// WHY THIS EXISTS: below ~768px the header row cannot fit its toolbar. Every
// control is `shrink-0`, so the toolbar's min-content width is a hard floor the
// row cannot go under; the buttons paint straight through `DialogTitle`'s `pr-8`
// close-X reserve and out past the panel's right edge. Measured on `main` with a
// markdown file open (six controls, the worst case): at 375px the `Changes`
// button starts at the panel's exact right edge and every hit-test point on it
// lands on the overlay or the close X — aiming at Changes CLOSES the viewer and
// loses the reader's place. WARDEN-1006 fixed the same destructive mis-hit at
// desktop widths and scoped the narrow-viewport residual to this ticket.
//
// The fix is toolbar responsiveness: below `md` the low-priority controls
// collapse into an overflow menu, so only `Changes` and the close X stay
// directly on the row. `flex-wrap` was tried first on WARDEN-1006 and backed
// out — it wraps the toolbar to two rows at 1280px, trading a desktop
// regression for the mobile fix.
//
// WHAT LIVES HERE vs IN THE COMPONENT: this module owns the part a unit test can
// actually see — WHICH controls collapse, in WHAT order, and WHAT state each one
// reports — because this repo has no front-end DOM test runner (see
// breadcrumbs.test.mjs / fileViewerChanges.ts), so a geometry regression is
// invisible to `npm test` and only the pure contract can be pinned. Icons and
// click handlers stay in FileViewer.tsx, keyed by `key`.
//
// This module is `import`-free at runtime (pure logic, no value imports) so
// Vite's OXC transform emits clean ESM JS and the transpile-to-temp-`.mjs` test
// harness loads the REAL module rather than a re-implementation.

/** Stable identity of one collapsible toolbar control. */
export type ToolbarActionKey = 'viewmode' | 'history' | 'annotate' | 'reload' | 'follow';

/** The FileViewer view-state the toolbar labels/pressed-states are derived from. */
export interface ToolbarActionState {
  /** Markdown files get a sixth control (the Rendered/Source toggle). */
  isMarkdown: boolean;
  viewMode: 'rendered' | 'source';
  history: boolean;
  annotate: boolean;
  follow: boolean;
  /** A manual ↻ reload is in flight — the button is busy, not "pressed". */
  manualReloading: boolean;
}

export interface ToolbarAction {
  key: ToolbarActionKey;
  /** Visible text on the row, and the accessible name of the icon-only ↻. */
  label: string;
  /** Tooltip — the same string the inline button has carried since WARDEN-749/786. */
  title: string;
  /**
   * `aria-pressed` for a TOGGLE, or null for a plain action (↻ reload). Carried
   * on the descriptor rather than re-derived per presentation so the overflow
   * menu shows the same on/off state the inline button does: these are toggles,
   * and a menu that hid their state would make the collapse lossy.
   */
  pressed: boolean | null;
  /** In-flight (↻ only) — rendered as a spinner and disabled. */
  busy: boolean;
}

/**
 * The controls that collapse into the overflow menu, in header DOM order.
 *
 * `Changes` is deliberately absent: it is the control the destructive mis-hit
 * was reported against, so it stays directly on the row at every viewport
 * alongside the close X. Everything else is lower-priority and may collapse.
 */
export function secondaryToolbarActions(s: ToolbarActionState): ToolbarAction[] {
  const rendered = s.viewMode === 'rendered';
  return [
    ...(s.isMarkdown
      ? [{
          key: 'viewmode' as const,
          label: rendered ? 'Rendered' : 'Source',
          title: rendered ? 'Show raw markdown source' : 'Show rendered documentation',
          pressed: rendered,
          busy: false,
        }]
      : []),
    {
      key: 'history',
      label: 'History',
      title: s.history
        ? 'Hide file commit history'
        : 'Show commit history for this file (every commit that touched it, across renames)',
      pressed: s.history,
      busy: false,
    },
    {
      key: 'annotate',
      label: 'Annotate',
      title: s.annotate
        ? 'Hide per-line git blame'
        : 'Show per-line git blame (which commit last touched each line)',
      pressed: s.annotate,
      busy: false,
    },
    {
      key: 'reload',
      label: 'Reload file',
      title: 'Reload file',
      pressed: null, // a one-shot action, not a toggle
      busy: s.manualReloading,
    },
    {
      key: 'follow',
      label: 'Follow',
      title: s.follow
        ? 'Stop following — pause live updates'
        : 'Follow — live-update this file as it changes (tail -f)',
      pressed: s.follow,
      busy: false,
    },
  ];
}

/**
 * Where each collapsible control sits relative to the always-inline `Changes`
 * button when the row is wide enough to show them all (>= `md`).
 *
 * Two groups rather than one because splitting at `Changes` is what keeps the
 * DESKTOP row byte-identical to what shipped: the header has always read
 * [markdown toggle] History Annotate | Changes | ↻ Follow, and rendering the
 * collapsible set as a single run would silently reorder ↻ and Follow in front
 * of Changes at 1280px — a visible desktop change for a narrow-viewport fix.
 *
 * Their concatenation must equal `secondaryToolbarActions`' order exactly; a new
 * action added to neither group would vanish from the desktop row while still
 * appearing in the overflow menu. fileViewerToolbar.test.mjs pins that.
 */
export const TOOLBAR_LEADING_KEYS: readonly ToolbarActionKey[] = ['viewmode', 'history', 'annotate'];
export const TOOLBAR_TRAILING_KEYS: readonly ToolbarActionKey[] = ['reload', 'follow'];
