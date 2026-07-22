// Telemetry section (WARDEN-457/522/557/569/595/631) — backend /api/config +
// write-only receiver auth token + the live test-connection probe + runtime
// schema-drift status. Extracted verbatim from SettingsPage (WARDEN-664);
// behavior is unchanged.
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { TelemetryTransparency } from '@/components/TelemetryTransparency';
import { describeTelemetryTestVerdict, type TelemetryTestVerdict } from '@/lib/telemetry/testConnection';
import { deriveTelemetryRuntimeStatus } from '@/lib/telemetry/runtimeStatus';
import { telemetryDestinationLabel } from '@/lib/telemetry/destination';
import { type TelemetryRuntimeStatus } from '@/lib/electron';
import {
  TelemetrySendingStatus,
  TelemetryRuntimeDriftStatus,
  TelemetryRuntimeDeliveryFailingStatus,
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
  // WARDEN-883 — the Remove action queues a clear (pendingClear → save sends
  // explicit null). undoRemove cancels a queued clear before Save.
  telemetryAuthTokenPendingClear: boolean;
  removeTelemetryAuthToken: () => void;
  undoRemoveTelemetryAuthToken: () => void;
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
  telemetryAuthTokenPendingClear,
  removeTelemetryAuthToken,
  undoRemoveTelemetryAuthToken,
  telemetryTestLoading,
  telemetryTestVerdict,
  setTelemetryTestVerdict,
  sendTestConnection,
  telemetryRuntimeStatus,
  hidden,
}: TelemetrySectionProps) {
  // WARDEN-631/808 — derive the runtime delivery status ONCE. Precedence:
  // schema-drift (415, sending paused) wins over delivery-failing (sustained drops,
  // still retrying) wins over the default sending status. Gated on baseEnabled in
  // the JSX below so NEITHER runtime banner shows when telemetry is off.
  const runtimeKind = deriveTelemetryRuntimeStatus(telemetryRuntimeStatus).kind;
  // WARDEN-883 — confirm the irreversible token removal before queueing it.
  const [confirmRemoveOpen, setConfirmRemoveOpen] = useState(false);
  return (
    <>
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
          (see TelemetrySendingStatus). Placed here, directly above the
          endpoint field, so the cause (blank endpoint) and the consequence
          (nothing sent) read together. Reads the same `config` the toggles/
          field mutate via setConfig, so it updates live with no stale-closure
          / shadow state.
          WARDEN-631/808 — when telemetry is ON, a RUNTIME delivery issue takes
          this slot instead, because "events will go to X" is misleading while X
          is rejecting or refusing every send. schema-drift (a 415, sending paused)
          takes precedence over delivery-failing (sustained non-415 drops, still
          retrying) — a 415 is also a run of all-drops, so it must win the slot.
          Gated on baseEnabled so neither runtime banner shows when telemetry is
          off (both are moot then). */}
      {config.telemetryBaseEnabled && runtimeKind === 'schema-drift' ? (
        <TelemetryRuntimeDriftStatus
          destination={telemetryDestinationLabel(config.telemetryEndpoint)}
        />
      ) : config.telemetryBaseEnabled && runtimeKind === 'delivery-failing' ? (
        <TelemetryRuntimeDeliveryFailingStatus
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
        <div className="flex items-center gap-2">
          <Input
            id="telemetryAuthToken"
            type="password"
            className="flex-1"
            value={telemetryAuthTokenInput}
            onChange={(e) => {
              setTelemetryAuthTokenInput(e.target.value);
              // An edited token invalidates any prior probe result.
              setTelemetryTestVerdict(null);
            }}
            placeholder={
              telemetryAuthTokenPendingClear
                ? 'Will be removed on Save'
                : telemetryAuthTokenSet
                  ? `••••• set${telemetryAuthTokenTail ? ` (…${telemetryAuthTokenTail})` : ''}`
                  : 'Not set'
            }
          />
          {/* WARDEN-883 — Remove surfaces only when a token is stored and not
              already queued for removal. The confirm dialog gates the click. */}
          {telemetryAuthTokenSet && !telemetryAuthTokenPendingClear && (
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => setConfirmRemoveOpen(true)}
            >
              Remove
            </Button>
          )}
        </div>
        {telemetryAuthTokenPendingClear ? (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            The saved token will be removed when you press Save.{' '}
            <button
              type="button"
              className="underline cursor-pointer"
              onClick={undoRemoveTelemetryAuthToken}
            >
              Undo
            </button>
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {telemetryAuthTokenSet
              ? `A token is saved${telemetryAuthTokenTail ? ` (ends …${telemetryAuthTokenTail})` : ''}. It is sent as Authorization: Bearer so a receiver that requires auth (AUTH_TOKEN) accepts your events. Type a new one to replace it; leave blank to keep it.`
              : 'Optional. Sent as Authorization: Bearer when your receiver is gated by a shared secret (AUTH_TOKEN). Leave blank if your receiver runs open.'}
          </p>
        )}
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

    {/* WARDEN-883 — confirm the token removal before queueing the clear. */}
    <ConfirmDialog
      open={confirmRemoveOpen}
      onOpenChange={(o) => { if (!o) setConfirmRemoveOpen(false); }}
      title="Remove saved receiver auth token?"
      description="The stored telemetry auth token will be deleted from config.json, and events will be sent without an Authorization: Bearer header (works against an AUTH_TOKEN-unset receiver). You'll need to re-enter a token if your receiver requires one. Applies when you press Save."
      confirmLabel="Remove token"
      destructive
      onConfirm={() => { removeTelemetryAuthToken(); setConfirmRemoveOpen(false); }}
    />
    </>
  );
}
