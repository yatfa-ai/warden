import { cn } from '@/lib/utils';

/**
 * StatusDot — a status indicator that NEVER conveys state by hue alone.
 *
 * WCAG 2.1 **1.4.1 Use of Color (Level A)** requires that information conveyed
 * by color also be conveyed by a second, non-color cue. StatusDot pairs the
 * existing color (retained for fast sighted scanning) with a non-color cue:
 *
 *  - a distinct **shape** (filled circle / hollow ring / square / pulsing), or
 *  - a visible **glyph** character (e.g. `✓ ◐ ✕ ○ ·`).
 *
 * Each dot also exposes an accessible name via `role="img"` + `aria-label`,
 * so the state is announced by screen readers without relying on a bare
 * `title` tooltip. The `label` prop is required on purpose so a hue-only dot
 * can never silently recur.
 *
 * Shape cue legend (all grayscale-legible at small sizes):
 *   solid  — filled circle  → good / active / connected / online
 *   ring   — hollow circle  → idle / neutral / disconnected / unknown
 *   square — filled square  → bad / error / dead / critical / offline
 *   pulse  — pulsing circle → in-progress / connecting / reconnecting
 *   glyph  — text character → multi-state indicators (e.g. health)
 */

export type StatusTone = 'green' | 'red' | 'yellow' | 'gray' | 'muted' | 'cyan';
export type StatusVariant = 'solid' | 'ring' | 'square' | 'pulse' | 'glyph';

/** Literal class maps so Tailwind v4's scanner can see every class. */
const TONE_BG: Record<StatusTone, string> = {
  green: 'bg-green-500',
  red: 'bg-red-500',
  yellow: 'bg-yellow-500',
  gray: 'bg-gray-400',
  muted: 'bg-muted-foreground/60',
  cyan: 'bg-cyan-500',
};

const TONE_BORDER: Record<StatusTone, string> = {
  green: 'border-green-500',
  red: 'border-red-500',
  yellow: 'border-yellow-500',
  gray: 'border-gray-400',
  muted: 'border-muted-foreground/60',
  cyan: 'border-cyan-500',
};

const TONE_TEXT: Record<StatusTone, string> = {
  green: 'text-green-500',
  red: 'text-red-500',
  yellow: 'text-yellow-500',
  gray: 'text-gray-400',
  muted: 'text-muted-foreground',
  cyan: 'text-cyan-500',
};

export interface StatusDotProps {
  /** Accessible name describing the state (e.g. "Connected"). Required. */
  label: string;
  /** Color family — retained as a fast sighted cue; not the only cue. */
  tone: StatusTone;
  /** Non-color cue: a shape, or `glyph` to render the `glyph` character. */
  variant: StatusVariant;
  /** Character shown when `variant === 'glyph'`. */
  glyph?: string;
  /** Box size for shape variants. Defaults to `size-2`. Ignored by `glyph`. */
  size?: string;
  /** Native hover tooltip. Defaults to `label`. */
  title?: string;
  className?: string;
}

export function StatusDot({
  label,
  tone,
  variant,
  glyph,
  size = 'size-2',
  title,
  className,
}: StatusDotProps) {
  const resolvedTitle = title ?? label;

  if (variant === 'glyph') {
    return (
      <span
        role="img"
        aria-label={label}
        title={resolvedTitle}
        className={cn(
          'inline-flex shrink-0 items-center justify-center leading-none font-bold select-none text-[11px]',
          TONE_TEXT[tone],
          className,
        )}
      >
        {glyph}
      </span>
    );
  }

  const shape =
    variant === 'ring'
      ? cn('rounded-full bg-transparent border-2', TONE_BORDER[tone])
      : variant === 'square'
        ? cn('rounded-[2px]', TONE_BG[tone])
        : cn('rounded-full', TONE_BG[tone]);

  return (
    <span
      role="img"
      aria-label={label}
      title={resolvedTitle}
      className={cn(size, 'inline-block shrink-0', shape, variant === 'pulse' && 'animate-pulse', className)}
    />
  );
}
