// Performance section (WARDEN-439) — backend /api/config. Extracted verbatim
// from SettingsPage (WARDEN-664); behavior is unchanged.
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { SettingsSection } from '../SettingsSection';
import { ConfigResetToDefaultButton } from '../rows/ResetToDefaultButton';
import { type ConfigData, type SetConfig } from '../types';

export function PerformanceSection({ config, setConfig, hidden }: { config: ConfigData; setConfig: SetConfig; hidden: boolean }) {
  return (
    <SettingsSection title="Performance" className={hidden ? 'hidden' : undefined}>
      <div className="flex items-center gap-2">
        <Switch
          id="companionTransportEnabled"
          checked={config.companionTransportEnabled ?? true}
          disabled={config.companionTransportOverridden}
          onCheckedChange={(v) => setConfig({ ...config, companionTransportEnabled: v })}
        />
        <Label
          htmlFor="companionTransportEnabled"
          className={cn('cursor-pointer', config.companionTransportOverridden && 'cursor-not-allowed opacity-60')}
        >
          Companion transport
        </Label>
        {/* The env override makes the toggle inert, so a restore would write a
            draft value nothing honors — hide the affordance in that state, the
            same discrimination the disabled Switch above already makes. */}
        {!config.companionTransportOverridden && (
          <ConfigResetToDefaultButton label="Companion transport" path="companionTransportEnabled" config={config} setConfig={setConfig} />
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Route remote host operations — tmux discovery, pane capture with live delta
        push, session spawn/kill/resize, text and keystroke send, liveness/ping,
        interactive terminal attach, exec, file writes, plus the script-delivery legs
        (git routes, file read/exists, session search/read, observer tails, claude
        detection) — through a single persistent SSH channel instead of a fresh ssh
        process per operation, so the per-op ssh process count on remote hosts drops
        to near zero. Takes effect on the next operation. Local hosts are unaffected
        (remote-only by design).
      </p>
      {config.companionTransportOverridden && (
        <p className="text-xs text-muted-foreground">
          <Badge variant="outline">env override</Badge>{' '}
          The <code className="text-[11px]">WARDEN_COMPANION_TRANSPORT</code> environment
          variable is set, so it overrides this toggle — the on/off state above is inert.
          Unset the variable and restart Warden to control it here.
        </p>
      )}

      {/* WARDEN-1390 — the PER-HOST opt-out. The toggle above is fleet-global, but
          the reason to opt out is usually one host (a Windows companion can never
          carry a PTY), so this list excludes exactly those hosts while every other
          host keeps riding the channel. Comma-separated aliases, parsed to the
          string[] the backend persists; the server refuses malformed entries
          (commas/newlines/control characters — a dropped exclusion would be
          invisible breakage) and the save flow reports the refusal. */}
      <div className="flex flex-col gap-2 pt-1">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="companionExcludedHosts">Companion excluded hosts</Label>
          <ConfigResetToDefaultButton label="Companion excluded hosts" path="companionExcludedHosts" config={config} setConfig={setConfig} />
        </div>
        <Input
          id="companionExcludedHosts"
          value={(config.companionExcludedHosts ?? []).join(', ')}
          onChange={(e) => setConfig({
            ...config,
            companionExcludedHosts: e.target.value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          })}
          placeholder="e.g. win-box, build-agent (comma-separated host aliases)"
        />
        <p className="text-xs text-muted-foreground">
          Hosts listed here never use the companion transport — they keep the default
          SSH path for every operation (attach, capture, exec, …), while all other
          hosts keep riding the persistent channel. Use this for hosts where the
          companion cannot deliver (a Windows companion cannot allocate a PTY, so
          interactive attach there requires the default path). Enter bare SSH host
          aliases, comma-separated. Takes effect on the next operation; a newly
          excluded host's live channel is closed immediately.
        </p>
      </div>
    </SettingsSection>
  );
}
