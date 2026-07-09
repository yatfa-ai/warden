// UI state persisted in localStorage.
// activeTabs = the user's persistent working set (survives reload, pane close, host nav).
// openPanes = which tabs have a live terminal open right now (subset of activeTabs).
const KEY = 'warden:ui:v2';

// Whether launch reopens the previous workspace ('previous', default = today's
// exact behavior) or starts with a clean workspace ('empty'). Pure client-side pref.
export type RestoreOnStartup = 'previous' | 'empty';

export interface UiState {
  activeTabs: string[];
  hiddenTabs: string[];
  openPanes: string[];
  focused: string | null;
  sidebarCollapsed: boolean;
  observerCollapsed: boolean;
  healthCollapsed?: boolean;
  sidebarWidth?: number;
  observerWidth?: number;
  terminalFontSize?: number;
  theme?: 'light' | 'dark' | 'system';
  // UI density: 'comfortable' (default = today's spacing) or 'compact' (tighter
  // rows/headers/gaps so more agents fit per screen). Pure client-side pref.
  density?: 'comfortable' | 'compact';
  // Whether launch reopens the previous workspace ('previous') or starts empty
  // ('empty'). Pure client-side pref; never sent to the backend.
  restoreOnStartup?: RestoreOnStartup;
  // pane id (chat key) -> host, so restored remote panes know which host to discover.
  paneHost?: Record<string, string>;
  agentFilter?: 'all' | 'yatfa' | 'claude' | 'manual' | 'active' | 'hidden';
  agentSort?: 'manual' | 'name' | 'host' | 'status' | 'activity';
}

export function loadUi(): UiState {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '');
    if (v && Array.isArray(v.activeTabs)) {
      return {
        activeTabs: v.activeTabs.map((t: any) => typeof t === 'string' ? t : t.id),
        hiddenTabs: Array.isArray(v.hiddenTabs) ? v.hiddenTabs : [],
        openPanes: Array.isArray(v.openPanes) ? v.openPanes.map((t: any) => typeof t === 'string' ? t : t.id) : [],
        focused: v.focused ?? null,
        sidebarCollapsed: v.sidebarCollapsed ?? false,
        observerCollapsed: v.observerCollapsed ?? false,
        healthCollapsed: v.healthCollapsed ?? true,
        sidebarWidth: typeof v.sidebarWidth === 'number' ? v.sidebarWidth : 220,
        observerWidth: typeof v.observerWidth === 'number' ? v.observerWidth : 380,
        terminalFontSize: typeof v.terminalFontSize === 'number' ? v.terminalFontSize : 14,
        theme: v.theme ?? 'system',
        density: v.density === 'compact' ? 'compact' : 'comfortable',
        restoreOnStartup: v.restoreOnStartup === 'empty' ? 'empty' : 'previous',
        paneHost: (v.paneHost && typeof v.paneHost === 'object') ? v.paneHost : {},
        agentFilter: v.agentFilter ?? 'all',
        agentSort: v.agentSort ?? 'manual',
      };
    }
  } catch { /* ignore */ }
  return { activeTabs: [], hiddenTabs: [], openPanes: [], focused: null, sidebarCollapsed: false, observerCollapsed: false, healthCollapsed: true, sidebarWidth: 220, observerWidth: 380, terminalFontSize: 14, theme: 'system', density: 'comfortable', restoreOnStartup: 'previous', paneHost: {}, agentFilter: 'all', agentSort: 'manual' };
}

export function saveUi(s: UiState) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

// The workspace fields that the "Restore workspace on startup" pref gates. These
// are what an 'empty' launch must blank and what 'previous' must restore. paneHost
// is required here: initialWorkspace always returns a concrete object for it.
type Workspace = {
  activeTabs: string[];
  hiddenTabs: string[];
  openPanes: string[];
  focused: string | null;
  paneHost: Record<string, string>;
};

// Workspace to seed React state with on mount, honoring the pref. 'previous'
// restores the last-saved workspace (today's behavior); 'empty' hands back a
// clean slate regardless of what was open at last close. Pure: no localStorage.
export function initialWorkspace(disk: UiState, restoreOnStartup: RestoreOnStartup): Workspace {
  if (restoreOnStartup === 'empty') {
    return { activeTabs: [], hiddenTabs: [], openPanes: [], focused: null, paneHost: {} };
  }
  return {
    activeTabs: disk.activeTabs,
    hiddenTabs: disk.hiddenTabs,
    openPanes: disk.openPanes,
    focused: disk.focused,
    paneHost: disk.paneHost ?? {},
  };
}

// Build the UiState to persist, honoring the pref. CRITICAL: the live workspace
// arrays are NOT always a legitimate restorable snapshot — they are blank on a
// clean mount whose pref is 'empty' (the initializers gate via initialWorkspace),
// and they STAY blank for that whole session even if the user flips back to
// 'previous' mid-session. Persisting them verbatim in either case would overwrite
// and DESTROY the last-saved workspace (violating "flipping back to Reopen
// previous still restores it"). So we carry the workspace forward from the on-disk
// snapshot whenever the pref is 'empty' OR this launch started empty
// (`startedEmpty`, captured at mount); all other fields always persist from `live`.
// Pure: no localStorage access (the caller passes the `disk` snapshot).
export function persistUiState(
  live: Omit<UiState, 'restoreOnStartup'>,
  restoreOnStartup: RestoreOnStartup,
  disk: UiState,
  startedEmpty: boolean,
): UiState {
  if (restoreOnStartup === 'empty' || startedEmpty) {
    return {
      ...live,
      activeTabs: disk.activeTabs,
      hiddenTabs: disk.hiddenTabs,
      openPanes: disk.openPanes,
      focused: disk.focused,
      paneHost: disk.paneHost,
      restoreOnStartup,
    };
  }
  return { ...live, restoreOnStartup };
}

// Observer tabs
const OBS_KEY = 'warden:observer:v1';
export interface ObsUi { openIds: string[]; activeId: string | null; viewMode?: 'sessions' | 'activity' }
export function loadObs(): ObsUi {
  try {
    const v = JSON.parse(localStorage.getItem(OBS_KEY) || '');
    if (v && Array.isArray(v.openIds)) return { openIds: v.openIds, activeId: v.activeId ?? null, viewMode: v.viewMode || 'sessions' };
  } catch { /* ignore */ }
  return { openIds: [], activeId: null, viewMode: 'sessions' };
}
export function saveObs(s: ObsUi) {
  try { localStorage.setItem(OBS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}
