'use strict';

// WARDEN-1258 — the main-process builder that turns the server child's
// 'telemetry-metrics' IPC snapshot into an `operational-metrics` schema event.
// Split out of electron/main.cjs into its own CJS module so it is unit-testable
// under `node --test` via createRequire (the established electron/window-state.cjs
// / telemetry-source.cjs pattern) — main.cjs itself cannot be required without
// standing up Electron.
//
// CONSENT NOTE (do not "fix" this module to check consent): the per-category
// gate for this event lives at the PRODUCERS, exactly like the incidents source:
//   1. the server child gates record() on the operational-metrics category
//      (src/fileExistsTelemetry.js) and DROPS the window at flush time when the
//      category is off;
//   2. main.cjs re-checks the category on IPC receipt before building this
//      event (a window can land mid-flip).
// The pipeline downstream gates on "anything collecting" (its documented
// contract), which is the same granularity every other event type flows under.
//
// The builder is defensive but NOT the wire's last line of defense: the
// pipeline's redact → validate stages remain authoritative. A snapshot that is
// not shaped like an M1 aggregator window yields null (nothing recorded), and a
// structurally-valid-but-hostile snapshot is still dropped pre-send by the
// pipeline's validator.

// Build the event. Returns the event object, or null when `snapshot` is not an
// object shaped like an aggregator window (a non-object, missing arrays, or
// non-numeric window stamps). The event carries AGGREGATES ONLY — counts,
// ratios, latencies, and constant kebab-case operation literals; there is no
// free-text field anywhere in the shape.
function buildOperationalMetricsEvent({ snapshot, schemaVersion, appVersion, platform, now }) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const {
    startedAt, endedAt, boundaries, operations, rejected,
  } = snapshot;
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return null;
  if (typeof endedAt !== 'number' || !Number.isFinite(endedAt)) return null;
  if (!Array.isArray(boundaries) || !Array.isArray(operations)) return null;
  if (typeof rejected !== 'number' || !Number.isFinite(rejected)) return null;
  const ts = typeof now === 'function' ? now() : Date.now();
  const event = {
    schemaVersion,
    type: 'operational-metrics',
    runtime: 'main',
    timestamp: ts,
    windowStartedAt: startedAt,
    windowEndedAt: endedAt,
    boundaries,
    operations,
    rejected,
  };
  // The non-identifying volume-attribution labels, attached exactly as the
  // incident builders attach them (optional per the schema; omitted when the
  // caller cannot supply one).
  if (typeof appVersion === 'string' && appVersion) event.appVersion = appVersion;
  if (typeof platform === 'string' && platform) event.platform = platform;
  return event;
}

module.exports = { buildOperationalMetricsEvent };
