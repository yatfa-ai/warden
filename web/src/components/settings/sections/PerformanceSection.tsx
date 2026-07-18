// Performance section (WARDEN-439) — backend /api/config. Extracted verbatim
// from SettingsPage (WARDEN-664); behavior is unchanged.
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { SettingsSection } from '../SettingsSection';
import { type ConfigData, type SetConfig } from '../types';

export function PerformanceSection({ config, setConfig, hidden }: { config: ConfigData; setConfig: SetConfig; hidden: boolean }) {
  return (
    <SettingsSection title="Performance" className={hidden ? 'hidden' : undefined}>
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
  );
}
