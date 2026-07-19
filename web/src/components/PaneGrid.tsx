import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PaneTile } from './PaneTile';
import { FileViewer } from './FileViewer';
import { WorkspaceSearchDialog } from './WorkspaceSearchDialog';
import { FileBrowserDialog } from './FileBrowserDialog';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import type { Chat } from '@/lib/types';
import type { PaneLayout, TerminalCursorStyle, OnExitBehavior, Snippet } from '@/lib/storage';
import {
  resolveVisibleTiles,
  gridShape,
  equalRatios,
  effectiveRatios,
  redistributeRatios,
  resolveJunctionAxis,
  gutterCenters,
  PANE_COL_FLOOR_REM,
  PANE_ROW_FLOOR_REM,
} from '@/lib/paneGrid';
import { resolveActingChat } from '@/lib/actingChat';
import type { ThemeId } from '@/lib/theme';
import type { TimestampFormat } from '@/lib/formatTimestamp';

export interface OpenTile { id: string }

// WARDEN-660: one drag session fields both axes (only one gutter is dragged at
// a time). Held in a ref so the shared pointermove/up handlers — attached once
// per handle — read live geometry without re-binding. `last` stashes the most
// recent ratio array so pointerUp commits the exact final value (React state
// may not have flushed by the time pointerUp fires synchronously after the last
// move).
type DragAxis = 'col' | 'row';
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
const HANDLE_W_PX = 10;
const HANDLE_HALF_PX = HANDLE_W_PX / 2;

// WARDEN-660: a crossing pad waits for the pointer to travel at least this far
// before committing to an axis, so a hair-trigger jitter (or a still click)
// doesn't mis-route a junction grab. Small enough to feel instant, large enough
// to rise above sub-pixel noise — and it's what lets a plain click land cleanly
// so the pad's onDoubleClick can fire unmolested.
const JUNCTION_THRESH_PX = 3;

