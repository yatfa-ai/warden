import { useState, useMemo, type ReactNode } from 'react';
import type { Chat } from '@/lib/types';
import type { TimestampFormat } from '@/lib/formatTimestamp';
import { formatTimestamp } from '@/lib/formatTimestamp';
import { displayName } from '@/lib/chatDisplay';
import { CollapsibleSectionHeader } from './CollapsibleSectionHeader';
import { bucketLabelIndices } from '@/lib/heatmap';

/**
 * FleetMatrixPanel — the ONE scaffold behind both Fleet Health matrix panels
 * (WARDEN-1177).
 *
 * FleetActivityHeatmap (WARDEN-532) and FleetStateTimeline (WARDEN-788) are two
 * renderings of a single shape: `<section>` → CollapsibleSectionHeader → a
 * three-way loading/error/empty branch → `role="grid"` → a sparse column-header
 * row → per-agent `role="row"` + `role="rowheader"` → cells → legend. Of their
 * normalized bodies 145 lines were character-identical, and the WARDEN-1078
 * error-channel fix had to be typed out twice (28 of its 48 code lines were the
 * redundant second copy). This component owns that shared scaffold so the next
 * cross-cutting fix is one edit.
 *
 * It is the second layer of the same extraction `CollapsibleSectionHeader`
 * (WARDEN-1050) started — that component owns the header; this one owns the
 * grid around it.
 *
 * WHAT IS PARAMETERIZED, AND WHY (the divergences are real, not accidents —
 * uniformizing any of them would be a silent behavior change):
 *
 *  - `renderCell` is a RENDER PROP, not a className parameter, because the two
 *    cells differ in element ARITY: the timeline's cell is a `<div>` wrapping a
 *    glyph `<span>` (its WCAG 1.4.1 non-color channel), the heatmap's is a
 *    self-closing `<div>` carrying a computed `style={{ opacity }}`. Per-cell
 *    tooltip/aria construction differs too, so it lives in there with them.
 *  - `legend` is a SLOT, not a shared loop: the timeline's legend is a
 *    per-state swatch+glyph+label list, the heatmap's is a `less → ramp → more`
 *    intensity scale plus an error swatch. They are unrelated components.
 *  - Colour domains (STATE_BG/cellBg vs OPACITY_FLOOR/intensityOpacity) stay in
 *    each panel file — this scaffold has no palette of its own.
 *  - Every user-facing noun (`sectionAriaLabel`, `headerLabel`, `loadingText`,
 *    `errorText`, `emptyText`) is a per-panel string, and the two aria-label
 *    producers arrive as plain function props (their arities are identical), so
 *    the announced strings are byte-identical to what each panel produced alone.
 *
 * Generic over the cell type (`TCell` = StateCell | HeatmapCell) — no `any`, no
 * casts, no widening: `StateRow`/`HeatmapRow` are already structurally
 * `MatrixRow<TCell>`.
 *
 * Collapse state is LOCAL React state (deliberately NOT a persisted /api/config
 * pref — avoids the dead-pref trap), owned here on behalf of both panels.
 * Defaults OPEN.
 */

/**
 * One matrix row: the agent + its per-bucket cells. Structurally the shared
 * shape of `StateRow` (stateTimeline.ts) and `HeatmapRow` (heatmap.ts) — both
 * already expose exactly `{ agent: { container }, cells }`, so neither library
 * type needs to change and neither call site needs a cast.
 */
export interface MatrixRow<TCell> {
  /** `container` is NON-null on a row — the selectors filter case-1 chats out. */
  agent: { container: string };
  /** Per-bucket cells, parallel to the shared bucket grid (`buckets`). */
  cells: TCell[];
}

/** Everything `renderCell` needs to build one cell, with no scaffold state leaking. */
export interface MatrixCellContext<TCell> {
  /** The cell itself — the panel's own cell type. */
  cell: TCell;
  /** Column index within the row (also the index into `buckets`). */
  index: number;
  /** The row agent's resolved display name (for the tooltip prefix). */
  agentName: string;
  /** Epoch-ms start of this cell's bucket. */
  bucket: number;
}

