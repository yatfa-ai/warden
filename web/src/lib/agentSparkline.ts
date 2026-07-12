// Pure join logic for the Fleet Health per-agent sparklines (WARDEN-299).
//
// HealthDashboard renders one row per agent and needs to decide — per row —
// whether to draw a sparkline, and with what data. That decision has three
// cases, and getting the third one right is the whole point of the feature:
//
//   1. NO container (manual/tmux chat)            → no sparkline (graceful sparsity;
//                                                    only yatfa agents carry one).
//   2. container WITH events in the 24h window    → real per-bucket totals/errors.
//   3. container with NO events in the window     → a zero-filled series → the
//                                                    <Sparkline> renders a flat
//                                                    baseline, NOT a blank.
//
// Case 3 is what lets a human tell an idle-but-alive agent from a row that
// simply has no data — the exact question the dot + "X ago" text can't settle
// (criterion #1). Extracted here as PURE functions so the cases are unit-testable
// without a DOM (mirrors web/src/lib/attentionRollup.ts + its web/*.test.mjs),
// and so HealthDashboard's render is a thin call instead of inline JSX logic.
import type { ActivitySeries, Chat } from '@/lib/types';

/** Per-container 24h totals, pre-summed for an O(1) row lookup + aria-label. */
export interface AgentActivityEntry {
  /** Per-bucket event totals (parallel to the series buckets). */
  values: number[];
  /** Per-bucket error sub-counts (parallel to `values`). */
  errors: number[];
  /** Sum of `values` across the window — drives the aria-label noun count. */
  totalSum: number;
  /** Sum of `errors` across the window — drives the aria-label error count. */
  errorSum: number;
}

/** container → pre-summed bucket arrays. Built once per series refresh. */
export type AgentActivityMap = Map<string, AgentActivityEntry>;

/**
 * Flatten the wire `ActivitySeries` into a per-container Map of pre-summed
 * bucket arrays, so each row's sparkline render is an O(1) Map lookup instead of
 * re-summing every render. Pure — memoized on a single input (`activitySeries`)
 * inside HealthDashboard, so the 10s `/api/health` tick never recomputes it.
 *
 * A container with zero events in the window is intentionally absent here too
 * (getSeriesSince never creates a series entry for a zero-event key): the idle
 * flat-line is synthesized in `selectAgentSparkline`, not stored, so the Map only
 * holds agents that actually did something.
 */
export function buildAgentActivity(series: ActivitySeries | null): AgentActivityMap {
  const map: AgentActivityMap = new Map();
  if (!series) return map;
  for (const [container, entry] of Object.entries(series.series)) {
    let totalSum = 0;
    let errorSum = 0;
    for (let i = 0; i < entry.total.length; i++) {
      totalSum += entry.total[i] | 0;
      errorSum += entry.error[i] | 0;
    }
    map.set(container, { values: entry.total, errors: entry.error, totalSum, errorSum });
  }
  return map;
}

/** A sparkline to render for a row, or `null` to render nothing. */
export interface AgentSparkline {
  values: number[];
  errors: number[];
  ariaLabel: string;
}

/**
 * Decide what (if anything) a fleet row should sparkline. See the three cases
 * documented at the top of this file.
 *
 * `bucketCount` is the width of the series bucket grid (`series.buckets.length`)
 * — needed only for case 3 (idle flat-line), so the zero-fill spans the same
 * hour-columns as active rows. Pass 0 while the series is still loading and idle
 * agents render nothing until it arrives (brief — the hook fetches on mount).
 */
export function selectAgentSparkline(
  agent: Pick<Chat, 'container'>,
  activity: AgentActivityMap,
  bucketCount: number,
): AgentSparkline | null {
  // Case 1: no container → no sparkline (manual/tmux chats stay clean).
  if (!agent.container) return null;

  // Case 2: container with events → its real per-bucket totals/errors.
  const a = activity.get(agent.container);
  if (a) {
    return {
      values: a.values,
      errors: a.errors,
      ariaLabel: `${a.totalSum} event${a.totalSum === 1 ? '' : 's'}, ${a.errorSum} error${a.errorSum === 1 ? '' : 's'} in the last 24 hours`,
    };
  }

  // Case 3: container present but zero events in the window → idle flat-line.
  // Zero-fill across the bucket grid so <Sparkline> draws a visible baseline
  // (its `hasData` guard is false → the flat-baseline branch), not a blank.
  if (bucketCount > 0) {
    const zeros = new Array<number>(bucketCount).fill(0);
    return { values: zeros, errors: zeros, ariaLabel: '0 events in the last 24 hours' };
  }

  // Series not loaded yet (bucketCount 0) — render nothing until it is.
  return null;
}
