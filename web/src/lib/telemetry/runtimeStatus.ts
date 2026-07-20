/**
 * WARDEN-631 / WARDEN-808 — pure derivation of the RUNTIME telemetry delivery
 * status from the main→renderer bridge payload.
 *
 * This is the RUNTIME sibling of `deriveTelemetrySendingStatus` (destination.ts).
 * That function is a pure function of CONFIG prefs (`baseEnabled × endpoint`) and
 * answers "is telemetry configured to send?". This one is a pure function of the
 * pipeline's runtime DELIVERY outcome and answers "are events actually landing,
 * or is the receiver rejecting/failing them?". The two are distinct concerns:
 * telemetry can be configured (green "configured" status) yet silently losing
 * every event — to a schema mismatch (`schema-drift`, WARDEN-631) or to a
 * sustained non-415 delivery failure (`delivery-failing`, WARDEN-808).
 *
 * Kept here, separate from the React component, so the mapping is plain,
 * side-effect-free, and verifiable independent of the DOM — mirroring
 * destination.ts's and testConnection.ts's discipline. The components in
 * rows/TelemetryStatus.tsx are thin renderers over `deriveTelemetryRuntimeStatus`.
 *
 * Source of truth: the `{ drifted, deliveryFailing }` payload the main process
 * pushes (on arm/clear) and pulls (on Settings mount) over the telemetry
 * runtime-status bridge.
 * - `drifted` is true ONLY when the current endpoint returned a 415 schema mismatch
 *   and the pipeline's per-endpoint breaker is armed (sending is PAUSED); it clears
 *   on endpoint/schema change or a later successful send.
 * - `deliveryFailing` is true ONLY when the most recent N send outcomes were ALL
 *   dropped (receiver down, persistent 5xx, broken network). Pure observability:
 *   sending is NOT paused — the client keeps retrying and the next 'ok' self-heals
 *   the status. Distinct from `drifted`, which is permanent and gates dispatch.
 *
 * PRECEDENCE: `schema-drift` wins over `delivery-failing` wins over `ok`. A 415 is
 * also a run of all-drops, so when both flags hold the schema mismatch takes the
 * slot — it is the more actionable, permanent condition (the user must update a
 * schema version; delivery-failing just asks them to check the receiver is up).
 */
import type { TelemetryRuntimeStatus } from '@/lib/electron';

export type TelemetryRuntimeDriftStatus =
  // The current endpoint rejected the current schema (415) — the breaker is armed
  // and events are NOT being delivered. This is the actionable state: the user
  // must update the client or the receiver so the schema versions agree.
  | { kind: 'schema-drift' }
  // WARDEN-808 — a SUSTAINED non-415 delivery failure: the most recent N sends all
  // dropped (receiver down, persistent 5xx, broken network). Events are NOT landing,
  // but unlike schema-drift the client KEEPS sending (this is observability, not a
  // circuit breaker) — the next successful send self-heals the status.
  | { kind: 'delivery-failing' }
  // No runtime delivery issue detected. NOT a reachability or success claim — only
  // that no 415 has been observed AND the recent outcome window is not all-drops.
  | { kind: 'ok' };

/**
 * Map the runtime status payload to its rendered descriptor, with precedence
 * schema-drift > delivery-failing > ok. Pure: same input → same output, no DOM,
 * no state. A missing/ambiguous payload (null, undefined, or non-boolean flags)
 * maps to `ok` — never surface a false alarm from a malformed or absent bridge
 * message. The renderer renders a non-ok branch ONLY when the main process
 * unambiguously reported the corresponding flag as `=== true`.
 */
export function deriveTelemetryRuntimeStatus(
  status: TelemetryRuntimeStatus | null | undefined,
): TelemetryRuntimeDriftStatus {
  if (status && status.drifted === true) return { kind: 'schema-drift' };
  if (status && status.deliveryFailing === true) return { kind: 'delivery-failing' };
  return { kind: 'ok' };
}
