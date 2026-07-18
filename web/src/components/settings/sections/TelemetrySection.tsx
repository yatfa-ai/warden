// Telemetry section (WARDEN-457/522/557/569/595/631) — backend /api/config +
// write-only receiver auth token + the live test-connection probe + runtime
// schema-drift status. Extracted verbatim from SettingsPage (WARDEN-664);
// behavior is unchanged.
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { TelemetryTransparency } from '@/components/TelemetryTransparency';
import { describeTelemetryTestVerdict, type TelemetryTestVerdict } from '@/lib/telemetry/testConnection';
import { deriveTelemetryRuntimeStatus } from '@/lib/telemetry/runtimeStatus';
import { telemetryDestinationLabel } from '@/lib/telemetry/destination';
import { type TelemetryRuntimeStatus } from '@/lib/electron';
import {
  TelemetrySendingStatus,
  TelemetryRuntimeDriftStatus,
} from '../rows/TelemetryStatus';
import { SettingsSection } from '../SettingsSection';
import { type ConfigData, type SetConfig } from '../types';

export interface TelemetrySectionProps {
  config: ConfigData;
  setConfig: SetConfig;
  // Write-only receiver auth token (WARDEN-569).
  telemetryAuthTokenSet: boolean;
  telemetryAuthTokenTail: string | null;
  telemetryAuthTokenInput: string;
  setTelemetryAuthTokenInput: (v: string) => void;
  // Live test-connection probe (WARDEN-595) — never persisted.
  telemetryTestLoading: boolean;
  telemetryTestVerdict: TelemetryTestVerdict | null;
  setTelemetryTestVerdict: (v: TelemetryTestVerdict | null) => void;
  sendTestConnection: () => void;
  // Runtime schema-drift status (WARDEN-631) — pushed from main, live-only.
  telemetryRuntimeStatus: TelemetryRuntimeStatus | null;
  hidden: boolean;
}

