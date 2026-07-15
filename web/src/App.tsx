import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { streamApi } from '@/lib/stream';
import { postJson } from '@/lib/api';
import { loadUi, saveUi, persistUiState, initialWorkspace, mergeRecentlyClosed, DEFAULT_TERMINAL_FONT_FAMILY, STARTER_SNIPPETS, type RestoreOnStartup, type PaneLayout, type TerminalCursorStyle, type OnExitBehavior, type CustomPreset, type Snippet, type WorkspacePaneSet, type RecentlyClosedEntry, clampSidebarWidth, clampObserverWidth, clampLayoutWidths, HEALTH_WIDTH } from '@/lib/storage';
import { displayName } from '@/lib/chatDisplay';
import { applyTheme, listenSystemThemeChange, resolveThemeId, resolveTerminalThemeId, type Theme, type ThemeId, type TerminalColorScheme } from '@/lib/theme';
import { applyDensity, type Density } from '@/lib/density';
import { type TimestampFormat } from '@/lib/formatTimestamp';
import { type AgentFilter, type AgentSort } from '@/lib/agentFilter';
import { stampLastSeen } from '@/lib/whatsNew';
import { useWatchCatchup } from '@/lib/useWatchCatchup';
import { requestAlertPermission, type AttentionSeverityPrefs } from '@/lib/desktopAlerts';
import { useTokenBudget } from '@/lib/useTokenBudget';
import { useAttentionRollup } from '@/lib/useAttentionRollup';
import { rankAttention, hasReturnContent, attentionReason, type AttentionItem } from '@/lib/attentionRollup';
import { cn } from '@/lib/utils';
import { getRememberWindowBounds, setRememberWindowBounds as persistRememberWindowBounds, getLaunchAtLogin, setLaunchAtLogin as persistLaunchAtLogin, getCloseToTray, setCloseToTray as persistCloseToTray } from '@/lib/electron';
import type { Chat } from '@/lib/types';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ChatSidebar } from '@/components/ChatSidebar';
import { PaneGrid } from '@/components/PaneGrid';
import { WorkspaceTabs } from '@/components/WorkspaceTabs';
import { ObserverTabs } from '@/components/ObserverTabs';
import { SettingsPage } from '@/components/SettingsPage';
import { OpenChatBrowserPage } from '@/components/OpenChatBrowserPage';
import { GlobalSearchDialog } from '@/components/GlobalSearchDialog';
import { HealthDashboard } from '@/components/HealthDashboard';
import { AttentionBadge, dotForState } from '@/components/AttentionBadge';
import { WatchCatchup } from '@/components/WatchCatchup';
import { StatusDot } from '@/components/StatusDot';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Button } from '@/components/ui/button';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { useNotificationPrefs } from '@/lib/useNotificationPrefs';
import { resolvePollIntervalMs, WEB_POLL_DEFAULT_MS } from '@/lib/pollInterval';
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

