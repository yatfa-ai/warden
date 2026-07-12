import { useState, useEffect, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { ArrowLeft, Trash2 } from 'lucide-react';
import { type Theme, type TerminalColorScheme } from '@/lib/theme';
import { type Density } from '@/lib/density';
import { type RestoreOnStartup, type PaneLayout, type TerminalCursorStyle, type OnExitBehavior, type CustomPreset, type PresetNameIssue, PRESET_NAME_MAX, validatePresetName, DEFAULT_TERMINAL_FONT_FAMILY } from '@/lib/storage';
import { hasWindowBridge } from '@/lib/electron';
import { requestAlertPermission } from '@/lib/desktopAlerts';
import { putJson } from '@/lib/api';
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
  // Fleet health attention thresholds (minutes of inactivity). healthWarning
  // is the healthy→WARNING boundary (default 5); healthCritical is the
  // warning→CRITICAL boundary (default 30) which also fires desktop alerts.
  healthWarningThresholdMin: number | null;
  healthCriticalThresholdMin: number | null;
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
  // Default agent type + host pre-filled in the ＋ new chat form. Pure client-side
  // localStorage prefs: applied instantly via the prop callbacks and persisted by
  // App's saveUi effect. They must never be added to the `config` state /
  // PUT /api/config body. `defaultNewChatPreset` is a reserved built-in name
  // ('claude' | 'shell') OR a custom preset name.
  defaultNewChatPreset: string;
  setDefaultNewChatPreset: (v: string) => void;
  defaultNewChatHost: string;
  setDefaultNewChatHost: (v: string) => void;
  // User-defined spawn presets (named quick-fill commands beyond claude/shell).
  // Pure client-side localStorage pref, persisted by App's saveUi effect; never
  // sent to the backend.
  customPresets: CustomPreset[];
  setCustomPresets: (v: CustomPreset[]) => void;
  // Default shell launched by the pane-grid ＋ split button (WARDEN-223). Blank
  // means "no explicit shell" → the host launches its own login shell. Pure
  // client-side localStorage pref, persisted by App's saveUi effect; never sent
  // to the backend. Independent of the spawn presets above.
  defaultSplitShell: string;
  setDefaultSplitShell: (v: string) => void;
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
  // Opt-in OS desktop alerts when agents need attention AND Warden is unfocused
  // (WARDEN-259). Pure client-side localStorage pref (NOT backend config): it
  // applies instantly via the prop callback (forwarded to the AttentionBadge) and
  // is persisted by App's saveUi effect. It must NEVER be added to the `config`
  // state / PUT /api/config body — the adjacent toast toggles use setConfig, but
  // this is a different delivery channel AND a different persistence path.
  attentionDesktopAlerts: boolean;
  setAttentionDesktopAlerts: (v: boolean) => void;
}

/** A titled group of related settings, separated by a top border. */
function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 pt-6 border-t first:pt-0 first:border-t-0">
      <h2 className="text-sm font-medium text-foreground">{title}</h2>
      {children}
    </section>
  );
}

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

