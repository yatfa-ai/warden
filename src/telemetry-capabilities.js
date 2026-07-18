// Config-time receiver verification — the backend half of the Settings "Test
// connection" probe (WARDEN-595). The renderer cannot fetch the receiver directly:
// the telemetry transport runs in the Node main process (no CORS), but the probe
// button lives in the renderer, and a cross-origin renderer fetch would be
// CORS-blocked (the receiver sends no CORS headers). So — exactly like
// /api/webhook-test — the renderer POSTs { endpoint, token? } to a backend route,
// and THIS module's caller does the outbound GET /capabilities in Node (no CORS).
//
// mapCapabilitiesVerdict is the PURE, network-free verdict mapper, split out so the
// four verdict states are unit-testable without a fetch mock. The route handler in
// server.js composes it with a single fetch.
//
// WHY A PROBE, NOT A STORED STATUS: the verdict is intentionally NOT persisted. A
// cached "connected" goes stale (receiver down, token rotated, schema bumped) and
// becomes a false trust signal — the whole point of this feature is to turn the
// destination label's deliberate NON-claim ("configured" is not "reachable") into a
// VERIFIED one, and a verification is only honest at the moment it is made. So it
// stays a live, on-demand probe, recomputed on every click.

// The client's telemetry schema version — the SAME value as the canonical
// web/src/lib/telemetry/schema.ts SCHEMA_VERSION (and the vendored copy in the
// warden-telemetry receiver repo). It is INLINED here rather than imported across
// the src/↔web/ boundary: the backend runs on Node 22 without
// --experimental-strip-types, so a runtime .ts import is not possible, and src/ has
// no precedent for importing from web/ (the two trees only reference each other in
// comments — e.g. notify.js, agentState.js, budget.js all "mirror" values, not
// import them). The drift test (telemetry-capabilities.test.js) asserts this equals
// the canonical schema.ts value, so it CANNOT fall out of sync silently — the same
// discipline the warden-telemetry repo's drift.test.mjs uses against the client.
export const CLIENT_SCHEMA_VERSION = 3;

// The receiver's config-time verification path (mirrors warden-telemetry's
// CAPABILITIES_PATH). Appended to the derived origin to form the probe URL — the
// receiver serves /capabilities at the same origin as /ingest.
export const CAPABILITIES_PATH = '/capabilities';

// Derive the GET /capabilities URL from a user-entered endpoint (which may be the
// /ingest URL or a bare host). Mirrors web/src/lib/telemetry/destination.ts's
// telemetryDestinationLabel origin-derivation: strict parse first, then a lenient
// https:// retry for a scheme-less bare host (the common self-hoster mistake).
// Returns origin + CAPABILITIES_PATH, or null if no origin could be derived (the
// route then reports no-receiver — never a guess). NEVER carries the path/query of
// the ingest endpoint: /capabilities is a distinct route at the receiver's origin.
export function capabilitiesUrlFromEndpoint(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  let origin;
  try {
    origin = new URL(trimmed).origin;
  } catch {
    try {
      // Lenient: a bare host has no scheme, so the strict parse above threw.
      origin = new URL('https://' + trimmed).origin;
    } catch {
      return null;
    }
  }
  return origin + CAPABILITIES_PATH;
}

