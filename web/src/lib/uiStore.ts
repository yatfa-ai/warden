// uiStore — the shared CLIENT-STATE store (WARDEN-1271, roadmap WARDEN-1204
// slice 1), the decided instrument from WARDEN-832 row 2: "shared/persisted
// client UI state → Zustand layered over storage.ts".
//
// WHAT THIS IS FOR
// ────────────────
// warden's persistence half is healthy: ONE compile-locked write effect
// (useConfigPersistence.ts) is the single writer to localStorage. The SHARING
// half is what did not exist — a shared pref lived in an App.tsx `useState` and
// was handed down as a prop through every intermediate component between App
// and the surface that actually reads it. `snippets` (WARDEN-323) was the worst
// case: 8 reading surfaces behind 7 App pass-sites, with intermediate hops that
// are pure pass-throughs by their own comments (PaneGrid "pure pass-through to
// PaneTile", ChatSidebar "threaded straight through").
//
// This store is the SHARING channel: a surface that needs a shared pref
// SUBSCRIBES to it instead of receiving it through its ancestors.
//
// HOW IT COMPOSES WITH storage.ts (it never competes with it)
// ──────────────────────────────────────────────────────────
// storage.ts stays the single source of truth for the SHAPE and the DEFAULTS of
// every pref (types, DEFAULT_UI, the loadUi() sanitizers, STARTER_SNIPPETS).
// This module imports them and re-declares NOTHING.
//
// Persistence stays exactly where it was — SINGLE-WRITER, deliberately:
//
//     store.setSnippets(next)
//       → App's useUiStore subscription re-renders App
//       → the `snippets` field of App's PersistedPrefSnapshot changes identity
//       → useConfigPersistence's saveUi effect fires (its deps are the
//         snapshot's values)
//       → persistUiState → localStorage
//
// There is deliberately NO store-owned write-through persistence here. Adding
// one would create a SECOND writer to the same key and break the compile-locked
// single-writer design (PersistedPrefSnapshot's Required<Pick<…>> lock +
// storage.test.mjs's PERSISTED_PREF_KEYS exhaustiveness guard). Revisit only
// once the subscription pattern is proven across several prefs.
//
// WHY A FACTORY *AND* A SINGLETON
// ───────────────────────────────
// A module-level store leaks between tests unless handled deliberately: test A
// mutates it, test B sees A's value. `createUiStore()` gives every test its own
// isolated instance; `uiStore` is the ONE app-level instance the React hooks
// below bind to. Production code should use the hooks; tests should use the
// factory.

import { createStore, useStore } from 'zustand';
import {
  loadUi,
  loadObs,
  resetObsPrefDefaults,
  DEFAULT_TERMINAL_FONT_FAMILY,
  type Snippet,
  type TerminalCursorStyle,
  type OnExitBehavior,
  type CustomPreset,
} from '@/lib/storage';
import type { PaneLayout, RestoreOnStartup, ObsUi } from '@/lib/storage';
import type { TimestampFormat } from '@/lib/formatTimestamp';
import type { HostLabels } from '@/lib/chatDisplay';
import type { AgentFilter, AgentSort } from '@/lib/agentFilter';
import type { Theme, TerminalColorScheme } from '@/lib/theme';
import type { Density } from '@/lib/density';

/**
 * The shared client-state slice. One field + its setter per migrated pref.
 *
 * SCOPE DISCIPLINE: this holds only prefs that are genuinely SHARED across
 * distant surfaces. A value read by exactly one component stays a `useState`
 * there (WARDEN-832: "ephemeral component state → useState") — moving it here
 * would buy nothing and cost a global re-render.
 */