export interface FleetMatrixPanelProps<TCell> {
  /** `aria-label` on the outer `<section>` (e.g. "Fleet activity over the last 24 hours"). */
  sectionAriaLabel: string;
  /** Visible title in the collapsible header (e.g. "Fleet activity · 24h"). */
  headerLabel: string;
  /** The matrix rows, in catalog order. */
  rows: readonly MatrixRow<TCell>[];
  /** Epoch-ms bucket starts — the shared column axis. */
  buckets: readonly number[];
  /** The fleet agents — the display-name source for each row header. */
  agents: readonly Chat[];
  /** Routes the sparse column time-labels through the shared timestamp helper. */
  timestampFormat: TimestampFormat;
  /** True only during the very first fetch, before any data has arrived. The
   *  ONLY honest source for "still loading" (WARDEN-1078). */
  loading: boolean;
  /** Last fetch error from useActivitySeries, or null. */
  error: Error | null;
  /** Whether a series has EVER arrived. `loading`/`error` are surfaced only when
   *  it is false, so a blip after a good poll keeps the last good matrix on
   *  screen rather than swapping it for an error (WARDEN-1078). */
  hasSeries: boolean;
  /** Empty-branch copy while the first fetch is in flight. */
  loadingText: string;
  /** Empty-branch copy prefix for a failed first fetch — the error message is
   *  appended after ": " exactly as each panel wrote it. */
  errorText: string;
  /** Empty-branch copy when the fetch succeeded but there is nothing to show. */
  emptyText: string;
  /** The panel's whole-matrix aria-label producer (`matrixAriaLabel` / `matrixStateAriaLabel`). */
  matrixAriaLabel: (rows: readonly MatrixRow<TCell>[], bucketCount: number) => string;
  /** The panel's per-row aria-label producer (`rowAriaLabel` / `rowStateAriaLabel`). */
  rowAriaLabel: (cells: readonly TCell[]) => string;
  /** Renders ONE cell. MUST set `key` on the returned element (it lands directly
   *  in the cells array). Owns the cell's element arity, className, style,
   *  tooltip and aria-label — all of which differ between the two panels. */
  renderCell: (ctx: MatrixCellContext<TCell>) => ReactNode;
  /** The panel's legend body, rendered inside the shared legend row when there
   *  are rows. The two legends are unrelated components, so this is a slot. */
  legend?: ReactNode;
}

// Sparse column label cadence: label ~every 6 buckets (≈ every 6h for the default
// 24h / 1h-bucket window) so the axis carries time context without clutter — and
// so the two stacked panels share axis ticks verbatim.
const LABEL_STEP = 6;
/** Cell-size class shared by every cell so the grid is uniform. Exported because
 *  each panel's own `renderCell` needs the identical class on its cell. */
export const MATRIX_CELL_SIZE = 'h-3 compact:h-2.5';

export function FleetMatrixPanel<TCell>({
  sectionAriaLabel,
  headerLabel,
  rows,
  buckets,
  agents,
  timestampFormat,
  loading,
  error,
  hasSeries,
  loadingText,
  errorText,
  emptyText,
  matrixAriaLabel,
  rowAriaLabel,
  renderCell,
  legend,
}: FleetMatrixPanelProps<TCell>) {
  // LOCAL collapse state — never serialized to /api/config (avoids the dead-pref
  // trap). Defaults open so the fleet pattern is glanceable on entry.
  const [open, setOpen] = useState(true);

  // Resolve each agent's display name by container (the matrix rows carry only
  // the container; the name is a render concern). Keyed by container — unique
  // per yatfa agent.
  const nameByContainer = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents) if (a.container) m.set(a.container, displayName(a));
    return m;
  }, [agents]);

  const colCount = buckets.length;
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

  const hasRows = rows.length > 0;

  return (
    <section className="rounded-md border border-border bg-card/40" aria-label={sectionAriaLabel}>
      {/* Collapsible header. Chevron ▾/▸ mirrors the host-grouping collapse in
          HealthDashboard so the affordance reads the same everywhere. Shared
          with the sibling Fleet Health panels (WARDEN-1050). */}
      <CollapsibleSectionHeader
        open={open}
        onToggle={() => setOpen((v) => !v)}
        label={headerLabel}
        meta={hasRows ? `${rows.length} agent${rows.length === 1 ? '' : 's'}` : ''}
      />

      {open && (
        <div className="px-2 pb-2 pt-0.5">
          {hasRows ? (
            <div
              role="grid"
              aria-label={matrixAriaLabel(rows, colCount)}
              aria-rowcount={rows.length + 1}
              aria-colcount={colCount + 1}
              className="flex flex-col gap-px"
            >
              {/* Column-header row: a corner spacer + one header per bucket.
                  Only the sparse labelled columns carry a time tick (and a
                  columnheader role); the rest are presentational spacers so a
                  screen reader isn't read 24 blank headers. */}
              <div role="row" className="grid" style={{ gridTemplateColumns: gridCols, gap: '1px' }}>
                <div role="presentation" className={MATRIX_CELL_SIZE} aria-hidden="true" />
                {buckets.map((b, i) =>
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
              {rows.map((row) => {
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
                    {row.cells.map((cell, i) =>
                      renderCell({ cell, index: i, agentName: name, bucket: buckets[i] }),
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            // Graceful empty state: series still loading, the fetch failed, or
            // there are no container-bearing agents / no history yet. Never
            // render a misleading empty grid — and never claim to be loading
            // data we have already given up on (WARDEN-1078). `loading` is the
            // only honest "still fetching" signal; `error` is only surfaced when
            // NO series ever arrived, so a blip after a good poll leaves the
            // matrix above on screen.
            <div className="py-2 text-center text-[10px] text-muted-foreground">
              {loading && !hasSeries ? (
                loadingText
              ) : error && !hasSeries ? (
                <span className="text-destructive">
                  ⚠ {errorText}: {error.message}
                </span>
              ) : (
                emptyText
              )}
            </div>
          )}

          {/* Legend row — the shared container; the swatches themselves are the
              panel's own (a state key vs an intensity ramp). */}
          {hasRows && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[9px] text-muted-foreground">
              {legend}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
