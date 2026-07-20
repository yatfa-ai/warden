// Pure join + math for the Fleet-wide 24h state timeline (WARDEN-788).
//
// FleetActivityHeatmap (WARDEN-532) plots event VOLUME — cell intensity = how
// much happened. But volume cannot reveal OSCILLATION: an agent looping
// `stuck → active → stuck` every few hours looks like "some events" in the
// heatmap and "stuck, 4m in state" in the snapshot, identical to a one-off stall.
// This module is the orthogonal complement — it turns the SAME wire series's
// `stateSeries` into a coordinated matrix where rows = agents, columns = the
// shared epoch-aligned hourly buckets, and each cell is the agent's classified
// STATE in that bucket (active/idle/stuck/erroring/blocked/waiting/…). A
// repeating stuck/active/stuck stripe reads at a glance — the one signal no
// current surface can show.
//
// The decision per row mirrors selectHeatmapCells (web/src/lib/heatmap.ts) so the
// two panels share one row set + axis:
//
//   1. NO container (manual/tmux chat)            → no row (no state timeline;
//                                                    only yatfa agents carry one).
//   2. container WITH a stateSeries entry          → its forward-filled states.
//   3. container with NO stateSeries entry         → a null-filled row → the
//                                                    renderer draws a flat
//                                                    "unobserved" stripe, NOT blank.
//
// Pure (only `import type`, erased at transpile time → loadable standalone by the
// web/*.test.mjs harness, exactly like heatmap.ts) so the matrix math is unit-
// testable WITHOUT a DOM; the renderer (FleetStateTimeline.tsx) is a thin call
// over this.
import type { ActivitySeries, Chat } from '@/lib/types';

/** One agent × one hourly bucket: the agent's last-known state in that bucket. */
export interface StateCell {
  /** The classified state held in this bucket (`active`/`idle`/`stuck`/…), or
   *  `null` when the agent was not yet observed in (or before) this bucket — the
   *  honest "unknown" that renders distinctly from a real state. */
  state: string | null;
}

/** One agent row: the agent + its per-bucket state cells. */
export interface StateRow {
  /**
   * The agent this row represents. `container` is NON-null here — case 1 above
   * (`if (!agent.container) continue;`) guarantees every row carries a real
   * container, narrowing Chat's `string | null | undefined` to `string`. The
   * renderer resolves the display name from this key (same as the heatmap).
   */
  agent: { container: string };
  /** Per-bucket state cells, parallel to the shared bucket grid (`buckets`). */
  cells: StateCell[];
}

/** The fleet-wide state matrix on a shared bucket axis (mirrors HeatmapMatrix). */
export interface StateMatrix {
  /** Container-bearing agents (case-1 manual chats filtered out), in input order. */
  rows: StateRow[];
  /** Epoch-ms bucket starts — the SHARED axis every row's cells align to. */
  buckets: number[];
  /** Bucket width in ms. */
  bucketMs: number;
}

/**
 * The canonical pane states `classifyPane` produces, plus `capture_failed`
 * (capture tried + failed) — every state `pollAgentStates` can log as a
 * `state_changed` `to`. `done` is included for forward-compat: it is today a
 * CLIENT-side active→idle completion concept (WARDEN-575, in useAttentionRollup),
 * NOT a state the server logs, so it will not appear in the series unless future
 * work logs it server-side. Kept here so the legend + glyph map are the single
 * source of truth for every state the timeline can ever render.
 */
export const KNOWN_STATES = [
  'active', 'idle', 'stuck', 'erroring', 'blocked', 'waiting', 'done', 'capture_failed',
] as const;

/** Human label for a state (tooltip / aria / legend). */
export function stateLabel(state: string | null): string {
  switch (state) {
    case 'active': return 'active';
    case 'idle': return 'idle';
    case 'stuck': return 'stuck (repeating loop)';
    case 'erroring': return 'erroring';
    case 'blocked': return 'blocked (dependency)';
    case 'waiting': return 'waiting (input)';
    case 'done': return 'done';
    case 'capture_failed': return 'capture failed (unreachable)';
    case null: return 'unknown / not yet observed';
    default: return state; // a future/unknown server state — show it verbatim
  }
}

