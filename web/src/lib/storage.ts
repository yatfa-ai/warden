import type { AgentFilter, AgentSort } from './agentFilter';

// UI state persisted in localStorage.
// activeTabs = the user's persistent working set (survives reload, pane close, host nav).
// openPanes = which tabs have a live terminal open right now (subset of activeTabs).
//
// NOTE on durability (WARDEN-181): localStorage persists across a normal restart
// inside the OS-default userData dir. Reads below go through readVersioned() so a
// FUTURE localStorage KEY-version bump (v2 -> v3 ...) can never silently drop the
// user's data — the newest surviving payload is promoted forward to the current
// key instead. Persistence errors are surfaced via console.warn rather than
// swallowed (WARDEN-89), so a quota/serialization failure is never silent.
const KEY = 'warden:ui:v2';
const KEY_PREFIX = 'warden:ui';
const KEY_VERSION = 2;

// The default monospace font stack for every agent terminal pane. Must stay
// byte-identical to the previous hardcoded literal baked into PaneTile's
// Terminal constructor so "System default" reproduces today's exact appearance.
// Exported so storage (the pref owner), PaneTile (the use site), and the
// Settings curated list ("System default") all reference one source of truth.
export const DEFAULT_TERMINAL_FONT_FAMILY =
  '"Cascadia Code", "JetBrains Mono", "Fira Code", "Symbols Nerd Font", ui-monospace, Menlo, Consolas, monospace';

// Whether launch reopens the previous workspace ('previous', default = today's
// exact behavior) or starts with a clean workspace ('empty'). Pure client-side pref.
export type RestoreOnStartup = 'previous' | 'empty';

// How open agent panes are arranged: 'auto' (default = today's grid), 'stacked'
// (single column, full-width), or 'side-by-side' (single row). Pure client-side pref.
export type PaneLayout = 'auto' | 'stacked' | 'side-by-side';

// What happens to an already-open pane when its underlying agent process exits
// (its tmux session ends): 'keep' (default = today's behavior — leave the pane as
// a dead terminal the human closes by hand), 'dim' (mark it "exited" with an
// overlay + reduced opacity while keeping the last output readable for review),
// or 'auto-close' (remove the pane via the existing closePane path, once). Pure
// client-side pref; never sent to the backend. The exit signal is chat.active
// (the backend's authoritative tmux-session liveness), so this only reacts to a
// genuine live→exited transition of an already-open pane — never a pane whose
// agent never attached. See WARDEN-248.
export type OnExitBehavior = 'keep' | 'dim' | 'auto-close';

// Terminal cursor shape × blink for every agent pane. 'blink-block' (default)
// reproduces today's exact cursor (xterm's block + cursorBlink). The 'steady-*'
// variants stop the blink — the one piece of always-on motion WARDEN-190's
// reduced-motion work (CSS + scroll only) never reached, since xterm's cursor
// blink is independently timed. Pure client-side pref; never sent to the backend.
export type TerminalCursorStyle =
  | 'blink-block'
  | 'steady-block'
  | 'blink-underline'
  | 'steady-underline'
  | 'blink-bar'
  | 'steady-bar';

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

// Maximum length of a custom preset name. Centralized here so every write site
// (parseCustomPresets, SettingsPage add/rename, the name Inputs' maxLength)
// agrees with the load-time sanitizer on one bound — the in-memory list can
// never hold a name the sanitizer would silently drop on next reload.
export const PRESET_NAME_MAX = 32;

// Reserved built-in name check, CASE-INSENSITIVE — so "Claude"/"Shell" are
// rejected just like "claude"/"shell". This matches the case-insensitive name
// de-duplication, so a custom preset can never near-collide with a built-in
// quick-fill that is always rendered regardless of the custom list.
export function isReservedPresetName(name: string): boolean {
  const lower = name.toLowerCase();
  return BUILTIN_PRESETS.some((b) => b.toLowerCase() === lower);
}

// The validation outcome for a candidate preset name. `null` means acceptable.
export type PresetNameIssue = 'empty' | 'too-long' | 'reserved' | 'duplicate';