export interface UiStoreState {
  /**
   * The user-authored instruction library (WARDEN-323). Read by the pane
   * context menu, the broadcast picker, the watch catch-up quick reply, and
   * Settings' CRUD section. Written only by Settings (add/rename/edit/delete)
   * and by the "Reset appearance & UI preferences" action.
   */
  snippets: Snippet[];
  /** Replace the snippet library. The persisted write follows via App's snapshot. */
  setSnippets: (snippets: Snippet[]) => void;
  /**
   * The File Viewer's Rendered ⇄ Source markdown toggle (WARDEN-480), made one
   * global remembered choice rather than a per-open reset. Exactly ONE reader
   * and ONE writer — FileViewer's own toolbar — yet it used to travel App →
   * {ChatSidebar, PaneGrid, HealthDashboard} → {PaneTile} → FileViewer through
   * four PURE pass-through carriers. FileViewer now subscribes here directly
   * (WARDEN-1288, roadmap WARDEN-1204 slice 2) and those hops are deleted.
   */
  fileViewerViewMode: 'rendered' | 'source';
  /** Flip the File Viewer's view mode. The persisted write follows via App's snapshot. */
  setFileViewerViewMode: (mode: 'rendered' | 'source') => void;
  /**
   * Terminal font size in px (8–24, WARDEN-125). Read by PaneTile (the clamp +
   * xterm construction + the live font/scrollback effect) and Settings'
   * AppearanceSection. Written by PaneTile's own A−/A+ toolbar buttons and
   * context-menu entries, and by AppearanceSection.
   */
  terminalFontSize: number;
  /** Set the terminal font size. The persisted write follows via App's snapshot. */
  setTerminalFontSize: (n: number) => void;
  /**
   * Terminal scrollback depth in lines (100–100000, WARDEN-174). Read by
   * PaneTile (the clamp + xterm construction + the live effect; xterm honors a
   * change on reopen) and AppearanceSection (its only writer).
   */
  terminalScrollback: number;
  /** Set the terminal scrollback depth. The persisted write follows via App's snapshot. */
  setTerminalScrollback: (n: number) => void;
  /**
   * Terminal font family — the CSS font-family string xterm renders
   * (WARDEN-230). DEFAULT_UI's value is the EMPTY STRING (blank = default
   * stack), and this seed keeps App's truthiness fallback: a persisted `''`
   * must seed the real DEFAULT_TERMINAL_FONT_FAMILY stack, never `''`, or a
   * pane blanks. Read by PaneTile (with its own defensive `||` fallback at the
   * use site) and AppearanceSection (its only writer, via the curated list or
   * the Custom… free-text field).
   */
  terminalFontFamily: string;
  /** Set the terminal font family. The persisted write follows via App's snapshot. */
  setTerminalFontFamily: (v: string) => void;
  /**
   * Terminal cursor shape × blink (blink/steady × block/underline/bar,
   * WARDEN-241). Read by PaneTile (the CURSOR_OPTIONS map in the xterm
   * constructor + the live [terminalCursorStyle] effect) and AppearanceSection
   * (its only writer). A 'steady-*' value stops the blink — the accessibility
   * payoff vs WARDEN-190.
   */
  terminalCursorStyle: TerminalCursorStyle;
  /** Set the terminal cursor style. The persisted write follows via App's snapshot. */
  setTerminalCursorStyle: (v: TerminalCursorStyle) => void;
  /**
   * "Copy on select" (WARDEN-285): completing a text selection in a pane
   * copies it to the clipboard immediately. Read by PaneTile (mirrored into a
   * ref its selection handler reads, so a toggle applies LIVE to already-open
   * panes) and AppearanceSection (its only writer). Default OFF.
   */
  copyOnSelect: boolean;
  /** Set copy-on-select. The persisted write follows via App's snapshot. */
  setCopyOnSelect: (v: boolean) => void;
  /**
   * "Pane on agent exit" behavior — keep | dim | auto-close (WARDEN-248). Read
   * by PaneTile (the exit effect + the dim overlay) and AppearanceSection (its
   * only writer). 'keep' is today's exact behavior.
   */
  onExitBehavior: OnExitBehavior;
  /** Set the on-exit behavior. The persisted write follows via App's snapshot. */
  setOnExitBehavior: (v: OnExitBehavior) => void;
  /**
   * The dashboard-wide Timestamp format (WARDEN-213) — Relative ("3h") vs
   * Absolute ("2:13 PM") — migrated onto the store (WARDEN-1342, roadmap
   * WARDEN-1204 slice 4). Read by every surface that renders a human-facing
   * timestamp (ActivityTimeline, the sidebar chat rows, DirectiveHistory,
   * FileViewer blame, FleetMatrixPanel buckets, GlobalSearchDialog,
   * HealthDashboard, ObserverPanel, OpenChatBrowserPage,
   * SessionTranscriptViewer, UpdatedAgo) and written by Settings'
   * AppearanceSection. Default 'relative'.
   */
  timestampFormat: TimestampFormat;
  /** Set the timestamp format. The persisted write follows via App's snapshot. */
  setTimestampFormat: (v: TimestampFormat) => void;
  /**
   * Per-host display labels (WARDEN-490) — raw host string ('(local)' / SSH
   * host) → the human's friendly label, shown wherever a host tag appears.
   * Migrated onto the store (roadmap WARDEN-1204 slice 6), which deletes the
   * LAST React context in web/src: a purpose-built provider that carried the
   * map to ~10 reading surfaces, plus a parallel props channel to the Settings
   * writer. HostsSection (the writer) and every display surface (readers) now
   * subscribe here directly. Pure client localStorage — display-only, it never
   * reaches the backend — so this is shared/persisted CLIENT state and
   * WARDEN-832 row 2 (this store), not the server-state rows, governs. An
   * empty map (or a host with no entry) = no label = the raw host.
   */
  hostLabels: HostLabels;
  /** Replace the label map. The persisted write follows via App's snapshot. */
  setHostLabels: (labels: HostLabels) => void;
  /**
   * The sidebar fleet Filter (all/yatfa/claude/manual — WARDEN-442's pair,
   * controls shipped in WARDEN-91), migrated onto the store (roadmap
   * WARDEN-1204 slice 7), which retires the LAST large prop-drilled persisted
   * pair: App owned both in a useState and threaded them read-only into
   * ChatSidebar, which passed all four down to each of its three
   * AgentFilterSortControls mounts. ChatSidebar (which APPLIES the pair —
   * matchesAgentFilter + sortChats on the collection and host lists) and the
   * popover (which WRITES it) now subscribe here directly, and the 16 JSX
   * pass sites are gone. Persistence is unchanged: App keeps its snapshot
   * field + resetSetters entry, so the ONE compile-locked saveUi effect
   * remains the single writer. Default 'all'.
   */
  agentFilter: AgentFilter;
  /** Set the sidebar fleet filter. The persisted write follows via App's snapshot. */
  setAgentFilter: (filter: AgentFilter) => void;
  /**
   * The sidebar fleet Sort (manual/name/host/status/activity — the other half
   * of WARDEN-442's pair), same migration as agentFilter above. Read by
   * sortChats on the collection and host lists; the ROOT list deliberately
   * never sorts (WARDEN-949), and its header hides the sort Select so a
   * non-manual value can never tint an inactive control. Default 'manual'.
   */
  agentSort: AgentSort;
  /** Set the sidebar fleet sort. The persisted write follows via App's snapshot. */
  setAgentSort: (sort: AgentSort) => void;
  /**
   * The new-chats spawn family (roadmap WARDEN-1204 slice 8, WARDEN-1383) —
   * the default agent type / host / cwd / shell pre-filled in the ＋ new chat
   * form, their per-host overrides, and the user-defined custom presets.
   * Exactly TWO reading surfaces and ONE writing surface each, which is what
   * made this the last surviving second-read-channel in web/src:
   * NewChatForm (the reader) did a PRIVATE `useState(() => loadUi())` while
   * NewChatsSection (the writer) got the same facts threaded through the
   * `NewChatsPrefs` bag — one value, two channels. Both now subscribe here
   * (App too, via keep-local-names, for the snapshot + resetSetters), the
   * bag interface is retired, and the guard test in uiStore.test.mjs keeps
   * `loadUi(` out of web/src/components/ for good. All eight are pure client
   * localStorage prefs — shared + persisted client state, WARDEN-832 row 2.
   * Defaults mirror DEFAULT_UI ('claude', '(local)', '', {}, []), seeded
   * ??-only like every other fact.
   */
  defaultNewChatPreset: string;
  /** Set the default spawn agent type. The persisted write follows via App's snapshot. */
  setDefaultNewChatPreset: (v: string) => void;
  /** Per-host spawn agent-type overrides ('(local)' / SSH host → preset name). */
  defaultNewChatPresetByHost: Record<string, string>;
  /** Replace the per-host preset map. The persisted write follows via App's snapshot. */
  setDefaultNewChatPresetByHost: (v: Record<string, string>) => void;
  /** The host the ＋ new chat form pre-selects ('(local)' or an SSH host). */
  defaultNewChatHost: string;
  /** Set the default spawn host. The persisted write follows via App's snapshot. */
  setDefaultNewChatHost: (v: string) => void;
  /** The cwd pre-filled in the spawn form. Blank = the host's home directory. */
  defaultNewChatCwd: string;
  /** Set the global default spawn cwd. The persisted write follows via App's snapshot. */
  setDefaultNewChatCwd: (v: string) => void;
  /** Per-host spawn cwd overrides (host → cwd path). */
  defaultNewChatCwdByHost: Record<string, string>;
  /** Replace the per-host cwd map. The persisted write follows via App's snapshot. */
  setDefaultNewChatCwdByHost: (v: Record<string, string>) => void;
  /** The user-defined quick-fill presets (named commands beyond claude/shell). */
  customPresets: CustomPreset[];
  /** Replace the custom-preset list (Settings CRUD). The persisted write follows via App's snapshot. */
  setCustomPresets: (v: CustomPreset[]) => void;
  /** The default shell the spawn form's shell preset + App's split button open. Blank = host login shell. */
  defaultShell: string;
  /** Set the global default shell. The persisted write follows via App's snapshot. */
  setDefaultShell: (v: string) => void;
  /** Per-host default-shell overrides (host → shell name). */
  defaultShellByHost: Record<string, string>;
  /** Replace the per-host shell map. The persisted write follows via App's snapshot. */
  setDefaultShellByHost: (v: Record<string, string>) => void;
  /**
   * The attention/notification pair (roadmap WARDEN-1204 slice 11, WARDEN-1408).
   * The master OS-desktop-alert opt-in (WARDEN-259) plus the per-state Attention
   * badge display filters (WARDEN-344). WARDEN-1274 is the reason the pair still
   * exists and what the master toggle still gates — the fleet ATTENTION alert it
   * was named for is retired, but TWO live channels remain and it is the ONLY
   * opt-in on both:
   *   1. The token-BUDGET OS notification (useTokenBudget → pickBudgetChannel):
   *      hidden + this off resolves the channel to 'none', so the away-alarm
   *      simply never fires. Removing this toggle would have silently killed it.
   *   2. The hidden-tab poll relaxation in useAttentionRollup, which keeps the
   *      surviving WATCH ping able to fire while the human is away.
   * So it is NOT a no-op knob — it gates working channels; the Settings copy in
   * NotificationsSection names those, not the removed attention alerts.
   *
   * Reading surfaces beyond the writer's own subscription: useAttentionRollup's
   * three poller gates (the runWhileHidden relaxation above), useTokenBudget's
   * OS-notification gate, and App's persist/reset channels. NotificationsSection
   * (the writer) and each consumer SUBSCRIBE here directly since WARDEN-1408 —
   * the DesktopAlertPrefs Settings props bag is retired. Defaults mirror
   * DEFAULT_UI (false / { stuck: true, done: true }), seeded ??-only like every
   * other fact — loadUi's sanitizers (`=== true` for the opt-in, `!== false`
   * per state) already normalize a persisted payload.
   */
  attentionDesktopAlerts: boolean;
  /** Set the master desktop-alert opt-in. The persisted write follows via App's snapshot. */
  setAttentionDesktopAlerts: (v: boolean) => void;
  /** Per-state Attention badge display filters (stuck / done since WARDEN-1360; each defaults ON). */
  attentionStates: { stuck?: boolean; done?: boolean };
  /** Replace the per-state filter bag. The persisted write follows via App's snapshot. */
  setAttentionStates: (v: { stuck?: boolean; done?: boolean }) => void;
  /**
   * The six remaining AppearancePrefs pairs (roadmap WARDEN-1204 slice 12,
   * WARDEN-1420) — theme, density, paneLayout, autoFocusNewPane,
   * restoreOnStartup and terminalColorScheme. Slice 3 (WARDEN-1322) took the
   * six terminal prefs out of the same bag; this takes the rest, so
   * `AppearancePrefs` shrinks to the three ELECTRON pairs (rememberWindowBounds
   * / launchAtLogin / closeToTray) that deliberately stay App-local: one
   * reader, one writer, an IPC integration with no second sharing channel.
   *
   * The slice-3 note kept terminalColorScheme in the bag because App — not a
   * component — was its only runtime reader. That is SUPERSEDED, not
   * contradicted: once the family moves, a UiState pref still riding a props
   * bag IS the second sharing channel this direction exists to end, and App
   * keeps reading it here (via the hook) to derive `terminalThemeId`.
   *
   * Every one of the six is pure client localStorage — shared + persisted
   * client state, WARDEN-832 row 2 — and persistence is unchanged: App keeps
   * its snapshot fields + resetSetters entries, so the ONE compile-locked
   * saveUi effect remains the single writer.
   */
  /**
   * The app-wide theme pref — 'system' (follow the OS) or a concrete named
   * theme id. Read by App (the [theme] effect that paints the chrome and keeps
   * `resolvedThemeId` in sync) and AppearanceSection (its only writer).
   */
  theme: Theme;
  /** Set the app theme. The persisted write follows via App's snapshot. */
  setTheme: (v: Theme) => void;
  /**
   * Row/header spacing — 'comfortable' | 'compact' (WARDEN-133). Read by App's
   * applyDensity effect; AppearanceSection is its only writer.
   */
  density: Density;
  /** Set the density. The persisted write follows via App's snapshot. */
  setDensity: (v: Density) => void;
  /**
   * How open panes are arranged — 'auto' | 'stacked' | 'side-by-side'. Read by
   * PaneGrid (`gridShape(paneLayout, tiles.length)`), which SUBSCRIBES here
   * since this slice instead of taking it as a prop from App; AppearanceSection
   * is its only writer.
   */
  paneLayout: PaneLayout;
  /** Set the pane layout. The persisted write follows via App's snapshot. */
  setPaneLayout: (v: PaneLayout) => void;
  /**
   * Whether opening/resuming/splitting a chat moves keyboard focus to the new
   * pane (WARDEN-274; default true = today's behavior). Read by App's openChat
   * (it gates the setFocused calls) and AppearanceSection (its only writer).
   */
  autoFocusNewPane: boolean;
  /** Set auto-focus-on-open. The persisted write follows via App's snapshot. */
  setAutoFocusNewPane: (v: boolean) => void;
  /**
   * "Restore workspace on startup" — 'previous' | 'empty'. The ONE UiState
   * field persistUiState takes as a separate argument rather than through the
   * `live` spread, so App passes the LIVE value to useConfigPersistence.
   * BOOT restoration does not read this store: App resolves the initial
   * workspace from the DISK payload before React renders, so where the live
   * pref lives is independent of it. AppearanceSection is its only writer.
   */
  restoreOnStartup: RestoreOnStartup;
  /** Set the startup-restore pref. The persisted write follows via App's snapshot. */
  setRestoreOnStartup: (v: RestoreOnStartup) => void;
  /**
   * Terminal color scheme — 'auto' (follow the effective app theme) |
   * 'dark' | 'light'. Read by App, which resolves it together with
   * `resolvedThemeId` into the concrete `terminalThemeId` PaneTile repaints
   * from (that derivation stays an App-computed prop so an OS theme flip
   * re-themes open panes live); AppearanceSection is its only writer.
   */
  terminalColorScheme: TerminalColorScheme;
  /** Set the terminal color scheme. The persisted write follows via App's snapshot. */
  setTerminalColorScheme: (v: TerminalColorScheme) => void;
  /**
   * The Fleet Health pair (roadmap WARDEN-1204 slice 13, WARDEN-1426) — the
   * LAST persisted UiState family that crossed a props bag into another
   * component. App owned both as useStates and threaded four JSX pass sites +
   * four Props entries into HealthDashboard, which is mounted in exactly ONE
   * place and is the pair's only reader AND only writer. It subscribes here
   * now, so the props channel is gone.
   *
   * Both are pure client localStorage — shared + persisted client state,
   * WARDEN-832 row 2 — and persistence is unchanged: App keeps its snapshot
   * fields + resetSetters entries, so the ONE compile-locked saveUi effect
   * remains the single writer.
   */
  /**
   * "Group agents by: Health | Host | Project" (WARDEN-237; Project added in
   * WARDEN-741, persisted in WARDEN-468). Read by HealthDashboard's mode
   * buttons, its visible-ids derivation and its render fork; written by those
   * same mode buttons. The type is the inline literal union rather than an
   * import of HealthDashboard's exported `GroupMode` — the fileViewerViewMode
   * precedent above — so lib/ never imports from components/.
   */
  healthGroupBy: 'health' | 'host' | 'project';
  /** Set the health grouping mode. The persisted write follows via App's snapshot. */
  setHealthGroupBy: (v: 'health' | 'host' | 'project') => void;
  /**
   * The per-host expand/collapse state INSIDE Host grouping (WARDEN-237,
   * persisted in WARDEN-500) — the companion that made WARDEN-468's durable
   * grouping choice useful, since the collapsed hosts beneath it used to reset
   * on every restart. Read by HealthDashboard's host-group render branch;
   * written by its per-host collapse toggle. Default {} = every host expanded.
   */
  healthCollapsedHosts: Record<string, boolean>;
  /** Set the collapsed-hosts map. The persisted write follows via App's snapshot. */
  setHealthCollapsedHosts: (v: Record<string, boolean>) => void;
  /**
   * The draggable resize-gutter ratios (WARDEN-660; roadmap WARDEN-1204 slice
   * 14, WARDEN-1433) — per-axis PaneGrid track weights ([] = equal split, the
   * default). The pair's ONLY reader AND only writer is PaneGrid: App owned
   * both as useStates and threaded four JSX pass sites + four Props entries
   * into it, and PaneGrid now subscribes here instead, so the props channel
   * is gone.
   *
   * Pure client localStorage — shared + persisted client state, WARDEN-832
   * row 2 — persisted by the saveUi effect (App keeps its snapshot
   * subscription; the store has NO write-through). PaneGrid keeps a LOCAL
   * working copy so a drag re-templates the grid at 60fps without a
   * localStorage write per pointermove; it commits the final arrays through
   * these actions on pointerUp only. NOT resettable: both keys sit in
   * RESET_PRESERVED_KEYS (WARDEN-934 — "they are panel layout, which the
   * shipped button promises to keep"), so there is deliberately NO entry for
   * them in resetUiPrefDefaults() or App's resetSetters.
   */
  paneColRatios: number[];
  paneRowRatios: number[];
  /** Commit the column ratios (PaneGrid pointerUp). The persisted write follows via App's snapshot. */
  setPaneColRatios: (v: number[]) => void;
  /** Commit the row ratios (PaneGrid pointerUp). The persisted write follows via App's snapshot. */
  setPaneRowRatios: (v: number[]) => void;
  /**
   * The Observer panel's four view prefs (roadmap WARDEN-1204 slice 15,
   * WARDEN-1441) — which tab is showing (`observerViewMode`) plus the three
   * per-tab filter shapes (activity type/agent/host, directives agent/host,
   * attention agent/host). They live in the SECOND storage namespace (ObsUi /
   * warden:observer:v1, behind loadObs/saveObs), and used to sit in
   * ObserverTabs' own useStates while App — the "View Activity" deep-links and
   * the Settings → Reset action — had to command them through two channels
   * (a one-shot `externalViewMode` prop + consume callback, and a
   * `resetToken` nonce), each documented for the bugs it caused (WARDEN-880's
   * yank/dead-link pair; WARDEN-981's nonce). ObserverTabs and App both
   * SUBSCRIBE here now, so the command channels are deleted.
   *
   * These are the first ObsUi-namespace facts on the store, and the store is
   * deliberately NOT their persistence writer: the single ObsUi writer stays
   * ObserverTabs' `satisfies Required<ObsUi>` saveObs effect (the uiStore.test.mjs
   * saveObs guard pins exactly two call sites). The setters write state only.
   * The value shapes are imported from storage.ts (NonNullable<ObsUi[...]>) —
   * storage stays the owner of shape and defaults; nothing is re-declared here.
   */
  observerViewMode: NonNullable<ObsUi['viewMode']>;
  /** Set the Observer's visible tab (App's "View Activity" deep-links, the tab buttons). */
  setObserverViewMode: (v: NonNullable<ObsUi['viewMode']>) => void;
  /** The Activity tab's type/agent/host filter shape (7 filter scalars live across the three shapes). */
  observerActivityFilters: NonNullable<ObsUi['activityFilters']>;
  /** Replace the Activity filter shape (the tab's three Selects; App's reset). */
  setObserverActivityFilters: (v: NonNullable<ObsUi['activityFilters']>) => void;
  /** The Directives tab's agent/host filter shape. */
  observerDirectiveFilters: NonNullable<ObsUi['directiveFilters']>;
  /** Replace the Directives filter shape (the tab's two Selects; App's reset). */
  setObserverDirectiveFilters: (v: NonNullable<ObsUi['directiveFilters']>) => void;
  /** The Attention tab's agent/host filter shape. */
  observerAttentionFilters: NonNullable<ObsUi['attentionFilters']>;
  /** Replace the Attention filter shape (the tab's two Selects; App's reset). */
  setObserverAttentionFilters: (v: NonNullable<ObsUi['attentionFilters']>) => void;
}

