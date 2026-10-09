import { useEffect, useState, useCallback, useRef } from 'react';
import { streamApi } from '@/lib/stream';
import { postJson, fetchBounded, pollerFetchOptions } from '@/lib/api';
import { mergeRecentlyClosed, type RecentlyClosedEntry } from '@/lib/storage';
import { mergeHostList } from '@/lib/hostList';
import { useWatchCatchup } from '@/lib/useWatchCatchup';
import { useTokenBudget } from '@/lib/useTokenBudget';
import { useAttentionRollup } from '@/lib/useAttentionRollup';
import { useVisiblePoller } from '@/lib/useVisiblePoller';
import { setTelemetryContext, forwardRendererError, forwardWorkspaceShape, forwardFeatureUsage, installRendererErrorCapture } from '@/lib/electron';
import { getWorkspaceShapeSampler } from '@/lib/workspaceShapeTelemetry';
import { getFeatureUsageSampler } from '@/lib/featureUsageTelemetry';
import type { Chat } from '@/lib/types';
import { paneIdOf, resumeShouldReattach, type PaneAttachPhase } from '@/lib/paneAttach';
import { normalizeIssueLinkEntries, unambiguousPrefixEntries, type IssueLinkEntry } from '@/lib/issue-links';
import { useSetObserverViewMode, usePrimePaneHost, useSetObserverCollapsed, uiStore, selectActiveWorkspace, useWorkspaces, useActiveWorkspaceId, useUpdateActiveWorkspace, useSetOpenPanes, useSetFocused, useSetMaximized, useMarkPaneActivity, useClearPaneActivity, useRevealPane, useDropRecentlyClosed, useMarkRecentlySaved, useBumpReconnectToken, useSetExternalSearchQuery, useSetGlobalSearchOpen, useSettingsOpen, useSetSettingsOpen } from '@/lib/uiStore';

// WARDEN-1144: the catalog reads below gate the sidebar's `loading` flag (the ↻
// spinner), so they are bounded by the shared deadline. They ride an interval
// poller whose period is the USER-TUNED `pollIntervalMs`, so the deadline is
// derived from that pref's FLOOR rather than its current value: the floor is the
// shortest period the pref can resolve to, so a deadline of half the floor is
// strictly shorter than EVERY period the poller can run at — the poller rule
// holds without threading a live cadence into a `useCallback([])`. The next tick
// IS the retry, so `retries: 0` applies here too.
const CATALOG_FETCH_OPTS = pollerFetchOptions(WEB_POLL_FLOOR_MS);
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ChatSidebar } from '@/components/ChatSidebar';
import { PaneGrid } from '@/components/PaneGrid';
import { WorkspaceTabs } from '@/components/WorkspaceTabs';
import { ObserverTabs } from '@/components/ObserverTabs';
import { SettingsPage } from '@/components/SettingsPage';
import { GlobalSearchHost } from '@/components/GlobalSearchHost';
import { HealthPanel } from '@/components/HealthPanel';
import { PanelToggleButtons } from '@/components/PanelToggleButtons';
import { PanelLayoutSync } from '@/components/PanelLayoutSync';
import { AppearanceSync } from '@/components/AppearanceSync';
import { AppMenuBridge } from '@/components/AppMenuBridge';
import { AttentionBadge } from '@/components/AttentionBadge';
import { ReturnBanner } from '@/components/ReturnBanner';
import { ResizableRail } from '@/components/ResizableRail';
import { WatchCatchup } from '@/components/WatchCatchup';
import { StreamStatusDot } from '@/components/StreamStatusDot';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { useNotificationPrefs } from '@/lib/useNotificationPrefs';
import { useConfigPersistence } from '@/lib/useConfigPersistence';
import { useObsPersistence } from '@/lib/useObsPersistence';
import { useConfirmTarget } from '@/lib/useConfirmTarget';
import { resolvePollIntervalMs, WEB_POLL_DEFAULT_MS, WEB_POLL_FLOOR_MS } from '@/lib/pollInterval';
import { swapPanes } from '@/lib/paneGrid';
import { telemetryChatName } from '@/lib/telemetryChatName';
import { toast } from 'sonner';

// Canonical id of this machine's own tmux host (mirrors LOCAL in src/chats.js). Local agents
// are auto-discovered on mount so their dots are live without a click; remote SSH hosts stay
// on-demand per lazy mode.
const THIS_MACHINE = '(local)';

// Apply in-flight optimistic mutations to a freshly-fetched/merged chat list so
// a background catalog refresh (/api/chats) or live discovery (/api/discover)
// can't resurrect a just-killed chat or revert a just-renamed name while that
// op's server round-trip is still pending (the disk file hasn't updated yet).
// A no-op when nothing is in flight. Pure/module-level so callers don't widen
// their useCallback dependency arrays.
function applyOptimisticGuard(list: Chat[], killed: Set<string>, renamed: Map<string, string>): Chat[] {
  if (!killed.size && !renamed.size) return list;
  return list
    .filter((c) => !killed.has(c.key || c.id))
    .map((c) => {
      const pendingName = renamed.get(c.key || c.id);
      return pendingName === undefined ? c : { ...c, name: pendingName };
    });
}

// Install the renderer's global error/unhandled-rejection listeners once, at
// module load, so non-React renderer errors (the half WARDEN-637's React
// ErrorBoundary `onError` does NOT cover) are forwarded to main's consent-gated
// telemetry source. Runs in the renderer's main world; no-ops outside the
// Electron app (no bridge). Idempotent.
installRendererErrorCapture();

