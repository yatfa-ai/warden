// Observer Preferences section (backend /api/config + write-only auth token).
// Extracted verbatim from SettingsPage (WARDEN-664); behavior is unchanged.
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingsSection } from '../SettingsSection';
import { type ConfigData, type SetConfig } from '../types';

export interface ObserverSectionProps {
  config: ConfigData;
  setConfig: SetConfig;
  // Write-only auth token (WARDEN-350): GET returns only a masked set + tail
  // indicator, so the input stays empty until the human types a new token; on
  // save it is sent ONLY when non-empty (handled in useBackendConfig.handleSave).
  observerAuthTokenSet: boolean;
  observerAuthTokenTail: string | null;
  observerAuthTokenInput: string;
  setObserverAuthTokenInput: (v: string) => void;
  hidden: boolean;
}

export function ObserverSection({
  config,
  setConfig,
  observerAuthTokenSet,
  observerAuthTokenTail,
  observerAuthTokenInput,
  setObserverAuthTokenInput,
  hidden,
}: ObserverSectionProps) {
  return (
    <SettingsSection title="Observer Preferences" className={hidden ? 'hidden' : undefined}>
      <div className="flex flex-col gap-2">
        <Label htmlFor="observerConfirmMode">Directive Confirmation</Label>
        <Select
          value={config.observerConfirmMode}
          onValueChange={(v) =>
            setConfig({ ...config, observerConfirmMode: v as 'always' | 'auto-safe' })
          }
        >
          <SelectTrigger id="observerConfirmMode" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="always">Always confirm (default)</SelectItem>
            <SelectItem value="auto-safe">Auto-send safe directives</SelectItem>
          </SelectContent>
        </Select>
        {config.observerConfirmMode === 'auto-safe' && (
          <p className="text-xs text-muted-foreground">
            When "Auto-send safe", read-only directives (list, read) skip confirmation.
          </p>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Switch
          id="observerAutoStart"
          checked={config.observerAutoStart}
          onCheckedChange={(v) => setConfig({ ...config, observerAutoStart: v })}
        />
        <Label htmlFor="observerAutoStart" className="cursor-pointer">
          Auto-start Observer
        </Label>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="observerSessionTimeout">Session Auto-stop (minutes)</Label>
        <Input
          id="observerSessionTimeout"
          type="number"
          min="1"
          max="180"
          step="1"
          value={config.observerSessionTimeout ?? ''}
          onChange={(e) =>
            setConfig({
              ...config,
              observerSessionTimeout: e.target.value ? parseInt(e.target.value) : null,
            })
          }
          onBlur={() => {
            // [WARDEN-867]: clamp the committed value into the [1, 180] bounds
            // the input advertises — mirrors WARDEN-747 (connectTimeout bilateral
            // clamp + tokenBudget nullable floor). Null is the disable path and
            // stays null; only clamp when a value is present.
            const v = config.observerSessionTimeout;
            if (v != null) {
              const clamped = Math.min(180, Math.max(1, v));
              if (clamped !== v) setConfig({ ...config, observerSessionTimeout: clamped });
            }
          }}
          placeholder="Disabled when empty"
        />
        {config.observerSessionTimeout != null &&
          (config.observerSessionTimeout < 1 || config.observerSessionTimeout > 180) && (
            <p className="text-xs text-destructive">
              Must be between 1 and 180 minutes — capped to{' '}
              {Math.min(180, Math.max(1, config.observerSessionTimeout))} on blur.
            </p>
          )}
        <p className="text-xs text-muted-foreground">
          Automatically stop Observer after N minutes of inactivity. Leave empty to disable.
        </p>
      </div>

      {/* Observer model/provider (WARDEN-350) — configure the Observer's
          LLM from the UI instead of hand-editing ~/.yatfa-warden/config.json
          or exporting shell env vars. Applies live: the next Observer call
          re-reads model/baseUrl/token via llm.js's per-call resolvers and
          reads maxTokens from the live cfg ref, with NO app restart. The
          auth token is write-only (never seeded from GET; sent only when
          typed so the stored secret survives an unchanged save). */}
      <div className="flex flex-col gap-3 rounded-md border bg-muted/30 p-3">
        <div className="text-xs font-medium text-foreground">Observer model</div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="observerModel">Model</Label>
          <Input
            id="observerModel"
            value={config.llm.model}
            onChange={(e) => setConfig({ ...config, llm: { ...config.llm, model: e.target.value } })}
            placeholder="glm-5.2"
          />
          <p className="text-xs text-muted-foreground">
            The model id the Observer uses. A trailing context tag like <code className="bg-muted px-1 rounded">[1m]</code> is stripped automatically. Falls back to the WARDEN_MODEL env var, then the default (glm-5.2).
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="observerBaseUrl">Base URL</Label>
          <Input
            id="observerBaseUrl"
            value={config.llm.baseUrl}
            onChange={(e) => setConfig({ ...config, llm: { ...config.llm, baseUrl: e.target.value } })}
            placeholder="https://api.anthropic.com"
          />
          <p className="text-xs text-muted-foreground">
            Anthropic-Messages-compatible endpoint. Leave blank for the default (https://api.anthropic.com) or an ANTHROPIC_BASE_URL env var.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="observerAuthToken">Auth token</Label>
          <Input
            id="observerAuthToken"
            type="password"
            value={observerAuthTokenInput}
            onChange={(e) => setObserverAuthTokenInput(e.target.value)}
            placeholder={observerAuthTokenSet ? `••••• set${observerAuthTokenTail ? ` (…${observerAuthTokenTail})` : ''}` : 'Not set'}
          />
          <p className="text-xs text-muted-foreground">
            {observerAuthTokenSet
              ? `A token is saved${observerAuthTokenTail ? ` (ends …${observerAuthTokenTail})` : ''}. Type a new one to replace it; leave blank to keep the saved token.`
              : 'No token saved here. Enter one to authenticate the Observer, or leave blank to keep using env / config-file credentials.'}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="observerMaxTokens">Max output tokens</Label>
          <Input
            id="observerMaxTokens"
            type="number"
            min="1"
            step="1"
            value={config.llm.maxTokens ?? ''}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              setConfig({ ...config, llm: { ...config.llm, maxTokens: e.target.value === '' || Number.isNaN(n) ? null : n } });
            }}
            placeholder="2048 (default)"
          />
          <p className="text-xs text-muted-foreground">
            Maximum tokens the Observer model may generate per call. Leave empty for the default (2048).
          </p>
        </div>
      </div>
    </SettingsSection>
  );
}
