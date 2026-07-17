import { useState, useEffect, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { TelemetryTransparency } from '@/components/TelemetryTransparency';
import { deriveTelemetrySendingStatus } from '@/lib/telemetry/destination';
import { ArrowLeft, Trash2, AlertTriangle, Send } from 'lucide-react';
import { type Theme, type TerminalColorScheme, THEMES } from '@/lib/theme';
import { type Density } from '@/lib/density';
import { type TimestampFormat } from '@/lib/formatTimestamp';
import { type RestoreOnStartup, type PaneLayout, type TerminalCursorStyle, type OnExitBehavior, type CustomPreset, type PresetNameIssue, type Snippet, type SnippetNameIssue, type WatchPattern, type PatternNameIssue, PRESET_NAME_MAX, validatePresetName, SNIPPET_NAME_MAX, SNIPPET_TEXT_MAX, validateSnippetName, WATCH_PATTERN_NAME_MAX, WATCH_PATTERN_EXPRESSION_MAX, WATCH_PATTERN_MAX_COUNT, validatePatternName, isValidRegex, DEFAULT_TERMINAL_FONT_FAMILY } from '@/lib/storage';
import { THIS_MACHINE, type HostLabels } from '@/lib/chatDisplay';
import { hasWindowBridge } from '@/lib/electron';
import { requestAlertPermission } from '@/lib/desktopAlerts';
import { putJson } from '@/lib/api';
import { resolvePollIntervalMs } from '@/lib/pollInterval';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

// Curated common monospace fonts for the "Terminal font family" control. Each
// `value` is a complete, valid CSS font-family string (the chosen face first,
// then sane monospace fallbacks) so it can be passed straight to xterm. "System
// default" maps to DEFAULT_TERMINAL_FONT_FAMILY (today's exact stack). Anything
// not in this list is "Custom…" (free-text input below).
const TERMINAL_FONT_OPTIONS: { label: string; value: string }[] = [
  { label: 'System default', value: DEFAULT_TERMINAL_FONT_FAMILY },
  { label: 'Cascadia Code', value: '"Cascadia Code", "JetBrains Mono", "Fira Code", ui-monospace, Menlo, Consolas, monospace' },
  { label: 'JetBrains Mono', value: '"JetBrains Mono", "Cascadia Code", "Fira Code", ui-monospace, Menlo, Consolas, monospace' },
  { label: 'Fira Code', value: '"Fira Code", "JetBrains Mono", "Cascadia Code", ui-monospace, Menlo, Consolas, monospace' },
  { label: 'Source Code Pro', value: '"Source Code Pro", "JetBrains Mono", "Cascadia Code", ui-monospace, Menlo, Consolas, monospace' },
  { label: 'Menlo', value: 'Menlo, "Cascadia Code", "JetBrains Mono", ui-monospace, Consolas, monospace' },
  { label: 'Consolas', value: 'Consolas, "Cascadia Code", "JetBrains Mono", ui-monospace, Menlo, monospace' },
];
// Sentinel value the Select uses to mean "show the free-text Custom input".
// (Radix Select forbids an empty-string option value, so this is non-empty.)
const CUSTOM_FONT_VALUE = '__custom__';

interface ConfigData {
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
  // User-authored output-pattern alerts (WARDEN-540). Persisted via /api/config
  // (SERVER-side — the matcher runs in pollAgentStates, not the renderer), NOT client
  // localStorage. Round-tripped through GET/PUT like the other config fields above.
  watchPatterns: WatchPattern[];
}

interface Props {
  /** Return to the dashboard without saving backend config. */
  onClose: () => void;
  onConfigChange: () => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  // Density is a pure client-side localStorage pref (NOT backend config): it
  // applies instantly via the prop callback and is persisted by App's saveUi
  // effect. It must never be added to the `config` state / PUT /api/config body.
  density: Density;
  setDensity: (density: Density) => void;
  // Pane layout is a pure client-side localStorage pref (NOT backend config):
  // it applies instantly via the prop callback (PaneGrid recomputes cols/rows
  // on render) and is persisted by App's saveUi effect. It must never be added
  // to the `config` state / PUT /api/config body.
  paneLayout: PaneLayout;
  setPaneLayout: (layout: PaneLayout) => void;
  // "Pane on agent exit" behavior is likewise a pure client-side localStorage pref
  // (NOT backend config): it controls how an already-open pane reacts when its
  // agent process exits, applies instantly via the prop callback, and is persisted
  // by App's saveUi effect. It must never be added to the `config` state /
  // PUT /api/config body. See WARDEN-248.
  onExitBehavior: OnExitBehavior;
  setOnExitBehavior: (v: OnExitBehavior) => void;
  // "Auto-focus new pane" is likewise a pure client-side localStorage pref (NOT
  // backend config): it gates whether opening/resuming/splitting a chat moves
  // keyboard focus to the new pane (default on = today's behavior). It applies
  // instantly via the prop callback and is persisted by App's saveUi effect. It
  // must never be added to the `config` state / PUT /api/config body. See
  // WARDEN-274.
  autoFocusNewPane: boolean;
  setAutoFocusNewPane: (v: boolean) => void;
  // "Restore workspace on startup" is likewise a pure client-side localStorage
  // pref: it gates App's workspace initializers and is persisted by App's saveUi
  // effect. It must never be added to the `config` state / PUT /api/config body.
  restoreOnStartup: RestoreOnStartup;
  setRestoreOnStartup: (v: RestoreOnStartup) => void;
  terminalFontSize: number;
  setTerminalFontSize: (n: number) => void;
  // Terminal scrollback is likewise a pure client-side localStorage pref: it
  // sets the xterm scrollback buffer depth and is persisted by App's saveUi
  // effect. It must never be added to the `config` state / PUT /api/config body.
  terminalScrollback: number;
  setTerminalScrollback: (n: number) => void;
  // Terminal font family is likewise a pure client-side localStorage pref: it
  // sets the xterm CSS font-family for every agent pane and is persisted by
  // App's saveUi effect. It must never be added to the `config` state /
  // PUT /api/config body. Applies live to open panes.
  terminalFontFamily: string;
  setTerminalFontFamily: (v: string) => void;
  // Terminal color scheme is likewise a pure client-side localStorage pref: it
  // sets the xterm surface (background/foreground) and is persisted by App's
  // saveUi effect. It must never be added to the `config` state / PUT /api/config body.
  terminalColorScheme: TerminalColorScheme;
  setTerminalColorScheme: (v: TerminalColorScheme) => void;
  // Terminal cursor style (shape × blink) is likewise a pure client-side
  // localStorage pref: it sets the xterm cursorStyle + cursorBlink and is
  // persisted by App's saveUi effect. It must never be added to the `config`
  // state / PUT /api/config body.
  terminalCursorStyle: TerminalCursorStyle;
  setTerminalCursorStyle: (v: TerminalCursorStyle) => void;
  // "Copy on select" is likewise a pure client-side localStorage pref (NOT
  // backend config): when ON, completing a text selection in a pane copies it to
  // the clipboard immediately (no Ctrl/Cmd+C). Default OFF = today's behavior.
  // It applies instantly via the prop callback (PaneTile's onSelectionChange
  // handler reads the latest value live) and is persisted by App's saveUi
  // effect. It must never be added to the `config` state / PUT /api/config body.
  copyOnSelect: boolean;
  setCopyOnSelect: (v: boolean) => void;
  // Timestamp format is a pure client-side localStorage pref (NOT backend
  // config): it chooses how every timestamp surface reads — 'relative'
  // ("2m"/"3h" buckets) or 'absolute' (clock time) — applies instantly via the
  // prop callback (every surface re-renders through the shared formatTimestamp
  // helper), and is persisted by App's saveUi effect. It must NEVER be added to
  // the `config` state / PUT /api/config body. See WARDEN-213.
  timestampFormat: TimestampFormat;
  setTimestampFormat: (v: TimestampFormat) => void;
  // Default agent type + host pre-filled in the ＋ new chat form. Pure client-side
  // localStorage prefs: applied instantly via the prop callbacks and persisted by
  // App's saveUi effect. They must never be added to the `config` state /
  // PUT /api/config body. `defaultNewChatPreset` is a reserved built-in name
  // ('claude' | 'shell') OR a custom preset name.
  defaultNewChatPreset: string;
  setDefaultNewChatPreset: (v: string) => void;
  // Per-host agent-type (preset) overrides for the ＋ new chat spawn form
  // (WARDEN-352 — mirrors defaultNewChatCwdByHost). Keys are host strings
  // ('(local)' / SSH host name); a host with no entry (or one whose value names
  // a since-deleted preset, dropped on load) falls through to the global
  // defaultNewChatPreset, then 'claude'. Pure client-side localStorage pref,
  // persisted by App's saveUi effect; never sent to the backend.
  defaultNewChatPresetByHost: Record<string, string>;
  setDefaultNewChatPresetByHost: (v: Record<string, string>) => void;
  defaultNewChatHost: string;
  setDefaultNewChatHost: (v: string) => void;
  // Default working directory pre-filled in the ＋ new chat spawn form
  // (WARDEN-311). Blank → the host's home directory (today's behavior). Pure
  // client-side localStorage pref, persisted by App's saveUi effect; never sent
  // to the backend.
  defaultNewChatCwd: string;
  setDefaultNewChatCwd: (v: string) => void;
  // Per-host cwd overrides for the ＋ new chat spawn form (WARDEN-336). Keys are
  // host strings ('(local)' / SSH host name); a host with no entry (or an empty
  // value, dropped on load) falls through to defaultNewChatCwd above, then blank.
  // Pure client-side localStorage pref, persisted by App's saveUi effect; never
  // sent to the backend.
  defaultNewChatCwdByHost: Record<string, string>;
  setDefaultNewChatCwdByHost: (v: Record<string, string>) => void;
  // User-defined spawn presets (named quick-fill commands beyond claude/shell).
  // Pure client-side localStorage pref, persisted by App's saveUi effect; never
  // sent to the backend.
  customPresets: CustomPreset[];
  setCustomPresets: (v: CustomPreset[]) => void;
  // User-defined instruction snippets (named, reusable intervention text —
  // WARDEN-323). Surfaced at the Broadcast dialog (insert-only) and a focused
  // pane's context menu (one-click send). Global (one flat list). Pure client-
  // side localStorage pref, persisted by App's saveUi effect; only the literal
  // `text` ever leaves the client, over the existing /api/send path.
  snippets: Snippet[];
  setSnippets: (v: Snippet[]) => void;
  // Default shell opened by BOTH the ＋ new-chat *shell* preset and the ＋ split
  // button (WARDEN-429 — unifies the prior split-only defaultSplitShell). Blank
  // means "no explicit shell" → the host launches its own login shell. Pure
  // client-side localStorage pref, persisted by App's saveUi effect; never sent
  // to the backend.
  defaultShell: string;
  setDefaultShell: (v: string) => void;
  // Per-host default-shell overrides (WARDEN-429 — mirrors defaultNewChatCwdByHost).
  // Keys are host strings ('(local)' / SSH host name); a host with no entry (or an
  // empty value, dropped on load) falls through to defaultShell, then blank (host
  // login shell). Pure client-side localStorage pref, persisted by App's saveUi
  // effect; never sent to the backend.
  defaultShellByHost: Record<string, string>;
  setDefaultShellByHost: (v: Record<string, string>) => void;
  // Per-host display labels (WARDEN-490) — friendly names shown wherever a host
  // tag appears (sidebar rows, pane header, Kill/Collision/Broadcast dialogs,
  // Open Chat Browser, Activity timeline, Directive history, Observer tabs,
  // Health dashboard, token-budget offender line, SessionTranscriptViewer).
  // Pure client-side localStorage pref, persisted by App's saveUi effect; NEVER
  // sent to the backend / /api/config (a label is display-only). Keys are raw
  // host strings ('(local)' / SSH host); a blank/absent value = raw host. The
  // Hosts section renders an inline editor for this even though the rest of the
  // section touches `config` (backend) — labels are threaded in separately.
  hostLabels: HostLabels;
  setHostLabels: (v: HostLabels) => void;
  // "Remember window position and size" is an Electron-main-owned pref, NOT a
  // renderer localStorage pref: OS window bounds must be readable at
  // createWindow() time (before the renderer loads), so the flag + bounds live
  // in main's window-state.json and are read/written through the IPC bridge
  // (web/src/lib/electron.ts). This prop is a display mirror; main's file is the
  // source of truth, so it is NOT part of UiState / the saveUi effect. When the
  // bridge is absent (`npm run dev` browser, `node web/smoke.cjs`) the control
  // renders disabled with a hint that it applies to the desktop app — the same
  // web bundle runs in all three contexts. See WARDEN-263.
  rememberWindowBounds: boolean;
  setRememberWindowBounds: (v: boolean) => void;
  // "Launch Warden at login" — main-owned via IPC (WARDEN-278). Sits beside the
  // remember-bounds control: both govern launch behavior. Defaults OFF (consent —
  // auto-start modifies the OS login items), unlike remember-bounds which
  // defaults ON. Same hasWindowBridge() gating as remember-bounds.
  launchAtLogin: boolean;
  setLaunchAtLogin: (v: boolean) => void;
  // "Close to tray" — main-owned via IPC (WARDEN-330). Sits beside the launch-
  // at-login control: both govern what happens when the app/window closes.
  // Defaults OFF (opt-in): when ON, closing the window hides it to a tray icon
  // so the backend + desktop alerts keep running instead of quitting. Same
  // hasWindowBridge() gating as the sibling controls.
  closeToTray: boolean;
  setCloseToTray: (v: boolean) => void;
  // Opt-in OS desktop alerts when agents need attention AND Warden is unfocused
  // (WARDEN-259). Pure client-side localStorage pref (NOT backend config): it
  // applies instantly via the prop callback (forwarded to the AttentionBadge) and
  // is persisted by App's saveUi effect. It must NEVER be added to the `config`
  // state / PUT /api/config body — the adjacent toast toggles use setConfig, but
  // this is a different delivery channel AND a different persistence path.
  attentionDesktopAlerts: boolean;
  setAttentionDesktopAlerts: (v: boolean) => void;
  // WARDEN-364 — per-severity routing for the desktop-alert channel (layered on
  // the master toggle above). Same persistence path (App's saveUi / UiState).
  alertCritical: boolean;
  setAlertCritical: (v: boolean) => void;
  alertWarning: boolean;
  setAlertWarning: (v: boolean) => void;
  alertDirective: boolean;
  setAlertDirective: (v: boolean) => void;
  alertError: boolean;
  setAlertError: (v: boolean) => void;
  // Per-state Attention toggle (WARDEN-344): which pane states raise the badge +
  // desktop alert. Pure client-side localStorage pref (same channel/persistence as
  // attentionDesktopAlerts); never added to the backend `config`.
  attentionStates: { stuck?: boolean; erroring?: boolean; waiting?: boolean; blocked?: boolean };
  setAttentionStates: (v: { stuck?: boolean; erroring?: boolean; waiting?: boolean; blocked?: boolean }) => void;
  // Reset every client-side UI PREF (appearance, terminal, new-chat, behavior)
  // to its DEFAULT_UI value while preserving the open workspace (tabs/panes/
  // focus/host map) and panel layout (collapse state + widths). Confirm-gated
  // by this page's danger-zone control; the callback is App-owned and stable.
  // Pure client-side: never touches the backend / config.json. See WARDEN-346.
  resetUiPrefsToDefaults: () => void;
}

/** A titled group of related settings. In the master-detail layout only one
 *  section is visible at a time, so it no longer needs inter-section borders. */
function SettingsSection({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn('flex flex-col gap-3', className)}>
      <h2 className="text-sm font-medium text-foreground">{title}</h2>
      {children}
    </section>
  );
}

