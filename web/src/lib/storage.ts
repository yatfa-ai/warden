import type { AgentFilter, AgentSort } from './agentFilter';
import type { TimestampFormat } from './formatTimestamp';
import type { HostLabels } from '@/lib/chatDisplay';

// UI state persisted in localStorage.
// workspaces = the browser-tab-style project pane-sets the user switches between;
//   each owns its own openPanes + focused + recentlyClosed. activeWorkspaceId
//   picks the one whose panes render in the grid. A pane lives in at most one
//   workspace (openChat dedups across workspaces). paneHost stays global (keyed
//   by pane id). WARDEN-372 abolished the flat activeTabs/hiddenTabs working set
//   — the sidebar root is now the active workspace's openPanes + a per-workspace
//   recently-closed recovery list.
//
// NOTE on durability (WARDEN-181): localStorage persists across a normal restart
// inside the OS-default userData dir. Reads below go through readVersioned() so a
// FUTURE localStorage KEY-version bump (v2 -> v3 ...) can never silently drop the
// user's data — the newest surviving payload is promoted forward to the current
// key instead. Persistence errors are surfaced via console.warn rather than
// swallowed (WARDEN-89), so a quota/serialization failure is never silent.
import { normalizeThemePref, type ThemePref } from '@/lib/themes';

const KEY = 'warden:ui:v3';
const KEY_PREFIX = 'warden:ui';
const KEY_VERSION = 3;

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

// A snapshot of a pane the user closed, kept per-workspace as a click-to-reopen
// recovery list (WARDEN-372). `id` is the chat's host-prefixed id (key || id),
// the same identity openPanes uses, so reopening is a plain openChat(id). The
// display fields (name/host/cwd) are a snapshot at close time so the row still
// renders even if the underlying chat has since left the catalog. `closedAt` is
// ms-since-epoch for the "show more / newest-first" ordering. Pure client-side
// state; never sent to the backend.
export interface RecentlyClosedEntry {
  id: string;
  name: string;
  host: string;
  cwd: string;
  closedAt: number;
}

// Cap on how many recently-closed entries a workspace retains. The UI shows 5
// with a "show more" affordance that expands to this cap; older entries beyond
// it are dropped (newest-first). Centralized so the parse sanitizer, the merge
// helper, and the UI's "show more" all agree on one bound.
export const RECENTLY_CLOSED_CAP = 20;
// How many recently-closed entries the sidebar shows before the "show more"
// affordance expands the list to the full cap.
export const RECENTLY_CLOSED_PREVIEW = 5;

// A named workspace: one browser-tab-style project pane-set. Owns its openPanes
// (the pane ids with a live terminal in the grid when this workspace is active),
// its focused pane, and its per-workspace recently-closed recovery list. `id` is
// a stable UUID (never an array index) so drag-and-drop payloads identify a
// workspace unambiguously (WARDEN-108). `name` is the user-editable tab label.
// Pure client-side pref; never sent to the backend.
export interface WorkspacePaneSet {
  id: string;
  name: string;
  openPanes: string[];
  focused: string | null;
  recentlyClosed: RecentlyClosedEntry[];
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
  recentlyClosed: RecentlyClosedEntry[] = [],
  id: string = genWorkspaceId(),
): WorkspacePaneSet {
  return { id, name, openPanes, focused, recentlyClosed };
}

// Merge a live session's recently-closed entries into the carried-forward disk
// list, deduping by id (the live/incoming entry wins → re-closing moves it to
// the top) and capping at RECENTLY_CLOSED_CAP, newest-first. Used by the
// 'empty'-mode freeze so recentlyClosed — which is NOT workspace-restoration
// state — tracks live recovery activity instead of being frozen to disk. Pure
// and dependency-free so it is unit-tested directly. (WARDEN-372.)
export function mergeRecentlyClosed(
  existing: RecentlyClosedEntry[],
  incoming: RecentlyClosedEntry[],
): RecentlyClosedEntry[] {
  const seen = new Set<string>();
  const out: RecentlyClosedEntry[] = [];
  for (const entry of [...incoming, ...existing]) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
    if (out.length >= RECENTLY_CLOSED_CAP) break;
  }
  return out;
}