// Validate a candidate preset name against the SAME contract parseCustomPresets
// enforces at load time, so the Settings write sites (add/rename) can never
// persist a name the sanitizer would silently drop. Pure and dependency-free so
// it is unit-tested directly (there is no React test runner in this repo).
//   - `existing`: the current custom-preset list (for duplicate detection)
//   - `except`:   an entry name to EXCLUDE from duplicate detection (for renames,
//                 so a case-only rename like codex -> Codex isn't its own dupe)
// Trims the name first, matching how parseCustomPresets normalizes on load.
export function validatePresetName(
  name: string,
  existing: CustomPreset[],
  except?: string,
): PresetNameIssue | null {
  const n = name.trim();
  if (!n) return 'empty';
  if (n.length > PRESET_NAME_MAX) return 'too-long';
  if (isReservedPresetName(n)) return 'reserved';
  const lower = n.toLowerCase();
  if (existing.some((p) => p.name !== except && p.name.toLowerCase() === lower)) return 'duplicate';
  return null;
}

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
  // Opt-in OS desktop alert that fires when agents need attention AND Warden is
  // unfocused (WARDEN-259). Default OFF (opt-in). Pure client-side pref (like
  // terminalFontSize/scrollback); never sent to the backend / /api/config.
  attentionDesktopAlerts?: boolean;
  terminalScrollback?: number;
  // Terminal font family: the CSS font-family value xterm renders in every agent
  // pane. '' / absent = the DEFAULT_TERMINAL_FONT_FAMILY stack (today's look);
  // a curated named font or any pasted CSS value (e.g. a Nerd Font) otherwise.
  // Pure client-side pref (like terminalFontSize/scrollback); never sent to the
  // backend / /api/config.
  terminalFontFamily?: string;
  // Terminal color scheme: 'auto' (default) makes the terminal surface follow
  // the app's Light/Dark/System chrome preference; 'dark'/'light' force it
  // regardless of chrome (the common power-user "always dark terminal" case).
  // Pure client-side pref (like terminalFontSize/scrollback); never sent to the
  // backend / /api/config.
  terminalColorScheme?: 'auto' | 'dark' | 'light';
  // Terminal cursor shape × blink (blink/steady × block/underline/bar). Defaults
  // to 'blink-block' (today's exact cursor). Pure client-side pref (like
  // terminalFontSize/scrollback/colorScheme); never sent to the backend.
  terminalCursorStyle?: TerminalCursorStyle;
  theme?: 'light' | 'dark' | 'system';
  // UI density: 'comfortable' (default = today's spacing) or 'compact' (tighter
  // rows/headers/gaps so more agents fit per screen). Pure client-side pref.
  density?: 'comfortable' | 'compact';
  // Pane layout: how open agent panes are arranged. 'auto' (default = today's
  // grid: cols = ceil(sqrt(n))), 'stacked' (single column), or 'side-by-side'
  // (single row). Pure client-side pref; never sent to the backend.
  paneLayout?: PaneLayout;
  // What happens to an already-open pane when its agent process exits: 'keep'
  // (default = today's behavior), 'dim' (overlay + reduced opacity, keep last
  // output), or 'auto-close' (remove via closePane once). Pure client-side pref;
  // never sent to the backend. See OnExitBehavior / WARDEN-248.
  onExitBehavior?: OnExitBehavior;
  // Whether opening/resuming/splitting a chat auto-focuses the new pane (default
  // true = today's behavior). When false the focused pane is preserved; xterm's
  // native click-to-focus lets the user focus a pane on demand. Pure client-side
  // pref; never sent to the backend. See WARDEN-274.
  autoFocusNewPane?: boolean;
  // Whether launch reopens the previous workspace ('previous') or starts empty
  // ('empty'). Pure client-side pref; never sent to the backend.
  restoreOnStartup?: RestoreOnStartup;
  // Default agent type pre-filled in the New Chats spawn form. 'claude' and
  // 'shell' are reserved built-ins; any other value must name a `customPresets`
  // entry (falls back to 'claude' if that preset was since deleted). Pure
  // client-side pref; never sent to the backend.
  defaultNewChatPreset?: string;
  defaultNewChatHost?: string;
  // Default shell launched by the pane-grid ＋ split button (WARDEN-223). A
  // non-empty value (e.g. 'zsh', 'pwsh') is the `cmd` every split spawns; blank
  // (default) means "no explicit shell" — the host launches its own login shell
  // (auto-detected per host, never hardcoded). Independent of the New Chats
  // spawn presets above (a scratch terminal is a different concern). Pure
  // client-side pref; never sent to the backend / /api/config.
  defaultSplitShell?: string;
  // User-defined spawn presets (named quick-fill commands beyond claude/shell).
  // Validated on load: entries missing a name/cmd are dropped, names are bounded
  // (≤32 chars) and de-duplicated, and reserved built-in names are rejected.
  // Pure client-side pref; never sent to the backend.
  customPresets?: CustomPreset[];
  // pane id (chat key) -> host, so restored remote panes know which host to discover.
  paneHost?: Record<string, string>;
  agentFilter?: AgentFilter;
  agentSort?: AgentSort;
}

