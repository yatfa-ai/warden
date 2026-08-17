import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * CollapsibleSectionHeader — the ONE definition of the Fleet Health panel header
 * (WARDEN-1050).
 *
 * Three panels (FleetActivityHeatmap / FleetStateTimeline / FleetRecentCommits)
 * had hand-copied the same header — chevron + label + right-hand count + a
 * 137-character Tailwind class literal — each feature copying the last
 * (5950e9a → b03a9a8 → 0a84afd). The copies' own comments admitted it.
 *
 * The duplication was not merely untidy; it produced an accessibility DEFECT.
 * FleetRecentCommits is the one panel whose header needed an action (a ↻
 * refresh), and a hand-copied `<button>` offers no slot for one — so the action
 * was placed INSIDE the toggle button. `Button` renders a native `<button>`
 * (ui/button.tsx: `const Comp = asChild ? Slot.Root : "button"`), so that was
 * literally `<button>` inside `<button>`: invalid HTML (button's content model
 * forbids interactive descendants — the `nested-interactive` violation, WCAG
 * 4.1.2), and it polluted the toggle's accessible name, which is computed from
 * its contents and so folded in the refresh button's label. An
 * `e.stopPropagation()` existed only to paper over the nesting.
 *
 * `actions` is therefore rendered as a SIBLING of the toggle button, never a
 * child — THAT is the point of the extraction. It makes the invalid nesting
 * structurally unrepresentable at every call site, present and future, and lets
 * the stopPropagation workaround be deleted.
 *
 * Deliberately NOT folded in: the host-group collapse in HealthDashboard
 * (~:1588). It is a different contract, not a fourth copy — per-host persisted
 * `collapsedHosts` state, an INVERTED chevron order, a `Button` rather than a
 * bare `<button>`, a multi-line flex-col body with a StatusDot, and a dynamic
 * aria-label/title. Forcing it through this component would be false
 * deduplication.
 */
export interface CollapsibleSectionHeaderProps {
  /** Whether the section body is currently expanded. */
  open: boolean;
  /** Fired when the toggle is activated. */
  onToggle: () => void;
  /** The visible title text. */
  label: string;
  /**
   * The toggle's accessible name. Explicit rather than scraped from the
   * chevron glyph + label + count (the HealthDashboard host-collapse pattern).
   */
  ariaLabel: string;
  /** Right-hand slot — the `N agents` count each panel renders. */
  meta?: ReactNode;
  /**
   * Header actions. Rendered as a SIBLING of the toggle button so an
   * interactive control can never nest inside it.
   */
  actions?: ReactNode;
}

export function CollapsibleSectionHeader({
  open,
  onToggle,
  label,
  ariaLabel,
  meta,
  actions,
}: CollapsibleSectionHeaderProps) {
  const toggle = (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={ariaLabel}
      className={cn(
        'flex items-center gap-1.5 px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:bg-accent rounded-md transition-colors',
        // With actions the toggle shares the row and must yield space to them;
        // without, it spans the header exactly as the three copies did.
        actions ? 'min-w-0 flex-1' : 'w-full',
      )}
    >
      <span className="text-[10px] text-muted-foreground/60 w-2 shrink-0">{open ? '▾' : '▸'}</span>
      <span>{label}</span>
      <span className="ml-auto normal-case tracking-normal text-[10px] text-muted-foreground/70">
        {meta}
      </span>
    </button>
  );

  // No actions → no wrapper, so the two action-less panels keep byte-identical
  // structure. The row wrapper exists only where there is a sibling to hold.
  if (!actions) return toggle;

  return (
    <div className="flex w-full items-center pr-1">
      {toggle}
      {actions}
    </div>
  );
}