/**
 * A single-glyph encoding per state — WCAG 2.1 1.4.1: state is NEVER encoded by
 * color alone. The glyph is the non-color channel (rendered in-cell at a small
 * size AND in the legend beside its color swatch), so a colorblind operator can
 * distinguish stuck (↻) from erroring (✕), or waiting (?) from blocked (■),
 * without relying on hue. This is the same discipline heatmap.ts follows (error
 * is never color-alone — its tooltip + aria carry the count); here the discrete
 * states warrant a per-state glyph rather than a single error flag.
 */
export function stateGlyph(state: string | null): string {
  switch (state) {
    case 'active': return '▸';
    case 'idle': return '·';
    case 'stuck': return '↻';
    case 'erroring': return '✕';
    case 'blocked': return '■';
    case 'waiting': return '?';
    case 'done': return '✓';
    case 'capture_failed': return '⚠';
    case null: return '';
    default: return '·'; // unknown server state — neutral dot
  }
}

/**
 * Build the fleet state matrix from the wire `ActivitySeries.stateSeries` + the
 * rendered agents list. Iterates `agents` in order, mirroring selectHeatmapCells's
 * three cases (see file header), so a row's position lines up with the heatmap +
 * per-row sparkline beside it.
 *
 * `series` null / no buckets (still loading, or an empty window) → empty matrix:
 * the renderer shows a graceful empty state, and unobserved containers cannot yet
 * be null-filled to a width (case 3 needs the bucket count) so they wait for the
 * series — brief, the hook fetches on mount.
 */
export function selectStateCells(
  series: ActivitySeries | null,
  agents: readonly Pick<Chat, 'container'>[],
): StateMatrix {
  const buckets = series?.buckets ?? [];
  const bucketMs = series?.bucketMs ?? 0;
  const n = buckets.length;
  if (!series || n === 0) return { rows: [], buckets, bucketMs };

  const stateSeries = series.stateSeries ?? {};
  const rows: StateRow[] = [];

  for (const agent of agents) {
    // Case 1: no container → no row (manual/tmux chats carry no state timeline).
    if (!agent.container) continue;

    const entry = stateSeries[agent.container];
    // Case 2: container with a stateSeries entry → its real forward-filled states.
    // Case 3: container with NO entry (absent from the series — getStateSeriesSince
    // never creates a never-observed entry) → null-fill across the grid so the row
    // renders a flat "unobserved" stripe, not a blank (parity with the heatmap's
    // idle zero-fill: an alive-but-untracked agent reads as a row, not a gap).
    const raw: (string | null)[] = entry ? entry.states : new Array<null>(n).fill(null);
    // Guard length: a malformed/truncated series array must never desync from the
    // bucket grid — coerce to null so cells stay 1:1 with buckets.
    const states = deriveDone(raw);
    const cells: StateCell[] = new Array<StateCell>(n);
    for (let i = 0; i < n; i++) {
      cells[i] = { state: states[i] ?? null };
    }
    rows.push({ agent: { container: agent.container }, cells });
  }

  return { rows, buckets, bucketMs };
}