// Sanitize a raw customPresets value into a valid CustomPreset[]. Defensive:
// never throws on malformed input (WARDEN-89) — it drops bad entries instead, so
// one corrupt entry can never blank the spawn command. Drops entries missing a
// name or cmd, names over PRESET_NAME_MAX chars, reserved built-in names
// (case-insensitive), and duplicates (case-insensitive; first occurrence wins).
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
    if (name.length > PRESET_NAME_MAX) continue;
    if (isReservedPresetName(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, cmd });
  }
  return out;
}

// Version-tolerant read: prefer the current key, but if it is absent, walk down
// to older versioned (and finally unversioned) keys and promote the newest
// surviving payload up to the current key. This guarantees a key-version bump
// (v2 -> v3 ...) never silently drops the user's data — the prior payload
// migrates forward instead. Returns the raw string, or null if nothing survives.
function readVersioned(prefix: string, version: number): string | null {
  const currentKey = `${prefix}:v${version}`;
  const cur = localStorage.getItem(currentKey);
  if (cur != null) return cur;
  for (let v = version - 1; v >= 1; v--) {
    const k = `${prefix}:v${v}`;
    const raw = localStorage.getItem(k);
    if (raw != null) {
      try {
        localStorage.setItem(currentKey, raw);
        localStorage.removeItem(k);
      } catch (e) {
        console.warn(`[warden:storage] failed to migrate ${k} -> ${currentKey}`, e);
      }
      return raw;
    }
  }
  // Legacy unversioned key (pre-versioning) — promote it too.
  const legacy = localStorage.getItem(prefix);
  if (legacy != null) {
    try {
      localStorage.setItem(currentKey, legacy);
      localStorage.removeItem(prefix);
    } catch (e) {
      console.warn(`[warden:storage] failed to migrate ${prefix} -> ${currentKey}`, e);
    }
    return legacy;
  }
  return null;
}

// The defaults returned when nothing valid is stored. Centralized so the load
// fallback and every "missing field" coercion agree on one set of values.
const DEFAULT_UI: UiState = {
  activeTabs: [], hiddenTabs: [], openPanes: [], focused: null,
  sidebarCollapsed: false, observerCollapsed: false, healthCollapsed: true,
  sidebarWidth: 220, observerWidth: 380, terminalFontSize: 14,
  attentionDesktopAlerts: false,
  terminalScrollback: 10000, terminalFontFamily: '',
  terminalColorScheme: 'auto',
  terminalCursorStyle: 'blink-block',
  theme: 'system', density: 'comfortable', paneLayout: 'auto',
  onExitBehavior: 'keep',
  autoFocusNewPane: true,
  restoreOnStartup: 'previous',
  defaultNewChatPreset: 'claude', defaultNewChatHost: '(local)', customPresets: [],
  defaultSplitShell: '',
  paneHost: {}, agentFilter: 'all', agentSort: 'manual',
};

