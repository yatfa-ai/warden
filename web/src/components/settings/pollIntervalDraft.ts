// Typed-draft rules for the Settings "Dashboard Refresh Interval (ms)" control
// (WARDEN-938).
//
// The control used to render `resolvePollIntervalMs(config.pollIntervalMs)`
// directly as a controlled `value`, which made the field un-typeable: the first
// keystroke committed a sub-floor number, the resolver mapped it to the 60s web
// default, and the field snapped to `60000` mid-edit. HostsSection now keeps the
// raw keystrokes in a LOCAL draft (no resolver in the render path) and commits a
// parsed+clamped number to `config` on blur. These are the pure pieces of that
// rule, split out so they can be tested without a browser.
//
// Two invariants this file exists to protect:
//   1. An UNTOUCHED field never commits anything. `pollIntervalMs` is shared
//      with the CLI, whose watch mode legitimately uses the 1500ms default, so
//      merely tabbing through the field must not rewrite the stored value up to
//      the web floor. A `null` draft therefore commits `null`.
//   2. What is committed is what the dashboard runs. Everything this returns is
//      inside [POLL_INPUT_MIN_MS, POLL_INPUT_MAX_MS], the band that
//      `resolvePollIntervalMs` passes through unchanged — so displayed value ==
//      persisted value == actual cadence.
//
// Deliberately import-free (not even `import type`) so web/pollIntervalDraft.test.mjs
// can load it standalone through Vite's OXC transform, exactly like
// configDirty.ts and lib/pollInterval.ts. The bounds below MIRROR
// WEB_POLL_FLOOR_MS / WEB_POLL_CEILING_MS in lib/pollInterval.ts (which must not
// be modified — its below-floor branch is the defense for stale/CLI/migrated
// values); that test asserts the two pairs stay equal.

/** Smallest cadence the UI accepts — mirrors WEB_POLL_FLOOR_MS. */
export const POLL_INPUT_MIN_MS = 10_000;

/** Largest cadence the UI accepts — mirrors WEB_POLL_CEILING_MS. */
export const POLL_INPUT_MAX_MS = 120_000;

/**
 * Parse a typed draft into the number to commit to `config.pollIntervalMs`.
 *
 *   - `null` (field never edited)  -> null (commit NOTHING; see invariant 1)
 *   - unparseable ('', '-', 'abc') -> null (revert to the stored value)
 *   - anything else                -> clamped into [MIN, MAX]
 */
export function commitPollIntervalDraft(draft: string | null): number | null {
  if (draft === null) return null;
  const n = Number.parseInt(draft, 10);
  if (!Number.isFinite(n)) return null;
  return Math.min(POLL_INPUT_MAX_MS, Math.max(POLL_INPUT_MIN_MS, n));
}

/**
 * Whether the draft currently reads outside the advertised range — drives the
 * "capped to N on blur" hint, mirroring the connectTimeout hint next to it.
 * An untouched or unparseable draft is never "out of range" (nothing is
 * committed for either, so there is nothing to warn about).
 */
export function isPollDraftOutOfRange(draft: string | null): boolean {
  if (draft === null) return false;
  const n = Number.parseInt(draft, 10);
  if (!Number.isFinite(n)) return false;
  return n < POLL_INPUT_MIN_MS || n > POLL_INPUT_MAX_MS;
}