// Sanitize a raw recentlyClosed value into a valid, id-unique, capped
// RecentlyClosedEntry[]. Defensive: never throws on malformed input (WARDEN-89)
// — it drops bad entries instead, so one corrupt entry can never blank the
// recovery list. Each entry requires a string id; name/host/cwd coerce to
// strings; closedAt coerces to a number (0 if absent/invalid). Dedups by id
// (first occurrence wins) and caps at RECENTLY_CLOSED_CAP.
function parseRecentlyClosed(raw: unknown): RecentlyClosedEntry[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined && raw !== null) {
      console.warn('[loadUi] recentlyClosed is not an array; ignoring:', raw);
    }
    return [];
  }
  const seen = new Set<string>();
  const out: RecentlyClosedEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === 'string' ? e.id : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const closedAt = typeof e.closedAt === 'number' && Number.isFinite(e.closedAt) ? e.closedAt : 0;
    out.push({
      id,
      name: typeof e.name === 'string' ? e.name : '',
      host: typeof e.host === 'string' ? e.host : '',
      cwd: typeof e.cwd === 'string' ? e.cwd : '',
      closedAt,
    });
    if (out.length >= RECENTLY_CLOSED_CAP) break;
  }
  return out;
}

// A user-defined instruction snippet: a named, reusable instruction the human
// can insert at an intervention point (the Broadcast dialog + a focused pane's
// context menu) instead of retyping common guidance ("run the tests", "pull
// latest", "commit your work"). Mirrors CustomPreset's {name, cmd} shape but
// holds free-form instruction text rather than a spawn command. Pure client-
// side pref; never sent to the backend as anything but the literal `text` over
// the existing /api/send path. Global — one flat list, not host-keyed
// (WARDEN-323 Decision 1); per-host/per-agent scoping is a v2 extension.
export interface Snippet {
  name: string;
  text: string;
}

// Maximum length of a snippet name / text, and the max persisted count.
// Centralized here so every write site (parseSnippets, SettingsPage add/rename,
// the Inputs' maxLength) agrees with the load-time sanitizer on one bound — the
// in-memory list can never hold a name/text the sanitizer would silently drop
// on next reload. SNIPPET_MAX_COUNT caps the payload so a runaway list can
// never bloat localStorage; the load-time sanitizer drops the overflow.
export const SNIPPET_NAME_MAX = 32;
export const SNIPPET_TEXT_MAX = 2000;
export const SNIPPET_MAX_COUNT = 50;

// The validation outcome for a candidate snippet name. `null` means acceptable.
// Simpler than presets: there are no reserved built-in snippet names, so only
// empty | too-long | duplicate.
export type SnippetNameIssue = 'empty' | 'too-long' | 'duplicate';

// Validate a candidate snippet name against the SAME contract parseSnippets
// enforces at load time, so the Settings write sites (add/rename) can never
// persist a name the sanitizer would silently drop. Pure and dependency-free so
// it is unit-tested directly (there is no React test runner in this repo).
//   - `existing`: the current snippet list (for duplicate detection)
//   - `except`:   an entry name to EXCLUDE from duplicate detection (for renames,
//                 so a case-only rename like "Run tests" -> "RUN TESTS" isn't its
//                 own dupe)
// Trims the name first, matching how parseSnippets normalizes on load.
export function validateSnippetName(
  name: string,
  existing: Snippet[],
  except?: string,
): SnippetNameIssue | null {
  const n = name.trim();
  if (!n) return 'empty';
  if (n.length > SNIPPET_NAME_MAX) return 'too-long';
  const lower = n.toLowerCase();
  if (existing.some((s) => s.name !== except && s.name.toLowerCase() === lower)) return 'duplicate';
  return null;
}

// The starter snippet set seeded once on a fresh install (and on a v2→v3
// promote where the persisted `snippets` field is absent). Ordinary editable
// Snippet entries — no "built-in vs user" distinction; the user can rename,
// edit-text, or delete each freely. Seeding is one-time: it fires ONLY when the
// persisted `snippets` field is absent; once any value exists (including `[]`
// after the user deletes everything), the seed never re-triggers, so deletions
// stick. (WARDEN-323 Decision 3.)
export const STARTER_SNIPPETS: Snippet[] = [
  { name: 'Run tests', text: 'run the test suite' },
  { name: 'Pull latest', text: 'pull latest' },
  { name: 'Commit your work', text: 'commit your work' },
  { name: 'Summarize progress', text: 'summarize your progress so far' },
];

