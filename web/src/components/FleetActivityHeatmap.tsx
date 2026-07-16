import { useState, useMemo } from 'react';
import type { ActivitySeries, Chat } from '@/lib/types';
import type { TimestampFormat } from '@/lib/formatTimestamp';
import { formatTimestamp } from '@/lib/formatTimestamp';
import { displayName } from '@/lib/chatDisplay';
import { cn } from '@/lib/utils';
import {
  selectHeatmapCells,
  bucketLabelIndices,
  cellHasError,
  rowAriaLabel,
  matrixAriaLabel,
} from '@/lib/heatmap';

/**
 * FleetActivityHeatmap — a fleet-wide 24h activity matrix (WARDEN-532).
 *
 * WARDEN-299 gave every fleet row its OWN sparkline, but those strips are
 * independent and mutually unaligned — each is a `w-14 h-4` SVG with no shared
 * time axis, so cross-fleet temporal patterns (everything going quiet at 3am, a
 * correlated error burst across agents, the fleet winding down) are impossible
 * to read. This panel promotes that same data to ONE coordinated matrix on a
 * shared epoch-aligned bucket axis: rows = agents, columns = hourly buckets,
 * cell intensity = event volume, error buckets tinted red. A vertical quiet
 * stripe = many agents dark in the same hour; a vertical red stripe = many
 * agents erroring together.
 *
 * Pure additive slice — consumes the ALREADY-fetched `activitySeries` (the same
 * `useActivitySeries` 60s-cadence hook the per-row sparklines use) + the agents
 * list already in HealthDashboard scope. No new endpoint, poll, SSH, or config.
 *
 * The matrix math lives in the pure, DOM-free `web/src/lib/heatmap.ts`
 * (selectHeatmapCells — three cases mirroring selectAgentSparkline, fleet-wide
 * intensity normalization) so it is unit-tested without a render; this file is
 * the thin renderer.
 *
 * Encoding (WCAG 2.1 1.4.1 — never color alone): cell OPACITY ∝ the bucket's
 * volume, normalized against the fleet max; cell COLOR is muted-foreground
 * (volume) vs red-500 (the bucket errored). So intensity reads in grayscale, and
 * an error burst reads as a red cluster even at a glance. Every cell + row also
 * carries an aria-label / tooltip with the exact counts. Colors come from the
 * EXISTING muted-foreground + red-500 Tailwind tokens HealthDashboard + the
 * Sparkline already use (theme-aware across all 8 themes); only the opacity — a
 * scalar, not a color — is computed.
 *
 * Collapse state is LOCAL React state (deliberately NOT a persisted /api/config
 * pref — avoids the dead-pref trap). Defaults OPEN so a returning human scans
 * the fleet pattern at a glance on opening Fleet Health.
 */
interface Props {
  /** The same 24h series the per-row sparklines consume (useActivitySeries). */
  series: ActivitySeries | null;
  /** The fleet agents (healthData.agents) — the row set, in catalog order. */
  agents: readonly Chat[];
  /** Routes the sparse column time-labels through the shared timestamp helper. */
  timestampFormat: TimestampFormat;
}

// Sparse column label cadence: label ~every 6 buckets (≈ every 6h for the default
// 24h / 1h-bucket window) so the axis carries time context without clutter.
const LABEL_STEP = 6;
// Cell-size class shared by every cell (volume + error) so the grid is uniform.
const CELL_SIZE = 'h-3 compact:h-2.5';
// Intensity → opacity ramp. Floor 0.2 so an idle row reads as a visible flat dim
// stripe (idle-baseline parity with the per-row Sparkline, NOT a blank); ceiling
// 0.9 so the fleet peak is strong without saturating to solid.
const OPACITY_FLOOR = 0.2;
const OPACITY_RANGE = 0.7;
function intensityOpacity(intensity: number): number {
  return OPACITY_FLOOR + OPACITY_RANGE * intensity;
}

