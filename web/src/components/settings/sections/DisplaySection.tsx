// Display section — backend /api/config display customization. Extracted
// verbatim from SettingsPage (WARDEN-664); behavior is unchanged.
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { SettingsSection } from '../SettingsSection';
import { ConfigResetToDefaultButton } from '../rows/ResetToDefaultButton';
import { type ConfigData, type SetConfig } from '../types';

export function DisplaySection({ config, setConfig, hidden }: { config: ConfigData; setConfig: SetConfig; hidden: boolean }) {
  return (
    <SettingsSection title="Display" className={hidden ? 'hidden' : undefined}>
      <div className="flex items-center gap-2">
        <Switch
          id="showHostTags"
          checked={config.showHostTags ?? true}
          onCheckedChange={(v) => setConfig({ ...config, showHostTags: v })}
        />
        <Label htmlFor="showHostTags" className="cursor-pointer">
          Show host tags (local/hostname badges)
        </Label>
        <ConfigResetToDefaultButton label="Show host tags" path="showHostTags" config={config} setConfig={setConfig} />
      </div>
      <div className="flex items-center gap-2">
        <Switch
          id="showTypeBadges"
          checked={config.showTypeBadges ?? true}
          onCheckedChange={(v) => setConfig({ ...config, showTypeBadges: v })}
        />
        <Label htmlFor="showTypeBadges" className="cursor-pointer">
          Show type badges (shell/claude/yatfa labels)
        </Label>
        <ConfigResetToDefaultButton label="Show type badges" path="showTypeBadges" config={config} setConfig={setConfig} />
      </div>
      <div className="flex items-center gap-2">
        <Switch
          id="showStatusIndicators"
          checked={config.showStatusIndicators ?? true}
          onCheckedChange={(v) => setConfig({ ...config, showStatusIndicators: v })}
        />
        <Label htmlFor="showStatusIndicators" className="cursor-pointer">
          Show status indicators (active/idle/dead dots)
        </Label>
        <ConfigResetToDefaultButton label="Show status indicators" path="showStatusIndicators" config={config} setConfig={setConfig} />
      </div>
      <div className="flex items-center gap-2">
        <Switch
          id="showProjectBadges"
          checked={config.showProjectBadges ?? false}
          onCheckedChange={(v) => setConfig({ ...config, showProjectBadges: v })}
        />
        <Label htmlFor="showProjectBadges" className="cursor-pointer">
          Show project badges
        </Label>
        <ConfigResetToDefaultButton label="Show project badges" path="showProjectBadges" config={config} setConfig={setConfig} />
      </div>
      <div className="flex items-center gap-2">
        <Switch
          id="hideOfflineHosts"
          checked={config.hideOfflineHosts ?? false}
          onCheckedChange={(v) => setConfig({ ...config, hideOfflineHosts: v })}
        />
        <Label htmlFor="hideOfflineHosts" className="cursor-pointer">
          Hide offline hosts (collapse into an expandable summary)
        </Label>
        <ConfigResetToDefaultButton label="Hide offline hosts" path="hideOfflineHosts" config={config} setConfig={setConfig} />
      </div>
    </SettingsSection>
  );
}
