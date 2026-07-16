// Pure join + math for the Fleet-wide 24h activity heatmap (WARDEN-532).
//
// HealthDashboard already renders one per-row sparkline per agent (WARDEN-299),
// but those strips are INDEPENDENT and mutually unaligned — each is its own
// `w-14 h-4` SVG with no shared time axis, so cross-agent temporal patterns
// (simultaneous stalls, correlated error bursts, a fleet-wide quiet stretch) are
// structurally impossible to read. This module turns the SAME wire series into
// ONE coordinated matrix: rows = agents, columns = the shared epoch-aligned
// hourly buckets, cell intensity = event volume, error buckets flagged red.
//
// The decision per row is the SAME three cases as the per-row sparkline
// (web/src/lib/agentSparkline.ts), and getting the third one right is the whole
// point again:
//
//   1. NO container (manual/tmux chat)            → no row (no activity data;
//                                                    only yatfa agents carry one).
//   2. container WITH events in the 24h window    → real per-bucket totals/errors.
//   3. container with NO events in the window     → a zero-filled row → the
//                                                    renderer draws a flat dim
//                                                    stripe, NOT a blank.
//
// Case 3 is what lets a human tell an idle-but-alive agent from one that simply
// has no row — idle-baseline parity with `selectAgentSparkline`. Pure (only
// `import type`, erased at transpile time → loadable standalone by the
// web/*.test.mjs harness, exactly like agentSparkline.ts) so the matrix math is
// unit-testable WITHOUT a DOM; the renderer (FleetActivityHeatmap.tsx) is a thin
// call over this.
import type { ActivitySeries, Chat } from '@/lib/types';

/** One agent × one hourly bucket. */
export interface HeatmapCell {
  /** Per-bucket event total (volume) for this agent/bucket. */
  total: number;
  /** Per-bucket error sub-count ("something went wrong" event types) for this agent/bucket. */
  error: number;
  /** `total / max` normalized against the fleet-wide max, clamped to [0,1]. 0 = idle. */
  intensity: number;
}

/** One agent row in the matrix: the agent + its per-bucket cells. */
export interface HeatmapRow {
  /**
   * The agent this row represents. `container` is NON-null here — case 1 above
   * (`if (!agent.container) continue;`) guarantees every row carries a real
   * container, so the type narrows from Chat's `string | null | undefined` to a
   * plain `string`. The renderer resolves the display name from this key.
   */
  agent: { container: string };
  /** Per-bucket cells, parallel to the shared bucket grid (`buckets`). */
  cells: HeatmapCell[];
}

/** The fleet-wide matrix on a shared bucket axis. */
export interface HeatmapMatrix {
  /** Container-bearing agents (case-1 manual chats filtered out), in input order. */
  rows: HeatmapRow[];
  /** Epoch-ms bucket starts — the SHARED axis every row's cells align to. */
  buckets: number[];
  /** Bucket width in ms. */
  bucketMs: number;
  /** Fleet-wide max per-bucket total — the intensity denominator (0 = idle fleet). */
  max: number;
}

/**
 * Build the fleet heatmap matrix from the wire `ActivitySeries` + the rendered
 * agents list. Iterates `agents` in order, mirroring selectAgentSparkline's three
 * cases (see file header), so a row's position lines up with the per-row
 * sparkline beside it.
 *
 * Intensity is normalized against the FLEET-WIDE max — NOT each row's own max —
 * so a high-volume agent cannot drown out a quiet one. That shared scale is the
 * whole reason a vertical quiet stripe (many agents dark in the same hour) or a
 * correlated red stripe (many agents erroring together) reads at a glance.
 *
 * `series` null / no buckets (still loading, or an empty window) → empty matrix:
 * the renderer shows a graceful empty state instead of a misleading grid, and
 * idle containers cannot yet be zero-filled to a width (case 3 needs the bucket
 * count) so they too wait for the series — brief, the hook fetches on mount.
 */
