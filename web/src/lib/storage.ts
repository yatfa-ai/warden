import type { AgentFilter, AgentSort } from './agentFilter';
import type { TimestampFormat } from './formatTimestamp';

// UI state persisted in localStorage.
// activeTabs = the user's persistent working set (survives reload, pane close, host nav).
//   (Flat + global — the sidebar's working set, unchanged by WARDEN-256.)
// workspaces = the browser-tab-style project pane-sets the user switches between;
//   each owns its own openPanes + focused. activeWorkspaceId picks the one whose
//   panes render in the grid. A pane lives in at most one workspace (openChat
//   dedups across workspaces). paneHost stays global (keyed by pane id).
//
// NOTE on durability (WARDEN-181): localStorage persists across a normal restart
// inside the OS-default userData dir. Reads below go through readVersioned() so a
// FUTURE localStorage KEY-version bump (v2 -> v3 ...) can never silently drop the
// user's data — the newest surviving payload is promoted forward to the current
// key instead. Persistence errors are surfaced via console.warn rather than
// swallowed (WARDEN-89), so a quota/serialization failure is never silent.
import { normalizeThemePref, type ThemePref } from '@/lib/themes';

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

// WARDEN-261 — per-host options. Host-keyed (the chat's `host`: '(local)' or an
// SSH alias) so the Seamless-copy toggle is independent per host. Pure client-
// side pref like the other terminal prefs: persisted here, sent to the backend
// only as a transient attach flag (not via /api/config), so the backend never
// owns or persists it. `seamlessCopy` disabled tmux mouse on attach for that
// host's tmux so xterm owns the selection and the standard copy gesture works.
export interface HostOptions {
  seamlessCopy?: boolean;
}
export type HostOptionsMap = Record<string, HostOptions>;

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

// A named workspace: one browser-tab-style project pane-set. Owns its openPanes
// (the pane ids with a live terminal in the grid when this workspace is active)
// and its focused pane. `id` is a stable UUID (never an array index) so drag-
// and-drop payloads identify a workspace unambiguously (WARDEN-108). `name` is
// the user-editable tab label. Pure client-side pref; never sent to the backend.
export interface WorkspacePaneSet {
  id: string;
  name: string;
  openPanes: string[];
  focused: string | null;
}

// Default name for the first / migrated workspace. New workspaces created via
// the ＋ button get "Workspace N" by the caller (App knows the live count).
export const DEFAULT_WORKSPACE_NAME = 'Workspace 1';

