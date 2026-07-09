import type { ReactNode } from "react"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

interface IconTooltipProps {
  /** Themed tooltip body — a plain label or structured ReactNode (e.g. stacked lines). */
  label: ReactNode
  /** The interactive control (button, etc.) whose purpose the tooltip telegraphs. */
  children: ReactNode
  side?: "top" | "bottom" | "left" | "right"
}

/**
 * Wraps an icon/glyph control in the app's themed (dark-mode-aware) Radix
 * Tooltip so its meaning is shown through one app-consistent channel instead of
 * raw browser `title=` chrome.
 *
 * The trigger wraps `children` in a span — the Radix pattern for tooltips that
 * must also open on *disabled* controls (a disabled <button> drops pointer
 * events, but the wrapping span keeps receiving them). Keyboard focus on the
 * inner control bubbles up, so the tooltip still opens for keyboard users.
 */
export function IconTooltip({ label, children, side = "top" }: IconTooltipProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{children}</span>
      </TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  )
}