export function FleetActivityHeatmap({ series, agents, timestampFormat }: Props) {
  // LOCAL collapse state — never serialized to /api/config (avoids the dead-pref
  // trap). Defaults open so the fleet pattern is glanceable on entry.
  const [open, setOpen] = useState(true);

  // The matrix is memoized on the series + agents ONLY — it refreshes on the
  // 60s series cadence, never on the 10s /api/health tick.
  const matrix = useMemo(() => selectHeatmapCells(series, agents), [series, agents]);

  // Resolve each agent's display name by container (the matrix rows carry only
  // the container; the name is a render concern). Keyed by container — unique
  // per yatfa agent.
  const nameByContainer = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents) if (a.container) m.set(a.container, displayName(a));
    return m;
  }, [agents]);

  const colCount = matrix.buckets.length;
  const labelled = useMemo(() => new Set(bucketLabelIndices(colCount, LABEL_STEP)), [colCount]);
  // Shared grid template — the header row + every agent row use the SAME columns
  // so cells line up vertically (a column = one hour across the whole fleet).
  const gridCols = `minmax(52px, 5rem) repeat(${colCount}, minmax(0, 1fr))`;

  // The "now" edge (rightmost column) is labelled literally rather than by its
  // bucket-start time (which is up to an hour old and would read as e.g. "23m").
  const columnLabel = (bucket: number, i: number): string => {
    if (i === colCount - 1) return 'now';
    return formatTimestamp(bucket, timestampFormat);
  };

  const hasRows = matrix.rows.length > 0;

  return (
    <section
      className="rounded-md border border-border bg-card/40"
      aria-label="Fleet activity over the last 24 hours"
    >
      {/* Collapsible header. Chevron ▾/▸ mirrors the host-grouping collapse in
          HealthDashboard so the affordance reads the same everywhere. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:bg-accent rounded-md transition-colors"
      >
        <span className="text-[10px] text-muted-foreground/60 w-2 shrink-0">{open ? '▾' : '▸'}</span>
        <span>Fleet activity · 24h</span>
        <span className="ml-auto normal-case tracking-normal text-[10px] text-muted-foreground/70">
          {hasRows ? `${matrix.rows.length} agent${matrix.rows.length === 1 ? '' : 's'}` : ''}
        </span>
      </button>

      {open && (
        <div className="px-2 pb-2 pt-0.5">
          {hasRows ? (
            <div
              role="grid"
              aria-label={matrixAriaLabel(matrix.rows, colCount)}
              aria-rowcount={matrix.rows.length + 1}
              aria-colcount={colCount + 1}
              className="flex flex-col gap-px"
            >
              {/* Column-header row: a corner spacer + one header per bucket.
                  Only the sparse labelled columns carry a time tick (and a
                  columnheader role); the rest are presentational spacers so a
                  screen reader isn't read 24 blank headers. */}
              <div role="row" className="grid" style={{ gridTemplateColumns: gridCols, gap: '1px' }}>
                <div role="presentation" className="h-3 compact:h-2.5" aria-hidden="true" />
                {matrix.buckets.map((b, i) =>
                  labelled.has(i) ? (
                    <div
                      key={i}
                      role="columnheader"
                      aria-label={columnLabel(b, i)}
                      className="text-center text-[8px] leading-none text-muted-foreground/80 overflow-visible whitespace-nowrap"
                    >
                      {columnLabel(b, i)}
                    </div>
                  ) : (
                    <div key={i} role="presentation" aria-hidden="true" />
                  ),
                )}
              </div>

              {/* Agent rows. Each row is the keyboard-focusable unit (tabIndex 0)
                  with a full summary aria-label; cells carry per-bucket labels +
                  tooltips for granularity without 24×N tab stops. */}
              {matrix.rows.map((row) => {
                const name = nameByContainer.get(row.agent.container) ?? row.agent.container;
                return (
                  <div
                    key={row.agent.container}
                    role="row"
                    tabIndex={0}
                    aria-label={`${name}: ${rowAriaLabel(row.cells)}`}
                    className="grid items-center rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-primary focus-visible:bg-accent/40"
                    style={{ gridTemplateColumns: gridCols, gap: '1px' }}
                  >
                    <div
                      role="rowheader"
                      className="truncate text-[10px] text-muted-foreground pr-1"
                      title={name}
                    >
                      {name}
                    </div>
                    {row.cells.map((cell, i) => {
                      const hadError = cellHasError(cell.error);
                      const bucketTime = formatTimestamp(matrix.buckets[i], 'absolute');
                      const cellAria = `${cell.total} event${cell.total === 1 ? '' : 's'}${hadError ? `, ${cell.error} error${cell.error === 1 ? '' : 's'}` : ''}`;
                      return (
                        <div
                          key={i}
                          role="gridcell"
                          aria-label={cellAria}
                          title={`${name} · ${bucketTime}: ${cellAria}`}
                          // bg token (theme-safe) + computed opacity (the only
                          // non-token value, and it is a scalar not a color).
                          className={cn(
                            CELL_SIZE,
                            'rounded-[2px] min-w-0',
                            hadError ? 'bg-red-500' : 'bg-muted-foreground',
                          )}
                          style={{ opacity: intensityOpacity(cell.intensity) }}
                        />
                      );
                    })}
                  </div>
                );
              })}
            </div>
          ) : (
            // Graceful empty state: series still loading, or no container-bearing
            // agents. Never render a misleading empty grid.
            <div className="py-2 text-center text-[10px] text-muted-foreground">
              {series == null ? 'Loading fleet activity…' : 'No agent activity in the last 24 hours.'}
            </div>
          )}

          {/* Legend — intensity ramp + error swatch. Compact, token-colored so it
              matches the cells exactly. */}
          {hasRows && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[9px] text-muted-foreground">
              <span className="flex items-center gap-1">
                less
                <span className="flex items-center gap-px">
                  {[0, 0.33, 0.66, 1].map((v) => (
                    <span
                      key={v}
                      className="inline-block h-2 w-2 compact:h-1.5 compact:w-1.5 rounded-[1px] bg-muted-foreground"
                      style={{ opacity: intensityOpacity(v) }}
                    />
                  ))}
                </span>
                more
              </span>
              <span className="flex items-center gap-1">
                <span
                  className="inline-block h-2 w-2 compact:h-1.5 compact:w-1.5 rounded-[1px] bg-red-500"
                  style={{ opacity: intensityOpacity(1) }}
                />
                error burst
              </span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