// Generate a workspace id. crypto.randomUUID() is available in every target
// (modern browsers + Node ≥19, including the storage test harness which loads
// this module in Node). Used at load/parse/create time only — never on the hot
// render path.
function genWorkspaceId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `ws-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

// Construct a workspace. Centralizes the id + shape so DEFAULT_UI, load-time
// migration, and parseWorkspace all agree on one factory.
function makeWorkspace(
  name: string,
  openPanes: string[] = [],
  focused: string | null = null,
  id: string = genWorkspaceId(),
): WorkspacePaneSet {
  return { id, name, openPanes, focused };
}

export interface UiState {
  activeTabs: string[];
  hiddenTabs: string[];
  // Browser-tab-style project pane-sets (WARDEN-256). Each workspace owns its own
  // openPanes + focused; switching the active workspace swaps the pane grid. A
  // pane id lives in at most one workspace's openPanes (openChat dedups across
  // them). activeTabs/hiddenTabs stay flat + global (the sidebar's working set,
  // unchanged); paneHost stays global (keyed by pane id).
  workspaces: WorkspacePaneSet[];
  activeWorkspaceId: string | null;
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
  // Per-state toggle for the Attention badge + desktop alert (WARDEN-344): which
  // pane states (stuck/erroring/waiting/blocked) raise attention. Each defaults to
  // ON so every state surfaces; a human can silence a noisy "waiting" without losing
  // "erroring". Pure client-side pref; never sent to the backend / /api/config.
  attentionStates?: { stuck?: boolean; erroring?: boolean; waiting?: boolean; blocked?: boolean };
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
  // "Copy on select": when true, completing a text selection in any agent pane
  // copies it to the system clipboard immediately (no Ctrl/Cmd+C needed) — the
  // select-to-copy behavior humans expect from iTerm2/GNOME-Terminal/Windows
  // Terminal. Default OFF (opt-in = today's exact behavior, zero regression).
  // Pure client-side pref (like terminalFontSize/scrollback); never sent to the
  // backend. See WARDEN-285.
  copyOnSelect?: boolean;
  // How timestamps render across the dashboard: 'relative' (default = today's
  // "2m"/"3h" buckets) or 'absolute' (clock time "2:13 PM"). Pure client-side
  // pref (like density/copyOnSelect); persisted by App's saveUi effect, never
  // sent to the backend / /api/config. See WARDEN-213.
  timestampFormat?: TimestampFormat;
  // App theme: either a concrete named-theme id (e.g. 'github-dark',
  // 'dracula') or 'system' to follow the OS. Default 'system'. Backward
  // compatible: a legacy stored 'light'/'dark'/'system' value migrates on load
  // to the closest named theme (via normalizeThemePref), so an upgrade never
  // crashes. Pure client-side pref; never sent to the backend / /api/config.
  theme?: ThemePref;
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
  // Default working directory pre-filled in the ＋ new chat spawn form
  // (WARDEN-311). Blank (default) → the host's home directory (today's
  // behavior); a path like '~/projects/warden' is seeded into the cwd field and
  // remains editable per-spawn. Pure client-side pref; never sent to the
  // backend / /api/config.
  defaultNewChatCwd?: string;
  // Per-host default working directory overrides for the ＋ new chat spawn form
  // (WARDEN-336). Keys are the host strings — '(local)' for local, the SSH host
  // name for remote (matching defaultNewChatHost); values are cwd paths. A host
  // with no entry (or an empty/whitespace value, dropped on load) falls through
  // to defaultNewChatCwd, then blank — identical to today's single-host
  // behavior. Sanitized on load by parseCwdByHost. Pure client-side pref; never
  // sent to the backend / /api/config.
  defaultNewChatCwdByHost?: Record<string, string>;
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
  // WARDEN-261: per-host options map. Host-keyed (chat `host` → options). Pure
  // client-side pref like terminalCursorStyle; sent to the backend only as the
  // transient `seamlessCopy` attach flag, never via /api/config.
  hostOptions?: HostOptionsMap;
  // WARDEN-261: per-host dismissal of the "copy may not grab selected text"
  // hint. Host-keyed; once dismissed, the hint stays silenced for that host.
  // Pure client-side pref like terminalCursorStyle; never sent to the backend.
  copyHintDismissed?: Record<string, boolean>;
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

// Sanitize a raw defaultNewChatCwdByHost value (host key → default cwd) into a
// valid Record<string,string>. Defensive: never throws on malformed input
// (WARDEN-89) — it drops bad entries instead, so one corrupt/blank entry can
// never blank the spawn cwd field. Modeled on parseCustomPresets (and explicitly
// NOT on the looser paneHost loader, which does not coerce values): each entry
// requires a non-empty trimmed-string KEY and a trimmed-string VALUE, and
// entries whose value is empty/whitespace are dropped — an empty override means
// "use the global defaultNewChatCwd" and so must never persist as a blank that
// could seed the spawn field empty. Values are trimmed, matching
// defaultNewChatCwd's own load-time trim (line ~331).
function parseCwdByHost(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== undefined && raw !== null) {
      // A present-but-wrong-type value is genuine corruption worth surfacing.
      console.warn('[loadUi] defaultNewChatCwdByHost is not an object; ignoring:', raw);
    }
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = typeof k === 'string' ? k.trim() : '';
    const val = typeof v === 'string' ? v.trim() : '';
    if (!key || !val) continue; // empty key → drop; empty value → inherit global default
    out[key] = val;
  }
  return out;
}

// Sanitize a raw hostOptions value into a valid HostOptionsMap. Defensive: never
// throws (WARDEN-89) — drops bad entries instead, so one corrupt host can never
// blank another host's options. Keys are strings (host names); each value must
// be an object whose `seamlessCopy` (if present) is coerced to a boolean.
// Mirrors parseCustomPresets's drop-bad-entries discipline.
function parseHostOptions(raw: unknown): HostOptionsMap {
  if (!raw || typeof raw !== 'object') {
    if (raw !== undefined && raw !== null) {
      console.warn('[loadUi] hostOptions is not an object; ignoring:', raw);
    }
    return {};
  }
  const out: HostOptionsMap = {};
  for (const [host, val] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof host !== 'string' || !host) continue;
    if (!val || typeof val !== 'object') continue;
    const v = val as Record<string, unknown>;
    const entry: HostOptions = {};
    if (typeof v.seamlessCopy === 'boolean') entry.seamlessCopy = v.seamlessCopy;
    // An entry with no recognized fields is dropped (never persists empty junk).
    if (Object.keys(entry).length) out[host] = entry;
  }
  return out;
}

// Sanitize a raw copyHintDismissed value into Record<host, boolean>. Defensive:
// drops non-boolean values so a corrupt entry can't survive (WARDEN-89).
function parseDismissedMap(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, boolean> = {};
  for (const [host, val] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof host === 'string' && host && typeof val === 'boolean') out[host] = val;
  }
  return out;
}

// Sanitize a raw workspaces value into a valid, id-unique WorkspacePaneSet[].
// Defensive: never throws on malformed input (WARDEN-89) — drops/replaces bad
// entries instead, so one corrupt workspace can never blank the pane grid.
//   - non-array / empty → [] (the caller migrates from legacy flat fields or
//     seeds a default, so this never leaves loadUi with zero workspaces).
//   - each entry: id coerced to a fresh UUID if missing/duplicate; name trimmed
//     with a fallback; openPanes filtered to strings; focused kept only if a
//     string (a focused id not in openPanes is left as-is — harmless, the grid
//     derives from openPanes).
// Id UNIQUENESS is enforced (first occurrence wins; duplicates get fresh ids)
// so active-workspace lookup-by-id is always unambiguous.
function parseWorkspaces(raw: unknown): WorkspacePaneSet[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined && raw !== null) {
      console.warn('[loadUi] workspaces is not an array; ignoring:', raw);
    }
    return [];
  }
  const seenIds = new Set<string>();
  const out: WorkspacePaneSet[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    let id = typeof e.id === 'string' && e.id ? e.id : genWorkspaceId();
    if (seenIds.has(id)) id = genWorkspaceId();
    seenIds.add(id);
    const name = typeof e.name === 'string' && e.name.trim() ? e.name.trim() : DEFAULT_WORKSPACE_NAME;
    const openPanes = Array.isArray(e.openPanes) ? e.openPanes.filter((p: unknown): p is string => typeof p === 'string') : [];
    const focused = typeof e.focused === 'string' ? e.focused : null;
    out.push({ id, name, openPanes, focused });
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
// The default owns exactly one empty workspace (the active one).
const DEFAULT_WORKSPACE = makeWorkspace(DEFAULT_WORKSPACE_NAME);
const DEFAULT_UI: UiState = {
  activeTabs: [], hiddenTabs: [],
  workspaces: [DEFAULT_WORKSPACE],
  activeWorkspaceId: DEFAULT_WORKSPACE.id,
  sidebarCollapsed: false, observerCollapsed: false, healthCollapsed: true,
  sidebarWidth: 220, observerWidth: 380, terminalFontSize: 14,
  attentionDesktopAlerts: false,
  attentionStates: { stuck: true, erroring: true, waiting: true, blocked: true },
  terminalScrollback: 10000, terminalFontFamily: '',
  terminalColorScheme: 'auto',
  terminalCursorStyle: 'blink-block',
  copyOnSelect: false,
  timestampFormat: 'relative',
  theme: 'system', density: 'comfortable', paneLayout: 'auto',
  onExitBehavior: 'keep',
  autoFocusNewPane: true,
  restoreOnStartup: 'previous',
  defaultNewChatPreset: 'claude', defaultNewChatHost: '(local)', customPresets: [], defaultNewChatCwd: '', defaultNewChatCwdByHost: {},
  defaultSplitShell: '',
  paneHost: {}, agentFilter: 'all', agentSort: 'manual',
  hostOptions: {}, copyHintDismissed: {},
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
      // Workspaces: parse the new model, migrating legacy single-workspace state
      // (flat openPanes/focused) forward on first load so no open pane is lost.
      let workspaces = parseWorkspaces(v.workspaces);
      if (!workspaces.length) {
        // Legacy migration (WARDEN-256): workspaces absent → synthesize ONE
        // workspace from the prior flat openPanes/focused. paneHost stays global.
        const legacyOpen = Array.isArray(v.openPanes)
          ? v.openPanes.map((t: any) => typeof t === 'string' ? t : t.id).filter((s: any): s is string => typeof s === 'string')
          : [];
        const legacyFocused = typeof v.focused === 'string' ? v.focused : null;
        workspaces = [makeWorkspace(DEFAULT_WORKSPACE_NAME, legacyOpen, legacyFocused)];
      }
      // activeWorkspaceId must point at a real workspace; fall back to the first.
      const activeWorkspaceId =
        typeof v.activeWorkspaceId === 'string' && workspaces.some((w) => w.id === v.activeWorkspaceId)
          ? v.activeWorkspaceId
          : workspaces[0].id;
      return {
        activeTabs: v.activeTabs.map((t: any) => typeof t === 'string' ? t : t.id),
        hiddenTabs: Array.isArray(v.hiddenTabs) ? v.hiddenTabs : [],
        workspaces,
        activeWorkspaceId,
        sidebarCollapsed: v.sidebarCollapsed ?? false,
        observerCollapsed: v.observerCollapsed ?? false,
        healthCollapsed: v.healthCollapsed ?? true,
        sidebarWidth: typeof v.sidebarWidth === 'number' ? v.sidebarWidth : 220,
        observerWidth: typeof v.observerWidth === 'number' ? v.observerWidth : 380,
        terminalFontSize: typeof v.terminalFontSize === 'number' ? v.terminalFontSize : 14,
        // Opt-in: only an explicitly-stored `true` enables it. Anything else
        // (missing / false / wrong type) stays OFF — the conservative default.
        attentionDesktopAlerts: v.attentionDesktopAlerts === true,
        // Per-state toggle: each state defaults ON (only an explicit false silences
        // it), so a partial/legacy payload never drops a state silently. Matches
        // buildAttentionRollup's `enabledStates[k] !== false` semantics.
        attentionStates: {
          stuck: v.attentionStates?.stuck !== false,
          erroring: v.attentionStates?.erroring !== false,
          waiting: v.attentionStates?.waiting !== false,
          blocked: v.attentionStates?.blocked !== false,
        },
        terminalScrollback: typeof v.terminalScrollback === 'number' ? v.terminalScrollback : 10000,
        terminalFontFamily: typeof v.terminalFontFamily === 'string' ? v.terminalFontFamily : '',
        terminalColorScheme: ['auto', 'dark', 'light'].includes(v.terminalColorScheme) ? v.terminalColorScheme : 'auto',
        terminalCursorStyle: ['blink-block', 'steady-block', 'blink-underline', 'steady-underline', 'blink-bar', 'steady-bar'].includes(v.terminalCursorStyle) ? v.terminalCursorStyle : 'blink-block',
        // Opt-in: only an explicitly-stored `true` enables it. Anything else
        // (missing / false / wrong type) stays OFF — the conservative default.
        copyOnSelect: v.copyOnSelect === true,
        // Only an explicit 'absolute' opts into clock time; absent/unknown/wrong-
        // type stays 'relative' (today's "2m ago" buckets) — the conservative
        // default that minimizes disruption across every timestamp surface.
        timestampFormat: v.timestampFormat === 'absolute' ? 'absolute' : 'relative',
        theme: normalizeThemePref(v.theme),
        density: v.density === 'compact' ? 'compact' : 'comfortable',
        paneLayout: (v.paneLayout === 'stacked' || v.paneLayout === 'side-by-side') ? v.paneLayout : 'auto',
        onExitBehavior: ['keep', 'dim', 'auto-close'].includes(v.onExitBehavior) ? v.onExitBehavior : 'keep',
        // Only an explicit false opts out; absent/unknown defaults to true so a
        // partial payload never silently disables focus-stealing.
        autoFocusNewPane: v.autoFocusNewPane !== false,
        restoreOnStartup: v.restoreOnStartup === 'empty' ? 'empty' : 'previous',
        defaultNewChatPreset: presetIsValid(v.defaultNewChatPreset) ? (v.defaultNewChatPreset as string) : 'claude',
        defaultNewChatHost: typeof v.defaultNewChatHost === 'string' ? v.defaultNewChatHost : '(local)',
        // Trim on load so stray whitespace never becomes the seeded cwd path;
        // blank is the meaningful "host home directory" value (today's behavior).
        defaultNewChatCwd: typeof v.defaultNewChatCwd === 'string' ? v.defaultNewChatCwd.trim() : '',
        // Per-host cwd overrides: a stricter string→string sanitizer than
        // paneHost's loose pass — a corrupt/blank entry must never seed the
        // spawn field empty. Empty values drop ("use the global default").
        defaultNewChatCwdByHost: parseCwdByHost(v.defaultNewChatCwdByHost),
        // Trim on load so stray whitespace never becomes the spawned shell name;
        // blank is the meaningful "auto-detect host login shell" value.
        defaultSplitShell: typeof v.defaultSplitShell === 'string' ? v.defaultSplitShell.trim() : '',
        customPresets,
        paneHost: (v.paneHost && typeof v.paneHost === 'object') ? v.paneHost : {},
        hostOptions: parseHostOptions(v.hostOptions),
        copyHintDismissed: parseDismissedMap(v.copyHintDismissed),
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

// The fields that the "Restore workspace on startup" pref gates. These are what
// an 'empty' launch must blank and what 'previous' must restore. paneHost is
// required here: initialWorkspace always returns a concrete object for it. The
// pane-set (openPanes/focused) now lives inside `workspaces` + `activeWorkspaceId`
// (WARDEN-256); activeTabs/hiddenTabs stay flat + global.
type Workspace = {
  activeTabs: string[];
  hiddenTabs: string[];
  workspaces: WorkspacePaneSet[];
  activeWorkspaceId: string;
  paneHost: Record<string, string>;
};

// Workspace to seed React state with on mount, honoring the pref. 'previous'
// restores the last-saved workspace (today's behavior); 'empty' hands back a
// clean slate regardless of what was open at last close — one empty workspace,
// the active one. Pure: no localStorage.
export function initialWorkspace(disk: UiState, restoreOnStartup: RestoreOnStartup): Workspace {
  if (restoreOnStartup === 'empty') {
    const ws = makeWorkspace(DEFAULT_WORKSPACE_NAME);
    return { activeTabs: [], hiddenTabs: [], workspaces: [ws], activeWorkspaceId: ws.id, paneHost: {} };
  }
  return {
    activeTabs: disk.activeTabs,
    hiddenTabs: disk.hiddenTabs,
    workspaces: disk.workspaces,
    activeWorkspaceId: disk.activeWorkspaceId ?? disk.workspaces[0]?.id ?? '',
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
      workspaces: disk.workspaces,
      activeWorkspaceId: disk.activeWorkspaceId,
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
export interface ObsUi { openIds: string[]; activeId: string | null; viewMode?: 'sessions' | 'activity' | 'directives' }
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