/**
 * WARDEN-557 — the honest "is signal actually flowing?" status for the
 * Telemetry section. A pure, live-derived view of the two already-bound prefs
 * `telemetryBaseEnabled` × `telemetryEndpoint` (no new consent flag, no
 * transport change, no delivery feedback). It reads the same values the
 * consent toggles and endpoint field use, so it re-renders the instant either
 * changes — there is no shadow state.
 *
 * Three states (see deriveTelemetrySendingStatus):
 *  - base OFF → renders nothing (off is off).
 *  - base ON + blank endpoint → amber notice: enabled but no receiver is
 *    configured, so nothing is being sent (the silently-inert opt-in).
 *  - base ON + endpoint set → positive destination confirmation (host only,
 *    derived from the configured URL; NOT a reachability claim).
 */
function TelemetrySendingStatus({
  baseEnabled,
  endpoint,
}: {
  baseEnabled: boolean;
  endpoint: string;
}) {
  const status = deriveTelemetrySendingStatus({ baseEnabled, endpoint });
  if (status.kind === 'off') return null;
  if (status.kind === 'unconfigured') {
    return (
      // role="status" (an aria-live=polite region): the whole point of this
      // slice is that the status updates live as the user toggles base consent
      // or edits the endpoint. The unconfigured notice is the state change most
      // worth announcing — "you opted in, but nothing is being sent yet."
      <div
        role="status"
        className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs"
      >
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
        <p className="text-amber-800 dark:text-amber-200">
          <span className="font-medium">Enabled, but nothing is being sent.</span>{' '}
          No receiver endpoint is configured, so events buffer in memory and are
          dropped. Add a receiver URL below for signal to flow.
        </p>
      </div>
    );
  }
  return (
    // role="status": a live region so the transition INTO "configured" (user
    // pastes a receiver URL) is announced alongside the unconfigured notice above.
    <div
      role="status"
      className="flex items-start gap-2 rounded-md border border-green-500/30 bg-green-500/5 px-3 py-2 text-xs"
    >
      <Send className="mt-0.5 size-3.5 shrink-0 text-green-600 dark:text-green-400" aria-hidden />
      <p className="text-muted-foreground">
        <span className="font-medium text-foreground">
          Configured — events will go to {status.destination}.
        </span>{' '}
        That is the receiver host above; warden does not verify whether the
        receiver is reachable or accepts events.
      </p>
    </div>
  );
}

/** The settings section nav entries: a left rail on wide screens, a dropdown on
 *  narrow ones. Order is the display order; the first entry is active by default.
 *  The `id` doubles as the active-section discriminator — each SettingsSection
 *  below hides itself unless its id matches `activeSection`. */
const SETTINGS_SECTIONS = [
  { id: 'hosts', label: 'Hosts & Connection' },
  { id: 'observer', label: 'Observer Preferences' },
  { id: 'safety', label: 'Safety' },
  { id: 'attention', label: 'Attention thresholds' },
  { id: 'tokenbudget', label: 'Token budget' },
  { id: 'performance', label: 'Performance' },
  { id: 'telemetry', label: 'Telemetry' },
  { id: 'display', label: 'Display' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'newchats', label: 'New Chats' },
  { id: 'snippets', label: 'Instruction snippets' },
  { id: 'patterns', label: 'Watch patterns' },
  { id: 'notifications', label: 'Notifications' },
] as const;
type SectionId = (typeof SETTINGS_SECTIONS)[number]['id'];

/**
 * One editable custom preset row: an inline name field (committed on blur/Enter,
 * reverted on a rejected rename) and a live-editable command field, plus delete.
 * Stateless w.r.t. its own value except the name draft — the list is the source
 * of truth, so this is the only piece of local state needed.
 */
function PresetRow({
  preset,
  isDefault,
  onRename,
  onCmdChange,
  onDelete,
}: {
  preset: CustomPreset;
  isDefault: boolean;
  onRename: (oldName: string, newName: string) => boolean;
  onCmdChange: (name: string, cmd: string) => void;
  onDelete: (name: string) => void;
}) {
  const [nameDraft, setNameDraft] = useState(preset.name);
  const [cmdDraft, setCmdDraft] = useState(preset.cmd);
  // Re-sync the drafts if the preset changes from the outside (e.g. after a
  // coordinated default rename or a load), so the inputs never drift.
  useEffect(() => {
    setNameDraft(preset.name);
  }, [preset.name]);
  useEffect(() => {
    setCmdDraft(preset.cmd);
  }, [preset.cmd]);

  const commitName = () => {
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== preset.name) {
      if (!onRename(preset.name, trimmed)) setNameDraft(preset.name); // revert on rejection
    } else {
      setNameDraft(preset.name); // empty or unchanged → revert
    }
  };

  // Commit the command on blur/Enter, mirroring commitName: free-edit while
  // focused, but never persist an empty command — parseCustomPresets would drop
  // the whole preset on next reload (silent data loss). Empty on commit reverts
  // to the last saved value, so the field is editable but never goes dangling.
  const commitCmd = () => {
    const trimmed = cmdDraft.trim();
    if (trimmed) {
      onCmdChange(preset.name, trimmed);
    } else {
      setCmdDraft(preset.cmd); // empty → revert
    }
  };

  return (
    <div className="flex flex-col gap-1 rounded-md border bg-muted/30 p-2">
      <div className="flex items-center gap-2">
        <Input
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') setNameDraft(preset.name);
          }}
          className="h-8 flex-1"
          placeholder="name"
          aria-label="Preset name"
          maxLength={PRESET_NAME_MAX}
        />
        {isDefault && <Badge variant="secondary">default</Badge>}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onDelete(preset.name)}
          aria-label={`Delete ${preset.name} preset`}
        >
          <Trash2 />
        </Button>
      </div>
      <Input
        value={cmdDraft}
        onChange={(e) => setCmdDraft(e.target.value)}
        onBlur={commitCmd}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setCmdDraft(preset.cmd);
        }}
        className="h-8"
        placeholder="command"
        aria-label={`${preset.name} command`}
      />
    </div>
  );
}

/**
 * One editable instruction-snippet row: an inline name field (committed on
 * blur/Enter, reverted on a rejected rename) and a live-editable text field
 * (the instruction itself — free-form, so a Textarea), plus delete. Stateless
 * w.r.t. its own value except the two drafts — the list is the source of truth.
 * Mirrors PresetRow; the only structural difference is Textarea vs Input for
 * the body (instructions are multi-line free text up to SNIPPET_TEXT_MAX chars,
 * not a single spawn command).
 */
function SnippetRow({
  snippet,
  onRename,
  onTextChange,
  onDelete,
}: {
  snippet: Snippet;
  onRename: (oldName: string, newName: string) => boolean;
  onTextChange: (name: string, text: string) => void;
  onDelete: (name: string) => void;
}) {
  const [nameDraft, setNameDraft] = useState(snippet.name);
  const [textDraft, setTextDraft] = useState(snippet.text);
  // Re-sync the drafts if the snippet changes from the outside (e.g. after a
  // coordinated load), so the inputs never drift.
  useEffect(() => {
    setNameDraft(snippet.name);
  }, [snippet.name]);
  useEffect(() => {
    setTextDraft(snippet.text);
  }, [snippet.text]);

  const commitName = () => {
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== snippet.name) {
      if (!onRename(snippet.name, trimmed)) setNameDraft(snippet.name); // revert on rejection
    } else {
      setNameDraft(snippet.name); // empty or unchanged → revert
    }
  };

  // Commit the text on blur, mirroring commitName: free-edit while focused, but
  // never persist an empty text — parseSnippets would drop the whole snippet on
  // next reload (silent data loss). Empty on commit reverts to the last saved
  // value, so the field is editable but never goes dangling.
  const commitText = () => {
    const trimmed = textDraft.trim();
    if (trimmed) {
      onTextChange(snippet.name, trimmed);
    } else {
      setTextDraft(snippet.text); // empty → revert
    }
  };

  return (
    <div className="flex flex-col gap-1 rounded-md border bg-muted/30 p-2">
      <div className="flex items-center gap-2">
        <Input
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') setNameDraft(snippet.name);
          }}
          className="h-8 flex-1"
          placeholder="name"
          aria-label="Snippet name"
          maxLength={SNIPPET_NAME_MAX}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onDelete(snippet.name)}
          aria-label={`Delete ${snippet.name} snippet`}
        >
          <Trash2 />
        </Button>
      </div>
      <Textarea
        value={textDraft}
        onChange={(e) => setTextDraft(e.target.value)}
        onBlur={commitText}
        onKeyDown={(e) => {
          // Enter inserts a newline in a Textarea; ⌘/Ctrl+Enter commits.
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.currentTarget.blur(); }
          if (e.key === 'Escape') setTextDraft(snippet.text);
        }}
        className="min-h-[60px] text-sm"
        placeholder="the instruction to send"
        aria-label={`${snippet.name} instruction text`}
        maxLength={SNIPPET_TEXT_MAX}
      />
    </div>
  );
}

/**
 * One editable watch-pattern row (WARDEN-540): an inline name field, the match
 * expression, a string/regex mode selector, an enabled toggle, and delete. Mirrors
 * SnippetRow's commit-on-blur discipline but persists through /api/config (server-
 * side) rather than localStorage — the matcher runs in pollAgentStates, so the
 * pattern must reach the backend. The list (`config.watchPatterns`) is the source of
 * truth; this holds only the two editable drafts, re-synced on external change.
 *
 * For mode 'regex', a live validity check (isValidRegex) warns when the expression
 * won't compile — the backend matcher try/catches and skips an invalid pattern rather
 * than throwing, but authoring-time feedback beats a silently-never-matching rule.
 */
function PatternRow({
  pattern,
  onRename,
  onExpressionChange,
  onModeChange,
  onToggleEnabled,
  onDelete,
}: {
  pattern: WatchPattern;
  onRename: (id: string, newName: string) => boolean;
  onExpressionChange: (id: string, expression: string) => void;
  onModeChange: (id: string, mode: 'string' | 'regex') => void;
  onToggleEnabled: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [nameDraft, setNameDraft] = useState(pattern.name);
  const [exprDraft, setExprDraft] = useState(pattern.expression);
  useEffect(() => { setNameDraft(pattern.name); }, [pattern.name]);
  useEffect(() => { setExprDraft(pattern.expression); }, [pattern.expression]);

  const commitName = () => {
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== pattern.name) {
      if (!onRename(pattern.id, trimmed)) setNameDraft(pattern.name); // revert on rejection
    } else {
      setNameDraft(pattern.name); // empty or unchanged → revert
    }
  };
  const commitExpr = () => {
    const trimmed = exprDraft.trim();
    if (trimmed) {
      onExpressionChange(pattern.id, trimmed);
    } else {
      setExprDraft(pattern.expression); // empty → revert (never persist an empty expression)
    }
  };

  // Only flag an invalid regex once the user has typed something — an empty draft is
  // the "not yet editing" state, not a malformed rule.
  const regexInvalid = pattern.mode === 'regex' && exprDraft.trim().length > 0 && !isValidRegex(exprDraft);

  return (
    <div className="flex flex-col gap-1 rounded-md border bg-muted/30 p-2">
      <div className="flex items-center gap-2">
        <Input
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') setNameDraft(pattern.name);
          }}
          className="h-8 flex-1"
          placeholder="name (e.g. Deploy failed)"
          aria-label="Pattern name"
          maxLength={WATCH_PATTERN_NAME_MAX}
        />
        {/* Enabled toggle: silence a pattern without deleting it. */}
        <IconTooltip label={pattern.enabled ? 'disable — stop alerting on this pattern' : 'enable — alert when this matches'}>
          <Switch
            checked={pattern.enabled}
            onCheckedChange={() => onToggleEnabled(pattern.id)}
            aria-label={`Toggle ${pattern.name} pattern`}
          />
        </IconTooltip>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onDelete(pattern.id)}
          aria-label={`Delete ${pattern.name} pattern`}
        >
          <Trash2 />
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Input
          value={exprDraft}
          onChange={(e) => setExprDraft(e.target.value)}
          onBlur={commitExpr}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') setExprDraft(pattern.expression);
          }}
          className="h-8 flex-1"
          placeholder={pattern.mode === 'regex' ? 'regex (e.g. payment (required|due))' : 'text to match (e.g. merge conflict)'}
          aria-label={`${pattern.name} match expression`}
          maxLength={WATCH_PATTERN_EXPRESSION_MAX}
        />
        <Select
          value={pattern.mode}
          onValueChange={(v) => onModeChange(pattern.id, v === 'regex' ? 'regex' : 'string')}
        >
          <SelectTrigger className="h-8 w-[104px]" aria-label="Match mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="string">text</SelectItem>
            <SelectItem value="regex">regex</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {regexInvalid && (
        <p className="text-xs text-red-500">Invalid regex — it will be skipped until fixed.</p>
      )}
    </div>
  );
}

