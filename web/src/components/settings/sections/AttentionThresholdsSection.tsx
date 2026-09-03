// Attention thresholds section (WARDEN-317) — backend /api/config. Extracted
// verbatim from SettingsPage (WARDEN-664); behavior is unchanged.
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SettingsSection } from '../SettingsSection';
import { ConfigResetToDefaultButton } from '../rows/ResetToDefaultButton';
import { type ConfigData, type SetConfig } from '../types';

export function AttentionThresholdsSection({ config, setConfig, hidden }: { config: ConfigData; setConfig: SetConfig; hidden: boolean }) {
  return (
    <SettingsSection title="Attention thresholds" className={hidden ? 'hidden' : undefined}>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="healthWarningThresholdMin">Warning after (minutes)</Label>
          <ConfigResetToDefaultButton label="Warning after (minutes)" path="healthWarningThresholdMin" config={config} setConfig={setConfig} />
        </div>
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
            //
            // WARDEN-925: floor at 1 FIRST (the min the input advertises), then
            // apply the ordering clamp — composed into a SINGLE setConfig so the
            // second step can't read a stale `config` closure. Without the floor,
            // 0/negative reached the backend's `nullablePositiveNumber` guard
            // (`value > 0`), which silently refuses the write while the server
            // still answers { ok: true } — the value reverted with no error ever
            // shown. Null is the use-the-default path and passes through
            // unclamped, so a clamp can never turn "default" into a number.
            const w = config.healthWarningThresholdMin;
            if (w == null) return;
            const c = config.healthCriticalThresholdMin;
            let next = Math.max(1, w);
            // Never clamp below the floor, even against a (transiently) sub-1
            // critical — an out-of-range value must not survive this blur.
            if (c != null && next > c) next = Math.max(1, c);
            if (next !== w) setConfig({ ...config, healthWarningThresholdMin: next });
          }}
          placeholder="Default 5"
        />
        <p className="text-xs text-muted-foreground">
          Minutes of agent inactivity before it needs attention (warning state). Leave empty for the default (5).
        </p>
        {config.healthWarningThresholdMin != null && config.healthWarningThresholdMin < 1 && (
          <p className="text-xs text-destructive">Must be at least 1 — capped to 1 on blur.</p>
        )}
        {config.healthWarningThresholdMin != null &&
          config.healthCriticalThresholdMin != null &&
          config.healthWarningThresholdMin > config.healthCriticalThresholdMin && (
            <p className="text-xs text-destructive">
              Warning must come before Critical — capped to {config.healthCriticalThresholdMin} min on blur.
            </p>
          )}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="healthCriticalThresholdMin">Critical after (minutes)</Label>
          <ConfigResetToDefaultButton label="Critical after (minutes)" path="healthCriticalThresholdMin" config={config} setConfig={setConfig} />
        </div>
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
          onBlur={() => {
            // WARDEN-925: floor at 1 (the min the input advertises). 0/negative
            // was silently refused by the backend's `value > 0` guard while
            // PUT /api/config still answered { ok: true }, so the field reverted
            // on the next open with no error shown. Null stays the
            // use-the-default path and is never clamped.
            //
            // Deliberately does NOT touch healthWarningThresholdMin: flooring
            // critical can leave the pair inverted (warning 5 > critical 1), but
            // rewriting a field the human never touched is worse. The render-time
            // ordering message below fires immediately, and the backend
            // crossField (a) guard clamps warning down to critical on save, so
            // what persists is always well-ordered.
            const v = config.healthCriticalThresholdMin;
            if (v != null && v < 1) {
              setConfig({ ...config, healthCriticalThresholdMin: 1 });
            }
          }}
        />
        <p className="text-xs text-muted-foreground">
          Minutes of inactivity before an agent is critical and triggers a desktop alert. Leave empty for the default (30).
        </p>
        {config.healthCriticalThresholdMin != null && config.healthCriticalThresholdMin < 1 && (
          <p className="text-xs text-destructive">Must be at least 1 — capped to 1 on blur.</p>
        )}
      </div>
    </SettingsSection>
  );
}
