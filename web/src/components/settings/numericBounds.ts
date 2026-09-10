// The ONE numeric clamp the settings sections share (WARDEN-1331).
//
// Before this module each section hand-rolled its own onBlur clamp — a
// Math.min/Math.max sandwich restating the [1,60] range in HostsSection, the
// same sandwich restating [1,180] in ObserverSection, bare `< 1` floors in
// AttentionThresholdsSection / TokenBudgetSection — each restating a range
// that now travels in the served `config.bounds` (derived from
// src/config-schema.js's clamp/uiRange descriptors). The sections call THESE
// helpers with the served bound, so the input's min/max attributes, the onBlur
// clamp and the "capped to N on blur" hint all come from the one declared
// range.
//
// Pure and deliberately import-free (no `import type` either) so
// web/numericBounds.test.mjs can load it standalone through Vite's OXC
// transform, exactly like configDirty.ts and lib/pollInterval.ts.

/** One field's served bound. An absent side is unbounded on that side. */
export interface NumBound {
  min?: number;
  max?: number;
}

/**
 * Clamp `value` into `bound`. One-sided bounds clamp only the declared side —
 * no max is invented where the server enforces none.
 */
export function clampToBounds(value: number, bound: NumBound): number {
  if (bound.min !== undefined && value < bound.min) return bound.min;
  if (bound.max !== undefined && value > bound.max) return bound.max;
  return value;
}

/**
 * Whether `value` currently sits outside `bound` — drives the
 * "capped to N on blur" hint next to the inputs.
 */
export function isOutOfBounds(value: number, bound: NumBound): boolean {
  return (bound.min !== undefined && value < bound.min)
    || (bound.max !== undefined && value > bound.max);
}
