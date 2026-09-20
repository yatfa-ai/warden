'use strict';

// WARDEN-1416 — the main-process builder that turns the server child's
// 'telemetry-names' IPC snapshot into a `workspace-names` schema event. Split
// out of electron/main.cjs into its own CJS module so it is unit-testable under
// `node --test` via createRequire (the established telemetry-metrics-event.cjs /
// telemetry-stall-event.cjs pattern) — main.cjs itself cannot be required
// without standing up Electron.
//
// WHY MAIN BUILDS AN EVENT ABOUT ANOTHER PROCESS. The consent-gated pipeline
// and the transport live in MAIN; the server child reads its own in-memory chat
// catalog and forwards the closed window. The event's `runtime` is therefore
// `server` — the catalog (and the workspace it describes) lives in the forked
// backend child, exactly the fact the `server` runtime exists to name. The
// schema validator enforces the pin (a `workspace-names` with any other
// runtime is rejected), so this cannot regress silently.
//
// CONSENT NOTE (do not "fix" this module to check consent): the per-category
// gate for this event lives at the PRODUCERS, exactly like the incidents source
// and the metrics window:
//   1. the server child gates its flush on the `names` category
//      (src/workspaceNamesTelemetry.js) and DROPS the window at flush time when
//      the category is off;
//   2. main.cjs re-checks the category on IPC receipt before building this
//      event (a window can land mid-flip).
// The pipeline downstream re-gates PER EVENT TYPE (an event is sendable iff an
// ENABLED category declares its type — WARDEN-1416), on top of its coarse
// "anything collecting" guard, so this event reaches the wire only under the
// `names` category's own consent, end to end.
//
// The builder is defensive but NOT the wire's last line of defense: the
// pipeline's redact → validate stages remain authoritative. A snapshot that is
// not shaped like the producer's window yields null (nothing recorded), and a
// structurally-valid-but-hostile snapshot is still dropped pre-send by the
// pipeline's validator.

// Build the event. Returns the event object, or null when `snapshot` is not an
// object shaped like the producer's window (a non-object, a non-array `chats`,
// a non-string entry inside it, or non-numeric window stamps / count). The
// event carries NAMES ONLY — the sidebar-rendered strings — plus the true count
// and the loud truncated flag; there is no other text field in the shape.
function buildWorkspaceNamesEvent({ snapshot, schemaVersion, appVersion, platform, now }) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const { startedAt, endedAt, chats, chatCount, truncated } = snapshot;
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return null;
  if (typeof endedAt !== 'number' || !Number.isFinite(endedAt)) return null;
  if (!Array.isArray(chats)) return null;
  for (const c of chats) {
    if (typeof c !== 'string') return null;
  }
  if (typeof chatCount !== 'number' || !Number.isInteger(chatCount) || chatCount < 0) return null;
  if (chatCount < chats.length) return null; // the honest-cap invariant
  if (typeof truncated !== 'boolean') return null;
  const ts = typeof now === 'function' ? now() : Date.now();
  const event = {
    schemaVersion,
    type: 'workspace-names',
    // The forked BACKEND child owns the chat catalog — see the note above.
    // Never 'main'.
    runtime: 'server',
    timestamp: ts,
    windowStartedAt: startedAt,
    windowEndedAt: endedAt,
    chats,
    chatCount,
    truncated,
  };
  // The non-identifying volume-attribution labels, attached exactly as the
  // other builders attach them (optional per the schema; omitted when the
  // caller cannot supply one).
  if (typeof appVersion === 'string' && appVersion) event.appVersion = appVersion;
  if (typeof platform === 'string' && platform) event.platform = platform;
  return event;
}

module.exports = { buildWorkspaceNamesEvent };
