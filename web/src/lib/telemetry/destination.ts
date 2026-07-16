/**
 * WARDEN-557 — pure derivation of the "is anything being sent, and to where?"
 * status from the two already-persisted telemetry prefs.
 *
 * This is a *derived view of configuration only*. It does NOT touch the
 * transport (telemetry-send.js), does NOT add a consent flag, and does NOT
 * report delivery outcome (whether the receiver is reachable or accepts
 * events). Its sole job: given `baseEnabled` × `endpoint`, tell the user
 * whether their opt-in is live or silently inert — and if live, name the
 * destination host.
 *
 * Kept here, separate from the React component, so the logic is plain,
 * side-effect-free, and verifiable independent of the DOM. The component in
 * SettingsPage.tsx is a thin renderer over `deriveTelemetrySendingStatus`.
 */

/** The destination host for a configured endpoint: the URL's `host`
 *  (hostname + port when present), never the path. Derived from the
 *  configured endpoint only — never rewritten, never a hardcoded SaaS host.
 *
 *  - Strict parse first. If the user omitted the scheme (a bare host like
 *    `receiver.example/ingest` is the common self-hoster mistake), retry with
 *    an `https://` prefix so we can still surface a clean host.
 *  - If neither parses, fall back to the raw trimmed value rather than guess.
 *  - Returns '' for an empty/whitespace input; callers treat that as
 *    "unconfigured" before ever relying on the label.
 */
export function telemetryDestinationLabel(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed).host || trimmed;
  } catch {
    try {
      // Lenient: a bare host has no scheme, so the strict parse above threw.
      return new URL('https://' + trimmed).host || trimmed;
    } catch {
      return trimmed;
    }
  }
}

export type TelemetrySendingStatus =
  // Base consent off — off is off; the UI renders no sending status.
  | { kind: 'off' }
  // Base on but no receiver endpoint — the silently-inert opt-in: the
  // transport no-ops, events buffer in memory and are dropped.
  | { kind: 'unconfigured' }
  // Base on and a receiver endpoint is set — events will go to `destination`.
  // `destination` is host-only (no path) and is NOT a reachability claim.
  | { kind: 'configured'; destination: string };

/**
 * Derive the honest sending status from the live config prefs. Pure: same
 * inputs → same output, no stale closures. The endpoint is trimmed for the
 * blank check so a whitespace-only field reads as "unconfigured" (a real URL
 * has not been set); the persisted value itself is left untouched.
 */
export function deriveTelemetrySendingStatus({
  baseEnabled,
  endpoint,
}: {
  baseEnabled: boolean;
  endpoint: string;
}): TelemetrySendingStatus {
  if (!baseEnabled) return { kind: 'off' };
  // telemetryDestinationLabel('') === '', and for any non-blank input it
  // returns a non-empty host (or the raw value), so emptiness here is exactly
  // "no real endpoint configured".
  const destination = telemetryDestinationLabel(endpoint);
  return destination ? { kind: 'configured', destination } : { kind: 'unconfigured' };
}
