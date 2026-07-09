// UI state persisted in localStorage.
// activeTabs = the user's persistent working set (survives reload, pane close, host nav).
// openPanes = which tabs have a live terminal open right now (subset of activeTabs).
const KEY = 'warden:ui:v2';

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
  // pane id (chat key) -> host, so restored remote panes know which host to discover.
  paneHost?: Record<string, string>;
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
        paneHost: (v.paneHost && typeof v.paneHost === 'object') ? v.paneHost : {},
      };
    }
  } catch { /* ignore */ }
  return { activeTabs: [], hiddenTabs: [], openPanes: [], focused: null, sidebarCollapsed: false, observerCollapsed: false, healthCollapsed: true, sidebarWidth: 220, observerWidth: 380, terminalFontSize: 14, theme: 'system', density: 'comfortable', paneHost: {} };
}

export function saveUi(s: UiState) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
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
