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
import { ArrowLeft } from 'lucide-react';
import { type Theme } from '@/lib/theme';
import { type Density } from '@/lib/density';
import { type RestoreOnStartup } from '@/lib/storage';
import { putJson } from '@/lib/api';
import { toast } from 'sonner';

interface ConfigData {
  hosts: string[];
  pollIntervalMs: number;
  tmuxSession: string;
  connectTimeout: number;
  observerConfirmMode: 'always' | 'auto-safe';
  observerAutoStart: boolean;
  observerSessionTimeout: number | null;
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

export function SettingsPage({ onClose, onConfigChange, theme, setTheme, density, setDensity, restoreOnStartup, setRestoreOnStartup, terminalFontSize, setTerminalFontSize, terminalScrollback, setTerminalScrollback }: Props) {
  const [config, setConfig] = useState<ConfigData>({
    hosts: [],
    pollIntervalMs: 1500,
    tmuxSession: 'agent',
    connectTimeout: 10,
    observerConfirmMode: 'always',
    observerAutoStart: false,
    observerSessionTimeout: 30,
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
  });
  const [availableHosts, setAvailableHosts] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

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