export function selectHeatmapCells(
  series: ActivitySeries | null,
  agents: readonly Pick<Chat, 'container'>[],
): HeatmapMatrix {
  const buckets = series?.buckets ?? [];
  const bucketMs = series?.bucketMs ?? 0;
  const n = buckets.length;
  if (!series || n === 0) return { rows: [], buckets, bucketMs, max: 0 };

  const rows: HeatmapRow[] = [];
  let max = 0;

  for (const agent of agents) {
    // Case 1: no container → no row (manual/tmux chats carry no activity data).
    if (!agent.container) continue;

    const entry = series.series[agent.container];
    // Case 2: container with events → its real parallel total/error arrays.
    // Case 3: container with NO events (absent from the series, since
    // getSeriesSince never creates a zero-event entry) → zero-fill across the
    // grid so the row renders a flat dim stripe, not a blank.
    const totals: number[] = entry ? entry.total : new Array<number>(n).fill(0);
    const errors: number[] = entry ? entry.error : new Array<number>(n).fill(0);

    const cells: HeatmapCell[] = new Array<HeatmapCell>(n);
    for (let i = 0; i < n; i++) {
      // `| 0` coerces undefined / non-numeric counts to 0, never NaN — mirrors
      // buildAgentActivity's defensive sum.
      const total = totals[i] | 0;
      const error = errors[i] | 0;
      if (total > max) max = total;
      // intensity filled in the second pass once the fleet max is known.
      cells[i] = { total, error, intensity: 0 };
    }
    rows.push({ agent: { container: agent.container }, cells });
  }

  // Second pass: normalize every cell against the fleet-wide max.
  for (const row of rows) {
    for (const cell of row.cells) {
      cell.intensity = max > 0 ? cell.total / max : 0;
    }
  }

  return { rows, buckets, bucketMs, max };
}

/**
 * A cell's normalized intensity: `total / max`, clamped to [0,1]. Returns 0 when
 * `max` is ≤ 0 (an all-idle fleet — nothing to scale against). Exposed so the
 * renderer and tests can re-derive a single cell's intensity without rebuilding
 * the matrix.
 */
export function cellIntensity(total: number, max: number): number {
  if (max <= 0) return 0;
  const v = total / max;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * A bucket is an error burst iff it carries ≥1 error-typed event. (WCAG 1.4.1:
 * error is never encoded by color alone — the cell tooltip + aria-label always
 * carry the error count too. This flag just selects the red vs muted tint.)
 */
export function cellHasError(errorCount: number): boolean {
  return errorCount > 0;
}

/**
 * Sparse column indices to label, ~every `step` buckets starting at 0, always
 * including the final bucket (the "now" edge) so the time range's right end is
 * pinned. The renderer formats those bucket epochs via the shared formatTimestamp
 * (kept OUT of this pure layer so it has no wall-clock / locale dependency and
 * stays deterministic under test). For the default 24h / 1h window, step 6 →
 * labels at buckets [0, 6, 12, 18, 23] — four "every 6h" marks plus "now".
 */
export function bucketLabelIndices(count: number, step: number): number[] {
  if (count <= 0 || step <= 0) return [];
  const out: number[] = [];
  for (let i = 0; i < count; i += step) out.push(i);
  const last = count - 1;
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/**
 * Screen-reader summary for one row: "N events, M errors in the last 24 hours"
 * (mirrors selectAgentSparkline's ariaLabel grammar exactly, including the
 * singular/plural rules). The renderer prepends the agent's display name.
 */
export function rowAriaLabel(cells: readonly HeatmapCell[]): string {
  let total = 0;
  let error = 0;
  for (const c of cells) {
    total += c.total;
    error += c.error;
  }
  const ev = total === 1 ? 'event' : 'events';
  if (error > 0) {
    return `${total} ${ev}, ${error} error${error === 1 ? '' : 's'} in the last 24 hours`;
  }
  return `${total} ${ev} in the last 24 hours`;
}

/**
 * Screen-reader summary for the whole matrix. Announces the agent count + the
 * hourly-bucket span so a non-visual user knows the shape of the grid before
 * hearing individual rows.
 */
export function matrixAriaLabel(rows: readonly HeatmapRow[], bucketCount: number): string {
  if (rows.length === 0) return 'Fleet activity heatmap is empty';
  return `Fleet activity heatmap, ${rows.length} agent${rows.length === 1 ? '' : 's'} across ${bucketCount} hourly bucket${bucketCount === 1 ? '' : 's'} in the last 24 hours`;
}
