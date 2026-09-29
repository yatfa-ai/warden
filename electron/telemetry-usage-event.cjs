'use strict';

// WARDEN-1479 — the main-process builder that turns the renderer's
// 'telemetry:renderer-usage' IPC window into a `feature-usage` schema event.
// Split out of electron/main.cjs into its own CJS module so it is unit-testable
// under `node --test` via createRequire (the established telemetry-shape-event
// .cjs pattern) — main.cjs itself cannot be required without standing up
// Electron.
//
// WHY MAIN BUILDS AN EVENT ABOUT ANOTHER PROCESS. The consent-gated pipeline
// and the transport live in MAIN; the renderer folds its own capability-use
// counter and forwards the closed window. The event's `runtime` is therefore
// `renderer` — the capability seams (global search, settings, pane maximize,
// panel expands, workspace switch/create, chat spawn, theme change) live in
// the renderer's own UI handlers, exactly the fact the pin names. The schema
// validator enforces the pin (a `feature-usage` with any other runtime is
// rejected), so this cannot regress silently.
//
// CONSENT NOTE (do not "fix" this module to check consent): the per-category
// gate for this event lives at the RECEIPT, exactly like the workspace-shape
// window (the renderer cannot see consent):
//   1. main.cjs re-checks the `feature-adoption` category on IPC receipt
//      before building this event (a window can land mid-flip);
//   2. the pipeline downstream re-gates PER EVENT TYPE (an event is sendable
//      iff an ENABLED category declares its type — WARDEN-1416), on top of its
//      coarse "anything collecting" guard.
// So this event reaches the wire only under the `feature-adoption` category's
// own consent, end to end. The renderer producer (web/src/lib/
// featureUsageTelemetry.ts) is deliberately NOT consent-gated — it forwards
// aggregates only, and nothing out-of-consent is ever recorded.
//
// CARRIER HYGIENE: the event carries a CLOSED-SET name + positive-count map —
// there is no string field anywhere in the shape beyond the closed-set
// capability names and the optional base-tier labels the builder itself
// attaches. A snapshot with a malformed stamp, a non-array `features`, a
// name that is not a lowercase kebab literal (uppercase / underscore /
// 65+-char / path- or host-shaped), a zero / negative / non-integer count,
// a duplicate name, an empty window, or ANY unexpected key (an injected
// `chatName`, `path`, `host`, …) yields null — the closed-key + name-pattern
// checks make "no identifier can ride the feature-usage channel" structural
// at the builder, before the schema's identical checks run again at validate.
//
// The builder is defensive but NOT the wire's last line of defense: the
// pipeline's redact → validate stages remain authoritative. A structurally
// valid-but-hostile snapshot is still dropped pre-send by the pipeline's
// validator.

// The closed key set the producer's window may carry. Everything else — any
// string-bearing extra key included — is rejected: the feature-usage event is
// a closed-set count map, and an unknown key is by definition not one.
const WINDOW_KEYS = new Set(['startedAt', 'endedAt', 'features', 'hasAnything']);

// The kebab-case capability-name pattern — the SAME shape an
// `operational-metrics` operation name carries (mirrors the canonical
// schema's FEATURE_NAME_RE). Lowercase letters, digits, and hyphens only, so
// a path (needs a separator), a hostname (needs a dot + TLD) and a chat name
// (needs its own characters) can never match.
const FEATURE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// The schema's generous ceiling above the producer's cap — a window carrying
// more entries than this is a shape violation, rejected here exactly as the
// validator rejects it (never truncated).
const MAX_FEATURES = 64;

// Build the event. Returns the event object, or null when `snapshot` is not
// an object shaped like the producer's window (a non-object, an unexpected
// key, a non-numeric window stamp, an empty window, or any malformed
// feature row).
function buildFeatureUsageEvent({ snapshot, schemaVersion, appVersion, platform, now }) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  for (const k of Object.keys(snapshot)) {
    if (!WINDOW_KEYS.has(k)) return null;
  }
  const { startedAt, endedAt, features } = snapshot;
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return null;
  if (typeof endedAt !== 'number' || !Number.isFinite(endedAt)) return null;
  if (!Array.isArray(features) || features.length === 0 || features.length > MAX_FEATURES) return null;
  const seen = new Set();
  const ROW_KEYS = new Set(['name', 'count']);
  for (const f of features) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) return null;
    // Closed ROW key set: a row carries exactly {name, count}. An injected
    // identifier key on a row rejects the snapshot wholesale (mirrors the
    // validator's row check — never copy-and-hope).
    for (const k of Object.keys(f)) {
      if (!ROW_KEYS.has(k)) return null;
    }
    if (typeof f.name !== 'string' || !FEATURE_NAME_RE.test(f.name)) return null;
    if (!Number.isInteger(f.count) || f.count <= 0) return null;
    if (seen.has(f.name)) return null; // a folded map: one row per name
    seen.add(f.name);
  }
  const ts = typeof now === 'function' ? now() : Date.now();
  const event = {
    schemaVersion,
    type: 'feature-usage',
    // The RENDERER owns the capability seams — see the note above. Never 'main'.
    runtime: 'renderer',
    timestamp: ts,
    windowStartedAt: startedAt,
    windowEndedAt: endedAt,
    // Copy ONLY the name/count pairs — a hostile row carrying extra keys
    // (`chatName` on a row) cannot ride into the event even if the top-level
    // key check passed.
    features: features.map((f) => ({ name: f.name, count: f.count })),
  };
  // The non-identifying volume-attribution labels, attached exactly as the
  // other builders attach them (optional per the schema; omitted when the
  // caller cannot supply one).
  if (typeof appVersion === 'string' && appVersion) event.appVersion = appVersion;
  if (typeof platform === 'string' && platform) event.platform = platform;
  return event;
}

module.exports = { buildFeatureUsageEvent };
