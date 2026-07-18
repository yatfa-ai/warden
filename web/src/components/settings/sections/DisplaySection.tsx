// Display section — backend /api/config display customization. Extracted
// verbatim from SettingsPage (WARDEN-664); behavior is unchanged.
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { SettingsSection } from '../SettingsSection';
import { type ConfigData, type SetConfig } from '../types';

export function DisplaySection({ config, setConfig, hidden }: { config: ConfigData; setConfig: SetConfig; hidden: boolean }) {
  return (
    <SettingsSection title="Display" className={hidden ? 'hidden' : undefined}>
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
  );
}
