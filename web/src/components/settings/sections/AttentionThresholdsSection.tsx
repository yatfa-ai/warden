// Attention thresholds section (WARDEN-317) — backend /api/config. Extracted
// verbatim from SettingsPage (WARDEN-664); behavior is unchanged.
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SettingsSection } from '../SettingsSection';
import { type ConfigData, type SetConfig } from '../types';

export function AttentionThresholdsSection({ config, setConfig, hidden }: { config: ConfigData; setConfig: SetConfig; hidden: boolean }) {
  return (
    <SettingsSection title="Attention thresholds" className={hidden ? 'hidden' : undefined}>
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
  );
}
