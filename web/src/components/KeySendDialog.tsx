// The confirm-and-interrupt dialog for the multi-select batch-interrupt feature
// (WARDEN-492).
//
// This is the CONFIRMATION GATE: a human who has selected N agents and hit
// "Interrupt N…" lands here before a single key reaches a tmux session. It shows
// the FULL target list (name · type · host · role — so a kind/host mismatch is
// visible before the send), a live count, a key selector, and clear
// NON-DESTRUCTIVE framing. Nothing is sent until the explicit "Interrupt N"
// Confirm — the dialog is ALWAYS shown (no opt-out), matching the broadcast/kill
// precedent and the WARDEN-68 quality bar.
//
// Interrupt is deliberately framed apart from Kill (KillDialog): sending Ctrl-C
// signals only the foreground process; the session and its scrollback are NOT
// affected (unlike Kill, whose destructive warning says it stops the session).
// The human can re-attach and continue — the observable difference from Kill.
//
// The dialog is presentational + owns its key-pick/sending state; the actual
// fan-out (Promise.allSettled over /api/key per target, in @/lib/keysend) is
// driven by the parent via `onSend`, which returns the per-agent summary so the
// parent can surface the result toast and clear the selection. Keeping the
// network + toast logic in the parent matches where the other chat-op fetches
// live (broadcast/kill); keeping the key-pick state here keeps it out of the
// parent's already-large state surface.
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Loader2 } from 'lucide-react';
import { chatType, displayName, hostTagOf } from '@/lib/chatDisplay';
import type { Chat } from '@/lib/types';
import type { KeySendSummary } from '@/lib/keysend';

// The control-key vocabulary this dialog can offer — a bounded subset of the
// backend's ALLOWED_KEYS (src/tmux.js), limited to the control/interrupt keys.
// The backend's sendKey rejects anything outside ALLOWED_KEYS, so this list is
// also a correctness guard: the Select can never offer a key /api/key would
// refuse. Do NOT surface text-input keys here — this slice is the control
// vocabulary only. `value` is the raw tmux token POSTed to /api/key.
const KEY_OPTIONS = [
  { value: 'C-c', label: 'Ctrl-C — Interrupt' },
  { value: 'Escape', label: 'Esc — Dismiss prompt / clear input' },
] as const;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Resolved selected chats, in display order. Empty list disables the send. */
  targets: Chat[];
  /** Fan `key` out to every selected agent. Resolves with the per-agent summary
   *  (the parent toasts it + clears the selection). Never rejects — partial
   *  failure is encoded in the summary, not thrown. */
  onSend: (key: string) => Promise<KeySendSummary>;
}

export function KeySendDialog({ open, onOpenChange, targets, onSend }: Props) {
  // Default to C-c — the common case ("all my agents are stuck / looping; stop
  // them now without losing their work"). Reset to it on every open so a previous
  // pick can't linger to be re-sent by accident on the next selection.
  const [key, setKey] = useState('C-c');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (open) {
      setKey('C-c');
      setSending(false);
    }
  }, [open]);

  const count = targets.length;
  const canSend = count > 0 && !sending;

  const handleSend = async () => {
    if (!canSend) return;
    setSending(true);
    try {
      // onSend resolves (never rejects) once every per-target send has settled —
      // close on resolve; the parent has already surfaced the result toast.
      await onSend(key);
      onOpenChange(false);
    } finally {
      setSending(false);
    }
  };

  // The verb in the title/button tracks the key, matching the result-toast copy
  // in formatKeySendToast: "Interrupt N" for C-c, "Send Esc to N" for Escape.
  const verb = key === 'C-c' ? 'Interrupt' : 'Send Esc to';

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!sending) onOpenChange(o); }}>
      <DialogContent
        className="sm:max-w-md"
        // ⌘/Ctrl+Enter confirms — matches BroadcastDialog's confirm intent (a
        // keyboard path to the footer button) without a mouse trip. Only the
        // chord (not bare Enter) so it never collides with the Select's own
        // Enter-to-open behavior.
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleSend(); } }}
      >
        <DialogHeader>
          <DialogTitle>{verb} {count} agent{count === 1 ? '' : 's'}</DialogTitle>
          <DialogDescription>
            Sends the key to every selected agent's tmux session via the same durable path as typing into a pane. Each send is independent — one failure won't block the others.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {/* The full target list — name · type · host · role — so a kind/host
              mismatch is visible BEFORE the send (e.g. a yatfa-role agent mixed
              in with bare tmux shells). Scrollable so a large fleet selection
              doesn't grow the dialog past the viewport. */}
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

          {/* The key selector — the only input. Bounded to KEY_OPTIONS
              (C-c / Escape); the Select can offer nothing /api/key would refuse.
              The pattern mirrors the snippet picker in BroadcastDialog. */}
          <div className="flex flex-col gap-1">
            <label htmlFor="keysend-key" className="text-xs text-muted-foreground">Key</label>
            <Select value={key} onValueChange={setKey} disabled={sending}>
              <SelectTrigger id="keysend-key" className="text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KEY_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* NON-DESTRUCTIVE framing — the deliberate contrast with Kill's
              destructive warning (KillDialog). Interrupt signals only the
              foreground process; the session and its scrollback survive so the
              human can re-attach and continue. Neutral styling (not destructive). */}
          <div className="rounded-md border border-border bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground">
            This signals only each agent's foreground process — the session and its history are <span className="font-medium">not</span> affected (unlike Kill, which stops the session). Re-attach to continue.
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={sending}>
            Cancel
          </Button>
          {/* Non-destructive → default variant (NOT destructive), the visible
              difference from Kill's red Confirm. */}
          <Button type="button" onClick={handleSend} disabled={!canSend}>
            {sending ? (
              <>
                <Loader2 className="animate-spin" />
                Sending…
              </>
            ) : (
              `${verb} ${count}`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
