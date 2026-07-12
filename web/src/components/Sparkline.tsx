import { cn } from '@/lib/utils';

/**
 * Sparkline — a compact, dependency-free SVG activity strip (WARDEN-299).
 *
 * Warden's first visualization primitive: a hand-rolled bar series (no chart
 * library — the established Warden viz pattern, and a hard no-dependency gate).
 * Designed to be reused later by the sidebar ChatRow and a per-host rollup; this
 * slice adopts it only in HealthDashboard.
 *
 * Encoding (WCAG 2.1 1.4.1 — never color alone):
 *  - bar HEIGHT ∝ the bucket's event `total` (volume);
 *  - a RED segment at the bar's base ∝ the bucket's `error` sub-count, so an
 *    error burst reads as a cluster of red bases even at a glance;
 *  - an idle agent (all-zero / empty `values`) renders a deliberately flat
 *    baseline — never a blank — so "quiet" is a visible shape, not missing ink;
 *  - every sparkline carries an `ariaLabel` summarizing recent activity, so the
 *    signal survives grayscale / color-vision deficiency and is announced by
 *    screen readers (mirrors the StatusDot glyph+label pattern, WARDEN-68).
 *
 * Theme + density: colors come from the existing muted-foreground + red-500
 * vocabulary HealthDashboard already uses (theme-aware via Tailwind tokens, no
 * magic px); the element is sized with spacing-token classes and tightens under
 * `.compact` via the `compact:` variant (passed by the caller). Internal
 * geometry uses a unitless viewBox, so it scales to the element's CSS size with
 * no px leakage. `preserveAspectRatio="none"` lets the bars fill the strip; we
 * therefore render only fills (no strokes), which don't distort under non-uniform scaling.
 */
export interface SparklineProps {
  /** Per-bucket totals; bar height is proportional to each value. */
  values: number[];
  /** Per-bucket error sub-counts (same length as `values`). Renders a red base segment. */
  errors?: number[];
  /** Accessible summary, e.g. "12 events, 3 errors in the last 24 hours". Required — never color-only. */
  ariaLabel: string;
  /** Element width as a Tailwind spacing-token class (e.g. 'w-16'). */
  width?: string;
  /** Element height as a Tailwind spacing-token class (e.g. 'h-5'). */
  height?: string;
  className?: string;
}

// Unitless viewBox geometry. These scale to the element's CSS size, so they are
// NOT px (no magic-px leakage). 100 × 20 (~5:1) leaves room for 24 hourly bars.
const VB_W = 100;
const VB_H = 20;
// 1-unit (unitless) gap between bars — the only "spacing" inside the viewBox.
const GAP = 1;
// Height of the idle baseline rect, in viewBox units. A thin strip at the
// bottom reads as a flatline rather than an empty slot.
const BASELINE_H = 2;

export function Sparkline({
  values,
  errors,
  ariaLabel,
  width = 'w-16',
  height = 'h-5',
  className,
}: SparklineProps) {
  const n = values.length;
  const err = errors ?? [];
  const hasData = n > 0 && values.some((v) => v > 0);

  // max(1, …) so even a low-volume agent (max total of 1) shows visible bars
  // rather than a flat line — it is alive, not idle.
  const max = hasData ? Math.max(1, ...values) : 1;
  const barW = n > 1 ? (VB_W - GAP * (n - 1)) / n : VB_W;

  return (
    <svg
      role="img"
      aria-label={ariaLabel}
      className={cn('text-muted-foreground shrink-0', width, height, className)}
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      preserveAspectRatio="none"
    >
      {hasData
        ? values.map((v, i) => {
            const x = i * (barW + GAP);
            const totalH = (v / max) * VB_H;
            const errorCount = err[i] ?? 0;
            // Clamp the red base to the total height so it can never overshoot.
            const errorH = Math.min(totalH, (errorCount / max) * VB_H);
            const hadError = errorCount > 0;
            return (
              <g key={i}>
                {/* total-volume bar (muted); tinted red when the bucket errored,
                    so the whole bar signals trouble, with a crisp base below. */}
                <rect
                  x={x}
                  y={VB_H - totalH}
                  width={barW}
                  height={totalH}
                  className={hadError ? 'fill-red-500/70' : 'fill-current opacity-60'}
                />
                {/* crisp red base for the error sub-count, so a burst reads even
                    when the error fraction is small relative to total volume. */}
                {hadError && errorH > 0 && (
                  <rect x={x} y={VB_H - errorH} width={barW} height={errorH} className="fill-red-500" />
                )}
              </g>
            );
          })
        : // Idle / empty: a flat baseline so a quiet agent is a visible shape.
          <rect x={0} y={VB_H - BASELINE_H} width={VB_W} height={BASELINE_H} className="fill-current opacity-40" />}
    </svg>
  );
}
