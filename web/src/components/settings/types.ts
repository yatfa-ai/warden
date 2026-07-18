// Shared types for the Settings decomposition (WARDEN-664).
//
// The Settings page conflates two persistence models, and this module is where
// that boundary is made structural:
//
//   - BACKEND fields  → `ConfigData` below. Loaded from GET /api/config, saved
//                       atomically via PUT /api/config by the useBackendConfig
//                       seam. Owned INSIDE SettingsPage (never threaded from App).
//
//   - CLIENT prefs    → the `*Prefs` groups (AppearancePrefs, NewChatsPrefs,
//                       SnippetsPrefs, DesktopAlertPrefs). Pure localStorage
//                       prefs owned by App and persisted by App's saveUi effect.
//                       Threaded into SettingsPage as grouped props.
//
// A client pref must NEVER appear in `ConfigData` — that is the 10×-commented
// "wrong persistence sink" footgun (mixing the two inside one component made it
// trivially easy to send a localStorage pref to PUT /api/config). Partitioning
// the types along the same line as the persistence model removes the hazard by
// construction: there is no flat ~70-prop signature to accidentally add a
// backend field to, and the PUT body is typed to `ConfigData` (+write-only
// secrets) exclusively.

import type { Dispatch, SetStateAction } from 'react';
import type { WatchPattern } from '@/lib/storage';

/**
 * The setter signature for the shared backend `config` state. Backend sections
 * receive `config` + `setConfig` and write with the exact prior pattern
 * `setConfig({ ...config, field: value })` (spread-from-closure), preserved
 * verbatim from the god-component so the update semantics are unchanged.
 */
export type SetConfig = Dispatch<SetStateAction<ConfigData>>;

/**
 * The BACKEND configuration shape — every field here is round-tripped through
 * GET / PUT /api/config (the `config` state in useBackendConfig). Nothing in
 * this interface is a client localStorage pref. The comments call out the
 * write-only secrets (auth token / webhook secret / telemetry token) which are
 * NOT part of this state — they live in separate write-only inputs and are sent
 * on save only when typed, so GET (which returns only a masked set+tail
 * indicator) never seeds them.
 */
export interface ConfigData {
  hosts: string[];
  pollIntervalMs: number;
  tmuxSession: string;
  connectTimeout: number;
  observerConfirmMode: 'always' | 'auto-safe';
  observerAutoStart: boolean;
  observerSessionTimeout: number | null;
  // Observer model/provider (WARDEN-350). Round-tripped through /api/config.
  // The auth token is write-only — GET never returns cleartext (only a masked
  // authTokenSet/authTokenTail indicator), so it is NOT part of this state; it
  // lives in separate write-only state and is sent on save only when typed.
  llm: {
    model: string;
    baseUrl: string;
    maxTokens: number | null;
  };
  // Fleet health attention thresholds (minutes of inactivity). healthWarning
  // is the healthy→WARNING boundary (default 5); healthCritical is the
  // warning→CRITICAL boundary (default 30) which also fires desktop alerts.
  healthWarningThresholdMin: number | null;
  healthCriticalThresholdMin: number | null;
  // Token-spend budget (WARDEN-415). tokenBudgetEnabled is the master switch;
  // the three numeric knobs may be null (cleared to default at read time). The
  // per-session threshold is null-able so it can be turned OFF independently.
  tokenBudgetEnabled: boolean;
  tokenBudgetThresholdTokens: number | null;
  tokenBudgetWindowHours: number | null;
  tokenBudgetPerSessionThresholdTokens: number | null;
  // Companion transport (WARDEN-439). Experimental master switch that routes
  // remote tmux ops through a persistent RPC channel instead of a fresh ssh per
  // op. companionTransportOverridden is true when WARDEN_COMPANION_TRANSPORT was
  // operator-set at boot — then the env var wins and the toggle is inert.
  companionTransportEnabled: boolean;
  companionTransportOverridden: boolean;
  confirmDestructiveActions: boolean;
  notifyChatOps: boolean;
  notifyErrors: boolean;
  notifySuccess: boolean;
  notifyObserver: boolean;
  // Display customization
  showHostTags?: boolean;
  showTypeBadges?: boolean;
  showStatusIndicators?: boolean;
  showProjectBadges?: boolean;
  hideOfflineHosts?: boolean;
  // Telemetry consent (WARDEN-457). Both off by default; persisted server-side
  // via /api/config (NOT client localStorage) so consent survives a restart.
  // Extended is gated behind base: meaningful only when telemetryBaseEnabled.
  telemetryBaseEnabled: boolean;
  telemetryExtendedEnabled: boolean;
  // Receiver endpoint (WARDEN-522). Empty string = unconfigured = sends nothing.
  // The transport (telemetry-send.js) no-ops while this is blank, independent of
  // the consent toggles. Persisted via /api/config so it survives a restart.
  telemetryEndpoint: string;
  // Webhook "push" delivery channel (WARDEN-555). OFF by default; sends nothing
  // until a URL is configured + the master switch is enabled. Routes critical
  // agent alerts to the user's own webhook URL (ntfy/Discord/Slack/Telegram) so a
  // human away from the machine still gets pinged. The shared secret is WRITE-
  // ONLY (GET returns only webhookSecretSet + a tail), so — like the LLM auth
  // token — the secret itself is NOT part of this state; it lives in a separate
  // input state and is sent on save only when non-empty.
  webhookUrl: string;
  webhookEnabled: boolean;
  webhookAlertAttention: boolean;
  webhookAlertBudget: boolean;
  webhookAlertDone: boolean;
  // User-authored output-pattern alerts (WARDEN-540). Persisted via /api/config
  // (SERVER-side — the matcher runs in pollAgentStates, not the renderer), NOT client
  // localStorage. Round-tripped through GET/PUT like the other config fields above.
  watchPatterns: WatchPattern[];
}

