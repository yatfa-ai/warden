// Typed-draft rules for the Settings "Dashboard Refresh Interval (ms)" control
// (WARDEN-938, bounds-parameterized by WARDEN-1331).
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
//      inside the SERVED band [min, max] (config.bounds.pollIntervalMs, derived
//      from src/config-schema.js's uiRange descriptor), the band that
//      `resolvePollIntervalMs` passes through unchanged — so displayed value ==
//      persisted value == actual cadence.
//
// WARDEN-1331: the [10_000, 120_000] band used to live HERE as hand-copied
// module constants (POLL_INPUT_MIN_MS/POLL_INPUT_MAX_MS mirroring
// WEB_POLL_FLOOR_MS/WEB_POLL_CEILING_MS, agreement held together by a test).
// The band is now DECLARED once on the backend registry and SERVED over GET;
// callers pass `config.bounds.pollIntervalMs` and this module holds no copy of
// any range. Deliberately import-free (not even `import type`) so
// web/pollIntervalDraft.test.mjs can load it standalone through Vite's OXC
// transform, exactly like configDirty.ts and lib/pollInterval.ts.

export interface PollDraftBounds {
  min: number;
  max: number;
}

/**
 * Parse a typed draft into the number to commit to `config.pollIntervalMs`.
 *
 *   - `null` (field never edited)  -> null (commit NOTHING; see invariant 1)
 *   - unparseable ('', '-', 'abc') -> null (revert to the stored value)
 *   - anything else                -> clamped into [bounds.min, bounds.max]
 */
export function commitPollIntervalDraft(
  draft: string | null,
  bounds: PollDraftBounds,
): number | null {
  if (draft === null) return null;
  const n = Number.parseInt(draft, 10);
  if (!Number.isFinite(n)) return null;
  return Math.min(bounds.max, Math.max(bounds.min, n));
}

/**
 * Whether the draft currently reads outside the advertised range — drives the
 * "capped to N on blur" hint, mirroring the connectTimeout hint next to it.
 * An untouched or unparseable draft is never "out of range" (nothing is
 * committed for either, so there is nothing to warn about).
 */
export function isPollDraftOutOfRange(
  draft: string | null,
  bounds: PollDraftBounds,
): boolean {
  if (draft === null) return false;
  const n = Number.parseInt(draft, 10);
  if (!Number.isFinite(n)) return false;
  return n < bounds.min || n > bounds.max;
}