export function SettingsPage({ onClose, onConfigChange, theme, setTheme, density, setDensity, paneLayout, setPaneLayout, onExitBehavior, setOnExitBehavior, autoFocusNewPane, setAutoFocusNewPane, restoreOnStartup, setRestoreOnStartup, terminalFontSize, setTerminalFontSize, attentionDesktopAlerts, setAttentionDesktopAlerts, terminalScrollback, setTerminalScrollback, terminalFontFamily, setTerminalFontFamily, terminalColorScheme, setTerminalColorScheme, terminalCursorStyle, setTerminalCursorStyle, copyOnSelect, setCopyOnSelect, defaultNewChatPreset, setDefaultNewChatPreset, defaultNewChatHost, setDefaultNewChatHost, customPresets, setCustomPresets, defaultSplitShell, setDefaultSplitShell, rememberWindowBounds, setRememberWindowBounds, launchAtLogin, setLaunchAtLogin }: Props) {
  const [config, setConfig] = useState<ConfigData>({
    hosts: [],
    pollIntervalMs: 1500,
    tmuxSession: 'agent',
    connectTimeout: 10,
    observerConfirmMode: 'always',
    observerAutoStart: false,
    observerSessionTimeout: 30,
    healthWarningThresholdMin: 5,
    healthCriticalThresholdMin: 30,
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
  });
  const [availableHosts, setAvailableHosts] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

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
          healthWarningThresholdMin: configData.healthWarningThresholdMin ?? 5,
          healthCriticalThresholdMin: configData.healthCriticalThresholdMin ?? 30,
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
        });
        setAvailableHosts(hostsData.hosts || []);
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
      const { ok, error } = await putJson('/api/config', config);
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

  const availableHostsToAdd = availableHosts.filter((h) => !config.hosts.includes(h));

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

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-6 flex flex-col gap-6">
          {loading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">Loading configuration…</div>
          ) : (
            <>
              {/* Hosts & Connection */}
              <SettingsSection title="Hosts & Connection">
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

                <div className="flex flex-col gap-2">
                  <Label htmlFor="pollIntervalMs">Poll Interval (ms)</Label>
                  <Input
                    id="pollIntervalMs"
                    type="number"
                    min="500"
                    max="10000"
                    step="100"
                    value={config.pollIntervalMs}
                    onChange={(e) =>
                      setConfig({ ...config, pollIntervalMs: parseInt(e.target.value) || 1500 })
                    }
                  />
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
              <SettingsSection title="Observer Preferences">
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
              </SettingsSection>

              {/* Safety */}
              <SettingsSection title="Safety">
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
              <SettingsSection title="Attention thresholds">
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
                    placeholder="Default 5"
                  />
                  <p className="text-xs text-muted-foreground">
                    Minutes of agent inactivity before it needs attention (warning state). Leave empty for the default (5).
                  </p>
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

              {/* Display */}
              <SettingsSection title="Display">
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
              <SettingsSection title="Appearance">
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
                  <Label htmlFor="theme">Color Scheme</Label>
                  <Select value={theme} onValueChange={(v) => setTheme(v as Theme)}>
                    <SelectTrigger id="theme" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="system">System (follow OS preference)</SelectItem>
                      <SelectItem value="light">Light</SelectItem>
                      <SelectItem value="dark">Dark</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Choose how Warden appears. "System" automatically switches between light and dark based on your OS settings.
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
                    How terminal panes are colored. "Match app theme" follows the Color Scheme above (including System); "Always dark/light" forces it regardless of the rest of the UI. Applies live to open panes.
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
              </SettingsSection>

              {/* New Chats — client-side default agent type + host for the ＋ new spawn form */}
              <SettingsSection title="New Chats">
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

                {/* Default split shell (WARDEN-223): the shell the pane-grid ＋ split
                    button spawns next to the focused pane. Blank = the host's own
                    login shell (auto-detected per host; never hardcoded). A separate
                    concern from the agent spawn presets above. */}
                <div className="flex flex-col gap-2">
                  <Label htmlFor="defaultSplitShell">Default split shell</Label>
                  <Input
                    id="defaultSplitShell"
                    value={defaultSplitShell}
                    onChange={(e) => setDefaultSplitShell(e.target.value)}
                    placeholder="auto (host login shell)"
                  />
                  <p className="text-xs text-muted-foreground">
                    Shell launched by the ＋ split button next to a pane, on that pane's host at its working directory. Enter a name like <code className="bg-muted px-1 rounded">zsh</code> or <code className="bg-muted px-1 rounded">pwsh</code>; leave blank to use each host's default login shell.
                  </p>
                </div>
              </SettingsSection>

              {/* Notifications */}
              <SettingsSection title="Notifications">
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
                    Show an OS notification when an agent goes critical/warning or a new directive/error lands while you’re in another app. Clicking it focuses Warden. Your OS will ask for permission when you turn this on.
                  </p>
                </div>
              </SettingsSection>
            </>
          )}
        </div>
      </div>

      <footer className="flex items-center justify-end gap-2 px-4 h-14 border-t shrink-0">
        <Button variant="outline" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={saving || loading}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </footer>
    </div>
  );
}
