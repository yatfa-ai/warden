// Pure aggregator behind the always-visible header "Attention" badge (WARDEN-228),
// extended in WARDEN-344 to also fold in rich pane states (stuck / erroring /
// waiting / blocked) from /api/agent-states — the cases /api/health's inactivity-only
// classification reads as "Healthy" — and in WARDEN-384 to RANK those buckets into a
// single directed answer (rankAttention) so the badge promotes "you're needed HERE,
// because X" instead of a flat rundown the human must scan.
//
// The badge surfaces — in one zero-click place — signals that already exist but are
// scattered/buried: critical + warning fleet health, stuck/erroring/waiting/blocked
// pane states, pending directives, and recent errors from the activity log. This
// module only AGGREGATES (+ ranks); the fetching, cadence, and visibility-gating
// live in useAttentionRollup. Keeping aggregation pure + dependency-free is what
// lets attentionRollup.test.mjs load it directly (TS -> ESM via Vite's OXC
// transform) and exercise the formula with plain objects.
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

// ─── Directed ranking (Observer Intelligence roadmap WARDEN-8, Job #2) ────────
//
// buildAttentionRollup above is a flat bucket sum — with N panes needing attention
// the human must open the popover, scan sections top→bottom, scan rows within each,
// and mentally pick "where am I needed FIRST." rankAttention turns that rundown into
// a single directed answer ("you're needed HERE, because X"): it flattens the
// buckets into one urgency-ordered list and exposes the top item as the promoted
// callout target. The sectioned rundown stays below it as the fallback for N>1.
//
// Like buildAttentionRollup this is PURE + dependency-free (only the `import type`
// above, erased at transpile), so attentionRollup.test.mjs can exercise it
// standalone alongside the existing aggregation cases.

/**
 * A single attention item flattened to the minimal shape the directed callout +
 * ranked fallback need: identity (`key || id`, to deep-link the CORRECT pane —
 * matches the badge's existing row keying), a display name, the attention `state`
 * (a pane state, or a synthesized 'critical'/'warning' for health-group agents
 * that carry no pane state of their own), and the `signal` line that explains WHY
 * it needs attention (null for health-group agents, which have no triggering line).
 */
export interface AttentionItem {
  id: string;
  name?: string;
  state: string;
  signal?: string | null;
}

/**
 * Urgency precedence for the directed callout — higher weight is picked first.
 *
 * The pane-state precedence already encoded in `agentState.js`'s `classifyPane` is
 * `erroring > stuck > blocked > waiting` — but that decides which SINGLE state wins
 * when ONE pane matches several. "Which of MANY panes to go to first" is a
 * different question, so we start from that order and BIAS it: a pane WAITING on
 * the human is the unique case where ONLY the human can unblock, so it is promoted
 * to the very top — above even a live error/loop. That is the strongest "you're
 * needed HERE" signal (a `waiting`-on-you pane ranks above a merely `stuck` one).
 * `blocked` sinks: the agent depends on OTHER agents, so the human is not the sole
 * unblocker. `critical`/`warning` health sit alongside, severe-but-less-actionable
 * than a live failure with a visible signal.
 */
const ATTENTION_RANK: Record<string, number> = {
  waiting: 100,
  erroring: 90,
  stuck: 80,
  critical: 70,
  blocked: 60,
  warning: 50,
};

/**
 * Flatten the rollup into a single directed answer + an urgency-ordered list.
 *
 * Returns `{ top, ranked }`:
 *  - `top`    — the single highest-urgency deep-linkable item (the callout target),
 *               or `null` when no pane/health agent needs attention (e.g. only
 *               directives/errors counts remain — those have no single pane to
 *               deep-link, so they cannot be the directed answer).
 *  - `ranked` — every deep-linkable item, highest urgency first, for the sectioned
 *               fallback rundown.
 *
 * `enabledStates` is already honored upstream by `buildAttentionRollup` (a silenced
 * state's bucket is empty), so a silenced state can never become `top`. Ties (same
 * precedence tier — e.g. several `waiting` panes) resolve in input order, since
 * `Array#sort` is stable: the order `/api/agent-states` returned is preserved.
 */
export function rankAttention(rollup: AttentionRollup): {
  top: AttentionItem | null;
  ranked: AttentionItem[];
} {
  // Health-group agents (Chat) carry no pane state or signal of their own; tag them
  // with a synthesized state so the callout can still phrase the reason. Pane-state
  // rows (AgentStateRow) keep their real state + signal. Identity mirrors the badge's
  // existing row keying (`a.key || a.id`) so the deep-link opens the correct pane.
  const fromChat =
    (state: string) =>
    (a: Chat): AttentionItem => ({
      id: a.key || a.id,
      name: a.name || a.key || a.id,
      state,
      signal: null,
    });
  const fromRow = (a: AgentStateRow): AttentionItem => ({
    id: a.key || a.id,
    name: a.name || a.key || a.id,
    state: a.state,
    signal: a.signal ?? null,
  });

  // `directives`/`errors` are raw event counts with no single pane to deep-link, so
  // they are excluded from the directed answer — they stay in the sectioned rundown.
  // Items are seeded in precedence order so the stable sort below keeps same-tier
  // ties deterministic even if a caller ever reorders the rollup's buckets.
  const items: AttentionItem[] = [
    ...rollup.waiting.map(fromRow),
    ...rollup.erroring.map(fromRow),
    ...rollup.stuck.map(fromRow),
    ...rollup.critical.map(fromChat('critical')),
    ...rollup.blocked.map(fromRow),
    ...rollup.warning.map(fromChat('warning')),
  ];

  const ranked = items
    .slice()
    .sort((a, b) => (ATTENTION_RANK[b.state] ?? 0) - (ATTENTION_RANK[a.state] ?? 0));

  return { top: ranked.length > 0 ? ranked[0] : null, ranked };
}