export function SettingsPage({ onClose, onConfigChange, theme, setTheme, density, setDensity, paneLayout, setPaneLayout, onExitBehavior, setOnExitBehavior, autoFocusNewPane, setAutoFocusNewPane, restoreOnStartup, setRestoreOnStartup, terminalFontSize, setTerminalFontSize, attentionDesktopAlerts, setAttentionDesktopAlerts, attentionStates, setAttentionStates, alertCritical, setAlertCritical, alertWarning, setAlertWarning, alertDirective, setAlertDirective, alertError, setAlertError, terminalScrollback, setTerminalScrollback, terminalFontFamily, setTerminalFontFamily, terminalColorScheme, setTerminalColorScheme, terminalCursorStyle, setTerminalCursorStyle, copyOnSelect, setCopyOnSelect, timestampFormat, setTimestampFormat, defaultNewChatPreset, setDefaultNewChatPreset, defaultNewChatPresetByHost, setDefaultNewChatPresetByHost, defaultNewChatHost, setDefaultNewChatHost, defaultNewChatCwd, setDefaultNewChatCwd, defaultNewChatCwdByHost, setDefaultNewChatCwdByHost, customPresets, setCustomPresets, snippets, setSnippets, defaultShell, setDefaultShell, defaultShellByHost, setDefaultShellByHost, hostLabels, setHostLabels, rememberWindowBounds, setRememberWindowBounds, launchAtLogin, setLaunchAtLogin, closeToTray, setCloseToTray, resetUiPrefsToDefaults }: Props) {
  const [config, setConfig] = useState<ConfigData>({
    hosts: [],
    pollIntervalMs: 1500,
    tmuxSession: 'agent',
    connectTimeout: 10,
    observerConfirmMode: 'always',
    observerAutoStart: false,
    observerSessionTimeout: 30,
    llm: { model: '', baseUrl: '', maxTokens: null },
    healthWarningThresholdMin: 5,
    healthCriticalThresholdMin: 30,
    tokenBudgetEnabled: false,
    tokenBudgetThresholdTokens: 2_000_000,
    tokenBudgetWindowHours: 24,
    tokenBudgetPerSessionThresholdTokens: 1_000_000,
    companionTransportEnabled: false,
    companionTransportOverridden: false,
    confirmDestructiveActions: true,
    notifyChatOps: true,
    notifyErrors: true,
    notifySuccess: true,
    notifyObserver: true,
    // Display customization
    showHostTags: true,
    showTypeBadges: true,
    showStatusIndicators: true,
    showProjectBadges: false,
    hideOfflineHosts: false,
    // Telemetry consent (WARDEN-457) — off by default.
    telemetryBaseEnabled: false,
    telemetryExtendedEnabled: false,
    // Receiver endpoint (WARDEN-522) — empty by default = unconfigured = no-op.
    telemetryEndpoint: '',
    // Webhook push channel (WARDEN-555) — off by default; both routing toggles on.
    webhookUrl: '',
    webhookEnabled: false,
    webhookAlertAttention: true,
    webhookAlertBudget: true,
    // WARDEN-540 — empty until the GET /api/config load populates it.
    watchPatterns: [],
  });
  const [availableHosts, setAvailableHosts] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // "Reset preferences to defaults" confirm dialog (danger-zone). Always gated
  // by the confirm — it is a rare, destructive-to-prefs action worth the
  // friction regardless of the confirmDestructiveActions kill-toggle (that
  // toggle is about chat/session kills, not about reverting your own tuning).
  const [resetPrefsOpen, setResetPrefsOpen] = useState(false);

  // Observer auth token — write-only (WARDEN-350). GET /api/config returns only
  // a masked indicator (authTokenSet + optional last-4); there is no cleartext
  // to seed into the password input, so it stays empty until the human types a
  // new token. On save it is sent ONLY when non-empty; an untouched field is
  // omitted so the backend no-clobbers the stored secret.
  const [observerAuthTokenSet, setObserverAuthTokenSet] = useState(false);
  const [observerAuthTokenTail, setObserverAuthTokenTail] = useState<string | null>(null);
  const [observerAuthTokenInput, setObserverAuthTokenInput] = useState('');

  // Webhook shared secret (WARDEN-555) — write-only, identical discipline to the
  // observer auth token above: GET returns only a set + tail indicator, so the
  // input stays empty until the human types a new secret; on save it is sent ONLY
  // when non-empty, and an untouched field is omitted so the backend no-clobbers
  // the stored secret.
  const [webhookSecretSet, setWebhookSecretSet] = useState(false);
  const [webhookSecretTail, setWebhookSecretTail] = useState<string | null>(null);
  const [webhookSecretInput, setWebhookSecretInput] = useState('');
  const [testingWebhook, setTestingWebhook] = useState(false);

  // Telemetry receiver auth token (WARDEN-569) — write-only, identical discipline
  // to the webhook secret above: GET returns only a set + tail indicator, so the
  // password input stays empty until the human types a new token; on save it is
  // sent ONLY when non-empty, and an untouched field is omitted so the backend
  // no-clobbers the stored token. Sent on the wire as `Authorization: Bearer`.
  const [telemetryAuthTokenSet, setTelemetryAuthTokenSet] = useState(false);
  const [telemetryAuthTokenTail, setTelemetryAuthTokenTail] = useState<string | null>(null);
  const [telemetryAuthTokenInput, setTelemetryAuthTokenInput] = useState('');

  // Active section in the master-detail nav. The first section is selected by
  // default; switching shows only that section, so there's no cross-section
  // page-level scroll. Persisting across visits is intentionally not done.
  const [activeSection, setActiveSection] = useState<SectionId>('hosts');

  // Terminal font family Select: a curated font, or "Custom…" which reveals a
  // free-text input for any installed CSS font (e.g. a Nerd Font for glyphs).
  // The pref is always the full CSS font-family string; customFontMode tracks
  // whether the free-text field is shown (initialized from whether the saved
  // value is already a non-curated/custom value). A blank custom value falls
  // back to the default stack, but we stay in custom mode so the field doesn't
  // vanish mid-edit.
  const matchedCurated = TERMINAL_FONT_OPTIONS.find((f) => f.value === terminalFontFamily);
  const [customFontMode, setCustomFontMode] = useState(!matchedCurated);
  const [customFontText, setCustomFontText] = useState(!matchedCurated ? terminalFontFamily : '');
  const fontSelectValue = customFontMode ? CUSTOM_FONT_VALUE : terminalFontFamily;

  // Load current config and available hosts when the page mounts.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      fetch('/api/config').then((r) => r.json()),
      fetch('/api/ssh-hosts').then((r) => r.json()),
    ])
      .then(([configData, hostsData]) => {
        if (cancelled) return;
        setConfig({
          hosts: configData.hosts || [],
          pollIntervalMs: configData.pollIntervalMs || 1500,
          tmuxSession: configData.tmuxSession || 'agent',
          connectTimeout: configData.connectTimeout || 10,
          observerConfirmMode: ['always', 'auto-safe'].includes(configData.observerConfirmMode)
            ? configData.observerConfirmMode
            : 'always',
          observerAutoStart: configData.observerAutoStart || false,
          observerSessionTimeout: configData.observerSessionTimeout ?? 30,
          llm: {
            model: configData.llm?.model ?? '',
            baseUrl: configData.llm?.baseUrl ?? '',
            maxTokens: typeof configData.llm?.maxTokens === 'number' ? configData.llm.maxTokens : null,
          },
          healthWarningThresholdMin: configData.healthWarningThresholdMin ?? 5,
          healthCriticalThresholdMin: configData.healthCriticalThresholdMin ?? 30,
          tokenBudgetEnabled: configData.tokenBudgetEnabled ?? false,
          tokenBudgetThresholdTokens:
            typeof configData.tokenBudgetThresholdTokens === 'number'
              ? configData.tokenBudgetThresholdTokens
              : 2_000_000,
          tokenBudgetWindowHours:
            typeof configData.tokenBudgetWindowHours === 'number'
              ? configData.tokenBudgetWindowHours
              : 24,
          tokenBudgetPerSessionThresholdTokens:
            typeof configData.tokenBudgetPerSessionThresholdTokens === 'number'
              ? configData.tokenBudgetPerSessionThresholdTokens
              : 1_000_000,
          companionTransportEnabled: configData.companionTransportEnabled ?? false,
          companionTransportOverridden: configData.companionTransportOverridden ?? false,
          confirmDestructiveActions: configData.confirmDestructiveActions ?? true,
          notifyChatOps: configData.notifyChatOps ?? true,
          notifyErrors: configData.notifyErrors ?? true,
          notifySuccess: configData.notifySuccess ?? true,
          notifyObserver: configData.notifyObserver ?? true,
          // Display customization
          showHostTags: configData.showHostTags ?? true,
          showTypeBadges: configData.showTypeBadges ?? true,
          showStatusIndicators: configData.showStatusIndicators ?? true,
          showProjectBadges: configData.showProjectBadges ?? false,
          hideOfflineHosts: configData.hideOfflineHosts ?? false,
          // Telemetry consent (WARDEN-457) — defensive ?? false so an older
          // backend that does not return the fields stays safely OFF.
          telemetryBaseEnabled: configData.telemetryBaseEnabled ?? false,
          telemetryExtendedEnabled: configData.telemetryExtendedEnabled ?? false,
          // Defensive ?? '' so an older backend that does not return the field
          // stays safely unconfigured (empty = sends nothing).
          telemetryEndpoint: configData.telemetryEndpoint ?? '',
          // Webhook push channel (WARDEN-555). Defensive fallbacks so an older
          // backend without these fields stays safely OFF / unconfigured.
          webhookUrl: configData.webhookUrl ?? '',
          webhookEnabled: configData.webhookEnabled ?? false,
          webhookAlertAttention: configData.webhookAlertAttention ?? true,
          webhookAlertBudget: configData.webhookAlertBudget ?? true,
          // WARDEN-540: patterns are sanitized on the PUT boundary, so the GET
          // response is already well-formed. Defensive ?? [] keeps an older backend
          // (no watchPatterns field) safely empty → no alerts.
          watchPatterns: Array.isArray(configData.watchPatterns) ? configData.watchPatterns : [],
        });
        setAvailableHosts(hostsData.hosts || []);
        setObserverAuthTokenSet(Boolean(configData.llm?.authTokenSet));
        setObserverAuthTokenTail(configData.llm?.authTokenTail ?? null);
        setWebhookSecretSet(Boolean(configData.webhookSecretSet));
        setWebhookSecretTail(configData.webhookSecretTail ?? null);
        setTelemetryAuthTokenSet(Boolean(configData.telemetryAuthTokenSet));
        setTelemetryAuthTokenTail(configData.telemetryAuthTokenTail ?? null);
      })
      .catch((err) => {
        console.error('Failed to load config:', err);
        toast.error('Failed to load configuration');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const addHost = (host: string) => {
    if (!config.hosts.includes(host)) {
      setConfig({ ...config, hosts: [...config.hosts, host] });
    }
  };

  const removeHost = (host: string) => {
    setConfig({ ...config, hosts: config.hosts.filter((h) => h !== host) });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // The auth token is write-only: GET never returns cleartext, so the
      // password field is empty until the human types a new one. Send the typed
      // value only when non-empty; omit it on an untouched field so the backend
      // no-clobbers the stored secret. model/baseUrl/maxTokens round-trip.
      const llm: { model: string; baseUrl: string; maxTokens: number | null; authToken?: string } = { ...config.llm };
      const token = observerAuthTokenInput.trim();
      if (token) llm.authToken = token;
      // Webhook secret is write-only too (WARDEN-555): send it only when the human
      // typed a new one; omit it on an untouched field so the backend no-clobbers
      // the stored secret.
      const webhookSecret = webhookSecretInput.trim();
      const webhookExtra: { webhookSecret?: string } = {};
      if (webhookSecret) webhookExtra.webhookSecret = webhookSecret;
      // Telemetry auth token is write-only too (WARDEN-569): send it only when the
      // human typed a new one; omit it on an untouched field so the backend
      // no-clobbers the stored token.
      const telemetryAuthToken = telemetryAuthTokenInput.trim();
      const telemetryExtra: { telemetryAuthToken?: string } = {};
      if (telemetryAuthToken) telemetryExtra.telemetryAuthToken = telemetryAuthToken;
      const { ok, error } = await putJson('/api/config', { ...config, llm, ...webhookExtra, ...telemetryExtra });
      if (!ok) {
        throw new Error(error || 'Failed to save configuration');
      }
      onConfigChange();
      onClose();
    } catch (err) {
      console.error('Failed to save config:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  // "Send test alert" (WARDEN-555): POST a test payload so the user can verify
  // their ntfy/Discord/Slack/Telegram topic end-to-end. The endpoint honors the
  // on-the-wire gate (enabled + URL), so the button is disabled until both are
  // set; the response tells us sent / dropped / not-configured. This MUST be
  // called after a Save when the user just typed a new URL/secret/enable — the
  // backend reads the PERSISTED config, not the in-memory draft.
  const sendTestAlert = async () => {
    setTestingWebhook(true);
    try {
      const res = await fetch('/api/webhook-test', { method: 'POST' });
      const body = await res.json();
      if (body.ok) {
        toast.success('Test alert sent — check your webhook destination.');
      } else if (body.attempts === 0) {
        toast.error('Enable the webhook and set a URL first, then Save.');
      } else if (body.dropped) {
        toast.error(`Could not deliver (last status ${body.status ?? 'n/a'}). Check the URL and try again.`);
      } else {
        toast.error('Test alert did not succeed.');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to send test alert');
    } finally {
      setTestingWebhook(false);
    }
  };

  const availableHostsToAdd = availableHosts.filter((h) => !config.hosts.includes(h));

  // Confirm the workspace-preserving prefs reset: applies the App callback
  // (which snaps every pref to its default and lets the saveUi effect persist
  // it), closes the dialog, and toasts. The workspace (tabs/panes/focus) and
  // panel layout are untouched by design.
  const confirmResetPrefs = () => {
    resetUiPrefsToDefaults();
    setResetPrefsOpen(false);
    toast.success('Preferences reset to defaults');
  };

  // --- Custom spawn-preset management (create / rename / delete) -------------
  // All pure client-side: edits apply instantly via setCustomPresets and are
  // persisted by App's saveUi effect. Renaming/deleting a preset that is the
  // current default keeps the default in sync (rename tracks it; delete falls
  // back to claude) so the default never dangles.
  const [newPresetName, setNewPresetName] = useState('');
  const [newPresetCmd, setNewPresetCmd] = useState('');

  // Human message for a non-null preset-name validation issue. The contract
  // itself lives in storage.ts (validatePresetName); this just renders it.
  const presetNameErrorMessage = (name: string, issue: PresetNameIssue): string => {
    switch (issue) {
      case 'empty': return 'Preset needs a name.';
      case 'too-long': return `Preset name must be ${PRESET_NAME_MAX} characters or fewer.`;
      case 'reserved': return `"${name}" is a reserved preset name (use the built-in claude/shell instead).`;
      case 'duplicate': return `A preset named "${name}" already exists.`;
    }
  };

  const addPreset = () => {
    const name = newPresetName.trim();
    const cmd = newPresetCmd.trim();
    if (!name || !cmd) {
      toast.error('Preset needs both a name and a command.');
      return;
    }
    const issue = validatePresetName(name, customPresets);
    if (issue) {
      toast.error(presetNameErrorMessage(name, issue));
      return;
    }
    setCustomPresets([...customPresets, { name, cmd }]);
    setNewPresetName('');
    setNewPresetCmd('');
  };

  // Returns true on success (PresetRow reverts its draft on false). Coordinated
  // with the default so renaming the current default keeps it selected.
  // Validates through the shared storage contract so a name the load-time
  // sanitizer would drop (too long / reserved / duplicate) can never be persisted.
  const renamePreset = (oldName: string, newName: string): boolean => {
    const issue = validatePresetName(newName, customPresets, oldName);
    if (issue) {
      // commitName already reverts an empty draft silently before calling us;
      // only surface a toast for the rejectable issues.
      if (issue !== 'empty') toast.error(presetNameErrorMessage(newName.trim(), issue));
      return false;
    }
    const name = newName.trim();
    setCustomPresets(customPresets.map((p) => (p.name === oldName ? { ...p, name } : p)));
    if (defaultNewChatPreset === oldName) setDefaultNewChatPreset(name);
    // Keep per-host overrides in sync (WARDEN-352): a host defaulting to the
    // renamed preset must keep pointing at it, not dangle on the old name (which
    // the load-time sanitizer would drop on next reload — this avoids a stale
    // dropdown between saves). Mirrors the defaultNewChatPreset sync above.
    if (Object.values(defaultNewChatPresetByHost).includes(oldName)) {
      setDefaultNewChatPresetByHost(Object.fromEntries(
        Object.entries(defaultNewChatPresetByHost).map(([h, p]) => [h, p === oldName ? name : p]),
      ));
    }
    return true;
  };

  const updatePresetCmd = (name: string, cmd: string) => {
    const trimmed = cmd.trim();
    // Never persist an empty command — parseCustomPresets would drop the whole
    // preset on next reload (silent data loss). PresetRow also reverts an empty
    // draft on blur, but this guards the contract at the write site itself.
    if (!trimmed) return;
    setCustomPresets(customPresets.map((p) => (p.name === name ? { ...p, cmd: trimmed } : p)));
  };

  const deletePreset = (name: string) => {
    setCustomPresets(customPresets.filter((p) => p.name !== name));
    if (defaultNewChatPreset === name) setDefaultNewChatPreset('claude');
    // Drop any per-host override referencing the deleted preset (WARDEN-352): the
    // host would fall back to the global default on next load anyway (the load-
    // time sanitizer drops it), but removing it here keeps the live dropdown free
    // of a dangling name between saves. Mirrors the defaultNewChatPreset reset.
    if (Object.values(defaultNewChatPresetByHost).includes(name)) {
      setDefaultNewChatPresetByHost(Object.fromEntries(
        Object.entries(defaultNewChatPresetByHost).filter(([, p]) => p !== name),
      ));
    }
  };

  // --- Instruction-snippet management (create / rename / edit-text / delete) --
  // All pure client-side: edits apply instantly via setSnippets and are
  // persisted by App's saveUi effect. Mirrors the custom-preset handlers above;
  // the differences are the {name, text} shape (vs {name, cmd}), a text-edit
  // handler (vs cmd), and NO reserved built-in names (so validateSnippetName
  // has no 'reserved' case). The starter set the library seeds on first run
  // (WARDEN-323) renders here as ordinary editable entries — rename, edit text,
  // or delete like any user-created snippet; once deleted, they stay deleted.
  const [newSnippetName, setNewSnippetName] = useState('');
  const [newSnippetText, setNewSnippetText] = useState('');

  // Human message for a non-null snippet-name validation issue. The contract
  // itself lives in storage.ts (validateSnippetName); this just renders it.
  const snippetNameErrorMessage = (name: string, issue: SnippetNameIssue): string => {
    switch (issue) {
      case 'empty': return 'Snippet needs a name.';
      case 'too-long': return `Snippet name must be ${SNIPPET_NAME_MAX} characters or fewer.`;
      case 'duplicate': return `A snippet named "${name}" already exists.`;
    }
  };

  const addSnippet = () => {
    const name = newSnippetName.trim();
    const text = newSnippetText.trim();
    if (!name || !text) {
      toast.error('Snippet needs both a name and instruction text.');
      return;
    }
    const issue = validateSnippetName(name, snippets);
    if (issue) {
      toast.error(snippetNameErrorMessage(name, issue));
      return;
    }
    setSnippets([...snippets, { name, text }]);
    setNewSnippetName('');
    setNewSnippetText('');
  };

  // Returns true on success (SnippetRow reverts its draft on false). Validates
  // through the shared storage contract so a name the load-time sanitizer would
  // drop (too long / duplicate) can never be persisted.
  const renameSnippet = (oldName: string, newName: string): boolean => {
    const issue = validateSnippetName(newName, snippets, oldName);
    if (issue) {
      // commitName already reverts an empty draft silently before calling us;
      // only surface a toast for the rejectable issues.
      if (issue !== 'empty') toast.error(snippetNameErrorMessage(newName.trim(), issue));
      return false;
    }
    const name = newName.trim();
    setSnippets(snippets.map((s) => (s.name === oldName ? { ...s, name } : s)));
    return true;
  };

  const updateSnippetText = (name: string, text: string) => {
    const trimmed = text.trim();
    // Never persist an empty text — parseSnippets would drop the whole snippet
    // on next reload (silent data loss). SnippetRow also reverts an empty draft
    // on blur, but this guards the contract at the write site itself.
    if (!trimmed) return;
    setSnippets(snippets.map((s) => (s.name === name ? { ...s, text: trimmed } : s)));
  };

  const deleteSnippet = (name: string) => {
    setSnippets(snippets.filter((s) => s.name !== name));
  };

  // ─── Watch patterns (WARDEN-540) ────────────────────────────────────────────
  // CRUD over config.watchPatterns (server-side, round-tripped via /api/config on
  // Save). Each pattern is keyed by a stable id (so a rename never confuses the row),
  // unlike snippets which key on name. The new-pattern form mirrors the snippet form.
  const [newPatternName, setNewPatternName] = useState('');
  const [newPatternExpression, setNewPatternExpression] = useState('');
  const [newPatternMode, setNewPatternMode] = useState<'string' | 'regex'>('string');

  const patternNameErrorMessage = (name: string, issue: PatternNameIssue): string => {
    switch (issue) {
      case 'empty': return 'Pattern needs a name.';
      case 'too-long': return `Pattern name must be ${WATCH_PATTERN_NAME_MAX} characters or fewer.`;
      case 'duplicate': return `A pattern named "${name}" already exists.`;
    }
  };

  // Stable id for a new pattern. crypto.randomUUID is available in every target
  // (mirrors genWorkspaceId in storage.ts); the fallback covers an older webview.
  const genPatternId = (): string =>
    globalThis.crypto?.randomUUID?.() ?? `wp-${Math.random().toString(36).slice(2)}-${Date.now()}`;

  const addPattern = () => {
    const name = newPatternName.trim();
    const expression = newPatternExpression.trim();
    if (!name || !expression) {
      toast.error('Pattern needs both a name and an expression.');
      return;
    }
    if (config.watchPatterns.length >= WATCH_PATTERN_MAX_COUNT) {
      toast.error(`You can have at most ${WATCH_PATTERN_MAX_COUNT} watch patterns.`);
      return;
    }
    const issue = validatePatternName(name, config.watchPatterns);
    if (issue) {
      toast.error(patternNameErrorMessage(name, issue));
      return;
    }
    if (newPatternMode === 'regex' && !isValidRegex(expression)) {
      toast.error('That regex is invalid — fix it before adding.');
      return;
    }
    setConfig({
      ...config,
      watchPatterns: [...config.watchPatterns, { id: genPatternId(), name, expression, mode: newPatternMode, enabled: true }],
    });
    setNewPatternName('');
    setNewPatternExpression('');
    setNewPatternMode('string');
  };

  // Returns true on success (PatternRow reverts its draft on false). Validates the
  // name through the shared contract so a duplicate/oversize name can never persist.
  const renamePattern = (id: string, newName: string): boolean => {
    const issue = validatePatternName(newName, config.watchPatterns, id);
    if (issue) {
      if (issue !== 'empty') toast.error(patternNameErrorMessage(newName.trim(), issue));
      return false;
    }
    const name = newName.trim();
    setConfig({ ...config, watchPatterns: config.watchPatterns.map((p) => (p.id === id ? { ...p, name } : p)) });
    return true;
  };

  const updatePatternExpression = (id: string, expression: string) => {
    const trimmed = expression.trim();
    if (!trimmed) return; // never persist an empty expression
    setConfig({ ...config, watchPatterns: config.watchPatterns.map((p) => (p.id === id ? { ...p, expression: trimmed } : p)) });
  };

  const setPatternMode = (id: string, mode: 'string' | 'regex') => {
    setConfig({ ...config, watchPatterns: config.watchPatterns.map((p) => (p.id === id ? { ...p, mode } : p)) });
  };

  const togglePatternEnabled = (id: string) => {
    setConfig({ ...config, watchPatterns: config.watchPatterns.map((p) => (p.id === id ? { ...p, enabled: !p.enabled } : p)) });
  };

  const deletePattern = (id: string) => {
    setConfig({ ...config, watchPatterns: config.watchPatterns.filter((p) => p.id !== id) });
  };

  // Write a per-host cwd override (WARDEN-336). An empty/whitespace value means
  // "inherit the global defaultNewChatCwd" — drop the key entirely so it never
  // persists as a blank that cwdFor would return instead of falling through to
  // the global default. (The load-time sanitizer drops blanks too; this keeps
  // the live state in the same sanitized shape between saves.) Keys are the same
  // host strings the spawn form uses ('(local)' / SSH host name).
  const setHostCwd = (host: string, value: string) => {
    const next = { ...defaultNewChatCwdByHost };
    if (value.trim() === '') {
      delete next[host];
    } else {
      next[host] = value;
    }
    setDefaultNewChatCwdByHost(next);
  };

  // Write a per-host agent-type (preset) override (WARDEN-352 — the preset mirror
  // of setHostCwd). A blank/"use global" value means "inherit the global
  // defaultNewChatPreset" — drop the key entirely so it never persists as a blank
  // that presetFor would return instead of falling through to the global default.
  // (The load-time sanitizer drops invalid/blank entries too; this keeps the live
  // state in the same sanitized shape between saves.) Keys are the same host
  // strings the spawn form uses ('(local)' / SSH host name).
  const setHostPreset = (host: string, value: string) => {
    const next = { ...defaultNewChatPresetByHost };
    if (value.trim() === '') {
      delete next[host];
    } else {
      next[host] = value;
    }
    setDefaultNewChatPresetByHost(next);
  };

  // Write a per-host default-shell override (WARDEN-429 — the shell mirror of
  // setHostCwd). An empty/whitespace value means "inherit the global defaultShell"
  // (then the host login shell) — drop the key entirely so it never persists as a
  // blank that the resolver would return instead of falling through to the global
  // default. (The load-time sanitizer drops blanks too; this keeps the live state
  // in the same sanitized shape between saves.) Keys are the same host strings the
  // spawn form uses ('(local)' / SSH host name).
  const setHostShell = (host: string, value: string) => {
    const next = { ...defaultShellByHost };
    if (value.trim() === '') {
      delete next[host];
    } else {
      next[host] = value;
    }
    setDefaultShellByHost(next);
  };

  // Write a per-host display label (WARDEN-490). An empty/whitespace value means
  // "no label" (show the raw host, today's behavior) — drop the key entirely so
  // it never persists as a blank (matching the load-time sanitizer + the funnel's
  // empty = no-label rule). Keys are the raw host strings ('(local)' / SSH host
  // name) — the same every display surface keys on.
  const setHostLabel = (host: string, value: string) => {
    const next = { ...hostLabels };
    if (value.trim() === '') {
      delete next[host];
    } else {
      next[host] = value;
    }
    setHostLabels(next);
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <header className="flex items-center gap-2 px-3 h-11 border-b shrink-0">
        <IconTooltip label="Back to dashboard" side="bottom">
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Back to dashboard">
            <ArrowLeft />
          </Button>
        </IconTooltip>
        <h1 className="text-sm font-semibold tracking-wide">Settings</h1>
        <span className="text-xs text-muted-foreground">
          Manage SSH hosts and connection settings for Warden.
        </span>
      </header>

      <div className="flex flex-1 min-h-0">
        {/* Section nav rail — wide screens (md+). A VS Code-style master-detail
            left rail: pick a section, see only that section in the content pane. */}
        <nav aria-label="Settings sections" className="hidden w-56 shrink-0 flex-col gap-1 overflow-y-auto border-r p-2 md:flex">
          {SETTINGS_SECTIONS.map((s) => (
            <Button
              key={s.id}
              variant="ghost"
              size="sm"
              className={cn(
                'w-full justify-start',
                activeSection === s.id && 'bg-accent font-medium text-accent-foreground hover:bg-accent hover:text-accent-foreground',
              )}
              onClick={() => setActiveSection(s.id)}
              aria-current={activeSection === s.id ? 'page' : undefined}
            >
              {s.label}
            </Button>
          ))}
        </nav>
        <main className="flex min-w-0 min-h-0 flex-1 flex-col">
          {/* Compact section picker — narrow screens (<md). The rail would crowd
              content below ~768px, so it collapses to a dropdown here. Same
              `activeSection` state as the rail; the two never show at once. */}
          <div className="shrink-0 border-b px-4 pb-3 pt-4 md:hidden">
            <Select value={activeSection} onValueChange={(v) => setActiveSection(v as SectionId)}>
              <SelectTrigger className="w-full" aria-label="Settings section">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SETTINGS_SECTIONS.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {/* Content pane — scrolls the ACTIVE section only (no cross-section
              page scroll). Left-aligned with a readable cap so wide screens use
              the horizontal space via nav+pane, not a centered narrow column. */}
          <div className="flex-1 min-h-0 overflow-y-auto">
            <div className="flex max-w-4xl flex-col gap-6 px-4 py-6 md:px-6">
              {loading ? (
                <div className="py-8 text-center text-sm text-muted-foreground">Loading configuration…</div>
              ) : (
                <>
              {/* Hosts & Connection */}
              <SettingsSection title="Hosts & Connection" className={cn(activeSection !== 'hosts' && 'hidden')}>
                {/* Host Management */}
                <div className="flex flex-col gap-2">
                  <Label>Configured Hosts</Label>
                  <div className="flex flex-wrap gap-2 min-h-10 p-2 rounded-md border bg-muted/30">
                    {config.hosts.length === 0 ? (
                      <span className="text-xs text-muted-foreground">No hosts configured</span>
                    ) : (
                      config.hosts.map((host) => (
                        <Badge
                          key={host}
                          variant="secondary"
                          className="cursor-pointer hover:bg-destructive/20"
                          onClick={() => removeHost(host)}
                          title="Click to remove"
                        >
                          {host} ×
                        </Badge>
                      ))
                    )}
                  </div>
                </div>

                {/* Add Host */}
                {availableHostsToAdd.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="addHost">Add Host</Label>
                    <Select
                      value=""
                      onValueChange={(v) => {
                        if (v) addHost(v);
                      }}
                    >
                      <SelectTrigger id="addHost" className="w-full">
                        <SelectValue placeholder="Select a host to add…" />
                      </SelectTrigger>
                      <SelectContent>
                        {availableHostsToAdd.map((host) => (
                          <SelectItem key={host} value={host}>
                            {host}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {/* Per-host display labels (WARDEN-490) — a friendly name for each
                    host shown wherever a host tag appears (sidebar rows, pane
                    header, Kill/Collision/Broadcast dialogs, Health dashboard,
                    token-budget offender line, etc.). Pure client-side: never
                    sent to the backend (it's a UiState pref, not config). Leave a
                    host blank to show its raw name. Covers this machine plus every
                    configured host; this machine is listed even though it isn't in
                    config.hosts (it's always implied). */}
                <div className="flex flex-col gap-2">
                  <Label>Display label per host</Label>
                  <p className="text-xs text-muted-foreground">
                    Give any host a friendly name (e.g. <code className="bg-muted px-1 rounded">CI runner</code>) shown wherever a host tag appears. Leave blank to show the raw host name. Local and remote alike. Stored on this machine only — never sent to the server.
                  </p>
                  <div className="flex flex-col gap-2 rounded-md border bg-muted/30 p-2">
                    {[{ key: THIS_MACHINE, label: 'this machine (local)' }, ...config.hosts.filter((h) => h !== THIS_MACHINE).map((h) => ({ key: h, label: h }))].map(({ key, label }) => {
                      const safeId = `hostLabel-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
                      return (
                        <div className="flex flex-col gap-1" key={`hostLabel-${key}`}>
                          <Label htmlFor={safeId} className="text-xs font-normal text-muted-foreground">{label}</Label>
                          <Input
                            id={safeId}
                            value={hostLabels[key] ?? ''}
                            onChange={(e) => setHostLabel(key, e.target.value)}
                            placeholder={`raw name (${key === THIS_MACHINE ? 'local' : key})`}
                            className="h-8"
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="pollIntervalMs">Dashboard Refresh Interval (ms)</Label>
                  <Input
                    id="pollIntervalMs"
                    type="number"
                    min="10000"
                    max="120000"
                    step="5000"
                    value={resolvePollIntervalMs(config.pollIntervalMs)}
                    onChange={(e) =>
                      setConfig({ ...config, pollIntervalMs: parseInt(e.target.value) || 1500 })
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    How often the dashboard auto-refreshes — re-pulls the chat catalog, re-checks engaged hosts for live status, and re-checks host connectivity. Range 10000–120000ms (10s–2min). The dashboard enforces a 10s minimum and reverts any smaller value (including the 1500ms CLI default) to 60s, so the value shown is the cadence you get. The CLI reads the raw value directly for its watch mode (default 1500ms). Backgrounded tabs still skip ticks.
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="tmuxSession">Tmux Session Name</Label>
                  <Input
                    id="tmuxSession"
                    value={config.tmuxSession}
                    onChange={(e) => setConfig({ ...config, tmuxSession: e.target.value })}
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="connectTimeout">Connect Timeout (seconds)</Label>
                  <Input
                    id="connectTimeout"
                    type="number"
                    min="1"
                    max="60"
                    value={config.connectTimeout}
                    onChange={(e) =>
                      setConfig({ ...config, connectTimeout: parseInt(e.target.value) || 10 })
                    }
                  />
                </div>
              </SettingsSection>

              {/* Observer Preferences */}
              <SettingsSection title="Observer Preferences" className={cn(activeSection !== 'observer' && 'hidden')}>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="observerConfirmMode">Directive Confirmation</Label>
                  <Select
                    value={config.observerConfirmMode}
                    onValueChange={(v) =>
                      setConfig({ ...config, observerConfirmMode: v as 'always' | 'auto-safe' })
                    }
                  >
                    <SelectTrigger id="observerConfirmMode" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="always">Always confirm (default)</SelectItem>
                      <SelectItem value="auto-safe">Auto-send safe directives</SelectItem>
                    </SelectContent>
                  </Select>
                  {config.observerConfirmMode === 'auto-safe' && (
                    <p className="text-xs text-muted-foreground">
                      When "Auto-send safe", read-only directives (list, read) skip confirmation.
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <Switch
                    id="observerAutoStart"
                    checked={config.observerAutoStart}
                    onCheckedChange={(v) => setConfig({ ...config, observerAutoStart: v })}
                  />
                  <Label htmlFor="observerAutoStart" className="cursor-pointer">
                    Auto-start Observer
                  </Label>
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="observerSessionTimeout">Session Auto-stop (minutes)</Label>
                  <Input
                    id="observerSessionTimeout"
                    type="number"
                    min="1"
                    max="180"
                    step="1"
                    value={config.observerSessionTimeout ?? ''}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        observerSessionTimeout: e.target.value ? parseInt(e.target.value) : null,
                      })
                    }
                    placeholder="Disabled when empty"
                  />
                  <p className="text-xs text-muted-foreground">
                    Automatically stop Observer after N minutes of inactivity. Leave empty to disable.
                  </p>
                </div>

                {/* Observer model/provider (WARDEN-350) — configure the Observer's
                    LLM from the UI instead of hand-editing ~/.yatfa-warden/config.json
                    or exporting shell env vars. Applies live: the next Observer call
                    re-reads model/baseUrl/token via llm.js's per-call resolvers and
                    reads maxTokens from the live cfg ref, with NO app restart. The
                    auth token is write-only (never seeded from GET; sent only when
                    typed so the stored secret survives an unchanged save). */}
                <div className="flex flex-col gap-3 rounded-md border bg-muted/30 p-3">
                  <div className="text-xs font-medium text-foreground">Observer model</div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="observerModel">Model</Label>
                    <Input
                      id="observerModel"
                      value={config.llm.model}
                      onChange={(e) => setConfig({ ...config, llm: { ...config.llm, model: e.target.value } })}
                      placeholder="glm-5.2"
                    />
                    <p className="text-xs text-muted-foreground">
                      The model id the Observer uses. A trailing context tag like <code className="bg-muted px-1 rounded">[1m]</code> is stripped automatically. Falls back to the WARDEN_MODEL env var, then the default (glm-5.2).
                    </p>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="observerBaseUrl">Base URL</Label>
                    <Input
                      id="observerBaseUrl"
                      value={config.llm.baseUrl}
                      onChange={(e) => setConfig({ ...config, llm: { ...config.llm, baseUrl: e.target.value } })}
                      placeholder="https://api.anthropic.com"
                    />
                    <p className="text-xs text-muted-foreground">
                      Anthropic-Messages-compatible endpoint. Leave blank for the default (https://api.anthropic.com) or an ANTHROPIC_BASE_URL env var.
                    </p>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="observerAuthToken">Auth token</Label>
                    <Input
                      id="observerAuthToken"
                      type="password"
                      value={observerAuthTokenInput}
                      onChange={(e) => setObserverAuthTokenInput(e.target.value)}
                      placeholder={observerAuthTokenSet ? `••••• set${observerAuthTokenTail ? ` (…${observerAuthTokenTail})` : ''}` : 'Not set'}
                    />
                    <p className="text-xs text-muted-foreground">
                      {observerAuthTokenSet
                        ? `A token is saved${observerAuthTokenTail ? ` (ends …${observerAuthTokenTail})` : ''}. Type a new one to replace it; leave blank to keep the saved token.`
                        : 'No token saved here. Enter one to authenticate the Observer, or leave blank to keep using env / config-file credentials.'}
                    </p>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="observerMaxTokens">Max output tokens</Label>
                    <Input
                      id="observerMaxTokens"
                      type="number"
                      min="1"
                      step="1"
                      value={config.llm.maxTokens ?? ''}
                      onChange={(e) => {
                        const n = parseInt(e.target.value, 10);
                        setConfig({ ...config, llm: { ...config.llm, maxTokens: e.target.value === '' || Number.isNaN(n) ? null : n } });
                      }}
                      placeholder="2048 (default)"
                    />
                    <p className="text-xs text-muted-foreground">
                      Maximum tokens the Observer model may generate per call. Leave empty for the default (2048).
                    </p>
                  </div>
                </div>
              </SettingsSection>

              {/* Safety */}
              <SettingsSection title="Safety" className={cn(activeSection !== 'safety' && 'hidden')}>
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="confirmDestructiveActions"
                      checked={config.confirmDestructiveActions}
                      onCheckedChange={(checked) =>
                        setConfig({ ...config, confirmDestructiveActions: checked === true })
                      }
                    />
                    <Label htmlFor="confirmDestructiveActions" className="cursor-pointer">
                      Confirm before destructive actions (force-kill, kill chat)
                    </Label>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    When on, force-killing a session and killing a chat ask for confirmation. Turn off for less friction.
                  </p>
                </div>
              </SettingsSection>

              {/* Attention thresholds (WARDEN-317) — configurable fleet-health
                  boundaries. The healthy→WARNING and warning→CRITICAL cutoffs
                  were previously hardcoded at 5 / 30 min in src/health.js. They
                  tune the same "needs attention" signal the Desktop alerts
                  preference (WARDEN-259) reacts to, so a human who checks hourly
                  can raise the critical boundary instead of being spammed at the
                  fixed 30-min mark. Empty falls back to the default (5 / 30). */}
              <SettingsSection title="Attention thresholds" className={cn(activeSection !== 'attention' && 'hidden')}>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="healthWarningThresholdMin">Warning after (minutes)</Label>
                  <Input
                    id="healthWarningThresholdMin"
                    type="number"
                    min="1"
                    step="1"
                    value={config.healthWarningThresholdMin ?? ''}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        healthWarningThresholdMin: e.target.value ? parseInt(e.target.value) : null,
                      })
                    }
                    onBlur={() => {
                      // WARDEN-374: keep the pair well-ordered (warning <= critical).
                      // On blur, clamp the warning down to the critical value when the
                      // human has entered a warning that exceeds it. Mirrors the backend
                      // PUT /api/config guard so the committed value matches what
                      // persists; the classifier clamps regardless (defense-in-depth),
                      // this just makes the relationship visible while editing.
                      const w = config.healthWarningThresholdMin;
                      const c = config.healthCriticalThresholdMin;
                      if (w != null && c != null && w > c) {
                        setConfig({ ...config, healthWarningThresholdMin: c });
                      }
                    }}
                    placeholder="Default 5"
                  />
                  <p className="text-xs text-muted-foreground">
                    Minutes of agent inactivity before it needs attention (warning state). Leave empty for the default (5).
                  </p>
                  {config.healthWarningThresholdMin != null &&
                    config.healthCriticalThresholdMin != null &&
                    config.healthWarningThresholdMin > config.healthCriticalThresholdMin && (
                      <p className="text-xs text-destructive">
                        Warning must come before Critical — capped to {config.healthCriticalThresholdMin} min on blur.
                      </p>
                    )}
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="healthCriticalThresholdMin">Critical after (minutes)</Label>
                  <Input
                    id="healthCriticalThresholdMin"
                    type="number"
                    min="1"
                    step="1"
                    value={config.healthCriticalThresholdMin ?? ''}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        healthCriticalThresholdMin: e.target.value ? parseInt(e.target.value) : null,
                      })
                    }
                    placeholder="Default 30"
                  />
                  <p className="text-xs text-muted-foreground">
                    Minutes of inactivity before an agent is critical and triggers a desktop alert. Leave empty for the default (30).
                  </p>
                </div>
              </SettingsSection>

              {/* Token budget (WARDEN-415) — the ALARM that completes the
                  WARDEN-367 token meter. When enabled, Warden watches the
                  fleet's token spend on a slow (~120s) cadence and raises a
                  desktop alert + in-app toast when it crosses a threshold —
                  routing attention to a runaway/looping agent's cost while the
                  founder is away. Fully human-in-the-loop: it NOTIFY, it never
                  auto-kills/stops. Disabled by default. */}
              <SettingsSection title="Token budget" className={cn(activeSection !== 'tokenbudget' && 'hidden')}>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="tokenBudgetEnabled"
                    checked={config.tokenBudgetEnabled ?? false}
                    onCheckedChange={(checked) =>
                      setConfig({ ...config, tokenBudgetEnabled: checked === true })
                    }
                  />
                  <Label htmlFor="tokenBudgetEnabled" className="cursor-pointer">
                    Enable token-spend budget alerts
                  </Label>
                </div>
                <p className="text-xs text-muted-foreground">
                  Watch the fleet's token usage on a slow cadence and raise a desktop alert + in-app
                  toast when spend crosses a threshold — so a runaway or looping agent's cost is
                  caught while you're away. Model-agnostic token counts, not dollar cost. It only
                  notifies; it never kills or pauses agents.
                </p>
                <div className={cn('flex flex-col gap-4 pl-4 ml-1 border-l border-border/60', !config.tokenBudgetEnabled && 'pointer-events-none opacity-50')}>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="tokenBudgetThresholdTokens">Fleet threshold (tokens)</Label>
                    <Input
                      id="tokenBudgetThresholdTokens"
                      type="number"
                      min="1"
                      step="100000"
                      value={config.tokenBudgetThresholdTokens ?? ''}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          tokenBudgetThresholdTokens: e.target.value ? parseInt(e.target.value) : null,
                        })
                      }
                      placeholder="Default 2,000,000"
                    />
                    <p className="text-xs text-muted-foreground">
                      Total tokens spent by sessions active in the window before the fleet alarm
                      fires. Leave empty for the default (2,000,000).
                    </p>
                  </div>

                  <div className="flex flex-col gap-2">
                    <Label htmlFor="tokenBudgetWindowHours">Window (hours)</Label>
                    <Input
                      id="tokenBudgetWindowHours"
                      type="number"
                      min="1"
                      step="1"
                      value={config.tokenBudgetWindowHours ?? ''}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          tokenBudgetWindowHours: e.target.value ? parseInt(e.target.value) : null,
                        })
                      }
                      placeholder="Default 24"
                    />
                    <p className="text-xs text-muted-foreground">
                      Which sessions count: those active in the last N hours. Each contributes its
                      full lifetime token total (the existing meter), not just turns within the
                      window — so a runaway that's burning tokens right now is captured. Default 24.
                    </p>
                  </div>

                  <div className="flex flex-col gap-2">
                    <Label htmlFor="tokenBudgetPerSessionThresholdTokens">Per-session threshold (tokens)</Label>
                    <Input
                      id="tokenBudgetPerSessionThresholdTokens"
                      type="number"
                      min="1"
                      step="100000"
                      value={config.tokenBudgetPerSessionThresholdTokens ?? ''}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          tokenBudgetPerSessionThresholdTokens: e.target.value ? parseInt(e.target.value) : null,
                        })
                      }
                      placeholder="Default 1,000,000"
                    />
                    <p className="text-xs text-muted-foreground">
                      Catch the specific runaway: when any single session's lifetime total crosses
                      this, Warden names it in the alert. Empty disables the per-session alarm
                      (the fleet threshold still applies). Default 1,000,000.
                    </p>
                  </div>
                </div>
              </SettingsSection>

              {/* Performance — WARDEN-439. The companion transport collapses the
                  per-op SSH handshake on remote hosts into one persistent RPC
                  channel, the biggest lever for cutting ssh-process churn on a
                  remote-heavy fleet. Experimental; remote-only by design (local
                  hosts are unaffected). Default OFF. */}
              <SettingsSection title="Performance" className={cn(activeSection !== 'performance' && 'hidden')}>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="companionTransportEnabled"
                    checked={config.companionTransportEnabled ?? false}
                    disabled={config.companionTransportOverridden}
                    onCheckedChange={(checked) =>
                      setConfig({ ...config, companionTransportEnabled: checked === true })
                    }
                  />
                  <Label
                    htmlFor="companionTransportEnabled"
                    className={cn('cursor-pointer', config.companionTransportOverridden && 'cursor-not-allowed opacity-60')}
                  >
                    Companion transport <Badge variant="secondary">experimental</Badge>
                  </Label>
                </div>
                <p className="text-xs text-muted-foreground">
                  Route remote tmux ops (discover, capture, spawn, kill, liveness, resize) through a
                  single persistent SSH channel instead of a fresh ssh process per operation — so the
                  per-op ssh process count on remote hosts drops to near zero. Takes effect on the next
                  operation. Local hosts are unaffected (remote-only by design).
                </p>
                {config.companionTransportOverridden && (
                  <p className="text-xs text-muted-foreground">
                    <Badge variant="outline">env override</Badge>{' '}
                    The <code className="text-[11px]">WARDEN_COMPANION_TRANSPORT</code> environment
                    variable is set, so it overrides this toggle — the on/off state above is inert.
                    Unset the variable and restart Warden to control it here.
                  </p>
                )}
              </SettingsSection>

              {/* Telemetry — optional, OFF by default, two consent tiers (WARDEN-457).
                  No first-run prompt: consent lives here in Settings, both tiers
                  default OFF, and nothing is sent in this build. Extended is
                  gated behind base in the UI (disabled until base on) AND clamped
                  again by the server on save. */}
              <SettingsSection title="Telemetry" className={cn(activeSection !== 'telemetry' && 'hidden')}>
                <p className="text-xs text-muted-foreground">
                  Optional, off by default. Help improve warden by sending
                  anonymous diagnostics. Nothing is sent until you turn a tier on,
                  and the destination is a self-hosted receiver — no third-party
                  analytics service. You can revoke either tier at any time.
                </p>

                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Switch
                      id="telemetryBaseEnabled"
                      checked={config.telemetryBaseEnabled}
                      onCheckedChange={(v) =>
                        setConfig({
                          ...config,
                          telemetryBaseEnabled: v,
                          // Turning base off also revokes extended
                          // (extended-requires-base). The server re-clamps on
                          // save; this keeps the toggle honest in the meantime.
                          telemetryExtendedEnabled: v && config.telemetryExtendedEnabled,
                        })
                      }
                    />
                    <Label htmlFor="telemetryBaseEnabled" className="cursor-pointer">
                      Anonymous errors, crashes &amp; freezes
                    </Label>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Base tier. Anonymous error, crash, and event-loop-freeze
                    reports — no chat content, no file paths, no hostnames, no
                    credentials.
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Switch
                      id="telemetryExtendedEnabled"
                      checked={config.telemetryExtendedEnabled}
                      disabled={!config.telemetryBaseEnabled}
                      onCheckedChange={(v) =>
                        // Disabled while base is off, so a toggle only arrives
                        // with base on. Guard anyway: extended requires base.
                        setConfig({ ...config, telemetryExtendedEnabled: v && config.telemetryBaseEnabled })
                      }
                    />
                    <Label htmlFor="telemetryExtendedEnabled" className="cursor-pointer">
                      Also include chat &amp; session names
                    </Label>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Extended tier (requires the base tier). Additionally includes
                    chat names and Claude session names to help diagnose reports.
                    Chat <em>content</em> is never sent — names only.
                  </p>
                </div>

                {/* WARDEN-557 — honest sending status. A pure derived view of
                    config.telemetryBaseEnabled × config.telemetryEndpoint
                    (see TelemetrySendingStatus above). Placed here, directly
                    above the endpoint field, so the cause (blank endpoint)
                    and the consequence (nothing sent) read together. Reads the
                    same `config` the toggles/field mutate via setConfig, so it
                    updates live with no stale-closure / shadow state. */}
                <TelemetrySendingStatus
                  baseEnabled={config.telemetryBaseEnabled}
                  endpoint={config.telemetryEndpoint}
                />

                <div className="flex flex-col gap-2">
                  <Label htmlFor="telemetryEndpoint">Receiver endpoint</Label>
                  <Input
                    id="telemetryEndpoint"
                    value={config.telemetryEndpoint}
                    onChange={(e) => setConfig({ ...config, telemetryEndpoint: e.target.value })}
                    placeholder="https://your-receiver.example/ingest"
                  />
                  <p className="text-xs text-muted-foreground">
                    Leave blank for unconfigured (sends nothing). Events go only to this URL — a self-hosted receiver you control, never a third-party analytics service.
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="telemetryAuthToken">Receiver auth token (optional)</Label>
                  <Input
                    id="telemetryAuthToken"
                    type="password"
                    value={telemetryAuthTokenInput}
                    onChange={(e) => setTelemetryAuthTokenInput(e.target.value)}
                    placeholder={telemetryAuthTokenSet ? `••••• set${telemetryAuthTokenTail ? ` (…${telemetryAuthTokenTail})` : ''}` : 'Not set'}
                  />
                  <p className="text-xs text-muted-foreground">
                    {telemetryAuthTokenSet
                      ? `A token is saved${telemetryAuthTokenTail ? ` (ends …${telemetryAuthTokenTail})` : ''}. It is sent as Authorization: Bearer so a receiver that requires auth (AUTH_TOKEN) accepts your events. Type a new one to replace it; leave blank to keep it.`
                      : 'Optional. Sent as Authorization: Bearer when your receiver is gated by a shared secret (AUTH_TOKEN). Leave blank if your receiver runs open.'}
                  </p>
                </div>

                {/* WARDEN-526 — read-only "What telemetry sends" verifiability
                    panel. Renders WARDEN-508's describeCollection (per-tier
                    collection catalog) + previewPayload (exact redacted payload
                    of a sample event) so an opt-in user can inspect precisely
                    what is transmitted. Pure functions, no transport, no new
                    consent flag; read-only. Placed last in the section so the
                    flow reads: consent toggles → endpoint → inspect payload. */}
                <TelemetryTransparency
                  telemetryBaseEnabled={config.telemetryBaseEnabled}
                  telemetryExtendedEnabled={config.telemetryExtendedEnabled}
                />
              </SettingsSection>

              {/* Display */}
              <SettingsSection title="Display" className={cn(activeSection !== 'display' && 'hidden')}>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="showHostTags"
                    checked={config.showHostTags ?? true}
                    onCheckedChange={(checked) =>
                      setConfig({ ...config, showHostTags: checked === true })
                    }
                  />
                  <Label htmlFor="showHostTags" className="cursor-pointer">
                    Show host tags (local/hostname badges)
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="showTypeBadges"
                    checked={config.showTypeBadges ?? true}
                    onCheckedChange={(checked) =>
                      setConfig({ ...config, showTypeBadges: checked === true })
                    }
                  />
                  <Label htmlFor="showTypeBadges" className="cursor-pointer">
                    Show type badges (shell/claude/yatfa labels)
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="showStatusIndicators"
                    checked={config.showStatusIndicators ?? true}
                    onCheckedChange={(checked) =>
                      setConfig({ ...config, showStatusIndicators: checked === true })
                    }
                  />
                  <Label htmlFor="showStatusIndicators" className="cursor-pointer">
                    Show status indicators (active/idle/dead dots)
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="showProjectBadges"
                    checked={config.showProjectBadges ?? false}
                    onCheckedChange={(checked) =>
                      setConfig({ ...config, showProjectBadges: checked === true })
                    }
                  />
                  <Label htmlFor="showProjectBadges" className="cursor-pointer">
                    Show project badges
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="hideOfflineHosts"
                    checked={config.hideOfflineHosts ?? false}
                    onCheckedChange={(checked) =>
                      setConfig({ ...config, hideOfflineHosts: checked === true })
                    }
                  />
                  <Label htmlFor="hideOfflineHosts" className="cursor-pointer">
                    Hide offline hosts (collapse into an expandable summary)
                  </Label>
                </div>
              </SettingsSection>

              {/* Appearance — client-side look preferences */}
              <SettingsSection title="Appearance" className={cn(activeSection !== 'appearance' && 'hidden')}>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="terminalFontSize">Terminal font size</Label>
                  <Input
                    id="terminalFontSize"
                    type="number"
                    min="8"
                    max="24"
                    step="1"
                    value={terminalFontSize}
                    onChange={(e) => setTerminalFontSize(parseInt(e.target.value, 10) || 14)}
                    onBlur={(e) => {
                      const n = parseInt(e.target.value, 10);
                      setTerminalFontSize(Number.isNaN(n) ? 14 : Math.max(8, Math.min(24, n)));
                    }}
                  />
                  <p className="text-xs text-muted-foreground">
                    Applies to all terminal panes (8–24). Use the A− / A+ buttons on any pane to adjust the same value.
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="terminalFontFamily">Terminal font family</Label>
                  <Select
                    value={fontSelectValue}
                    onValueChange={(v) => {
                      if (v === CUSTOM_FONT_VALUE) {
                        setCustomFontMode(true);
                        // Seed the field with the current custom value, or blank
                        // when switching from a curated font (effective font
                        // stays put until the user types something new).
                        setCustomFontText(matchedCurated ? '' : terminalFontFamily);
                      } else {
                        setCustomFontMode(false);
                        setCustomFontText('');
                        setTerminalFontFamily(v);
                      }
                    }}
                  >
                    <SelectTrigger id="terminalFontFamily" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TERMINAL_FONT_OPTIONS.map((f) => (
                        <SelectItem key={f.label} value={f.value}>{f.label}</SelectItem>
                      ))}
                      <SelectItem value={CUSTOM_FONT_VALUE}>Custom…</SelectItem>
                    </SelectContent>
                  </Select>
                  {customFontMode && (
                    <Input
                      aria-label="Custom terminal font family"
                      value={customFontText}
                      onChange={(e) => {
                        const v = e.target.value;
                        setCustomFontText(v);
                        // A blank custom value falls back to the default stack
                        // (never a blank pane); we stay in custom mode so the
                        // field keeps showing while editing.
                        setTerminalFontFamily(v.trim() === '' ? DEFAULT_TERMINAL_FONT_FAMILY : v);
                      }}
                      placeholder='e.g. "Hack Nerd Font", ui-monospace, monospace'
                    />
                  )}
                  <p className="text-xs text-muted-foreground">
                    Monospace font for all agent panes. Pick a common font, or choose <strong>Custom…</strong> to paste any installed CSS font-family (e.g. a Nerd Font for glyphs). Applies live to open panes; blank reverts to the system default.
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="terminalScrollback">Terminal scrollback (lines)</Label>
                  <Input
                    id="terminalScrollback"
                    type="number"
                    min="100"
                    max="100000"
                    step="100"
                    value={terminalScrollback}
                    onChange={(e) => setTerminalScrollback(parseInt(e.target.value, 10) || 10000)}
                    onBlur={(e) => {
                      const n = parseInt(e.target.value, 10);
                      setTerminalScrollback(Number.isNaN(n) ? 10000 : Math.max(100, Math.min(100000, n)));
                    }}
                  />
                  <p className="text-xs text-muted-foreground">
                    Maximum lines each terminal pane keeps in memory (100–100000). Applies to new panes; existing panes pick up the change when reopened. Default 10000.
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="theme">Theme</Label>
                  <Select value={theme} onValueChange={(v) => setTheme(v as Theme)}>
                    <SelectTrigger id="theme" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="system">System (follow OS)</SelectItem>
                      <SelectGroup>
                        <SelectLabel>Light</SelectLabel>
                        {THEMES.filter((t) => t.mode === 'light').map((t) => (
                          <SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>
                        ))}
                      </SelectGroup>
                      <SelectGroup>
                        <SelectLabel>Dark</SelectLabel>
                        {THEMES.filter((t) => t.mode === 'dark').map((t) => (
                          <SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    A complete color theme for the whole app and every terminal pane. "System" follows your OS (GitHub Light ↔ GitHub Dark); any named theme applies live and is remembered across reloads.
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="terminalColorScheme">Terminal color scheme</Label>
                  <Select value={terminalColorScheme} onValueChange={(v) => setTerminalColorScheme(v as TerminalColorScheme)}>
                    <SelectTrigger id="terminalColorScheme" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">Match app theme (default)</SelectItem>
                      <SelectItem value="dark">Always dark</SelectItem>
                      <SelectItem value="light">Always light</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    How terminal panes are colored. "Match app theme" follows the Theme above (including System); "Always dark/light" forces the terminal to GitHub Dark / GitHub Light regardless of the rest of the UI. Applies live to open panes.
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="terminalCursorStyle">Terminal cursor style</Label>
                  <Select value={terminalCursorStyle} onValueChange={(v) => setTerminalCursorStyle(v as TerminalCursorStyle)}>
                    <SelectTrigger id="terminalCursorStyle" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="blink-block">Blinking block (default)</SelectItem>
                      <SelectItem value="steady-block">Steady block</SelectItem>
                      <SelectItem value="blink-underline">Blinking underline</SelectItem>
                      <SelectItem value="steady-underline">Steady underline</SelectItem>
                      <SelectItem value="blink-bar">Blinking bar</SelectItem>
                      <SelectItem value="steady-bar">Steady bar</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Cursor shape and whether it blinks in terminal panes. "Steady" options stop the blink — useful if you reduce motion at the OS level (WARDEN-190 only covered page motion, not this cursor). Applies live to all open panes.
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Switch
                      id="copyOnSelect"
                      checked={copyOnSelect}
                      onCheckedChange={setCopyOnSelect}
                    />
                    <Label htmlFor="copyOnSelect" className="cursor-pointer">
                      Copy on select
                    </Label>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Copy agent output to the clipboard as soon as you select it (off by default). Mirrors select-to-copy in iTerm2/GNOME-Terminal/Windows Terminal — no Ctrl/Cmd+C needed. Applies live to all open panes.
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="density">Density</Label>
                  <Select value={density} onValueChange={(v) => setDensity(v as Density)}>
                    <SelectTrigger id="density" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="comfortable">Comfortable (default)</SelectItem>
                      <SelectItem value="compact">Compact</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    "Compact" tightens row and header spacing so more agents fit on screen. Applies instantly and is remembered across reloads.
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="timestampFormat">Timestamp format</Label>
                  <Select value={timestampFormat} onValueChange={(v) => setTimestampFormat(v as TimestampFormat)}>
                    <SelectTrigger id="timestampFormat" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="relative">Relative (default)</SelectItem>
                      <SelectItem value="absolute">Absolute</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    How times read across the dashboard. "Relative" shows compact buckets like "2m ago"; "Absolute" shows clock time like "2:13 PM". Applies instantly to every timestamp and is remembered across reloads.
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="paneLayout">Pane layout</Label>
                  <Select value={paneLayout} onValueChange={(v) => setPaneLayout(v as PaneLayout)}>
                    <SelectTrigger id="paneLayout" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">Auto grid (default)</SelectItem>
                      <SelectItem value="stacked">Stacked (single column)</SelectItem>
                      <SelectItem value="side-by-side">Side-by-side (single row)</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Controls how open agent panes are arranged. "Auto grid" splits them into a near-square grid, "Stacked" stacks them in one full-width column, and "Side-by-side" lays them out in a single row. Applies instantly and is remembered across reloads.
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="onExitBehavior">When an agent exits</Label>
                  <Select value={onExitBehavior} onValueChange={(v) => setOnExitBehavior(v as OnExitBehavior)}>
                    <SelectTrigger id="onExitBehavior" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="keep">Keep pane (default)</SelectItem>
                      <SelectItem value="dim">Dim pane</SelectItem>
                      <SelectItem value="auto-close">Auto-close pane</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    What happens to an already-open pane when its agent process exits. "Keep pane" leaves it for you to close manually; "Dim pane" marks it exited while keeping the last output readable; "Auto-close pane" removes it for you. Applies only to panes whose agent was running — a pane that never started is left alone. Applies globally and is remembered across reloads.
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Switch
                      id="autoFocusNewPane"
                      checked={autoFocusNewPane}
                      onCheckedChange={(v) => setAutoFocusNewPane(v)}
                    />
                    <Label htmlFor="autoFocusNewPane" className="cursor-pointer">
                      Auto-focus pane on open
                    </Label>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    When on, opening, resuming, or splitting a chat moves keyboard focus to the new pane. Turn off to keep typing where you are — click any pane to focus it instead. Applies globally and is remembered across reloads.
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="restoreOnStartup">Restore workspace on startup</Label>
                  <Select
                    value={restoreOnStartup}
                    onValueChange={(v) => setRestoreOnStartup(v as RestoreOnStartup)}
                  >
                    <SelectTrigger id="restoreOnStartup" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="previous">Reopen previous (default)</SelectItem>
                      <SelectItem value="empty">Start empty</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Reopen the tabs and panes you had open at last close, or start every launch with a clean workspace.
                  </p>
                </div>

                {/* Remember window bounds — main-owned via IPC (WARDEN-263). Sits
                    beside the sibling "Restore workspace on startup" control: both
                    govern what a fresh launch looks like (contents vs. container).
                    Disabled with a hint when the preload bridge is absent (browser
                    / smoke test) — the same web bundle runs in all contexts. */}
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Switch
                      id="rememberWindowBounds"
                      checked={rememberWindowBounds}
                      onCheckedChange={(v) => setRememberWindowBounds(v)}
                      disabled={!hasWindowBridge()}
                    />
                    <Label htmlFor="rememberWindowBounds" className="cursor-pointer">
                      Remember window position and size
                    </Label>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {hasWindowBridge()
                      ? 'Reopen the window at the same size, position, and maximize state as last time. Turn off to always start at the default size.'
                      : 'Reopen the window at the same size, position, and maximize state as last time. Applies to the desktop app only.'}
                  </p>
                </div>

                {/* Launch Warden at login — main-owned via IPC (WARDEN-278). Sits
                    beside the remember-bounds control: both govern launch
                    behavior. Off by default (consent — auto-start modifies the
                    OS login items). Same hasWindowBridge() gating as
                    remember-bounds so dev/smoke are unaffected. */}
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Switch
                      id="launchAtLogin"
                      checked={launchAtLogin}
                      onCheckedChange={(v) => setLaunchAtLogin(v)}
                      disabled={!hasWindowBridge()}
                    />
                    <Label htmlFor="launchAtLogin" className="cursor-pointer">
                      Launch Warden at login
                    </Label>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {hasWindowBridge()
                      ? 'Open Warden automatically when you log in to your computer. Off by default — turn it on to skip relaunching Warden after every reboot.'
                      : 'Open Warden automatically when you log in to your computer. Applies to the desktop app only.'}
                  </p>
                </div>

                {/* Close to tray — main-owned via IPC (WARDEN-330). Sits beside
                    the launch-at-login control: both govern close/launch
                    behavior. Off by default (opt-in — changing what the close
                    button does is surprising). When ON, the backend and desktop
                    attention alerts keep running while the window is hidden, so
                    it pairs naturally with launch-at-login + desktop alerts.
                    Same hasWindowBridge() gating as the sibling controls. */}
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Switch
                      id="closeToTray"
                      checked={closeToTray}
                      onCheckedChange={(v) => setCloseToTray(v)}
                      disabled={!hasWindowBridge()}
                    />
                    <Label htmlFor="closeToTray" className="cursor-pointer">
                      Close to tray
                    </Label>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {hasWindowBridge()
                      ? 'Keep Warden running in the system tray when you close the window — the backend and desktop alerts stay active. Click the tray icon to show the window, or use its menu to quit.'
                      : 'Keep Warden running in the system tray when you close the window. Applies to the desktop app only.'}
                  </p>
                </div>
              </SettingsSection>

              {/* New Chats — client-side default agent type + host for the ＋ new spawn form */}
              <SettingsSection title="New Chats" className={cn(activeSection !== 'newchats' && 'hidden')}>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="defaultNewChatPreset">Default agent type</Label>
                  <Select
                    value={defaultNewChatPreset}
                    onValueChange={(v) => setDefaultNewChatPreset(v)}
                  >
                    <SelectTrigger id="defaultNewChatPreset" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="claude">claude (default)</SelectItem>
                      <SelectItem value="shell">shell</SelectItem>
                      {customPresets.map((p) => (
                        <SelectItem key={p.name} value={p.name}>
                          {p.name}
                        </SelectItem>
                      ))}
                      {/* A default naming a since-deleted preset must never leave
                          an empty trigger — render it visibly but disabled so the
                          user sees it's gone. Mirrors the default-host fallback. */}
                      {defaultNewChatPreset !== 'claude' &&
                        defaultNewChatPreset !== 'shell' &&
                        !customPresets.some((p) => p.name === defaultNewChatPreset) && (
                          <SelectItem value={defaultNewChatPreset} disabled>
                            {defaultNewChatPreset} (deleted)
                          </SelectItem>
                        )}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Which command preset the ＋ new chat form starts with. Define your own below (e.g. codex, gemini, a wrapper script).
                  </p>
                </div>

                {/* Custom spawn presets — create / rename / delete. Pure client-side. */}
                <div className="flex flex-col gap-2">
                  <Label>Custom presets</Label>
                  {customPresets.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No custom presets yet. Add one to turn any agent command into a one-click spawn button.
                    </p>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {customPresets.map((p) => (
                        <PresetRow
                          key={p.name}
                          preset={p}
                          isDefault={defaultNewChatPreset === p.name}
                          onRename={renamePreset}
                          onCmdChange={updatePresetCmd}
                          onDelete={deletePreset}
                        />
                      ))}
                    </div>
                  )}

                  {/* Add a new preset */}
                  <div className="flex flex-col gap-1 rounded-md border bg-muted/30 p-2">
                    <Input
                      value={newPresetName}
                      onChange={(e) => setNewPresetName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          addPreset();
                        }
                      }}
                      className="h-8"
                      placeholder="name (e.g. codex)"
                      aria-label="New preset name"
                      maxLength={PRESET_NAME_MAX}
                    />
                    <Input
                      value={newPresetCmd}
                      onChange={(e) => setNewPresetCmd(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          addPreset();
                        }
                      }}
                      className="h-8"
                      placeholder="command (e.g. codex)"
                      aria-label="New preset command"
                    />
                    <Button variant="outline" size="sm" className="w-full" onClick={addPreset}>
                      Add preset
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Custom presets appear as one-click buttons in the ＋ new chat form and can be set as the default above. Names can't reuse the built-ins claude/shell.
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="defaultNewChatHost">Default host</Label>
                  <Select value={defaultNewChatHost} onValueChange={(v) => setDefaultNewChatHost(v)}>
                    <SelectTrigger id="defaultNewChatHost" className="w-full">
                      <SelectValue placeholder="this machine (local)" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="(local)">this machine (local)</SelectItem>
                      {availableHosts.map((h) => (
                        <SelectItem key={h} value={h}>
                          {h}
                        </SelectItem>
                      ))}
                      {/* A stored default host that's no longer detected must never leave
                          an empty/dangling trigger — render it visibly but disabled so the
                          user sees it's gone and can pick a new default. Mirrors the
                          "never empty" rule NewChatForm enforces at open time. */}
                      {defaultNewChatHost !== '(local)' && !availableHosts.includes(defaultNewChatHost) && (
                        <SelectItem value={defaultNewChatHost} disabled>
                          {defaultNewChatHost} (no longer available)
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Where new chats spawn by default. Detected SSH hosts appear here; a default host no longer available is shown disabled here and falls back to local at spawn time.
                  </p>
                </div>

                {/* Default shell (WARDEN-429): the single shell preference governing
                    BOTH the ＋ new-chat *shell* preset and the ＋ split button. Blank
                    (default) = the host's own login shell (auto-detected per host;
                    never hardcoded — a zsh-login host yields zsh out of the box), so
                    an unconfigured user gets the right shell with zero config. A
                    non-empty value (e.g. zsh/fish/pwsh) is used everywhere, overridable
                    per host below. Supersedes the prior split-only "Default split
                    shell" (folded in on load) and the hardcoded 'bash' the new-chat
                    shell preset used to force-feed. */}
                <div className="flex flex-col gap-2">
                  <Label htmlFor="defaultShell">Default shell (fallback for any host without its own)</Label>
                  <Input
                    id="defaultShell"
                    value={defaultShell}
                    onChange={(e) => setDefaultShell(e.target.value)}
                    placeholder="auto (host login shell)"
                  />
                  <p className="text-xs text-muted-foreground">
                    Shell opened by the ＋ new-chat <em>shell</em> preset and the ＋ split button. Enter a name like <code className="bg-muted px-1 rounded">zsh</code> or <code className="bg-muted px-1 rounded">fish</code>; leave blank to use each host's default login shell (the out-of-the-box behavior). Set a per-host override below to use a different shell on a specific host.
                  </p>
                </div>

                {/* Per-host default-shell overrides (WARDEN-429 — the shell mirror of
                    the per-host cwd block below). A shell is host-specific (zsh on a
                    mac, fish on a Linux box), so a single global default breaks the
                    moment there is a second host. Leave a host blank to inherit the
                    global default above (then the host's login shell). Keys are the
                    same host strings the spawn form uses ('(local)' / SSH host). */}
                <div className="flex flex-col gap-2">
                  <Label>Default shell per host</Label>
                  <p className="text-xs text-muted-foreground">
                    Override the default shell for a specific host. Leave a host blank to use the global default above (or the host's login shell).
                  </p>
                  <div className="flex flex-col gap-2 rounded-md border bg-muted/30 p-2">
                    {[{ key: '(local)', label: 'this machine (local)' }, ...availableHosts.map((h) => ({ key: h, label: h }))].map(({ key, label }) => {
                      const safeId = `defaultShellByHost-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
                      return (
                        <div className="flex flex-col gap-1" key={`shellByHost-${key}`}>
                          <Label htmlFor={safeId} className="text-xs font-normal text-muted-foreground">{label}</Label>
                          <Input
                            id={safeId}
                            value={defaultShellByHost[key] ?? ''}
                            onChange={(e) => setHostShell(key, e.target.value)}
                            placeholder="auto (host login shell)"
                            className="h-8"
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Default working directory (WARDEN-311): the GLOBAL cwd fallback
                    pre-filled in the ＋ new chat spawn form. Blank → the host's
                    home directory (today's behavior); the seeded value is still
                    editable per-spawn in the form. WARDEN-336 adds per-host
                    overrides below — a host with its own value wins over this. */}
                <div className="flex flex-col gap-2">
                  <Label htmlFor="defaultNewChatCwd">Default working directory (fallback for any host without its own)</Label>
                  <Input
                    id="defaultNewChatCwd"
                    value={defaultNewChatCwd}
                    onChange={(e) => setDefaultNewChatCwd(e.target.value)}
                    placeholder="auto (home directory)"
                  />
                  <p className="text-xs text-muted-foreground">
                    Working directory pre-filled in the ＋ new chat spawn form. Enter a path like <code className="bg-muted px-1 rounded">~/projects/warden</code>; leave blank to start each chat in the host's home directory (today's behavior). Editable per-spawn. Set a per-host override below to use a different directory on a specific host.
                  </p>
                </div>

                {/* Per-host agent-type (preset) overrides (WARDEN-352 — the preset
                    mirror of the per-host cwd block below). Just like a cwd path,
                    the agent you run is host-specific: claude locally but codex
                    (or a wrapper) on a remote GPU box. Leave a host on "Use global
                    default" to inherit the default agent type above. Keys are the
                    same host strings the spawn form uses ('(local)' / SSH host). */}
                <div className="flex flex-col gap-2">
                  <Label>Agent type per host</Label>
                  <p className="text-xs text-muted-foreground">
                    Override the default agent type for a specific host when spawning. Leave a host on “Use global default” to use the default agent type above.
                  </p>
                  <div className="flex flex-col gap-2 rounded-md border bg-muted/30 p-2">
                    {[{ key: '(local)', label: 'this machine (local)' }, ...availableHosts.map((h) => ({ key: h, label: h }))].map(({ key, label }) => {
                      // Radix Select forbids an empty-string item value, so
                      // "inherit global" is a sentinel option mapped to a blank
                      // (deleted) entry by setHostPreset — a cleared row means
                      // "inherit the global default", never a persisted blank.
                      const INHERIT = '__inherit_global__';
                      const saved = defaultNewChatPresetByHost[key];
                      const hasOverride = typeof saved === 'string' && saved.trim() !== '';
                      const validOverride = hasOverride && (saved === 'claude' || saved === 'shell' || customPresets.some((p) => p.name === saved));
                      return (
                        <div className="flex flex-col gap-1" key={`presetByHost-${key}`}>
                          <Label className="text-xs font-normal text-muted-foreground">{label}</Label>
                          <Select value={hasOverride ? saved : INHERIT} onValueChange={(v) => setHostPreset(key, v === INHERIT ? '' : v)}>
                            <SelectTrigger className="h-8 w-full">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={INHERIT}>Use global default</SelectItem>
                              <SelectItem value="claude">claude</SelectItem>
                              <SelectItem value="shell">shell</SelectItem>
                              {customPresets.map((p) => (
                                <SelectItem key={p.name} value={p.name}>
                                  {p.name}
                                </SelectItem>
                              ))}
                              {/* A saved value naming a since-deleted preset
                                  (only reachable via direct localStorage
                                  tampering — the load sanitizer + the rename/
                                  delete propagation above keep the live map
                                  valid) must never leave an empty trigger;
                                  render it visibly but disabled, mirroring the
                                  global preset Select's "(deleted)" item. */}
                              {hasOverride && !validOverride && (
                                <SelectItem value={saved} disabled>
                                  {saved} (deleted)
                                </SelectItem>
                              )}
                            </SelectContent>
                          </Select>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Per-host working directory overrides (WARDEN-336): one input per
                    configured host. A filesystem path is inherently host-specific,
                    so a single global cwd breaks the moment there is a second host.
                    Leave a host blank to inherit the global default above. Keys are
                    the same host strings the spawn form uses ('(local)' / SSH host). */}
                <div className="flex flex-col gap-2">
                  <Label>Working directory per host</Label>
                  <p className="text-xs text-muted-foreground">
                    Override the default working directory for a specific host when spawning. Leave a host blank to use the global default above.
                  </p>
                  <div className="flex flex-col gap-2 rounded-md border bg-muted/30 p-2">
                    {[{ key: '(local)', label: 'this machine (local)' }, ...availableHosts.map((h) => ({ key: h, label: h }))].map(({ key, label }) => {
                      const safeId = `defaultNewChatCwdByHost-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
                      return (
                        <div className="flex flex-col gap-1" key={`cwdByHost-${key}`}>
                          <Label htmlFor={safeId} className="text-xs font-normal text-muted-foreground">{label}</Label>
                          <Input
                            id={safeId}
                            value={defaultNewChatCwdByHost[key] ?? ''}
                            onChange={(e) => setHostCwd(key, e.target.value)}
                            placeholder="auto (home directory)"
                            className="h-8"
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              </SettingsSection>

              {/* Instruction snippets (WARDEN-323): a named, reusable intervention
                  library surfaced at the Broadcast dialog (insert-only) and a
                  focused pane's context menu (one-click send). Pure client-side;
                  the starter set ships as ordinary editable entries. */}
              <SettingsSection title="Instruction snippets" className={cn(activeSection !== 'snippets' && 'hidden')}>
                <p className="text-xs text-muted-foreground">
                  Save instructions you send often ("run the tests", "pull latest", "commit your work") and reuse them from the Broadcast dialog or a pane's right-click menu. New installs start with a few examples you can edit or delete.
                </p>
                <div className="flex flex-col gap-2">
                  {snippets.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No snippets yet. Add one to reuse common instructions like 'run the tests' across your fleet.
                    </p>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {snippets.map((s) => (
                        <SnippetRow
                          key={s.name}
                          snippet={s}
                          onRename={renameSnippet}
                          onTextChange={updateSnippetText}
                          onDelete={deleteSnippet}
                        />
                      ))}
                    </div>
                  )}

                  {/* Add a new snippet */}
                  <div className="flex flex-col gap-1 rounded-md border bg-muted/30 p-2">
                    <Input
                      value={newSnippetName}
                      onChange={(e) => setNewSnippetName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          addSnippet();
                        }
                      }}
                      className="h-8"
                      placeholder="name (e.g. Run tests)"
                      aria-label="New snippet name"
                      maxLength={SNIPPET_NAME_MAX}
                    />
                    <Textarea
                      value={newSnippetText}
                      onChange={(e) => setNewSnippetText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          addSnippet();
                        }
                      }}
                      className="min-h-[60px] text-sm"
                      placeholder="instruction (e.g. run the test suite)"
                      aria-label="New snippet instruction text"
                      maxLength={SNIPPET_TEXT_MAX}
                    />
                    <Button variant="outline" size="sm" className="w-full" onClick={addSnippet}>
                      Add snippet
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Snippets appear in the Broadcast dialog (insert into the message, then confirm Send) and in a pane's right-click menu (one-click send to that agent). Names must be unique.
                  </p>
                </div>
              </SettingsSection>

              {/* Watch patterns (WARDEN-540): "ping me when a watched agent prints X."
                  A named match expression; when any WATCHED agent's captured output
                  newly matches, the existing attention surface fires (desktop alert +
                  attention-rollup row) within one capture tick — no new SSH cost, since
                  the matcher rides the watched-set capture the watch diff already does. */}
              <SettingsSection title="Watch patterns" className={cn(activeSection !== 'patterns' && 'hidden')}>
                <p className="text-xs text-muted-foreground">
                  Get pinged when a watched agent prints specific text — a deploy failure, a merge conflict, a paywall page, anything the built-in categories are blind to. Patterns match only over output already captured for watched chats (no extra SSH cost). Disable a pattern to silence it without deleting.
                </p>
                <div className="flex flex-col gap-2">
                  {config.watchPatterns.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No patterns yet. Add one like <code className="rounded bg-muted px-1">merge conflict</code> (text) or <code className="rounded bg-muted px-1">payment (required|due)</code> (regex).
                    </p>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {config.watchPatterns.map((p) => (
                        <PatternRow
                          key={p.id}
                          pattern={p}
                          onRename={renamePattern}
                          onExpressionChange={updatePatternExpression}
                          onModeChange={setPatternMode}
                          onToggleEnabled={togglePatternEnabled}
                          onDelete={deletePattern}
                        />
                      ))}
                    </div>
                  )}

                  {/* Add a new pattern */}
                  <div className="flex flex-col gap-1 rounded-md border bg-muted/30 p-2">
                    <Input
                      value={newPatternName}
                      onChange={(e) => setNewPatternName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); addPattern(); }
                      }}
                      className="h-8"
                      placeholder="name (e.g. Deploy failed)"
                      aria-label="New pattern name"
                      maxLength={WATCH_PATTERN_NAME_MAX}
                    />
                    <div className="flex items-center gap-2">
                      <Input
                        value={newPatternExpression}
                        onChange={(e) => setNewPatternExpression(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); addPattern(); }
                        }}
                        className="h-8 flex-1"
                        placeholder={newPatternMode === 'regex' ? 'regex (e.g. payment (required|due))' : 'text to match (e.g. merge conflict)'}
                        aria-label="New pattern expression"
                        maxLength={WATCH_PATTERN_EXPRESSION_MAX}
                      />
                      <Select
                        value={newPatternMode}
                        onValueChange={(v) => setNewPatternMode(v === 'regex' ? 'regex' : 'string')}
                      >
                        <SelectTrigger className="h-8 w-[104px]" aria-label="New pattern match mode">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="string">text</SelectItem>
                          <SelectItem value="regex">regex</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {newPatternMode === 'regex' && newPatternExpression.trim().length > 0 && !isValidRegex(newPatternExpression) && (
                      <p className="text-xs text-red-500">That regex is invalid.</p>
                    )}
                    <Button variant="outline" size="sm" className="w-full" onClick={addPattern}>
                      Add pattern
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Patterns evaluate over watched chats only. <strong>text</strong> = case-insensitive substring; <strong>regex</strong> = case-insensitive regular expression. Names must be unique.
                  </p>
                </div>
              </SettingsSection>

              {/* Notifications */}
              <SettingsSection title="Notifications" className={cn(activeSection !== 'notifications' && 'hidden')}>
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Switch
                      id="notifyChatOps"
                      checked={config.notifyChatOps}
                      onCheckedChange={(v) => setConfig({ ...config, notifyChatOps: v })}
                    />
                    <Label htmlFor="notifyChatOps" className="cursor-pointer">
                      Chat operations
                    </Label>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Session kill, chat kill, resume, and rename notifications
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Switch
                      id="notifyErrors"
                      checked={config.notifyErrors}
                      onCheckedChange={(v) => setConfig({ ...config, notifyErrors: v })}
                    />
                    <Label htmlFor="notifyErrors" className="cursor-pointer">
                      Errors
                    </Label>
                  </div>
                  <p className="text-xs text-muted-foreground">Error toast notifications</p>
                </div>

                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Switch
                      id="notifySuccess"
                      checked={config.notifySuccess}
                      onCheckedChange={(v) => setConfig({ ...config, notifySuccess: v })}
                    />
                    <Label htmlFor="notifySuccess" className="cursor-pointer">
                      Success messages
                    </Label>
                  </div>
                  <p className="text-xs text-muted-foreground">Success toast notifications</p>
                </div>

                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Switch
                      id="notifyObserver"
                      checked={config.notifyObserver}
                      onCheckedChange={(v) => setConfig({ ...config, notifyObserver: v })}
                    />
                    <Label htmlFor="notifyObserver" className="cursor-pointer">
                      Observer events
                    </Label>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Observer connection timeout and gate prompt notifications
                  </p>
                </div>

                {/* Desktop alerts (WARDEN-259) — a DIFFERENT channel + persistence
                    path than the toast toggles above. Those gate in-app toasts via
                    the server-side `config` / PUT /api/config; this is a pure
                    client-side localStorage pref that fires an OS notification when
                    an agent newly needs attention while Warden is UNFOCUSED (the
                    always-on badge already covers the in-app case). On enable we
                    request OS permission fire-and-forget; if denied the toggle still
                    flips on but alerts simply no-op until granted. */}
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Switch
                      id="attentionDesktopAlerts"
                      checked={attentionDesktopAlerts}
                      onCheckedChange={(v) => {
                        setAttentionDesktopAlerts(v);
                        if (v) void requestAlertPermission();
                      }}
                    />
                    <Label htmlFor="attentionDesktopAlerts" className="cursor-pointer">
                      Desktop alerts when agents need attention (while Warden is unfocused)
                    </Label>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Show an OS notification when an agent needs attention — critical/warning, a newly stuck/erroring/waiting/blocked pane, or a new directive/error — while you’re in another app. Clicking it focuses Warden. Your OS will ask for permission when you turn this on.
                  </p>
                </div>

                {/* Per-state toggle (WARDEN-344): which pane states raise the
                    Attention badge + desktop alert. Each defaults ON; a human can
                    silence a noisy "waiting" without losing "erroring". Same
                    client-side channel/persistence as the master toggle above. */}
                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    {([
                      { k: 'erroring', label: 'Erroring', hint: 'errors / stack traces' },
                      { k: 'stuck', label: 'Stuck', hint: 'repeating-output loops' },
                      { k: 'waiting', label: 'Waiting on you', hint: 'human-input prompts' },
                      { k: 'blocked', label: 'Blocked', hint: 'coordination / dependency' },
                    ] as const).map(({ k, label, hint }) => (
                      <div key={k} className="flex items-center gap-2">
                        <Switch
                          id={`attention-state-${k}`}
                          checked={attentionStates[k] !== false}
                          onCheckedChange={(v) => setAttentionStates({ ...attentionStates, [k]: v })}
                        />
                        <Label htmlFor={`attention-state-${k}`} className="cursor-pointer leading-tight">
                          {label}
                          <span className="block text-[10px] text-muted-foreground font-normal">{hint}</span>
                        </Label>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Which agent pane states raise the Attention badge (and desktop alert). Turn a noisy one off without losing the others.
                  </p>

                  {/* WARDEN-364 — per-severity routing, nested under the master
                      toggle. Greyed + inert while the master is off: the whole
                      channel is off then, so routing is moot. Defaults are all
                      ON (behavior-preserving); the human opts buckets OUT. */}
                  <div className={cn('pl-4 ml-1 flex flex-col gap-2 border-l border-border/60', !attentionDesktopAlerts && 'pointer-events-none opacity-50')}>
                    <div className="flex items-center gap-2">
                      <Switch id="alertCritical" checked={alertCritical} disabled={!attentionDesktopAlerts} onCheckedChange={setAlertCritical} />
                      <Label htmlFor="alertCritical" className="cursor-pointer">Critical agents</Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch id="alertWarning" checked={alertWarning} disabled={!attentionDesktopAlerts} onCheckedChange={setAlertWarning} />
                      <Label htmlFor="alertWarning" className="cursor-pointer">Warning agents</Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch id="alertDirective" checked={alertDirective} disabled={!attentionDesktopAlerts} onCheckedChange={setAlertDirective} />
                      <Label htmlFor="alertDirective" className="cursor-pointer">Pending directives</Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch id="alertError" checked={alertError} disabled={!attentionDesktopAlerts} onCheckedChange={setAlertError} />
                      <Label htmlFor="alertError" className="cursor-pointer">Recent errors</Label>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Choose which signals escalate to the desktop. To mute a specific agent, use the bell on its row in the attention menu (health signals only — directives and errors aren’t per-agent).
                    </p>
                  </div>
                </div>

                {/* Webhook "push" delivery channel (WARDEN-555) — a THIRD channel
                    alongside the in-app toast + OS desktop alert: it POSTs the
                    alert to the user's OWN webhook URL (ntfy/Discord/Slack/
                    Telegram/Home Assistant) so a human AWAY from the machine still
                    gets pinged, even with the Warden window closed to tray. Off by
                    default; sends nothing until a URL is set + enabled. Payload
                    goes only to the user's URL (no yatfa SaaS) — same stance as
                    the LLM API + telemetry endpoints. Persisted server-side via
                    /api/config (NOT client localStorage) so it survives a restart. */}
                <div className="flex flex-col gap-3 rounded-md border border-border/60 p-3 mt-2">
                  <div className="flex flex-col gap-1">
                    <span className="text-sm font-medium">Webhook push alerts</span>
                    <span className="text-xs text-muted-foreground">
                      Deliver critical alerts to your own webhook URL (ntfy, Discord, Slack, Telegram, Home Assistant) so you’re pinged on your phone even when Warden is closed to tray. Off by default.
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    <Switch
                      id="webhookEnabled"
                      checked={config.webhookEnabled}
                      onCheckedChange={(v) => setConfig({ ...config, webhookEnabled: v })}
                    />
                    <Label htmlFor="webhookEnabled" className="cursor-pointer">
                      Enable webhook push
                    </Label>
                  </div>

                  <div className="flex flex-col gap-2">
                    <Label htmlFor="webhookUrl">Webhook URL</Label>
                    <Input
                      id="webhookUrl"
                      value={config.webhookUrl}
                      onChange={(e) => setConfig({ ...config, webhookUrl: e.target.value })}
                      placeholder="https://ntfy.sh/your-topic"
                    />
                    <p className="text-xs text-muted-foreground">
                      Leave blank for unconfigured (sends nothing). Alerts go only to this URL — a destination you control, never a third-party service.
                    </p>
                  </div>

                  <div className="flex flex-col gap-2">
                    <Label htmlFor="webhookSecret">Shared secret (optional)</Label>
                    <Input
                      id="webhookSecret"
                      type="password"
                      value={webhookSecretInput}
                      onChange={(e) => setWebhookSecretInput(e.target.value)}
                      placeholder={webhookSecretSet ? `••••• set${webhookSecretTail ? ` (…${webhookSecretTail})` : ''}` : 'Not set'}
                    />
                    <p className="text-xs text-muted-foreground">
                      {webhookSecretSet
                        ? `A secret is saved${webhookSecretTail ? ` (ends …${webhookSecretTail})` : ''}. It is sent as Authorization: Bearer and X-Webhook-Secret. Type a new one to replace it; leave blank to keep it.`
                        : 'Optional. Sent as Authorization: Bearer and X-Webhook-Secret so your endpoint can verify the request. Leave blank if your topic needs no auth.'}
                    </p>
                  </div>

                  <div className="flex flex-col gap-2">
                    <span className="text-sm font-medium">Which alerts to push</span>
                    <div className="flex flex-wrap gap-x-4 gap-y-2">
                      <div className="flex items-center gap-2">
                        <Switch
                          id="webhookAlertAttention"
                          checked={config.webhookAlertAttention}
                          onCheckedChange={(v) => setConfig({ ...config, webhookAlertAttention: v })}
                        />
                        <Label htmlFor="webhookAlertAttention" className="cursor-pointer leading-tight">
                          Attention
                          <span className="block text-[10px] text-muted-foreground font-normal">stuck / erroring / waiting / blocked</span>
                        </Label>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch
                          id="webhookAlertBudget"
                          checked={config.webhookAlertBudget}
                          onCheckedChange={(v) => setConfig({ ...config, webhookAlertBudget: v })}
                        />
                        <Label htmlFor="webhookAlertBudget" className="cursor-pointer leading-tight">
                          Token budget
                          <span className="block text-[10px] text-muted-foreground font-normal">fleet / per-session breach</span>
                        </Label>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Attention alerts fire once per new transition into a stuck/erroring/waiting/blocked pane state. Budget alerts fire once per crossing of your token-spend threshold.
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={sendTestAlert}
                      disabled={testingWebhook || !config.webhookEnabled || !config.webhookUrl.trim()}
                    >
                      {testingWebhook ? 'Sending…' : 'Send test alert'}
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      Save first, then verify your topic receives it. Fires only when enabled with a URL set.
                    </span>
                  </div>
                </div>
              </SettingsSection>

              {/* Danger zone — workspace-preserving reset of all client-side UI
                  prefs. The ONLY non-destructive way to revert an over-tuned
                  setup: appearance/terminal/new-chat/behavior prefs snap to
                  their defaults while open tabs, panes, focus, and panel layout
                  survive. Pure client-side (no backend / config.json write).
                  Always confirm-gated: a rare, hard-to-undo en-masse revert is
                  worth the friction even with the destructive-confirm toggle
                  off (that toggle governs chat/session kills, not this). */}
              <SettingsSection title="Reset">
                <div className="flex flex-col gap-3 rounded-md border border-destructive/30 p-3">
                  <div className="flex flex-col gap-1">
                    <span className="text-sm font-medium">Reset preferences to defaults</span>
                    <span className="text-xs text-muted-foreground">
                      Resets all appearance, terminal, new-chat, and behavior preferences to their defaults. Your open tabs, panes, focus, and panel layout are preserved.
                    </span>
                  </div>
                  <div>
                    <Button variant="destructive" size="sm" onClick={() => setResetPrefsOpen(true)}>
                      Reset preferences to defaults
                    </Button>
                  </div>
                </div>
              </SettingsSection>
                </>
              )}
            </div>
          </div>
        </main>
      </div>

      <footer className="flex items-center justify-end gap-2 px-4 h-14 border-t shrink-0">
        <Button variant="outline" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={saving || loading}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </footer>

      <ConfirmDialog
        open={resetPrefsOpen}
        onOpenChange={(o) => { if (!o) setResetPrefsOpen(false); }}
        title="Reset preferences to defaults?"
        description="Resets all appearance, terminal, new-chat, and behavior preferences to their defaults. Your open tabs, panes, focus, and panel layout are preserved."
        confirmLabel="Reset"
        cancelLabel="Cancel"
        destructive
        onConfirm={confirmResetPrefs}
      />
    </div>
  );
}
