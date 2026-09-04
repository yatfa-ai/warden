// Token budget section (WARDEN-415) — backend /api/config. Extracted verbatim
// from SettingsPage (WARDEN-664); behavior is unchanged.
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { SettingsSection } from '../SettingsSection';
import { ConfigResetToDefaultButton } from '../rows/ResetToDefaultButton';
import { type ConfigData, type SetConfig } from '../types';

export function TokenBudgetSection({ config, setConfig, hidden }: { config: ConfigData; setConfig: SetConfig; hidden: boolean }) {
  // WARDEN-946: the nested numeric prefs are only meaningful while the master
  // switch is on. The gate must be REAL — `disabled` on each Input — not just
  // `pointer-events-none` on the wrapper, which suppresses mouse hit-testing
  // only and leaves the fields tabbable, typeable, and invisible-to-AT-as-
  // disabled (an edit then dirtied the page for a field rendered as inert).
  // Mirrors NotificationsSection/TelemetrySection, which pass a real
  // `disabled` to every control inside their gated subgroup.
  const gated = !config.tokenBudgetEnabled;
  // The Input's own `disabled:` classes dim the fields; the Labels and helper
  // text are plain elements, so they're dimmed explicitly here. (Dimming the
  // wrapper instead would compound with the Input's `disabled:opacity-50` and
  // fade the fields to ~0.25.)
  const dim = gated ? 'opacity-50' : undefined;
  return (
    <SettingsSection title="Token budget" className={hidden ? 'hidden' : undefined}>
      <div className="flex items-center gap-2">
        <Switch
          id="tokenBudgetEnabled"
          checked={config.tokenBudgetEnabled ?? false}
          onCheckedChange={(v) => setConfig({ ...config, tokenBudgetEnabled: v })}
        />
        <Label htmlFor="tokenBudgetEnabled" className="cursor-pointer">
          Enable token-spend budget alerts
        </Label>
        <ConfigResetToDefaultButton label="Enable token-spend budget alerts" path="tokenBudgetEnabled" config={config} setConfig={setConfig} />
      </div>
      <p className="text-xs text-muted-foreground">
        Watch the fleet's token usage on a slow cadence and raise a desktop alert + in-app
        toast when spend crosses a threshold — so a runaway or looping agent's cost is
        caught while you're away. Model-agnostic token counts, not dollar cost. It only
        notifies; it never kills or pauses agents.
      </p>
      <div className="flex flex-col gap-4 pl-4 ml-1 border-l border-border/60">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="tokenBudgetThresholdTokens" className={dim}>Fleet threshold (tokens)</Label>
            {!gated && (
              <ConfigResetToDefaultButton label="Fleet threshold (tokens)" path="tokenBudgetThresholdTokens" config={config} setConfig={setConfig} />
            )}
          </div>
          <Input
            id="tokenBudgetThresholdTokens"
            type="number"
            min="1"
            step="100000"
            disabled={gated}
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
          <p className={cn('text-xs text-muted-foreground', dim)}>
            Total tokens spent by sessions active in the window before the fleet alarm
            fires. Leave empty for the default (2,000,000).
          </p>
          {!gated &&
            config.tokenBudgetThresholdTokens != null &&
            config.tokenBudgetThresholdTokens < 1 && (
              <p className="text-xs text-destructive">
                Must be at least 1 — capped to 1 on blur.
              </p>
            )}
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="tokenBudgetWindowHours" className={dim}>Window (hours)</Label>
            {!gated && (
              <ConfigResetToDefaultButton label="Window (hours)" path="tokenBudgetWindowHours" config={config} setConfig={setConfig} />
            )}
          </div>
          <Input
            id="tokenBudgetWindowHours"
            type="number"
            min="1"
            step="1"
            disabled={gated}
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
          <p className={cn('text-xs text-muted-foreground', dim)}>
            Which sessions count: those active in the last N hours. Each contributes its
            full lifetime token total (the existing meter), not just turns within the
            window — so a runaway that's burning tokens right now is captured. Default 24.
          </p>
          {!gated && config.tokenBudgetWindowHours != null && config.tokenBudgetWindowHours < 1 && (
            <p className="text-xs text-destructive">
              Must be at least 1 — capped to 1 on blur.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="tokenBudgetPerSessionThresholdTokens" className={dim}>Per-session threshold (tokens)</Label>
            {!gated && (
              <ConfigResetToDefaultButton label="Per-session threshold (tokens)" path="tokenBudgetPerSessionThresholdTokens" config={config} setConfig={setConfig} />
            )}
          </div>
          <Input
            id="tokenBudgetPerSessionThresholdTokens"
            type="number"
            min="1"
            step="100000"
            disabled={gated}
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
          <p className={cn('text-xs text-muted-foreground', dim)}>
            Catch the specific runaway: when any single session's lifetime total crosses
            this, Warden names it in the alert. Empty disables the per-session alarm
            (the fleet threshold still applies). Default 1,000,000.
          </p>
          {!gated &&
            config.tokenBudgetPerSessionThresholdTokens != null &&
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