/**
 * The seed a fresh store starts from: whatever the persisted payload holds,
 * normalized by loadUi()'s own sanitizers (which is also where STARTER_SNIPPETS
 * seeding lives). Read ONCE per store instance — the store is the live copy
 * from that point on, exactly as App's `useState(() => uiState.snippets ?? [])`
 * lazy initializer was.
 *
 * Overridable so a test can seed a known slice without touching localStorage.
 */
export type UiStoreSeed = Partial<
  Pick<
    UiStoreState,
    | 'snippets'
    | 'fileViewerViewMode'
    | 'terminalFontSize'
    | 'terminalScrollback'
    | 'terminalFontFamily'
    | 'terminalCursorStyle'
    | 'copyOnSelect'
    | 'onExitBehavior'
    | 'timestampFormat'
    | 'hostLabels'
    | 'agentFilter'
    | 'agentSort'
    | 'defaultNewChatPreset'
    | 'defaultNewChatPresetByHost'
    | 'defaultNewChatHost'
    | 'defaultNewChatCwd'
    | 'defaultNewChatCwdByHost'
    | 'customPresets'
    | 'defaultShell'
    | 'defaultShellByHost'
    | 'attentionDesktopAlerts'
    | 'attentionStates'
    | 'theme'
    | 'density'
    | 'paneLayout'
    | 'autoFocusNewPane'
    | 'restoreOnStartup'
    | 'terminalColorScheme'
    | 'healthGroupBy'
    | 'healthCollapsedHosts'
    | 'paneColRatios'
    | 'paneRowRatios'
    | 'observerViewMode'
    | 'observerActivityFilters'
    | 'observerDirectiveFilters'
    | 'observerAttentionFilters'
  >
