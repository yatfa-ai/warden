/**
 * WARDEN-631 — pure derivation of the RUNTIME telemetry drift status from the
 * main→renderer bridge payload.
 *
 * This is the RUNTIME sibling of `deriveTelemetrySendingStatus` (destination.ts).
 * That function is a pure function of CONFIG prefs (`baseEnabled × endpoint`) and
 * answers "is telemetry configured to send?". This one is a pure function of the
 * pipeline's runtime DELIVERY outcome and answers "are events actually being
 * delivered, or is the receiver rejecting them as a schema mismatch?". The two
 * are distinct concerns: telemetry can be configured (green "configured" status)
 * yet silently losing every event to a version mismatch (this `schema-drift`
 * status) — which is the exact gap WARDEN-631 closes.
 *
 * Kept here, separate from the React component, so the mapping is plain,
 * side-effect-free, and verifiable independent of the DOM — mirroring
 * destination.ts's and testConnection.ts's discipline. The component in
 * SettingsPage.tsx is a thin renderer over `deriveTelemetryRuntimeStatus`.
 *
 * Source of truth: the `{ drifted }` payload the main process pushes (on arm/clear)
 * and pulls (on Settings mount) over the telemetry runtime-status bridge. `drifted`
 * is true ONLY when the current endpoint returned a 415 schema mismatch and the
 * pipeline's per-endpoint breaker is armed; it clears on endpoint/schema change or
 * a later successful send.
 */
import type { TelemetryRuntimeStatus } from '@/lib/electron';

export type TelemetryRuntimeDriftStatus =
  // The current endpoint rejected the current schema (415) — the breaker is armed
  // and events are NOT being delivered. This is the actionable state: the user
  // must update the client or the receiver so the schema versions agree.
  | { kind: 'schema-drift' }
  // No runtime drift detected (the breaker is not armed). NOT a reachability or
  // success claim — only that no 415 has been observed for the current endpoint.
  | { kind: 'ok' };

/**
 * Map the runtime drift payload to its rendered descriptor. Pure: same input →
 * same output, no DOM, no state. A missing/ambiguous payload (null, undefined, or
 * a non-boolean `drifted`) maps to `ok` — never surface a false drift alarm from
 * a malformed or absent bridge message. The renderer renders the `schema-drift`
 * branch ONLY when the main process unambiguously reported `drifted === true`.
 */
export function deriveTelemetryRuntimeStatus(
  status: TelemetryRuntimeStatus | null | undefined,
): TelemetryRuntimeDriftStatus {
  if (status && status.drifted === true) return { kind: 'schema-drift' };
  return { kind: 'ok' };
}
