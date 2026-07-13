// Pure aggregator behind the always-visible header "Attention" badge (WARDEN-228),
// extended in WARDEN-344 to also fold in rich pane states (stuck / erroring /
// waiting / blocked) from /api/agent-states — the cases /api/health's inactivity-only
// classification reads as "Healthy".
//
// The badge surfaces — in one zero-click place — signals that already exist but are
// scattered/buried: critical + warning fleet health, stuck/erroring/waiting/blocked
// pane states, pending directives, and recent errors from the activity log. This
// module only AGGREGATES; the fetching, cadence, and visibility-gating live in
// useAttentionRollup. Keeping aggregation pure + dependency-free is what lets
// attentionRollup.test.mjs load it directly (TS -> ESM via Vite's OXC transform) and
// exercise the formula with plain objects.
//
// `import type` is fully erased at transpile time, so the emitted module has no
// runtime imports — the unit test can import it standalone.
import type { Chat, HealthData, ActivityStats, AgentStateRow } from '@/lib/types';

export interface AttentionRollup {
  /** Critical-health agents (deep-link to the agent pane). */
  critical: Chat[];
  /** Warning-health agents (deep-link to the agent pane). */
  warning: Chat[];
  /** Agents in a repeating-output loop — red tone (deep-link to the agent pane). */
  stuck: AgentStateRow[];
  /** Agents emitting errors / stack traces — red tone (deep-link to the agent pane). */
  erroring: AgentStateRow[];
  /** Agents parked at a human-input prompt — amber tone (deep-link to the agent pane). */
  waiting: AgentStateRow[];
  /** Agents blocked on another agent / dependency — amber tone (deep-link to the agent pane). */
  blocked: AgentStateRow[];
  /** Directive-proposal events in the recent window (links to the Activity tab). */
  directives: number;
  /** Error events in the recent window (links to the Activity tab). */
  errors: number;
  /** Total attention items == sum of all eight buckets (the number the badge shows). */
  total: number;
}

/**
 * Which pane states raise the Attention badge + desktop alert (WARDEN-344 per-state
 * toggle). Each defaults to ON (enabled) unless explicitly `false`, so omitting the
 * option surfaces every state while a human can silence a noisy "waiting" without
 * losing "erroring". A silenced state contributes NEITHER to the badge sections NOR
 * to `total` (so it can't fire a desktop alert either).
 */
export interface AttentionRollupOptions {
  enabledStates?: {
    stuck?: boolean;
    erroring?: boolean;
    waiting?: boolean;
    blocked?: boolean;
  };
}

export const EMPTY_ATTENTION_ROLLUP: AttentionRollup = {
  critical: [],
  warning: [],
  stuck: [],
  erroring: [],
  waiting: [],
  blocked: [],
  directives: 0,
  errors: 0,
  total: 0,
};

/**
 * Roll up already-fetched health + activity-stats + pane states into the header
 * attention count.
 *
 * Formula: critical + warning health agents + stuck/erroring/waiting/blocked pane
 * states + pending directives + recent errors.
 *
 *  - `critical`/`warning` are the GROUP ARRAYS from /api/health (not the summary
 *    numbers) so each item can deep-link to its agent pane via onOpenChat.
 *  - `agentStates` is the per-agent classified state list from /api/agent-states;
 *    only the four attention-worthy states (stuck/erroring/waiting/blocked) are
 *    bucketed. capture_failed is intentionally excluded (see AgentStateRow).
 *  - `directives`/`errors` are raw event counts from /api/activity/stats over a
 *    bounded recent window. There is NO server-side "unresolved"/"pending" flag,
 *    so a windowed count is the accepted proxy for "needs your eye" — the caller
 *    (useAttentionRollup) applies the window via the `after=` query param.
 *  - `opts.enabledStates` silences a pane state entirely (badge section + total).
 *
 * Defensive against null/partial inputs: a missing endpoint result or a missing
 * group key degrades to an empty bucket rather than crashing the badge.
 */
export function buildAttentionRollup(
  health: HealthData | null,
  stats: ActivityStats | null,
  agentStates: AgentStateRow[] | null = null,
  opts: AttentionRollupOptions = {},
): AttentionRollup {
  const critical = health?.groups?.critical ?? [];
  const warning = health?.groups?.warning ?? [];
  // The TS type says these are numbers, but defensively coerce: a missing/NaN
  // value must never reach the count. Number(x) || 0 turns undefined/null/NaN
  // into 0.
  const directives = Number(stats?.directive_proposed) || 0;
  const errors = Number(stats?.error) || 0;

  // Per-state toggle: default ON (enabled !== false), so omitting the option keeps
  // today's "every state surfaces" behavior while a human can silence one.
  const en = opts.enabledStates ?? {};
  const on = (k: 'stuck' | 'erroring' | 'waiting' | 'blocked') => en[k] !== false;

  const rows = Array.isArray(agentStates) ? agentStates : [];
  const bucket = (state: string) => rows.filter((a) => a && a.state === state);
  const stuck = on('stuck') ? bucket('stuck') : [];
  const erroring = on('erroring') ? bucket('erroring') : [];
  const waiting = on('waiting') ? bucket('waiting') : [];
  const blocked = on('blocked') ? bucket('blocked') : [];

  const total =
    critical.length + warning.length + directives + errors +
    stuck.length + erroring.length + waiting.length + blocked.length;
  return { critical, warning, stuck, erroring, waiting, blocked, directives, errors, total };
}