>;

/**
 * Build an INDEPENDENT store instance.
 *
 * Used by the app once (see `uiStore` below) and by every test that needs a
 * clean slice — that isolation is the whole reason this is a factory rather
 * than a bare module-level `create()`.
 */
export function createUiStore(seed: UiStoreSeed = {}) {
  // ONE persisted read per store instance, shared by every seeded fact — the
  // same single `loadUi()` App does for its own lazy initializers.
  const persisted = loadUi();
  // ONE ObsUi read per store instance, for the second namespace's facts
  // (slice 15). `resetObsPrefDefaults()` is the ??-only fallback for both the
  // view mode and the three filter shapes — storage.ts stays the owner of
  // shape and defaults; nothing below re-declares a `{ type: 'all', … }`
  // literal. It is a FACTORY, so every store instance (and the singleton)
  // gets its own fresh default objects — handing them to state aliases
  // nothing, and a store-level `set` replaces objects whole anyway.
  const persistedObs = loadObs();
  const obsDefaults = resetObsPrefDefaults();
  return createStore<UiStoreState>()((set) => ({
    snippets: seed.snippets ?? persisted.snippets ?? [],
    setSnippets: (snippets) => set({ snippets }),
    fileViewerViewMode: seed.fileViewerViewMode ?? persisted.fileViewerViewMode ?? 'rendered',
    setFileViewerViewMode: (fileViewerViewMode) => set({ fileViewerViewMode }),
    // The six terminal prefs (WARDEN-1322, roadmap WARDEN-1204 slice 3). The
    // literals below mirror DEFAULT_UI (pinned against it by uiStore.test.mjs),
    // exactly as the useStates they replaced did.
    terminalFontSize: seed.terminalFontSize ?? persisted.terminalFontSize ?? 14,
    setTerminalFontSize: (terminalFontSize) => set({ terminalFontSize }),
    terminalScrollback: seed.terminalScrollback ?? persisted.terminalScrollback ?? 10000,
    setTerminalScrollback: (terminalScrollback) => set({ terminalScrollback }),
    // WARDEN-1322's one deliberate deviation from the ??-only shape above:
    // truthiness, not nullish — DEFAULT_UI.terminalFontFamily is '' (blank =
    // default stack) and a persisted '' MUST seed the real font stack, or a
    // pane blanks. Parenthesized because ?? cannot be mixed with || bare.
    // PaneTile keeps its own defensive || at the use site too.
    terminalFontFamily:
      seed.terminalFontFamily ?? (persisted.terminalFontFamily || DEFAULT_TERMINAL_FONT_FAMILY),
    setTerminalFontFamily: (terminalFontFamily) => set({ terminalFontFamily }),
    terminalCursorStyle: seed.terminalCursorStyle ?? persisted.terminalCursorStyle ?? 'blink-block',
    setTerminalCursorStyle: (terminalCursorStyle) => set({ terminalCursorStyle }),
    copyOnSelect: seed.copyOnSelect ?? persisted.copyOnSelect ?? false,
    setCopyOnSelect: (copyOnSelect) => set({ copyOnSelect }),
    onExitBehavior: seed.onExitBehavior ?? persisted.onExitBehavior ?? 'keep',
    setOnExitBehavior: (onExitBehavior) => set({ onExitBehavior }),
    // WARDEN-1342 (roadmap WARDEN-1204 slice 4): ??-only shape — DEFAULT_UI
    // .timestampFormat is 'relative' (a non-empty literal), so this is NOT the
    // terminalFontFamily truthiness exception.
    timestampFormat: seed.timestampFormat ?? persisted.timestampFormat ?? 'relative',
    setTimestampFormat: (timestampFormat) => set({ timestampFormat }),
    // WARDEN-1204 slice 6: ??-only shape — DEFAULT_UI.hostLabels is {} and an
    // empty map is the "no labels" identity, the same Record-shape class the
    // `?? {}` seed of healthCollapsedHosts below carries (it was App's
    // `useState(() => uiState.healthCollapsedHosts ?? {})` initializer until
    // slice 13 moved that fact here too). The store's {} replaces the context's
    // `undefined` default with an equivalent: hostLabelFor/hostTagOf treat both
    // as "no labels", so nothing renders differently.
    hostLabels: seed.hostLabels ?? persisted.hostLabels ?? {},
    setHostLabels: (hostLabels) => set({ hostLabels }),
    // WARDEN-1204 slice 7: ??-only shape, mirroring App's retired
    // `useState(() => uiState.agentFilter ?? 'all')` / `?? 'manual'`
    // initializers — both literals mirror DEFAULT_UI (pinned against it by
    // uiStore.test.mjs), and loadUi()'s own sanitizers already normalize a
    // persisted payload (agentFilter by enum membership, agentSort by ??).
    agentFilter: seed.agentFilter ?? persisted.agentFilter ?? 'all',
    setAgentFilter: (agentFilter) => set({ agentFilter }),
    agentSort: seed.agentSort ?? persisted.agentSort ?? 'manual',
    setAgentSort: (agentSort) => set({ agentSort }),
    // WARDEN-1383 (roadmap WARDEN-1204 slice 8): the new-chats spawn family,
    // ??-only — every literal below mirrors DEFAULT_UI (pinned against it by
    // uiStore.test.mjs), exactly as the App useStates they replaced seeded
    // (`uiState.X ?? <default>`). '' IS the default for the cwd/shell facts,
    // and {} / [] are the already-shaped empties for the maps and the preset
    // list — no terminalFontFamily-style truthiness exception here.
    defaultNewChatPreset: seed.defaultNewChatPreset ?? persisted.defaultNewChatPreset ?? 'claude',
    setDefaultNewChatPreset: (defaultNewChatPreset) => set({ defaultNewChatPreset }),
    defaultNewChatPresetByHost: seed.defaultNewChatPresetByHost ?? persisted.defaultNewChatPresetByHost ?? {},
    setDefaultNewChatPresetByHost: (defaultNewChatPresetByHost) => set({ defaultNewChatPresetByHost }),
    defaultNewChatHost: seed.defaultNewChatHost ?? persisted.defaultNewChatHost ?? '(local)',
    setDefaultNewChatHost: (defaultNewChatHost) => set({ defaultNewChatHost }),
    defaultNewChatCwd: seed.defaultNewChatCwd ?? persisted.defaultNewChatCwd ?? '',
    setDefaultNewChatCwd: (defaultNewChatCwd) => set({ defaultNewChatCwd }),
    defaultNewChatCwdByHost: seed.defaultNewChatCwdByHost ?? persisted.defaultNewChatCwdByHost ?? {},
    setDefaultNewChatCwdByHost: (defaultNewChatCwdByHost) => set({ defaultNewChatCwdByHost }),
    customPresets: seed.customPresets ?? persisted.customPresets ?? [],
    setCustomPresets: (customPresets) => set({ customPresets }),
    defaultShell: seed.defaultShell ?? persisted.defaultShell ?? '',
    setDefaultShell: (defaultShell) => set({ defaultShell }),
    defaultShellByHost: seed.defaultShellByHost ?? persisted.defaultShellByHost ?? {},
    setDefaultShellByHost: (defaultShellByHost) => set({ defaultShellByHost }),
    // WARDEN-1408 (roadmap WARDEN-1204 slice 11): the attention/notification
    // pair, ??-only — the literals below mirror DEFAULT_UI (pinned against it
    // by uiStore.test.mjs), exactly as the App useStates they replaced seeded
    // (`uiState.attentionDesktopAlerts ?? false` /
    // `uiState.attentionStates ?? { stuck: true, done: true }`). loadUi's own
    // sanitizers (`=== true` for the opt-in; `!== false` per state) already
    // normalize a persisted payload, so there is no terminalFontFamily-style
    // truthiness exception here either.
    attentionDesktopAlerts: seed.attentionDesktopAlerts ?? persisted.attentionDesktopAlerts ?? false,
    setAttentionDesktopAlerts: (attentionDesktopAlerts) => set({ attentionDesktopAlerts }),
    attentionStates: seed.attentionStates ?? persisted.attentionStates ?? { stuck: true, done: true },
    setAttentionStates: (attentionStates) => set({ attentionStates }),
    // WARDEN-1420 (roadmap WARDEN-1204 slice 12): the six remaining appearance
    // prefs, ??-only — every literal below mirrors DEFAULT_UI (pinned against
    // it by uiStore.test.mjs), exactly as the App useStates they replaced
    // seeded (`uiState.theme ?? 'system'`, `?? 'comfortable'`, `?? 'auto'`,
    // `?? true`, `?? 'previous'`, `?? 'auto'`). loadUi's own sanitizers already
    // normalize a persisted payload, so there is no terminalFontFamily-style
    // truthiness exception here either.
    theme: seed.theme ?? persisted.theme ?? 'system',
    setTheme: (theme) => set({ theme }),
    density: seed.density ?? persisted.density ?? 'comfortable',
    setDensity: (density) => set({ density }),
    paneLayout: seed.paneLayout ?? persisted.paneLayout ?? 'auto',
    setPaneLayout: (paneLayout) => set({ paneLayout }),
    autoFocusNewPane: seed.autoFocusNewPane ?? persisted.autoFocusNewPane ?? true,
    setAutoFocusNewPane: (autoFocusNewPane) => set({ autoFocusNewPane }),
    restoreOnStartup: seed.restoreOnStartup ?? persisted.restoreOnStartup ?? 'previous',
    setRestoreOnStartup: (restoreOnStartup) => set({ restoreOnStartup }),
    terminalColorScheme: seed.terminalColorScheme ?? persisted.terminalColorScheme ?? 'auto',
    setTerminalColorScheme: (terminalColorScheme) => set({ terminalColorScheme }),
    // WARDEN-1426 (roadmap WARDEN-1204 slice 13): the Fleet Health pair,
    // ??-only — both literals mirror DEFAULT_UI (pinned against it by
    // uiStore.test.mjs), exactly as the App useStates they replaced seeded
    // (`uiState.healthGroupBy ?? 'health'` / `uiState.healthCollapsedHosts ??
    // {}`). loadUi's own sanitizers already normalize a persisted payload (a
    // 3-way enum allow-list for the mode; parseCollapsedHosts drops non-boolean
    // entries from the map), so there is no terminalFontFamily-style truthiness
    // exception here either — and {} is the already-shaped "every host
    // expanded" identity, the same Record-shape class as hostLabels above.
    healthGroupBy: seed.healthGroupBy ?? persisted.healthGroupBy ?? 'health',
    setHealthGroupBy: (healthGroupBy) => set({ healthGroupBy }),
    healthCollapsedHosts: seed.healthCollapsedHosts ?? persisted.healthCollapsedHosts ?? {},
    setHealthCollapsedHosts: (healthCollapsedHosts) => set({ healthCollapsedHosts }),
    // WARDEN-1433 (roadmap WARDEN-1204 slice 14): the pane-ratio pair, ??-only
    // — both literals mirror DEFAULT_UI (pinned against it by
    // uiStore.test.mjs), exactly as the App useStates they replaced seeded
    // (`uiState.paneColRatios ?? []` / `uiState.paneRowRatios ?? []`).
    // loadUi's own sanitizer (parseRatioArray: a non-array payload → [], and
    // any array holding a non-positive/non-finite entry → the whole []) already
    // normalizes a persisted payload, so there is no terminalFontFamily-style
    // truthiness exception here — and [] is the already-shaped "equal split"
    // identity, the same array-shape class as watchedChats/customPresets above.
    paneColRatios: seed.paneColRatios ?? persisted.paneColRatios ?? [],
    setPaneColRatios: (paneColRatios) => set({ paneColRatios }),
    paneRowRatios: seed.paneRowRatios ?? persisted.paneRowRatios ?? [],
    setPaneRowRatios: (paneRowRatios) => set({ paneRowRatios }),
    // WARDEN-1441 (roadmap WARDEN-1204 slice 15): the Observer panel's four
    // view prefs — the first facts seeded from the SECOND storage namespace
    // (ObsUi / warden:observer:v1, `persistedObs` above), ??-only like every
    // slice before. The fallbacks are `obsDefaults` (resetObsPrefDefaults())
    // rather than re-declared literals: loadObs itself defaults viewMode to
    // 'sessions' but leaves the three filter shapes undefined when a payload
    // predates them, so the fallback pair mirrors exactly what ObserverTabs'
    // retired per-field useStates did (`obsSeed.viewMode || 'sessions'`,
    // `obsSeed.activityFilters ?? { type: 'all', … }`) with the literals now
    // owned by storage.ts. There is deliberately NO write-through: these four
    // setters write state only, and the ONE ObsUi writer stays ObserverTabs'
    // `satisfies Required<ObsUi>` saveObs effect (App's Settings-reset disk
    // write is the second sanctioned call site) — pinned by uiStore.test.mjs's
    // saveObs guard.
    observerViewMode: seed.observerViewMode ?? persistedObs.viewMode ?? obsDefaults.viewMode,
    setObserverViewMode: (observerViewMode) => set({ observerViewMode }),
    observerActivityFilters:
      seed.observerActivityFilters ?? persistedObs.activityFilters ?? obsDefaults.activityFilters,
    setObserverActivityFilters: (observerActivityFilters) => set({ observerActivityFilters }),
    observerDirectiveFilters:
      seed.observerDirectiveFilters ?? persistedObs.directiveFilters ?? obsDefaults.directiveFilters,
    setObserverDirectiveFilters: (observerDirectiveFilters) => set({ observerDirectiveFilters }),
    observerAttentionFilters:
      seed.observerAttentionFilters ?? persistedObs.attentionFilters ?? obsDefaults.attentionFilters,
    setObserverAttentionFilters: (observerAttentionFilters) => set({ observerAttentionFilters }),
  }));
}

