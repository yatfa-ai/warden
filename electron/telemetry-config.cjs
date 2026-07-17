'use strict';

// Telemetry config-wiring helper — the PURE decision logic that maps the
// persisted telemetry prefs to the pipeline's effective consent tier, PLUS the
// startup disk read of those prefs. Extracted from electron/main.cjs (mirroring
// electron/window-state.cjs's separable pure logic) so both are unit-testable in
// isolation under `node --test`, without standing up Electron.
//
// WARDEN-524 (live-wire the assembled telemetry pipeline). main.cjs calls
// resolveTelemetryTier to drive BOTH the source's base-consent toggle and the
// pipeline's consent resolver; readTelemetryPrefs at boot supplies the initial
// values (live changes arrive over the fork's IPC channel, not via re-reads).

const fs = require('fs');
const path = require('path');
const os = require('os');

// The on-disk config path — mirrors src/config.js's `configPath`
// (path.join(os.homedir(), '.yatfa-warden', 'config.json')). This file lives
// OUTSIDE the app asar (in the user's home), so reading it with fs is bulletproof
// regardless of packaging — the main process never needs to load src/config.js
// (ESM) to read three booleans/strings.
const CONFIG_PATH = path.join(os.homedir(), '.yatfa-warden', 'config.json');

// Resolve the effective telemetry consent tier from the persisted prefs.
//
// Mirrors the SERVER's extended-requires-base clamp (src/server.js PUT /api/config,
// `cfg.telemetryExtendedEnabled = cfg.telemetryExtendedEnabled && cfg.telemetryBaseEnabled`):
// the extended tier is reachable ONLY when base is also on. A corrupt disk state
// (extended on, base off) therefore resolves to 'off' here too — defense in depth
// alongside the server-side clamp, so the main process never trusts a stale/
// corrupt pair it read before the server's next PUT self-heals it.
//
// Returns one of 'off' | 'base' | 'extended'. Any missing / non-boolean /
// unrecognized pref resolves to 'off' — the off-by-default posture, and the
// pipeline treats 'off' as a HARD no-op (nothing built, buffered, or sent).
function resolveTelemetryTier(prefs) {
  const p = prefs && typeof prefs === 'object' ? prefs : {};
  const base = p.telemetryBaseEnabled === true;
  const extended = base && p.telemetryExtendedEnabled === true; // extended-requires-base
  if (extended) return 'extended';
  if (base) return 'base';
  return 'off';
}

// Read the telemetry prefs off the on-disk config at boot. Missing keys
// default to false / '' — EXACTLY the off / no-endpoint / no-token posture
// (mirrors src/config.js DEFAULTS, so a first-run or partially-written config
// is safe). Never throws: an unreadable / missing / malformed config yields the
// safe all-off defaults, so a corrupt disk state can never accidentally enable
// telemetry. Type-strict — only a real boolean/string is accepted. The auth
// token is read in CLEARTEXT here (main-process boot read, same trust boundary
// as the endpoint); it is only ever MASKED on the GET /api/config → renderer
// path (src/server.js), never on this internal main-process read.
function readTelemetryPrefs(configPath) {
  const file = typeof configPath === 'string' && configPath ? configPath : CONFIG_PATH;
  const safe = {
    telemetryBaseEnabled: false,
    telemetryExtendedEnabled: false,
    telemetryEndpoint: '',
    telemetryAuthToken: '',
  };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') {
      if (typeof raw.telemetryBaseEnabled === 'boolean') safe.telemetryBaseEnabled = raw.telemetryBaseEnabled;
      if (typeof raw.telemetryExtendedEnabled === 'boolean') safe.telemetryExtendedEnabled = raw.telemetryExtendedEnabled;
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
  resolveTelemetryTier,
  readTelemetryPrefs,
};