export interface UiState {
  // Browser-tab-style project pane-sets (WARDEN-256). Each workspace owns its own
  // openPanes + focused + recentlyClosed; switching the active workspace swaps the
  // pane grid. A pane id lives in at most one workspace's openPanes (openChat
  // dedups across them); paneHost stays global (keyed by pane id). WARDEN-372
  // abolished the flat activeTabs/hiddenTabs working set — the sidebar root is now
  // the active workspace's openPanes plus a per-workspace recently-closed list.
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
  // WARDEN-364 — per-severity routing for the desktop-alert channel, layered on
  // top of the `attentionDesktopAlerts` master switch. The master gates the whole
  // channel; these route WHICH of the four attention buckets may escalate to an
  // OS notification (critical/warning health, pending directives, recent errors).
  // Defaults all-true = behavior-preserving. Pure client-side pref; never sent to
  // the backend / /api/config.
  alertCritical?: boolean;
  alertWarning?: boolean;
  alertDirective?: boolean;
  alertError?: boolean;
  // WARDEN-364 — chat keys (`a.key || a.id`) muted on the desktop-alert channel.
  // A muted agent driving a critical/warning increase fires NO OS notification
  // while still appearing in the in-app AttentionBadge (which consumes the
  // unfiltered rollup). directives/errors are aggregate counts with no per-agent
  // identity, so mute applies to the health buckets only. Pure client-side pref;
  // never sent to the backend / /api/config.
  mutedAlertKeys?: string[];
  // Per-chat "watch" opt-in (WARDEN-378): pane keys the human marked "watch this
  // chat" for a targeted, reason-specific desktop ping when that chat newly needs
  // them. Global (not per-workspace) — a watched chat stays watched across workspace
  // switches. Pure client-side pref (like attentionDesktopAlerts/attentionStates):
  // persisted by App's saveUi effect, never sent to the backend. The keys ride the
  // existing ?panes= query on /api/agent-states, which already accepts arbitrary
  // pane keys and resolves them from the cache (no server writer / allow-list risk).
  watchedChats?: string[];
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
  // File Viewer markdown view mode: 'rendered' (default = docs/README reading)
  // or 'source' (raw markdown — common when inspecting agent prompt/config/
  // CLAUDE.md files). Pure client-side pref; persisted by App's saveUi effect,
  // never sent to the backend / /api/config. See WARDEN-480.
  fileViewerViewMode?: 'rendered' | 'source';
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
  // Per-host default agent-type overrides for the ＋ new chat spawn form
  // (WARDEN-352 — mirrors defaultNewChatCwdByHost from WARDEN-336). Keys are the
  // host strings — '(local)' for local, the SSH host name for remote (matching
  // defaultNewChatHost); values are preset names. A host with no entry (or one
  // whose value is empty/whitespace OR names a since-deleted custom preset, both
  // dropped on load by parsePresetByHost) falls through to defaultNewChatPreset,
  // then 'claude' — identical to today's single-host behavior. Pure client-side
  // pref; never sent to the backend / /api/config.
  defaultNewChatPresetByHost?: Record<string, string>;
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
  // Default shell opened by BOTH the ＋ new-chat *shell* preset and the ＋ split
  // button (WARDEN-429 — unifies the prior split-only `defaultSplitShell` with the
  // hardcoded `'bash'` the new-chat shell preset used to force-feed). Blank
  // (default) means "no explicit shell" → the host launches its own login shell
  // (auto-detected per host, never hardcoded; WARDEN-223), so a zsh-login host
  // yields zsh out of the box with zero config. A non-empty value (e.g. 'zsh',
  // 'fish', 'pwsh') is the cmd every shell terminal/split spawns, overridable per
  // host below. Pure client-side pref; never sent to the backend / /api/config.
  defaultShell?: string;
  // Per-host default-shell overrides (WARDEN-429 — mirrors the
  // defaultNewChatCwdByHost shape from WARDEN-336). Keys are the host strings —
  // '(local)' for local, the SSH host name for remote (matching
  // defaultNewChatHost); values are shell names. A host with no entry (or one
  // whose value is empty/whitespace, dropped on load by parseShellByHost) falls
  // through to defaultShell, then blank (host login shell) — identical to the
  // single-host behavior. Pure client-side pref; never sent to the backend /
  // /api/config.
  defaultShellByHost?: Record<string, string>;
  // User-defined spawn presets (named quick-fill commands beyond claude/shell).
  // Validated on load: entries missing a name/cmd are dropped, names are bounded
  // (≤32 chars) and de-duplicated, and reserved built-in names are rejected.
  // Pure client-side pref; never sent to the backend.
  customPresets?: CustomPreset[];
  // User-defined instruction snippets (named, reusable intervention text —
  // "run the tests", "pull latest", etc.) surfaced at the Broadcast dialog and
  // a focused pane's context menu. Global (one flat list, not host-keyed).
  // Validated on load by parseSnippets: entries missing a name/text are dropped,
  // names/text are bounded and de-duplicated (case-insensitive), and the count
  // is capped. Seeded once with STARTER_SNIPPETS when the field is absent
  // (WARDEN-323). Pure client-side pref; only the literal `text` ever leaves
  // the client, over the existing /api/send path.
  snippets?: Snippet[];
  // pane id (chat key) -> host, so restored remote panes know which host to discover.
  paneHost?: Record<string, string>;
  agentFilter?: AgentFilter;
  agentSort?: AgentSort;
  // WARDEN-468: HealthDashboard "Group agents by: Health | Host" toggle
  // (WARDEN-237). Was a HealthDashboard-local useState that reset to 'health' on
  // every Warden restart; now App-owned + persisted so a cross-host human's Host
  // grouping survives reload. Defensive allow-list normalizer in loadUi below.
  healthGroupBy?: 'health' | 'host';
  // WARDEN-500: the per-host expand/collapse state INSIDE Host grouping (which
  // hosts are collapsed). Was a HealthDashboard-local useState that reset to {}
  // on every Warden restart — so the durable grouping choice (WARDEN-468) survived
  // reload but the expansion state beneath it did not. Now App-owned + persisted
  // (completing WARDEN-468's slice). key = host, value = collapsed. Default {} =
  // every host expanded = byte-for-byte today's behavior. Defensive drop-bad-
  // entries normalizer (parseCollapsedHosts) in loadUi below.
  healthCollapsedHosts?: Record<string, boolean>;
  // WARDEN-490 — per-host display labels (friendly names). Keys are the raw host
  // strings ('(local)' for this machine, the SSH host name for remote); values
  // are the human's label, which replaces the raw host in every host-tag display
  // surface (sidebar rows, pane header, Kill/Collision/Broadcast dialogs, Open
  // Chat Browser, Activity timeline, Directive history, Observer tabs, Health
  // dashboard, token-budget offender line, SessionTranscriptViewer). A host with
  // no entry (or an empty/whitespace value, dropped on load by parseLabelsByHost)
  // is byte-identical to today — including the intentional 'local' vs 'this
  // machine' difference across surfaces. Pure client-side pref, persisted by
  // App's saveUi effect; NEVER sent to the backend / /api/config or any SSH /
  // telemetry path (a label is display-only — it must never leak into a backend
  // payload). Mirrors the host-keyed shape of defaultNewChatCwdByHost /
  // defaultShellByHost.
  hostLabels?: HostLabels;
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

// Sanitize a raw snippets value into a valid Snippet[]. Defensive: never throws
// on malformed input (WARDEN-89) — it drops bad entries instead, so one corrupt
// entry can never blank the snippet list. Drops entries missing a name or text,
// names over SNIPPET_NAME_MAX chars, text over SNIPPET_TEXT_MAX chars, and
// duplicates (case-insensitive; first occurrence wins). Caps the count at
// SNIPPET_MAX_COUNT (overflow dropped) so the payload can never bloat
// localStorage. Mirrors parseCustomPresets's drop-bad-entries discipline.
function parseSnippets(raw: unknown): Snippet[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined && raw !== null) {
      // A present-but-wrong-type value is genuine corruption worth surfacing.
      console.warn('[loadUi] snippets is not an array; ignoring:', raw);
    }
    return [];
  }
  const seen = new Set<string>();
  const out: Snippet[] = [];
  for (const entry of raw) {
    if (out.length >= SNIPPET_MAX_COUNT) break; // cap payload size
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    const text = typeof e.text === 'string' ? e.text.trim() : '';
    if (!name || !text) continue;
    if (name.length > SNIPPET_NAME_MAX) continue;
    if (text.length > SNIPPET_TEXT_MAX) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, text });
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

