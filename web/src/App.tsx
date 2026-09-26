import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { streamApi } from '@/lib/stream';
import { postJson, fetchBounded, pollerFetchOptions } from '@/lib/api';
import { loadUi, initialWorkspace, mergeRecentlyClosed, resetUiPrefDefaults, loadObs, saveObs, resetObsPrefsPreservingWorkspace, type ResettableKey, type ResetUiDefaults, type WorkspacePaneSet, type RecentlyClosedEntry } from '@/lib/storage';
import { clampSidebarWidth, clampObserverWidth, clampLayoutWidths, HEALTH_WIDTH } from '@/lib/layout';
import { mergeHostList } from '@/lib/hostList';
import { applyTheme, listenSystemThemeChange, resolveThemeId, resolveTerminalThemeId, type ThemeId } from '@/lib/theme';
import { applyDensity } from '@/lib/density';
import { stampLastSeen } from '@/lib/whatsNew';
import { useWatchCatchup } from '@/lib/useWatchCatchup';
import { useWatchState } from '@/lib/useWatchState';
import { useTokenBudget } from '@/lib/useTokenBudget';
import { useAttentionRollup } from '@/lib/useAttentionRollup';
import { useHostStatuses } from '@/lib/useHostStatuses';
import { useVisiblePoller } from '@/lib/useVisiblePoller';
import { rankAttention, hasReturnContent, attentionReason, type AttentionItem } from '@/lib/attentionRollup';
import { cn } from '@/lib/utils';
import { getRememberWindowBounds, setRememberWindowBounds as persistRememberWindowBounds, getLaunchAtLogin, setLaunchAtLogin as persistLaunchAtLogin, getCloseToTray, setCloseToTray as persistCloseToTray, setTelemetryContext, forwardRendererError, forwardWorkspaceShape, installRendererErrorCapture, onOpenSettings, onSelectAll } from '@/lib/electron';
import { getWorkspaceShapeSampler } from '@/lib/workspaceShapeTelemetry';
import { routeMenuSelectAll, TERMINAL_SELECT_ALL_EVENT } from '@/lib/terminalEdit';
import type { Chat } from '@/lib/types';
import { paneIdOf, bumpReconnectToken, resumeShouldReattach, type PaneAttachPhase, type ReconnectTokens } from '@/lib/paneAttach';
import { normalizeIssueLinkEntries, unambiguousPrefixEntries, type IssueLinkEntry } from '@/lib/issue-links';
import { useSnippets, useSetSnippets, useFileViewerViewMode, useSetFileViewerViewMode, useTerminalFontSize, useSetTerminalFontSize, useTerminalScrollback, useSetTerminalScrollback, useTerminalFontFamily, useSetTerminalFontFamily, useTerminalCursorStyle, useSetTerminalCursorStyle, useCopyOnSelect, useSetCopyOnSelect, useOnExitBehavior, useSetOnExitBehavior, useTimestampFormat, useSetTimestampFormat, useHostLabels, useSetHostLabels, useAgentFilter, useSetAgentFilter, useAgentSort, useSetAgentSort, useDefaultNewChatPreset, useSetDefaultNewChatPreset, useDefaultNewChatPresetByHost, useSetDefaultNewChatPresetByHost, useDefaultNewChatHost, useSetDefaultNewChatHost, useDefaultNewChatCwd, useSetDefaultNewChatCwd, useDefaultNewChatCwdByHost, useSetDefaultNewChatCwdByHost, useCustomPresets, useSetCustomPresets, useDefaultShell, useSetDefaultShell, useDefaultShellByHost, useSetDefaultShellByHost, useAttentionDesktopAlerts, useSetAttentionDesktopAlerts, useAttentionStates, useSetAttentionStates, useTheme, useSetTheme, useDensity, useSetDensity, usePaneLayout, useSetPaneLayout, useAutoFocusNewPane, useSetAutoFocusNewPane, useRestoreOnStartup, useSetRestoreOnStartup, useTerminalColorScheme, useSetTerminalColorScheme, useHealthGroupBy, useSetHealthGroupBy, useHealthCollapsedHosts, useSetHealthCollapsedHosts, usePaneColRatios, usePaneRowRatios } from '@/lib/uiStore';

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
import { GlobalSearchDialog } from '@/components/GlobalSearchDialog';
import { SessionTranscriptViewer } from '@/components/SessionTranscriptViewer';
import { HealthDashboard } from '@/components/HealthDashboard';
import { AttentionBadge, dotForState } from '@/components/AttentionBadge';
import { WatchCatchup } from '@/components/WatchCatchup';
import { StatusDot } from '@/components/StatusDot';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Button } from '@/components/ui/button';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { useNotificationPrefs } from '@/lib/useNotificationPrefs';
import { useConfigPersistence, type PersistedPrefSnapshot } from '@/lib/useConfigPersistence';
import { useConfirmTarget } from '@/lib/useConfirmTarget';
import { resolvePollIntervalMs, WEB_POLL_DEFAULT_MS, WEB_POLL_FLOOR_MS } from '@/lib/pollInterval';
import { swapPanes } from '@/lib/paneGrid';
import { reconcileMainOwnedPref } from '@/lib/mainOwnedPref';
import { toast } from 'sonner';