interface Props {
  tiles: OpenTile[];
  focused: string | null;
  maximized: string | null;
  newActivity: Set<string>;
  chats: Chat[];
  paneHost: Record<string, string>;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onToggleMax: (id: string) => void;
  onClearNew: (id: string) => void;
  onForceKill: (id: string) => void;
  // ＋ split (WARDEN-223 → WARDEN-543): spawn a host shell pane derived from a
  // source pane (same host + cwd). WARDEN-543 moved this off the grid-toolbar
  // ＋split button onto each pane's own context menu, so the split acts on the
  // right-clicked pane, not the focused one. App owns the spawn; PaneGrid binds
  // this per-pane (onSplitShell?.(t.id)) when handing it to each PaneTile.
  onSplitShell?: (id?: string) => void;
  onSpawned: (chat: Chat) => void;
  externalSearchQuery?: { paneId: string; query: string } | null;
  onToggleSidebar?: () => void;
  onToggleObserver?: () => void;
  fontSize: number;
  onFontSizeChange: (n: number) => void;
  scrollback: number;
  // Global, persisted terminal font family (UiState). Pure pass-through to
  // PaneTile — App owns the value (and the empty → default fallback).
  fontFamily: string;
  paneLayout: PaneLayout;
  // WARDEN-660: draggable resize-gutter ratios. Per-axis track weights for the
  // grid's columns / rows ([] or all-equal = today's uniform grid). App owns the
  // persisted pref; PaneGrid holds a LOCAL working copy (see colRatios/rowRatios
  // below) so a drag re-templates the grid at 60fps without a localStorage write
  // per pointermove, then commits the final array up through the setters on
  // pointerUp. The setters are stable React setters passed straight through from
  // App (no inline arrow) per the App→PaneGrid handler convention (WARDEN-16).
  paneColRatios: number[];
  paneRowRatios: number[];
  onPaneColRatiosChange: (ratios: number[]) => void;
  onPaneRowRatiosChange: (ratios: number[]) => void;
  // Resolved terminal theme id (App resolves terminalColorScheme + the active
  // theme down to a concrete named-theme id here). Pure pass-through to PaneTile
  // — App owns the resolution so an OS theme flip can re-theme open panes live
  // without PaneGrid knowing about the scheme pref.
  terminalThemeId: ThemeId;
  // Terminal cursor shape × blink (blink/steady × block/underline/bar). Pure
  // pass-through to PaneTile; App owns the state so a Settings change live-
  // updates every open pane.
  terminalCursorStyle: TerminalCursorStyle;
  // "Copy on select" (WARDEN-285): when ON, completing a selection in a pane
  // copies it to the clipboard immediately. Pure pass-through to PaneTile —
  // App owns the persisted pref; PaneTile registers the xterm selection event
  // and reads the latest value from a ref, so a toggle applies LIVE to already-
  // open panes (better than the scrollback posture).
  copyOnSelect: boolean;
  // "Pane on agent exit" behavior (keep | dim | auto-close). Pure pass-through to
  // PaneTile — App owns the persisted pref; PaneTile reacts to its own chat's
  // live→exited transition. See WARDEN-248.
  onExitBehavior: OnExitBehavior;
  // Show the host tag in each pane header (WARDEN-290). Pure pass-through to
  // PaneTile — App owns the persisted showHostTags pref (displaySettings) so a
  // Settings toggle live-updates already-open pane headers, mirroring the
  // sidebar's live update.
  showHostTags?: boolean;
  // Saved instruction snippets (WARDEN-323): pure pass-through to PaneTile —
  // App owns the persisted list. PaneTile renders a "Snippets" submenu in each
  // pane's context menu for one-click send to that pane's agent.
  snippets: Snippet[];
  // "Timestamp format" pref (WARDEN-422): pure pass-through to PaneTile and to
  // this grid's own FileViewer — App owns the persisted pref; the FileViewer's
  // blame view formats author-dates per the pref, mirroring every other surface.
  timestampFormat: TimestampFormat;
  // File Viewer markdown view mode (WARDEN-480): pure pass-through to PaneTile
  // and to this grid's own FileViewer — App owns the persisted pref (one global
  // remembered choice) so toggling Rendered⇄Source once sticks across opens.
  fileViewerViewMode: 'rendered' | 'source';
  onFileViewerViewModeChange: (mode: 'rendered' | 'source') => void;
  // Follow poll cadence (WARDEN-749): pure pass-through to PaneTile and to this
  // grid's own FileViewer — App owns the resolved value (the same one the catalog
  // poll uses), so Follow shares the dashboard cadence instead of hardcoding one.
  pollIntervalMs: number;
}

