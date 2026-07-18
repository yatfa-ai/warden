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
            placeholder="Default 2,000,000"
          />
          <p className="text-xs text-muted-foreground">
            Total tokens spent by sessions active in the window before the fleet alarm
            fires. Leave empty for the default (2,000,000).
          </p>
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
            placeholder="Default 24"
          />
          <p className="text-xs text-muted-foreground">
            Which sessions count: those active in the last N hours. Each contributes its
            full lifetime token total (the existing meter), not just turns within the
            window — so a runaway that's burning tokens right now is captured. Default 24.
          </p>
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
            placeholder="Default 1,000,000"
          />
          <p className="text-xs text-muted-foreground">
            Catch the specific runaway: when any single session's lifetime total crosses
            this, Warden names it in the alert. Empty disables the per-session alarm
            (the fleet threshold still applies). Default 1,000,000.
          </p>
        </div>
      </div>
    </SettingsSection>
  );
}
