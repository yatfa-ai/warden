'use strict';

// WARDEN-1278 — the main-process builder that turns the server child's
// 'telemetry-stalls' IPC snapshot into a `server-stall` schema event. Split out
// of electron/main.cjs into its own CJS module so it is unit-testable under
// `node --test` via createRequire (the established electron/window-state.cjs /
// telemetry-metrics-event.cjs pattern) — main.cjs itself cannot be required
// without standing up Electron.
//
// WHY MAIN BUILDS AN EVENT ABOUT ANOTHER PROCESS. The consent-gated pipeline and
// the transport live in MAIN; the server child observes itself and forwards a
// closed window. The event's `runtime` is therefore `server` — not `main` — and
// that is the whole point of the v6 schema bump: the backend is a third real OS
// process warden has always run and the wire could not name, so nothing it
// observed could ever be reported. Stamping `main` here would be a lie about
// which process froze, and it is exactly the lie the new runtime exists to end.
// The schema validator enforces it (a `server-stall` with any other runtime is
// rejected), so this cannot regress silently.
//
// CONSENT NOTE (do not "fix" this module to check consent): the per-category
// gate for this event lives at the PRODUCERS, exactly like the incidents source
// and the metrics window:
//   1. the server child gates record() on the `incidents` category
//      (src/serverStallTelemetry.js) and DROPS the window at flush time when the
//      category is off;
//   2. main.cjs re-checks the category on IPC receipt before building this
//      event (a window can land mid-flip).
// The pipeline downstream gates on "anything collecting" (its documented
// contract), which is the same granularity every other event type flows under.
//
// The builder is defensive but NOT the wire's last line of defense: the
// pipeline's redact → validate stages remain authoritative. A snapshot that is
// not shaped like a stall-aggregator window yields null (nothing recorded), and
// a structurally-valid-but-hostile snapshot is still dropped pre-send by the
// pipeline's validator.

// Build the event. Returns the event object, or null when `snapshot` is not an
// object shaped like a stall-aggregator window (a non-object, missing arrays, or
// non-numeric window stamps / totals). The event carries AGGREGATES ONLY —
// counts, durations, a fixed-boundary lag histogram, and closed-set kebab-case
// culprit keys; there is no free-text field anywhere in the shape.
function buildServerStallEvent({ snapshot, schemaVersion, appVersion, platform, now }) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const {
    startedAt, endedAt, count, totalMs, maxMs, boundaries, buckets, culprits,
  } = snapshot;
  for (const v of [startedAt, endedAt, count, totalMs, maxMs]) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  }
  if (!Array.isArray(boundaries) || !Array.isArray(buckets) || !Array.isArray(culprits)) return null;
  const ts = typeof now === 'function' ? now() : Date.now();
  const event = {
    schemaVersion,
    type: 'server-stall',
    // The forked BACKEND child — see the note above. Never 'main'.
    runtime: 'server',
    timestamp: ts,
    windowStartedAt: startedAt,
    windowEndedAt: endedAt,
    count,
    totalMs,
    maxMs,
    boundaries,
    buckets,
    culprits,
  };
  // The non-identifying volume-attribution labels, attached exactly as the
  // incident builders attach them (optional per the schema; omitted when the
  // caller cannot supply one). They describe the APP, not the process, so they
  // are correct for a server-runtime event too.
  if (typeof appVersion === 'string' && appVersion) event.appVersion = appVersion;
  if (typeof platform === 'string' && platform) event.platform = platform;
  return event;
}

module.exports = { buildServerStallEvent };
