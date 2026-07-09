import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { type Theme } from '@/lib/theme';
import { type Density } from '@/lib/density';
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
  open: boolean;
  onClose: () => void;
  onConfigChange: () => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  // Density is a pure client-side localStorage pref (NOT backend config): it
  // applies instantly via the prop callback and is persisted by App's saveUi
  // effect. It must never be added to the `config` state / PUT /api/config body.
  density: Density;
  setDensity: (density: Density) => void;
}

export function SettingsDialog({ open, onClose, onConfigChange, theme, setTheme, density, setDensity }: Props) {
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
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Load current config and available hosts when dialog opens
  useEffect(() => {
    if (open) {
      setLoading(true);
      Promise.all([
        fetch('/api/config').then((r) => r.json()),
        fetch('/api/ssh-hosts').then((r) => r.json()),
      ])
        .then(([configData, hostsData]) => {
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
        .finally(() => setLoading(false));
    }
  }, [open]);

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
      const res = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(config),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to save configuration');
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
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Manage SSH hosts and connection settings for Warden.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">Loading configuration…</div>
        ) : (
          <div className="flex flex-col gap-4 py-4">
            {/* Host Management */}
            <div className="flex flex-col gap-2">
              <Label>Configured Hosts</Label>
              <div className="flex flex-wrap gap-2 min-h-[40px] p-2 rounded-md border bg-muted/30">
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

            {/* Add Host Dropdown */}
            {availableHostsToAdd.length > 0 && (
              <div className="flex flex-col gap-2">
                <Label>Add Host</Label>
                <div className="relative">
                  <select
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onChange={(e) => {
                      if (e.target.value) {
                        addHost(e.target.value);
                        e.target.value = '';
                      }
                    }}
                  >
                    <option value="">Select a host to add…</option>
                    {availableHostsToAdd.map((host) => (
                      <option key={host} value={host}>
                        {host}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {/* Poll Interval */}
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

            {/* Tmux Session */}
            <div className="flex flex-col gap-2">
              <Label htmlFor="tmuxSession">Tmux Session Name</Label>
              <Input
                id="tmuxSession"
                value={config.tmuxSession}
                onChange={(e) => setConfig({ ...config, tmuxSession: e.target.value })}
              />
            </div>

            {/* Connect Timeout */}
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

            {/* Observer Preferences Section */}
            <div className="flex flex-col gap-3 pt-2 border-t">
              <div className="text-sm font-medium text-foreground">Observer Preferences</div>

              {/* Confirmation Mode */}
              <div className="flex flex-col gap-2">
                <Label htmlFor="observerConfirmMode">Directive Confirmation</Label>
                <select
                  id="observerConfirmMode"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={config.observerConfirmMode}
                  onChange={(e) =>
                    setConfig({ ...config, observerConfirmMode: e.target.value as 'always' | 'auto-safe' })
                  }
                >
                  <option value="always">Always confirm (default)</option>
                  <option value="auto-safe">Auto-send safe directives</option>
                </select>
                {config.observerConfirmMode === 'auto-safe' && (
                  <p className="text-xs text-muted-foreground">
                    When "Auto-send safe", read-only directives (list, read) skip confirmation.
                  </p>
                )}
              </div>

              {/* Auto-Start Toggle */}
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

              {/* Session Timeout */}
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
            </div>

            {/* Safety Section — destructive-action confirmation preference */}
            <div className="flex flex-col gap-3 pt-2 border-t">
              <div className="text-sm font-medium text-foreground">Safety</div>

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
            </div>

            {/* Display Customization Section */}
            <div className="flex flex-col gap-3 pt-2 border-t">
              <div className="text-sm font-medium text-foreground">Display</div>
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
            </div>

            {/* Appearance Section — client-side look preferences (color scheme + density) */}
            <div className="flex flex-col gap-3 pt-2 border-t">
              <div className="text-sm font-medium text-foreground">Appearance</div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="theme">Color Scheme</Label>
                <select
                  id="theme"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={theme}
                  onChange={(e) => setTheme(e.target.value as Theme)}
                >
                  <option value="system">System (follow OS preference)</option>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
                <p className="text-xs text-muted-foreground">
                  Choose how Warden appears. "System" automatically switches between light and dark based on your OS settings.
                </p>
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="density">Density</Label>
                <select
                  id="density"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={density}
                  onChange={(e) => setDensity(e.target.value as Density)}
                >
                  <option value="comfortable">Comfortable (default)</option>
                  <option value="compact">Compact</option>
                </select>
                <p className="text-xs text-muted-foreground">
                  "Compact" tightens row and header spacing so more agents fit on screen. Applies instantly and is remembered across reloads.
                </p>
              </div>
            </div>

            {/* Notification Preferences Section */}
            <div className="flex flex-col gap-3 pt-2 border-t">
              <div className="text-sm font-medium text-foreground">Notifications</div>

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
                <p className="text-xs text-muted-foreground">
                  Error toast notifications
                </p>
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
                <p className="text-xs text-muted-foreground">
                  Success toast notifications
                </p>
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
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving || loading}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
