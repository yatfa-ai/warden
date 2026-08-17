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
   * OPTIONAL override for the toggle's accessible name. Leave it unset: the
   * default is composed from what is actually on screen — `label`, the textual
   * `meta`, and the state word — mirroring HealthDashboard's host collapse
   * (`${hostLabel}: ${n} agents${collapsed ? ', expand' : ', collapse'}`).
   *
   * Composing rather than hand-writing is deliberate. `aria-label` WINS over
   * element contents in the accessible-name computation, so a hand-written
   * string silently DISCARDS the visible label — which fails WCAG 2.5.3 Label
   * in Name (a speech-input user saying "click Fleet state 24h" can no longer
   * reach the control) and drops the agent count a screen-reader user used to
   * hear. Deriving it makes the correct name the path of least resistance and
   * still keeps the name deliberate: the ▾/▸ glyph and any `actions` label stay
   * out of it, which is the whole reason this is not left to content scraping.
   *
   * Only pass this when the derived name genuinely cannot serve (e.g. a `meta`
   * that is a non-textual node); prefer fixing `label`/`meta` first.
   */
  ariaLabel?: string;
  /**
   * Right-hand slot — the `N agents` count each panel renders. A string or
   * number here also feeds the derived accessible name; a richer node cannot
   * be read as text and is omitted from it (pass `ariaLabel` in that case).
   */
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
  // Only text-ish meta can be spoken; a node has no reliable string form.
  const metaText = typeof meta === 'string' || typeof meta === 'number' ? String(meta) : '';
  const name =
    ariaLabel ?? [label, metaText, open ? 'collapse' : 'expand'].filter(Boolean).join(', ');

  const toggle = (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={name}
      className={cn(
        'flex items-center gap-1.5 px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:bg-accent rounded-md transition-colors',
        // With actions the toggle shares the row and must yield space to them;
        // without, it spans the header exactly as the three copies did.
        // The pr-1.5 (vs px-2) is what keeps the count-to-action gap at the
        // 6px the inline `gap-1.5` used to give it — see the wrapper below.
        actions ? 'min-w-0 flex-1 pr-1.5' : 'w-full',
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
    // Geometry matches the pre-extraction inline header exactly: the toggle's
    // pr-1.5 restores the old `gap-1.5` (6px) between the count and the action,
    // and this pr-2 restores the old `px-2` (8px) right inset of the action.
    <div className="flex w-full items-center pr-2">
      {toggle}
      {actions}
    </div>
  );
}