// Sanitize a raw defaultShellByHost value (host key → default shell) into a
// valid Record<string,string> (WARDEN-429 — mirrors parseCwdByHost). Like a cwd
// path, a shell name is an arbitrary string, so a non-empty trim is enough
// (there is no semantic "valid preset" check as parsePresetByHost needs).
// Defensive: never throws on malformed input (WARDEN-89) — it drops bad entries
// instead, so one corrupt/blank entry can never seed the spawn command with a
// dangling shell name. Each entry requires a non-empty trimmed-string KEY and a
// trimmed-string VALUE; entries whose value is empty/whitespace are dropped — an
// empty override means "use the global defaultShell" (then the host login shell)
// and so must never persist as a blank that could seed the command field empty.
// Values are trimmed, matching defaultShell's own load-time trim.
function parseShellByHost(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== undefined && raw !== null) {
      // A present-but-wrong-type value is genuine corruption worth surfacing.
      console.warn('[loadUi] defaultShellByHost is not an object; ignoring:', raw);
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

// Sanitize a raw hostLabels value (raw host key → friendly label) into a valid
// HostLabels map (WARDEN-490). Mirrors parseCwdByHost/parseShellByHost's drop-
// bad-entries discipline: each entry requires a non-empty trimmed-string KEY and
// a trimmed-string VALUE, and entries whose value is empty/whitespace are
// dropped — an empty label means "no label" (today's behavior), so it must never
// persist as a blank that could blank a host's tag. Defensive: never throws on
// malformed input (WARDEN-89) — it drops bad entries instead, so one corrupt
// entry can never blank the label map. NOTE: this map is display-only; it never
// reaches the backend (see the UiState.hostLabels comment).
function parseLabelsByHost(raw: unknown): HostLabels {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== undefined && raw !== null) {
      // A present-but-wrong-type value is genuine corruption worth surfacing.
      console.warn('[loadUi] hostLabels is not an object; ignoring:', raw);
    }
    return {};
  }
  const out: HostLabels = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = typeof k === 'string' ? k.trim() : '';
    const val = typeof v === 'string' ? v.trim() : '';
    if (!key || !val) continue; // empty key → drop; empty label → no label (today's behavior)
    out[key] = val;
  }
  return out;
}