export function PaneGrid({ tiles, focused, maximized, newActivity, chats, paneHost, onFocus, onClose, onToggleMax, onClearNew, onForceKill, onSplitShell, onSpawned, externalSearchQuery, onToggleSidebar, onToggleObserver, fontSize, onFontSizeChange, scrollback, fontFamily, paneLayout, paneColRatios, paneRowRatios, onPaneColRatiosChange, onPaneRowRatiosChange, terminalThemeId, terminalCursorStyle, copyOnSelect, onExitBehavior, showHostTags, snippets, timestampFormat, fileViewerViewMode, onFileViewerViewModeChange, pollIntervalMs }: Props) {
  const [fileOpen, setFileOpen] = useState(false);
  const [filePath, setFilePath] = useState('');
  // WARDEN-334: the 1-based line a grep result selected, fed to FileViewer's
  // existing `line` prop (WARDEN-227) so the viewer scrolls to + highlights that
  // row. `undefined` (manual path-entry open) ⇒ the viewer opens at the top
  // (its line-jump effect early-returns on typeof line !== 'number').
  const [fileLine, setFileLine] = useState<number | undefined>(undefined);
  const [fileInput, setFileInput] = useState('');
  const [fileInputError, setFileInputError] = useState('');
  const [filePromptOpen, setFilePromptOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  // WARDEN-563: the pane whose context menu last opened a workspace dialog
  // (search / file / browse). The dialogs resolve `actingChat` from this — NOT
  // `focusedChat` — so right-clicking a NON-focused pane searches/opens/browses
  // in THAT pane's repo. Seeded by openSearchFor / openFilePromptFor /
  // openBrowseFor (bound per-tile), mirroring how onSplitShell threads a pane
  // id. Stays set after a dialog closes (harmless: the next menu action re-seeds
  // it); resolves to focusedChat when unset, and falls back to focusedChat if
  // the acting pane's chat has since vanished (keeps an open dialog mounted
  // rather than blanking it).
  const [actingPaneId, setActingPaneId] = useState<string | null>(null);
  // WARDEN-573: read-only directory browser (📂) — the structural twin of the
  // grep dialog (WARDEN-145). Opened from a pane's context menu (openBrowseFor),
  // not the retired grid toolbar.
  const [browseOpen, setBrowseOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const nameOf = (id: string) => chats.find((c) => (c.key || c.id) === id)?.name || id;

  // WARDEN-660: non-maximized grid shape (column/row COUNT). Computed up here so
  // the ratio-state initializers below can seed against the matching shape.
  // Maximize is a transient 1×1 overlay (the template gates on effectiveMax
  // below) and does NOT change this shape — so toggling maximize never resets the
  // ratios (acceptance: "ratios intact after restore"). n===0 renders the empty-
  // state message instead of the grid, so the shape is unused then.
  const { cols, rows } = gridShape(paneLayout, tiles.length);

  // WARDEN-660: working ratio arrays for the grid's column / row tracks. LOCAL
  // state so a drag re-templates the grid at 60fps without a localStorage write
  // per pointermove (the App-owned persisted pref is committed on pointerUp
  // only). Seeded from the persisted prop when its length matches the current
  // shape, else equal split. Always length === cols / rows while the shape is
  // stable (the reset effect restores that invariant on any shape change).
  const [colRatios, setColRatios] = useState<number[]>(() => effectiveRatios(paneColRatios, cols));
  const [rowRatios, setRowRatios] = useState<number[]>(() => effectiveRatios(paneRowRatios, rows));

  // The last ratios PaneGrid pushed up to App. Lets the sync effect tell a
  // SELF-commit (the prop echoes what we just sent → local already matches, so
  // skip — avoids a redundant render on every drag commit) from an EXTERNAL
  // change (a global pref reset wipes the prop to [] → re-seed local).
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

  const focusedChat = focused ? chats.find((c) => (c.key || c.id) === focused) : null;

  // WARDEN-563: the chat the workspace dialogs (search / file-prompt /
  // FileViewer) act on — the right-clicked pane's chat, not the focused one.
  // Pure resolution lives in resolveActingChat (src/lib) so it's unit-tested.
  const actingChat = resolveActingChat(actingPaneId, focusedChat, chats);

  const handleOpenFile = () => {
    if (!actingChat) return;

    const trimmedInput = fileInput.trim();
    if (!trimmedInput) {
      setFileInputError('Please enter a file path');
      return;
    }

    // Check for obvious path traversal attempts
    if (trimmedInput.includes('..') || trimmedInput.includes('~')) {
      setFileInputError('Path traversal not allowed');
      return;
    }

    // Clear error and open the file
    setFileInputError('');
    setFilePath(trimmedInput);
    setFileLine(undefined); // manual path-entry has no line → open at top (WARDEN-334)
    setFileOpen(true);
    setFilePromptOpen(false); // Close the path-entry Dialog
    setFileInput(''); // Clear file input to prevent both dialogs from showing
  };

  // WARDEN-563: per-pane "open file from directory" trigger — seeds the acting
  // pane (so the path-entry dialog + FileViewer resolve THIS pane's cwd, not the
  // focused pane's), prefills the input with the pane's cwd, and opens the
  // path-entry Dialog. Replaces the old handleFilePrompt, which keyed off
  // focusedChat and is what made the grid-toolbar 📄 button act on the wrong pane.
  const openFilePromptFor = (id: string) => {
    const chat = chats.find((c) => (c.key || c.id) === id);
    if (!chat) return;
    setActingPaneId(id);
    // Auto-fill with the chat's working directory if known
    const cwd = chat.cwd || '.';
    setFileInput(`${cwd}/`);
    setFileInputError(''); // Clear any previous error
    setFileOpen(false);
    setFilePromptOpen(true); // Open the path-entry Dialog
  };

  // WARDEN-563: per-pane workspace content-search trigger — seeds the acting pane
  // so WorkspaceSearchDialog scopes its query to THIS pane's repo. Mirrors
  // openFilePromptFor's id-seeding shape.
  const openSearchFor = (id: string) => {
    setActingPaneId(id);
    setSearchOpen(true);
  };

  // WARDEN-573: per-pane read-only directory-browse trigger (📂) — the structural
  // twin of openSearchFor. Seeds the acting pane so FileBrowserDialog lists THIS
  // pane's repo (not the focused pane's). Same id-seeding shape.
  const openBrowseFor = (id: string) => {
    setActingPaneId(id);
    setBrowseOpen(true);
  };

  // keyboard shortcuts: pane navigation, actions, and panel toggles
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Panel toggles first — they don't depend on tiles, so they must run before
      // the zero-panes guard below. PaneGrid is always mounted (even with 0 open
      // panes), and these shortcuts are advertised in PRODUCT.md unconditionally.
      if (e.altKey && e.code === 'KeyS') {
        e.preventDefault();
        onToggleSidebar?.();
      }
      if (e.altKey && e.code === 'KeyO') {
        e.preventDefault();
        onToggleObserver?.();
      }

      if (!tiles.length) return;
      const ids = tiles.map((t) => t.id);
      const idx = focused ? ids.indexOf(focused) : -1;

      // Pane navigation: Alt+←/→ or Ctrl+Tab/Shift+Tab
      if (e.altKey && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
        e.preventDefault();
        const dir = e.code === 'ArrowRight' ? 1 : -1;
        const next = ids[(idx + dir + ids.length) % ids.length];
        if (next) onFocus(next);
      }

      // Pane navigation: Ctrl+Tab/Shift+Tab cycle forward/backward
      if (e.ctrlKey && e.code === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        const next = ids[(idx + 1) % ids.length];
        if (next) onFocus(next);
      }
      if (e.ctrlKey && e.code === 'Tab' && e.shiftKey) {
        e.preventDefault();
        const next = ids[(idx - 1 + ids.length) % ids.length];
        if (next) onFocus(next);
      }

      // Direct pane jumping: Alt+1-9 for indexed, Alt+0 for last
      if (e.altKey && e.code >= 'Digit1' && e.code <= 'Digit9') {
        e.preventDefault();
        const num = parseInt(e.code.slice(5), 10); // Extract number from 'DigitN'
        if (num <= ids.length) onFocus(ids[num - 1]);
      }
      if (e.altKey && e.code === 'Digit0') {
        e.preventDefault();
        onFocus(ids[ids.length - 1]); // Jump to last pane
      }

      // Pane actions: Ctrl+W close, Alt+Enter maximize, Alt+Escape restore
      if (e.ctrlKey && e.code === 'KeyW' && focused) {
        e.preventDefault();
        onClose(focused);
      }
      if (e.altKey && e.code === 'Enter' && focused) {
        e.preventDefault();
        onToggleMax(focused);
      }
      if (e.altKey && e.code === 'Escape') {
        e.preventDefault();
        if (maximized) onToggleMax(maximized); // Exit maximize mode
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [tiles, focused, maximized, onFocus, onClose, onToggleMax, onToggleSidebar, onToggleObserver]);

  // Focus the path input when the entry Dialog opens — React-controlled via ref,
  // not a DOM query (WARDEN-68 Rule 4). Radix's own open-auto-focus is disabled
  // (see onOpenAutoFocus on DialogContent) so it doesn't race this.
  useEffect(() => {
    if (filePromptOpen) fileInputRef.current?.focus();
  }, [filePromptOpen]);

  // Resolve the visible tiles through the stale-maximized guard (WARDEN-521): a
  // maximized id whose tile is no longer in the grid (closed/killed/moved away)
  // behaves as "not maximized" so the grid falls back to every open tile instead
  // of blanking. effectiveMax also drives the grid template and per-tile flag, so
  // a stale id can never pin the layout to a single column either.
  const { effectiveMax, visible } = resolveVisibleTiles(maximized, tiles);
  const n = visible.length;
  // WARDEN-660: whether the grid div is currently mounted. PaneGrid is always
  // mounted (its keydown handler needs it), but the grid div itself is rendered
  // only on the `n > 0` branch below — so this bool tracks the grid node's
  // presence and is the dep the geometry effect re-runs on (see that effect).
  const gridMounted = n > 0;
  // `cols`/`rows` (the non-maximized grid shape) are resolved above via
  // gridShape(paneLayout, tiles.length). 'auto' reproduces today's exact grid
  // (cols = ceil(sqrt(nAll)), rows = ceil(nAll/cols)); 'stacked' forces a single
  // column; 'side-by-side' forces a single row. Maximize overrides to a 1×1 grid
  // via the template's `effectiveMax ? 1 : …` below (and hides the gutters), so
  // it never touches the shape or the ratios — toggling it preserves the ratios
  // (WARDEN-660: "ratios intact after restore"). The n===0 case renders the
  // empty-state message instead of the grid, so the shape is moot then.

  // WARDEN-660 sync: when the persisted ratio prop changes OUT from under us
  // (an external reset — e.g. resetUiPrefsPreservingWorkspace wipes it to []),
  // re-seed local. A prop value equal to what we last pushed is our own commit
  // echoing back — local already matches, so skip (avoids a redundant render on
  // every drag commit). Skips mount (pushedRef seeded to the prop).
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
    // Commit the final ratios to App for persistence — ONE write per drag, not
    // one per pointermove (the per-move updates were local-only).
    if (d.axis === 'col') {
      pushedRef.current.col = d.last.slice();
      onPaneColRatiosChange(d.last);
    } else {
      pushedRef.current.row = d.last.slice();
      onPaneRowRatiosChange(d.last);
    }
  };

  // Double-click a gutter → reset that whole axis (cols or rows) to equal split.
  const resetAxis = (axis: DragAxis) => (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
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

  // Double-click a crossing pad → reset BOTH axes to equal. A pad sits on both a
  // col and a row gutter, so committing to a single axis would be arbitrary;
  // resetting both matches "reset what you can see diverging" and stays the
  // symmetric counterpart to the single-axis strips (a col strip resets cols, a
  // row strip resets rows). Same pushedRef + commit pattern as resetAxis so the
  // reset survives the sync effect and reload.
  const resetBothAxes = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const eqCol = equalRatios(cols);
    const eqRow = equalRatios(rows);
    pushedRef.current.col = eqCol;
    pushedRef.current.row = eqRow;
    setColRatios(eqCol);
    setRowRatios(eqRow);
    onPaneColRatiosChange(eqCol);
    onPaneRowRatiosChange(eqRow);
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
  const showGutters = !effectiveMax && visible.length > 1;
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

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center px-3 py-2 compact:py-1.5 border-b text-xs text-muted-foreground gap-2 shrink-0 relative">
        <span className="truncate">{focused ? nameOf(focused) : 'open a chat →'}</span>
        <span className="flex-1" />
        {/* WARDEN-563: the grid-toolbar 🔍 search / 📄 file buttons lived here,
            operating on the focused pane. Retired — both affordances now live
            on each pane's own context menu (right-click → Search workspace
            files / Open file from directory / Browse files in directory) and
            act on the right-clicked pane. The 📂 browse entry (WARDEN-573) is a
            third sibling there, not a re-added toolbar button. */}
      </div>
      <div className="flex-1 min-h-0 p-1">
        {n === 0 ? (
          <div className="text-xs text-muted-foreground p-8 text-center">click a chat to open a live pane</div>
        ) : (
          <div data-pane-grid ref={gridRef}
            className={`relative grid gap-2 compact:gap-1 h-full min-h-0 overflow-x-auto ease-in-out ${dragging ? '' : 'transition-all duration-200'}`}
            style={{ gridTemplateColumns: colTpl, gridTemplateRows: rowTpl }}>
            {visible.map((t) => {
              const chat = chats.find((c) => (c.key || c.id) === t.id);
              return (
                <div key={t.id} data-pane-id={t.id} className="min-h-0 min-w-0">
                  <PaneTile id={t.id} label={nameOf(t.id)} focused={focused === t.id} maximized={effectiveMax === t.id}
                    hasNew={newActivity.has(t.id)} onClearNew={() => onClearNew(t.id)}
                    onFocus={() => onFocus(t.id)} onClose={() => onClose(t.id)} onToggleMax={() => onToggleMax(t.id)}
                    onKill={() => onForceKill(t.id)} onSplitShell={() => onSplitShell?.(t.id)} onSearchWorkspace={() => openSearchFor(t.id)} onOpenFileFromDir={() => openFilePromptFor(t.id)} onBrowseFiles={() => openBrowseFor(t.id)} chat={chat} host={paneHost[t.id]}
                    externalSearchQuery={externalSearchQuery?.paneId === t.id ? externalSearchQuery.query : undefined}
                    fontSize={fontSize} onFontSizeChange={onFontSizeChange}
                    scrollback={scrollback}
                    fontFamily={fontFamily}
                    terminalThemeId={terminalThemeId}
                    terminalCursorStyle={terminalCursorStyle}
                    copyOnSelect={copyOnSelect}
                    onExitBehavior={onExitBehavior}
                    showHostTags={showHostTags}
                    onSpawned={onSpawned}
                    snippets={snippets}
                    timestampFormat={timestampFormat}
                    fileViewerViewMode={fileViewerViewMode}
                    onFileViewerViewModeChange={onFileViewerViewModeChange}
                    pollIntervalMs={pollIntervalMs}
                  />
                </div>
              );
            })}
            {/* WARDEN-660: draggable resize gutters. One transparent hit area per
                internal gutter, positioned over the visual gap between two
                adjacent tracks. The rest of this overlay is pointer-events-none
                so it never blocks the panes; only the gutter strips (and the
                crossing pads below) capture pointers. A 1px line reveals on
                hover as the affordance. Double-click resets the axis to equal.
                Rendered only on a real multi-track grid (never maximized /
                single-pane). Strips are single-axis (col strips → col-resize,
                row strips → row-resize); crossing pads (rendered last, on top at
                each intersection) route by the drag's initial direction so
                neither axis is ungrabbable where the gutters cross. */}
            {showGutters && (colCenters.length > 0 || rowCenters.length > 0) && (
              <div ref={setOverlayRef} className="absolute inset-0 pointer-events-none z-10">
                {colCenters.map((left, g) => (
                  <div key={`cg${g}`} role="separator" aria-orientation="vertical"
                    aria-label="Resize columns"
                    onPointerDown={beginDrag('col', g)} onPointerMove={onHandlePointerMove}
                    onPointerUp={onHandlePointerUp} onDoubleClick={resetAxis('col')}
                    className="group/gutter pointer-events-auto absolute top-0 bottom-0 cursor-col-resize"
                    style={{ left: left - HANDLE_HALF_PX, width: HANDLE_W_PX, touchAction: 'none' }}>
                    <div className="absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2 bg-border opacity-0 transition-opacity duration-100 group-hover/gutter:opacity-100" />
                  </div>
                ))}
                {rowCenters.map((top, g) => (
                  <div key={`rg${g}`} role="separator" aria-orientation="horizontal"
                    aria-label="Resize rows"
                    onPointerDown={beginDrag('row', g)} onPointerMove={onHandlePointerMove}
                    onPointerUp={onHandlePointerUp} onDoubleClick={resetAxis('row')}
                    className="group/gutter pointer-events-auto absolute left-0 right-0 cursor-row-resize"
                    style={{ top: top - HANDLE_HALF_PX, height: HANDLE_W_PX, touchAction: 'none' }}>
                    <div className="absolute top-1/2 left-0 right-0 h-px -translate-y-1/2 bg-border opacity-0 transition-opacity duration-100 group-hover/gutter:opacity-100" />
                  </div>
                ))}
                {/* WARDEN-660 crossing pads: one per col-gutter × row-gutter
                    intersection, rendered LAST so each sits above BOTH strips at
                    the crossing. A pad covers exactly the two strips' overlap
                    (a HANDLE_W_PX square), so away from crossings the
                    single-axis strips stay the undisputed target and keep their
                    direct behavior, while AT a crossing the pad wins and routes
                    the drag by its initial direction (beginJunctionDrag →
                    |dx|>=|dy| ? cols : rows). Without it the row strip — painted
                    above the col strip — silently swallowed horizontal drags at
                    the crossing, the 2×2 dead-center grab. The pad's own hover
                    affordance is a small plus (arms extend half a handle past
                    the square) signalling "drag either way", distinct from a
                    lone strip's single line; double-click resets both axes. */}
                {colCenters.map((left, gCol) => rowCenters.map((top, gRow) => (
                  <div key={`x${gCol}-${gRow}`} role="separator"
                    aria-label="Resize columns or rows"
                    onPointerDown={beginJunctionDrag(gCol, gRow)}
                    onPointerMove={onHandlePointerMove}
                    onPointerUp={onHandlePointerUp}
                    onDoubleClick={resetBothAxes}
                    className="group/gutter pointer-events-auto absolute cursor-grab"
                    style={{ left: left - HANDLE_HALF_PX, top: top - HANDLE_HALF_PX, width: HANDLE_W_PX, height: HANDLE_W_PX, touchAction: 'none' }}>
                    <div aria-hidden
                      className="absolute left-1/2 w-px -translate-x-1/2 bg-border opacity-0 transition-opacity duration-100 group-hover/gutter:opacity-100"
                      style={{ top: -HANDLE_HALF_PX, bottom: -HANDLE_HALF_PX }} />
                    <div aria-hidden
                      className="absolute top-1/2 h-px -translate-y-1/2 bg-border opacity-0 transition-opacity duration-100 group-hover/gutter:opacity-100"
                      style={{ left: -HANDLE_HALF_PX, right: -HANDLE_HALF_PX }} />
                  </div>
                )))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* File Viewer Dialog */}
      {actingChat && filePath && (
        <FileViewer
          chatId={actingChat.id}
          filePath={filePath}
          line={fileLine}
          open={fileOpen}
          timestampFormat={timestampFormat}
          viewMode={fileViewerViewMode}
          onViewModeChange={onFileViewerViewModeChange}
          onNavigate={(p) => { setFilePath(p); setFileLine(undefined); }}
          pollIntervalMs={pollIntervalMs}
          onOpenChange={(open) => {
            setFileOpen(open);
            if (!open) {
              setFilePath(''); // Clear file path when dialog closes
              setFileLine(undefined); // and the grep-selected line (WARDEN-334)
            }
          }}
        />
      )}

      {/* Workspace content-search Dialog (WARDEN-145): locate a file by content,
          then hand its path to the FileViewer above to open. WARDEN-563: scoped
          to the right-clicked pane's chat (actingChat), not the focused pane. */}
      {actingChat && (
        <WorkspaceSearchDialog
          chatId={actingChat.id}
          cwd={actingChat.cwd}
          open={searchOpen}
          onOpenChange={setSearchOpen}
          onSelectFile={(file, line) => { setFilePath(file); setFileLine(line); setFileOpen(true); }}
        />
      )}

      {/* Read-only directory browser (WARDEN-573): the structural twin of the
          grep dialog — browse dirs → filenames, then hand the chosen path to the
          same FileViewer above. onSelectFile mirrors the grep callback minus the
          line (a browse has no line to scroll to). WARDEN-563: scoped to the
          right-clicked pane's chat (actingChat), not the focused pane. */}
      {actingChat && (
        <FileBrowserDialog
          chatId={actingChat.id}
          cwd={actingChat.cwd}
          open={browseOpen}
          onOpenChange={setBrowseOpen}
          onSelectFile={(file) => { setFilePath(file); setFileLine(undefined); setFileOpen(true); }}
        />
      )}

      {/* File Path Entry Dialog — shadcn Dialog + Input + Button (WARDEN-68) */}
      <Dialog
        open={filePromptOpen}
        onOpenChange={(open) => {
          if (!open) {
            setFilePromptOpen(false);
            setFileInput('');
            setFileInputError('');
          }
        }}
      >
        <DialogContent className="sm:max-w-md" onOpenAutoFocus={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle>Open file from chat directory</DialogTitle>
            <DialogDescription>Working directory: {actingChat?.cwd || '.'}</DialogDescription>
          </DialogHeader>
          <Input
            ref={fileInputRef}
            value={fileInput}
            onChange={(e) => { setFileInput(e.target.value); setFileInputError(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter') handleOpenFile(); }}
            placeholder="relative/path/to/file.txt"
          />
          {fileInputError && (
            <p className="text-xs text-destructive">{fileInputError}</p>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button onClick={handleOpenFile}>Open</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