/** The store type, so consumers/tests can name an instance. */
export type UiStore = ReturnType<typeof createUiStore>;

/**
 * The ONE app-level instance. Created at module load from the persisted
 * payload, mirroring the single `loadUi()` read App does for its own seeds.
 */
export const uiStore: UiStore = createUiStore();

/**
 * Subscribe to a slice of the app-level store.
 *
 * Always select the NARROWEST slice you need — `useUiStore((s) => s.snippets)`,
 * never the whole state object — so a component re-renders only when the fact
 * it actually reads changes.
 */
export function useUiStore<T>(selector: (state: UiStoreState) => T): T {
  return useStore(uiStore, selector);
}

// ─── Per-fact hooks ──────────────────────────────────────────────────────────
//
// Named hooks rather than raw selectors at each call site: the selector lives in
// exactly one place per fact, so every surface reading `snippets` is guaranteed
// to subscribe identically (and a future move of the fact touches one line).

/** The shared snippet library (WARDEN-323). Read-only subscription. */
export function useSnippets(): Snippet[] {
  return useUiStore((s) => s.snippets);
}

/**
 * The snippet-library setter. Stable across renders (zustand actions are created
 * once with the store), so it is safe in a dependency array.
 */
export function useSetSnippets(): (snippets: Snippet[]) => void {
  return useUiStore((s) => s.setSnippets);
}