// Sanitize a raw healthCollapsedHosts value (host key → collapsed?) into a
// valid Record<string,boolean> (WARDEN-500 — mirrors parseCwdByHost's
// drop-bad-entries model). The per-host expand/collapse state inside Health's
// Host grouping was a HealthDashboard-local useState that reset to {} on every
// Warden restart; now App-owned + persisted so a cross-host human's collapsed
// hosts survive reload (completing the persistence WARDEN-468 started for the
// grouping toggle itself). Defensive: never throws on malformed input
// (WARDEN-89) — it drops bad entries instead, so one corrupt entry can never
// blank the whole collapse map. Each entry requires a non-empty trimmed-string
// KEY and a strictly-boolean VALUE; anything else is dropped. A non-object
// payload (string/array/number) degrades to {} (every host expanded — byte-for-
// byte today's default, zero regression for fresh installs).
function parseCollapsedHosts(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== undefined && raw !== null) {
      // A present-but-wrong-type value is genuine corruption worth surfacing.
      console.warn('[loadUi] healthCollapsedHosts is not an object; ignoring:', raw);
    }
    return {};
  }
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = typeof k === 'string' ? k.trim() : '';
    if (!key) continue; // empty/whitespace key → drop
    if (typeof v !== 'boolean') continue; // non-boolean value → drop
    out[key] = v;
  }
  return out;
}

// Sanitize a raw defaultNewChatPresetByHost value (host key → preset name) into a
// valid Record<string,string> (WARDEN-352 — mirrors parseCwdByHost). CRITICAL
// DIFFERENCE from parseCwdByHost: cwd values are arbitrary path strings (a
// non-empty trim is enough), but preset values are SEMANTIC names — each must be
// a VALID preset (a built-in 'claude'/'shell' OR an existing customPresets
// entry). A host defaulting to a since-deleted custom preset is DROPPED on load,
// which means "inherit the global defaultNewChatPreset" — exactly mirroring how
// the global defaultNewChatPreset itself falls back to 'claude' via presetIsValid
// when it names a deleted preset. `isValid` is that same loadUi-scoped
// presetIsValid closure (built-in OR in the parsed customPresets), passed in at
// the call site where customPresets is already in scope — so a per-host value
// naming a REAL custom preset is correctly KEPT (do not call this where
// customPresets has not yet been parsed). Defensive: never throws (WARDEN-89) —
// drops bad entries instead, so one corrupt entry can never seed the spawn field
// with a dangling preset name.
function parsePresetByHost(
  raw: unknown,
  isValid: (p: unknown) => boolean,
): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== undefined && raw !== null) {
      // A present-but-wrong-type value is genuine corruption worth surfacing.
      console.warn('[loadUi] defaultNewChatPresetByHost is not an object; ignoring:', raw);
    }
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = typeof k === 'string' ? k.trim() : '';
    const val = typeof v === 'string' ? v.trim() : '';
    // empty key → drop; empty value → inherit global default; invalid preset
    // (not a built-in and not in customPresets) → inherit global default.
    if (!key || !val || !isValid(val)) continue;
    out[key] = val;
  }
  return out;
}