/**
 * Relabel `idle` runs that immediately follow an `active` segment as `done` —
 * the active→idle COMPLETION concept (WARDEN-575's `isDoneTransition`: active→idle
 * ONLY, narrower than a crash/stall→idle). The server's classifier (`classifyPane`)
 * emits `idle`, not `done` (`done` is otherwise a client-side attention concept), so
 * the raw state log never carries `done`; this pure pass surfaces completions on the
 * timeline (a green ✓ segment after a work burst) without any server-side change or
 * dedup interaction. Done CLIENT-side (post-forward-fill) rather than at log time
 * because logging `done` server-side would diverge from the classifier's `idle`
 * output and re-fire a spurious done→idle transition on the next unchanged tick.
 *
 * Rules (single left→right pass):
 *  - `active` ends any done-run (the agent is working again).
 *  - `idle` whose most-recent KNOWN non-idle state was `active` starts/continues a
 *    done-run → relabeled `done`.
 *  - `idle` with any other known predecessor (stuck/erroring/blocked/waiting/…)
 *    stays `idle` — only a clean active→idle reads as a finish.
 *  - any other known state ends the done-run; `null` (unobserved) is transparent
 *    (neither starts nor breaks a run), so an active…<gap>…idle still reads as done.
 */
export function deriveDone(states: readonly (string | null)[]): (string | null)[] {
  const out = new Array<string | null>(states.length);
  let prevKnown: string | null = null; // last non-null state seen (the predecessor)
  let inDoneRun = false; // we are inside an idle-run that followed an active segment
  for (let i = 0; i < states.length; i++) {
    const s = states[i];
    if (s === 'active') {
      inDoneRun = false;
      out[i] = 'active';
    } else if (s === 'idle') {
      if (prevKnown === 'active') inDoneRun = true; // clean active→idle transition
      out[i] = inDoneRun ? 'done' : 'idle';
    } else {
      // Any other real state breaks the done-run; null is transparent (kept as-is).
      if (s !== null) inDoneRun = false;
      out[i] = s;
    }
    if (s !== null) prevKnown = s;
  }
  return out;
}

/**
 * Count the DISTINCT contiguous state segments in a row — the oscillation signal.
 * A row that held one state all day = 1 segment (steady); a row that flipped
 * stuck→active→stuck→active = 4 segments (the looping pattern this panel exists
 * to surface). `null` buckets (unobserved) do not count as a segment and do not
 * break a held-state run. Exposed for the renderer's per-row summary + aria so a
 * non-visual user hears "4 state transitions" without scanning the stripe.
 */
export function countStateSegments(cells: readonly StateCell[]): number {
  let segments = 0;
  let prev: string | null = null;
  for (const c of cells) {
    // A real state that DIFFERS from the previous real state starts a new segment.
    // null (unobserved) is skipped — it neither starts nor continues a segment.
    if (c.state !== null && c.state !== prev) {
      segments += 1;
      prev = c.state;
    }
    // When the state is null we DON'T reset prev: a held state that brackets a
    // brief unobserved gap (e.g. capture_failed → null → capture_failed) reads as
    // one continuous segment, not three. (null is "we don't know", not "changed".)
  }
  return segments;
}

/**
 * Screen-reader summary for one row: "<N> state change<s>" — the count of genuine
 * transitions (segments − 1, floored at 0) so a non-visual user gets the
 * oscillation signal. Steady (1 segment) → "no state changes"; one flip →
 * "1 state change"; flapping → "N state changes".
 */
export function rowStateAriaLabel(cells: readonly StateCell[]): string {
  const segments = countStateSegments(cells);
  const changes = Math.max(0, segments - 1);
  if (changes === 0) return 'no state changes in the last 24 hours';
  return `${changes} state change${changes === 1 ? '' : 's'} in the last 24 hours`;
}

/**
 * Screen-reader summary for the whole matrix. Announces the agent count + the
 * hourly-bucket span so a non-visual user knows the shape of the grid before
 * hearing individual rows. Mirrors matrixAriaLabel grammar.
 */
export function matrixStateAriaLabel(rows: readonly StateRow[], bucketCount: number): string {
  if (rows.length === 0) return 'Fleet state timeline is empty';
  return `Fleet state timeline, ${rows.length} agent${rows.length === 1 ? '' : 's'} across ${bucketCount} hourly bucket${bucketCount === 1 ? '' : 's'} in the last 24 hours`;
}