/**
 * The File Viewer's Rendered ⇄ Source markdown toggle (WARDEN-480, WARDEN-1288).
 * Read-only subscription — FileViewer reads it here instead of receiving it
 * through four pass-through ancestors.
 */
export function useFileViewerViewMode(): 'rendered' | 'source' {
  return useUiStore((s) => s.fileViewerViewMode);
}

/**
 * The File Viewer view-mode setter. Stable across renders (zustand actions are
 * created once with the store), so it is safe in a dependency array — and its
 * plain value signature is what App's `resetSetters` entry calls.
 */
export function useSetFileViewerViewMode(): (mode: 'rendered' | 'source') => void {
  return useUiStore((s) => s.setFileViewerViewMode);
}

/**
 * The terminal font size in px (WARDEN-125, WARDEN-1322). Read by PaneTile and
 * AppearanceSection, both of which subscribe here instead of receiving it
 * through the PaneGrid pass-through (a proven-zero-use carrier).
 */
export function useTerminalFontSize(): number {
  return useUiStore((s) => s.terminalFontSize);
}

/**
 * The font-size setter. PaneTile's A−/A+ buttons and context-menu entries are
 * WRITERS of this fact, not just readers — they call the same store action
 * AppearanceSection does. Stable across renders (zustand actions are created
 * once with the store), so it is safe in a dependency array.
 */
export function useSetTerminalFontSize(): (n: number) => void {
  return useUiStore((s) => s.setTerminalFontSize);
}

/** The terminal scrollback depth (WARDEN-174, WARDEN-1322). */
export function useTerminalScrollback(): number {
  return useUiStore((s) => s.terminalScrollback);
}

/** The scrollback setter (AppearanceSection). Stable across renders. */
export function useSetTerminalScrollback(): (n: number) => void {
  return useUiStore((s) => s.setTerminalScrollback);
}

/**
 * The terminal font family (WARDEN-230, WARDEN-1322). Note the seed's
 * truthiness fallback (the `||` in createUiStore) — subscribers can rely on a
 * non-empty value the same way App's old initializer guaranteed.
 */
export function useTerminalFontFamily(): string {
  return useUiStore((s) => s.terminalFontFamily);
}

/** The font-family setter (AppearanceSection). Stable across renders. */
export function useSetTerminalFontFamily(): (v: string) => void {
  return useUiStore((s) => s.setTerminalFontFamily);
}

/** The terminal cursor style (WARDEN-241, WARDEN-1322). */
export function useTerminalCursorStyle(): TerminalCursorStyle {
  return useUiStore((s) => s.terminalCursorStyle);
}

/** The cursor-style setter (AppearanceSection). Stable across renders. */
export function useSetTerminalCursorStyle(): (v: TerminalCursorStyle) => void {
  return useUiStore((s) => s.setTerminalCursorStyle);
}

/** "Copy on select" (WARDEN-285, WARDEN-1322). */
export function useCopyOnSelect(): boolean {
  return useUiStore((s) => s.copyOnSelect);
}

/** The copy-on-select setter (AppearanceSection). Stable across renders. */
export function useSetCopyOnSelect(): (v: boolean) => void {
  return useUiStore((s) => s.setCopyOnSelect);
}

/** The "pane on agent exit" behavior (WARDEN-248, WARDEN-1322). */
export function useOnExitBehavior(): OnExitBehavior {
  return useUiStore((s) => s.onExitBehavior);
}

/** The on-exit-behavior setter (AppearanceSection). Stable across renders. */
export function useSetOnExitBehavior(): (v: OnExitBehavior) => void {
  return useUiStore((s) => s.setOnExitBehavior);
}

/**
 * The dashboard-wide Timestamp format (WARDEN-213, WARDEN-1342 — roadmap
 * WARDEN-1204 slice 4). Every timestamp-display surface subscribes here instead
 * of receiving the pref through pass-through ancestors; it is also the channel
 * that let the three `formatRelative` call sites (GitBadges ×2,
 * TelemetryTransmissionLog) stop hardcoding relative mode.
 */
export function useTimestampFormat(): TimestampFormat {
  return useUiStore((s) => s.timestampFormat);
}

/** The timestamp-format setter (AppearanceSection). Stable across renders. */
export function useSetTimestampFormat(): (v: TimestampFormat) => void {
  return useUiStore((s) => s.setTimestampFormat);
}

/**
 * Per-host display labels (WARDEN-490, roadmap WARDEN-1204 slice 6). Every
 * host-tag surface (pane tiles, sidebar rows, fleet dashboards, transcripts,
 * directive history) subscribes here instead of consuming the deleted
 * React context — this store is now the fact's ONE home.
 */
export function useHostLabels(): HostLabels {
  return useUiStore((s) => s.hostLabels);
}

/**
 * The label-map setter (HostsSection is the only writer). Stable across
 * renders (zustand actions are created once with the store), so it is safe in
 * a dependency array — and its plain value signature is what App's
 * resetSetters entry calls.
 */
export function useSetHostLabels(): (labels: HostLabels) => void {
  return useUiStore((s) => s.setHostLabels);
}

/**
 * The sidebar fleet Filter (WARDEN-442, roadmap WARDEN-1204 slice 7). The
 * three sidebar views' filter applications and their shared
 * AgentFilterSortControls popover subscribe here instead of receiving the
 * pair through App's 16 JSX pass sites — the last large prop-drilled
 * persisted pair is retired.
 */