export function loadUi(): UiState {
  try {
    const v = JSON.parse(readVersioned(KEY_PREFIX, KEY_VERSION) ?? 'null');
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
        // Opt-in: only an explicitly-stored `true` enables it. Anything else
        // (missing / false / wrong type) stays OFF — the conservative default.
        attentionDesktopAlerts: v.attentionDesktopAlerts === true,
        terminalScrollback: typeof v.terminalScrollback === 'number' ? v.terminalScrollback : 10000,
        terminalFontFamily: typeof v.terminalFontFamily === 'string' ? v.terminalFontFamily : '',
        terminalColorScheme: ['auto', 'dark', 'light'].includes(v.terminalColorScheme) ? v.terminalColorScheme : 'auto',
        terminalCursorStyle: ['blink-block', 'steady-block', 'blink-underline', 'steady-underline', 'blink-bar', 'steady-bar'].includes(v.terminalCursorStyle) ? v.terminalCursorStyle : 'blink-block',
        theme: v.theme ?? 'system',
        density: v.density === 'compact' ? 'compact' : 'comfortable',
        paneLayout: (v.paneLayout === 'stacked' || v.paneLayout === 'side-by-side') ? v.paneLayout : 'auto',
        onExitBehavior: ['keep', 'dim', 'auto-close'].includes(v.onExitBehavior) ? v.onExitBehavior : 'keep',
        // Only an explicit false opts out; absent/unknown defaults to true so a
        // partial payload never silently disables focus-stealing.
        autoFocusNewPane: v.autoFocusNewPane !== false,
        restoreOnStartup: v.restoreOnStartup === 'empty' ? 'empty' : 'previous',
        defaultNewChatPreset: presetIsValid(v.defaultNewChatPreset) ? (v.defaultNewChatPreset as string) : 'claude',
        defaultNewChatHost: typeof v.defaultNewChatHost === 'string' ? v.defaultNewChatHost : '(local)',
        // Trim on load so stray whitespace never becomes the spawned shell name;
        // blank is the meaningful "auto-detect host login shell" value.
        defaultSplitShell: typeof v.defaultSplitShell === 'string' ? v.defaultSplitShell.trim() : '',
        customPresets,
        paneHost: (v.paneHost && typeof v.paneHost === 'object') ? v.paneHost : {},
        agentFilter: v.agentFilter ?? 'all',
        agentSort: v.agentSort ?? 'manual',
      };
    }
  } catch (e) {
    // WARDEN-89: surface the real failure instead of silently swallowing it.
    console.warn('[warden:storage] loadUi failed, using defaults', e);
  }
  return { ...DEFAULT_UI };
}

export function saveUi(s: UiState) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); }
  catch (e) { console.warn('[warden:storage] saveUi failed', e); }
}

// --- Resizable layout width clamps (WARDEN-183) ----------------------------
// Usable floors + caps for the two user-resizable panels, the reserved middle-
// pane column floor, and the fixed health-panel width. The drag handler, the
// window-resize listener, AND the persisted-width load all route through the
// clamp helpers below so a single source of truth governs every path: no panel
// can be crushed below a usable size, and two wide panels can never starve the
// middle pane column. These are layout *bounds* (tracked in px against mouse /
// viewport math), not inline visual styles — so WARDEN-68 Rule 2 (no magic-
// number inline px) does not apply to them; visual min-widths on inputs/tiles
// use Tailwind scale classes instead.
export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 400;
export const OBSERVER_MIN = 300;
export const OBSERVER_MAX = 600;
// Middle pane column floor — the anti-crush reserve. The clamps subtract it
// (plus the health panel when expanded) from the viewport so the sidebar and
// observer together can never leave the middle pane below this width.
export const PANE_MIN = 320;
export const HEALTH_WIDTH = 320;

export interface LayoutContext {
  windowWidth: number;
  healthCollapsed: boolean;
  // Collapse state for the shared re-clamp (clampLayoutWidths). A collapsed
  // panel is hidden — its flex column is width 0 — so it reserves NO shared
  // space and is never trimmed; only the *visible* panel(s) are clamped against
  // the space they actually occupy. The drag clamps already pass the OTHER panel
  // as 0 when it is collapsed (`dragOtherWidth = otherCollapsed ? 0 : other`),
  // so a panel can be dragged wide while its neighbor is hidden, storing a width
  // that only fits alone. The shared clamp must match that collapse-awareness so
  // a lone visible panel is never trimmed to reserve room for a hidden one, and
  // so the re-clamp that fires on the hidden panel's EXPAND trims the pair back
  // to fit (WARDEN-183 round 3). Optional: absent = visible (backward-compatible
  // with the load/drag callers that don't track collapse).
  sidebarCollapsed?: boolean;
  observerCollapsed?: boolean;
}

const clampN = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

// Viewport space the two resizable panels may share: viewport minus the middle-
// pane floor and the health panel (when expanded).
function sharedWidth(ctx: LayoutContext): number {
  return ctx.windowWidth - PANE_MIN - (ctx.healthCollapsed ? 0 : HEALTH_WIDTH);
}