function App() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [sshHosts, setSshHosts] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null);
  // Read persisted UI state ONCE on mount (lazy initializer runs only the first
  // render) and reuse it for every useState seed below — consolidates the prior
  // per-state loadUi() calls into a single read.
  const [uiState] = useState(() => loadUi());
  // Stable for the session: true when THIS launch started in "Start empty" mode.
  // The live workspace is then a gated clean slate, not a legitimate workspace to
  // persist — so for the whole session persistUiState carries the on-disk workspace
  // forward (even after flipping back to "Reopen previous"), never the live arrays.
  const startedEmpty = uiState.restoreOnStartup === 'empty';
  const [restoreOnStartup, setRestoreOnStartup] = useState<RestoreOnStartup>(() => uiState.restoreOnStartup ?? 'previous');
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
  const [externalViewMode, setExternalViewMode] = useState<'sessions' | 'activity' | 'directives' | null>(null);
  const [showGlobalSearch, setShowGlobalSearch] = useState(false);
  const [externalSearchQuery, setExternalSearchQuery] = useState<{ paneId: string; query: string } | null>(null);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(uiState.sidebarCollapsed);
  const [observerCollapsed, setObserverCollapsed] = useState(uiState.observerCollapsed);
  const [healthCollapsed, setHealthCollapsed] = useState(uiState.healthCollapsed ?? true);
  const [theme, setTheme] = useState<Theme>(() => uiState.theme ?? 'system');
  // The OS-resolved concrete theme id (e.g. 'github-dark', 'dracula'). The
  // `theme` state variable stays 'system' on an OS flip, so chrome re-paints via
  // a direct DOM attribute mutation in the [theme] effect — no React re-render.
  // But the terminal surface re-themes imperatively inside PaneTile's effect,
  // which only re-fires when its prop changes. Tracking resolvedThemeId as React
  // state and feeding it to resolveTerminalThemeId is what makes "Match app
  // theme" live-update on an OS flip (nuance #1): listenSystemThemeChange calls
  // setResolvedThemeId, the prop propagates to PaneTile, and its effect
  // re-paints open panes with the new theme's xterm palette.
  const [resolvedThemeId, setResolvedThemeId] = useState<ThemeId>(() => resolveThemeId(uiState.theme ?? 'system'));
  const [density, setDensity] = useState<Density>(() => uiState.density ?? 'comfortable');
  const [paneLayout, setPaneLayout] = useState<PaneLayout>(() => uiState.paneLayout ?? 'auto');
  // "Pane on agent exit" behavior: what an already-open pane does when its agent
  // process exits (chat.active goes true→false). 'keep' (default) is today's exact
  // behavior (dead terminal left for manual close); 'dim' marks it exited while
  // keeping the last output readable; 'auto-close' removes it via closePane once.
  // Pure client-side pref (like paneLayout/terminalFontSize): persisted by the
  // saveUi effect below, never sent to the backend. See WARDEN-248.
  const [onExitBehavior, setOnExitBehavior] = useState<OnExitBehavior>(() => uiState.onExitBehavior ?? 'keep');
  // "Auto-focus new pane": whether opening/resuming/splitting a chat moves
  // keyboard focus to the new pane (default true = today's behavior). When false
  // the currently focused pane is preserved — xterm's native click-to-focus lets
  // the user focus a pane on demand. Pure client-side pref (like
  // onExitBehavior/paneLayout): persisted by the saveUi effect below, never sent
  // to the backend. Gates the setFocused call in openChat below. See WARDEN-274.
  const [autoFocusNewPane, setAutoFocusNewPane] = useState<boolean>(() => uiState.autoFocusNewPane ?? true);
  const [terminalFontSize, setTerminalFontSize] = useState(() => uiState.terminalFontSize ?? 14);
  // Opt-in OS desktop alerts when agents need attention and Warden is unfocused
  // (WARDEN-259). Pure client-side pref (like terminalFontSize/scrollback):
  // persisted by the saveUi effect below, forwarded to the AttentionBadge's
  // useAttentionRollup so the existing poll fires an OS notification on a rollup
  // increase while hidden. Never sent to the backend.
  const [attentionDesktopAlerts, setAttentionDesktopAlerts] = useState(() => uiState.attentionDesktopAlerts ?? false);
  // Per-state Attention toggle (WARDEN-344): which pane states (stuck/erroring/
  // waiting/blocked) raise the badge + desktop alert. Each defaults ON; persisted by
  // the saveUi effect below and forwarded to the AttentionBadge's useAttentionRollup.
  const [attentionStates, setAttentionStates] = useState(() => uiState.attentionStates ?? { stuck: true, erroring: true, waiting: true, blocked: true });
  // WARDEN-364 — per-severity routing + per-agent mute for the desktop-alert
  // channel, layered on the `attentionDesktopAlerts` master switch above. The
  // master gates the whole channel; these route WHICH buckets/agents escalate.
  // Defaults all-on + empty mute set = behavior-preserving. Pure client-side
  // prefs (like attentionDesktopAlerts): persisted by the saveUi effect below,
  // forwarded to SettingsPage (toggles) and AttentionBadge (mute affordance +
  // routing into useAttentionRollup). Never sent to the backend.
  const [alertCritical, setAlertCritical] = useState(() => uiState.alertCritical ?? true);
  const [alertWarning, setAlertWarning] = useState(() => uiState.alertWarning ?? true);
  const [alertDirective, setAlertDirective] = useState(() => uiState.alertDirective ?? true);
  const [alertError, setAlertError] = useState(() => uiState.alertError ?? true);
  const [mutedAlertKeys, setMutedAlertKeys] = useState<string[]>(() => uiState.mutedAlertKeys ?? []);
  // Toggle a chat key in the desktop-alert mute set. A muted agent driving a
  // critical/warning increase fires no OS notification but still appears in the
  // in-app AttentionBadge (which consumes the unfiltered rollup).
  const toggleMuteAlertKey = useCallback((key: string) => {
    setMutedAlertKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }, []);
  // Per-chat "watch" opt-in (WARDEN-378): pane keys the human marked "watch this
  // chat" for a targeted, reason-specific desktop ping when that chat newly needs
  // them. Global (not per-workspace). Pure client-side pref (like
  // attentionDesktopAlerts/attentionStates): persisted by the saveUi effect below,
  // forwarded to the AttentionBadge's useAttentionRollup (which unions watched ∪
  // open into the ?panes= poll and runs the per-chat transition detector). Never
  // sent to the backend.
  const [watchedChats, setWatchedChats] = useState<string[]>(() => uiState.watchedChats ?? []);
  const [terminalScrollback, setTerminalScrollback] = useState(() => uiState.terminalScrollback ?? 10000);
  // Terminal font family: the CSS font-family value every agent pane renders.
  // '' / absent / blank → DEFAULT_TERMINAL_FONT_FAMILY (today's exact stack) so
  // an empty or unknown custom value can never blank a pane (uses || not ?? on
  // purpose: '' must fall back). Pure client-side pref (like terminalFontSize/
  // scrollback): persisted by the saveUi effect below, never sent to the backend.
  const [terminalFontFamily, setTerminalFontFamily] = useState(() => uiState.terminalFontFamily || DEFAULT_TERMINAL_FONT_FAMILY);
  // Terminal color scheme: 'auto' follows the effective app theme (above);
  // 'dark'/'light' force the terminal surface. Pure client-side pref (like
  // terminalFontSize/scrollback): persisted by the saveUi effect below, never
  // sent to the backend.
  const [terminalColorScheme, setTerminalColorScheme] = useState<TerminalColorScheme>(() => uiState.terminalColorScheme ?? 'auto');
  // Terminal cursor style (shape × blink). Pure client-side pref (like
  // terminalFontSize/scrollback/colorScheme): persisted by the saveUi effect
  // below, applied live to all open panes via PaneTile's effect, and never sent
  // to the backend. 'blink-block' is the default (today's exact cursor).
  const [terminalCursorStyle, setTerminalCursorStyle] = useState<TerminalCursorStyle>(() => uiState.terminalCursorStyle ?? 'blink-block');
  // "Copy on select" (WARDEN-285): when ON, completing a text selection in any
  // agent pane copies it to the clipboard immediately (no Ctrl/Cmd+C). Default
  // OFF = today's exact behavior. Pure client-side pref (like terminalFontSize/
  // scrollback): persisted by the saveUi effect below, applies LIVE to all open
  // panes (PaneTile mirrors it into a ref its selection handler reads), and is
  // never sent to the backend.
  const [copyOnSelect, setCopyOnSelect] = useState(() => uiState.copyOnSelect ?? false);
  // Timestamp format (WARDEN-213): how every timestamp surface reads — 'relative'
  // (default = "2m"/"3h" buckets) or 'absolute' (clock time). Pure client-side
  // pref (like copyOnSelect/density): persisted by the saveUi effect below,
  // threaded to every timestamp display via the shared formatTimestamp helper,
  // and never sent to the backend.
  const [timestampFormat, setTimestampFormat] = useState<TimestampFormat>(() => uiState.timestampFormat ?? 'relative');
  // WARDEN-442: sidebar fleet Filter (all/yatfa/claude/manual) + Sort, shipped in
  // WARDEN-91. These were ChatSidebar-local useState with their own save effect,
  // which App's saveUi spread (which omits both keys) then clobbered on every
  // unrelated state change — wiping them from disk so the controls reset to
  // 'all'/'manual' on reload. Now App-owned and persisted by its saveUi effect
  // (the single writer), like every other UiState pref. Seeded from loadUi; the
  // 'all'/'manual' defaults already match DEFAULT_UI. Forwarded read-only to
  // ChatSidebar except for the change handlers. Pure client-side pref.
  const [agentFilter, setAgentFilter] = useState<AgentFilter>(() => uiState.agentFilter ?? 'all');
  const [agentSort, setAgentSort] = useState<AgentSort>(() => uiState.agentSort ?? 'manual');
  // Default agent type + host pre-filled in the ＋ new chat form, plus the
  // user-defined custom presets (named quick-fill commands beyond claude/shell).
  // All pure client-side prefs (like density/terminalFontSize): persisted by the
  // saveUi effect below, never sent to the backend. defaultNewChatPreset is a
  // reserved built-in name ('claude' | 'shell') or a custom preset name.
  const [defaultNewChatPreset, setDefaultNewChatPreset] = useState<string>(() => uiState.defaultNewChatPreset ?? 'claude');
  const [defaultNewChatHost, setDefaultNewChatHost] = useState(() => uiState.defaultNewChatHost ?? THIS_MACHINE);
  // Default working directory pre-filled in the ＋ new chat spawn form
  // (WARDEN-311). Blank → the host's home directory (today's behavior). Pure
  // client-side pref (like the new-chat host above): persisted by the saveUi
  // effect below, never sent to the backend.
  const [defaultNewChatCwd, setDefaultNewChatCwd] = useState(() => uiState.defaultNewChatCwd ?? '');
  // Per-host cwd overrides for the ＋ new chat spawn form (WARDEN-336). Keys are
  // host strings ('(local)' / SSH host name); a host with no entry falls through
  // to defaultNewChatCwd above, then blank. Pure client-side pref like the global
  // cwd above: persisted by the saveUi effect below, never sent to the backend.
  const [defaultNewChatCwdByHost, setDefaultNewChatCwdByHost] = useState<Record<string, string>>(() => uiState.defaultNewChatCwdByHost ?? {});
  // Per-host agent-type (preset) overrides for the ＋ new chat spawn form
  // (WARDEN-352 — mirrors the cwd map above). Keys are host strings; a host with
  // no entry (or one naming a since-deleted preset, dropped on load) falls
  // through to defaultNewChatPreset, then 'claude'. Pure client-side pref like
  // the cwd map above: persisted by the saveUi effect below, never sent to the
  // backend.
  const [defaultNewChatPresetByHost, setDefaultNewChatPresetByHost] = useState<Record<string, string>>(() => uiState.defaultNewChatPresetByHost ?? {});
  const [customPresets, setCustomPresets] = useState<CustomPreset[]>(() => uiState.customPresets ?? []);
  // Saved instruction snippets (WARDEN-323): a named, reusable intervention
  // library surfaced at the Broadcast dialog (insert-only) and a focused pane's
  // context menu (one-click send). Pure client-side localStorage pref like the
  // spawn presets above: persisted by the saveUi effect below, never sent to the
  // backend as anything but the literal `text` over the existing /api/send path.
  // Seeded once with STARTER_SNIPPETS by loadUi when the field is absent.
  const [snippets, setSnippets] = useState<Snippet[]>(() => uiState.snippets ?? []);
  // Default shell opened by BOTH the ＋ new-chat *shell* preset and the ＋ split
  // button (WARDEN-429 — unifies the prior split-only defaultSplitShell, migrated
  // into defaultShell on load). Blank means "no explicit shell" → the host
  // launches its own login shell. Pure client-side pref (like the new-chat prefs
  // above): persisted by the saveUi effect below, never sent to the backend.
  const [defaultShell, setDefaultShell] = useState(() => uiState.defaultShell ?? '');
  // Per-host default-shell overrides (WARDEN-429 — mirrors the cwd/preset maps
  // above). Keys are host strings ('(local)' / SSH host name); a host with no
  // entry (or an empty value, dropped on load) falls through to defaultShell,
  // then blank (host login shell). Pure client-side pref like defaultShell
  // above: persisted by the saveUi effect below, never sent to the backend.
  const [defaultShellByHost, setDefaultShellByHost] = useState<Record<string, string>>(() => uiState.defaultShellByHost ?? {});
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
  // here because the forceKill/requestKill callbacks below read it eagerly via
  // their dependency arrays.
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

    // Store close timestamp on unmount
    const handleBeforeUnload = () => {
      localStorage.setItem('warden:lastClose', String(Date.now()));
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

  // apply theme on mount and when theme changes
  useEffect(() => {
    // Apply theme immediately: sets the [data-theme] attribute (selecting the
    // matching CSS token block) and toggles `.dark` from the theme's mode.
    applyTheme(theme);
    // Keep the resolved concrete theme id in sync so the terminal pane (which
    // derives its xterm palette from it) follows a manual theme change live.
    setResolvedThemeId(resolveThemeId(theme));
    saveUi({ ...loadUi(), theme });

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

  // Persist live UI state, honoring the "Restore workspace on startup" pref.
  // persistUiState carries the on-disk workspace forward (instead of the live
  // arrays) whenever the pref is 'empty' OR this launch started empty — otherwise
  // a clean/'empty' launch, or flipping back to "Reopen previous" from one, would
  // overwrite and destroy the last saved workspace.
  useEffect(() => {
    saveUi(persistUiState({ workspaces, activeWorkspaceId, sidebarCollapsed, observerCollapsed, healthCollapsed, sidebarWidth, observerWidth, terminalFontSize, attentionDesktopAlerts, attentionStates, alertCritical, alertWarning, alertDirective, alertError, mutedAlertKeys, watchedChats, terminalScrollback, terminalFontFamily, terminalColorScheme, terminalCursorStyle, copyOnSelect, timestampFormat, theme, density, paneLayout, onExitBehavior, autoFocusNewPane, paneHost, defaultNewChatPreset, defaultNewChatPresetByHost, defaultNewChatHost, defaultNewChatCwd, defaultNewChatCwdByHost, customPresets, snippets, defaultShell, defaultShellByHost, agentFilter, agentSort }, restoreOnStartup, loadUi(), startedEmpty));
  }, [workspaces, activeWorkspaceId, sidebarCollapsed, observerCollapsed, healthCollapsed, sidebarWidth, observerWidth, terminalFontSize, attentionDesktopAlerts, attentionStates, alertCritical, alertWarning, alertDirective, alertError, mutedAlertKeys, watchedChats, terminalScrollback, terminalFontFamily, terminalColorScheme, terminalCursorStyle, copyOnSelect, timestampFormat, theme, density, paneLayout, onExitBehavior, autoFocusNewPane, paneHost, defaultNewChatPreset, defaultNewChatPresetByHost, defaultNewChatHost, defaultNewChatCwd, defaultNewChatCwdByHost, customPresets, snippets, defaultShell, defaultShellByHost, agentFilter, agentSort, restoreOnStartup, startedEmpty]);

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
    fetch('/api/ssh-hosts').then((r) => r.json()).then((j) => setSshHosts(j.hosts || [])).catch((error) => console.error('[ssh-hosts] Failed:', error));
    try {
      const cr = await fetch('/api/chats');
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
      });
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
    } catch (e) {
      console.error('Failed to refresh config preferences:', e);
    }
  }, []);

  // Called after Settings saves: reload chats/ssh-hosts, refresh notification prefs
  // everywhere (the shared hook broadcasts to all subscribers), and refresh config
  // preferences — so all toggles take effect immediately without a page reload.
  const handleConfigChange = useCallback(() => {
    refresh();
    reloadNotificationPrefs();
    refreshConfigPrefs();
  }, [refresh, reloadNotificationPrefs, refreshConfigPrefs]);

  // Write-through setter for the main-owned "remember window bounds" flag: update
  // the display mirror AND persist to main via IPC. A stable callback so the
  // SettingsPage prop identity doesn't churn on every poll tick (matching the
  // other stable setters passed down). No-op in a browser (persist call resolves
  // without the bridge). WARDEN-263.
  const setRememberWindowBounds = useCallback((v: boolean) => {
    setRememberWindowBoundsState(v);
    void persistRememberWindowBounds(v);
  }, []);

  // Mirror setter for launch-at-login: update the display state and write the OS
  // login item through the IPC bridge. Stable identity for the same reason as
  // setRememberWindowBounds. No-op in a browser (persist call resolves without
  // the bridge). WARDEN-278.
  const setLaunchAtLogin = useCallback((v: boolean) => {
    setLaunchAtLoginState(v);
    void persistLaunchAtLogin(v);
  }, []);

  // Mirror setter for close-to-tray: update the display state and write the
  // persisted flag (plus attach/detach the tray) through the IPC bridge. Stable
  // identity for the same reason as setLaunchAtLogin. No-op in a browser.
  // WARDEN-330.
  const setCloseToTray = useCallback((v: boolean) => {
    setCloseToTrayState(v);
    void persistCloseToTray(v);
  }, []);

  // Reset every UI PREF to its effective default value (the value loadUi()
  // yields post-coercion, so live React state / persisted state / a fresh
  // reload all agree) while leaving the WORKSPACE + panel layout untouched.
  // The setters fire the existing saveUi effect, which persists defaults-for-
  // prefs + preserved-workspace via persistUiState. Pure client-side: never
  // touches the backend / config.json (display/terminal/new-chat prefs are
  // client-side only by design). Stable identity — it only calls useState
  // setters (all stable) — so the SettingsPage prop identity never churns,
  // matching the other stable setters passed down.
  //
  // terminalFontFamily nuance: resets to DEFAULT_TERMINAL_FONT_FAMILY (the
  // curated "System default" value), NOT DEFAULT_UI.terminalFontFamily ('').
  // The persisted shape uses '' (blank = default stack), but the LIVE React
  // initializer coerces '' → DEFAULT_TERMINAL_FONT_FAMILY via || (App.tsx:158)
  // so a pane can never blank. Setting live state to '' here would leave the
  // Settings font-select showing "Custom…" (no '' option in the curated list)
  // until reload; DEFAULT_TERMINAL_FONT_FAMILY keeps live/persisted/reload in
  // sync (the saveUi effect persists the curated value, loadUi returns it as-
  // is, and it is NOT the DEFAULT_UI '' sentinel — but it renders identically).
  // defaultNewChatCwd is reset too: it is a pref (in the saveUi spread), part
  // of the defaultNewChat* family, and omitting it would leave the stale value
  // in live state for the next persist — violating the "all agree" invariant.
  // Does NOT touch workspace/layout setters (workspaces/activeWorkspaceId/
  // paneHost/sidebarCollapsed/observerCollapsed/healthCollapsed/sidebarWidth/
  // observerWidth) — those are preserved. See WARDEN-346.
  //
  // Every OTHER pref in App's persist spread is reset here so live state, the
  // next saveUi persist, and a fresh reload all agree (acceptance criterion #2).
  // This includes prefs added by tickets that landed after WARDEN-346 branched
  // (per-state attentionStates, per-severity alert routing, mutedAlertKeys,
  // watchedChats, timestampFormat, per-host
  // preset/cwd overrides, instruction snippets). Omitting any would leave it
  // stale in live React state and silently survive the "reset everything"
  // action — the next persist would then write the stale value right back.
  // User-curated lists (customPresets/snippets/watchedChats/mutedAlertKeys)
  // reset too: this is a destructive, confirm-gated "back to factory defaults",
  // consistent with customPresets → [] (customPresets is user-authored as well).
  const resetUiPrefsToDefaults = useCallback(() => {
    // Appearance
    setTheme('system');
    setDensity('comfortable');
    setPaneLayout('auto');
    // Behavior
    setOnExitBehavior('keep');
    setAutoFocusNewPane(true);
    setRestoreOnStartup('previous');
    setCopyOnSelect(false);
    setTimestampFormat('relative');
    // Sidebar fleet filter/sort (WARDEN-442): reset to the DEFAULT_UI values.
    setAgentFilter('all');
    setAgentSort('manual');
    // Terminal
    setTerminalFontSize(14);
    setTerminalScrollback(10000);
    setTerminalFontFamily(DEFAULT_TERMINAL_FONT_FAMILY);
    setTerminalColorScheme('auto');
    setTerminalCursorStyle('blink-block');
    // New chats
    setDefaultNewChatPreset('claude');
    setDefaultNewChatPresetByHost({});
    setDefaultNewChatHost(THIS_MACHINE);
    setDefaultNewChatCwd('');
    setDefaultNewChatCwdByHost({});
    setCustomPresets([]);
    setSnippets(STARTER_SNIPPETS);
    setDefaultShell('');
    setDefaultShellByHost({});
    // Attention / desktop alerts
    setAttentionDesktopAlerts(false);
    setAttentionStates({ stuck: true, erroring: true, waiting: true, blocked: true });
    setAlertCritical(true);
    setAlertWarning(true);
    setAlertDirective(true);
    setAlertError(true);
    setMutedAlertKeys([]);
    setWatchedChats([]);
  }, []);

  // Discover one host on demand (lazy mode): fetch live chats for that host and replace
  // its entries in the chats list so dots update to green/red.
  const discoverHost = useCallback(async (host: string) => {
    discoveredHostsRef.current.add(host);
    try {
      const r = await fetch(`/api/discover?host=${encodeURIComponent(host)}`);
      const j = await r.json();
      if (Array.isArray(j.chats)) {
        setChats((prev) => applyOptimisticGuard([...prev.filter((c) => c.host !== host), ...j.chats] as Chat[], killedChatIdsRef.current, pendingRenamesRef.current));
      }
    } catch (e) { console.error('discoverHost failed:', e); }
  }, []);

  // Re-discover every host the user has engaged with, concurrently. This is what keeps
  // active/idle dots + last-activity live: /api/discover is the only source of live status in
  // lazy mode (/api/chats is disk-only). Bounded to visited hosts — not the whole fleet — so
  // SSH cost tracks user engagement, and only invoked while the tab is visible (see the
  // auto-refresh effect below).
  const refreshDiscoveredHosts = useCallback(async () => {
    const hosts = [...discoveredHostsRef.current];
    if (!hosts.length) return;
    await Promise.all(hosts.map((h) => discoverHost(h)));
  }, [discoverHost]);

  // Auto-refresh the agent list so active/idle dots + last-activity stay live in the sidebar
  // without a manual refresh. Lazy mode serves /api/chats from disk only (active=null); live
  // status comes from /api/discover, which the client normally runs just on host-click. So
  // each visible tick silently re-pulls the catalog AND re-discovers every host the user has
  // already engaged with — that is what advances dots/timestamps and surfaces external spawns.
  // Ticks are gated on Page Visibility so a backgrounded tab never burns SSH; on regaining
  // focus we refresh immediately because state may be stale while hidden.
  useEffect(() => {
    const REFRESH_MS = pollIntervalMs;
    const poll = async () => {
      if (document.visibilityState !== 'visible') return;
      await applyCatalog(true);
      void refreshDiscoveredHosts();
    };
    const onVisibilityChange = async () => {
      if (document.visibilityState !== 'visible') return;
      await applyCatalog(true);
      void refreshDiscoveredHosts();
    };
    const intervalId = window.setInterval(poll, REFRESH_MS);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [applyCatalog, refreshDiscoveredHosts, pollIntervalMs]);

  // Discover this machine's own agents once on mount. Local discovery is cheap (no SSH) and is
  // the common case, so local agents show live immediately and the auto-refresh above keeps
  // them live — no host-click required. Remote hosts remain on-demand per lazy mode.
  useEffect(() => {
    void discoverHost(THIS_MACHINE);
  }, [discoverHost]);

  // Poll host connectivity statuses every 30s. Lifted here from ChatSidebar so the
  // dots stay live while the full-page Open Chat browser (which replaces the
  // sidebar) is open. Graceful degradation: on failure every host reads 'unknown'.
  useEffect(() => {
    const fetchHostStatuses = async () => {
      try {
        const r = await fetch('/api/hosts/status');
        const j = await r.json();
        const statuses: Record<string, { status: 'online' | 'offline' | 'unknown'; latency_ms: number | null }> = {};
        j.hosts.forEach((h: { host: string; status: string; latency_ms: number | null }) => {
          statuses[h.host] = {
            status: h.status as 'online' | 'offline' | 'unknown',
            latency_ms: h.latency_ms,
          };
        });
        setHostStatuses(statuses);
      } catch {
        // Graceful degradation — leave prior statuses (or unknown) in place.
      }
    };
    fetchHostStatuses();
    const interval = window.setInterval(fetchHostStatuses, pollIntervalMs);
    return () => window.clearInterval(interval);
  }, [pollIntervalMs]);

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
  const openChat = useCallback((id: string) => {
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
    // Search EVERY workspace for an existing pane with this id. If it's already
    // open elsewhere, switch to that workspace + focus it (no duplicate pane).
    const owner = workspacesRef.current.find((w) => w.openPanes.includes(id));
    if (owner) {
      if (owner.id !== activeWorkspaceIdRef.current) setActiveWorkspaceId(owner.id);
      if (autoFocusNewPane) setWorkspaces((prev) => prev.map((w) => (w.id === owner.id && w.focused !== id ? { ...w, focused: id } : w)));
      return;
    }
    // Otherwise add to the active workspace + focus it.
    setOpenPanes((p) => p.includes(id) ? p : [...p, id]);
    if (autoFocusNewPane) setFocused(id);
  }, [autoFocusNewPane, setOpenPanes, setFocused]);

  // handle focus-agent callback from Observer suggestion cards
  const handleFocusAgent = useCallback((id: string) => {
    openChat(id);
  }, [openChat]);

  // WARDEN-417: in-app catch-up for per-chat watch pings that fired while the human
  // was away (the OS notification was unsupported / denied / cleared / lost). Reads
  // the durable miss log written at the fire site in useAttentionRollup and surfaces
  // the unacknowledged away misses on return, each deep-linking to its watched pane
  // via the same openChat path. See useWatchCatchup / WatchCatchup.
  const watchCatchup = useWatchCatchup(openChat);
  // Wire the ack-on-open chokepoint: hand the hook's ackKey to the openChat ref above
  // so EVERY open of a watched chat (sidebar, OS-toast click, search, observer, catch-
  // up row) clears that chat's catch-up misses. ackKey is stable (its only dep is the
  // stable recompute), so this effect runs once; until it does, the ref is a no-op.
  useEffect(() => {
    ackWatchMissRef.current = watchCatchup.ackKey;
  }, [watchCatchup.ackKey]);

  // WARDEN-436: the live attention rollup is now owned by App (lifted UP from
  // AttentionBadge) so the SAME rollup feeds BOTH the header badge AND the
  // "While you were away" return banner — single source of truth, and the
  // /api/health (10s) + /api/agent-states (30s) polling still runs exactly ONCE.
  // (Option A from WARDEN-427: the alternative — a second hook instance in App —
  // would double that polling, which the codebase treats as an SSH-cost concern;
  // see useAttentionRollup.ts header.) The desktop-alert routing + watch-ping side
  // effects inside the hook keep working unchanged from this new call site;
  // AttentionBadge now receives the rollup as a prop instead of computing it.
  const attentionSeverityPrefs = useMemo<AttentionSeverityPrefs>(
    () => ({ alertCritical, alertWarning, alertDirective, alertError }),
    [alertCritical, alertWarning, alertDirective, alertError],
  );
  // The chat the observer should bind to when "observe focused" is clicked, AND
  // (WARDEN-426) the focused pane's identity for focus-gating the per-chat watch
  // ping. Hoisted above the lifted useAttentionRollup call (WARDEN-436) so the
  // focus-gate survives the lift — the hook consumes focusedPaneKey below. Derived
  // from chats (not `focused` raw) so a STALE focused key (a chat since closed/
  // re-keyed) resolves to null → the ping fires unchanged rather than spuriously
  // matching a transient row sharing the old key.
  const focusedChat = chats.find((c) => (c.key || c.id) === focused) || null;
  const focusedPaneKey = focusedChat?.key || focusedChat?.id || null;
  const { rollup: attentionRollup } = useAttentionRollup(
    attentionDesktopAlerts, openPanes, attentionStates, attentionSeverityPrefs, mutedAlertKeys, watchedChats, openChat, focusedPaneKey,
  );
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

  // WARDEN-378: toggle a chat's per-chat "watch" — marks it for a targeted,
  // reason-specific desktop ping when it newly needs the human. Turning watch ON
  // also requests OS notification permission (if not already granted) so the ping
  // can actually fire — the same requestAlertPermission the fleet-alert toggle uses.
  // Pure client-side state (persisted via the saveUi effect); no backend call. The
  // permission request is hoisted out of the updater (updaters must stay pure, and
  // StrictMode double-invokes them in dev); requestAlertPermission is idempotent.
  const toggleWatch = useCallback((key: string) => {
    const turningOn = !watchedChats.includes(key);
    setWatchedChats((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
    if (turningOn) void requestAlertPermission();
  }, [watchedChats]);

  // Seamless cross-host resume: when an observer session bound to an agent is
  // opened, reconnect to that agent's chat. We prime the pane's host hint and
  // (for remote hosts) discover the host so the pane can attach, then open the
  // chat — so the user never has to manually navigate to the right host.
  const handleReconnectChat = useCallback((chatKey: string, host?: string | null) => {
    if (host && host !== '(local)') {
      setPaneHost((p) => (p[chatKey] === host ? p : { ...p, [chatKey]: host }));
      void discoverHost(host);
    }
    openChat(chatKey);
  }, [openChat, discoverHost]);

  // ＋ split (WARDEN-223): spawn a scratch shell pane next to the focused pane,
  // derived entirely from it — same host, same cwd — like VSCode's integrated-
  // terminal split. The shell `cmd` is resolved through the single Default shell
  // setting (WARDEN-429): a per-host override (defaultShellByHost) wins, falling
  // back to the global defaultShell, then blank; blank means "no explicit shell"
  // so the host launches its own login shell. host/cwd are read from chatsRef so
  // this callback isn't rebuilt on every poll. A yatfa pane has no cwd → empty →
  // the host's default login dir, and its host is the SSH host, so the shell
  // lands OUTSIDE the container (host-side tmux).
  const handleSplitShell = useCallback(async () => {
    const id = focused;
    if (!id) return;
    const fc = chatsRef.current.find((c) => (c.key || c.id) === id);
    if (!fc) return;
    const host = fc.host || THIS_MACHINE;
    const cwd = fc.cwd || '';
    const cmd = (defaultShellByHost[host] ?? defaultShell ?? '').trim();
    const session = `split-${Math.random().toString(36).slice(2, 10)}`;
    const result = await postJson<{ chat: Chat }>('/api/spawn', { host, session, cwd, cmd });
    if (!result.ok || !result.data) {
      if (prefs.notifyErrors) toast.error(result.error || 'Failed to spawn split shell');
      return;
    }
    await refresh();
    openChat(result.data.chat.key || result.data.chat.id);
  }, [focused, defaultShell, defaultShellByHost, refresh, openChat, prefs.notifyErrors]);
  // A chat was spawned from a pane's recovery panel (open-shell / re-spawn,
  // WARDEN-231): refresh the list so the new chat appears, then open + focus it.
  const handlePaneSpawned = useCallback((chat: Chat) => {
    void refresh();
    openChat(chat.key || chat.id);
  }, [refresh, openChat]);

  // WARDEN-372: record a closing pane in the active workspace's recently-closed
  // recovery list. Snapshots the chat's display name/host/cwd at close time so the
  // row renders even if the chat later leaves the catalog. Dedup-by-id (a re-close
  // moves it to the top) + cap are handled by mergeRecentlyClosed. No-op when the
  // chat can't be found (e.g. a pane already gone from the catalog) — there is
  // nothing to snapshot or reopen. Reads chatsRef so this callback stays stable.
  const pushRecentlyClosed = useCallback((id: string) => {
    const c = chatsRef.current.find((x) => (x.key || x.id) === id);
    if (!c) return;
    const entry: RecentlyClosedEntry = {
      id,
      name: displayName(c),
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
  }, [setOpenPanes, setFocused, pushRecentlyClosed]);
  // remove the pane only (no recently-closed entry) — used by the KILL flow, since
  // a killed chat's tmux session is destroyed and is not safely reopenable.
  const removeActive = useCallback((id: string) => {
    setOpenPanes((p) => p.filter((x) => x !== id));
    setFocused((f) => (f === id ? null : f));
  }, [setOpenPanes, setFocused]);
  // reopen a recently-closed pane: drop it from the recovery list (it is no longer
  // closed), then open it. openChat re-primes paneHost from the live catalog entry,
  // so a remote pane re-discovers its host on reopen.
  const reopenClosed = useCallback((id: string) => {
    updateActiveWorkspace((w) => ({
      ...w,
      recentlyClosed: (w.recentlyClosed ?? []).filter((e) => e.id !== id),
    }));
    openChat(id);
  }, [updateActiveWorkspace, openChat]);
  const toggleMax = useCallback((id: string) => setMaximized((m) => (m === id ? null : id)), []);
  // Stable toggles for keyboard shortcuts: useCallback with functional updates gives
  // them empty deps and a stable identity, so PaneGrid's keydown effect doesn't
  // tear down/re-subscribe on every App render (matching every other PaneGrid handler).
  const toggleSidebar = useCallback(() => setSidebarCollapsed((c) => !c), []);
  const toggleObserver = useCallback(() => setObserverCollapsed((c) => !c), []);
  const clearNew = useCallback((id: string) => setNewActivity((prev) => { if (!prev.has(id)) return prev; const n = new Set(prev); n.delete(id); return n; }), []);

  // Force-kill confirmation. The ⏹ force-kill button sits directly beside
  // clear/download/close in the pane toolbar — a single misclick otherwise
  // kills a possibly-running agent's tmux session with no guard. When "Confirm
  // before destructive actions" is on (default), open a ConfirmDialog first;
  // when off (power-user opt-out), kill immediately with no friction.
  const [forceKillTarget, setForceKillTarget] = useState<string | null>(null);

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

  const forceKill = useCallback((id: string) => {
    if (confirmDestructiveActions) setForceKillTarget(id);
    else void performForceKill(id);
  }, [confirmDestructiveActions, performForceKill]);

  const confirmForceKill = useCallback(() => {
    const id = forceKillTarget;
    setForceKillTarget(null);
    if (id) void performForceKill(id);
  }, [forceKillTarget, performForceKill]);

  const cancelForceKill = useCallback(() => {
    setForceKillTarget(null);
  }, []);

  // Kill-chat confirmation + optimistic UI. The native `window.confirm` guard is
  // replaced by a controlled ConfirmDialog: `requestKill` opens it (or, when the
  // "Confirm before destructive actions" preference is off, fires immediately).
  // `performKill` is OPTIMISTIC — it removes the row from local state in the same
  // frame as the click, before the cross-host SSH round-trip to /api/kill, and
  // rolls the row back (chats entry + tab + pane) on failure. Because the row
  // vanishes instantly there is no longer a blocking kill spinner, so requestKill
  // no longer returns an awaitable promise.
  const [killTarget, setKillTarget] = useState<string | null>(null);

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
      if (host) void discoverHost(host);
      if (prefs.notifyChatOps) toast.success('Chat killed');
    } catch (error) {
      // ROLLBACK on a thrown error too (e.g. an unexpected exception).
      rollback();
      if (prefs.notifyChatOps) toast.error(`Failed to kill chat: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [refresh, discoverHost, removeActive, setOpenPanes, setFocused, prefs.notifyChatOps]);

  const requestKill = useCallback((id: string) => {
    if (confirmDestructiveActions) {
      setKillTarget(id); // opens the ConfirmDialog; confirmKill/cancelKill close it
    } else {
      // preference off: honor the opt-out — skip the confirm and kill immediately.
      void performKill(id);
    }
  }, [confirmDestructiveActions, performKill]);

  const confirmKill = useCallback(() => {
    const id = killTarget;
    setKillTarget(null);
    if (id) void performKill(id);
  }, [killTarget, performKill]);

  const cancelKill = useCallback(() => {
    setKillTarget(null);
  }, []);

  const resumeSession = useCallback(async (id: string, description: string, cwd: string, host: string) => {
    try {
      const result = await postJson<{ chat: { key: string; id: string } }>('/api/resume', { id, cwd, host, name: description || undefined });
      if (!result.ok) {
        if (prefs.notifyChatOps) toast.error(result.error || 'resume failed');
        return;
      }
      const chat = result.data!.chat;
      // Drop any stale entry for this resumed chat before refresh() so the catalog
      // merge can't carry forward its pre-resume status. Re-resuming the same Claude
      // session reuses the `resume-<sid>` tmux session, so the existing live entry
      // would otherwise briefly flash its old (e.g. idle) status until discoverHost
      // re-marks it active. (chat's key/id — not the bare Claude session id passed
      // in — is what matches a chat already in the list.)
      const resumedId = chat.key || chat.id;
      setChats((prev) => prev.filter((c) => (c.key || c.id) !== resumedId));
      await refresh();
      // Resuming activates the chat; re-discover the host so it shows green immediately
      // instead of waiting for the next auto-refresh tick.
      if (host) void discoverHost(host);
      openChat(chat.key);
      if (prefs.notifyChatOps) toast.success('Session resumed');
    } catch (e) {
      if (prefs.notifyChatOps) toast.error(e instanceof Error ? e.message : String(e));
    }
  }, [refresh, discoverHost, openChat, prefs.notifyChatOps]);

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

  const openActivityTab = useCallback(() => {
    setObserverCollapsed(false);
    setExternalViewMode('activity');
  }, []);

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

  const [workspaceCloseTarget, setWorkspaceCloseTarget] = useState<string | null>(null);
  const requestCloseWorkspace = useCallback((id: string) => setWorkspaceCloseTarget(id), []);
  const confirmCloseWorkspace = useCallback(() => {
    const id = workspaceCloseTarget;
    setWorkspaceCloseTarget(null);
    if (id) closeWorkspace(id);
  }, [workspaceCloseTarget, closeWorkspace]);
  const cancelCloseWorkspace = useCallback(() => setWorkspaceCloseTarget(null), []);

  const openPaneSet = new Set(openPanes);
  // WARDEN-378: O(1) "is this chat watched?" lookup for the sidebar rows (the watch
  // toggle's active state). A Set mirroring watchedChats, recomputed each render.
  const watchedChatSet = new Set(watchedChats);
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
  // Full-page "Open chat" browser view (WARDEN-216). Mirrors settingsOpen: an
  // App-level boolean toggled by the sidebar's "Open chat…" button; when true the
  // view-switch ternary below swaps the workspace for the browser page. Formerly a
  // blocking Dialog modal — now a full-page view per WARDEN-68 Rule 7 (the browser
  // is an unbounded list + search, not a ≤200-symbol confirmation).
  const [chatBrowserOpen, setChatBrowserOpen] = useState(false);
  // Whether the browser should open with sort-by-usage ON. Seeded true when the
  // browser is opened as a token-budget deep-link (WARDEN-415) so the heaviest
  // (offending) session floats to the top; the sidebar "Open chat…" button opens
  // it false (recency first). The page mounts fresh each open, so this is read
  // once as the local sortUsage initial. Reset on close.
  const [chatBrowserSortUsage, setChatBrowserSortUsage] = useState(false);
  // Stable close handler for the browser page. useState's setter is stable, so
  // wrapping it here keeps `onClose` identity stable across chat-poll ticks —
  // otherwise the page's Escape keydown effect would re-subscribe on every poll.
  const closeChatBrowser = useCallback(() => { setChatBrowserOpen(false); setChatBrowserSortUsage(false); }, []);
  // Token-spend budget alarm (WARDEN-415). The always-on hook polls /api/budget
  // on a slow cadence and fires a debounced one-shot (toast + desktop) on a
  // threshold crossing. onOpenSessions deep-links to the All Sessions usage view
  // (heaviest first) so a click lands on the offending session. The desktop
  // channel is gated on the same attentionDesktopAlerts opt-in the attention
  // alerts respect.
  const openSessionsView = useCallback(() => { setChatBrowserSortUsage(true); setChatBrowserOpen(true); }, []);
  const { budget: tokenBudget } = useTokenBudget({ attentionDesktopAlerts, onOpenSessions: openSessionsView });
  // Host connectivity statuses. Polled at the App level (formerly inside
  // ChatSidebar) so they stay live while the full-page browser view — which
  // replaces ChatSidebar — is open. Fed to both ChatSidebar and the browser page.
  const [hostStatuses, setHostStatuses] = useState<Record<string, { status: 'online' | 'offline' | 'unknown'; latency_ms: number | null }>>({});
  // Display customization settings
  const [displaySettings, setDisplaySettings] = useState({
    showHostTags: true,
    showTypeBadges: true,
    showStatusIndicators: true,
    showProjectBadges: false,
    hideOfflineHosts: false,
  });
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
              <Button
                variant="ghost"
                onClick={() => openChat(attentionTop.id)}
                aria-label={`You're needed in ${attentionTop.name ?? attentionTop.id}. Open it.`}
                className="shrink min-w-0 gap-2 h-auto py-1 px-2.5 rounded-md bg-white/80 dark:bg-blue-900/50 hover:bg-white dark:hover:bg-blue-900/70 text-blue-900 dark:text-blue-50 font-normal"
              >
                <span className={cn('size-2 rounded-full shrink-0', dotForState(attentionTop.state))} aria-hidden />
                <span className="text-sm whitespace-nowrap shrink-0">You&rsquo;re needed in</span>
                <span className="text-sm font-semibold max-w-40 truncate">{attentionTop.name ?? attentionTop.id}</span>
                <span className="text-xs text-blue-700/90 dark:text-blue-200/80 max-w-sm truncate">{attentionReason(attentionTop)}</span>
                <span className="text-xs text-blue-600 dark:text-blue-300 shrink-0 whitespace-nowrap">open →</span>
              </Button>
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
      />
      {settingsOpen ? (
        <SettingsPage
          onClose={() => setSettingsOpen(false)}
          onConfigChange={handleConfigChange}
          theme={theme}
          setTheme={setTheme}
          density={density}
          setDensity={setDensity}
          paneLayout={paneLayout}
          setPaneLayout={setPaneLayout}
          onExitBehavior={onExitBehavior}
          setOnExitBehavior={setOnExitBehavior}
          autoFocusNewPane={autoFocusNewPane}
          setAutoFocusNewPane={setAutoFocusNewPane}
          restoreOnStartup={restoreOnStartup}
          setRestoreOnStartup={setRestoreOnStartup}
          terminalFontSize={terminalFontSize}
          setTerminalFontSize={setTerminalFontSize}
          attentionDesktopAlerts={attentionDesktopAlerts}
          setAttentionDesktopAlerts={setAttentionDesktopAlerts}
          attentionStates={attentionStates}
          setAttentionStates={setAttentionStates}
          alertCritical={alertCritical}
          setAlertCritical={setAlertCritical}
          alertWarning={alertWarning}
          setAlertWarning={setAlertWarning}
          alertDirective={alertDirective}
          setAlertDirective={setAlertDirective}
          alertError={alertError}
          setAlertError={setAlertError}
          terminalScrollback={terminalScrollback}
          setTerminalScrollback={setTerminalScrollback}
          terminalFontFamily={terminalFontFamily}
          setTerminalFontFamily={setTerminalFontFamily}
          terminalColorScheme={terminalColorScheme}
          setTerminalColorScheme={setTerminalColorScheme}
          terminalCursorStyle={terminalCursorStyle}
          setTerminalCursorStyle={setTerminalCursorStyle}
          copyOnSelect={copyOnSelect}
          setCopyOnSelect={setCopyOnSelect}
          timestampFormat={timestampFormat}
          setTimestampFormat={setTimestampFormat}
          defaultNewChatPreset={defaultNewChatPreset}
          setDefaultNewChatPreset={setDefaultNewChatPreset}
          defaultNewChatPresetByHost={defaultNewChatPresetByHost}
          setDefaultNewChatPresetByHost={setDefaultNewChatPresetByHost}
          defaultNewChatHost={defaultNewChatHost}
          setDefaultNewChatHost={setDefaultNewChatHost}
          defaultNewChatCwd={defaultNewChatCwd}
          setDefaultNewChatCwd={setDefaultNewChatCwd}
          defaultNewChatCwdByHost={defaultNewChatCwdByHost}
          setDefaultNewChatCwdByHost={setDefaultNewChatCwdByHost}
          customPresets={customPresets}
          setCustomPresets={setCustomPresets}
          snippets={snippets}
          setSnippets={setSnippets}
          defaultShell={defaultShell}
          setDefaultShell={setDefaultShell}
          defaultShellByHost={defaultShellByHost}
          setDefaultShellByHost={setDefaultShellByHost}
          rememberWindowBounds={rememberWindowBounds}
          setRememberWindowBounds={setRememberWindowBounds}
          launchAtLogin={launchAtLogin}
          setLaunchAtLogin={setLaunchAtLogin}
          closeToTray={closeToTray}
          setCloseToTray={setCloseToTray}
          resetUiPrefsToDefaults={resetUiPrefsToDefaults}
        />
      ) : chatBrowserOpen ? (
        <OpenChatBrowserPage
          onClose={closeChatBrowser}
          hosts={hosts}
          chats={chats}
          onOpenChat={openChat}
          onResume={resumeSession}
          onDiscoverHost={discoverHost}
          hostStatuses={hostStatuses}
          timestampFormat={timestampFormat}
          hideOfflineHosts={displaySettings.hideOfflineHosts}
          budget={tokenBudget}
          initialSortUsage={chatBrowserSortUsage}
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
          <AttentionBadge rollup={attentionRollup} onOpenChat={openChat} onOpenActivity={openActivityTab} attentionDesktopAlerts={attentionDesktopAlerts} mutedAlertKeys={mutedAlertKeys} onToggleMuteAlertKey={toggleMuteAlertKey} />
          <IconTooltip label="global search (Ctrl+Shift+F)" side="bottom"><button onClick={() => setShowGlobalSearch(true)} className="text-muted-foreground hover:text-foreground transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded px-1.5 py-0.5 hover:bg-accent/50">⌕</button></IconTooltip>
          <IconTooltip label="toggle health panel" side="bottom"><button onClick={() => setHealthCollapsed(!healthCollapsed)} className="text-muted-foreground hover:text-foreground transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded px-1.5 py-0.5 hover:bg-accent/50">{healthCollapsed ? '◂' : '▸'} Health</button></IconTooltip>
          <IconTooltip label="toggle observer" side="bottom"><button onClick={() => setObserverCollapsed(!observerCollapsed)} className="text-muted-foreground hover:text-foreground transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded px-1.5 py-0.5 hover:bg-accent/50">{observerCollapsed ? '◂' : '▸'}</button></IconTooltip>
          <IconTooltip label="settings" side="bottom"><button onClick={() => setSettingsOpen(true)} className="text-muted-foreground hover:text-foreground transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded px-1.5 py-0.5 hover:bg-accent/50">⚙</button></IconTooltip>
        </div>
      </header>
      <main className="flex flex-1 min-h-0">
        <section className="border-r min-h-0 transition-all duration-200 ease-in-out overflow-hidden relative"
          style={{ width: sidebarCollapsed ? 0 : sidebarWidth, flexShrink: 0, opacity: sidebarCollapsed ? 0 : 1 }}>
          <div
            className="absolute top-0 right-0 bottom-0 w-1 hover:bg-accent hover:w-1.5 transition-all cursor-col-resize z-10"
            onMouseDown={handleSidebarMouseDown}
            title="Drag to resize sidebar"
          />
          <ErrorBoundary>
            <ChatSidebar
              chats={chats}
              sshHosts={sshHosts}
              openPanes={openPaneSet}
              recentlyClosed={activeWorkspace?.recentlyClosed ?? []}
              onOpenChat={openChat}
              onClosePane={closePane}
              onReopenClosed={reopenClosed}
              onKill={requestKill}
              onRename={renameChat}
              onResume={resumeSession}
              onRefresh={refresh}
              onDiscoverHost={discoverHost}
              loading={loading}
              lastRefreshAt={lastRefreshAt}
              showHostTags={displaySettings.showHostTags}
              showTypeBadges={displaySettings.showTypeBadges}
              showStatusIndicators={displaySettings.showStatusIndicators}
              showProjectBadges={displaySettings.showProjectBadges}
              hideOfflineHosts={displaySettings.hideOfflineHosts}
              onOpenChatBrowser={() => setChatBrowserOpen(true)}
              hostStatuses={hostStatuses}
              timestampFormat={timestampFormat}
              snippets={snippets}
              watchedChats={watchedChatSet}
              onToggleWatch={toggleWatch}
              agentFilter={agentFilter}
              agentSort={agentSort}
              onFilterChange={setAgentFilter}
              onSortChange={setAgentSort}
            />
          </ErrorBoundary>
        </section>
        <section className="flex-1 min-h-0 min-w-0">
          <PaneGrid
            tiles={tiles}
            focused={focused}
            maximized={maximized}
            newActivity={newActivity}
            chats={chats}
            paneHost={paneHost}
            onFocus={setFocused}
            onClose={closePane}
            onToggleMax={toggleMax}
            onClearNew={clearNew}
            onForceKill={forceKill}
            onSplitShell={handleSplitShell}
            onSpawned={handlePaneSpawned}
            externalSearchQuery={externalSearchQuery}
            onToggleSidebar={toggleSidebar}
            onToggleObserver={toggleObserver}
            fontSize={terminalFontSize}
            onFontSizeChange={setTerminalFontSize}
            scrollback={terminalScrollback}
            fontFamily={terminalFontFamily}
            paneLayout={paneLayout}
            terminalThemeId={terminalThemeId}
            terminalCursorStyle={terminalCursorStyle}
            copyOnSelect={copyOnSelect}
            onExitBehavior={onExitBehavior}
            showHostTags={displaySettings.showHostTags}
            snippets={snippets}
            timestampFormat={timestampFormat}
          />
        </section>
        <section className="border-l min-h-0 transition-all duration-200 ease-in-out overflow-hidden relative"
          style={{ width: observerCollapsed ? 0 : observerWidth, flexShrink: 0, opacity: observerCollapsed ? 0 : 1 }}>
          <div
            className="absolute top-0 left-0 bottom-0 w-1 hover:bg-accent hover:w-1.5 transition-all cursor-col-resize z-10"
            onMouseDown={handleObserverMouseDown}
            title="Drag to resize observer panel"
          />
          <ErrorBoundary>
            <ObserverTabs externalViewMode={externalViewMode} onFocusAgent={handleFocusAgent} focusedChat={focusedChat} onReconnectChat={handleReconnectChat} observerAutoStart={observerAutoStart} observerSessionTimeout={observerSessionTimeout} timestampFormat={timestampFormat} />
          </ErrorBoundary>
        </section>
        <section className="border-l min-h-0 transition-all duration-200 ease-in-out overflow-hidden"
          style={{ width: healthCollapsed ? 0 : HEALTH_WIDTH, flexShrink: 0, opacity: healthCollapsed ? 0 : 1 }}>
          <HealthDashboard
            onOpenChat={openChat}
            onClose={() => setHealthCollapsed(true)}
            timestampFormat={timestampFormat}
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
