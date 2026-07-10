// Pure aggregator behind the always-visible header "Attention" badge (WARDEN-228).
//
// The badge surfaces — in one zero-click place — signals that already exist but are
// scattered/buried: critical + warning fleet health, plus pending directives and
// recent errors from the activity log. This module only AGGREGATES; the fetching,
// cadence, and visibility-gating live in useAttentionRollup. Keeping aggregation
// pure + dependency-free is what lets attentionRollup.test.mjs load it directly
// (TS -> ESM via Vite's OXC transform) and exercise the formula with plain objects.
//
// `import type` is fully erased at transpile time, so the emitted module has no
// runtime imports — the unit test can import it standalone.
import type { Chat, HealthData, ActivityStats } from '@/lib/types';

export interface AttentionRollup {
  /** Critical-health agents (deep-link to the agent pane). */
  critical: Chat[];
  /** Warning-health agents (deep-link to the agent pane). */
  warning: Chat[];
  /** Directive-proposal events in the recent window (links to the Activity tab). */
  directives: number;
  /** Error events in the recent window (links to the Activity tab). */
  errors: number;
  /** Total attention items == sum of the four buckets (the number the badge shows). */
  total: number;
}

export const EMPTY_ATTENTION_ROLLUP: AttentionRollup = {
  critical: [],
  warning: [],
  directives: 0,
  errors: 0,
  total: 0,
};

/**
 * Roll up already-fetched health + activity-stats into the header attention count.
 *
 * Formula: critical + warning health agents + pending directives + recent errors.
 *
 *  - `critical`/`warning` are the GROUP ARRAYS from /api/health (not the summary
 *    numbers) so each item can deep-link to its agent pane via onOpenChat.
 *  - `directives`/`errors` are raw event counts from /api/activity/stats over a
 *    bounded recent window. There is NO server-side "unresolved"/"pending" flag,
 *    so a windowed count is the accepted proxy for "needs your eye" — the caller
 *    (useAttentionRollup) applies the window via the `after=` query param.
 *
 * Defensive against null/partial inputs: a missing endpoint result or a missing
 * group key degrades to an empty bucket rather than crashing the badge.
 */
export function buildAttentionRollup(
  health: HealthData | null,
  stats: ActivityStats | null,
): AttentionRollup {
  const critical = health?.groups?.critical ?? [];
  const warning = health?.groups?.warning ?? [];
  // The TS type says these are numbers, but defensively coerce: a missing/NaN
  // value must never reach the count. Number(x) || 0 turns undefined/null/NaN
  // into 0.
  const directives = Number(stats?.directive_proposed) || 0;
  const errors = Number(stats?.error) || 0;
  const total = critical.length + warning.length + directives + errors;
  return { critical, warning, directives, errors, total };
}