export function useAgentFilter(): AgentFilter {
  return useUiStore((s) => s.agentFilter);
}

/**
 * The filter setter (the popover's filter Select is the only writer, and
 * App's "Reset appearance & UI preferences" calls it through the same
 * resetSetters entry). Stable across renders (zustand actions are created
 * once with the store), so it is safe in a dependency array.
 */
export function useSetAgentFilter(): (filter: AgentFilter) => void {
  return useUiStore((s) => s.setAgentFilter);
}

/**
 * The sidebar fleet Sort (WARDEN-442, roadmap WARDEN-1204 slice 7). Read by
 * sortChats on the collection and host lists (the root list deliberately
 * never sorts — WARDEN-949); the popover's sort Select subscribes to the
 * setter.
 */
export function useAgentSort(): AgentSort {
  return useUiStore((s) => s.agentSort);
}

/**
 * The sort setter (the popover's sort Select, plus the same reset path as
 * the filter). Stable across renders, so it is safe in a dependency array.
 */
export function useSetAgentSort(): (sort: AgentSort) => void {
  return useUiStore((s) => s.setAgentSort);
}

// ─── The new-chats spawn family (WARDEN-1383, roadmap WARDEN-1204 slice 8) ───
//
// NewChatForm (the reader) and NewChatsSection (the writer) subscribe here
// instead of NewChatForm's private `loadUi()` + the NewChatsPrefs bag —
// one home, one read channel. App subscribes too (keep-local-names) purely
// for the snapshot + resetSetters, as with every migrated fact. All setters
// are stable across renders (zustand actions are created once with the
// store), so they are safe in React dependency arrays.

/** The default spawn agent type ('claude' | 'shell' | a custom preset name). */
export function useDefaultNewChatPreset(): string {
  return useUiStore((s) => s.defaultNewChatPreset);
}

/** The default-spawn-preset setter (NewChatsSection; also App's resetSetters). Stable across renders. */
export function useSetDefaultNewChatPreset(): (v: string) => void {
  return useUiStore((s) => s.setDefaultNewChatPreset);
}

/** The per-host spawn agent-type override map. */
export function useDefaultNewChatPresetByHost(): Record<string, string> {
  return useUiStore((s) => s.defaultNewChatPresetByHost);
}

/** The per-host preset-map setter. Stable across renders. */
export function useSetDefaultNewChatPresetByHost(): (v: Record<string, string>) => void {
  return useUiStore((s) => s.setDefaultNewChatPresetByHost);
}

/** The host the spawn form pre-selects ('(local)' or an SSH host). */
export function useDefaultNewChatHost(): string {
  return useUiStore((s) => s.defaultNewChatHost);
}

/** The default-spawn-host setter. Stable across renders. */
export function useSetDefaultNewChatHost(): (v: string) => void {
  return useUiStore((s) => s.setDefaultNewChatHost);
}

/** The cwd pre-filled in the spawn form (blank = the host's home directory). */
export function useDefaultNewChatCwd(): string {
  return useUiStore((s) => s.defaultNewChatCwd);
}

/** The global default-cwd setter. Stable across renders. */
export function useSetDefaultNewChatCwd(): (v: string) => void {
  return useUiStore((s) => s.setDefaultNewChatCwd);
}

/** The per-host spawn cwd override map. */
export function useDefaultNewChatCwdByHost(): Record<string, string> {
  return useUiStore((s) => s.defaultNewChatCwdByHost);
}

/** The per-host cwd-map setter. Stable across renders. */
export function useSetDefaultNewChatCwdByHost(): (v: Record<string, string>) => void {
  return useUiStore((s) => s.setDefaultNewChatCwdByHost);
}

/** The user-defined quick-fill presets (named commands beyond claude/shell). */
export function useCustomPresets(): CustomPreset[] {
  return useUiStore((s) => s.customPresets);
}

/** The custom-preset list setter (NewChatsSection's CRUD is the only writer). Stable across renders. */
export function useSetCustomPresets(): (v: CustomPreset[]) => void {
  return useUiStore((s) => s.setCustomPresets);
}

/** The default shell the shell preset + App's split button open (blank = host login shell). */
export function useDefaultShell(): string {
  return useUiStore((s) => s.defaultShell);
}

/** The global default-shell setter. Stable across renders. */
export function useSetDefaultShell(): (v: string) => void {
  return useUiStore((s) => s.setDefaultShell);
}

/** The per-host default-shell override map. */
export function useDefaultShellByHost(): Record<string, string> {
  return useUiStore((s) => s.defaultShellByHost);
}

/** The per-host shell-map setter. Stable across renders. */
export function useSetDefaultShellByHost(): (v: Record<string, string>) => void {
  return useUiStore((s) => s.setDefaultShellByHost);
}

// ─── The attention/notification pair (WARDEN-1408, roadmap WARDEN-1204 slice 11) ───
//
// NotificationsSection (the writer), useAttentionRollup's three poller gates
// (the hidden-tab relaxation that keeps the WATCH ping alive while away) and
// useTokenBudget's OS-notification gate subscribe here instead of receiving
// the pair through the retired DesktopAlertPrefs bag. App subscribes too
// (keep-local-names) purely for the snapshot + resetSetters, as with every
// migrated fact. Both setters are stable across renders (zustand actions are
// created once with the store), so they are safe in React dependency arrays.

/**
 * The master OS-desktop-alerts opt-in (WARDEN-259). Since WARDEN-1274 it gates
 * exactly two live channels: the token-budget OS notification and the
 * hidden-tab poll relaxation the per-chat WATCH ping needs (see the
 * UiStoreState doc above for the full story).
 */
export function useAttentionDesktopAlerts(): boolean {
  return useUiStore((s) => s.attentionDesktopAlerts);
}

/** The desktop-alerts setter (NotificationsSection; also App's resetSetters). Stable across renders. */
export function useSetAttentionDesktopAlerts(): (v: boolean) => void {
  return useUiStore((s) => s.setAttentionDesktopAlerts);
}

/**
 * The per-state Attention badge display filters (WARDEN-344; stuck/done since
 * WARDEN-1360). Purely a DISPLAY filter on the passive readout — each state
 * defaults ON, only an explicit false silences it (mirrors
 * buildAttentionRollup's `enabledStates[k] !== false` semantics).
 */
export function useAttentionStates(): { stuck?: boolean; done?: boolean } {
  return useUiStore((s) => s.attentionStates);
}

/** The per-state-filter setter (NotificationsSection; also App's resetSetters). Stable across renders. */
export function useSetAttentionStates(): (v: { stuck?: boolean; done?: boolean }) => void {
  return useUiStore((s) => s.setAttentionStates);
}

// ─── the six remaining appearance prefs (WARDEN-1420, roadmap WARDEN-1204 slice 12) ───
//
// AppearanceSection (the writer of all six) subscribes here instead of
// destructuring them from the AppearancePrefs bag, and PaneGrid subscribes to
// `paneLayout` instead of taking it as a prop from App — so the bag shrinks to
// the three electron pairs and the App→PaneGrid pass site is gone. App
// subscribes too (keep-local-names) for its [theme]/[density] effects, the
// openChat focus gate, the terminalThemeId derivation, the persisted snapshot
// and resetSetters, as with every migrated fact. All six setters are stable
// across renders (zustand actions are created once with the store), so they are
// safe in React dependency arrays.

/**
 * The app-wide theme pref (WARDEN-1420). App's [theme] effect keys on THIS
 * VALUE (not on the setter's identity), so the OS-flip repaint chain —
 * listenSystemThemeChange → setResolvedThemeId → terminalThemeId → PaneTile —
 * is untouched by the migration.
 */
export function useTheme(): Theme {
  return useUiStore((s) => s.theme);
}

/** The theme setter (AppearanceSection; also App's resetSetters). Stable across renders. */
export function useSetTheme(): (v: Theme) => void {
  return useUiStore((s) => s.setTheme);
}

/** Row/header spacing — 'comfortable' | 'compact' (WARDEN-133, WARDEN-1420). */
export function useDensity(): Density {
  return useUiStore((s) => s.density);
}