// Sanitize a raw mutedAlertKeys value into a de-duplicated string[] of non-empty
// chat keys (WARDEN-364). Defensive: never throws on malformed input (WARDEN-89)
// — drops non-string / blank / duplicate entries instead, so one corrupt value
// can never blank the mute set. Modeled on parseCustomPresets's drop-bad-entries
// discipline; order is preserved (first occurrence wins) so the set is stable.
function parseMutedKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined && raw !== null) {
      console.warn('[loadUi] mutedAlertKeys is not an array; ignoring:', raw);
    }
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of raw) {
    if (typeof k !== 'string') continue;
    const key = k.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
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
    const recentlyClosed = parseRecentlyClosed(e.recentlyClosed);
    out.push({ id, name, openPanes, focused, recentlyClosed });
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
  workspaces: [DEFAULT_WORKSPACE],
  activeWorkspaceId: DEFAULT_WORKSPACE.id,
  sidebarCollapsed: false, observerCollapsed: false, healthCollapsed: true,
  sidebarWidth: 220, observerWidth: 380, terminalFontSize: 14,
  attentionDesktopAlerts: false,
  attentionStates: { stuck: true, erroring: true, waiting: true, blocked: true },
  alertCritical: true, alertWarning: true, alertDirective: true, alertError: true,
  mutedAlertKeys: [],
  // WARDEN-378: no chats watched by default (opt-in per chat).
  watchedChats: [],
  terminalScrollback: 10000, terminalFontFamily: '',
  terminalColorScheme: 'auto',
  terminalCursorStyle: 'blink-block',
  copyOnSelect: false,
  timestampFormat: 'relative',
  fileViewerViewMode: 'rendered',
  theme: 'system', density: 'comfortable', paneLayout: 'auto',
  onExitBehavior: 'keep',
  autoFocusNewPane: true,
  restoreOnStartup: 'previous',
  defaultNewChatPreset: 'claude', defaultNewChatPresetByHost: {}, defaultNewChatHost: '(local)', customPresets: [], snippets: STARTER_SNIPPETS, defaultNewChatCwd: '', defaultNewChatCwdByHost: {},
  defaultShell: '', defaultShellByHost: {},
  paneHost: {}, agentFilter: 'all', agentSort: 'manual', healthGroupBy: 'health', healthCollapsedHosts: {}, hostLabels: {},
};