// WARDEN-436: the return banner may FIRST appear only within this window after the
// human returns (>60s away). It covers the rollup's cold-start window (the first
// /api/health + /api/agent-states polls fire on mount but take a round-trip to
// resolve — the callout fills in as they land). Matches the slowest poll cadence
// (AGENT_STATE_POLL_MS) so a slow first fetch can still latch the banner. After the
// window the banner never appears ambiently; a pane that LATER needs attention
// updates the header badge, not a spontaneous banner. See the windowed latch below.
const RETURN_BANNER_WINDOW_MS = 30_000;

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
  const [, setLastRefreshAt] = useState<number | null>(null);
  // Read persisted UI state ONCE on mount (lazy initializer runs only the first
  // render) and reuse it for every useState seed below — consolidates the prior
  // per-state loadUi() calls into a single read.
  const [uiState] = useState(() => loadUi());
  // Stable for the session: true when THIS launch started in "Start empty" mode.
  // The live workspace is then a gated clean slate, not a legitimate workspace to
  // persist — so for the whole session persistUiState carries the on-disk workspace
  // forward (even after flipping back to "Reopen previous"), never the live arrays.
  const startedEmpty = uiState.restoreOnStartup === 'empty';
  // WARDEN-1420 (roadmap WARDEN-1204 slice 12): the LIVE "restore on startup"
  // pref migrated onto the shared store (see the appearance family below) —
  // AppearanceSection subscribes; App subscribes to keep the persistence
  // argument + reset partition whole. The two `uiState.restoreOnStartup` reads
  // that BRACKET this pair are deliberately NOT migrated with it, and reading
  // them as leftovers is the trap: both are BOOT facts about what this launch
  // started as, which the live pref stops being the moment the user flips it.
  // `startedEmpty` must stay pinned to the at-launch value for the whole
  // session (that is the comment above), and `initialWorkspace` resolves the
  // opening workspace from the DISK payload before React renders anything.
  // Where the LIVE pref lives is independent of both.
  const restoreOnStartup = useRestoreOnStartup();
  const setRestoreOnStartup = useSetRestoreOnStartup();
  const initWs = initialWorkspace(uiState, uiState.restoreOnStartup ?? 'previous');
  // Multi-workspace (WARDEN-256): openPanes/focused/recentlyClosed now live INSIDE
  // per-workspace pane-sets. The active workspace's panes are what render in the
  // grid; switching activeWorkspaceId swaps the grid instantly. paneHost stays
  // global (keyed by pane id). WARDEN-372 abolished the flat activeTabs/hiddenTabs
  // working set — the sidebar root is now the active workspace's openPanes + a
  // per-workspace recently-closed list.
  const [workspaces, setWorkspaces] = useState<WorkspacePaneSet[]>(() => initWs.workspaces);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>(() => initWs.activeWorkspaceId);
  const [paneHost, setPaneHost] = useState<Record<string, string>>(() => initWs.paneHost);
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
  // Sessions just saved from the recently-closed flyout — the one-shot "saved"
  // pill on their row. Entries expire (one-shot marker, not a state).
  const [recentlySavedIds, setRecentlySavedIds] = useState<Set<string>>(new Set());
  const markRecentlySaved = useCallback((id: string) => {
    setRecentlySavedIds((prev) => new Set(prev).add(id));
    setTimeout(() => {
      setRecentlySavedIds((prev) => { if (!prev.has(id)) return prev; const next = new Set(prev); next.delete(id); return next; });
    }, 30_000);
  }, []);
  const chatsRef = useRef(chats);
  useEffect(() => { chatsRef.current = chats; }, [chats]);
  // The active workspace's pane-set, derived every render. Falls back to the
  // first workspace if activeWorkspaceId ever dangles (defensive — loadUi/init
  // keep it valid, but a corrupt mid-session state must still render something).
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0] ?? null;
  const openPanes: string[] = activeWorkspace?.openPanes ?? [];
  const focused: string | null = activeWorkspace?.focused ?? null;
  // Mirrors read synchronously inside stable callbacks (performKill's rollback,
  // openChat's cross-workspace dedup) without widening their dependency arrays.
  const openPanesRef = useRef(openPanes); openPanesRef.current = openPanes;
  const focusedRef = useRef(focused); focusedRef.current = focused;
  const workspacesRef = useRef(workspaces); workspacesRef.current = workspaces;
  const activeWorkspaceIdRef = useRef(activeWorkspaceId); activeWorkspaceIdRef.current = activeWorkspaceId;

  // openPanes/focused now live inside the active workspace. These stable shims
  // keep every existing call site working (functional updates for openPanes,
  // value-or-fn for focused) while routing each change through the active
  // workspace. They read activeWorkspaceId via the ref (not a dep), so their
  // identity is stable ([] deps) — consumers like closePane that list no deps
  // still target the CURRENTLY active workspace, not the one at first render.
  const updateActiveWorkspace = useCallback(
    (fn: (w: WorkspacePaneSet) => WorkspacePaneSet) => {
      const aid = activeWorkspaceIdRef.current;
      setWorkspaces((prev) => {
        if (prev.length === 0) return prev;
        const idx = prev.findIndex((w) => w.id === aid);
        const target = idx >= 0 ? idx : 0;
        const updated = fn(prev[target]);
        if (updated === prev[target]) return prev;
        const copy = [...prev];
        copy[target] = updated;
        return copy;
      });
    },
    [],
  );
  const setOpenPanes = useCallback(
    (updater: string[] | ((p: string[]) => string[])) => {
      updateActiveWorkspace((w) => {
        const next = typeof updater === 'function' ? updater(w.openPanes) : updater;
        return next === w.openPanes ? w : { ...w, openPanes: next };
      });
    },
    [updateActiveWorkspace],
  );
  const setFocused = useCallback(
    (value: string | null | ((f: string | null) => string | null)) => {
      updateActiveWorkspace((w) => {
        const next = typeof value === 'function' ? value(w.focused) : value;
        return next === w.focused ? w : { ...w, focused: next };
      });
    },
    [updateActiveWorkspace],
  );
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
  // Persisted panel widths are clamped to their usable floors on mount so a
  // stale value (saved on a wider window, or from before WARDEN-183) can't crush
  // the middle pane column. Computed once via a lazy initializer, then split
  // into the two independent states the rest of the component reads.
  const [initialWidths] = useState(() =>
    clampLayoutWidths(
      { sidebar: uiState.sidebarWidth ?? 220, observer: uiState.observerWidth ?? 380 },
      {
        windowWidth: window.innerWidth,
        healthCollapsed: uiState.healthCollapsed ?? true,
        sidebarCollapsed: uiState.sidebarCollapsed,
        observerCollapsed: uiState.observerCollapsed,
      },
    ),
  );
  const [sidebarWidth, setSidebarWidth] = useState(initialWidths.sidebar);
  const [observerWidth, setObserverWidth] = useState(initialWidths.observer);
  const [maximized, setMaximized] = useState<string | null>(null);
  const [newActivity, setNewActivity] = useState<Set<string>>(new Set());
  const [streamConn, setStreamConn] = useState(false);
  const [activitySinceClose, setActivitySinceClose] = useState<any>(null);
  // WARDEN-436: the return banner now surfaces the ranked "you're needed HERE"
  // callout as its lead. Visibility is split into two concerns:
  //  - returnedAfterAbsence: the user-initiated RETURN trigger (set once on mount
  //    when >60s elapsed since warden:lastClose). This is the conservative,
  //    never-ambient gate — the banner can ONLY ever show right after a return.
  //  - bannerDismissed: the human clicked × — suppresses the banner until the next
  //    return (so it never re-pops ambiently mid-session).
  // The actual show/hide is DERIVED below (returnedAfterAbsence && !dismissed &&
  // hasReturnContent(...)) so the ranked callout can fill in once the rollup
  // arrives without an imperative setShow, and so the gate broadening — also fire
  // on a non-null ranked top, not just since-close activity events — lives in one
  // pure, unit-tested predicate (hasReturnContent).
  const [returnedAfterAbsence, setReturnedAfterAbsence] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [externalViewMode, setExternalViewMode] = useState<'sessions' | 'activity' | 'directives' | 'attention' | null>(null);
  // WARDEN-981 — the Observer panel's half of "Reset appearance & UI
  // preferences". The Observer's view prefs (viewMode + the 3 per-tab filter
  // shapes) persist in a SECOND storage namespace (ObsUi / warden:observer:v1)
  // that the UiState-derived ResettableKey reset below structurally cannot
  // reach. The reset below does two things: rewrites the stored payload
  // directly, and bumps this monotonically-increasing nonce so a STILL-MOUNTED
  // panel snaps its live states to defaults with no remount. (The shipped
  // reset fires from the full-page Settings view, which unmounts the dashboard
  // — on return the panel re-seeds from the rewritten payload — but the nonce
  // keeps the fix correct for any surface that resets while the dashboard is
  // up, and for the same-value-bailout trap a repeated reset would otherwise
  // hit: every bump is a distinct value.)
  const [observerResetToken, setObserverResetToken] = useState(0);
  const [showGlobalSearch, setShowGlobalSearch] = useState(false);
  // The past-conversation whose read-only transcript is open from a global-search
  // result (WARDEN-719). Lifted to App level — NOT inside GlobalSearchDialog —
  // because that dialog auto-closes on result-click, which would unmount a viewer
  // rendered within it. Mirrors OpenChatBrowserPage's internal `viewing` state.
  const [viewingSession, setViewingSession] = useState<{ id: string; host: string; label: string } | null>(null);
  const [externalSearchQuery, setExternalSearchQuery] = useState<{ paneId: string; query: string } | null>(null);
  // WARDEN-1422 (QA round 5): per-pane reconnect tokens. A saved session whose
  // pane is OPEN and stuck in session_dead must re-attach when (a) the sidebar
  // respawns its chat (respawnChat below) or (b) a resume click hits the pane
  // (openChat's already-open branch — resume means "click reconnects to the
  // live tmux session", so a dead recovery panel on screen must re-attach, not
  // just focus). PaneTile folds a CHANGE of its token into its retryNonce, so
  // the external value never widens the attach effect's deps.
  const [reconnectTokens, setReconnectTokens] = useState<ReconnectTokens>({});
  // The attach phase each open pane last reported (PaneTile's onPhaseChange).
  // A ref, not state: openChat must read it without depending on pane state,
  // and a phase change never re-renders the app — it only keeps this map
  // honest for the next resume click.
  const panePhaseRef = useRef<Record<string, PaneAttachPhase>>({});
  const handlePanePhaseChange = useCallback((id: string, phase: PaneAttachPhase) => {
    panePhaseRef.current[id] = phase;
  }, []);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(uiState.sidebarCollapsed);
  const [observerCollapsed, setObserverCollapsed] = useState(uiState.observerCollapsed);
  const [healthCollapsed, setHealthCollapsed] = useState(uiState.healthCollapsed ?? true);
  // WARDEN-431: Source Control section collapse (the single place a focused
  // pane's repo changes now show). A sidebar-internal section collapse, persisted
  // by the saveUi effect below like the panel collapses above. Pure client-side
  // pref; never sent to the backend. WARDEN-1422 moves the panel to the bottom of
  // root as an add-on and flips the DEFAULT to collapsed — git status is job D,
  // behind hosts and sessions in the sidebar's priority order.
  const [sourceControlCollapsed, setSourceControlCollapsed] = useState(uiState.sourceControlCollapsed ?? true);
  // WARDEN-1420 (roadmap WARDEN-1204 slice 12): theme/density/paneLayout/
  // autoFocusNewPane/restoreOnStartup/terminalColorScheme migrated onto the
  // shared store (lib/uiStore.ts) — AppearanceSection subscribes (it is the
  // only writer of all six) and PaneGrid subscribes to paneLayout; App
  // subscribes for its own runtime reads (the [theme]/[density] effects, the
  // openChat focus gate, the terminalThemeId derivation) plus the persisted
  // snapshot + reset partition.
  const theme = useTheme();
  const setTheme = useSetTheme();
  // The OS-resolved concrete theme id (e.g. 'github-dark', 'dracula'). The
  // `theme` state variable stays 'system' on an OS flip, so chrome re-paints via
  // a direct DOM attribute mutation in the [theme] effect — no React re-render.
  // But the terminal surface re-themes imperatively inside PaneTile's effect,
  // which only re-fires when its prop changes. Tracking resolvedThemeId as React
  // state and feeding it to resolveTerminalThemeId is what makes "Match app
  // theme" live-update on an OS flip (nuance #1): listenSystemThemeChange calls
  // setResolvedThemeId, the prop propagates to PaneTile, and its effect
  // re-paints open panes with the new theme's xterm palette.
  //
  // WARDEN-1420 (slice 12): seeded from the STORE's live `theme` above rather
  // than from a second read of the persisted payload — the store seeded itself
  // from the same loadUi() document at module load, so the value is identical
  // and the pref keeps exactly ONE read channel.
  const [resolvedThemeId, setResolvedThemeId] = useState<ThemeId>(() => resolveThemeId(theme));
  const density = useDensity();
  const setDensity = useSetDensity();
  const paneLayout = usePaneLayout();
  const setPaneLayout = useSetPaneLayout();
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
  // sites + four Props entries are gone. App keeps ONLY the value
  // subscriptions, for the same two reasons every migrated fact keeps its
  // App-side read: the values feed PersistedPrefSnapshot (the compile-locked
  // single writer) and the subscription is what re-renders App when a pane
  // resize commits, so the saveUi effect fires. The setters are NOT kept:
  // unlike the health pair (slice 13) the ratios are NOT resettable — both
  // keys sit in RESET_PRESERVED_KEYS (WARDEN-934: "they are panel layout,
  // which the shipped button promises to keep") — so no resetSetters entry
  // ever needed them, and an unused local would only fail noUnusedLocals.
  const paneColRatios = usePaneColRatios();
  const paneRowRatios = usePaneRowRatios();
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
  // App still subscribes for the same two single-writer reasons as `snippets`:
  // (1) each value must appear in the PersistedPrefSnapshot below so the ONE
  // compile-locked saveUi effect keeps writing it, and (2) the reset partition
  // (resetSetters) must keep a setter for each. The write path is unchanged end
  // to end: store.setX → this subscription re-renders App → the snapshot's
  // field changes → useConfigPersistence's effect fires → persistUiState →
  // localStorage. The store seeds itself from loadUi() at module load, the same
  // persisted read the useState lazy initializers did.
  const onExitBehavior = useOnExitBehavior();
  const setOnExitBehavior = useSetOnExitBehavior();
  // "Auto-focus new pane": whether opening/resuming/splitting a chat moves
  // keyboard focus to the new pane (default true = today's behavior). When false
  // the currently focused pane is preserved — xterm's native click-to-focus lets
  // the user focus a pane on demand. Pure client-side pref (like
  // onExitBehavior/paneLayout): persisted by the saveUi effect below, never sent
  // to the backend. Gates the setFocused call in openChat below. See WARDEN-274.
  //
  // WARDEN-1420 (slice 12): migrated onto the shared store with the rest of the
  // appearance family (see theme above).
  const autoFocusNewPane = useAutoFocusNewPane();
  const setAutoFocusNewPane = useSetAutoFocusNewPane();
  // WARDEN-1322 (slice 3): migrated onto the shared store (see onExitBehavior
  // above) — PaneTile and AppearanceSection subscribe; App subscribes only to
  // keep the persisted snapshot + reset partition whole.
  const terminalFontSize = useTerminalFontSize();
  const setTerminalFontSize = useSetTerminalFontSize();
  // WARDEN-1408 (roadmap WARDEN-1204 slice 11): the attention/notification pair
  // migrated onto the shared store (see onExitBehavior above) — NotificationsSection
  // (the writer), useAttentionRollup's three poller gates and useTokenBudget's
  // OS-notification gate subscribe to it directly, and the DesktopAlertPrefs
  // Settings bag is retired. App subscribes only to keep the persisted snapshot +
  // reset partition whole. The WARDEN-1274 "what the master toggle still gates"
  // note moved with the fact (see UiStoreState in lib/uiStore.ts).
  const attentionDesktopAlerts = useAttentionDesktopAlerts();
  const setAttentionDesktopAlerts = useSetAttentionDesktopAlerts();
  // Per-state Attention toggle (WARDEN-344): which pane states raise the badge.
  // Each defaults ON; persisted by the saveUi effect below and forwarded to the
  // AttentionBadge's useAttentionRollup. Purely a DISPLAY filter on the passive
  // readout since WARDEN-1274 retired the alert. WARDEN-1360: only the states the
  // passive readout can substantiate remain (stuck / done) — erroring / waiting /
  // blocked were substring guesses and their buckets (and knobs) are gone.
  const attentionStates = useAttentionStates();
  const setAttentionStates = useSetAttentionStates();
  // Per-chat watch state + single/bulk toggles + the derived O(1) lookup Set live
  // in useWatchState (WARDEN-696 slice 2). watchedChats is still persisted by the
  // saveUi effect below and wired into the attention rollup (composition root).
  const { watchedChats, clearWatchedChats } = useWatchState({
    initialWatched: uiState.watchedChats ?? [],
  });
  // WARDEN-1322 (slice 3): migrated onto the shared store (see onExitBehavior
  // above).
  const terminalScrollback = useTerminalScrollback();
  const setTerminalScrollback = useSetTerminalScrollback();
  // WARDEN-1322 (slice 3): migrated onto the shared store (see onExitBehavior
  // above). The store seed preserves the truthiness fallback below VERBATIM —
  // DEFAULT_UI.terminalFontFamily is '' (blank = default stack) and a persisted
  // '' must seed the real stack, never '' (a `??`-only seed would let '' reach
  // xterm and blank a pane). The reset deviation documented at
  // resetUiPrefDefaults (this pref resets to DEFAULT_TERMINAL_FONT_FAMILY, not
  // to DEFAULT_UI's '') lives there and is untouched.
  const terminalFontFamily = useTerminalFontFamily();
  const setTerminalFontFamily = useSetTerminalFontFamily();
  // Terminal color scheme: 'auto' follows the effective app theme (above);
  // 'dark'/'light' force the terminal surface. Pure client-side pref (like
  // terminalFontSize/scrollback): persisted by the saveUi effect below, never
  // sent to the backend.
  //
  // WARDEN-1420 (slice 12): migrated onto the shared store with the rest of the
  // appearance family (see theme above). App is still its only RUNTIME reader —
  // it derives terminalThemeId below — but it reads it through the hook now, so
  // no UiState pref rides a Settings props bag any more.
  const terminalColorScheme = useTerminalColorScheme();
  const setTerminalColorScheme = useSetTerminalColorScheme();
  // Terminal cursor style (shape × blink). 'blink-block' is the default (today's
  // exact cursor).
  //
  // WARDEN-1322 (slice 3): migrated onto the shared store (see onExitBehavior
  // above).
  const terminalCursorStyle = useTerminalCursorStyle();
  const setTerminalCursorStyle = useSetTerminalCursorStyle();
  // "Copy on select" (WARDEN-285): when ON, completing a text selection in any
  // agent pane copies it to the clipboard immediately (no Ctrl/Cmd+C). Default
  // OFF = today's exact behavior. Applies LIVE to all open panes (PaneTile
  // mirrors it into a ref its selection handler reads).
  //
  // WARDEN-1322 (slice 3): migrated onto the shared store (see onExitBehavior
  // above).
  const copyOnSelect = useCopyOnSelect();
  const setCopyOnSelect = useSetCopyOnSelect();
  // Timestamp format (WARDEN-213): how every timestamp surface reads — 'relative'
  // (default = "2m"/"3h" buckets) or 'absolute' (clock time). Pure client-side
  // pref (like copyOnSelect/density): persisted by the saveUi effect below,
  // threaded to every timestamp display via the shared formatTimestamp helper,
  // and never sent to the backend.
  // WARDEN-1342 (slice 4): the pref lives on the shared uiStore — same plain-value
  // signatures, so the persistedSnapshot field and the resetSetters entry below
  // are untouched (the slice-3 pattern).
  const timestampFormat = useTimestampFormat();
  const setTimestampFormat = useSetTimestampFormat();
  // WARDEN-442: sidebar fleet Filter (all/yatfa/claude/manual) + Sort, shipped
  // in WARDEN-91. These were ChatSidebar-local useState with their own save
  // effect, which App's saveUi spread (which omits both keys) then clobbered on
  // every unrelated state change — wiping them from disk so the controls reset
  // to 'all'/'manual' on reload. WARDEN-1204 slice 7: the pair lives on the
  // shared client-state store (lib/uiStore.ts) — App SUBSCRIBES for the same
  // two single-writer reasons as every migrated pref (the PersistedPrefSnapshot
  // field below and the resetSetters entry), and ChatSidebar + its three
  // AgentFilterSortControls mounts subscribe directly, so the four JSX pass
  // sites into ChatSidebar are gone. Pure client-side pref; the store seeds
  // itself from loadUi() with the same 'all'/'manual' defaults DEFAULT_UI has.
  const agentFilter = useAgentFilter();
  const setAgentFilter = useSetAgentFilter();
  const agentSort = useAgentSort();
  const setAgentSort = useSetAgentSort();
  // WARDEN-468: HealthDashboard "Group agents by: Health | Host | Project" toggle
  // (WARDEN-237; Project added in WARDEN-741). Was a HealthDashboard-local
  // useState that silently reset to 'health' on every Warden restart. Lifted to
  // App + persisted by the saveUi effect (the single writer), like
  // agentFilter/agentSort above — so a cross-host human's Host grouping
  // survives reload. Pure client-side pref.
  //
  // WARDEN-1426 (roadmap WARDEN-1204 slice 13) — migrated onto the shared
  // uiStore together with healthCollapsedHosts below. HealthDashboard is the
  // pair's ONLY reader and ONLY writer and is mounted in exactly one place, so
  // it SUBSCRIBES directly and the four JSX pass sites into it are gone. App
  // still subscribes for the same two single-writer reasons as `snippets`: the
  // PersistedPrefSnapshot field below and the reset partition's setter. The
  // store seeds itself from loadUi() with the same 'health' default DEFAULT_UI
  // has, through loadUi's own 3-way enum allow-list.
  const healthGroupBy = useHealthGroupBy();
  const setHealthGroupBy = useSetHealthGroupBy();
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
  // App still subscribes for the same two single-writer reasons as `snippets`:
  // (1) the value must appear in the PersistedPrefSnapshot below so the ONE
  // compile-locked saveUi effect keeps writing it, and (2) the reset partition
  // (resetSetters) must keep a setter for it. The write path is unchanged end to
  // end: store.setFileViewerViewMode → this subscription re-renders App → the
  // snapshot's `fileViewerViewMode` changes → useConfigPersistence's effect
  // fires → persistUiState → localStorage. The store seeds itself from loadUi()
  // at module load, the same persisted read the useState lazy initializer did.
  const fileViewerViewMode = useFileViewerViewMode();
  const setFileViewerViewMode = useSetFileViewerViewMode();
  // WARDEN-490 — per-host display labels (friendly names). A raw host string
  // ('(local)' / SSH host) → the human's label, shown in every host-tag display
  // surface. Migrated onto the shared uiStore (roadmap WARDEN-1204 slice 6):
  // App SUBSCRIBES to the fact instead of owning it in a useState — the old
  // context provider and the SettingsPage props channel are gone, and readers
  // plus the HostsSection writer subscribe at lib/uiStore directly.
  // Pure client-side pref (like healthCollapsedHosts/defaultShellByHost):
  // persisted by the saveUi effect below, never sent to the backend /
  // /api/config. An empty map (or a host with no entry) = today's behavior.
  const hostLabels = useHostLabels();
  const setHostLabels = useSetHostLabels();
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
  // subscribes directly, App keeps the snapshot field + the resetSetters entry,
  // and the store's `?? {}` seed reproduces the retired initializer's fallback.
  const healthCollapsedHosts = useHealthCollapsedHosts();
  const setHealthCollapsedHosts = useSetHealthCollapsedHosts();
  // Default agent type + host pre-filled in the ＋ new chat form, plus the
  // user-defined custom presets (named quick-fill commands beyond claude/shell).
  // All pure client-side prefs (like density/terminalFontSize): persisted by the
  // saveUi effect below, never sent to the backend. defaultNewChatPreset is a
  // reserved built-in name ('claude' | 'shell') or a custom preset name.
  //
  // WARDEN-1383 (roadmap WARDEN-1204 slice 8) — the LAST facts migrated off
  // App-owned useState + a second read channel onto the shared client-state
  // store (lib/uiStore.ts), following `snippets` through `agentSort`: the
  // eight new-chats spawn facts (preset + per-host map, host, cwd + per-host
  // map, customPresets, shell + per-host map). NewChatForm (the reader) used
  // to do a PRIVATE `useState(() => loadUi())` here while NewChatsSection
  // (the writer) received the same facts through the NewChatsPrefs bag —
  // one value, two channels. Both now SUBSCRIBE directly, the bag interface
  // is retired, and uiStore.test.mjs's guard keeps `loadUi(` out of
  // web/src/components/ so the invariant is enforced, not remembered.
  //
  // App still subscribes for the same two single-writer reasons as `snippets`:
  // (1) each value must appear in the PersistedPrefSnapshot below so the ONE
  // compile-locked saveUi effect keeps writing it, and (2) the reset partition
  // (resetSetters) must keep a setter for each. The write path is unchanged end
  // to end: store.setX → this subscription re-renders App → the snapshot's
  // field changes → useConfigPersistence's effect fires → persistUiState →
  // localStorage. The store seeds itself from loadUi() at module load, the same
  // persisted read the useState lazy initializers did.
  const defaultNewChatPreset = useDefaultNewChatPreset();
  const setDefaultNewChatPreset = useSetDefaultNewChatPreset();
  const defaultNewChatHost = useDefaultNewChatHost();
  const setDefaultNewChatHost = useSetDefaultNewChatHost();
  const defaultNewChatCwd = useDefaultNewChatCwd();
  const setDefaultNewChatCwd = useSetDefaultNewChatCwd();
  const defaultNewChatCwdByHost = useDefaultNewChatCwdByHost();
  const setDefaultNewChatCwdByHost = useSetDefaultNewChatCwdByHost();
  const defaultNewChatPresetByHost = useDefaultNewChatPresetByHost();
  const setDefaultNewChatPresetByHost = useSetDefaultNewChatPresetByHost();
  const customPresets = useCustomPresets();
  const setCustomPresets = useSetCustomPresets();
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
  // App still subscribes, for exactly two reasons — both of them the
  // single-writer persistence design, which this slice deliberately does NOT
  // touch: (1) the value must appear in the PersistedPrefSnapshot below so the
  // ONE compile-locked saveUi effect keeps writing it, and (2) the reset
  // partition (resetSetters) must keep a setter for it. So the write path is
  // unchanged end to end: store.setSnippets → this subscription re-renders App
  // → the snapshot's `snippets` changes identity → useConfigPersistence's
  // effect fires → persistUiState → localStorage. The store seeds itself from
  // loadUi() at module load, which is the same persisted read the useState
  // lazy initializer did.
  const snippets = useSnippets();
  const setSnippets = useSetSnippets();
  // Default shell opened by BOTH the ＋ new-chat *shell* preset and the ＋ split
  // button (WARDEN-429 — unifies the prior split-only defaultSplitShell, migrated
  // into defaultShell on load). Blank means "no explicit shell" → the host
  // launches its own login shell. Pure client-side pref (like the new-chat prefs
  // above): persisted by the saveUi effect below, never sent to the backend.
  // Store-backed since WARDEN-1383 (slice 8) like the rest of the spawn family.
  const defaultShell = useDefaultShell();
  const setDefaultShell = useSetDefaultShell();
  // Per-host default-shell overrides (WARDEN-429 — mirrors the cwd/preset maps
  // above). Keys are host strings ('(local)' / SSH host name); a host with no
  // entry (or an empty value, dropped on load) falls through to defaultShell,
  // then blank (host login shell). Pure client-side pref like defaultShell
  // above: persisted by the saveUi effect below, never sent to the backend.
  const defaultShellByHost = useDefaultShellByHost();
  const setDefaultShellByHost = useSetDefaultShellByHost();
  // "Remember window position and size" is an Electron-main-owned pref, NOT a
  // renderer localStorage pref like the ones above: the OS window bounds must be
  // readable at createWindow() time (before this renderer loads), so the flag +
  // bounds live in main's window-state.json and are read/written through the IPC
  // bridge in electron.ts. This React state is only a display mirror — main's
  // file is the source of truth — so it is deliberately NOT part of UiState or
  // the saveUi effect. Defaults to true; loads from main on mount (a no-op that
  // stays true in a plain browser where the bridge is absent). See WARDEN-263.
  const [rememberWindowBounds, setRememberWindowBoundsState] = useState(true);
  // "Launch Warden at login" is the sibling Electron-main-owned pref: the OS
  // (not Warden's own file) is the source of truth, read/written via the IPC
  // bridge in electron.ts. As with remember-bounds, this React state is only a
  // display mirror and is deliberately NOT part of UiState or the saveUi effect.
  // Defaults to FALSE (consent — auto-start modifies the OS login items, so it
  // is more invasive than restoring bounds); loads from main on mount (a no-op
  // that stays false in a plain browser where the bridge is absent). See
  // WARDEN-278.
  const [launchAtLogin, setLaunchAtLoginState] = useState(false);
  // "Close to tray" preference (default OFF, opt-in). When ON, closing the
  // window hides it to a system-tray icon instead of quitting, keeping the
  // backend (and renderer-side desktop alerts) alive while the window is closed.
  // Same display-mirror / write-through pattern as launch-at-login — NOT part of
  // UiState / saveUi. Loads from main on mount (stays false in a browser where
  // the bridge is absent). See WARDEN-330.
  const [closeToTray, setCloseToTrayState] = useState(false);
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
    streamApi.onOpen = () => setStreamConn(true);
    streamApi.onClose = () => setStreamConn(false);
    streamApi.onAnyMessage = (m) => {
      if (m.type === 'pty' && m.id !== focusedRef.current) {
        setNewActivity((prev) => { if (prev.has(m.id)) return prev; const n = new Set(prev); n.add(m.id); return n; });
      }
    };
    streamApi.connect();
    refresh();
    refreshConfigPrefs();
    // Load the main-owned "remember window bounds" flag (no-op in a browser;
    // stays at the true default when the IPC bridge is absent). WARDEN-263.
    void getRememberWindowBounds().then(setRememberWindowBoundsState);
    // Load the main-owned "launch at login" flag (no-op in a browser; stays at
    // the false default when the IPC bridge is absent). WARDEN-278.
    void getLaunchAtLogin().then(setLaunchAtLoginState);
    // Load the main-owned "close to tray" flag (no-op in a browser; stays at the
    // false default when the IPC bridge is absent). WARDEN-330.
    void getCloseToTray().then(setCloseToTrayState);

    // Check for activity since last close — the "While you were away" return
    // digest. The RETURN trigger (returnedAfterAbsence) fires whenever >60s
    // elapsed since warden:lastClose, REGARDLESS of whether any activity events
    // occurred: WARDEN-436 broadened the banner so it also surfaces the ranked
    // "you're needed HERE" callout (current rollup state) even when nothing
    // happened while away. The since-close event tally is fetched separately and
    // shown as secondary context beneath the callout. (The actual show/hide is
    // derived in render from returnedAfterAbsence + hasReturnContent.)
    const checkActivitySinceClose = async () => {
      const lastCloseStr = localStorage.getItem('warden:lastClose');
      if (lastCloseStr) {
        const lastClose = parseInt(lastCloseStr, 10);
        const now = Date.now();
        if (now - lastClose > 60000) { // Only show if closed for more than 1 minute
          setReturnedAfterAbsence(true);
          try {
            const res = await fetch(`/api/activity/stats?after=${new Date(lastClose).toISOString()}`);
            const stats = await res.json();
            if (stats.total > 0) {
              setActivitySinceClose(stats);
            }
          } catch (e) {
            console.error('Failed to fetch activity stats:', e);
          }
        }
      }
    };
    checkActivitySinceClose();

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
      streamApi.onOpen = null;
      streamApi.onClose = null;
      streamApi.onAnyMessage = null;
      window.removeEventListener('beforeunload', handleBeforeUnload);
      handleBeforeUnload();
    };
  }, []);

  // clear "new" badge when a pane becomes focused
  useEffect(() => {
    if (focused) setNewActivity((prev) => { if (!prev.has(focused)) return prev; const n = new Set(prev); n.delete(focused); return n; });
  }, [focused]);

  // Per-agent "lastSeen" stamp (WARDEN-356): the moment a pane is focused is the
  // moment the human is looking at THAT agent — so it's the natural point to
  // reset its per-agent catch-up clock. Mirrors the fleet-wide warden:lastClose
  // stamp (written on close, read on the "While you were away" banner): same
  // String(Date.now()) shape, but keyed per chatId so the "What's new since"
  // marker + view answer "what did THIS agent change since I was last here?"
  // rather than "since the whole app closed." Opening the pane (openChat below)
  // stamps too, so a visit counts even when autoFocusNewPane is OFF (open without
  // focus). localStorage-only — never sent to the backend, matching lastClose.
  useEffect(() => {
    if (focused) stampLastSeen(focused);
  }, [focused]);

  // apply theme on mount and when theme changes (theme itself persists via the
  // single compile-locked saveUi effect in useConfigPersistence)
  useEffect(() => {
    // Apply theme immediately: sets the [data-theme] attribute (selecting the
    // matching CSS token block) and toggles `.dark` from the theme's mode.
    applyTheme(theme);
    // Keep the resolved concrete theme id in sync so the terminal pane (which
    // derives its xterm palette from it) follows a manual theme change live.
    setResolvedThemeId(resolveThemeId(theme));

    // If system mode, listen for system theme changes. The `theme` state stays
    // 'system' here (chrome re-paints via applyTheme's direct DOM attribute set),
    // but we ALSO push the OS-resolved theme id into React state so the terminal
    // surface — which re-themes imperatively in PaneTile — live-updates on an OS
    // flip (nuance #1).
    if (theme === 'system') {
      const cleanup = listenSystemThemeChange((id) => {
        applyTheme('system');
        setResolvedThemeId(id);
      });
      return cleanup;
    }
  }, [theme]);

  // apply density on mount and when density changes (persisted via the saveUi effect below)
  useEffect(() => {
    applyDensity(density);
  }, [density]);

  // The persisted-pref snapshot assembled here (App is the composition root) and
  // passed to useConfigPersistence, which owns the saveUi WRITE effect +
  // handleConfigChange (WARDEN-696). Typed as PersistedPrefSnapshot — bidirectionally
  // locked to PERSISTED_PREF_KEYS (a key in the source but missing here is a
  // missing-property compile error; a key here but absent from the source is an
  // excess-property error). This single type-checked list replaced the two
  // duplicated UNCHECKED hand-lists that caused WARDEN-442/468/500.
  const persistedSnapshot: PersistedPrefSnapshot = {
    workspaces, activeWorkspaceId, sidebarCollapsed, observerCollapsed,
    healthCollapsed, sourceControlCollapsed, sidebarWidth, observerWidth,
    terminalFontSize, attentionDesktopAlerts, attentionStates,
    watchedChats, terminalScrollback, terminalFontFamily, terminalColorScheme,
    terminalCursorStyle, copyOnSelect, timestampFormat, theme, density, paneLayout,
    paneColRatios, paneRowRatios,
    onExitBehavior, autoFocusNewPane, paneHost, defaultNewChatPreset,
    defaultNewChatPresetByHost, defaultNewChatHost, defaultNewChatCwd,
    defaultNewChatCwdByHost, customPresets, snippets, defaultShell, defaultShellByHost,
    agentFilter, agentSort, healthGroupBy, fileViewerViewMode, healthCollapsedHosts,
    hostLabels,
  };

  // Reset maximized when switching workspaces: a maximized pane belongs to its
  // workspace, so switching clears it (WARDEN-256: maximized resets on switch).
  useEffect(() => { setMaximized(null); }, [activeWorkspaceId]);

  // keyboard shortcut for global search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'F') {
        e.preventDefault();
        setShowGlobalSearch(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

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
      setLastRefreshAt(Date.now());
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
  // WRITE effect + this callback live in useConfigPersistence (WARDEN-696); the
  // snapshot above is assembled here (composition root) and passed in. This call
  // sits AFTER refresh/refreshConfigPrefs/reloadNotificationPrefs are defined so
  // the deps are initialized (no TDZ).
  const { handleConfigChange } = useConfigPersistence({
    persistedSnapshot,
    restoreOnStartup,
    startedEmpty,
    refresh,
    reloadNotificationPrefs,
    refreshConfigPrefs,
  });

  // Write-through setters for the three main-owned prefs: update the display
  // mirror optimistically, persist to main via IPC, then RECONCILE the mirror
  // with what main actually did. Main's set handlers return what happened, not
  // what was asked (it refuses close-to-tray with no working tray, and re-reads
  // the OS for launch-at-login), so a discarded return left the switch reading
  // ON while the feature was OFF — see lib/mainOwnedPref.ts and WARDEN-973.
  // In a browser the bridge is absent and lib/electron.ts echoes the passed
  // value, so the refusal branch is unreachable there (no spurious toast); the
  // switches are `disabled={!hasWindowBridge()}` besides. All three keep empty
  // deps so the SettingsPage prop identity doesn't churn on every poll tick
  // (matching the other stable setters passed down). WARDEN-263/278/330.
  const setRememberWindowBounds = useCallback((v: boolean) => {
    void reconcileMainOwnedPref(v, persistRememberWindowBounds, setRememberWindowBoundsState, () => {
      toast.error("Couldn't save that preference.");
    });
  }, []);

  const setLaunchAtLogin = useCallback((v: boolean) => {
    void reconcileMainOwnedPref(v, persistLaunchAtLogin, setLaunchAtLoginState, () => {
      toast.error("Couldn't set Launch at login — your OS didn't accept the change. On Linux this depends on your desktop environment.");
    });
  }, []);

  const setCloseToTray = useCallback((v: boolean) => {
    void reconcileMainOwnedPref(v, persistCloseToTray, setCloseToTrayState, () => {
      toast.error("Couldn't enable Close to tray — this desktop has no working system tray, so closing the window would leave Warden with no way to reopen it.");
    });
  }, []);

  // Reset every UI PREF to its effective default value (the value loadUi()
  // yields post-coercion, so live React state / persisted state / a fresh
  // reload all agree) while leaving the WORKSPACE + panel layout untouched.
  // What survives is exactly RESET_PRESERVED_KEYS (storage.ts) — the single
  // source of truth for the preserved set; see WARDEN-346. The setters fire
  // the existing saveUi effect, which persists defaults-for-prefs + preserved-
  // workspace via persistUiState. Pure client-side: never touches the backend
  // / config.json (display/terminal/new-chat prefs are client-side only by
  // design).
  //
  // WARDEN-934: this used to be a hand-enumerated list of ~35 setter calls
  // guarded only by a comment asserting it was complete — and it had already
  // drifted. fileViewerViewMode (WARDEN-480) was never reset, so "Reset UI
  // preferences" toasted success and left the File Viewer stuck in Source
  // forever. The classification is now DERIVED from one compile-enforced key
  // source, exactly like the persist path (PERSISTED_PREF_KEYS →
  // PersistedPrefSnapshot, which closed the identical WARDEN-442/468/500
  // drift):
  //
  //   ResettableKey = (PERSISTED_PREF_KEYS ∪ restoreOnStartup) − RESET_PRESERVED_KEYS
  //
  // and BOTH maps are keyed by it — resetUiPrefDefaults() (storage.ts) for the
  // values, resetSetters below for the state setters. A pref that is neither
  // listed in RESET_PRESERVED_KEYS nor given a default + setter is a TypeScript
  // error; the storage.test.mjs exhaustiveness test covers the runtime half.
  //
  // The two things the types can NOT say:
  //   - terminalFontFamily resets to DEFAULT_TERMINAL_FONT_FAMILY (the curated
  //     "System default" value), NOT DEFAULT_UI.terminalFontFamily (''). The
  //     persisted shape uses '' (blank = default stack), but the live value is
  //     seeded with the same truthiness fallback ('' →
  //     DEFAULT_TERMINAL_FONT_FAMILY, now in uiStore's createUiStore since
  //     WARDEN-1322 — formerly App's useState initializer) so a pane can never
  //     blank. Setting live
  //     state to '' here would leave the Settings font-select showing "Custom…"
  //     (no '' option in the curated list) until reload.
  //   - User-curated lists (customPresets/snippets/watchedChats)
  //     reset too: this is a destructive, confirm-gated "back to factory
  //     defaults", consistent with customPresets → [].
  //
  // Identity is stable because every value it closes over is: the useState
  // setters are stable by React contract, clearWatchedChats is a
  // useCallback(..., []) (useWatchState.ts), and setSnippets /
  // setFileViewerViewMode — plus the six terminal setters this reset covers
  // since WARDEN-1322 (setTerminalFontSize/setTerminalScrollback/
  // setTerminalFontFamily/setTerminalCursorStyle/setCopyOnSelect/
  // setOnExitBehavior), the attention pair since WARDEN-1408
  // (setAttentionDesktopAlerts/setAttentionStates), and the six appearance
  // prefs since WARDEN-1420 (setTheme/setDensity/setPaneLayout/
  // setAutoFocusNewPane/setRestoreOnStartup/setTerminalColorScheme) — are
  // zustand actions created once with the store (lib/uiStore.ts) — so listing
  // them in the dep array below costs nothing and keeps the lint rule satisfied
  // honestly rather than by suppression.
  //
  // The health pair's setters (setHealthGroupBy/setHealthCollapsedHosts, since
  // WARDEN-1426) are zustand actions on exactly the same terms, so the dep
  // array is left UNCHANGED for them: a store action's identity never varies,
  // so an unlisted one cannot go stale. They join the several store-backed
  // setters the array already omits for that reason (the standing
  // exhaustive-deps warning here is about those, and this slice neither adds to
  // it nor resolves it).
  const resetUiPrefsToDefaults = useCallback(() => {
    const resetSetters: { [K in ResettableKey]: (value: ResetUiDefaults[K]) => void } = {
      // Appearance
      theme: setTheme,
      density: setDensity,
      paneLayout: setPaneLayout,
      // Behavior
      onExitBehavior: setOnExitBehavior,
      autoFocusNewPane: setAutoFocusNewPane,
      restoreOnStartup: setRestoreOnStartup,
      copyOnSelect: setCopyOnSelect,
      timestampFormat: setTimestampFormat,
      // File Viewer markdown view mode (WARDEN-480) — the WARDEN-934 omission.
      fileViewerViewMode: setFileViewerViewMode,
      // Sidebar fleet filter/sort (WARDEN-442), health grouping (WARDEN-468),
      // per-host collapse (WARDEN-500), per-host display labels (WARDEN-490).
      agentFilter: setAgentFilter,
      agentSort: setAgentSort,
      healthGroupBy: setHealthGroupBy,
      healthCollapsedHosts: setHealthCollapsedHosts,
      hostLabels: setHostLabels,
      // Terminal
      terminalFontSize: setTerminalFontSize,
      terminalScrollback: setTerminalScrollback,
      terminalFontFamily: setTerminalFontFamily,
      terminalColorScheme: setTerminalColorScheme,
      terminalCursorStyle: setTerminalCursorStyle,
      // New chats
      defaultNewChatPreset: setDefaultNewChatPreset,
      defaultNewChatPresetByHost: setDefaultNewChatPresetByHost,
      defaultNewChatHost: setDefaultNewChatHost,
      defaultNewChatCwd: setDefaultNewChatCwd,
      defaultNewChatCwdByHost: setDefaultNewChatCwdByHost,
      customPresets: setCustomPresets,
      snippets: setSnippets,
      defaultShell: setDefaultShell,
      defaultShellByHost: setDefaultShellByHost,
      // Attention / desktop alerts
      attentionDesktopAlerts: setAttentionDesktopAlerts,
      attentionStates: setAttentionStates,
      // watchedChats lives in useWatchState, which exposes a clear() rather than a
      // raw setter — the reset value is always [] (see resetUiPrefDefaults).
      watchedChats: () => clearWatchedChats(),
    };
    const defaults = resetUiPrefDefaults();
    // The per-key types are locked by the two maps above; TS cannot correlate
    // them across a dynamic index, so the call site casts once.
    for (const key of Object.keys(defaults) as ResettableKey[]) {
      (resetSetters[key] as (value: unknown) => void)(defaults[key]);
    }

    // WARDEN-981 — the Observer panel's prefs are the one resettable view state
    // OUTSIDE UiState: ObsUi / warden:observer:v1, behind its own loadObs/
    // saveObs. Two halves, deliberately separated:
    //   1. DISK: rewrite the stored payload with the 4 pref fields defaulted
    //      (resetObsPrefsPreservingWorkspace keeps openIds/activeId — which
    //      observer sessions are open is workspace state, exactly like
    //      workspaces/activeWorkspaceId above). This is the half the shipped
    //      flow rides: the full-page Settings view unmounts the dashboard, and
    //      ObserverTabs re-seeds its viewMode/filter useState from loadObs() on
    //      remount — so the panel returns from Settings already reset.
    //   2. LIVE: bump the nonce ObserverTabs watches, so a panel that IS
    //      mounted when the reset fires snaps viewMode + the 7 filter states to
    //      defaults in place (they are component-local useState seeded once at
    //      mount; without the signal a mounted panel would keep rendering the
    //      old tab/filters). Monotonic counter → back-to-back resets are always
    //      distinct values, immune to the same-value bailout.
    // setObserverResetToken is a useState setter (stable identity by React
    // contract), so it joins clearWatchedChats outside the dep array.
    saveObs(resetObsPrefsPreservingWorkspace(loadObs()));
    setObserverResetToken((t) => t + 1);
  }, [clearWatchedChats, setSnippets, setFileViewerViewMode, setTerminalFontSize, setTerminalScrollback, setTerminalFontFamily, setTerminalCursorStyle, setCopyOnSelect, setOnExitBehavior, setAttentionDesktopAlerts, setAttentionStates, setTheme, setDensity, setPaneLayout, setAutoFocusNewPane, setRestoreOnStartup, setTerminalColorScheme]);

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
  // preserved (click-to-focus still works via xterm's native focus). Adding
  // autoFocusNewPane to the deps rebuilds this callback (and its callers) when
  // the pref toggles — a rare, deliberate action.
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
    // WARDEN-356: opening the pane counts as a visit to THIS agent — reset its
    // per-agent lastSeen so the "What's new since" marker reflects work landed
    // after THIS open. Stamped before the workspace search below so a visit
    // counts whether the pane is newly opened OR switched-to from another
    // workspace. When autoFocusNewPane is ON the focus effect also stamps
    // (idempotent — both write Date.now()); this line guarantees the stamp
    // happens even when opening doesn't steal focus (autoFocusNewPane OFF).
    stampLastSeen(id);
    // remember this pane's host so a restored remote pane knows which host to discover
    const c = chatsRef.current.find((x) => (x.key || x.id) === id);
    if (c?.host) setPaneHost((p) => (p[id] === c.host ? p : { ...p, [id]: c.host }));
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
    const owner = workspacesRef.current.find((w) => w.openPanes.includes(id));
    if (owner) {
      if (owner.id !== activeWorkspaceIdRef.current) setActiveWorkspaceId(owner.id);
      if (autoFocusNewPane) setWorkspaces((prev) => prev.map((w) => (w.id === owner.id && w.focused !== id ? { ...w, focused: id } : w)));
      // WARDEN-1422 (QA round 5): resume = "click reconnects to the live tmux
      // session". When the click hits a pane OPEN but stuck in session_dead
      // (e.g. the session was respawned from the sidebar after the pane died,
      // or the row still reads WORKING while the pane shows the dead panel),
      // focus alone leaves the dead recovery panel on screen — bump the pane's
      // reconnect token so it re-attaches now. Any other phase (connecting,
      // connected, host_unreachable, error) is never disturbed: those have
      // their own recovery affordances and a live pane must not flicker.
      if (resumeShouldReattach(panePhaseRef.current[id])) {
        setReconnectTokens((prev) => bumpReconnectToken(prev, id));
      }
      return;
    }
    // Otherwise add to the active workspace + focus it.
    setOpenPanes((p) => p.includes(id) ? p : [...p, id]);
    if (autoFocusNewPane) setFocused(id);
  }, [autoFocusNewPane, setOpenPanes, setFocused]);

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
  useEffect(() => {
    setTelemetryContext({ chatName: focusedChat?.name });
  }, [focusedChat?.name]);
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
        const ws = workspacesRef.current;
        const activeId = activeWorkspaceIdRef.current;
        const active = ws.find((w) => w.id === activeId) ?? ws[0] ?? null;
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
  // WARDEN-1408 (slice 11): the persisted prefs the rollup gates on (the
  // desktop-alerts opt-in + per-state filters) are subscribed INSIDE the hook
  // from the shared store now — the runtime inputs (openPanes, watchedChats,
  // onOpenChat, focusedPaneKey) stay explicit, exactly as they always were.
  const { rollup: attentionRollup, watchedStates: watchedAgentStates } = useAttentionRollup(
    openPanes, watchedChats, openChat, focusedPaneKey,
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
  // The single directed "you're needed HERE, because X" answer — the banner's lead.
  // top is null when no pane/health agent currently needs attention (only raw
  // directive/error counts, which have no pane to deep-link). Recomputed only when
  // the rollup reference changes (the hook's own useMemo already stabilizes it).
  const attentionTop = useMemo<AttentionItem | null>(
    () => rankAttention(attentionRollup).top,
    [attentionRollup],
  );
  // The since-close activity tally — STABLE: fetched once on mount
  // (checkActivitySinceClose), never re-fetched, so it can't drive a later pop-in.
  const activityTotalSinceClose = activitySinceClose?.total ?? 0;

  // ── Return-banner visibility: a windowed latch (WARDEN-436 conservative constraint)
  //
  // The banner may FIRST appear only within RETURN_BANNER_WINDOW_MS of the human
  // returning. Once it has appeared it stays until dismissed; if the fleet was
  // healthy at return and nothing surfaced within the window, it NEVER appears.
  // This keeps the banner a strictly user-initiated RETURN digest, never an ambient
  // surface: a pane that becomes stuck/critical LATER (well after return, mid-work)
  // updates the header AttentionBadge — NOT a spontaneous full-width banner.
  //
  // Within the window the banner DISPLAYS the LIVE attentionTop ("needed right now",
  // per WARDEN-427 decision #3): if the rollup is cold at first paint the callout
  // fills in as the first poll resolves, falling back to the tally alone. Intended
  // tradeoff (review nit): because the latch watches the LIVE top, a pane that turns
  // stuck/critical up to ~30s AFTER return can surface in the banner mid-work. This
  // is bounded (one window, strictly return-initiated) and is the cost of decision
  // #3 wanting live "needed right now" state to fill in rather than a strictly
  // at-return-instant snapshot.
  const [returnWindowActive, setReturnWindowActive] = useState(false);
  const [bannerShownOnce, setBannerShownOnce] = useState(false);
  useEffect(() => {
    if (!returnedAfterAbsence) return;
    // Open the return window once the return is detected.
    setReturnWindowActive(true);
    const timer = window.setTimeout(() => setReturnWindowActive(false), RETURN_BANNER_WINDOW_MS);
    return () => window.clearTimeout(timer);
  }, [returnedAfterAbsence]);
  useEffect(() => {
    // Latch "shown" the first time content appears WHILE the return window is open.
    // The latch is what freezes the decision: after the window, a newly-non-null
    // attentionTop can no longer trigger the banner (returnWindowActive is false).
    if (returnWindowActive && !bannerShownOnce && hasReturnContent(activityTotalSinceClose, attentionTop)) {
      setBannerShownOnce(true);
    }
  }, [returnWindowActive, bannerShownOnce, activityTotalSinceClose, attentionTop]);
  const showReturnBanner = bannerShownOnce && !bannerDismissed;

  // Seamless cross-host resume: when an observer session bound to an agent is
  // opened, reconnect to that agent's chat. We prime the pane's host hint and
  // (for remote hosts) discover the host so the pane can attach, then open the
  // chat — so the user never has to manually navigate to the right host.
  const handleReconnectChat = useCallback((chatKey: string, host?: string | null) => {
    if (host && host !== '(local)') {
      setPaneHost((p) => (p[chatKey] === host ? p : { ...p, [chatKey]: host }));
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
    setPaneHost((p) => (p[paneId] === hostOf ? p : { ...p, [paneId]: hostOf }));
    openChat(paneId);
    return true;
  }, [defaultShell, defaultShellByHost, refresh, openChat, prefs.notifyErrors, setPaneHost]);

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
      setPaneHost((p) => (p[paneId] === hostOf ? p : { ...p, [paneId]: hostOf }));
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
    setReconnectTokens((prev) => bumpReconnectToken(prev, id));
    if (prefs.notifyChatOps) toast.success('Session respawned — a fresh process under the same name');
  }, [discoverHost, prefs.notifyErrors, prefs.notifyChatOps]);

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
    setWorkspaces((prev) => prev.map((w) => ({ ...w, recentlyClosed: (w.recentlyClosed ?? []).filter((e) => e.id !== id) })));
    markRecentlySaved(chat.key || chat.id);
    void refresh();
    if (host) void discoverHost(host).catch(() => {});
    if (prefs.notifyChatOps) toast.success(`Saved — it is listed under ${host || 'its host'}`);
  }, [discoverHost, markRecentlySaved, refresh, prefs.notifyErrors, prefs.notifyChatOps]);

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
    // WARDEN-521: drop the maximized id when the maximized pane itself leaves the
    // grid, else it goes stale and the grid blanks until a workspace switch. A
    // NON-maximized pane closing while another is maximized leaves the id intact.
    setMaximized((m) => (m === id ? null : m));
  }, [setOpenPanes, setFocused, pushRecentlyClosed]);
  // remove the pane only (no recently-closed entry) — used by the KILL flow, since
  // a killed chat's tmux session is destroyed and is not safely reopenable.
  const removeActive = useCallback((id: string) => {
    setOpenPanes((p) => p.filter((x) => x !== id));
    setFocused((f) => (f === id ? null : f));
    // WARDEN-521: same stale-maximized guard as closePane — killing the maximized
    // pane must restore the grid, not blank it.
    setMaximized((m) => (m === id ? null : m));
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
    const entry = workspacesRef.current.find((w) => w.id === activeWorkspaceIdRef.current)?.recentlyClosed?.find((e) => e.id === id);
    if (entry?.host) setPaneHost((p) => (p[id] === entry.host ? p : { ...p, [id]: entry.host! }));
    updateActiveWorkspace((w) => ({
      ...w,
      recentlyClosed: (w.recentlyClosed ?? []).filter((e) => e.id !== id),
    }));
    openChat(id);
  }, [updateActiveWorkspace, openChat, setPaneHost]);
  const toggleMax = useCallback((id: string) => setMaximized((m) => (m === id ? null : id)), []);
  // Stable toggles for keyboard shortcuts: useCallback with functional updates gives
  // them empty deps and a stable identity, so PaneGrid's keydown effect doesn't
  // tear down/re-subscribe on every App render (matching every other PaneGrid handler).
  const toggleSidebar = useCallback(() => setSidebarCollapsed((c) => !c), []);
  const toggleObserver = useCallback(() => setObserverCollapsed((c) => !c), []);
  const clearNew = useCallback((id: string) => setNewActivity((prev) => { if (!prev.has(id)) return prev; const n = new Set(prev); n.delete(id); return n; }), []);

  // The destructive-action gate BOTH kill machines consult. One predicate, two
  // useConfirmTarget call sites below — the close-workspace machine deliberately
  // passes none (see its comment).
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

  const openActivityTab = useCallback(() => {
    setObserverCollapsed(false);
    setExternalViewMode('activity');
  }, []);

  // WARDEN-880 — externalViewMode is a ONE-SHOT command ObserverTabs consumes after
  // applying, then calls this to reset it to null. Without the reset, a 2nd
  // openActivityTab() finds externalViewMode already 'activity' (React same-value
  // bailout → no re-render → ObserverTabs' on-change effect never fires → the click
  // is a silent no-op). null between deep-links also keeps manual tab switches from
  // being yanked back. Stable identity (useCallback, []) so ObserverTabs' effect deps
  // are stable and it does not re-run every App render.
  const consumeExternalViewMode = useCallback(() => setExternalViewMode(null), []);

  // Focus a pane from global search / observer — routed through openChat so a
  // pane already open in another workspace switches there instead of duplicating.
  const handleFocusPane = useCallback((id: string) => {
    openChat(id);
  }, [openChat]);

  const handleJumpToMatch = useCallback((id: string, query: string) => {
    openChat(id);
    setExternalSearchQuery({ paneId: id, query });
  }, [openChat]);

  // --- Multi-workspace operations (WARDEN-256) --------------------------------
  // Switching is instant and remembers the focused pane per workspace (focused
  // lives inside each workspace). Each op keeps ≥1 workspace and dedups pane ids
  // across workspaces. Underlying chats/tmux sessions are never affected by a
  // move — only which workspace's grid the pane renders in.
  const selectWorkspace = useCallback((id: string) => {
    setActiveWorkspaceId(id);
  }, []);

  // Create a new workspace, optionally seeded with a moved pane. Default name
  // "Workspace N" where N is the new count; renameable via the tab strip.
  const createWorkspace = useCallback((seedPaneId?: string) => {
    const id = globalThis.crypto?.randomUUID?.() ?? `ws-${Math.random().toString(36).slice(2)}`;
    setWorkspaces((prev) => [...prev, { id, name: `Workspace ${prev.length + 1}`, openPanes: seedPaneId ? [seedPaneId] : [], focused: seedPaneId ?? null, recentlyClosed: [] }]);
    setActiveWorkspaceId(id);
    return id;
  }, []);

  const renameWorkspace = useCallback((id: string, name: string) => {
    const trimmed = name.trim();
    setWorkspaces((prev) => prev.map((w) => (w.id === id ? { ...w, name: trimmed || w.name } : w)));
  }, []);

  // Move a pane to an existing workspace (drag a pane tile onto a workspace tab):
  // remove from its current workspace, add to the target, switch to the target.
  const movePaneToWorkspace = useCallback((paneId: string, targetWorkspaceId: string) => {
    setWorkspaces((prev) => {
      const target = prev.find((w) => w.id === targetWorkspaceId);
      if (!target) return prev;
      return prev.map((w) => {
        if (w.id === targetWorkspaceId) {
          if (w.openPanes.includes(paneId)) return w; // already there
          return { ...w, openPanes: [...w.openPanes, paneId], focused: paneId };
        }
        if (w.openPanes.includes(paneId)) {
          const remaining = w.openPanes.filter((x) => x !== paneId);
          return { ...w, openPanes: remaining, focused: w.focused === paneId ? (remaining[0] ?? null) : w.focused };
        }
        return w;
      });
    });
    setActiveWorkspaceId(targetWorkspaceId);
  }, []);

  // Drop a pane on the ＋ button → new workspace containing it, then switch.
  // Mirrors movePaneToWorkspace's source-focus handling: when the dragged pane
  // was the focused one, fall back to the source workspace's first remaining
  // pane (not null) so that workspace never shows a visible-but-unfocused pane.
  const movePaneToNewWorkspace = useCallback((paneId: string) => {
    setWorkspaces((prev) => prev.map((w) => {
      if (!w.openPanes.includes(paneId)) return w;
      const remaining = w.openPanes.filter((x) => x !== paneId);
      return { ...w, openPanes: remaining, focused: w.focused === paneId ? (remaining[0] ?? null) : w.focused };
    }));
    createWorkspace(paneId);
  }, [createWorkspace]);

  // Close a workspace: removes its panes from the grid only; the chats stay in
  // the sidebar catalog and can be reopened. At least one workspace always
  // remains. Gated by a confirm dialog (requestCloseWorkspace opens it). The
  // active-id switch is computed from the ref OUTSIDE the workspaces updater so
  // that updater stays pure (no setState-in-updater side effect).
  const closeWorkspace = useCallback((id: string) => {
    const remaining = workspacesRef.current.filter((w) => w.id !== id);
    if (!remaining.length) return; // never drop below one workspace
    setWorkspaces(remaining);
    if (activeWorkspaceIdRef.current === id) setActiveWorkspaceId(remaining[0].id);
  }, []);

  // Pending-target confirm machine for the close above. NOTE: no gate predicate
  // is passed — unlike the two kill machines, closing a workspace is NOT
  // destructive (its panes leave the grid but the chats stay in the sidebar
  // catalog and can be reopened), so the dialog is unconditional by design.
  // That asymmetry is deliberate and load-bearing (WARDEN-1239 out-of-scope).
  const {
    target: workspaceCloseTarget,
    request: requestCloseWorkspace,
    confirm: confirmCloseWorkspace,
    cancel: cancelCloseWorkspace,
  } = useConfirmTarget(closeWorkspace);


  // WARDEN-514: per-key CURRENT-state lookup for the watched rows — so a watched chat
  // that needs the human right now (waiting/erroring/stuck/blocked) shows a persistent,
  // state-aware indicator on its own row even when its pane is closed (the header
  // AttentionBadge is open-gated, so a watched-but-CLOSED pane never reaches it). Built
  // from the rollup's already-fetched `watchedStates` exposure (the watched subset incl.
  // closed panes, pre-open-filter — useAttentionRollup), so this adds ZERO SSH cost: it
  // rides the same open ∪ watched ~30s poll. keyed by row.key ?? row.id — the same key
  // space watchedChats/openPanes use. Recomputed each render (mirrors watchedChatSet).
  // WARDEN-1422: the per-key watched-state map the sidebar rows used to render
  // (indexByWatchKey(watchedAgentStates)) is gone with the row indicators; the
  // rollup itself still feeds the header badge, and useWatchCatchup still reads
  // watchedAgentStates directly.
  const tiles = openPanes.map((id) => ({ id }));
  // Resolved terminal theme id (which named theme's xterm palette to use).
  // 'auto' defers to the active (OS-resolved) app theme; 'dark'/'light' force it
  // to the system default dark/light theme. Recomputed every render so a manual
  // theme change — and, critically, an OS theme flip while the app theme =
  // "System" (which updates resolvedThemeId via listenSystemThemeChange) —
  // changes this prop and re-themes already-open panes live via PaneTile's effect.
  const terminalThemeId = resolveTerminalThemeId(terminalColorScheme, resolvedThemeId);
  // focusedChat + focusedPaneKey are derived above the lifted useAttentionRollup
  // call (WARDEN-426/436); focusedChat is reused below for the observer bind.
  // Selectable host list for the Open Chat browser's multiselect chips: this
  // machine plus every configured SSH host.
  const hosts = [THIS_MACHINE, ...sshHosts];

  const [settingsOpen, setSettingsOpen] = useState(false);
  // WARDEN-1280 — the application menu's "Settings…" (CmdOrCtrl+,) item. Until
  // now the gear button below was the SOLE way into Settings; the menu item is
  // the second, and it is deliberately the SAME destination rather than a
  // parallel one — main pushes 'menu:open-settings' on the click and this effect
  // calls the exact setSettingsOpen(true) the gear calls. Runs once (the setter
  // identity is stable), and outside the Electron app onOpenSettings finds no
  // bridge and returns a no-op unsubscribe, so the `npm run dev` browser and
  // `node web/smoke.cjs` are byte-unaffected — neither has an application menu
  // to fire it.
  useEffect(() => onOpenSettings(() => setSettingsOpen(true)), []);
  // WARDEN-1356 — the application menu's Edit ▸ Select All item. The item is a
  // wired click (the bare role is inert on the agent-pane surface: xterm's
  // helper textarea is empty and webContents.selectAll() fires no DOM event the
  // pane could intercept), so main pushes 'menu:select-all' — the same bridge
  // shape as Settings above — and this effect routes by REAL DOM focus:
  //   terminal → broadcast to the panes; the one whose textarea is the active
  //              element claims it and calls term.selectAll();
  //   editable → a Settings (or other) field has focus;
  //              document.execCommand('selectAll') reproduces the role's
  //              native behaviour there, which is what keeps the item honest
  //              off the pane surface;
  //   none     → nothing editable has focus; a no-op, same as the role's
  //              select-nothing today.
  // DOM focus, not the focusedChat state, decides — focusedChat can still name
  // a pane while a Settings search field actually holds the keyboard, and the
  // role this replaces acted on real focus too. Runs once; outside the
  // Electron app onSelectAll finds no bridge and returns a no-op unsubscribe.
  useEffect(() => onSelectAll(() => {
    const route = routeMenuSelectAll(document.activeElement);
    if (route === 'terminal') {
      window.dispatchEvent(new CustomEvent(TERMINAL_SELECT_ALL_EVENT));
    } else if (route === 'editable') {
      document.execCommand('selectAll');
    }
  }), []);
  // WARDEN-1422: the full-page "Open chat" browser view (WARDEN-216) is DELETED —
  // the sidebar is the only session surface, and unsaved sessions are never
  // listed. The token-budget alarm's old deep-link into that page's heaviest-
  // first view goes with it; the alarm itself (toast + desktop) still fires.
  useTokenBudget({ hostLabels });
  // Host connectivity statuses, sourced from the shared /api/hosts/status
  // singleton (useHostStatuses, WARDEN-237). One ref-counted, visibility-gated
  // poll backs every consumer — this App-level feed (host rows + the host view's
  // unreachable state in the sidebar) plus the Fleet Health dashboard — so there
  // is no second SSH-probing poll. The poll
  // runs at a fixed 30s and is gated on Page Visibility (WARDEN-609); it does
  // not track the "Poll Interval" pref (the catalog poll above still does).
  const hostStatuses = useHostStatuses();
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
  // Resize drag state
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [isResizingObserver, setIsResizingObserver] = useState(false);
  const dragStartX = useRef<number>(0);
  const dragStartSidebarWidth = useRef<number>(0);
  const dragStartObserverWidth = useRef<number>(0);
  // Width of the *other* (non-dragged) panel + health state captured at drag
  // start, so the mousemove clamp can reserve the middle-pane floor (WARDEN-183)
  // without the effect needing live state in its deps — keeps the original
  // ref-based drag pattern (effect deps stay just the isResizing flags).
  const dragOtherWidth = useRef<number>(0);
  const dragHealthCollapsed = useRef<boolean>(true);

  const handleSidebarMouseDown = (e: React.MouseEvent) => {
    setIsResizingSidebar(true);
    dragStartX.current = e.clientX;
    dragStartSidebarWidth.current = sidebarWidth;
    dragOtherWidth.current = observerCollapsed ? 0 : observerWidth;
    dragHealthCollapsed.current = healthCollapsed;
    e.preventDefault();
  };

  const handleObserverMouseDown = (e: React.MouseEvent) => {
    setIsResizingObserver(true);
    dragStartX.current = e.clientX;
    dragStartObserverWidth.current = observerWidth;
    dragOtherWidth.current = sidebarCollapsed ? 0 : sidebarWidth;
    dragHealthCollapsed.current = healthCollapsed;
    e.preventDefault();
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const ctx = { windowWidth: window.innerWidth, healthCollapsed: dragHealthCollapsed.current };
      if (isResizingSidebar) {
        const delta = e.clientX - dragStartX.current;
        const newWidth = dragStartSidebarWidth.current + delta;
        setSidebarWidth(clampSidebarWidth(newWidth, dragOtherWidth.current, ctx));
      }
      if (isResizingObserver) {
        const delta = dragStartX.current - e.clientX;
        const newWidth = dragStartObserverWidth.current + delta;
        setObserverWidth(clampObserverWidth(newWidth, dragOtherWidth.current, ctx));
      }
    };

    const handleMouseUp = () => {
      setIsResizingSidebar(false);
      setIsResizingObserver(false);
    };

    if (isResizingSidebar || isResizingObserver) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isResizingSidebar, isResizingObserver]);

  // Live panel widths via ref so the space-change clamp reads fresh values
  // without re-subscribing its listener on every drag tick. (Mirrors the
  // focusedRef.current = focused pattern above.)
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;
  const observerWidthRef = useRef(observerWidth);
  observerWidthRef.current = observerWidth;

  // Re-clamp both panel widths against the current viewport, health state, AND
  // panel-collapse state so the visible panels together can never starve the
  // middle pane column. This is the single re-clamp entry point for every change
  // in AVAILABLE/VISIBLE LAYOUT SPACE — effect (1) (window resize) and effect
  // (2) (health + sidebar/observer collapse toggles) both call it (WARDEN-183).
  // Enlarging space (window grows, a panel collapses) is a no-op: in-range widths
  // clamp back to themselves. The deps are the space-shaping flags only (NOT the
  // width states), so setting the widths here cannot retrigger this callback.
  const applyLayoutClamp = useCallback(() => {
    const clamped = clampLayoutWidths(
      { sidebar: sidebarWidthRef.current, observer: observerWidthRef.current },
      { windowWidth: window.innerWidth, healthCollapsed, sidebarCollapsed, observerCollapsed },
    );
    setSidebarWidth(clamped.sidebar);
    setObserverWidth(clamped.observer);
  }, [healthCollapsed, sidebarCollapsed, observerCollapsed]);

  // (1) Window resize: a smaller viewport shrinks the space the two panels share.
  useEffect(() => {
    window.addEventListener('resize', applyLayoutClamp);
    return () => window.removeEventListener('resize', applyLayoutClamp);
  }, [applyLayoutClamp]);

  // (2) Space-shape changes: the health toggle AND the sidebar/observer collapse
  // toggles all change how much shared width the VISIBLE panels may occupy.
  // Health expanding reserves HEALTH_WIDTH (−320px). Expanding a side panel
  // re-introduces a width that may have been dragged wide while the OTHER panel
  // was collapsed — the drag clamp treats a collapsed neighbor as width 0
  // (`dragOtherWidth = otherCollapsed ? 0 : other`), so a wide drag there stores
  // a value that only fits when that neighbor is hidden. Without re-clamping on
  // the expand, both visible panels keep their full stored widths and the middle
  // pane column is crushed (to ~0 at the 900px floor). Collapsing only frees
  // space (a no-op clamp); the EXPAND direction is the one that needs this.
  // REQUIRED for the middle-pane invariant: removing it re-introduces the
  // WARDEN-183 crush (see layout.test.mjs, "expand re-clamp").
  useEffect(() => {
    applyLayoutClamp();
  }, [applyLayoutClamp]);

  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      {showReturnBanner && (
        <div className="flex items-center justify-between gap-3 px-3 py-2 bg-blue-50 dark:bg-blue-950 border-b border-blue-200 dark:border-blue-800">
          {/*
            WARDEN-436 — the ranked "you're needed HERE, because X" callout is the
            banner's LEAD (one-click deep-link into the pane that needs the human,
            via the same openChat the header badge uses). The since-close event
            tally is demoted to secondary context on its right. The banner renders
            the callout whenever the rollup's top is non-null (no >=2 gate — the
            banner has no rundown beneath it, unlike the badge popover); it fills in
            as soon as the rollup arrives (the first ~poll after return) and falls
            back to the tally alone in the first seconds or when no pane needs
            attention.
            Layout (WARDEN-436 review fix): the right cluster (View Activity + ×)
            is shrink-0 so the dismiss × is ALWAYS reachable; the callout Button is
            `shrink min-w-0` (overriding the <Button> base `shrink-0`) so a long
            agent name TRUNCATES instead of forcing the row wider and stranding ×
            off-screen at narrow viewports. The name is capped (`max-w-40`) +
            truncate; "You're needed in" is shrink-0 (label never clips); the reason
            is `max-w-sm` + truncate. Statically reasoned from the flex/overflow
            model — not browser-measured here (worker sandbox blocks Chromium;
            deferred to the reviewer sandbox per WARDEN-130/WARDEN-68).
          */}
          <div className="flex items-center gap-3 text-sm min-w-0">
            {attentionTop && (
              // WARDEN-1360: the banner callout no longer carries an inline reply.
              // It was gated on canReply(state) — true only for the removed
              // waiting/blocked buckets — so no ranked top can ever be replyable
              // again. (The QuickReply control survives on the WATCH lane, in
              // WatchCatchup, whose reasons are a user-authored literal, not a
              // substring guess.)
              <div className="flex flex-col gap-1 min-w-0 shrink">
                <div className="flex items-center gap-1 min-w-0">
                  <Button
                    variant="ghost"
                    onClick={() => openChat(attentionTop.id, attentionTop.anchor ?? undefined)}
                    aria-label={`You're needed in ${attentionTop.name ?? attentionTop.id}. Open it.`}
                    className="shrink min-w-0 gap-2 h-auto py-1 px-2.5 rounded-md bg-white/80 dark:bg-blue-900/50 hover:bg-white dark:hover:bg-blue-900/70 text-blue-900 dark:text-blue-50 font-normal"
                  >
                    <span className={cn('size-2 rounded-full shrink-0', dotForState(attentionTop.state))} aria-hidden />
                    <span className="text-sm whitespace-nowrap shrink-0">You&rsquo;re needed in</span>
                    <span className="text-sm font-semibold max-w-40 truncate">{attentionTop.name ?? attentionTop.id}</span>
                    <span className="text-xs text-blue-700/90 dark:text-blue-200/80 max-w-sm truncate">{attentionReason(attentionTop)}</span>
                    <span className="text-xs text-blue-600 dark:text-blue-300 shrink-0 whitespace-nowrap">open →</span>
                  </Button>
                </div>
              </div>
            )}
            {activitySinceClose && (
              <span className="text-blue-700 dark:text-blue-300 min-w-0">
                <span className="font-medium text-blue-900 dark:text-blue-100 mr-2">While you were away:</span>
                {activitySinceClose.directive_sent > 0 && (
                  <span className="mr-3">{activitySinceClose.directive_sent} directive{activitySinceClose.directive_sent !== 1 ? 's' : ''} sent</span>
                )}
                {activitySinceClose.attached > 0 && (
                  <span className="mr-3">{activitySinceClose.attached} session{activitySinceClose.attached !== 1 ? 's' : ''} attached</span>
                )}
                {activitySinceClose.error > 0 && (
                  <span className="mr-3 text-red-600 dark:text-red-400">{activitySinceClose.error} error{activitySinceClose.error !== 1 ? 's' : ''}</span>
                )}
                {activitySinceClose.total > 0 && (
                  <span className="text-blue-600 dark:text-blue-400">{activitySinceClose.total} total event{activitySinceClose.total !== 1 ? 's' : ''}</span>
                )}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="ghost"
              onClick={openActivityTab}
              className="h-auto px-2 py-1 text-xs rounded bg-blue-200 dark:bg-blue-800 text-blue-900 dark:text-blue-100 hover:bg-blue-300 dark:hover:bg-blue-700"
            >
              View Activity
            </Button>
            <Button
              variant="ghost"
              onClick={() => setBannerDismissed(true)}
              aria-label="Dismiss return banner"
              className="h-auto px-1.5 py-1 text-base leading-none text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-200"
            >
              ×
            </Button>
          </div>
        </div>
      )}
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
          appearance={{
            // WARDEN-1420 (roadmap WARDEN-1204 slice 12): this bag is now the
            // three ELECTRON pairs and nothing else. theme/density/paneLayout/
            // autoFocusNewPane/restoreOnStartup/terminalColorScheme joined the
            // six terminal prefs slice 3 moved — AppearanceSection subscribes to
            // every one of them in the shared store (lib/uiStore.ts). The three
            // below stay App-local by design: one reader, one writer, an IPC
            // integration (window bounds / login item / tray) with no second
            // sharing channel.
            rememberWindowBounds, setRememberWindowBounds,
            launchAtLogin, setLaunchAtLogin,
            closeToTray, setCloseToTray,
          }}
          // WARDEN-1383 (roadmap WARDEN-1204 slice 8): no `newChats` group —
          // NewChatsSection subscribes to the shared client-state store
          // (lib/uiStore.ts) directly, like SnippetsSection (WARDEN-1271) and
          // the six terminal prefs (WARDEN-1322) before it. WARDEN-1408 (slice
          // 11): no `alerts` group either — NotificationsSection subscribes to
          // the store the same way, and the DesktopAlertPrefs bag is retired.
          resetUiPrefsToDefaults={resetUiPrefsToDefaults}
        />
      ) : (
        <>
      <header className="flex items-center gap-3 px-3 h-11 border-b shrink-0">
        <IconTooltip label="toggle sidebar" side="bottom"><button onClick={() => setSidebarCollapsed(!sidebarCollapsed)} className="text-muted-foreground hover:text-foreground transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded px-1.5 py-0.5 hover:bg-accent/50">{sidebarCollapsed ? '▸' : '◂'}</button></IconTooltip>
        <span className="font-semibold tracking-wide shrink-0">Yatfa Warden</span>
        <span className="text-xs text-muted-foreground shrink-0 whitespace-nowrap">{openPanes.length} open</span>
        {/* Workspace tab strip (WARDEN-256) — the flexible, bounded middle region.
            min-w-0 + overflow-x-auto let it absorb remaining width and scroll its
            tabs internally so it can never push the right-side control cluster
            (below) off-screen at the default width. */}
        <WorkspaceTabs
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
          onSelect={selectWorkspace}
          onCreate={() => createWorkspace()}
          onRename={renameWorkspace}
          onClose={requestCloseWorkspace}
          onDropPane={movePaneToWorkspace}
          onDropPaneNew={movePaneToNewWorkspace}
          className="flex-1 min-w-0"
        />
        {/* Right-side control cluster — shrink-0 so the tab region yields first
            and this whole cluster stays fully visible at the default width. */}
        <div className="flex items-center gap-3 shrink-0">
          <StatusDot
            tone={streamConn ? 'green' : 'red'}
            variant={streamConn ? 'solid' : 'ring'}
            label={streamConn ? 'Connected' : 'Disconnected'}
            className="transition-colors duration-300 ease-in-out"
          />
          <AttentionBadge rollup={attentionRollup} onOpenChat={openChat} onOpenActivity={openActivityTab} focusedPaneKey={focusedPaneKey} />
          <IconTooltip label="global search (Ctrl+Shift+F)" side="bottom"><button onClick={() => setShowGlobalSearch(true)} className="text-muted-foreground hover:text-foreground transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded px-1.5 py-0.5 hover:bg-accent/50">⌕</button></IconTooltip>
          <IconTooltip label="toggle health panel" side="bottom"><button onClick={() => setHealthCollapsed(!healthCollapsed)} className="text-muted-foreground hover:text-foreground transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded px-1.5 py-0.5 hover:bg-accent/50">{healthCollapsed ? '◂' : '▸'} Health</button></IconTooltip>
          <IconTooltip label="toggle observer" side="bottom"><button onClick={() => setObserverCollapsed(!observerCollapsed)} className="text-muted-foreground hover:text-foreground transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded px-1.5 py-0.5 hover:bg-accent/50">{observerCollapsed ? '◂' : '▸'}</button></IconTooltip>
          <IconTooltip label="settings" side="bottom"><button onClick={() => setSettingsOpen(true)} className="text-muted-foreground hover:text-foreground transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded px-1.5 py-0.5 hover:bg-accent/50">⚙</button></IconTooltip>
        </div>
      </header>
      <main className="flex flex-1 min-h-0">
        <section className="chat-sidebar border-r min-h-0 transition-all duration-200 ease-in-out overflow-hidden relative"
          style={{ width: sidebarCollapsed ? 0 : sidebarWidth, flexShrink: 0, opacity: sidebarCollapsed ? 0 : 1 }}>
          <div
            className="absolute top-0 right-0 bottom-0 w-1 hover:bg-accent hover:w-1.5 transition-all cursor-col-resize z-10"
            onMouseDown={handleSidebarMouseDown}
            title="Drag to resize sidebar"
          />
          <ErrorBoundary onError={(error, info) => forwardRendererError(error, info.componentStack)}>
            <ChatSidebar
              chats={chats}
              tempChats={tempChats}
              hosts={hosts}
              recentlyClosed={activeWorkspace?.recentlyClosed ?? []}
              focused={focused}
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
              hostStatuses={hostStatuses}
              discoverErrors={discoverErrors}
              recentlySavedIds={recentlySavedIds}
              sourceControlCollapsed={sourceControlCollapsed}
              onSourceControlCollapsedChange={setSourceControlCollapsed}
              pollIntervalMs={pollIntervalMs}
            />
          </ErrorBoundary>
        </section>
        <section className="flex-1 min-h-0 min-w-0">
          <PaneGrid
            tiles={tiles}
            focused={focused}
            maximized={maximized}
            newActivity={newActivity}
            chats={[...chats, ...tempChats]}
            paneHost={paneHost}
            onFocus={setFocused}
            onClose={closePane}
            onToggleMax={toggleMax}
            onClearNew={clearNew}
            onForceKill={forceKill}
            onSplitShell={handleSplitShell}
            onSpawned={handlePaneSpawned}
            externalSearchQuery={externalSearchQuery}
            // WARDEN-1422 (QA round 5): per-pane reconnect tokens + phase
            // reports — the respawn/resume → open-dead-pane re-attach chain.
            reconnectTokens={reconnectTokens}
            onPanePhaseChange={handlePanePhaseChange}
            onToggleSidebar={toggleSidebar}
            onToggleObserver={toggleObserver}
            // WARDEN-1322 (slice 3): the six terminal prefs (fontSize/onFontSize-
            // Change, scrollback, fontFamily, terminalCursorStyle, copyOnSelect,
            // onExitBehavior) no longer ride through PaneGrid — PaneTile
            // subscribes to them in the shared store (lib/uiStore.ts) and
            // PaneGrid never read them. WARDEN-1420 (slice 12): `paneLayout`
            // stopped riding through too — PaneGrid DOES read that one, so it
            // subscribes to the same store directly. terminalThemeId STAYS a
            // prop: it is derived per render below so an OS theme flip re-themes
            // open panes live.
            // WARDEN-1433 (slice 14): the pane-ratio pair stopped riding through
            // the same way — PaneGrid DOES read AND write it (persisted values
            // in, committed arrays out), and it now subscribes to the store for
            // both under the exact local names the props used, so every drag /
            // template / equalize / reset-reorder call site below is unchanged.
            terminalThemeId={terminalThemeId}
            showHostTags={displaySettings.showHostTags}
            // WARDEN-1388: the issue-key link integration — server config
            // fetched by refreshConfigPrefs, live-updating already-open panes.
            issueLinksEnabled={displaySettings.issueLinksEnabled}
            issueLinkTrackers={issueLinkTrackers}
            pollIntervalMs={pollIntervalMs}
            onReorderPanes={reorderPanes}
          />
        </section>
        <section className="border-l min-h-0 transition-all duration-200 ease-in-out overflow-hidden relative"
          style={{ width: observerCollapsed ? 0 : observerWidth, flexShrink: 0, opacity: observerCollapsed ? 0 : 1 }}>
          <div
            className="absolute top-0 left-0 bottom-0 w-1 hover:bg-accent hover:w-1.5 transition-all cursor-col-resize z-10"
            onMouseDown={handleObserverMouseDown}
            title="Drag to resize observer panel"
          />
          <ErrorBoundary onError={(error, info) => forwardRendererError(error, info.componentStack)}>
            <ObserverTabs externalViewMode={externalViewMode} onExternalViewModeConsumed={consumeExternalViewMode} resetToken={observerResetToken} focusedChat={focusedChat} onReconnectChat={handleReconnectChat} observerAutoStart={observerAutoStart} observerSessionTimeout={observerSessionTimeout} attention={{ rollup: attentionRollup, onOpenChat: openChat, onOpenActivity: openActivityTab, focusedPaneKey }} issueEntries={markdownIssueEntries} />
          </ErrorBoundary>
        </section>
        <section className="border-l min-h-0 transition-all duration-200 ease-in-out overflow-hidden"
          style={{ width: healthCollapsed ? 0 : HEALTH_WIDTH, flexShrink: 0, opacity: healthCollapsed ? 0 : 1 }}>
          <HealthDashboard
            onOpenChat={openChat}
            onClose={() => setHealthCollapsed(true)}
            pollIntervalMs={pollIntervalMs}
            companionTransportEnabled={companionTransportEnabled}
          />
        </section>
      </main>
        </>
      )}
      <GlobalSearchDialog
        open={showGlobalSearch}
        onClose={() => setShowGlobalSearch(false)}
        openPanes={openPanes}
        onFocusPane={handleFocusPane}
        onJumpToMatch={handleJumpToMatch}
        onOpenSession={(id, host, label) => {
          // Set the App-level viewing session, then close the search dialog. The
          // viewer (rendered just below) survives the dialog closing because its
          // open state + session live here, not inside the dialog.
          setViewingSession({ id, host, label });
          setShowGlobalSearch(false);
        }}
      />
      <SessionTranscriptViewer
        open={!!viewingSession}
        onOpenChange={(o) => { if (!o) setViewingSession(null); }}
        session={viewingSession}
        issueEntries={markdownIssueEntries}
      />
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
      <ConfirmDialog
        open={workspaceCloseTarget !== null}
        onOpenChange={(o) => { if (!o) cancelCloseWorkspace(); }}
        title="Close workspace?"
        description="Closing a workspace removes its panes from the grid only — the chats stay in the sidebar and can be reopened."
        confirmLabel="Close workspace"
        cancelLabel="Cancel"
        destructive
        onConfirm={confirmCloseWorkspace}
      />
    </div>
  );
}

export default App;
