import type { ReactNode } from "react"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

interface IconTooltipProps {
  /** Themed tooltip body — a plain label or structured ReactNode (e.g. stacked lines). */
  label: ReactNode
  /** The interactive control (button, etc.) whose purpose the tooltip telegraphs. */
  children: ReactNode
  side?: "top" | "bottom" | "left" | "right"
  /**
   * Pass the control's own disabled state. Radix sets `aria-describedby` on the
   * trigger element (the `asChild` target). When `disabled` is false/omitted we
   * hand `children` straight to `asChild` so that attribute — and thus the
   * accessible description — lands on the real focusable control. Only the
   * disabled case needs the wrapping span: a disabled `<button>` drops pointer
   * events, so the span keeps receiving them and the tooltip still opens on
   * hover. Keyboard focus on the inner control bubbles up either way.
   */
  disabled?: boolean
}

/**
 * Wraps an icon/glyph control in the app's themed (dark-mode-aware) Radix
 * Tooltip so its meaning is shown through one app-consistent channel instead of
 * raw browser `title=` chrome.
 *
 * The trigger is the control itself (via `asChild`) for every enabled control,
 * preserving its keyboard/focus semantics and accessible description. Only
 * disabled controls are wrapped in a span — see `disabled`.
 */
export function IconTooltip({ label, children, side = "top", disabled }: IconTooltipProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {disabled ? <span className="inline-flex">{children}</span> : children}
      </TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  )
}
