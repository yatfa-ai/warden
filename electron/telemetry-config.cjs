'use strict';

// Telemetry config-wiring helper — the PURE decision logic that maps the
// persisted telemetry prefs to the pipeline's effective PER-CATEGORY consent,
// PLUS the startup disk read of those prefs. Extracted from electron/main.cjs
// (mirroring electron/window-state.cjs's separable pure logic) so both are
// unit-testable in isolation under `node --test`, without standing up Electron.
//
// WARDEN-524 (live-wire the assembled telemetry pipeline). main.cjs calls
// resolveTelemetryConsent to drive BOTH the source's consent state and the
// pipeline's consent resolver; readTelemetryPrefs at boot supplies the initial
// values (live changes arrive over the fork's IPC channel, not via re-reads).
//
// WARDEN-1116 — consent is now a set of INDEPENDENT per-category switches, and
// the ONE authority that resolves them is src/telemetry-consent.cjs. This
// module makes no consent decision of its own; it delegates.
//
// DEFENSE IN DEPTH — this is one of TWO INDEPENDENT off-by-default enforcement
// points, and it must stay that way:
//   1. HERE, the main-process boot read: whatever is on disk is re-resolved
//      through the consent authority before anything is armed. A missing,
//      partial, non-boolean, corrupt, or unrecognized persisted value resolves
//      to OFF. The main process therefore never trusts that the server's write
//      path sanitized what it wrote.
//   2. The SERVER's config write path (src/config-schema.js): it independently
//      sanitizes what it PERSISTS, so a hand-crafted PUT cannot store a value
//      the main process would have to defend against in the first place.
// Neither is a fallback for the other. Collapsing them into a single point of
// trust is exactly the failure this arrangement exists to prevent.

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  TELEMETRY_CATEGORIES,
  resolveConsent,
} = require('../src/telemetry-consent.cjs');

// The on-disk config path — mirrors src/config.js's `configPath`
// (path.join(os.homedir(), '.yatfa-warden', 'config.json')). This file lives
// OUTSIDE the app asar (in the user's home), so reading it with fs is bulletproof
// regardless of packaging — the main process never needs to load src/config.js
// (ESM) to read a handful of booleans/strings.
const CONFIG_PATH = path.join(os.homedir(), '.yatfa-warden', 'config.json');

// Resolve the effective PER-CATEGORY telemetry consent from the persisted prefs.
//
// Every category is independent and OFF by default; enabling one never enables
// another. A config written by a pre-WARDEN-1116 build (the linear
// telemetryBaseEnabled / telemetryExtendedEnabled pair) is translated forward by
// the authority's migration rule, so an existing opt-in carries over unchanged
// and nothing new is silently enabled.
//
// Returns a frozen `{ [categoryId]: boolean }`. Any missing / non-boolean /
// unrecognized pref resolves to false — the off-by-default posture — and the
// pipeline treats "nothing collecting" as a HARD no-op (nothing built, buffered,
// or sent).
function resolveTelemetryConsent(prefs) {
  return resolveConsent(prefs);
}

// Read the telemetry prefs off the on-disk config at boot. Missing keys
// default to false / '' — EXACTLY the off / no-endpoint / no-token posture
// (mirrors src/config.js DEFAULTS, so a first-run or partially-written config
// is safe). Never throws: an unreadable / missing / malformed config yields the
// safe all-off defaults, so a corrupt disk state can never accidentally enable
// telemetry. Type-strict — the consent categories are resolved through the
// consent authority (real booleans only, with the legacy pair translated
// forward), and only a real string is accepted for the endpoint/token. The auth
// token is read in CLEARTEXT here (main-process boot read, same trust boundary
// as the endpoint); it is only ever MASKED on the GET /api/config → renderer
// path (src/server.js), never on this internal main-process read.
function readTelemetryPrefs(configPath) {
  const file = typeof configPath === 'string' && configPath ? configPath : CONFIG_PATH;
  const safe = {
    telemetryEndpoint: '',
    telemetryAuthToken: '',
  };
  for (const cat of TELEMETRY_CATEGORIES) safe[cat.configKey] = false;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') {
      const consent = resolveConsent(raw);
      for (const cat of TELEMETRY_CATEGORIES) safe[cat.configKey] = consent[cat.id] === true;
      if (typeof raw.telemetryEndpoint === 'string') safe.telemetryEndpoint = raw.telemetryEndpoint;
      if (typeof raw.telemetryAuthToken === 'string') safe.telemetryAuthToken = raw.telemetryAuthToken;
    }
  } catch {
    // first run (no file) / unreadable / malformed JSON → safe all-off defaults
  }
  return safe;
}

module.exports = {
  CONFIG_PATH,
  resolveTelemetryConsent,
  readTelemetryPrefs,
};