// The four verdict states a "Test connection" probe can resolve to. `kind`
// discriminates; `ok` is the binary reachability+schema-match signal; `message` is
// the honest, user-facing copy the UI renders verbatim.
//
//   connected     — reachable + schema-matched. The auth outcome is folded into the
//                   message from the body's authRequired (a token either validated
//                   or was not required) — a 200 with matching schema is only
//                   reachable if auth passed (a gated receiver 401s first).
//   schema-drift  — reachable + authed, but the receiver's schemaVersion differs
//                   from the client's → events would be hard-rejected at /ingest
//                   (415). Names BOTH versions so the user can see the skew.
//   auth-required — the receiver rejected the probe as unauthenticated (401). The
//                   tokenSent flag makes the copy precise: a sent token was
//                   REJECTED; an absent token is REQUIRED.
//   no-receiver   — nothing answerable at this URL: a network error (host
//                   unreachable / DNS / refused / bad URL), a non-200, or a 200 body
//                   that is not a warden-telemetry capabilities payload.
//
// Pure: same inputs → same verdict, no network, no I/O. Tested directly.
export function mapCapabilitiesVerdict({
  status,
  body,
  clientSchemaVersion = CLIENT_SCHEMA_VERSION,
  tokenSent = false,
  fetchError = false,
} = {}) {
  // Network error — the fetch threw before a response arrived (host unreachable,
  // DNS failure, connection refused/reset, invalid URL, timeout).
  if (fetchError || status == null) {
    return { kind: 'no-receiver', ok: false, message: 'No warden-telemetry receiver responded at this URL.' };
  }
  // 401 — the auth gate fired before the capabilities body was returned. A token
  // was either absent (required) or present (rejected).
  if (status === 401) {
    return {
      kind: 'auth-required',
      ok: false,
      message: tokenSent
        ? 'The receiver rejected this auth token. Check that it matches the receiver\'s AUTH_TOKEN.'
        : 'The receiver requires an auth token. Enter the matching "Receiver auth token" and test again.',
    };
  }
  // 200 — a warden-telemetry receiver (or something answering on this path). Check
  // the schema version against the client's.
  if (status === 200) {
    const remoteVersion =
      body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'schemaVersion')
        ? body.schemaVersion
        : undefined;
    if (remoteVersion === clientSchemaVersion) {
      const authed = body && typeof body === 'object' && body.authRequired === true;
      return {
        kind: 'connected',
        ok: true,
        message: authed
          ? 'Connected — receiver is reachable, schema-matched, and your token was accepted.'
          : 'Connected — receiver is reachable and schema-matched (no auth required).',
      };
    }
    if (remoteVersion !== undefined && typeof remoteVersion !== 'object') {
      return {
        kind: 'schema-drift',
        ok: false,
        message: `Schema version mismatch: your client speaks v${clientSchemaVersion}, the receiver speaks v${remoteVersion}. Events would be rejected (HTTP 415).`,
      };
    }
    // 200 but the body is not a capabilities payload → not a warden-telemetry receiver.
    return { kind: 'no-receiver', ok: false, message: 'This URL responded but is not a warden-telemetry receiver.' };
  }
  // Any other status (403/404/5xx/…) — not a healthy receiver at this URL.
  return { kind: 'no-receiver', ok: false, message: `No warden-telemetry receiver at this URL (HTTP ${status}).` };
}

// Probe a receiver's GET /capabilities and return the verdict. The outbound fetch
// is INJECTED (`fetchImpl`) so the route is unit-testable with a capturing stub
// (ZERO real network) — the same discipline as telemetry-send.js's `fetchImpl`.
// The route handler in server.js composes this with the global fetch.
//
// `token` is a DRAFT token from the request body (the user may be testing a new
// one before saving); `fallbackToken` is the persisted cfg.telemetryAuthToken (used
// when no draft is supplied, so a saved secret works without retyping — the token
// is write-only on GET /api/config, so the renderer never holds its cleartext). A
// non-empty draft takes precedence over the fallback. Empty/missing → no auth
// header → works against an open (AUTH_TOKEN-unset) receiver.
export async function probeReceiverCapabilities({
  endpoint,
  token = '',
  fallbackToken = '',
  fetchImpl = globalThis.fetch,
} = {}) {
  const draft = typeof token === 'string' ? token.trim() : '';
  const useToken = draft || (typeof fallbackToken === 'string' ? fallbackToken.trim() : '');
  const tokenSent = useToken.length > 0;

  const capabilitiesUrl = capabilitiesUrlFromEndpoint(endpoint);
  if (!capabilitiesUrl) {
    // Unparseable origin — report no-receiver rather than guess a destination.
    return mapCapabilitiesVerdict({ fetchError: true, tokenSent });
  }

  const headers = {};
  if (tokenSent) headers.authorization = `Bearer ${useToken}`;

  let status = null;
  let body = null;
  try {
    const res = await fetchImpl(capabilitiesUrl, { method: 'GET', headers });
    status = res.status;
    try {
      body = await res.json();
    } catch {
      // A non-JSON body (e.g. an HTML landing page) → the mapper treats a missing
      // schemaVersion as not-a-receiver. Keep body null so no shape match succeeds.
      body = null;
    }
  } catch {
    // Network error — host unreachable, DNS failure, refused/reset, bad URL.
    return mapCapabilitiesVerdict({ fetchError: true, tokenSent });
  }

  return mapCapabilitiesVerdict({ status, body, tokenSent });
}

