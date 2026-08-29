/**
 * WARDEN-557 — pure derivation of the "is anything being sent, and to where?"
 * status from the two already-persisted telemetry prefs.
 *
 * This is a *derived view of configuration only*. It does NOT touch the
 * transport (telemetry-send.js), does NOT add a consent flag, and does NOT
 * report delivery outcome (whether the receiver is reachable or accepts
 * events). Its sole job: given `collecting` × `endpoint`, tell the user
 * whether their opt-in is live or silently inert — and if live, name the
 * destination host.
 *
 * Kept here, separate from the React component, so the logic is plain,
 * side-effect-free, and verifiable independent of the DOM. The component in
 * SettingsPage.tsx is a thin renderer over `deriveTelemetrySendingStatus`.
 */

/**
 * WARDEN-1238 — does the configured endpoint, AS CONFIGURED, resolve to a usable
 * web address? Parse success is NOT a validity test: `new URL('host:8080/ingest')`
 * parses without throwing (WHATWG reads `host:` as an opaque scheme) but yields
 * origin "null"; and a bare host does not parse at all. The telemetry transport
 * (telemetry-send.js) POSTs the endpoint string EXACTLY as configured — it never
 * rewrites the address — so only a strict http/https parse with a real origin is
 * an address events can actually be sent to.
 *
 * This predicate is the browser-side statement of src/telemetry-capabilities.js's
 * isUsableWebUrl: the two trees cannot import from each other (see
 * CLIENT_SCHEMA_VERSION for the same discipline), so it is stated twice and kept
 * honest by tests on both sides.
 */
function parseUsableWebUrl(candidate: string): URL | null {
  try {
    const url = new URL(candidate);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== 'null') {
      return url;
    }
    return null;
  } catch {
    return null;
  }
}

// WARDEN-1238 — does this scheme-less-looking input actually NAME a web host?
// Mirrors the backend's webOriginFromEndpoint branch logic: a strict parse that
// produced NO host at all (WHATWG misread `receiver.example:` in
// `receiver.example:8080/ingest` as an opaque scheme) is really a scheme-less
// host:port/path — the lenient https:// retry should apply so the host it names
// is recognised. A strict parse that DID produce a host under a non-web scheme
// (postgres://db.example, ssh://host) is the user's chosen scheme — respect it:
// not usable, never rewritten.
function lenientHostForSchemeless(trimmed: string): string | null {
  try {
    const lenient = new URL('https://' + trimmed);
    if (lenient.origin !== 'null') return lenient.host || null;
  } catch {
    // Unparseable even with the prefix.
  }
  return null;
}

/** The destination host for a configured endpoint: the URL's `host`
 *  (hostname + port when present), never the path. Derived from the
 *  configured endpoint only — never rewritten, never a hardcoded SaaS host.
 *
 *  WARDEN-1238 — judged by whether the address resolves to a usable WEB origin,
 *  not by whether it parses at all:
 *   - Strict http/https parse first: the address as configured names its own host.
 *   - Scheme-less address (bare host, or host:port/path where WHATWG misreads the
 *     host as a scheme and yields origin "null"): retry with an `https://` prefix
 *     so we can still surface the host of the address the user typed. The label
 *     still reflects the typed address (its host, port included, path stripped) —
 *     the https:// prefix is only a parse aid, never displayed and never a claim
 *     that the address is usable as configured (see isUsableTelemetryEndpoint).
 *  - If neither parses, fall back to the raw trimmed value rather than guess.
 *  - Returns '' for an empty/whitespace input; callers treat that as
 *    "unconfigured" before ever relying on the label.
 */
export function telemetryDestinationLabel(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const strict = parseUsableWebUrl(trimmed);
  if (strict) return strict.host || trimmed;
  // Not usable as-configured. If the strict parse produced no host (or threw),
  // treat it as scheme-less and surface the host of the address the user typed.
  let strictHadHost = false;
  try {
    strictHadHost = new URL(trimmed).host !== '';
  } catch {
    strictHadHost = false;
  }
  if (!strictHadHost) {
    const lenient = lenientHostForSchemeless(trimmed);
    if (lenient) return lenient;
  }
  return trimmed;
}

/** WARDEN-1238 — is the configured endpoint an address the transport can send to
 *  as-is? True only for a strict http/https URL with a real origin. A scheme-less
 *  address (bare host, or host:port/path) is NOT: the transport never rewrites
 *  the configured address, so such an endpoint is inert no matter what it names. */
export function isUsableTelemetryEndpoint(raw: string): boolean {
  const trimmed = raw.trim();
  return !!trimmed && parseUsableWebUrl(trimmed) !== null;
}

export type TelemetrySendingStatus =
  // Nothing is being collected — off is off; the UI renders no sending status.
  | { kind: 'off' }
  // Collecting but no receiver endpoint — the silently-inert opt-in: the
  // transport no-ops, events buffer in memory and are dropped.
  | { kind: 'unconfigured' }
  // WARDEN-1238 — collecting with a NON-BLANK endpoint that is NOT a usable web
  // address (no scheme: bare host, or host:port/path). The transport POSTs the
  // endpoint exactly as configured and never rewrites it, so this opt-in is just
  // as inert as unconfigured — but for a DIFFERENT, fixable reason, so it gets its
  // own state and copy: "add https://" rather than "no endpoint set".
  | { kind: 'needs-scheme'; destination: string }
  // Collecting and a receiver endpoint is set — events will go to `destination`.
  // `destination` is host-only (no path) and is NOT a reachability claim.
  | { kind: 'configured'; destination: string };

/**
 * Derive the honest sending status from the live config prefs. Pure: same
 * inputs → same output, no stale closures. The endpoint is trimmed for the
 * blank check so a whitespace-only field reads as "unconfigured" (a real URL
 * has not been set); the persisted value itself is left untouched.
 *
 * WARDEN-1116 — `collecting` is "a COLLECTING consent category is enabled"
 * (`collectsEvents`), not "the base tier is on". A decorating-only consent (e.g.
 * names with nothing collecting) is `off` here, which is the truth: no event is
 * produced, so nothing is sent.
 */
export function deriveTelemetrySendingStatus({
  collecting,
  endpoint,
}: {
  collecting: boolean;
  endpoint: string;
}): TelemetrySendingStatus {
  if (!collecting) return { kind: 'off' };
  // telemetryDestinationLabel('') === '', and for any non-blank input it
  // returns a non-empty host (or the raw value), so emptiness here is exactly
  // "no real endpoint configured".
  const destination = telemetryDestinationLabel(endpoint);
  if (!destination) return { kind: 'unconfigured' };
  // WARDEN-1238 — a non-blank endpoint that is not a usable web address (no
  // scheme) can never receive events: the transport sends to the raw string.
  // Do NOT bless it "configured" — surface the fixable cause instead.
  if (!isUsableTelemetryEndpoint(endpoint)) return { kind: 'needs-scheme', destination };
  return { kind: 'configured', destination };
}