export function loadUi(): UiState {
  try {
    const v = JSON.parse(readVersioned(KEY_PREFIX, KEY_VERSION) ?? 'null');
    // A valid payload is any plain object. WARDEN-372 removed the activeTabs
    // canary this guard used to key on (the tabs model is abolished); keying on
    // "is this a non-null object" is robust against future field removals and
    // still rejects a non-payload (string/number/null) the parse might surface.
    if (v && typeof v === 'object' && !Array.isArray(v)) {
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
        // WARDEN-364 — severity routing defaults ON (only an explicit `false`
        // opts a bucket out), so an upgrade or a partial payload preserves the
        // pre-routing "every bucket escalates" behavior bit-for-bit.
        alertCritical: v.alertCritical !== false,
        alertWarning: v.alertWarning !== false,
        alertDirective: v.alertDirective !== false,
        alertError: v.alertError !== false,
        // Sanitized to a de-duplicated string[] of non-empty keys.
        mutedAlertKeys: parseMutedKeys(v.mutedAlertKeys),
        // WARDEN-378: only string entries survive; a corrupt/non-array value
        // degrades to [] (no chats watched) — the conservative default.
        watchedChats: Array.isArray(v.watchedChats)
          ? v.watchedChats.filter((s: unknown): s is string => typeof s === 'string')
          : [],
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
        // Only an explicit 'source' opts into raw markdown; absent/unknown/wrong-
        // type stays 'rendered' (docs/README reading) — the conservative default
        // that minimizes disruption, matching timestampFormat above. See WARDEN-480.
        fileViewerViewMode: v.fileViewerViewMode === 'source' ? 'source' : 'rendered',
        theme: normalizeThemePref(v.theme),
        density: v.density === 'compact' ? 'compact' : 'comfortable',
        paneLayout: (v.paneLayout === 'stacked' || v.paneLayout === 'side-by-side') ? v.paneLayout : 'auto',
        onExitBehavior: ['keep', 'dim', 'auto-close'].includes(v.onExitBehavior) ? v.onExitBehavior : 'keep',
        // Only an explicit false opts out; absent/unknown defaults to true so a
        // partial payload never silently disables focus-stealing.
        autoFocusNewPane: v.autoFocusNewPane !== false,
        restoreOnStartup: v.restoreOnStartup === 'empty' ? 'empty' : 'previous',
        defaultNewChatPreset: presetIsValid(v.defaultNewChatPreset) ? (v.defaultNewChatPreset as string) : 'claude',
        // Per-host preset overrides (WARDEN-352): same drop-bad-entries discipline
        // as the cwd map above, but stricter — each value must additionally be a
        // VALID preset (built-in OR a customPresets entry) or it is dropped on
        // load (→ inherit the global default), so a since-deleted custom preset
        // can never seed the agent-type field with a dangling name. presetIsValid
        // (which closes over the just-parsed customPresets) is passed in so real
        // custom presets are kept.
        defaultNewChatPresetByHost: parsePresetByHost(v.defaultNewChatPresetByHost, presetIsValid),
        defaultNewChatHost: typeof v.defaultNewChatHost === 'string' ? v.defaultNewChatHost : '(local)',
        // Trim on load so stray whitespace never becomes the seeded cwd path;
        // blank is the meaningful "host home directory" value (today's behavior).
        defaultNewChatCwd: typeof v.defaultNewChatCwd === 'string' ? v.defaultNewChatCwd.trim() : '',
        // Per-host cwd overrides: a stricter string→string sanitizer than
        // paneHost's loose pass — a corrupt/blank entry must never seed the
        // spawn field empty. Empty values drop ("use the global default").
        defaultNewChatCwdByHost: parseCwdByHost(v.defaultNewChatCwdByHost),
        // Default shell for the ＋ new-chat *shell* preset AND the ＋ split
        // button (WARDEN-429). MIGRATION: the legacy split-only `defaultSplitShell`
        // is folded in here — if the new `defaultShell` field is absent, the prior
        // split-shell value (if any) is used so an upgrade never silently drops
        // the user's shell choice. Trimmed on load; blank is the meaningful
        // "auto-detect host login shell" value (an explicit empty cmd flows through
        // to tmux as a bare login shell per WARDEN-223). The legacy key is read
        // for migration only and not re-persisted (it is gone from UiState), so a
        // subsequent save drops it cleanly.
        defaultShell: typeof v.defaultShell === 'string'
          ? v.defaultShell.trim()
          : (typeof v.defaultSplitShell === 'string' ? v.defaultSplitShell.trim() : ''),
        // Per-host shell overrides: same drop-bad-entries discipline as the cwd
        // map — a corrupt/blank entry must never seed the command field empty.
        // Empty values drop ("use the global default", then the host login shell).
        defaultShellByHost: parseShellByHost(v.defaultShellByHost),
        customPresets,
        // One-time starter-set seeding (WARDEN-323 Decision 3): when the
        // persisted `snippets` field is ABSENT (a fresh install OR a v2→v3
        // promote of a payload that predates snippets), seed STARTER_SNIPPETS so
        // the library is useful out of the box. Once ANY value exists — including
        // `[]` after the user deletes everything — the seed never re-triggers, so
        // deletions stick. A present-but-corrupt value falls through to
        // parseSnippets (which returns [] defensively) rather than re-seeding.
        snippets: v.snippets == null ? STARTER_SNIPPETS : parseSnippets(v.snippets),
        paneHost: (v.paneHost && typeof v.paneHost === 'object') ? v.paneHost : {},
        // WARDEN-372: 'active'/'hidden' filter cases are abolished — a stored
        // value naming either coerces back to 'all' (defensive, like every other
        // enum-ish pref) so a legacy payload never selects a dead filter.
        agentFilter: ['all', 'yatfa', 'claude', 'manual'].includes(v.agentFilter) ? v.agentFilter : 'all',
        agentSort: v.agentSort ?? 'manual',
        // WARDEN-468: defensive allow-list — a legacy/corrupt value never selects
        // a dead group mode (mirrors the agentFilter enum normalizer above).
        healthGroupBy: v.healthGroupBy === 'host' ? 'host' : 'health',
        // WARDEN-500: defensive drop-bad-entries parse — a corrupt map never blanks
        // the whole collapse state. Mirrors parseCwdByHost/parseShellByHost: require
        // string keys + boolean values, drop anything else; a non-object → {}.
        healthCollapsedHosts: parseCollapsedHosts(v.healthCollapsedHosts),
        // WARDEN-490 — per-host display labels. Sanitized to a host→label map
        // with empty values dropped (no label = today's behavior). Display-only;
        // never sent to the backend.
        hostLabels: parseLabelsByHost(v.hostLabels),
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
// (WARDEN-256). WARDEN-372 abolished the flat activeTabs/hiddenTabs fields.
type Workspace = {
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
    return { workspaces: [ws], activeWorkspaceId: ws.id, paneHost: {} };
  }
  return {
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
//
// WARDEN-372 exemption: recentlyClosed is NOT workspace-restoration state, so it
// is NOT frozen with the pane grid. While the openPanes/focused of the carried-
// forward disk workspaces are preserved (the pane grid is frozen), the LIVE
// active workspace's recently-closed entries are merged INTO the disk active
// workspace — so this session's closes persist even in 'empty' mode, without
// wiping the recovery history already on disk (mergeRecentlyClosed dedups + caps).
export function persistUiState(
  live: Omit<UiState, 'restoreOnStartup'>,
  restoreOnStartup: RestoreOnStartup,
  disk: UiState,
  startedEmpty: boolean,
): UiState {
  if (restoreOnStartup === 'empty' || startedEmpty) {
    // recentlyClosed exemption: overlay the live active workspace's recovery
    // list onto the frozen disk active workspace (union, dedup, cap). The live
    // active workspace may be a fresh-id empty-mode workspace, so match by the
    // DISK active id (the workspace that survives the freeze), not live's.
    const liveActive = live.workspaces.find((w) => w.id === live.activeWorkspaceId) ?? live.workspaces[0];
    const frozenWorkspaces = disk.workspaces.map((w) =>
      liveActive && w.id === disk.activeWorkspaceId
        ? { ...w, recentlyClosed: mergeRecentlyClosed(w.recentlyClosed ?? [], liveActive.recentlyClosed ?? []) }
        : w,
    );
    return {
      ...live,
      workspaces: frozenWorkspaces,
      activeWorkspaceId: disk.activeWorkspaceId,
      paneHost: disk.paneHost,
      restoreOnStartup,
    };
  }
  return { ...live, restoreOnStartup };
}

// Reset every UI PREF to its DEFAULT_UI value while copying the WORKSPACE +
// panel-layout fields from `live`. Pure (no localStorage): the App callback
// (resetUiPrefsToDefaults) applies it via the pref setters, and the existing
// saveUi effect persists the result via persistUiState. This is the single
// non-destructive "Reset preferences to defaults" path: appearance/terminal/
// new-chat/behavior prefs snap to defaults while the open workspace (tabs,
// panes, focus, host map) AND panel layout (collapse state + widths) survive.
//
// The preserved fields are exactly the WORKSPACE + LAYOUT set (mirroring the
// setters App's reset callback does NOT call): workspaces, activeWorkspaceId,
// paneHost, sidebarCollapsed, observerCollapsed, healthCollapsed, sidebarWidth,
// observerWidth. (WARDEN-372 folded the former flat activeTabs/hiddenTabs/
// openPanes/focused working set into `workspaces`/`activeWorkspaceId`; paneHost
// stayed global.) Everything else in DEFAULT_UI is a PREF and gets the default —
// including agentFilter/agentSort (WARDEN-442 made these App-owned and added them
// to App's saveUi spread, so they now persist like every other pref; previously
// they were ChatSidebar-local and the spread omitted them, so they reset on
// reload).
//
// NOTE on terminalFontFamily: DEFAULT_UI.terminalFontFamily is '' (the "blank
// means default stack" sentinel), so this helper returns '' for it — correct
// for the persisted shape. App's reset callback separately coerces '' to
// DEFAULT_TERMINAL_FONT_FAMILY for the LIVE React state so the Settings
// font-select shows "System default" instead of "Custom…" until reload; see
// the App callback's own nuance comment.
export function resetUiPrefsPreservingWorkspace(live: UiState): UiState {
  return {
    ...DEFAULT_UI,
    // Preserve the workspace + panel-layout fields from `live` (do NOT reset).
    workspaces: live.workspaces,
    activeWorkspaceId: live.activeWorkspaceId,
    paneHost: live.paneHost,
    sidebarCollapsed: live.sidebarCollapsed,
    observerCollapsed: live.observerCollapsed,
    healthCollapsed: live.healthCollapsed,
    sidebarWidth: live.sidebarWidth,
    observerWidth: live.observerWidth,
  };
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
