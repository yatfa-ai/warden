import { useMemo } from 'react';
import type { ActivitySeries, Chat } from '@/lib/types';
import type { TimestampFormat } from '@/lib/formatTimestamp';
import { formatTimestamp } from '@/lib/formatTimestamp';
import { cn } from '@/lib/utils';
import { FleetMatrixPanel, MATRIX_CELL_SIZE } from './FleetMatrixPanel';
import {
  selectStateCells,
  stateGlyph,
  stateLabel,
  rowStateAriaLabel,
  matrixStateAriaLabel,
  type StateCell,
} from '@/lib/stateTimeline';

/**
 * FleetStateTimeline — a fleet-wide 24h per-agent STATE matrix (WARDEN-788).
 *
 * FleetActivityHeatmap (the sibling above) plots event VOLUME — how much
 * happened. But volume cannot reveal OSCILLATION: an agent looping
 * stuck→active→stuck looks like "some events" there and "stuck, 4m in state" in
 * the snapshot, identical to a one-off stall. This panel plots the agent's
 * classified STATE per hourly bucket — rows = agents, columns = the same shared
 * epoch-aligned bucket axis as the heatmap, each cell colored + glyphed by state.
 * A repeating stuck/active/stuck stripe reads at a glance: the one signal no
 * current surface (snapshot + time-in-state, volume heatmap) can reveal.
 *
 * Pure additive slice — consumes the ALREADY-fetched `activitySeries.stateSeries`
 * (the SAME useActivitySeries 60s-cadence hook the heatmap + per-row sparklines
 * use; the endpoint now returns stateSeries alongside the volume series — no new
 * fetch/poll/SSH) + the agents list already in HealthDashboard scope.
 *
 * The matrix math + the active→idle⇒done derivation live in the pure, DOM-free
 * `web/src/lib/stateTimeline.ts` (selectStateCells — mirrors selectHeatmapCells's
 * three cases) so they are unit-tested without a render; this file is the thin
 * renderer.
 *
 * The `<section>` + collapsible header + loading/error/empty branch + `role="grid"`
 * tree are the SHARED `FleetMatrixPanel` scaffold (WARDEN-1177) — the same one
 * FleetActivityHeatmap renders through. This file supplies only what genuinely
 * differs: the per-state colour domain, the cell (a `<div>` wrapping its glyph
 * `<span>`), and the per-state legend key.
 *
 * Encoding (WCAG 2.1 1.4.1 — never color alone, the same discipline heatmap.ts
 * follows): each state is a distinct BACKGROUND COLOR + a GLYPH + a human LABEL,
 * and every cell carries a tooltip + aria-label with the state name. So a
 * colorblind operator distinguishes stuck (↻ amber) from erroring (✕ red), or
 * waiting (? sky) from blocked (■ blue), via the glyph/tooltip/label — not hue
 * alone. Colors use the EXISTING Tailwind palette tokens the AttentionBadge /
 * StatusDot already use (green/red/blue/emerald/amber/muted) so they read across
 * all themes; idle is the theme-aware muted-foreground at reduced opacity (the
 * "calm" baseline), unknown/null is a transparent outlined cell.
 *
 * Collapse state is LOCAL React state (deliberately NOT a persisted /api/config
 * pref — avoids the dead-pref trap, same as the heatmap) and lives in the
 * scaffold. Defaults OPEN.
 */
interface Props {
  /** The same 24h series the heatmap + sparklines consume (useActivitySeries). */
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

// Per-state Tailwind background classes (the render concern — kept OUT of the
// pure lib so it has no class/DOM dependency). Saturated Tailwind palette colors
// render identically across light/dark (matching the heatmap's bg-red-500); idle
// is the theme-aware muted-foreground at /40 opacity (the dim "calm" baseline).
const STATE_BG: Record<string, string> = {
  active: 'bg-green-500',
  done: 'bg-emerald-500',
  idle: 'bg-muted-foreground/40',
  waiting: 'bg-sky-500',
  blocked: 'bg-blue-500',
  stuck: 'bg-amber-600',
  erroring: 'bg-red-500',
  capture_failed: 'bg-zinc-500',
};
const UNKNOWN_BG = 'bg-transparent border border-border/50';

// Legend: the states the timeline can actually render, in scan-friendly order
// (working → finished → quiet → needs-input → needs-action → unreachable). `done`
// is the client-side active→idle completion (deriveDone in stateTimeline.ts).
const LEGEND_STATES = [
  'active', 'done', 'idle', 'waiting', 'blocked', 'stuck', 'erroring', 'capture_failed',
] as const;

function cellBg(state: string | null): string {
  return state != null ? (STATE_BG[state] ?? UNKNOWN_BG) : UNKNOWN_BG;
}

export function FleetStateTimeline({ series, agents, timestampFormat, loading, error }: Props) {
  // Memoized on the series + agents ONLY — refreshes on the 60s series cadence.
  const matrix = useMemo(() => selectStateCells(series, agents), [series, agents]);

  return (
    <FleetMatrixPanel<StateCell>
      sectionAriaLabel="Fleet agent state over the last 24 hours"
      headerLabel="Fleet state · 24h"
      rows={matrix.rows}
      buckets={matrix.buckets}
      agents={agents}
      timestampFormat={timestampFormat}
      loading={loading}
      error={error}
      hasSeries={series != null}
      loadingText="Loading fleet state…"
      errorText="Couldn't load fleet state"
      emptyText="No agent state history in the last 24 hours."
      matrixAriaLabel={matrixStateAriaLabel}
      rowAriaLabel={rowStateAriaLabel}
      renderCell={({ cell, index, agentName, bucket }) => {
        const label = stateLabel(cell.state);
        const glyph = stateGlyph(cell.state);
        const bucketTime = formatTimestamp(bucket, 'absolute');
        return (
          <div
            key={index}
            role="gridcell"
            aria-label={label}
            title={`${agentName} · ${bucketTime}: ${label}`}
            className={cn(
              MATRIX_CELL_SIZE,
              'rounded-[2px] min-w-0 flex items-center justify-center',
              cellBg(cell.state),
            )}
          >
            {/* WCAG 1.4.1 non-color channel: the glyph reinforces the
                color. Subtle (8px) — the tooltip/aria/legend carry the
                authoritative state name, same discipline as the heatmap. */}
            {glyph && (
              <span className="text-[8px] leading-none text-white/90 select-none">
                {glyph}
              </span>
            )}
          </div>
        );
      }}
      legend={
        // Color + glyph + label per state (the WCAG encoding key).
        <>
          {LEGEND_STATES.map((s) => (
            <span key={s} className="flex items-center gap-1">
              <span
                className={cn(
                  'inline-flex h-2 w-2 compact:h-1.5 compact:w-1.5 items-center justify-center rounded-[1px]',
                  STATE_BG[s],
                )}
              >
                <span className="text-[6px] leading-none text-white/90">{stateGlyph(s)}</span>
              </span>
              {stateLabel(s)}
            </span>
          ))}
          <span className="flex items-center gap-1">
            <span className={cn('inline-block h-2 w-2 compact:h-1.5 compact:w-1.5 rounded-[1px]', UNKNOWN_BG)} />
            unknown
          </span>
        </>
      }
    />
  );
}
