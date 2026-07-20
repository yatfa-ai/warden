import { useState, useMemo } from 'react';
import type { ActivitySeries, Chat } from '@/lib/types';
import type { TimestampFormat } from '@/lib/formatTimestamp';
import { formatTimestamp } from '@/lib/formatTimestamp';
import { displayName } from '@/lib/chatDisplay';
import { cn } from '@/lib/utils';
import { bucketLabelIndices } from '@/lib/heatmap';
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
 * pref — avoids the dead-pref trap, same as the heatmap). Defaults OPEN.
 */
interface Props {
  /** The same 24h series the heatmap + sparklines consume (useActivitySeries). */
  series: ActivitySeries | null;
  /** The fleet agents (healthData.agents) — the row set, in catalog order. */
  agents: readonly Chat[];
  /** Routes the sparse column time-labels through the shared timestamp helper. */
  timestampFormat: TimestampFormat;
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

// Sparse column label cadence: label ~every 6 buckets (≈ every 6h for the default
// 24h / 1h-bucket window) — identical to the heatmap so the two panels share axis ticks.
const LABEL_STEP = 6;
const CELL_SIZE = 'h-3 compact:h-2.5';

function cellBg(state: string | null): string {
  return state != null ? (STATE_BG[state] ?? UNKNOWN_BG) : UNKNOWN_BG;
}

export function FleetStateTimeline({ series, agents, timestampFormat }: Props) {
  // LOCAL collapse state — never serialized to /api/config (avoids the dead-pref
  // trap). Defaults open so the fleet pattern is glanceable on entry.
  const [open, setOpen] = useState(true);

  // Memoized on the series + agents ONLY — refreshes on the 60s series cadence.
  const matrix = useMemo(() => selectStateCells(series, agents), [series, agents]);

  const nameByContainer = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents) if (a.container) m.set(a.container, displayName(a));
    return m;
  }, [agents]);

  const colCount = matrix.buckets.length;
  // Shared axis tick set with the heatmap (bucketLabelIndices is the heatmap's own
  // helper — reused so the two panels' time labels align verbatim when stacked).
  const labelled = useMemo(
    () => new Set(bucketLabelIndices(colCount, LABEL_STEP)),
    [colCount],
  );
  const gridCols = `minmax(52px, 5rem) repeat(${colCount}, minmax(0, 1fr))`;

  const columnLabel = (bucket: number, i: number): string => {
    if (i === colCount - 1) return 'now';
    return formatTimestamp(bucket, timestampFormat);
  };

  const hasRows = matrix.rows.length > 0;

  return (
    <section
      className="rounded-md border border-border bg-card/40"
      aria-label="Fleet agent state over the last 24 hours"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:bg-accent rounded-md transition-colors"
      >
        <span className="text-[10px] text-muted-foreground/60 w-2 shrink-0">{open ? '▾' : '▸'}</span>
        <span>Fleet state · 24h</span>
        <span className="ml-auto normal-case tracking-normal text-[10px] text-muted-foreground/70">
          {hasRows ? `${matrix.rows.length} agent${matrix.rows.length === 1 ? '' : 's'}` : ''}
        </span>
      </button>

      {open && (
        <div className="px-2 pb-2 pt-0.5">
          {hasRows ? (
            <div
              role="grid"
              aria-label={matrixStateAriaLabel(matrix.rows, colCount)}
              aria-rowcount={matrix.rows.length + 1}
              aria-colcount={colCount + 1}
              className="flex flex-col gap-px"
            >
              {/* Column-header row: mirrors the heatmap's sparse labelled columns. */}
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

              {/* Agent rows. Each row is keyboard-focusable with a full summary
                  aria-label (state-change count = the oscillation signal); cells
                  carry per-bucket state tooltips for granularity. */}
              {matrix.rows.map((row) => {
                const name = nameByContainer.get(row.agent.container) ?? row.agent.container;
                return (
                  <div
                    key={row.agent.container}
                    role="row"
                    tabIndex={0}
                    aria-label={`${name}: ${rowStateAriaLabel(row.cells)}`}
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
                    {row.cells.map((cell: StateCell, i: number) => {
                      const label = stateLabel(cell.state);
                      const glyph = stateGlyph(cell.state);
                      const bucketTime = formatTimestamp(matrix.buckets[i], 'absolute');
                      return (
                        <div
                          key={i}
                          role="gridcell"
                          aria-label={label}
                          title={`${name} · ${bucketTime}: ${label}`}
                          className={cn(
                            CELL_SIZE,
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
                    })}
                  </div>
                );
              })}
            </div>
          ) : (
            // Graceful empty state: series still loading, or no container-bearing
            // agents / no state history yet. Never render a misleading empty grid.
            <div className="py-2 text-center text-[10px] text-muted-foreground">
              {series == null ? 'Loading fleet state…' : 'No agent state history in the last 24 hours.'}
            </div>
          )}

          {/* Legend — color + glyph + label per state (the WCAG encoding key). */}
          {hasRows && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[9px] text-muted-foreground">
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
            </div>
          )}
        </div>
      )}
    </section>
  );
}
