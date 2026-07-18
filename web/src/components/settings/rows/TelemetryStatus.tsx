// The two Telemetry-section status banners — pure presentational views of
// already-bound state (no new state, no transport). Extracted verbatim from
// SettingsPage (WARDEN-664); behavior is unchanged. A row file rather than a
// section because neither is a `<SettingsSection>` body — they render inline
// inside the Telemetry section above the endpoint field.
import { AlertTriangle, Send } from 'lucide-react';
import { deriveTelemetrySendingStatus } from '@/lib/telemetry/destination';

/**
 * WARDEN-557 — the honest "is signal actually flowing?" status for the
 * Telemetry section. A pure, live-derived view of the two already-bound prefs
 * `telemetryBaseEnabled` × `telemetryEndpoint` (no new consent flag, no
 * transport change, no delivery feedback). It reads the same values the
 * consent toggles and endpoint field use, so it re-renders the instant either
 * changes — there is no shadow state.
 *
 * Three states (see deriveTelemetrySendingStatus):
 *  - base OFF → renders nothing (off is off).
 *  - base ON + blank endpoint → amber notice: enabled but no receiver is
 *    configured, so nothing is being sent (the silently-inert opt-in).
 *  - base ON + endpoint set → positive destination confirmation (host only,
 *    derived from the configured URL; NOT a reachability claim).
 */
export function TelemetrySendingStatus({
  baseEnabled,
  endpoint,
}: {
  baseEnabled: boolean;
  endpoint: string;
}) {
  const status = deriveTelemetrySendingStatus({ baseEnabled, endpoint });
  if (status.kind === 'off') return null;
  if (status.kind === 'unconfigured') {
    return (
      // role="status" (an aria-live=polite region): the whole point of this
      // slice is that the status updates live as the user toggles base consent
      // or edits the endpoint. The unconfigured notice is the state change most
      // worth announcing — "you opted in, but nothing is being sent yet."
      <div
        role="status"
        className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs"
      >
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
        <p className="text-amber-800 dark:text-amber-200">
          <span className="font-medium">Enabled, but nothing is being sent.</span>{' '}
          No receiver endpoint is configured, so events buffer in memory and are
          dropped. Add a receiver URL below for signal to flow.
        </p>
      </div>
    );
  }
  return (
    // role="status": a live region so the transition INTO "configured" (user
    // pastes a receiver URL) is announced alongside the unconfigured notice above.
    <div
      role="status"
      className="flex items-start gap-2 rounded-md border border-green-500/30 bg-green-500/5 px-3 py-2 text-xs"
    >
      <Send className="mt-0.5 size-3.5 shrink-0 text-green-600 dark:text-green-400" aria-hidden />
      <p className="text-muted-foreground">
        <span className="font-medium text-foreground">
          Configured — events will go to {status.destination}.
        </span>{' '}
        That is the receiver host above; warden does not verify whether the
        receiver is reachable or accepts events.
      </p>
    </div>
  );
}

/**
 * WARDEN-631 — the RUNTIME schema-drift warning. Unlike TelemetrySendingStatus
 * (a pure view of CONFIG prefs — "is telemetry configured to send?"), this is a
 * view of the pipeline's runtime DELIVERY outcome: the receiver has rejected the
 * current schema (415), the per-endpoint circuit-breaker is armed, and events are
 * NOT being delivered — even though the config-time status says "configured".
 *
 * Renders ONLY when main reports `drifted === true` (see
 * deriveTelemetryRuntimeStatus). When active it takes the place of the green
 * "configured" status below, because "events will go to X" is false while the
 * receiver rejects the schema. The status updates LIVE (the bridge pushes on
 * arm/clear), so the warning appears the moment a 415 lands without reopening
 * Settings — turning a silent permanent loss into a visible, actionable state.
 */
export function TelemetryRuntimeDriftStatus({ destination }: { destination: string }) {
  return (
    // role="status" (an aria-live=polite region), mirroring TelemetrySendingStatus:
    // the status appears the moment a 415 arms (the bridge pushes on arm/clear),
    // without reopening Settings — turning a silent permanent loss into a visible,
    // announced state. Polite (not alert) because the warning persists until the
    // mismatch resolves; an assertive alert would re-announce on every re-render.
    <div
      role="status"
      data-telemetry-runtime-status="schema-drift"
      className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs"
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
      <p className="text-amber-800 dark:text-amber-200">
        <span className="font-medium">Schema mismatch — events are not being delivered.</span>{' '}
        Telemetry is on, but{destination ? <> your receiver at{' '}
        <span className="font-medium">{destination}</span></> : ' your receiver'} rejected it as a
        schema-version mismatch. Further sends to this endpoint are paused to avoid
        losing every event. Update the client or the receiver so the schema versions
        agree, then click Test connection below to confirm and resume delivery.
      </p>
    </div>
  );
}
