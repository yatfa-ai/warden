// UI state persisted in localStorage.
// activeTabs = the user's persistent working set (survives reload, pane close, host nav).
// openPanes = which tabs have a live terminal open right now (subset of activeTabs).
const KEY = 'warden:ui:v2';

// Whether launch reopens the previous workspace ('previous', default = today's
// exact behavior) or starts with a clean workspace ('empty'). Pure client-side pref.
export type RestoreOnStartup = 'previous' | 'empty';

// How open agent panes are arranged: 'auto' (default = today's grid), 'stacked'
// (single column, full-width), or 'side-by-side' (single row). Pure client-side pref.
export type PaneLayout = 'auto' | 'stacked' | 'side-by-side';

// A user-defined spawn preset: a named quick-fill command beyond the two
// built-in claude/shell presets (e.g. "codex" → "codex"). Pure client-side pref;
// never sent to the backend. `name` is also a valid `defaultNewChatPreset` value.
export interface CustomPreset {
  name: string;
  cmd: string;
}

// The reserved built-in preset names — custom presets may not reuse them (they
// are always available as quick-fills regardless of the custom list).
export const BUILTIN_PRESETS = ['claude', 'shell'] as const;

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
  terminalScrollback?: number;
  // Terminal color scheme: 'auto' (default) makes the terminal surface follow
  // the app's Light/Dark/System chrome preference; 'dark'/'light' force it
  // regardless of chrome (the common power-user "always dark terminal" case).
  // Pure client-side pref (like terminalFontSize/scrollback); never sent to the
  // backend / /api/config.
  terminalColorScheme?: 'auto' | 'dark' | 'light';
  theme?: 'light' | 'dark' | 'system';
  // UI density: 'comfortable' (default = today's spacing) or 'compact' (tighter
  // rows/headers/gaps so more agents fit per screen). Pure client-side pref.
  density?: 'comfortable' | 'compact';
  // Pane layout: how open agent panes are arranged. 'auto' (default = today's
  // grid: cols = ceil(sqrt(n))), 'stacked' (single column), or 'side-by-side'
  // (single row). Pure client-side pref; never sent to the backend.
  paneLayout?: PaneLayout;
  // Whether launch reopens the previous workspace ('previous') or starts empty
  // ('empty'). Pure client-side pref; never sent to the backend.
  restoreOnStartup?: RestoreOnStartup;
  // Default agent type pre-filled in the New Chats spawn form. 'claude' and
  // 'shell' are reserved built-ins; any other value must name a `customPresets`
  // entry (falls back to 'claude' if that preset was since deleted). Pure
  // client-side pref; never sent to the backend.
  defaultNewChatPreset?: string;
  defaultNewChatHost?: string;
  // User-defined spawn presets (named quick-fill commands beyond claude/shell).
  // Validated on load: entries missing a name/cmd are dropped, names are bounded
  // (≤32 chars) and de-duplicated, and reserved built-in names are rejected.
  // Pure client-side pref; never sent to the backend.
  customPresets?: CustomPreset[];
  // pane id (chat key) -> host, so restored remote panes know which host to discover.
  paneHost?: Record<string, string>;
  agentFilter?: 'all' | 'yatfa' | 'claude' | 'manual' | 'active' | 'hidden';
  agentSort?: 'manual' | 'name' | 'host' | 'status' | 'activity';
}

// Sanitize a raw customPresets value into a valid CustomPreset[]. Defensive:
// never throws on malformed input (WARDEN-89) — it drops bad entries instead, so
// one corrupt entry can never blank the spawn command. Drops entries missing a
// name or cmd, names over 32 chars, reserved built-in names, and duplicates
// (case-insensitive; first occurrence wins).
function parseCustomPresets(raw: unknown): CustomPreset[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined && raw !== null) {
      // A present-but-wrong-type value is genuine corruption worth surfacing.
      console.warn('[loadUi] customPresets is not an array; ignoring:', raw);
    }
    return [];
  }
  const seen = new Set<string>();
  const out: CustomPreset[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    const cmd = typeof e.cmd === 'string' ? e.cmd.trim() : '';
    if (!name || !cmd) continue;
    if (name.length > 32) continue;
    if ((BUILTIN_PRESETS as readonly string[]).includes(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, cmd });
  }
  return out;
}

export function loadUi(): UiState {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '');
    if (v && Array.isArray(v.activeTabs)) {
      // Parse custom presets first so defaultNewChatPreset can be validated
      // against them: a default naming a since-deleted preset falls back to claude.
      const customPresets = parseCustomPresets(v.customPresets);
      const presetIsValid = (p: unknown): boolean =>
        typeof p === 'string' && (
          (BUILTIN_PRESETS as readonly string[]).includes(p) ||
          customPresets.some((c) => c.name === p)
        );
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
        terminalScrollback: typeof v.terminalScrollback === 'number' ? v.terminalScrollback : 10000,
        terminalColorScheme: ['auto', 'dark', 'light'].includes(v.terminalColorScheme) ? v.terminalColorScheme : 'auto',
        theme: v.theme ?? 'system',
        density: v.density === 'compact' ? 'compact' : 'comfortable',
        paneLayout: (v.paneLayout === 'stacked' || v.paneLayout === 'side-by-side') ? v.paneLayout : 'auto',
        restoreOnStartup: v.restoreOnStartup === 'empty' ? 'empty' : 'previous',
        defaultNewChatPreset: presetIsValid(v.defaultNewChatPreset) ? (v.defaultNewChatPreset as string) : 'claude',
        defaultNewChatHost: typeof v.defaultNewChatHost === 'string' ? v.defaultNewChatHost : '(local)',
        customPresets,
        paneHost: (v.paneHost && typeof v.paneHost === 'object') ? v.paneHost : {},
        agentFilter: v.agentFilter ?? 'all',
        agentSort: v.agentSort ?? 'manual',
      };
    }
  } catch { /* ignore */ }
  return { activeTabs: [], hiddenTabs: [], openPanes: [], focused: null, sidebarCollapsed: false, observerCollapsed: false, healthCollapsed: true, sidebarWidth: 220, observerWidth: 380, terminalFontSize: 14, terminalScrollback: 10000, terminalColorScheme: 'auto', theme: 'system', density: 'comfortable', paneLayout: 'auto', restoreOnStartup: 'previous', defaultNewChatPreset: 'claude', defaultNewChatHost: '(local)', customPresets: [], paneHost: {}, agentFilter: 'all', agentSort: 'manual' };
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
