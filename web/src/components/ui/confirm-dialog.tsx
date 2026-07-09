import * as React from "react"

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"

interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  onConfirm: () => void
}

/**
 * Controlled confirmation dialog built from the existing Radix `Dialog`
 * primitives — no new dependency.
 *
 * Semantics are deliberately split so confirm and dismiss stay unambiguous:
 * - `onConfirm` fires ONLY when the confirm button is pressed. The caller is
 *   responsible for closing the dialog (set `open` to false) from within
 *   `onConfirm`, so the action and the close happen together.
 * - `onOpenChange(false)` fires on Cancel, Escape, and overlay click — i.e.
 *   every dismissal that is NOT a confirm. Treat it as "cancel".
 *
 * Radix auto-focuses the first focusable element (the Cancel button) on open.
 */
function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{cancelLabel}</Button>
          </DialogClose>
          <Button
            variant={destructive ? "destructive" : "default"}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export { ConfirmDialog }
