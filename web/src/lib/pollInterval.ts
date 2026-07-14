// Dashboard auto-refresh cadence resolved from the persisted pollIntervalMs pref.
//
// pollIntervalMs is the user-facing knob for how often the web dashboard
// re-pulls the chat catalog, re-discovers engaged hosts, and re-checks host
// connectivity — all of which fan out over SSH on every visible tick. But the
// raw config value is CLI-oriented: config.js defaults to 1500ms (a one-host
// watch cadence that would re-discover every engaged host ~40x/min in the web).
// resolvePollIntervalMs maps the persisted pref onto a web-safe cadence so the
// "Poll Interval" control actually governs refresh WITHOUT regressing SSH load.
//
// Pure (no clock, no DOM) so it is unit-testable. See web/pollInterval.test.mjs.

// 10s floor — matches the existing web health-poll cadence
// (useAttentionRollup.ts HEALTH_POLL_MS). The web never refreshes faster than
// this, so a user (or a stale/CLI value) can't hammer SSH.
export const WEB_POLL_FLOOR_MS = 10_000;

// 2min ceiling — the slowest meaningful dashboard cadence; bounds long values.
export const WEB_POLL_CEILING_MS = 120_000;

// 60s default — the historical hardcoded cadence (App.tsx). Used whenever the
// pref is absent, non-finite, sub-floor, or the CLI default, so a fresh or
// CLI-tuned install keeps the exact SSH-load profile it always had (no
// regression). WARDEN-394.
export const WEB_POLL_DEFAULT_MS = 60_000;

// The config.js default (config.js:15) — CLI watch-mode cadence (one host,
// 1.5s). Nonsensical for the web, so it maps to the web default rather than
// being passed through to setInterval.
export const CLI_POLL_DEFAULT_MS = 1_500;

/**
 * Map a persisted pollIntervalMs pref onto a web-safe dashboard refresh
 * cadence (ms).
 *
 *   - absent / non-finite / sub-floor / CLI-default(1500) -> 60s web default
 *   - 10s..2min (inclusive)                                -> passed through
 *   - above 2min                                           -> clamped to 2min
 *
 * Below-floor values revert to the 60s default (NOT clamped up to the 10s
 * floor): clamping a user's 5s up to 10s would give a faster cadence than they
 * may realize, and the safe choice is the historical default. The Settings
 * control is retuned to min=10s so this branch is unreachable from the UI; it
 * only defends against stale/CLI/migrated values. See WARDEN-394 design tension.
 */
export function resolvePollIntervalMs(raw: number | null | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return WEB_POLL_DEFAULT_MS;
  if (raw === CLI_POLL_DEFAULT_MS) return WEB_POLL_DEFAULT_MS;
  if (raw < WEB_POLL_FLOOR_MS) return WEB_POLL_DEFAULT_MS;
  if (raw > WEB_POLL_CEILING_MS) return WEB_POLL_CEILING_MS;
  return raw;
}
