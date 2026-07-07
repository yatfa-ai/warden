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
import { Badge } from '@/components/ui/badge';

interface ConfigData {
  hosts: string[];
  pollIntervalMs: number;
  tmuxSession: string;
  connectTimeout: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onConfigChange: () => void;
}

export function SettingsDialog({ open, onClose, onConfigChange }: Props) {
  const [config, setConfig] = useState<ConfigData>({
    hosts: [],
    pollIntervalMs: 1500,
    tmuxSession: 'agent',
    connectTimeout: 10,
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
          });
          setAvailableHosts(hostsData.hosts || []);
        })
        .catch((err) => {
          console.error('Failed to load config:', err);
          alert('Failed to load configuration');
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
      alert(err instanceof Error ? err.message : 'Failed to save configuration');
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