function App() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [sshHosts, setSshHosts] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  // WARDEN-1420 (roadmap WARDEN-1204 slice 12) / WARDEN-1600 (slice 35): the
  // LIVE "restore on startup" pref lives on the shared store; AppearanceSection
  // and useConfigPersistence subscribe, App does NOT. The "launched in Start empty"
  // BOOT fact is derived inside useConfigPersistence (launchedEmpty(), pinned to
  // the at-launch value for the whole session), and the store's `initialWorkspace`
  // call resolves the opening workspace from the DISK payload before React renders
  // anything.
  // Multi-workspace (WARDEN-256): openPanes/focused/recentlyClosed live INSIDE
  // per-workspace pane-sets. The active workspace's panes are what render in the
  // grid; switching activeWorkspaceId swaps the grid instantly. paneHost stays
  // global (keyed by pane id). WARDEN-372 abolished the flat activeTabs/hiddenTabs
  // working set — the sidebar root is now the active workspace's openPanes + a
  // per-workspace recently-closed list. WARDEN-1526 (slice 23): the workspace
  // set — the LAST App-owned persisted fact — lives on the shared store with its
  // actions (lib/uiStore.ts); App subscribes for the render-time reads and calls
  // the store actions; read-inside-callback sites use uiStore.getState().
  const workspaces = useWorkspaces();
  const activeWorkspaceId = useActiveWorkspaceId();
  // WARDEN-1498 (slice 19): paneHost migrated onto the shared store — PaneGrid
  // subscribes directly and every writer calls the one idempotent primePaneHost
  // (keyed by PANE id: paneIdOf(chat) — see the action's doc in lib/uiStore.ts).
  const primePaneHost = usePrimePaneHost();
  // WARDEN-1422: running UNSAVED shells per discovered host — served by
  // /api/discover's `temporaryChats` and used ONLY for counts (the host view's
  // footer line + empty state). Never listed as rows; merged into PaneGrid's
  // chats so an open temp pane still resolves its label + host.
  const [tempChats, setTempChats] = useState<Chat[]>([]);
  // Ref twin for read-inside-callback sites (the close-time snapshot lookup),
  // mirroring chatsRef.
  const tempChatsRef = useRef<Chat[]>(tempChats);
  tempChatsRef.current = tempChats;
  // Per-host discovery failure reasons — the host view's "unknown, not absent"
  // unreachable state quotes these.
  const [discoverErrors, setDiscoverErrors] = useState<Record<string, string>>({});
  const chatsRef = useRef(chats);
  useEffect(() => { chatsRef.current = chats; }, [chats]);
  // The active workspace's pane-set, derived every render. Falls back to the
  // first workspace if activeWorkspaceId ever dangles (defensive — loadUi/init
  // keep it valid, but a corrupt mid-session state must still render something).
  const activeWorkspace = selectActiveWorkspace({ workspaces, activeWorkspaceId });
  const openPanes: string[] = activeWorkspace?.openPanes ?? [];
  const focused: string | null = activeWorkspace?.focused ?? null;
  // Mirrors read synchronously inside stable callbacks (performKill's rollback,
  // openChat's cross-workspace dedup) without widening their dependency arrays.
  const openPanesRef = useRef(openPanes); openPanesRef.current = openPanes;
  const focusedRef = useRef(focused); focusedRef.current = focused;

  // openPanes/focused live inside the active workspace. The store owns the
  // functional-update writers (identity-preserving, ONE set each — see
  // lib/uiStore.ts); the hooks return stable action references, so consumers
  // like closePane that list them still target the CURRENTLY active workspace.
  const updateActiveWorkspace = useUpdateActiveWorkspace();
  const setOpenPanes = useSetOpenPanes();
  const setFocused = useSetFocused();
  const setMaximized = useSetMaximized();
  const markPaneActivity = useMarkPaneActivity();
  const clearPaneActivity = useClearPaneActivity();
  const revealPane = useRevealPane();
  const dropRecentlyClosed = useDropRecentlyClosed();
  const markRecentlySaved = useMarkRecentlySaved();
  const bumpReconnectToken = useBumpReconnectToken();
  // In-flight optimistic mutations. The catalog merge in applyCatalog() would
  // otherwise re-introduce a just-killed chat or revert a just-renamed name from
  // the on-disk catalog while that op's server round-trip is still pending (the
  // disk file hasn't updated yet) — a flash-back. These let the merge defer to
  // the local optimistic state during that window; cleared once the server
  // confirms (or rolls back).
  const killedChatIdsRef = useRef<Set<string>>(new Set());
  const pendingRenamesRef = useRef<Map<string, string>>(new Map());
  // Hosts the user has engaged with (sidebar host-click / observer reconnect / resume). In
  // lazy mode only these get live SSH discovery; the auto-refresh re-discovers them so their
  // active/idle dot + last-activity advance without a manual click. /api/chats alone is
  // disk-only (active=null), so this set is what bounds the live-refresh SSH cost to visited
  // hosts rather than the whole fleet.
  const discoveredHostsRef = useRef<Set<string>>(new Set());
  // WARDEN-1441 (client-state slice 15): the Observer panel's four view prefs
  // (viewMode + the 3 per-tab filter shapes) moved onto the shared uiStore — the
  // observerViewMode/observerActivityFilters/observerDirectiveFilters/
  // observerAttentionFilters facts — so App writes them DIRECTLY here. These
  // setters replace two App→child command channels that each existed only
  // because App cannot call a component's useState setter: the one-shot
  // externalViewMode prop + its consume callback (WARDEN-880's
  // yank/dead-link pair), and the observerResetToken nonce the Settings →
  // Reset action bumped (WARDEN-981 — its full story lives in the reset
  // callback below, which still applies the ObsUi defaults through this
  // quartet). All four are zustand actions: stable identities, safe to list —
  // or omit — in dependency arrays.
  const setObserverViewMode = useSetObserverViewMode();
  // WARDEN-1568 (slice 30): the search-jump command lives on the uiStore (non-persisted);
  // App only WRITES it, PaneGrid subscribes directly.
  const setExternalSearchQuery = useSetExternalSearchQuery();
  // WARDEN-1620 (slice 37): "open global search" is a store command; the GlobalSearchHost component reads it.
  const setGlobalSearchOpen = useSetGlobalSearchOpen();
  // WARDEN-1422 (QA round 5): per-pane reconnect tokens. A saved session whose
  // pane is OPEN and stuck in session_dead must re-attach when (a) the sidebar
  // respawns its chat (respawnChat below) or (b) a resume click hits the pane
  // (openChat's already-open branch — resume means "click reconnects to the
  // live tmux session", so a dead recovery panel on screen must re-attach, not
  // just focus). PaneTile folds a CHANGE of its token into its retryNonce, so
  // the external value never widens the attach effect's deps.
  // The attach phase each open pane last reported (PaneTile's onPhaseChange).
  // A ref, not state: openChat must read it without depending on pane state,
  // and a phase change never re-renders the app — it only keeps this map
  // honest for the next resume click.
  const panePhaseRef = useRef<Record<string, PaneAttachPhase>>({});
  const handlePanePhaseChange = useCallback((id: string, phase: PaneAttachPhase) => {
    panePhaseRef.current[id] = phase;
  }, []);

  // WARDEN-1510 (roadmap WARDEN-1204 slice 21) / WARDEN-1645 (slice 42): the three
  // panel-collapse flags live on the shared store (lib/uiStore.ts) and App no longer
  // subscribes to them — <PanelLayoutSync/> (always mounted) owns the expand ticks,
  // resize listener and re-clamp; <PanelToggleButtons/> and <HealthPanel/> read the
  // flags themselves. PaneGrid's Alt+S/Alt+O call the toggle actions directly.
  // Persistence rides useConfigPersistence's snapshot (all 41 store facts). App keeps
  // only the call-time write below (openActivityTab).
  const setObserverCollapsed = useSetObserverCollapsed();
  // WARDEN-431 / WARDEN-1422: the Source Control section collapse migrated onto
  // the shared store (lib/uiStore.ts, roadmap WARDEN-1204 slice 18, WARDEN-1486)
  // — ChatSidebar is its only reader and writer and subscribes directly, so App
  // carries no state, prop pair, or snapshot entry for it (persistence rides the
  // store half of the snapshot via useConfigPersistence).
  // WARDEN-1420 (roadmap WARDEN-1204 slice 12): theme/density/paneLayout/
  // autoFocusNewPane/restoreOnStartup/terminalColorScheme migrated onto the
  // shared store (lib/uiStore.ts) — AppearanceSection subscribes (it is the
  // only writer of all six) and PaneGrid subscribes to paneLayout; App
  // subscribes for the openChat focus gate plus the reset partition.
  // WARDEN-1659 (slice 44): theme/density/setResolvedThemeId are no longer
  // subscribed here either — the always-mounted null-rendering <AppearanceSync/>
  // hosts the [theme]/[density] apply effects (and the OS-flip listener that
  // pushes the resolved concrete theme id into the store; PaneTile subscribes to
  // useTerminalThemeId() directly), so a theme/density change re-renders only
  // that component, not all of App. Since slice 16 (WARDEN-1471) the persisted
  // snapshot is NOT an App-side reason any more: useConfigPersistence reads the
  // store half.
  // paneLayout (WARDEN-1471, slice 16): App keeps only the SETTER — the reset
  // partition needs it; the value rides useConfigPersistence's single store
  // subscription into the same saveUi effect (PaneGrid subscribes to the
  // store directly for its own reads).
  // Draggable resize-gutter ratios (WARDEN-660): per-axis PaneGrid track
  // weights ([] = equal split, the default). Pure client-side pref (like
  // paneLayout/terminalFontSize): persisted by the saveUi effect below, never
  // sent to the backend. PaneGrid holds a LOCAL working copy so a drag re-
  // templates the grid at 60fps without a localStorage write per pointermove;
  // it commits the final ratios up through the store actions on pointerUp only.
  //
  // WARDEN-1433 (roadmap WARDEN-1204 slice 14) — migrated onto the shared
  // uiStore with the other panel prefs: PaneGrid is the pair's only reader AND
  // only writer, so it subscribes to the store directly and the four JSX pass
  // sites + four Props entries are gone. WARDEN-1471 (slice 16) then removed
  // even App's value subscriptions: the store half of the persisted snapshot
  // is read by useConfigPersistence, so App no longer needs the values to
  // re-render the saveUi effect — and the setters were already gone (the
  // ratios are NOT resettable: both keys sit in RESET_PRESERVED_KEYS —
  // WARDEN-934: "they are panel layout, which the shipped button promises to
  // keep" — so no reset entry ever needed them, and an unused local
  // would only fail noUnusedLocals).

  // "Pane on agent exit" behavior: what an already-open pane does when its agent
  // process exits (chat.active goes true→false). 'keep' (default) is today's exact
  // behavior (dead terminal left for manual close); 'dim' marks it exited while
  // keeping the last output readable; 'auto-close' removes it via closePane once.
  // See WARDEN-248.
  //
  // WARDEN-1322 (roadmap WARDEN-1204 slice 3) — this is the first of SIX App
  // useStates migrated off App-owned useState + prop-drilling onto the shared
  // client-state store (lib/uiStore.ts), following `snippets` and
  // `fileViewerViewMode`: onExitBehavior, terminalFontSize, terminalScrollback,
  // terminalFontFamily, terminalCursorStyle, copyOnSelect. Their readers are
  // PaneTile (which also WRITES font size via its A−/A+ buttons and context
  // menu) and AppearanceSection, both of which now SUBSCRIBE directly — so the
  // seven terminal-config props PaneGrid carried to PaneTile without ever
  // reading them are gone entirely.
  //
  // App-side reads: this slice-3 comment recorded the two reasons every
  // migrated fact kept an App subscription — the persisted snapshot and the
  // reset partition. WARDEN-1471 (slice 16) retired the FIRST reason for all
  // 41 store facts: the snapshot is subscribed once inside
  // useConfigPersistence (useShallow(selectPersistedStorePrefs)), so App keeps
  // only the setters the reset partition needs. The write path is unchanged
  // end to end: store.setX → that subscription re-renders App → the merged
  // snapshot's field changes → the saveUi effect fires → persistUiState →
  // localStorage. The store seeds itself from loadUi() at module load, the
  // same persisted read the useState lazy initializers did.
  // "Auto-focus new pane": whether opening/resuming/splitting a chat moves
  // keyboard focus to the new pane (default true = today's behavior). When false
  // the currently focused pane is preserved — xterm's native click-to-focus lets
  // the user focus a pane on demand. Pure client-side pref (like
  // onExitBehavior/paneLayout): persisted by the saveUi effect below, never sent
  // to the backend. Gates the setFocused call in openChat below. See WARDEN-274.
  //
  // WARDEN-1420 (slice 12): migrated onto the shared store with the rest of the
  // appearance family (see theme above). WARDEN-1600 (slice 35): App no longer
  // subscribes — openChat reads it at call time via uiStore.getState().
  // WARDEN-1322 (slice 3): migrated onto the shared store (see onExitBehavior
  // above) — PaneTile and AppearanceSection subscribe. Since WARDEN-1471
  // (slice 16) App keeps only the SETTER (the reset partition); the value
  // rides the hook's store subscription.
  // WARDEN-1408 (roadmap WARDEN-1204 slice 11): the attention/notification pair
  // migrated onto the shared store (see onExitBehavior above) — NotificationsSection
  // (the writer), useAttentionRollup's three poller gates and useTokenBudget's
  // OS-notification gate subscribe to it directly, and the DesktopAlertPrefs
  // Settings bag is retired. Since WARDEN-1471 (slice 16) App keeps only the
  // SETTERS (the reset partition); the values ride the hook's store
  // subscription. The WARDEN-1274 "what the master toggle still gates"
  // note moved with the fact (see UiStoreState in lib/uiStore.ts).
  // Per-state Attention toggle (WARDEN-344): which pane states raise the badge.
  // Each defaults ON; persisted by the saveUi effect below and forwarded to the
  // AttentionBadge's useAttentionRollup. Purely a DISPLAY filter on the passive
  // readout since WARDEN-1274 retired the alert. WARDEN-1360: only the states the
  // passive readout can substantiate remain (stuck / done) — erroring / waiting /
  // blocked were substring guesses and their buckets (and knobs) are gone.
  // WARDEN-1506 (slice 20): the per-chat watch set lives on the shared store
  // (persisted via STORE_PERSISTED_KEYS, read by useAttentionRollup directly).
  // App keeps only the SETTER, for Settings → Reset.
  // WARDEN-1322 (slice 3): migrated onto the shared store (see onExitBehavior
  // above). Since WARDEN-1471 (slice 16) App keeps only the SETTER; the value
  // rides the hook's store subscription.
  // WARDEN-1322 (slice 3): migrated onto the shared store (see onExitBehavior
  // above). The store seed preserves the truthiness fallback below VERBATIM —
  // DEFAULT_UI.terminalFontFamily is '' (blank = default stack) and a persisted
  // '' must seed the real stack, never '' (a `??`-only seed would let '' reach
  // xterm and blank a pane). The reset deviation documented at
  // resetUiPrefDefaults (this pref resets to DEFAULT_TERMINAL_FONT_FAMILY, not
  // to DEFAULT_UI's '') lives there and is untouched. Since WARDEN-1471
  // (slice 16) App keeps only the SETTER; the value rides the hook's store
  // subscription.
  // Terminal color scheme: 'auto' follows the effective app theme (above);
  // 'dark'/'light' force the terminal surface. Pure client-side pref (like
  // terminalFontSize/scrollback): persisted by the saveUi effect below, never
  // sent to the backend.
  //
  // WARDEN-1420 (slice 12): migrated onto the shared store with the rest of the
  // appearance family (see theme above). App is no longer a RUNTIME reader —
  // it does not read it at all (WARDEN-1574, slice 31): the derived terminal
  // theme id is a store selector PaneTile subscribes to, so only the setter
  // stays here for the reset partition.
  // Terminal cursor style (shape × blink). 'blink-block' is the default (today's
  // exact cursor).
  //
  // WARDEN-1322 (slice 3): migrated onto the shared store (see onExitBehavior
  // above). Since WARDEN-1471 (slice 16) App keeps only the SETTER; the value
  // rides the hook's store subscription.
  // "Copy on select" (WARDEN-285): when ON, completing a text selection in any
  // agent pane copies it to the clipboard immediately (no Ctrl/Cmd+C). Default
  // OFF = today's exact behavior. Applies LIVE to all open panes (PaneTile
  // mirrors it into a ref its selection handler reads).
  //
  // WARDEN-1322 (slice 3): migrated onto the shared store (see onExitBehavior
  // above). Since WARDEN-1471 (slice 16) App keeps only the SETTER; the value
  // rides the hook's store subscription.
  // Timestamp format (WARDEN-213): how every timestamp surface reads — 'relative'
  // (default = "2m"/"3h" buckets) or 'absolute' (clock time). Pure client-side
  // pref (like copyOnSelect/density): persisted by the saveUi effect below,
  // threaded to every timestamp display via the shared formatTimestamp helper,
  // and never sent to the backend.
  // WARDEN-1342 (slice 4): the pref lives on the shared uiStore — same plain-value
  // signatures, so the reset is untouched (the slice-3
  // pattern). Since WARDEN-1471 (slice 16) App keeps only the SETTER; the value
  // rides the hook's store subscription.
  // WARDEN-468: HealthDashboard "Group agents by: Health | Host | Project" toggle
  // (WARDEN-237; Project added in WARDEN-741). Was a HealthDashboard-local
  // useState that silently reset to 'health' on every Warden restart. Lifted to
  // App + persisted by the saveUi effect (the single writer), like
  // the other persisted prefs — so a cross-host human's Host grouping
  // survives reload. Pure client-side pref.
  //
  // WARDEN-1426 (roadmap WARDEN-1204 slice 13) — migrated onto the shared
  // uiStore together with healthCollapsedHosts below. HealthDashboard is the
  // pair's ONLY reader and ONLY writer and is mounted in exactly one place, so
  // it SUBSCRIBES directly and the four JSX pass sites into it are gone.
  // WARDEN-1471 (slice 16): App keeps only the SETTER (the reset partition);
  // the value rides the hook's store subscription. The store seeds itself from
  // loadUi() with the same 'health' default DEFAULT_UI has, through loadUi's
  // own 3-way enum allow-list.
  // File Viewer markdown view mode (WARDEN-480): 'rendered' (default = docs/
  // README reading) or 'source' (raw markdown). One global remembered choice,
  // surfaced only through the existing in-dialog toggle. Pure client-side pref;
  // never sent to the backend.
  //
  // WARDEN-1288 — the SECOND fact migrated off App-owned useState + prop-drilling
  // onto the shared client-state store (lib/uiStore.ts), following `snippets`
  // above. Its one reader and one writer are both FileViewer, which now
  // SUBSCRIBES directly, so the four PURE pass-through carriers between App and
  // it (ChatSidebar, PaneGrid, HealthDashboard, PaneTile) no longer carry it.
  //
  // WARDEN-1471 (slice 16): App keeps only the SETTER (the reset partition);
  // the value rides the hook's store subscription. The write path is unchanged
  // end to end: store.setFileViewerViewMode → that subscription re-renders
  // App → the merged snapshot's `fileViewerViewMode` changes → the saveUi
  // effect fires → persistUiState → localStorage. The store seeds itself from
  // loadUi() at module load, the same persisted read the useState lazy
  // initializer did.
  // WARDEN-490 — per-host display labels (friendly names). A raw host string
  // ('(local)' / SSH host) → the human's label, shown in every host-tag display
  // surface. Migrated onto the shared uiStore (roadmap WARDEN-1204 slice 6);
  // App does NOT subscribe (slice 45, WARDEN-1665): the readers and the
  // HostsSection writer subscribe at lib/uiStore directly, and useTokenBudget
  // reads uiStore.getState().hostLabels at alarm time, so a label edit no
  // longer re-renders App. Pure client-side pref, persisted by the store.
  // WARDEN-500: the per-host expand/collapse state INSIDE Health's Host grouping.
  // Was a HealthDashboard-local useState that reset to {} on every restart — so
  // the durable grouping choice (WARDEN-468) survived reload but the collapsed
  // hosts beneath it did not. Lifted to App + persisted by the saveUi effect (the
  // single writer), exactly like healthGroupBy above — so a cross-host human's
  // collapsed hosts survive reload. Pure client-side pref; default {} = every
  // host expanded.
  //
  // WARDEN-1426 (roadmap WARDEN-1204 slice 13) — migrated onto the shared
  // uiStore with healthGroupBy above, on the same terms: HealthDashboard
  // subscribes directly, and the store's `?? {}` seed reproduces the retired
  // initializer's fallback. WARDEN-1471 (slice 16): App keeps only the SETTER
  // (the reset partition); the value rides the hook's store subscription.
  // Default agent type + host pre-filled in the ＋ new chat form, plus the
  // user-defined custom presets (named quick-fill commands beyond claude/shell).
  // All pure client-side prefs (like density/terminalFontSize): persisted by the
  // saveUi effect below, never sent to the backend. defaultNewChatPreset is a
  // reserved built-in name ('claude' | 'shell') or a custom preset name.
  //
  // WARDEN-1383 (roadmap WARDEN-1204 slice 8) — the LAST facts migrated off
  // App-owned useState + a second read channel onto the shared client-state
  // store (lib/uiStore.ts), following `snippets` through `hostLabels`: the
  // eight new-chats spawn facts (preset + per-host map, host, cwd + per-host
  // map, customPresets, shell + per-host map). NewChatForm (the reader) used
  // to do a PRIVATE `useState(() => loadUi())` here while NewChatsSection
  // (the writer) received the same facts through the NewChatsPrefs bag —
  // one value, two channels. Both now SUBSCRIBE directly, the bag interface
  // is retired, and uiStore.test.mjs's guard keeps `loadUi(` out of
  // web/src/components/ so the invariant is enforced, not remembered.
  //
  // WARDEN-1471 (slice 16): App keeps only the SETTERS (the reset partition);
  // the values ride useConfigPersistence's single store subscription into the
  // same saveUi effect: store.setX → that subscription re-renders App → the
  // merged snapshot's field changes → the effect fires → persistUiState →
  // localStorage. The store seeds itself from loadUi() at module load, the same
  // persisted read the useState lazy initializers did.
  // Saved instruction snippets (WARDEN-323): a named, reusable intervention
  // library surfaced at the Broadcast dialog (insert-only) and a focused pane's
  // context menu (one-click send). Pure client-side localStorage pref like the
  // spawn presets above: persisted by the saveUi effect below, never sent to the
  // backend as anything but the literal `text` over the existing /api/send path.
  // Seeded once with STARTER_SNIPPETS by loadUi when the field is absent.
  //
  // WARDEN-1271 — the first fact migrated off App-owned useState + prop-drilling
  // onto the shared client-state store (lib/uiStore.ts; the WARDEN-832 row-2
  // instrument). The reading surfaces (pane context menu, broadcast picker,
  // watch-catchup quick reply, Settings CRUD) now SUBSCRIBE to the store
  // directly instead of receiving this list through their ancestors, so the
  // pure pass-through hops between App and each of them are gone.
  //
  // App still subscribed, for exactly two reasons — both of them the
  // single-writer persistence design — until WARDEN-1471 (slice 16) retired
  // the first: the value used to be subscribed and listed in the snapshot so
  // the ONE compile-locked saveUi effect kept writing it; the snapshot's store
  // half is now subscribed ONCE inside useConfigPersistence
  // (useShallow(selectPersistedStorePrefs)), so App keeps only the setter the
  // reset partition needs. The write path is unchanged end to end:
  // store.setSnippets → that subscription re-renders App → the merged
  // snapshot's `snippets` changes identity → the saveUi effect fires →
  // persistUiState → localStorage. The store seeds itself from loadUi() at
  // module load, which is the same persisted read the useState lazy
  // initializer did.
  // Default shell opened by BOTH the ＋ new-chat *shell* preset and the ＋ split
  // button (WARDEN-429 — unifies the prior split-only defaultSplitShell, migrated
  // into defaultShell on load). Blank means "no explicit shell" → the host
  // launches its own login shell. Pure client-side pref (like the new-chat prefs
  // above): persisted by the saveUi effect below, never sent to the backend.
  // Store-backed since WARDEN-1383 (slice 8) like the rest of the spawn family.
  // WARDEN-1600 (slice 35): App does not subscribe — spawnShell reads it at call
  // time via uiStore.getState(), so a Settings toggle never re-renders App.
  // Per-host default-shell overrides (WARDEN-429 — mirrors the cwd/preset maps
  // above). Keys are host strings ('(local)' / SSH host name); a host with no
  // entry (or an empty value, dropped on load) falls through to defaultShell,
  // then blank (host login shell). Pure client-side pref like defaultShell
  // above: persisted by the saveUi effect below, never sent to the backend.
  // (call-time read in spawnShell too, WARDEN-1600.)
  const { prefs, reload: reloadNotificationPrefs } = useNotificationPrefs();
  // "Confirm before destructive actions" preference (default on). Gates both
  // destructive kill paths — force-kill (tmux session) and kill chat. Loaded
  // from /api/config on mount and refreshed after Settings saves. Declared up
  // here because the shared destructive-confirm gate predicate below (feeding
  // the force-kill / kill-chat useConfirmTarget machines) reads it via its
  // dependency array.
  const [confirmDestructiveActions, setConfirmDestructiveActions] = useState(true);
  // WARDEN-332 — the two observer lifecycle preferences (auto-start + session
  // auto-stop). Initialized to the config.js defaults (false / 30) and refreshed
  // from /api/config below; passed to ObserverTabs so a Settings save applies
  // without a reload. observerSessionTimeout may be null (user cleared the field)
  // → disabled (never auto-close).
  const [observerAutoStart, setObserverAutoStart] = useState(false);
  const [observerSessionTimeout, setObserverSessionTimeout] = useState<number | null>(30);
  // WARDEN-394 — the dashboard auto-refresh cadence, resolved from the persisted
  // pollIntervalMs pref. Initialized to the 60s web default and refreshed from
  // /api/config below (after Settings saves) so a changed "Poll Interval" takes
  // effect immediately without a reload. The stored value is ALWAYS already
  // web-safe (resolvePollIntervalMs runs at read time), so the two poll effects
  // below consume it directly — a stale CLI default (1500) or sub-floor value
  // can never reach setInterval and flood SSH.
  const [pollIntervalMs, setPollIntervalMs] = useState<number>(WEB_POLL_DEFAULT_MS);
  // WARDEN-882 — whether the companion transport is enabled (the per-host
  // Go-binary transport, default on since WARDEN-1379). Read from /api/config
  // on mount and after Settings saves, then threaded into Fleet Health so the
  // per-host "Remove companion" action appears ONLY when the transport is on
  // (the same gate every companion surface uses). The companion can be removed
  // even after the flag is turned off, but the affordance is shown only while
  // it's on — matching the WARDEN-878 companion-state chip's future gating.
  const [companionTransportEnabled, setCompanionTransportEnabled] = useState(true);

  useEffect(() => {
    streamApi.onAnyMessage = (m) => {
      if (m.type === 'pty' && m.id !== focusedRef.current) {
        markPaneActivity(m.id);
      }
    };
    streamApi.connect();
    refresh();
    refreshConfigPrefs();

    // Store close timestamp on unmount. try/warn per the WARDEN-89 persistence
    // convention (storage.ts:18-20): a quota/SecurityError here must never
    // escape — this function is BOTH the beforeunload listener (page teardown)
    // and the last statement of the effect cleanup (React does not isolate
    // destroy-function exceptions). watchCatchup.ts:31 asserts this write
    // "console.warn[s] on quota, never throws" — keep that true.
    const handleBeforeUnload = () => {
      try {
        localStorage.setItem('warden:lastClose', String(Date.now()));
      } catch (e) {
        console.warn('[warden:app] saveLastClose failed', e);
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      streamApi.onAnyMessage = null;
      window.removeEventListener('beforeunload', handleBeforeUnload);
      handleBeforeUnload();
    };
  }, []);

  // clear "new" badge when a pane becomes focused
  useEffect(() => {
    if (focused) clearPaneActivity(focused);
  }, [focused]);

  // Refresh the chat list from the disk catalog (/api/chats, zero SSH in lazy mode). `silent`
  // skips the loading toggle so background auto-refresh ticks don't flash the ↻ button. In
  // lazy mode /api/chats returns disk-only chats (active=null), so we MERGE instead of
  // replacing: for hosts already discovered live we restore their last-known
  // active/lastActivity/status (and keep live-only chats — yatfa containers / external
  // spawns — that aren't in the catalog). A catalog refresh therefore never wipes green/red
  // dots back to "unknown". Live data itself is advanced by refreshDiscoveredHosts().
  const applyCatalog = useCallback(async (silent: boolean) => {
    if (!silent) setLoading(true);
    // WARDEN-1202: /api/ssh-hosts returns BOTH ~/.ssh/config aliases (`hosts`) and
    // the real configured fleet (`configured` = cfg.hosts). Reading only `hosts`
    // dropped every host added by typing its name in Settings (WARDEN-940), so it
    // got no sidebar row and no Open Chat scope chip. mergeHostList unions them,
    // de-duplicated and with '(local)' filtered (consumers prepend THIS_MACHINE).
    fetchBounded('/api/ssh-hosts', CATALOG_FETCH_OPTS).then((r) => r.json()).then((j) => setSshHosts(mergeHostList(j))).catch((error) => console.error('[ssh-hosts] Failed:', error));
    try {
      const cr = await fetchBounded('/api/chats', CATALOG_FETCH_OPTS);
      const diskChats: Chat[] = (await cr.json()).chats || [];
      setChats((prev) => {
        const discovered = discoveredHostsRef.current;
        let base: Chat[];
        if (!discovered.size) {
          base = diskChats;
        } else {
          const liveById = new Map<string, Chat>();
          for (const c of prev) if (discovered.has(c.host)) liveById.set(c.id, c);
          const diskIds = new Set(diskChats.map((c) => c.id));
          const merged = diskChats.map((c) => {
            const live = liveById.get(c.id);
            return live ? { ...c, active: live.active, lastActivity: live.lastActivity, status: live.status } : c;
          });
          const extraLive = [...liveById.values()].filter((c) => !diskIds.has(c.id));
          base = [...merged, ...extraLive];
        }
        // Respect in-flight optimistic mutations so a background catalog refresh
        // can't resurrect a just-killed chat or revert a just-renamed one while
        // its server round-trip is still pending (the disk file hasn't updated).
        return applyOptimisticGuard(base, killedChatIdsRef.current, pendingRenamesRef.current);
      });
    } catch (e) { console.error(e); }
    if (!silent) setLoading(false);
  }, []);

  const refresh = useCallback(async () => { await applyCatalog(false); }, [applyCatalog]);

  // Refresh backend-backed preferences from /api/config (display customization
  // + the "Confirm before destructive actions" safety toggle). Called on mount
  // and after Settings saves, so toggles take effect immediately without a reload.
  const refreshConfigPrefs = useCallback(async () => {
    try {
      const cfg = await fetch('/api/config').then((r) => r.json());
      setDisplaySettings({
        showHostTags: cfg.showHostTags ?? true,
        showTypeBadges: cfg.showTypeBadges ?? true,
        showStatusIndicators: cfg.showStatusIndicators ?? true,
        showProjectBadges: cfg.showProjectBadges ?? false,
        hideOfflineHosts: cfg.hideOfflineHosts ?? false,
        // WARDEN-1388: issue-key link integration (server config, off by
        // default — `=== true` keeps a missing/absent field OFF, the same
        // strict reading the server's boolean default encodes).
        issueLinksEnabled: cfg.issueLinksEnabled === true,
      });
      // WARDEN-1388: the tracker mapping is its own state (an array of
      // structured entries, not a boolean display flag — see the state comment
      // above), defensively re-normalized so a hand-edited config.json can't
      // hand the matcher a malformed mapping (GET is a raw arrayOrEmpty
      // passthrough; only PUT is sanitized server-side).
      setIssueLinkTrackers(normalizeIssueLinkEntries(cfg.issueLinkTrackers));
      setConfirmDestructiveActions(cfg.confirmDestructiveActions ?? true);
      // WARDEN-332 — observer lifecycle prefs. observerSessionTimeout is null OR
      // a finite positive number (server.js:373-376); `?? null` preserves an
      // explicit null (disabled) and coalesces an absent field to null (fail-safe
      // — never auto-close when the value is unknown). A fresh install returns 30.
      setObserverAutoStart(cfg.observerAutoStart ?? false);
      setObserverSessionTimeout(cfg.observerSessionTimeout ?? null);
      // WARDEN-394 — resolve the persisted pollIntervalMs to a web-safe cadence.
      // cfg.pollIntervalMs defaults to 1500 (config.js CLI watch cadence); that,
      // any non-number/absent/sub-floor value, and anything over the ceiling all
      // land on the 60s web default (resolvePollIntervalMs). The resolved value
      // feeds both dashboard poll effects so the pref actually governs refresh.
      setPollIntervalMs(resolvePollIntervalMs(cfg.pollIntervalMs));
      // WARDEN-882 — companion transport toggle drives the Fleet Health
      // per-host "Remove companion" affordance's visibility.
      setCompanionTransportEnabled(cfg.companionTransportEnabled ?? true);
    } catch (e) {
      console.error('Failed to refresh config preferences:', e);
    }
  }, []);

  // Persist the live pref snapshot to disk (honoring "Restore workspace on
  // startup") and expose handleConfigChange — the post-Settings orchestration
  // that reloads chats/ssh-hosts, re-broadcasts notification prefs, and refreshes
  // backend config prefs so toggles take effect without a page reload. The saveUi
  // WRITE effect + this callback live in useConfigPersistence (WARDEN-696);
  // since WARDEN-1471 (slice 16) the hook reads the store facts itself and, since
  // WARDEN-1526 (slice 23) moved the last App-owned fact (the workspace set), the
  // WHOLE persisted snapshot — App assembles and passes none of it. This call sits AFTER
  // refresh/refreshConfigPrefs/reloadNotificationPrefs are defined so the deps
  // are initialized (no TDZ).
  const { handleConfigChange } = useConfigPersistence({
    refresh,
    reloadNotificationPrefs,
    refreshConfigPrefs,
  });

  // WARDEN-1477 (client-state slice 17): the Observer's four view prefs are
  // store facts, but their only disk writer rode ObserverTabs' booted-gated
  // effect — so a store write made with the panel unmounted (App's own "View
  // Activity" deep-links render outside the Settings ternary) or mounted-but-
  // unbooted (the boot create-failure branch never sets `booted`) was lost on
  // restart. This hook is the always-mounted ObsUi writer: persistence is a
  // property of the store, exactly as useConfigPersistence made it for the
  // warden:ui:v3 half in slice 16. It persists the four prefs through
  // saveObs merging { ...loadObs(), … } — the second namespace, merged over the disk
  // document so the component half (openIds/activeId) is never clobbered.
  useObsPersistence();

  // Discover one host on demand (lazy mode): fetch live chats for that host and replace
  // its entries in the chats list so dots update to green/red.
  // WARDEN-1422: the response also carries `temporaryChats` — the host's running
  // UNSAVED shells. They are never listed; the sidebar reads only their COUNT
  // (the host view's footer line + empty state). A failed discover records the
  // reason in `discoverErrors` so the host view can say "unknown, not absent".
  const discoverHost = useCallback(async (host: string) => {
    discoveredHostsRef.current.add(host);
    try {
      const r = await fetchBounded(`/api/discover?host=${encodeURIComponent(host)}`, CATALOG_FETCH_OPTS);
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      if (Array.isArray(j.chats)) {
        setChats((prev) => applyOptimisticGuard([...prev.filter((c) => c.host !== host), ...j.chats] as Chat[], killedChatIdsRef.current, pendingRenamesRef.current));
      }
      setTempChats((prev) => [...prev.filter((c) => c.host !== host), ...(Array.isArray(j.temporaryChats) ? (j.temporaryChats as Chat[]) : [])]);
      setDiscoverErrors((prev) => (prev[host] ? { ...prev, [host]: undefined } as Record<string, string> : prev));
    } catch (e) {
      console.error('discoverHost failed:', e);
      const message = e instanceof Error ? e.message : 'discovery failed';
      setDiscoverErrors((prev) => ({ ...prev, [host]: message }));
      throw e;
    }
  }, []);

  // Re-discover every host the user has engaged with, concurrently. This is what keeps
  // active/idle dots + last-activity live: /api/discover is the only source of live status in
  // lazy mode (/api/chats is disk-only). Bounded to visited hosts — not the whole fleet — so
  // SSH cost tracks user engagement, and only invoked while the tab is visible (see the
  // auto-refresh effect below).
  const refreshDiscoveredHosts = useCallback(async () => {
    const hosts = [...discoveredHostsRef.current];
    if (!hosts.length) return;
    await Promise.all(hosts.map((h) => discoverHost(h).catch(() => {})));
  }, [discoverHost]);

  // Auto-refresh the agent list so active/idle dots + last-activity stay live in the sidebar
  // without a manual refresh. Lazy mode serves /api/chats from disk only (active=null); live
  // status comes from /api/discover, which the client normally runs just on host-click. So
  // each visible tick silently re-pulls the catalog AND re-discovers every host the user has
  // already engaged with — that is what advances dots/timestamps and surfaces external spawns.
  // Ticks are gated on Page Visibility so a backgrounded tab never burns SSH; on regaining
  // focus we refresh immediately because state may be stale while hidden.
  const poll = async () => {
    await applyCatalog(true);
    void refreshDiscoveredHosts();
  };
  // mountPoll:false preserves this poll's historical behavior exactly: it had NO
  // unconditional mount-poll (it self-gated via an early return and was interval-
  // only). The hook now owns the visibility gate + the focus-refresh, so poll no
  // longer self-gates. (WARDEN-753 Finding #2.)
  useVisiblePoller(poll, pollIntervalMs, [applyCatalog, refreshDiscoveredHosts, pollIntervalMs], {
    mountPoll: false,
  });

  // Discover this machine's own agents once on mount. Local discovery is cheap (no SSH) and is
  // the common case, so local agents show live immediately and the auto-refresh above keeps
  // them live — no host-click required. Remote hosts remain on-demand per lazy mode.
  useEffect(() => {
    void discoverHost(THIS_MACHINE).catch(() => {});
  }, [discoverHost]);

  // open chat: open pane + focus. The dedup point for the multi-workspace model
  // (WARDEN-256): a pane lives in at most one workspace, so if `id` is already a
  // pane in some workspace we switch there + focus it instead of duplicating it
  // in the active workspace. The focus calls are gated behind autoFocusNewPane
  // (WARDEN-274): when OFF, the pane still opens but the currently focused pane is
  // preserved (click-to-focus still works via xterm's native focus).
  // autoFocusNewPane is a CALL-TIME read (uiStore.getState(), WARDEN-1600 slice
  // 35): App never subscribes, so toggling it neither re-renders App nor rebuilds
  // this callback — the next open simply honors the current value.
  //
  // WARDEN-417: openChat is the single chokepoint every "open a chat" path funnels
  // through (sidebar, OS-watch-toast click, search, observer suggestion, catch-up
  // row, reconnect), so acking the watch catch-up HERE means a watched chat opened
  // via ANY path clears its recorded misses and can never re-surface as stale noise.
  // A ref breaks the define-order cycle: openChat is defined before useWatchCatchup
  // provides ackKey below, so openChat calls through a stable ref that the hook
  // fills in once it mounts. Defaults to a no-op so an open before that point is safe.
  const ackWatchMissRef = useRef<(key: string) => void>(() => {});
  const openChat = useCallback((id: string, anchor?: string) => {
    // WARDEN-417: ack-on-open — clear any catch-up miss for this chat first, so a
    // ping the human is acting on (by opening the chat) is acknowledged regardless of
    // which open path they used. No-op when there is nothing to ack (ackKey short-
    // circuits), so non-watched chats pay only a cheap log scan.
    ackWatchMissRef.current(id);
    // remember this pane's host so a restored remote pane knows which host to discover
    const c = chatsRef.current.find((x) => (x.key || x.id) === id);
    if (c?.host) primePaneHost(id, c.host);
    // WARDEN-877: when an attention surface handed an anchor, position the pane's
    // scrollback at the triggering line by reusing the SAME externalSearchQuery→findNext
    // mechanism global search uses (PaneTile's 100ms-settle effect opens the in-pane
    // search bar + runs findNext, so a wrong occurrence is one ↑/↓ away). Fires here —
    // BEFORE the owner early-return below — so it runs in BOTH branches: a pane already
    // open in another workspace still scrolls to the line, exactly as a newly-opened one
    // does. A no-anchor openChat(id) is byte-for-bit today's focus-only behavior (the
    // guard skips the setState entirely; React batches it with the workspace/focus sets
    // below into one render, so placement here is equivalent to firing it in both paths).
    if (anchor) setExternalSearchQuery({ paneId: id, query: anchor });
    // Search EVERY workspace for an existing pane with this id. If it's already
    // open elsewhere, switch to that workspace + focus it (no duplicate pane).
    const { workspaces: allWorkspaces, autoFocusNewPane } = uiStore.getState();
    const owner = allWorkspaces.find((w) => w.openPanes.includes(id));
    if (owner) {
      revealPane(owner.id, id, autoFocusNewPane);
      // WARDEN-1422 (QA round 5): resume = "click reconnects to the live tmux
      // session". When the click hits a pane OPEN but stuck in session_dead
      // (e.g. the session was respawned from the sidebar after the pane died,
      // or the row still reads WORKING while the pane shows the dead panel),
      // focus alone leaves the dead recovery panel on screen — bump the pane's
      // reconnect token so it re-attaches now. Any other phase (connecting,
      // connected, host_unreachable, error) is never disturbed: those have
      // their own recovery affordances and a live pane must not flicker.
      if (resumeShouldReattach(panePhaseRef.current[id])) {
        bumpReconnectToken(id);
      }
      return;
    }
    // Otherwise add to the active workspace + focus it.
    setOpenPanes((p) => p.includes(id) ? p : [...p, id]);
    if (autoFocusNewPane) setFocused(id);
  }, [setOpenPanes, setFocused, revealPane, bumpReconnectToken, setExternalSearchQuery]);

  // WARDEN-417 / WARDEN-476: in-app catch-up for per-chat watch pings that fired while
  // the human was away (the OS notification was unsupported / denied / cleared / lost).
  // Reads the durable miss log written at the fire site in useAttentionRollup and
  // surfaces the unacknowledged away misses on return — reconciled against the watched
  // chats' CURRENT states (WARDEN-476) so a recovered chat no longer reads "needs you" —
  // each deep-linking to its watched pane via the same openChat path. The
  // useWatchCatchup call + ack-on-open wiring live BELOW the useAttentionRollup call,
  // because the catch-up now consumes the rollup's `watchedStates` exposure; see there.

  // WARDEN-436: the live attention rollup is now owned by App (lifted UP from
  // AttentionBadge) so the SAME rollup feeds BOTH the header badge AND the
  // "While you were away" return banner — single source of truth, and the
  // /api/health (10s) + /api/agent-states (30s) polling still runs exactly ONCE.
  // (Option A from WARDEN-427: the alternative — a second hook instance in App —
  // would double that polling, which the codebase treats as an SSH-cost concern;
  // see useAttentionRollup.ts header.) The watch-ping side effect inside the hook
  // keeps working unchanged from this call site; AttentionBadge receives the rollup
  // as a prop instead of computing it.
  // The chat the observer should bind to when "observe focused" is clicked, AND
  // (WARDEN-426) the focused pane's identity for focus-gating the per-chat watch
  // ping. Hoisted above the lifted useAttentionRollup call (WARDEN-436) so the
  // focus-gate survives the lift — the hook consumes focusedPaneKey below. Derived
  // from chats (not `focused` raw) so a STALE focused key (a chat since closed/
  // re-keyed) resolves to null → the ping fires unchanged rather than spuriously
  // matching a transient row sharing the old key.
  const focusedChat = chats.find((c) => (c.key || c.id) === focused) || null;
  const focusedPaneKey = focusedChat?.key || focusedChat?.id || null;
  // WARDEN-538 — push the focused chat's name to the telemetry source so an
  // extended-tier opt-in's error/crash/stall events carry the correlation
  // identifier. The source attaches the name ONLY when extended consent is on
  // (which requires base), and the sink's redactor retains it only at the
  // extended tier — so this push is inert until the user opts in, and never
  // leaks a name at base/off. No sessionName: the focused Chat carries no
  // distinct Claude session name (the summary is folded into `.name` on resume),
  // per the WARDEN-538 planner decision. Fire-and-forget; a clean no-op outside
  // the Electron app (browser/dev/smoke have no telemetry source).
  //
  // WARDEN-1553/1554 — a chat spawned by POST /api/resume carries the owner's
  // FIRST PROMPT as `.name`; telemetryChatName() swaps it for the constant
  // 'resumed-session' (same provenance rule as buildNamesSnapshot, WARDEN-1550)
  // so prompt text never rides an incident event.
  const telemetryName = telemetryChatName(focusedChat);
  useEffect(() => {
    setTelemetryContext({ chatName: telemetryName });
  }, [telemetryName]);
  // WARDEN-1424 — the workspace-shape COUNT snapshot: ONE bounded
  // `workspace-shape` event per 5-minute window, read from THIS component's own
  // refs (nothing new fetched, polled, or retained — the sampler holds six
  // integers + two stamps per window). COUNTS ONLY by construction: workspaces
  // / panes / chats as numbers, never a name or a title — chat names ride
  // `workspace-names` behind their own consent category. In Electron the closed
  // window ships over the telemetry:renderer-shape bridge and MAIN is the
  // consent gate (the receipt refuses the operational-metrics category); in a
  // plain browser the sampler is a bounded no-op. Build-once via the module
  // singleton; the read closure reads refs, so it never goes stale and the
  // effect runs once.
  useEffect(() => {
    getWorkspaceShapeSampler({
      read: () => {
        const state = uiStore.getState();
        const ws = state.workspaces;
        const active = selectActiveWorkspace(state);
        return {
          workspaces: ws.length,
          panesOpen: ws.reduce((n, w) => n + (Array.isArray(w.openPanes) ? w.openPanes.length : 0), 0),
          panesActive: Array.isArray(active?.openPanes) ? active.openPanes.length : 0,
          chats: chatsRef.current.length,
        };
      },
      sendWindow: (snap) => forwardWorkspaceShape(snap),
    });
  }, []);
  // WARDEN-1479 — the feature-usage sampler: ONE bounded `feature-usage`
  // event per 5-minute window of CLOSED-SET capability names + counts (the
  // feature-adoption category's carrying event). COUNT-DRIVEN SILENCE: an
  // idle window sends nothing — feature-usage is NOT a liveness signal;
  // receiver silence means app-closed, consent-off, or a quiet session. The
  // seed call sites (search dialog, spawn control, appearance section, and
  // this component's own handlers) record through the SAME module singleton;
  // this build-once call supplies the Electron bridge transport (a child may
  // have gotten the singleton first — the transport upgrades in place). In
  // Electron MAIN is the consent gate (the receipt refuses the
  // feature-adoption category); in a plain browser the sampler is a bounded
  // no-op.
  useEffect(() => {
    getFeatureUsageSampler({
      sendWindow: (snap) => forwardFeatureUsage(snap),
    });
  }, []);
  // WARDEN-1466 — the PEAKS need an event-driven tick: the singleton's interval
  // and pagehide both call flush(), which folds only the CLOSING sample, so an
  // open-then-close burst inside one 5-minute window shipped a peak equal to
  // max(open, close) and the promise in workspaceShapeTelemetry.ts's header
  // was false. This effect folds ONE observation into the window's peak
  // accumulators on every workspaces/chats change — exact (no sampling period
  // for a short burst to fall inside), cheap (one read + two comparisons, no
  // timer, no state), and counts-only like everything on this channel. The
  // singleton is build-once, so the no-arg call returns the SAME instance with
  // the real read closure. Declared AFTER the build-once effect above and the
  // chatsRef sync effect (React runs effects in declaration order), so the
  // first tick meets a seeded sampler and current refs. Guarded by
  // web/workspaceShapeTickGuard.test.mjs.
  useEffect(() => {
    getWorkspaceShapeSampler().sampler.tick();
  }, [workspaces, chats]);
  // WARDEN-1408 (slice 11): the persisted prefs the rollup gates on (the
  // desktop-alerts opt-in + per-state filters) are subscribed INSIDE the hook
  // from the shared store now — the runtime inputs (openPanes,
  // onOpenChat, focusedPaneKey) stay explicit, exactly as they always were.
  const { rollup: attentionRollup, watchedStates: watchedAgentStates } = useAttentionRollup(
    openPanes, openChat, focusedPaneKey,
  );
  // WARDEN-417: surface the per-chat watch catch-up (unacked away misses, deep-linking
  // to each watched pane via openChat). WARDEN-476: pass the rollup's watched-states
  // exposure so the hook can suppress misses whose chats have since recovered on return
  // — closing the last false-positive trust hole in the catch-up. Lives below the
  // useAttentionRollup call precisely because it consumes that exposure.
  const watchCatchup = useWatchCatchup(openChat, watchedAgentStates);
  // Wire the ack-on-open chokepoint: hand the hook's ackKey to the openChat ref above
  // so EVERY open of a watched chat (sidebar, OS-toast click, search, observer, catch-
  // up row) clears that chat's catch-up misses. ackKey is stable (its only dep is the
  // stable recompute), so this effect runs once; until it does, the ref is a no-op.
  useEffect(() => {
    ackWatchMissRef.current = watchCatchup.ackKey;
  }, [watchCatchup.ackKey]);
  // Seamless cross-host resume: when an observer session bound to an agent is
  // opened, reconnect to that agent's chat. We prime the pane's host hint and
  // (for remote hosts) discover the host so the pane can attach, then open the
  // chat — so the user never has to manually navigate to the right host.
  const handleReconnectChat = useCallback((chatKey: string, host?: string | null) => {
    if (host && host !== '(local)') {
      primePaneHost(chatKey, host);
      void discoverHost(host).catch(() => {});
    }
    openChat(chatKey);
  }, [openChat, discoverHost]);

  // ＋ split (WARDEN-223 → WARDEN-543): spawn a scratch shell pane derived
  // entirely from a source pane — same host, same cwd — like VSCode's integrated-
  // terminal split. WARDEN-543 relocated this off the grid-toolbar ＋split button
  // (which acted on the FOCUSED pane) onto each pane's own context menu, so the
  // split operates on the RIGHT-CLICKED pane, not whichever pane happens to be
  // focused. The source pane id is therefore passed in explicitly; it falls back
  // to `focused` so any other caller stays safe. The shell `cmd` is resolved
  // through the single Default shell setting (WARDEN-429): a per-host override
  // (defaultShellByHost) wins, falling back to the global defaultShell, then
  // blank; blank means "no explicit shell" so the host launches its own login
  // shell. host/cwd are read from chatsRef so this callback isn't rebuilt on
  // every poll. A yatfa pane has no cwd → empty → the host's default login dir,
  // and its host is the SSH host, so the shell lands OUTSIDE the container
  // (host-side tmux).
  // Start a shell from the sidebar's spawn control (WARDEN-1422 job A): a PLAIN
  // SHELL on a host in a directory. A name makes it saved/persistent; no name
  // (undefined) makes it temporary — it runs as a pane and is never listed.
  // The user's per-host default-shell preference still decides WHICH shell when
  // set; blank = the host's own login shell (the WARDEN-223 semantics).
  const spawnShell = useCallback(async (host: string, cwd: string, name?: string) => {
    const { defaultShell, defaultShellByHost } = uiStore.getState();
    const cmd = (defaultShellByHost[host] ?? defaultShell ?? '').trim();
    // The name rides as `name` ONLY: the server derives the tmux session id
    // from it (the raw text may carry spaces — "release train 0.1.75") and
    // treats a body with neither session nor name as a temporary shell.
    const result = await postJson<{ chat: Chat }>('/api/spawn', name
      ? { host, cwd, cmd, name }
      : { host, cwd, cmd });
    if (!result.ok || !result.data) {
      if (prefs.notifyErrors) toast.error(result.error || 'Failed to start shell');
      return false;
    }
    // WARDEN-1513 — the feature-adoption seed: a SUCCESSFUL shell spawn is one
    // use of the chat-create capability (counts only; closed-set literal).
    // Recorded HERE, the seam every shell-creation entry funnels through
    // (SpawnControl, the empty-host "+ Start a shell" button, split-shell),
    // and only AFTER the failure return so a failed spawn counts nothing.
    getFeatureUsageSampler().sampler.recordFeatureUse('chat-create');
    const chat = result.data.chat;
    if (chat.temporary) {
      // Temporaries never ride the catalog list — track it locally so the new
      // pane resolves its label + host, and remember the pane's host (openChat's
      // chatsRef lookup cannot see a temp).
      setTempChats((prev) => [...prev.filter((c) => c.id !== chat.id), chat]);
    } else {
      void refresh();
    }
    const hostOf = chat.host || THIS_MACHINE;
    // paneHost is keyed by the id the pane OPENS with (paneIdOf — chat.key,
    // the bare tmux session; chat.id is the composite "host:session"). The
    // WARDEN-1422 QA round-4 blocker: keying by chat.id left the pane's own
    // paneHost lookup empty, the attach went out host-less, the server
    // skipped its refreshHost seed, and the just-spawned shell resolved to
    // "no chat matches" — Couldn't attach. Named spawns only passed by
    // timing luck (refresh() usually landing before the attach); the
    // pane-id key covers both. paneIdOf is the shared seam — the write key
    // and openChat's open id can no longer drift.
    const paneId = paneIdOf(chat);
    primePaneHost(paneId, hostOf);
    openChat(paneId);
    return true;
  }, [refresh, openChat, prefs.notifyErrors, primePaneHost]);

  // A split shell is an UNNAMED shell: temporary, never listed (WARDEN-1422).
  const handleSplitShell = useCallback(async (id?: string) => {
    const target = id ?? focused;
    if (!target) return;
    const fc = chatsRef.current.find((c) => (c.key || c.id) === target);
    if (!fc) return;
    const ok = await spawnShell(fc.host || THIS_MACHINE, fc.cwd || '');
    if (ok) void refresh();
  }, [focused, spawnShell, refresh]);
  // A chat was spawned from a pane's recovery panel (open-shell / re-spawn,
  // WARDEN-231): refresh the list so the new chat appears, then open + focus it.
  const handlePaneSpawned = useCallback((chat: Chat) => {
    // WARDEN-1422: an UNNAMED open-shell spawn is temporary — it never rides the
    // catalog list, so track it locally (pane label) and remember its pane host.
    const paneId = paneIdOf(chat);
    if (chat.temporary) {
      setTempChats((prev) => [...prev.filter((c) => c.id !== chat.id), chat]);
      // Same pane-id keying as spawnShell (paneIdOf): the pane opens with
      // chat.key, so paneHost must be keyed by the pane id or PaneGrid's
      // lookup misses and the attach goes out host-less ("Couldn't attach" —
      // WARDEN-1422 QA round 4).
      const hostOf = chat.host || THIS_MACHINE;
      primePaneHost(paneId, hostOf);
    } else {
      void refresh();
    }
    openChat(paneId);
  }, [refresh, openChat]);

  // Respawn a STOPPED saved session (WARDEN-1422): one action recreating the
  // tmux session with the same name in the same directory — a fresh process
  // under the same identity (tmux cannot resurrect the dead one). Only warden-
  // owned chats (kind:'tmux' with a stored cmd) are respawnable; the server
  // rejects the rest with a readable error.
  const respawnChat = useCallback(async (id: string) => {
    const result = await postJson('/api/respawn', { id });
    if (!result.ok) {
      if (prefs.notifyErrors) toast.error(result.error || 'Failed to respawn');
      return;
    }
    const host = chatsRef.current.find((c) => (c.key || c.id) === id)?.host;
    if (host) void discoverHost(host).catch(() => {});
    // WARDEN-1422 (QA round 5): if this chat's pane is OPEN (it sat in
    // session_dead — the ordinary permanent+stopped path), it must re-attach
    // NOW that the session exists again. Bump its reconnect token; PaneTile
    // folds the change into its retryNonce and re-runs the attach effect —
    // the same sequence the in-pane Re-spawn button drives. A pane that is
    // not open costs nothing (the token entry waits unused).
    bumpReconnectToken(id);
    if (prefs.notifyChatOps) toast.success('Session respawned — a fresh process under the same name');
  }, [discoverHost, prefs.notifyErrors, prefs.notifyChatOps, bumpReconnectToken]);

  // Save a closed TEMPORARY session from the recently-closed flyout (WARDEN-1422):
  // promote it to persistent — it moves into its host's saved list, and its
  // accident-insurance entry leaves the list (it is no longer a closed temp).
  const saveClosedSession = useCallback(async (id: string) => {
    const result = await postJson<{ chat: Chat }>('/api/save-session', { id });
    if (!result.ok || !result.data) {
      if (prefs.notifyErrors) toast.error(result.error || 'Failed to save session');
      return;
    }
    const chat = result.data.chat;
    const host = chat.host;
    // It is saved now — drop it from the temp tracking and from every workspace's
    // recently-closed list, then refresh so the host view shows it.
    setTempChats((prev) => prev.filter((c) => c.id !== id));
    dropRecentlyClosed(id);
    markRecentlySaved(chat.key || chat.id);
    void refresh();
    if (host) void discoverHost(host).catch(() => {});
    if (prefs.notifyChatOps) toast.success(`Saved — it is listed under ${host || 'its host'}`);
  }, [discoverHost, markRecentlySaved, refresh, dropRecentlyClosed, prefs.notifyErrors, prefs.notifyChatOps]);

  // WARDEN-372: record a closing pane in the active workspace's recently-closed
  // recovery list. Snapshots the chat's display name/host/cwd at close time so the
  // row renders even if the chat later leaves the catalog. Dedup-by-id (a re-close
  // moves it to the top) + cap are handled by mergeRecentlyClosed. No-op when the
  // chat can't be found (e.g. a pane already gone from the catalog) — there is
  // nothing to snapshot or reopen. Reads chatsRef so this callback stays stable.
  const pushRecentlyClosed = useCallback((id: string) => {
    // WARDEN-1422: a closed TEMPORARY shell is not in `chats` — the snapshot
    // comes from tempChatsRef instead, so the flyout's accident insurance
    // covers exactly the sessions that need it.
    const c = chatsRef.current.find((x) => (x.key || x.id) === id) || tempChatsRef.current.find((x) => (x.key || x.id) === id);
    if (!c) return;
    const entry: RecentlyClosedEntry = {
      id,
      // A temporary shell's name EQUALS its generated key, so displayName(c)
      // would collapse it to the "shell" cwd-label — the flyout must show the
      // actual generated name the human would be re-opening.
      name: c.name && c.name !== c.key ? c.name : (c.key || c.id),
      host: c.host || '',
      cwd: c.cwd || '',
      closedAt: Date.now(),
    };
    updateActiveWorkspace((w) => ({
      ...w,
      // mergeRecentlyClosed(existing, incoming) iterates incoming first, so the
      // just-closed entry (newest) lands on top and any prior occurrence of its
      // id is dropped — re-closing moves it to the top (WARDEN-372).
      recentlyClosed: mergeRecentlyClosed(w.recentlyClosed ?? [], [entry]),
    }));
  }, [updateActiveWorkspace]);

  // close pane: pane gone + recorded in recently-closed for one-click reopen.
  // Used by BOTH the pane-grid close (×) and the sidebar open-pane row close —
  // every pane close is a recovery candidate.
  const closePane = useCallback((id: string) => {
    pushRecentlyClosed(id);
    setOpenPanes((p) => p.filter((x) => x !== id));
    setFocused((f) => (f === id ? null : f));
    // The maximized id (WARDEN-521) is dropped by the store's setOpenPanes shim.
  }, [setOpenPanes, setFocused, pushRecentlyClosed]);
  // remove the pane only (no recently-closed entry) — used by the KILL flow, since
  // a killed chat's tmux session is destroyed and is not safely reopenable.
  const removeActive = useCallback((id: string) => {
    setOpenPanes((p) => p.filter((x) => x !== id));
    setFocused((f) => (f === id ? null : f));
    // Killing the maximized pane restores the grid: the store's setOpenPanes shim
    // clears the maximized id (WARDEN-521).
  }, [setOpenPanes, setFocused]);
  // WARDEN-909: drag a pane onto another pane tile → swap their positions in the
  // active workspace's openPanes. Routed through the setOpenPanes shim with a
  // functional update, so it always targets the CURRENTLY active workspace and
  // `workspaces` (already in PERSISTED_PREF_KEYS) persists the new order with no
  // extra wiring — a reordered grid survives a reload under restoreOnStartup
  // 'previous'. Nothing else needs touching: `focused` and `maximized` hold pane
  // IDS and paneHost is keyed by pane id, so focus, maximize and each pane's host
  // follow the pane into its new slot rather than staying with the slot. The
  // column/row resize ratios are per-TRACK weights whose count is unchanged by a
  // swap, so the grid's track sizes stay exactly as the user dragged them and
  // nothing jumps — the two panes simply exchange slots inside that layout.
  // swapPanes returns the SAME array on any no-op (self-drop, unknown id), which
  // the shim's `next === w.openPanes` check turns into no state change at all.
  const reorderPanes = useCallback((dragId: string, targetId: string) => {
    setOpenPanes((p) => swapPanes(p, dragId, targetId));
  }, [setOpenPanes]);
  // reopen a recently-closed pane: drop it from the recovery list (it is no longer
  // closed), then open it. openChat re-primes paneHost from the live catalog entry,
  // so a remote pane re-discovers its host on reopen.
  const reopenClosed = useCallback((id: string) => {
    // WARDEN-1422: a closed TEMPORARY shell is not in the chats catalog list, so
    // openChat's chatsRef lookup cannot learn its host — restore it from the
    // close-time snapshot instead (a remote temp must reattach to ITS host).
    // Read from the ref (not the updater — updaters must stay pure).
    const entry = selectActiveWorkspace(uiStore.getState())?.recentlyClosed?.find((e) => e.id === id);
    if (entry?.host) primePaneHost(id, entry.host);
    updateActiveWorkspace((w) => ({
      ...w,
      recentlyClosed: (w.recentlyClosed ?? []).filter((e) => e.id !== id),
    }));
    openChat(id);
  }, [updateActiveWorkspace, openChat, primePaneHost]);
  // WARDEN-1479 — the feature-adoption seed: each maximize/restore toggle is
  // one use of the pane-maximize capability (counts only; the name is a
  // closed-set literal).
  const toggleMax = useCallback((id: string) => {
    getFeatureUsageSampler().sampler.recordFeatureUse('pane-maximize');
    setMaximized((m) => (m === id ? null : id));
  }, [setMaximized]);

  // The destructive-action gate BOTH kill machines consult. One predicate, two
  // useConfirmTarget call sites below (the close-workspace machine lives in
  // <WorkspaceTabs/> and deliberately passes none).
  const shouldConfirmDestructive = useCallback(() => confirmDestructiveActions, [confirmDestructiveActions]);

  // Force-kill confirmation. The ⏹ force-kill button sits directly beside
  // clear/download/close in the pane toolbar — a single misclick otherwise
  // kills a possibly-running agent's tmux session with no guard. When "Confirm
  // before destructive actions" is on (default), open a ConfirmDialog first;
  // when off (power-user opt-out), kill immediately with no friction.
  const performForceKill = useCallback(async (id: string) => {
    const { ok, error, res } = await postJson('/api/session-kill', { id });
    if (!ok) {
      // Match the prior split: a generic toast on a server error, the reason
      // appended on a network failure.
      if (prefs.notifyChatOps) toast.error(res ? 'Failed to force-kill session' : `Failed to force-kill: ${error || ''}`);
      return;
    }
    if (prefs.notifyChatOps) toast.success('Session force-killed');
  }, [prefs.notifyChatOps]);

  const {
    target: forceKillTarget,
    request: forceKill,
    confirm: confirmForceKill,
    cancel: cancelForceKill,
  } = useConfirmTarget(performForceKill, shouldConfirmDestructive);

  // Kill-chat confirmation + optimistic UI. The native `window.confirm` guard is
  // replaced by a controlled ConfirmDialog: `requestKill` opens it (or, when the
  // "Confirm before destructive actions" preference is off, fires immediately).
  // `performKill` is OPTIMISTIC — it removes the row from local state in the same
  // frame as the click, before the cross-host SSH round-trip to /api/kill, and
  // rolls the row back (chats entry + tab + pane) on failure. Because the row
  // vanishes instantly there is no longer a blocking kill spinner, so requestKill
  // no longer returns an awaitable promise.
  const performKill = useCallback(async (id: string) => {
    const existing = chatsRef.current.find((x) => (x.key || x.id) === id);
    const host = existing?.host;
    // Snapshot the row's pane occupancy (read from refs so this callback's deps
    // stay stable) so a failed kill can restore the exact pre-click state.
    // WARDEN-372: tab occupancy (activeTabs/hiddenTabs) is gone — only pane state
    // is restored on rollback.
    const wasPane = openPanesRef.current.includes(id);
    const wasFocused = focusedRef.current === id;

    // Restore the row to its pre-click occupancy. Idempotent (guards on
    // presence) in case a concurrent refresh already re-added the entry.
    const rollback = () => {
      // Clear the optimistic guard first so a concurrent refresh stops hiding
      // the row before we restore it.
      killedChatIdsRef.current.delete(id);
      if (existing) setChats((prev) => prev.some((c) => (c.key || c.id) === id) ? prev : [...prev, existing]);
      if (wasPane) setOpenPanes((p) => p.includes(id) ? p : [...p, id]);
      if (wasFocused) setFocused(id);
    };

    // OPTIMISTIC: mutate local state immediately — before the await — so the
    // row disappears in the same frame as the click, not after the SSH
    // round-trip (hundreds of ms to seconds on a remote host). Guard the id so
    // a background catalog refresh can't resurrect it from disk mid-round-trip.
    killedChatIdsRef.current.add(id);
    removeActive(id);
    // Also drop the killed chat from the `chats` list itself (removeActive only
    // clears its tab/pane) so the row is gone from the sidebar's agent list in
    // this same frame. The killedChatIds guard above keeps the catalog merge /
    // live discovery from resurrecting it from disk while the round-trip is
    // pending; once it resolves the server no longer lists it either.
    setChats((prev) => prev.filter((c) => (c.key || c.id) !== id));

    try {
      const { ok, error, res } = await postJson('/api/kill', { id });
      if (!ok) {
        // ROLLBACK: the server rejected the kill, so restore the row.
        rollback();
        // Generic toast on a server error, reason appended on a network failure.
        if (prefs.notifyChatOps) toast.error(res ? 'Failed to kill chat' : `Failed to kill chat: ${error || ''}`);
        return;
      }
      // Success: the server confirmed the kill, so the disk catalog no longer
      // lists this chat — drop the optimistic guard and reconcile local state
      // with the server (the server remains the source of truth).
      killedChatIdsRef.current.delete(id);
      refresh();
      // discoverHost re-pulls that host's live list, confirming the kill and
      // refreshing the rest of the host's agents.
      if (host) void discoverHost(host).catch(() => {});
      if (prefs.notifyChatOps) toast.success('Chat killed');
    } catch (error) {
      // ROLLBACK on a thrown error too (e.g. an unexpected exception).
      rollback();
      if (prefs.notifyChatOps) toast.error(`Failed to kill chat: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [refresh, discoverHost, removeActive, setOpenPanes, setFocused, prefs.notifyChatOps]);

  const {
    target: killTarget,
    request: requestKill,
    confirm: confirmKill,
    cancel: cancelKill,
  } = useConfirmTarget(performKill, shouldConfirmDestructive);

  // WARDEN-1422: `resumeSession` (claude JSONL --resume from the history list and
  // the deleted Open-chat browser) is retired with those surfaces. The backend
  // /api/resume endpoint is untouched — the CLI and companion may still call it.

  const renameChat = useCallback(async (session: string, kind: string, name: string, host?: string) => {
    const prevName = chatsRef.current.find((c) => (c.key || c.id) === session)?.name;
    // OPTIMISTIC: reflect the new name in the same frame as the commit, before
    // the cross-host round-trip to /api/rename resolves. Guard it so a
    // background catalog refresh can't revert it from the on-disk (pre-rename)
    // name mid-round-trip.
    pendingRenamesRef.current.set(session, name);
    setChats((prev) => prev.map((c) => (c.key || c.id) === session ? { ...c, name } : c));

    // Stop guarding and restore the prior name (undefined → falls back to key/id).
    const rollback = () => {
      pendingRenamesRef.current.delete(session);
      setChats((prev) => prev.map((c) => (c.key || c.id) === session ? { ...c, name: prevName } : c));
    };

    try {
      // `host` scopes the rename to a host+session composite — the same session
      // name can exist on multiple hosts, so without it the server could rename
      // the wrong host's entry.
      const { ok, error, res } = await postJson('/api/rename', { session, kind, name, host });
      if (!ok) {
        // ROLLBACK: the server rejected the rename.
        rollback();
        // Generic toast on a server error, reason appended on a network failure.
        if (prefs.notifyChatOps) toast.error(res ? 'Failed to rename chat' : `Failed to rename: ${error || ''}`);
        return;
      }
      // Success: the disk catalog now holds the new name — drop the guard.
      pendingRenamesRef.current.delete(session);
      refresh();
      if (prefs.notifyChatOps) toast.success('Chat renamed');
    } catch (error) {
      // ROLLBACK on a thrown error too.
      rollback();
      if (prefs.notifyChatOps) toast.error(`Failed to rename: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [refresh, prefs.notifyChatOps]);

  // WARDEN-770 — surface an inline quick-reply send outcome under the SAME
  // prefs.notifyChatOps gate as kill/rename/resume above. The QuickReply control
  // owns the postJson send + its own inline error/retry cue; this callback is the
  // parent's toast channel. Success reads as a confirmation that the reply reached
  // the agent's tmux session without a pane switch; failure surfaces the server /
  // network reason (the control's inline error already points at the row that failed).
  const handleReplyResult = useCallback((ok: boolean, error?: string) => {
    if (!prefs.notifyChatOps) return;
    if (ok) toast.success('Reply sent');
    else toast.error(error || 'Reply failed');
  }, [prefs.notifyChatOps]);

  // WARDEN-1441 (slice 15): deep-links into the Observer's Activity tab now write
  // the shared uiStore directly (the retired externalViewMode one-shot prop made
  // every click a null→'activity' transition only by round-tripping through a
  // consume callback; a store write needs no such dance — a second write is a
  // fresh transition the subscriber re-renders from, so repeated "View Activity"
  // clicks work and a manual tab switch is never yanked back). The panel-collapse
  // half is a store write too (observerCollapsed, WARDEN-1510).
  const openActivityTab = useCallback(() => {
    setObserverCollapsed(false);
    setObserverViewMode('activity');
  }, [setObserverCollapsed, setObserverViewMode]);

  // --- Multi-workspace operations (WARDEN-256) --------------------------------
  // WARDEN-1638 (slice 41): the six workspace actions, their feature-use ticks and
  // the close-workspace confirm dialog live in <WorkspaceTabs/> now.

  // WARDEN-514: per-key CURRENT-state lookup for the watched rows — so a watched chat
  // that needs the human right now (waiting/erroring/stuck/blocked) shows a persistent,
  // state-aware indicator on its own row even when its pane is closed (the header
  // AttentionBadge is open-gated, so a watched-but-CLOSED pane never reaches it). Built
  // from the rollup's already-fetched `watchedStates` exposure (the watched subset incl.
  // closed panes, pre-open-filter — useAttentionRollup), so this adds ZERO SSH cost: it
  // rides the same open ∪ watched ~30s poll. keyed by row.key ?? row.id — the same key
  // space watchedChats/openPanes use. Recomputed each render.
  // WARDEN-1422: the per-key watched-state map the sidebar rows used to render
  // (indexByWatchKey(watchedAgentStates)) is gone with the row indicators; the
  // rollup itself still feeds the header badge, and useWatchCatchup still reads
  // watchedAgentStates directly.
  const tiles = openPanes.map((id) => ({ id }));
  // focusedChat + focusedPaneKey are derived above the lifted useAttentionRollup
  // call (WARDEN-426/436); focusedChat is reused below for the observer bind.
  // Selectable host list for the Open Chat browser's multiselect chips: this
  // machine plus every configured SSH host.
  const hosts = [THIS_MACHINE, ...sshHosts];

  // WARDEN-1671 (slice 46): "open Settings" is a store command (non-persisted
  // `settingsOpen`); the always-mounted AppMenuBridge component owns the application
  // menu's Settings… and Edit ▸ Select All subscriptions.
  const settingsOpen = useSettingsOpen();
  const setSettingsOpen = useSetSettingsOpen();
  // WARDEN-1422: the full-page "Open chat" browser view (WARDEN-216) is DELETED —
  // the sidebar is the only session surface, and unsaved sessions are never
  // listed. The token-budget alarm's old deep-link into that page's heaviest-
  // first view goes with it; the alarm itself (toast + desktop) still fires.
  useTokenBudget({});
  // Display customization settings
  const [displaySettings, setDisplaySettings] = useState({
    showHostTags: true,
    showTypeBadges: true,
    showStatusIndicators: true,
    showProjectBadges: false,
    hideOfflineHosts: false,
    // WARDEN-1388: the issue-key link integration rides the same bundle (one
    // server-config fetch owns both halves — see refreshConfigPrefs).
    issueLinksEnabled: false,
  });
  // WARDEN-1388: the issue-key link integration, from /api/config (server
  // config — persisted across restarts, not a local UI pref). The toggle rides
  // displaySettings below; the tracker mapping is its own state because it is
  // an array of structured entries, not a boolean display flag. Both OFF/empty
  // by default, and the entries are re-normalized defensively on every fetch
  // (normalizeIssueLinkEntries): the server sanitizes on PUT, but a hand-edited
  // config.json bypasses that, and GET is a raw arrayOrEmpty passthrough — the
  // frontend filters rather than trusting.
  const [issueLinkTrackers, setIssueLinkTrackers] = useState<IssueLinkEntry[]>([]);
  // WARDEN-1394 (slice 2 of roadmap WARDEN-1386): the markdown issue-key
  // linkifier's entry set, threaded to the fleet-level markdown surfaces
  // (observer messages, directive text, transcript messages). Unlike the
  // terminal (strict per-pane project scoping via issueEntriesForProject), the
  // markdown path consults EVERY configured entry whose prefix is unique across
  // the set — messages are fleet-level, so cross-project references are
  // legitimate and the prefix→tracker mapping is human-stated config; a prefix
  // mapped under two projects links nowhere (ambiguity is honest silence).
  // Gated on the integration toggle so OFF (the default) yields [] — no plugin
  // registration in MarkdownBody, byte-identical rendering. Recomputed each
  // render (cheap; a filter over a handful of entries).
  const markdownIssueEntries = displaySettings.issueLinksEnabled
    ? unambiguousPrefixEntries(issueLinkTrackers)
    : [];
  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      <ReturnBanner rollup={attentionRollup} onOpenChat={openChat} onOpenActivity={openActivityTab} />
      <WatchCatchup
        misses={watchCatchup.misses}
        onOpenMiss={watchCatchup.openMiss}
        onDismiss={watchCatchup.dismiss}
        onReplyResult={handleReplyResult}
      />
      {settingsOpen ? (
        <SettingsPage
          onClose={() => setSettingsOpen(false)}
          onConfigChange={handleConfigChange}
          // WARDEN-1383 (roadmap WARDEN-1204 slice 8): no `newChats` group —
          // NewChatsSection subscribes to the shared client-state store
          // (lib/uiStore.ts) directly, like SnippetsSection (WARDEN-1271) and
          // the six terminal prefs (WARDEN-1322) before it. WARDEN-1408 (slice
          // 11): no `alerts` group either — NotificationsSection subscribes to
          // the store the same way, and the DesktopAlertPrefs bag is retired.
        />
      ) : (
        <>
      <header className="flex items-center gap-3 px-3 h-11 border-b shrink-0">
        <PanelToggleButtons panel="sidebar" />
        <span className="font-semibold tracking-wide shrink-0">Yatfa Warden</span>
        <span className="text-xs text-muted-foreground shrink-0 whitespace-nowrap">{openPanes.length} open</span>
        {/* Workspace tab strip (WARDEN-256) — the flexible, bounded middle region.
            min-w-0 + overflow-x-auto let it absorb remaining width and scroll its
            tabs internally so it can never push the right-side control cluster
            (below) off-screen at the default width. */}
        <WorkspaceTabs
          className="flex-1 min-w-0"
        />
        {/* Right-side control cluster — shrink-0 so the tab region yields first
            and this whole cluster stays fully visible at the default width. */}
        <div className="flex items-center gap-3 shrink-0">
          <StreamStatusDot />
          <AttentionBadge rollup={attentionRollup} onOpenChat={openChat} onOpenActivity={openActivityTab} focusedPaneKey={focusedPaneKey} />
          <IconTooltip label="global search (Ctrl+Shift+F)" side="bottom"><button onClick={() => setGlobalSearchOpen(true)} className="text-muted-foreground hover:text-foreground transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded px-1.5 py-0.5 hover:bg-accent/50">⌕</button></IconTooltip>
          <PanelToggleButtons panel="health" />
          <PanelToggleButtons panel="observer" />
          <IconTooltip label="settings" side="bottom"><button onClick={() => { getFeatureUsageSampler().sampler.recordFeatureUse('settings'); setSettingsOpen(true); }} className="text-muted-foreground hover:text-foreground transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded px-1.5 py-0.5 hover:bg-accent/50">⚙</button></IconTooltip>
        </div>
      </header>
      <main className="flex flex-1 min-h-0">
        <ResizableRail side="sidebar" className="chat-sidebar border-r min-h-0 transition-all duration-200 ease-in-out overflow-hidden relative" handleTitle="Drag to resize sidebar">
          <ErrorBoundary onError={(error, info) => forwardRendererError(error, info.componentStack)}>
            <ChatSidebar
              chats={chats}
              tempChats={tempChats}
              hosts={hosts}
              onOpenChat={openChat}
              onSpawnShell={spawnShell}
              onSaveSession={saveClosedSession}
              onReopenClosed={reopenClosed}
              onRespawn={respawnChat}
              onKill={requestKill}
              onRename={renameChat}
              onRefresh={refresh}
              onDiscoverHost={discoverHost}
              loading={loading}
              discoverErrors={discoverErrors}
              pollIntervalMs={pollIntervalMs}
            />
          </ErrorBoundary>
        </ResizableRail>
        <section className="flex-1 min-h-0 min-w-0">
          <PaneGrid
            tiles={tiles}
            chats={[...chats, ...tempChats]}
            onFocus={setFocused}
            onClose={closePane}
            onToggleMax={toggleMax}
            onForceKill={forceKill}
            onSplitShell={handleSplitShell}
            onSpawned={handlePaneSpawned}
            // WARDEN-1422 (QA round 5): per-pane reconnect tokens + phase
            // reports — the respawn/resume → open-dead-pane re-attach chain.
            onPanePhaseChange={handlePanePhaseChange}
            // WARDEN-1322 (slice 3): the six terminal prefs (fontSize/onFontSize-
            // Change, scrollback, fontFamily, terminalCursorStyle, copyOnSelect,
            // onExitBehavior) no longer ride through PaneGrid — PaneTile
            // subscribes to them in the shared store (lib/uiStore.ts) and
            // PaneGrid never read them. WARDEN-1420 (slice 12): `paneLayout`
            // stopped riding through too — PaneGrid DOES read that one, so it
            // subscribes to the same store directly. WARDEN-1574 (slice 31): the
            // derived terminal theme id stopped riding through too — PaneTile
            // subscribes to useTerminalThemeId(), so an OS theme flip re-themes
            // open panes live without an App prop.
            // WARDEN-1433 (slice 14): the pane-ratio pair stopped riding through
            // the same way — PaneGrid DOES read AND write it (persisted values
            // in, committed arrays out), and it now subscribes to the store for
            // both under the exact local names the props used, so every drag /
            // template / equalize / reset-reorder call site below is unchanged.
            showHostTags={displaySettings.showHostTags}
            // WARDEN-1388: the issue-key link integration — server config
            // fetched by refreshConfigPrefs, live-updating already-open panes.
            issueLinksEnabled={displaySettings.issueLinksEnabled}
            issueLinkTrackers={issueLinkTrackers}
            pollIntervalMs={pollIntervalMs}
            onReorderPanes={reorderPanes}
          />
        </section>
        <ResizableRail side="observer" className="border-l min-h-0 transition-all duration-200 ease-in-out overflow-hidden relative" handleTitle="Drag to resize observer panel">
          <ErrorBoundary onError={(error, info) => forwardRendererError(error, info.componentStack)}>
            <ObserverTabs focusedChat={focusedChat} onReconnectChat={handleReconnectChat} observerAutoStart={observerAutoStart} observerSessionTimeout={observerSessionTimeout} attention={{ rollup: attentionRollup, onOpenChat: openChat, onOpenActivity: openActivityTab, focusedPaneKey }} issueEntries={markdownIssueEntries} />
          </ErrorBoundary>
        </ResizableRail>
        <HealthPanel
          onOpenChat={openChat}
          pollIntervalMs={pollIntervalMs}
          companionTransportEnabled={companionTransportEnabled}
        />
      </main>
        </>
      )}
      <PanelLayoutSync />
      <AppearanceSync />
      <AppMenuBridge />
      <GlobalSearchHost onOpenChat={openChat} issueEntries={markdownIssueEntries} />
      <ConfirmDialog
        open={killTarget !== null}
        onOpenChange={(o) => { if (!o) cancelKill(); }}
        title="Kill chat?"
        description="kill this chat and forget it?"
        confirmLabel="Kill"
        cancelLabel="Cancel"
        destructive
        onConfirm={confirmKill}
      />
      <ConfirmDialog
        open={forceKillTarget !== null}
        onOpenChange={(o) => { if (!o) cancelForceKill(); }}
        title="Force-kill session?"
        description="Force-kill this session? This kills the tmux session for a possibly-running agent and cannot be undone."
        confirmLabel="Force-kill"
        cancelLabel="Cancel"
        destructive
        onConfirm={confirmForceKill}
      />
    </div>
  );
}

export default App;
