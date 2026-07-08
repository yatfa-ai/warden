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
      };
    }
  } catch { /* ignore */ }
  return { activeTabs: [], hiddenTabs: [], openPanes: [], focused: null, sidebarCollapsed: false, observerCollapsed: false, healthCollapsed: true, sidebarWidth: 220, observerWidth: 380 };
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
