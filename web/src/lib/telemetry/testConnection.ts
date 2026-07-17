/**
 * WARDEN-595 — pure derivation of the "Test connection" probe's DISPLAY descriptor
 * from a backend verdict. The renderer cannot reach the receiver directly (cross-
 * origin → CORS-blocked), so the probe goes through POST /api/telemetry-test; the
 * backend returns the verdict, and THIS module turns it into the { tone, label }
 * the Settings UI renders (a short title + the backend's detailed message, colored
 * by tone). Kept here, separate from the React component, so the four-state mapping
 * is plain, side-effect-free, and verifiable independent of the DOM — mirroring
 * destination.ts's discipline.
 *
 * The verdict itself is NEVER persisted (a cached "connected" goes stale: receiver
 * down, token rotated); this module only shapes a result that is already live.
 */

/** The verdict shape returned by POST /api/telemetry-test. Mirrors the backend's
 *  mapCapabilitiesVerdict result (src/telemetry-capabilities.js). `kind`
 *  discriminates the four states; `ok` is the binary reachability+schema-match
 *  signal; `message` is the honest, user-facing copy. */
export type TelemetryTestVerdict = {
  kind: 'connected' | 'schema-drift' | 'auth-required' | 'no-receiver';
  ok: boolean;
  message: string;
};

export type TelemetryTestVerdictTone = 'positive' | 'warning';

/** A short, fixed label per verdict kind — the title line above the backend's
 *  detailed `message`. Distinct for each of the four states so the outcome is
 *  legible at a glance, even before the message is read. */
const VERDICT_LABELS: Record<TelemetryTestVerdict['kind'], string> = {
  connected: 'Connected',
  'schema-drift': 'Schema mismatch',
  'auth-required': 'Auth required',
  'no-receiver': 'No receiver',
};

/**
 * Map a probe verdict to its display descriptor. Pure: same verdict → same
 * descriptor, no DOM, no state. `tone` is 'positive' only for the one affirmative
 * state (connected) — every other outcome is a 'warning' the user must act on.
 * Falls back to a neutral 'warning' for an unrecognized kind so a surprise backend
 * shape never throws in the renderer.
 */
export function describeTelemetryTestVerdict(verdict: TelemetryTestVerdict): {
  tone: TelemetryTestVerdictTone;
  label: string;
} {
  const label = VERDICT_LABELS[verdict?.kind] ?? 'No receiver';
  // `ok` is the source of truth for tone — connected is the only affirmative. A
  // verdict whose kind says connected but whose ok is false (shouldn't happen, but
  // is defensive) still renders as a warning: never show a green "success" tone for
  // anything that is not unambiguously ok.
  const tone: TelemetryTestVerdictTone = verdict?.ok === true ? 'positive' : 'warning';
  return { tone, label };
}