/** The density setter (AppearanceSection; also App's resetSetters). Stable across renders. */
export function useSetDensity(): (v: Density) => void {
  return useUiStore((s) => s.setDensity);
}

/**
 * The pane-arrangement pref (WARDEN-1420). PaneGrid — the fact's only runtime
 * reader — subscribes here directly; App no longer passes it down.
 */
export function usePaneLayout(): PaneLayout {
  return useUiStore((s) => s.paneLayout);
}

/** The pane-layout setter (AppearanceSection; also App's resetSetters). Stable across renders. */
export function useSetPaneLayout(): (v: PaneLayout) => void {
  return useUiStore((s) => s.setPaneLayout);
}

/** "Auto-focus pane on open" (WARDEN-274, WARDEN-1420). Read by App's openChat. */
export function useAutoFocusNewPane(): boolean {
  return useUiStore((s) => s.autoFocusNewPane);
}

/** The auto-focus setter (AppearanceSection; also App's resetSetters). Stable across renders. */
export function useSetAutoFocusNewPane(): (v: boolean) => void {
  return useUiStore((s) => s.setAutoFocusNewPane);
}

/**
 * "Restore workspace on startup" (WARDEN-1420). The LIVE pref App hands to
 * useConfigPersistence as persistUiState's separate argument. BOOT restoration
 * reads the DISK payload before React renders, so it never consults this.
 */
export function useRestoreOnStartup(): RestoreOnStartup {
  return useUiStore((s) => s.restoreOnStartup);
}

/** The startup-restore setter (AppearanceSection; also App's resetSetters). Stable across renders. */
export function useSetRestoreOnStartup(): (v: RestoreOnStartup) => void {
  return useUiStore((s) => s.setRestoreOnStartup);
}

/**
 * The terminal color scheme (WARDEN-1420). App reads it to derive
 * `terminalThemeId` (still a computed prop to PaneGrid → PaneTile, so an OS
 * theme flip re-themes open panes live).
 */
export function useTerminalColorScheme(): TerminalColorScheme {
  return useUiStore((s) => s.terminalColorScheme);
}

/** The terminal-color-scheme setter (AppearanceSection; also App's resetSetters). Stable across renders. */
export function useSetTerminalColorScheme(): (v: TerminalColorScheme) => void {
  return useUiStore((s) => s.setTerminalColorScheme);
}

// ─── the Fleet Health pair (WARDEN-1426, roadmap WARDEN-1204 slice 13) ───
//
// HealthDashboard — the pair's ONLY reader and ONLY writer, mounted in exactly
// one place — subscribes here instead of receiving four props from App, so the
// last persisted UiState family riding a props bag into another component is
// off that channel. App subscribes too (keep-local-names) for the persisted
// snapshot and resetSetters, as with every migrated fact. Both setters are
// stable across renders (zustand actions are created once with the store), so
// they are safe in React dependency arrays.

/**
 * The Fleet Health grouping mode — Health | Host | Project (WARDEN-237,
 * WARDEN-741, WARDEN-468, WARDEN-1426). HealthDashboard's mode buttons read it
 * for their pressed state and its visible-ids derivation keys on the VALUE, so
 * flipping the mode still recomputes the grouping live.
 */
export function useHealthGroupBy(): 'health' | 'host' | 'project' {
  return useUiStore((s) => s.healthGroupBy);
}

/** The grouping-mode setter (HealthDashboard's mode buttons; also App's resetSetters). Stable across renders. */
export function useSetHealthGroupBy(): (v: 'health' | 'host' | 'project') => void {
  return useUiStore((s) => s.setHealthGroupBy);
}

/**
 * The per-host collapse map inside Host grouping (WARDEN-500, WARDEN-1426).
 * `{}` = every host expanded, the same identity App's retired `?? {}`
 * initializer guaranteed.
 */
export function useHealthCollapsedHosts(): Record<string, boolean> {
  return useUiStore((s) => s.healthCollapsedHosts);
}

/** The collapsed-hosts setter (HealthDashboard's per-host toggle; also App's resetSetters). Stable across renders. */
export function useSetHealthCollapsedHosts(): (v: Record<string, boolean>) => void {
  return useUiStore((s) => s.setHealthCollapsedHosts);
}

/**
 * The draggable resize-gutter ratios, per axis (WARDEN-660, WARDEN-1433).
 * `[]` = equal split, the same identity App's retired `?? []` initializers
 * guaranteed. PaneGrid is the pair's only reader AND only writer: it holds a
 * LOCAL working copy for the 60fps drag and commits the final arrays through
 * the set actions on pointerUp only.
 */
export function usePaneColRatios(): number[] {
  return useUiStore((s) => s.paneColRatios);
}

/** The column-ratios commit action (PaneGrid pointerUp). Stable across renders. */
export function useSetPaneColRatios(): (v: number[]) => void {
  return useUiStore((s) => s.setPaneColRatios);
}

/** The row-axis twin of usePaneColRatios. */
export function usePaneRowRatios(): number[] {
  return useUiStore((s) => s.paneRowRatios);
}

/** The row-ratios commit action (PaneGrid pointerUp). Stable across renders. */
export function useSetPaneRowRatios(): (v: number[]) => void {
  return useUiStore((s) => s.setPaneRowRatios);
}

// ─── the Observer panel's four view prefs (WARDEN-1441, roadmap WARDEN-1204 slice 15) ───
//
// ObserverTabs (the tabs' own buttons and Selects) and App (the "View Activity"
// deep-links; the Settings → Reset action) subscribe here instead of App
// commanding a child's useState through the retired one-shot prop + nonce
// channels. Persistence stays OUT of this store: the single ObsUi writer is
// ObserverTabs' `satisfies Required<ObsUi>` saveObs effect. All setters are
// stable across renders (zustand actions are created once with the store), so
// they are safe in React dependency arrays.

/** The Observer panel's visible tab ('sessions' | 'activity' | 'directives' | 'attention'). */
export function useObserverViewMode(): NonNullable<ObsUi['viewMode']> {
  return useUiStore((s) => s.observerViewMode);
}

/**
 * The Observer view-mode setter. Written by ObserverTabs' own tab buttons and
 * by App's deep-links (openActivityTab). Stable across renders — and it is the
 * property that retires the WARDEN-880 one-shot dance: App writing 'activity'
 * twice in a row is two store transitions the subscriber always sees, where
 * the prop channel needed a consume callback to make the second click fresh.
 */
export function useSetObserverViewMode(): (v: NonNullable<ObsUi['viewMode']>) => void {
  return useUiStore((s) => s.setObserverViewMode);
}

/** The Activity tab's type/agent/host filter shape. */
export function useObserverActivityFilters(): NonNullable<ObsUi['activityFilters']> {
  return useUiStore((s) => s.observerActivityFilters);
}

/** The Activity filter-shape setter (the tab's three Selects; App's reset). Stable across renders. */
export function useSetObserverActivityFilters(): (v: NonNullable<ObsUi['activityFilters']>) => void {
  return useUiStore((s) => s.setObserverActivityFilters);
}

/** The Directives tab's agent/host filter shape. */
export function useObserverDirectiveFilters(): NonNullable<ObsUi['directiveFilters']> {
  return useUiStore((s) => s.observerDirectiveFilters);
}

/** The Directives filter-shape setter (the tab's two Selects; App's reset). Stable across renders. */
export function useSetObserverDirectiveFilters(): (v: NonNullable<ObsUi['directiveFilters']>) => void {
  return useUiStore((s) => s.setObserverDirectiveFilters);
}

/** The Attention tab's agent/host filter shape. */
export function useObserverAttentionFilters(): NonNullable<ObsUi['attentionFilters']> {
  return useUiStore((s) => s.observerAttentionFilters);
}

/** The Attention filter-shape setter (the tab's two Selects; App's reset). Stable across renders. */
export function useSetObserverAttentionFilters(): (v: NonNullable<ObsUi['attentionFilters']>) => void {
  return useUiStore((s) => s.setObserverAttentionFilters);
}