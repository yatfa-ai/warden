import type { ActivitySeries, Chat } from '@/lib/types';
import type { TimestampFormat } from '@/lib/formatTimestamp';
import { formatTimestamp } from '@/lib/formatTimestamp';
import { cn } from '@/lib/utils';
import { FleetMatrixPanel, MATRIX_CELL_SIZE } from './FleetMatrixPanel';
import { useMemo } from 'react';
import {
  selectHeatmapCells,
  cellHasError,
  rowAriaLabel,
  matrixAriaLabel,
  type HeatmapCell,
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
 * The `<section>` + collapsible header + loading/error/empty branch + `role="grid"`
 * tree are the SHARED `FleetMatrixPanel` scaffold (WARDEN-1177) — the same one
 * FleetStateTimeline renders through. This file supplies only what genuinely
 * differs: the intensity colour domain, the cell (a self-closing `<div>` with a
 * computed opacity), and the intensity-ramp legend.
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
 * pref — avoids the dead-pref trap) and lives in the scaffold. Defaults OPEN so a
 * returning human scans the fleet pattern at a glance on opening Fleet Health.
 */
interface Props {
  /** The same 24h series the per-row sparklines consume (useActivitySeries). */
  series: ActivitySeries | null;
  /** The fleet agents (healthData.agents) — the row set, in catalog order. */
  agents: readonly Chat[];
  /** Routes the sparse column time-labels through the shared timestamp helper. */
  timestampFormat: TimestampFormat;
  /** True only during the very first fetch, before any data has arrived. The
   *  ONLY honest source for "still loading" — `series == null` conflates it with
   *  a failed fetch (WARDEN-1078). */
  loading: boolean;
  /** Last fetch error from useActivitySeries, or null. Surfaced ONLY when no
   *  series has ever arrived; a blip after a good poll keeps the last good
   *  matrix on screen rather than swapping it for an error. */
  error: Error | null;
}

// Intensity → opacity ramp. Floor 0.2 so an idle row reads as a visible flat dim
// stripe (idle-baseline parity with the per-row Sparkline, NOT a blank); ceiling
// 0.9 so the fleet peak is strong without saturating to solid.
const OPACITY_FLOOR = 0.2;
const OPACITY_RANGE = 0.7;
function intensityOpacity(intensity: number): number {
  return OPACITY_FLOOR + OPACITY_RANGE * intensity;
}

export function FleetActivityHeatmap({ series, agents, timestampFormat, loading, error }: Props) {
  // The matrix is memoized on the series + agents ONLY — it refreshes on the
  // 60s series cadence, never on the 10s /api/health tick.
  const matrix = useMemo(() => selectHeatmapCells(series, agents), [series, agents]);

  return (
    <FleetMatrixPanel<HeatmapCell>
      sectionAriaLabel="Fleet activity over the last 24 hours"
      headerLabel="Fleet activity · 24h"
      rows={matrix.rows}
      buckets={matrix.buckets}
      agents={agents}
      timestampFormat={timestampFormat}
      loading={loading}
      error={error}
      hasSeries={series != null}
      loadingText="Loading fleet activity…"
      errorText="Couldn't load fleet activity"
      emptyText="No agent activity in the last 24 hours."
      matrixAriaLabel={matrixAriaLabel}
      rowAriaLabel={rowAriaLabel}
      renderCell={({ cell, index, agentName, bucket }) => {
        const hadError = cellHasError(cell.error);
        const bucketTime = formatTimestamp(bucket, 'absolute');
        const cellAria = `${cell.total} event${cell.total === 1 ? '' : 's'}${hadError ? `, ${cell.error} error${cell.error === 1 ? '' : 's'}` : ''}`;
        return (
          <div
            key={index}
            role="gridcell"
            aria-label={cellAria}
            title={`${agentName} · ${bucketTime}: ${cellAria}`}
            // bg token (theme-safe) + computed opacity (the only
            // non-token value, and it is a scalar not a color).
            className={cn(
              MATRIX_CELL_SIZE,
              'rounded-[2px] min-w-0',
              hadError ? 'bg-red-500' : 'bg-muted-foreground',
            )}
            style={{ opacity: intensityOpacity(cell.intensity) }}
          />
        );
      }}
      legend={
        // Intensity ramp + error swatch. Compact, token-colored so it matches
        // the cells exactly.
        <>
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
        </>
      }
    />
  );
}