// Clamp the sidebar width to [SIDEBAR_MIN, SIDEBAR_MAX], further capped so it
// can't crowd the middle pane below PANE_MIN given the observer's live width.
// Used by the sidebar drag handler — only the dragged panel is in motion, so
// the other panel's width is passed in (0 when collapsed).
export function clampSidebarWidth(requested: number, observerWidth: number, ctx: LayoutContext): number {
  const cap = Math.min(SIDEBAR_MAX, sharedWidth(ctx) - observerWidth);
  return clampN(requested, SIDEBAR_MIN, Math.max(SIDEBAR_MIN, cap));
}

// Symmetric clamp for the observer panel.
export function clampObserverWidth(requested: number, sidebarWidth: number, ctx: LayoutContext): number {
  const cap = Math.min(OBSERVER_MAX, sharedWidth(ctx) - sidebarWidth);
  return clampN(requested, OBSERVER_MIN, Math.max(OBSERVER_MIN, cap));
}

// Re-clamp BOTH panels together — for persisted-width load, window-resize, and
// any change in AVAILABLE/VISIBLE LAYOUT SPACE (health toggle, sidebar/observer
// collapse toggles), where neither panel is the active drag. A collapsed panel
// reserves no shared space and is never trimmed: widening one rail while the
// other is collapsed can store a width that only fits alone (the drag clamp
// treats a collapsed neighbor as 0), so the re-clamp that fires on the other
// rail's EXPAND is what trims the pair back to fit. Without it the middle pane
// column is crushed (WARDEN-183 round 3). If a stale pair or a shrunken viewport
// would together starve the middle (visible widths sum > shared space), each
// VISIBLE panel is trimmed toward its floor until they fit. The trim is
// deliberately ASYMMETRIC: the sidebar yields toward its floor first, and only
// once it can give no more does the observer give way — so a tighter layout
// shrinks the narrower, less-critical rail before the chat pane. Deterministic,
// not a sign of a bug; don't "fix" it toward symmetry without intent. At the
// 900px window floor there is always room for both minimums (180 + 300 + 320 =
// 800), so neither visible panel falls below its usable floor in practice.
export function clampLayoutWidths(
  requested: { sidebar: number; observer: number },
  ctx: LayoutContext,
): { sidebar: number; observer: number } {
  const sidebarVisible = !ctx.sidebarCollapsed;
  const observerVisible = !ctx.observerCollapsed;
  // Clamp each stored width into its own usable band regardless of visibility
  // (so a value stored while hidden is still in band when later expanded).
  let sidebar = clampN(requested.sidebar, SIDEBAR_MIN, SIDEBAR_MAX);
  let observer = clampN(requested.observer, OBSERVER_MIN, OBSERVER_MAX);
  // Only visible panels consume shared space; a hidden panel reserves none.
  const overshoot =
    (sidebarVisible ? sidebar : 0) + (observerVisible ? observer : 0) - sharedWidth(ctx);
  if (overshoot > 0) {
    // Trim visible panels toward their floors — sidebar yields first.
    if (sidebarVisible) {
      const sidebarTrim = Math.min(overshoot, Math.max(0, sidebar - SIDEBAR_MIN));
      sidebar -= sidebarTrim;
      const remaining = overshoot - sidebarTrim;
      if (remaining > 0 && observerVisible) {
        observer -= Math.min(remaining, Math.max(0, observer - OBSERVER_MIN));
      }
    } else if (observerVisible) {
      observer -= Math.min(overshoot, Math.max(0, observer - OBSERVER_MIN));
    }
  }
  return { sidebar, observer };
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
const OBS_PREFIX = 'warden:observer';
const OBS_VERSION = 1;
export interface ObsUi { openIds: string[]; activeId: string | null; viewMode?: 'sessions' | 'activity' }
export function loadObs(): ObsUi {
  try {
    const v = JSON.parse(readVersioned(OBS_PREFIX, OBS_VERSION) ?? 'null');
    if (v && Array.isArray(v.openIds)) return { openIds: v.openIds, activeId: v.activeId ?? null, viewMode: v.viewMode || 'sessions' };
  } catch (e) {
    console.warn('[warden:storage] loadObs failed, using defaults', e);
  }
  return { openIds: [], activeId: null, viewMode: 'sessions' };
}
export function saveObs(s: ObsUi) {
  try { localStorage.setItem(OBS_KEY, JSON.stringify(s)); }
  catch (e) { console.warn('[warden:storage] saveObs failed', e); }
}
