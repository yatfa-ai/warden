// Attention thresholds section (WARDEN-317) — backend /api/config. Extracted
// verbatim from SettingsPage (WARDEN-664); behavior is unchanged.
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SettingsSection } from '../SettingsSection';
import { ConfigResetToDefaultButton } from '../rows/ResetToDefaultButton';
import { clampToBounds, isOutOfBounds } from '../numericBounds';
import { type ConfigData, type SetConfig } from '../types';

export function AttentionThresholdsSection({ config, setConfig, hidden }: { config: ConfigData; setConfig: SetConfig; hidden: boolean }) {
  // WARDEN-1331 — the floors these inputs advertise come from the SERVED
  // bounds (GET /api/config), derived from the same registry clamp descriptors
  // the backend PUT guards enforce. One-sided ({min: 1}, no max): the
  // warning<=critical ceiling is a cross-field relationship, not a range, and
  // stays in its own onBlur + backend crossField rule below.
  const warningBounds = config.bounds.healthWarningThresholdMin;
  const criticalBounds = config.bounds.healthCriticalThresholdMin;
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
          min={warningBounds.min}
          step="1"
          value={config.healthWarningThresholdMin ?? ''}
          onChange={(e) =>
            setConfig({
              ...config,
              healthWarningThresholdMin: e.target.value ? parseInt(e.target.value) : null,
            })
          }
          onBlur={() => {
            // Keep the pair well-ordered (warning <= critical). On blur, clamp
            // the warning down to the critical value when the human has entered
            // a warning that exceeds it. Mirrors the backend PUT /api/config
            // guard so the committed value matches what persists; the
            // classifier clamps regardless (defense-in-depth), this just makes
            // the relationship visible while editing.
            //
            // Floor at the SERVED min FIRST (the min the input advertises,
            // WARDEN-1331), then apply the ordering clamp — composed into a
            // SINGLE setConfig so the second step can't read a stale `config`
            // closure. Without the floor, 0/negative used to be silently
            // refused by the backend (answered { ok: true } anyway — the value
            // reverted with no error ever shown; WARDEN-925). Null is the
            // use-the-default path and passes through unclamped, so a clamp
            // can never turn "default" into a number.
            const w = config.healthWarningThresholdMin;
            if (w == null) return;
            const c = config.healthCriticalThresholdMin;
            let next = clampToBounds(w, warningBounds);
            // Never clamp below the floor, even against a (transiently) sub-1
            // critical — an out-of-range value must not survive this blur.
            if (c != null && next > c) next = clampToBounds(c, criticalBounds);
            if (next !== w) setConfig({ ...config, healthWarningThresholdMin: next });
          }}
          placeholder="Default 5"
        />
        <p className="text-xs text-muted-foreground">
          Minutes of agent inactivity before it needs attention (warning state). Leave empty for the default (5).
        </p>
        {config.healthWarningThresholdMin != null && isOutOfBounds(config.healthWarningThresholdMin, warningBounds) && (
          <p className="text-xs text-destructive">
            Must be at least {warningBounds.min} — capped to {warningBounds.min} on blur.
          </p>
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
          min={criticalBounds.min}
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
            // Floor at the SERVED min (the min the input advertises,
            // WARDEN-1331). 0/negative used to be silently refused by the
            // backend while PUT /api/config still answered { ok: true }, so the
            // field reverted on the next open with no error shown (WARDEN-925);
            // the backend now clamps instead (WARDEN-1331) and this onBlur
            // mirrors it. Null stays the use-the-default path and is never
            // clamped.
            //
            // Deliberately does NOT touch healthWarningThresholdMin: flooring
            // critical can leave the pair inverted (warning 5 > critical 1), but
            // rewriting a field the human never touched is worse. The render-time
            // ordering message below fires immediately, and the backend
            // crossField (a) guard clamps warning down to critical on save, so
            // what persists is always well-ordered.
            const v = config.healthCriticalThresholdMin;
            if (v != null && isOutOfBounds(v, criticalBounds)) {
              setConfig({ ...config, healthCriticalThresholdMin: clampToBounds(v, criticalBounds) });
            }
          }}
        />
        <p className="text-xs text-muted-foreground">
          Minutes of inactivity before an agent is critical and triggers a desktop alert. Leave empty for the default (30).
        </p>
        {config.healthCriticalThresholdMin != null && isOutOfBounds(config.healthCriticalThresholdMin, criticalBounds) && (
          <p className="text-xs text-destructive">
            Must be at least {criticalBounds.min} — capped to {criticalBounds.min} on blur.
          </p>
        )}
      </div>
    </SettingsSection>
  );
}