export function TelemetrySection({
  config,
  setConfig,
  telemetryAuthTokenSet,
  telemetryAuthTokenTail,
  telemetryAuthTokenInput,
  setTelemetryAuthTokenInput,
  telemetryTestLoading,
  telemetryTestVerdict,
  setTelemetryTestVerdict,
  sendTestConnection,
  telemetryRuntimeStatus,
  hidden,
}: TelemetrySectionProps) {
  return (
    <SettingsSection title="Telemetry" className={hidden ? 'hidden' : undefined}>
      <p className="text-xs text-muted-foreground">
        Optional, off by default. Help improve warden by sending
        anonymous diagnostics. Nothing is sent until you turn a tier on,
        and the destination is a self-hosted receiver — no third-party
        analytics service. You can revoke either tier at any time.
      </p>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Switch
            id="telemetryBaseEnabled"
            checked={config.telemetryBaseEnabled}
            onCheckedChange={(v) =>
              setConfig({
                ...config,
                telemetryBaseEnabled: v,
                // Turning base off also revokes extended
                // (extended-requires-base). The server re-clamps on
                // save; this keeps the toggle honest in the meantime.
                telemetryExtendedEnabled: v && config.telemetryExtendedEnabled,
              })
            }
          />
          <Label htmlFor="telemetryBaseEnabled" className="cursor-pointer">
            Anonymous errors, crashes &amp; freezes
          </Label>
        </div>
        <p className="text-xs text-muted-foreground">
          Base tier. Anonymous error, crash, and event-loop-freeze
          reports — no chat content, no file paths, no hostnames, no
          credentials.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Switch
            id="telemetryExtendedEnabled"
            checked={config.telemetryExtendedEnabled}
            disabled={!config.telemetryBaseEnabled}
            onCheckedChange={(v) =>
              // Disabled while base is off, so a toggle only arrives
              // with base on. Guard anyway: extended requires base.
              setConfig({ ...config, telemetryExtendedEnabled: v && config.telemetryBaseEnabled })
            }
          />
          <Label htmlFor="telemetryExtendedEnabled" className="cursor-pointer">
            Also include chat &amp; session names
          </Label>
        </div>
        <p className="text-xs text-muted-foreground">
          Extended tier (requires the base tier). Additionally includes
          chat names and Claude session names to help diagnose reports.
          Chat <em>content</em> is never sent — names only.
        </p>
      </div>

      {/* WARDEN-557 — honest sending status. A pure derived view of
          config.telemetryBaseEnabled × config.telemetryEndpoint
          (see TelemetrySendingStatus above). Placed here, directly
          above the endpoint field, so the cause (blank endpoint)
          and the consequence (nothing sent) read together. Reads the
          same `config` the toggles/field mutate via setConfig, so it
          updates live with no stale-closure / shadow state.
          WARDEN-631 — when telemetry is ON and the RUNTIME breaker is
          armed (the receiver rejected the schema), the drift warning
          takes this slot instead: "events will go to X" is false while
          X rejects them. Gated on baseEnabled so a stale drift flag
          never shows when telemetry is off (drift is moot then). */}
      {config.telemetryBaseEnabled
      && deriveTelemetryRuntimeStatus(telemetryRuntimeStatus).kind === 'schema-drift' ? (
        <TelemetryRuntimeDriftStatus
          destination={telemetryDestinationLabel(config.telemetryEndpoint)}
        />
      ) : (
        <TelemetrySendingStatus
          baseEnabled={config.telemetryBaseEnabled}
          endpoint={config.telemetryEndpoint}
        />
      )}

      <div className="flex flex-col gap-2">
        <Label htmlFor="telemetryEndpoint">Receiver endpoint</Label>
        <Input
          id="telemetryEndpoint"
          value={config.telemetryEndpoint}
          onChange={(e) => {
            setConfig({ ...config, telemetryEndpoint: e.target.value });
            // An edited endpoint invalidates any prior probe result.
            setTelemetryTestVerdict(null);
          }}
          placeholder="https://your-receiver.example/ingest"
        />
        <p className="text-xs text-muted-foreground">
          Leave blank for unconfigured (sends nothing). Events go only to this URL — a self-hosted receiver you control, never a third-party analytics service.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="telemetryAuthToken">Receiver auth token (optional)</Label>
        <Input
          id="telemetryAuthToken"
          type="password"
          value={telemetryAuthTokenInput}
          onChange={(e) => {
            setTelemetryAuthTokenInput(e.target.value);
            // An edited token invalidates any prior probe result.
            setTelemetryTestVerdict(null);
          }}
          placeholder={telemetryAuthTokenSet ? `••••• set${telemetryAuthTokenTail ? ` (…${telemetryAuthTokenTail})` : ''}` : 'Not set'}
        />
        <p className="text-xs text-muted-foreground">
          {telemetryAuthTokenSet
            ? `A token is saved${telemetryAuthTokenTail ? ` (ends …${telemetryAuthTokenTail})` : ''}. It is sent as Authorization: Bearer so a receiver that requires auth (AUTH_TOKEN) accepts your events. Type a new one to replace it; leave blank to keep it.`
            : 'Optional. Sent as Authorization: Bearer when your receiver is gated by a shared secret (AUTH_TOKEN). Leave blank if your receiver runs open.'}
        </p>
      </div>

      {/* WARDEN-595 — config-time "Test connection" probe. The destination
          label above ("configured") is deliberately NOT a reachability
          claim; this turns it into a verified one on demand. The probe goes
          through the backend (renderer→receiver is cross-origin), tests the
          endpoint/token from the in-memory draft (before Save), and renders a
          precise multi-line verdict. The result is never persisted (a cached
          "connected" goes stale) — it recomputes on every click. */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={sendTestConnection}
            disabled={telemetryTestLoading || !config.telemetryEndpoint.trim()}
          >
            {telemetryTestLoading ? 'Testing…' : 'Test connection'}
          </Button>
          <span className="text-xs text-muted-foreground">
            Verifies the receiver is reachable, schema-matched, and authed. Uses the endpoint above — no Save required.
          </span>
        </div>
        {telemetryTestVerdict && (() => {
          const { tone, label } = describeTelemetryTestVerdict(telemetryTestVerdict);
          return (
            <div
              className={
                tone === 'positive'
                  ? 'rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400'
                  : 'rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400'
              }
              data-telemetry-test-verdict={telemetryTestVerdict.kind}
              role={tone === 'positive' ? 'status' : 'alert'}
            >
              <p className="font-medium">{label}</p>
              <p>{telemetryTestVerdict.message}</p>
            </div>
          );
        })()}
      </div>

      {/* WARDEN-526 — read-only "What telemetry sends" verifiability
          panel. Renders WARDEN-508's describeCollection (per-tier
          collection catalog) + previewPayload (exact redacted payload
          of a sample event) so an opt-in user can inspect precisely
          what is transmitted. Pure functions, no transport, no new
          consent flag; read-only. Placed last in the section so the
          flow reads: consent toggles → endpoint → inspect payload. */}
      <TelemetryTransparency
        telemetryBaseEnabled={config.telemetryBaseEnabled}
        telemetryExtendedEnabled={config.telemetryExtendedEnabled}
      />
    </SettingsSection>
  );
}
