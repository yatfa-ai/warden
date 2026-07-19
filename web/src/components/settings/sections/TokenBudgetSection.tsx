// Token budget section (WARDEN-415) — backend /api/config. Extracted verbatim
// from SettingsPage (WARDEN-664); behavior is unchanged.
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { SettingsSection } from '../SettingsSection';
import { type ConfigData, type SetConfig } from '../types';

export function TokenBudgetSection({ config, setConfig, hidden }: { config: ConfigData; setConfig: SetConfig; hidden: boolean }) {
  return (
    <SettingsSection title="Token budget" className={hidden ? 'hidden' : undefined}>
      <div className="flex items-center gap-2">
        <Checkbox
          id="tokenBudgetEnabled"
          checked={config.tokenBudgetEnabled ?? false}
          onCheckedChange={(checked) =>
            setConfig({ ...config, tokenBudgetEnabled: checked === true })
          }
        />
        <Label htmlFor="tokenBudgetEnabled" className="cursor-pointer">
          Enable token-spend budget alerts
        </Label>
      </div>
      <p className="text-xs text-muted-foreground">
        Watch the fleet's token usage on a slow cadence and raise a desktop alert + in-app
        toast when spend crosses a threshold — so a runaway or looping agent's cost is
        caught while you're away. Model-agnostic token counts, not dollar cost. It only
        notifies; it never kills or pauses agents.
      </p>
      <div className={cn('flex flex-col gap-4 pl-4 ml-1 border-l border-border/60', !config.tokenBudgetEnabled && 'pointer-events-none opacity-50')}>
        <div className="flex flex-col gap-2">
          <Label htmlFor="tokenBudgetThresholdTokens">Fleet threshold (tokens)</Label>
          <Input
            id="tokenBudgetThresholdTokens"
            type="number"
            min="1"
            step="100000"
            value={config.tokenBudgetThresholdTokens ?? ''}
            onChange={(e) =>
              setConfig({
                ...config,
                tokenBudgetThresholdTokens: e.target.value ? parseInt(e.target.value) : null,
              })
            }
            onBlur={() => {
              // WARDEN-747: floor at 1 (the min the input advertises) — mirrors
              // the WARDEN-374 attention-threshold clamp + the backend PUT
              // /api/config guard. These fields are null-able (empty = use the
              // default), so only clamp when a value is actually present.
              const v = config.tokenBudgetThresholdTokens;
              if (v != null && v < 1) {
                setConfig({ ...config, tokenBudgetThresholdTokens: 1 });
              }
            }}
            placeholder="Default 2,000,000"
          />
          <p className="text-xs text-muted-foreground">
            Total tokens spent by sessions active in the window before the fleet alarm
            fires. Leave empty for the default (2,000,000).
          </p>
          {config.tokenBudgetThresholdTokens != null &&
            config.tokenBudgetThresholdTokens < 1 && (
              <p className="text-xs text-destructive">
                Must be at least 1 — capped to 1 on blur.
              </p>
            )}
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="tokenBudgetWindowHours">Window (hours)</Label>
          <Input
            id="tokenBudgetWindowHours"
            type="number"
            min="1"
            step="1"
            value={config.tokenBudgetWindowHours ?? ''}
            onChange={(e) =>
              setConfig({
                ...config,
                tokenBudgetWindowHours: e.target.value ? parseInt(e.target.value) : null,
              })
            }
            onBlur={() => {
              // WARDEN-747: floor at 1 — mirrors WARDEN-374 + the backend guard.
              // Null-able (empty = use default), so only clamp when non-null.
              const v = config.tokenBudgetWindowHours;
              if (v != null && v < 1) {
                setConfig({ ...config, tokenBudgetWindowHours: 1 });
              }
            }}
            placeholder="Default 24"
          />
          <p className="text-xs text-muted-foreground">
            Which sessions count: those active in the last N hours. Each contributes its
            full lifetime token total (the existing meter), not just turns within the
            window — so a runaway that's burning tokens right now is captured. Default 24.
          </p>
          {config.tokenBudgetWindowHours != null && config.tokenBudgetWindowHours < 1 && (
            <p className="text-xs text-destructive">
              Must be at least 1 — capped to 1 on blur.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="tokenBudgetPerSessionThresholdTokens">Per-session threshold (tokens)</Label>
          <Input
            id="tokenBudgetPerSessionThresholdTokens"
            type="number"
            min="1"
            step="100000"
            value={config.tokenBudgetPerSessionThresholdTokens ?? ''}
            onChange={(e) =>
              setConfig({
                ...config,
                tokenBudgetPerSessionThresholdTokens: e.target.value ? parseInt(e.target.value) : null,
              })
            }
            onBlur={() => {
              // WARDEN-747: floor at 1 — mirrors WARDEN-374 + the backend guard.
              // Null-able (empty = use default / disable), so only clamp when
              // non-null; clearing the field stays null, the disable path.
              const v = config.tokenBudgetPerSessionThresholdTokens;
              if (v != null && v < 1) {
                setConfig({ ...config, tokenBudgetPerSessionThresholdTokens: 1 });
              }
            }}
            placeholder="Default 1,000,000"
          />
          <p className="text-xs text-muted-foreground">
            Catch the specific runaway: when any single session's lifetime total crosses
            this, Warden names it in the alert. Empty disables the per-session alarm
            (the fleet threshold still applies). Default 1,000,000.
          </p>
          {config.tokenBudgetPerSessionThresholdTokens != null &&
            config.tokenBudgetPerSessionThresholdTokens < 1 && (
              <p className="text-xs text-destructive">
                Must be at least 1 — capped to 1 on blur.
              </p>
            )}
        </div>
      </div>
    </SettingsSection>
  );
}