// ─── Client pref groups (the App → SettingsPage contract) ───────────────────
//
// Each group is a slice of App's UiState prefs, partitioned by the Settings
// section that owns them. App constructs a group from its useState hooks;
// SettingsPage spreads it straight through to the matching section component.
// A section's prop type is its group intersected with whatever extra (backend
// state, the `hidden` toggle) it needs — see each section file.

import type { Theme, TerminalColorScheme } from '@/lib/theme';
import type { Density } from '@/lib/density';
import type { TimestampFormat } from '@/lib/formatTimestamp';
import type {
  RestoreOnStartup,
  PaneLayout,
  TerminalCursorStyle,
  OnExitBehavior,
  CustomPreset,
  Snippet,
} from '@/lib/storage';
import type { HostLabels } from '@/lib/chatDisplay';

/**
 * Appearance + terminal + window/launch prefs — all pure client localStorage,
 * persisted by App's saveUi effect. (These were the most-footgun-heavy props:
 * each carried a "must never be added to the config state / PUT /api/config
 * body" comment. Grouping them here makes that comment structural — none of
 * these types are even expressible in `ConfigData`.)
 */
export interface AppearancePrefs {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  density: Density;
  setDensity: (density: Density) => void;
  paneLayout: PaneLayout;
  setPaneLayout: (layout: PaneLayout) => void;
  onExitBehavior: OnExitBehavior;
  setOnExitBehavior: (v: OnExitBehavior) => void;
  autoFocusNewPane: boolean;
  setAutoFocusNewPane: (v: boolean) => void;
  restoreOnStartup: RestoreOnStartup;
  setRestoreOnStartup: (v: RestoreOnStartup) => void;
  terminalFontSize: number;
  setTerminalFontSize: (n: number) => void;
  terminalScrollback: number;
  setTerminalScrollback: (n: number) => void;
  terminalFontFamily: string;
  setTerminalFontFamily: (v: string) => void;
  terminalColorScheme: TerminalColorScheme;
  setTerminalColorScheme: (v: TerminalColorScheme) => void;
  terminalCursorStyle: TerminalCursorStyle;
  setTerminalCursorStyle: (v: TerminalCursorStyle) => void;
  copyOnSelect: boolean;
  setCopyOnSelect: (v: boolean) => void;
  timestampFormat: TimestampFormat;
  setTimestampFormat: (v: TimestampFormat) => void;
  rememberWindowBounds: boolean;
  setRememberWindowBounds: (v: boolean) => void;
  launchAtLogin: boolean;
  setLaunchAtLogin: (v: boolean) => void;
  closeToTray: boolean;
  setCloseToTray: (v: boolean) => void;
}

/**
 * New-chat spawn defaults + custom presets + default shell — all pure client
 * localStorage. (availableHosts is NOT here: it comes from the backend
 * /api/ssh-hosts load inside useBackendConfig, so SettingsPage adds it when
 * assembling the section props.)
 */
export interface NewChatsPrefs {
  defaultNewChatPreset: string;
  setDefaultNewChatPreset: (v: string) => void;
  defaultNewChatPresetByHost: Record<string, string>;
  setDefaultNewChatPresetByHost: (v: Record<string, string>) => void;
  defaultNewChatHost: string;
  setDefaultNewChatHost: (v: string) => void;
  defaultNewChatCwd: string;
  setDefaultNewChatCwd: (v: string) => void;
  defaultNewChatCwdByHost: Record<string, string>;
  setDefaultNewChatCwdByHost: (v: Record<string, string>) => void;
  customPresets: CustomPreset[];
  setCustomPresets: (v: CustomPreset[]) => void;
  defaultShell: string;
  setDefaultShell: (v: string) => void;
  defaultShellByHost: Record<string, string>;
  setDefaultShellByHost: (v: Record<string, string>) => void;
}

/** Instruction snippets (WARDEN-323) — pure client localStorage. */
export interface SnippetsPrefs {
  snippets: Snippet[];
  setSnippets: (v: Snippet[]) => void;
}

/**
 * Desktop-alert client prefs for the Notifications section (the OS-notification
 * channel — a DIFFERENT channel + persistence path than the server-side toast
 * toggles, which live in `ConfigData`). Pure client localStorage.
 */
export interface DesktopAlertPrefs {
  attentionDesktopAlerts: boolean;
  setAttentionDesktopAlerts: (v: boolean) => void;
  alertCritical: boolean;
  setAlertCritical: (v: boolean) => void;
  alertWarning: boolean;
  setAlertWarning: (v: boolean) => void;
  alertDirective: boolean;
  setAlertDirective: (v: boolean) => void;
  alertError: boolean;
  setAlertError: (v: boolean) => void;
  attentionStates: { stuck?: boolean; erroring?: boolean; waiting?: boolean; blocked?: boolean; done?: boolean };
  setAttentionStates: (v: { stuck?: boolean; erroring?: boolean; waiting?: boolean; blocked?: boolean; done?: boolean }) => void;
}

/** Re-exported so sections that take a hostLabels pref share one type. */
export type { HostLabels };
