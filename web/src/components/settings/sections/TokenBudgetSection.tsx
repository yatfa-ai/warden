// Token budget section (WARDEN-415) — backend /api/config. Extracted verbatim
// from SettingsPage (WARDEN-664); behavior is unchanged.
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { SettingsSection } from '../SettingsSection';
import { ConfigResetToDefaultButton } from '../rows/ResetToDefaultButton';
import { clampToBounds, isOutOfBounds } from '../numericBounds';
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
  // WARDEN-1331 — the floors these inputs advertise come from the SERVED
  // bounds (GET /api/config). The backend has no clamp descriptor for these
  // three: they are `flooredNumber` fields whose guard floors every finite
  // number at 1, and buildBounds derives {min: 1} from that guard — the served
  // bound IS what the backend enforces.
  const fleetBounds = config.bounds.tokenBudgetThresholdTokens;
  const windowBounds = config.bounds.tokenBudgetWindowHours;
  const perSessionBounds = config.bounds.tokenBudgetPerSessionThresholdTokens;
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
            min={fleetBounds.min}
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
              // Floor at the SERVED min (the bound the input advertises) —
              // mirrors the backend flooredNumber guard. These fields are
              // null-able (empty = use the default), so only clamp when a
              // value is actually present. WARDEN-1331: bound derived, not
              // hand-copied.
              const v = config.tokenBudgetThresholdTokens;
              if (v != null && isOutOfBounds(v, fleetBounds)) {
                setConfig({ ...config, tokenBudgetThresholdTokens: clampToBounds(v, fleetBounds) });
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
            isOutOfBounds(config.tokenBudgetThresholdTokens, fleetBounds) && (
              <p className="text-xs text-destructive">
                Must be at least {fleetBounds.min} — capped to {fleetBounds.min} on blur.
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
            min={windowBounds.min}
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
              // Floor at the SERVED min — mirrors the backend flooredNumber
              // guard. Null-able (empty = use default), so only clamp when
              // non-null. (WARDEN-747 discipline, WARDEN-1331 derivation.)
              const v = config.tokenBudgetWindowHours;
              if (v != null && isOutOfBounds(v, windowBounds)) {
                setConfig({ ...config, tokenBudgetWindowHours: clampToBounds(v, windowBounds) });
              }
            }}
            placeholder="Default 24"
          />
          <p className={cn('text-xs text-muted-foreground', dim)}>
            Which sessions count: those active in the last N hours. Each contributes its
            full lifetime token total (the existing meter), not just turns within the
            window — so a runaway that's burning tokens right now is captured. Default 24.
          </p>
          {!gated && config.tokenBudgetWindowHours != null && isOutOfBounds(config.tokenBudgetWindowHours, windowBounds) && (
            <p className="text-xs text-destructive">
              Must be at least {windowBounds.min} — capped to {windowBounds.min} on blur.
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
            min={perSessionBounds.min}
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
              // Floor at the SERVED min — mirrors the backend flooredNumber
              // guard. Null-able (empty = use default / disable), so only clamp
              // when non-null; clearing the field stays null, the disable path.
              const v = config.tokenBudgetPerSessionThresholdTokens;
              if (v != null && isOutOfBounds(v, perSessionBounds)) {
                setConfig({ ...config, tokenBudgetPerSessionThresholdTokens: clampToBounds(v, perSessionBounds) });
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
            isOutOfBounds(config.tokenBudgetPerSessionThresholdTokens, perSessionBounds) && (
              <p className="text-xs text-destructive">
                Must be at least {perSessionBounds.min} — capped to {perSessionBounds.min} on blur.
              </p>
            )}
        </div>
      </div>
    </SettingsSection>
  );
}
