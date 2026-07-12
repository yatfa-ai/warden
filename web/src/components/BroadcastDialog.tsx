// The confirm-and-send dialog for the multi-select broadcast feature (WARDEN-292).
//
// This is the SAFETY GATE: a human who has selected N agents and hit "Send to N
// selected…" lands here before a single byte reaches a tmux session. It shows the
// FULL target list (name · type · host · role — so a kind/host mismatch is visible
// before the send, per the host/kind-awareness constraint), a live count, and a
// message textarea. Nothing sends until the explicit "Send to N" Confirm.
//
// The dialog is presentational + owns its textarea/sending state; the actual
// fan-out (Promise.allSettled over /api/send per target) lives in the parent
// (ChatSidebar) via `onSend`, which returns the per-agent summary so the parent
// can surface the result toast and clear the selection. Keeping the network +
// toast logic in the parent matches where the other chat-op fetches live
// (kill/resume/rename in App.tsx); keeping the textarea state here keeps it out
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
import { Textarea } from '@/components/ui/textarea';
import { Loader2 } from 'lucide-react';
import { chatType, displayName, hostTagOf } from '@/lib/chatDisplay';
import type { Chat } from '@/lib/types';
import type { BroadcastSummary } from '@/lib/broadcast';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Resolved selected chats, in display order. Empty list disables Send. */
  targets: Chat[];
  /** Fan out `text` to every selected agent. Resolves with the per-agent summary
   *  (the parent toasts it + clears the selection). Never rejects — partial
   *  failure is encoded in the summary, not thrown. */
  onSend: (text: string) => Promise<BroadcastSummary>;
}

export function BroadcastDialog({ open, onOpenChange, targets, onSend }: Props) {
  const [msg, setMsg] = useState('');
  const [sending, setSending] = useState(false);

  // Start every open fresh: a previous attempt's text shouldn't linger to be
  // re-sent by accident on the next selection.
  useEffect(() => {
    if (open) {
      setMsg('');
      setSending(false);
    }
  }, [open]);

  const count = targets.length;
  const trimmed = msg.trim();
  const canSend = count > 0 && trimmed.length > 0 && !sending;

  const handleSend = async () => {
    if (!canSend) return;
    setSending(true);
    try {
      // onSend resolves (never rejects) once every per-target send has settled —
      // close on resolve; the parent has already surfaced the result toast.
      await onSend(trimmed);
      onOpenChange(false);
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!sending) onOpenChange(o); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Send to {count} agent{count === 1 ? '' : 's'}</DialogTitle>
          <DialogDescription>
            Broadcasts the message to every selected agent's tmux session via the same durable path as typing into a pane. Each send is independent — one failure won't block the others.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {/* The full target list — name · type · host · role — so a kind/host
              mismatch is visible BEFORE the send (e.g. a yatfa-role agent mixed
              in with bare tmux shells). Scrollable so a large fleet selection
              doesn't grow the dialog past the viewport. */}
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Recipients</span>
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

          <div className="flex flex-col gap-1">
            <label htmlFor="broadcast-msg" className="text-xs text-muted-foreground">Message</label>
            <Textarea
              id="broadcast-msg"
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
              placeholder="e.g., pull latest and run the test suite"
              autoFocus
              disabled={sending}
              className="min-h-[80px] text-sm"
              // ⌘/Ctrl+Enter confirms — matches the "confirm-and-send" intent
              // without a mouse trip to the footer button.
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleSend(); } }}
            />
            <span className="text-[10px] text-muted-foreground">⌘/Ctrl+Enter to send · nothing is sent until you confirm</span>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={sending}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSend} disabled={!canSend}>
            {sending ? (
              <>
                <Loader2 className="animate-spin" />
                Sending…
              </>
            ) : (
              `Send to ${count}`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
