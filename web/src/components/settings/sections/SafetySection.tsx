// Safety section (backend /api/config). Extracted verbatim from SettingsPage
// (WARDEN-664); behavior is unchanged.
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { SettingsSection } from '../SettingsSection';
import { type ConfigData, type SetConfig } from '../types';

export function SafetySection({ config, setConfig, hidden }: { config: ConfigData; setConfig: SetConfig; hidden: boolean }) {
  return (
    <SettingsSection title="Safety" className={hidden ? 'hidden' : undefined}>
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
  );
}
