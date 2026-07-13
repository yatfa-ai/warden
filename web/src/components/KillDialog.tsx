// The confirm-and-stop dialog for the multi-select batch-kill feature
// (WARDEN-328).
//
// This is the SAFETY GATE: a human who has selected N agents and hit "Kill N…"
// lands here before a single tmux session is stopped. It shows the FULL target
// list (name · type · host · role — so a kind/host mismatch is visible before
// the stop), a live count, and a clear warning that this stops each agent's
// tmux session. Nothing is stopped until the explicit destructive "Stop N"
// Confirm — the dialog is ALWAYS shown (no opt-out), matching the broadcast
// precedent and the WARDEN-68 destructive-action bar.
//
// The dialog is presentational + owns its killing state; the actual fan-out
// (Promise.allSettled over /api/kill per target) lives in the parent
// (ChatSidebar) via `onKill`, which returns the per-agent summary so the parent
// can surface the result toast and clear the selection. Keeping the network +
// toast logic in the parent matches where the other chat-op fetches live
// (kill/resume/rename in App.tsx); keeping the spinner state here keeps it out
// of ChatSidebar's already-large state surface.
import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import { chatType, displayName, hostTagOf } from '@/lib/chatDisplay';
import type { Chat } from '@/lib/types';
import type { KillSummary } from '@/lib/kill';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Resolved selected chats, in display order. Empty list disables Stop. */
  targets: Chat[];
  /** Stop every selected agent. Resolves with the per-agent summary (the parent
   *  toasts it + clears the selection). Never rejects — partial failure is
   *  encoded in the summary, not thrown. */
  onKill: () => Promise<KillSummary>;
}

export function KillDialog({ open, onOpenChange, targets, onKill }: Props) {
  const [killing, setKilling] = useState(false);

  // Reset on every open so a previous attempt's spinner can't linger.
  useEffect(() => {
    if (open) setKilling(false);
  }, [open]);

  const count = targets.length;
  const canKill = count > 0 && !killing;

  const handleKill = async () => {
    if (!canKill) return;
    setKilling(true);
    try {
      // onKill resolves (never rejects) once every per-target kill has settled —
      // close on resolve; the parent has already surfaced the result toast.
      await onKill();
      onOpenChange(false);
    } finally {
      setKilling(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!killing) onOpenChange(o); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Stop {count} agent{count === 1 ? '' : 's'}?</DialogTitle>
          <DialogDescription>
            Stops each selected agent's tmux session via the same durable path as the per-row stop. Each stop is independent — one failure won't block the others.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {/* The full target list — name · type · host · role — so the human can
              confirm EXACTLY which sessions will die before confirming (e.g. a
              yatfa-role agent mixed in with bare tmux shells). Scrollable so a
              large fleet selection doesn't grow the dialog past the viewport. */}
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Targets</span>
            <div className="rounded-md border border-border max-h-44 overflow-auto">
              <ul className="divide-y divide-border">
                {targets.map((c) => {
                  const name = displayName(c);
                  const type = chatType(c);
                  const host = hostTagOf(c.host || '');
                  return (
                    <li key={c.key || c.id} className="flex items-center gap-2 px-2 py-1 text-xs">
                      <span className="truncate flex-1" title={name}>{name}</span>
                      <span className="shrink-0 text-muted-foreground">{type}</span>
                      <span className="shrink-0 text-muted-foreground">{host}</span>
                      {c.role && <span className="shrink-0 text-muted-foreground/70">{c.role}</span>}
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>

          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
            ⚠ This stops each agent's tmux session. The container keeps running; yatfa agents are re-discovered, manual tmux chats are forgotten. Nothing is stopped until you confirm.
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={killing}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={handleKill} disabled={!canKill}>
            {killing ? (
              <>
                <Loader2 className="animate-spin" />
                Stopping…
              </>
            ) : (
              `Stop ${count}`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
