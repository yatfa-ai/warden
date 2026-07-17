// The confirm-and-snooze dialog for the multi-select bulk-snooze feature
// (WARDEN-581).
//
// This is the CONFIRMATION + DURATION-PICKER gate: a human who has selected N
// agents and hit "Snooze N…" lands here before a single snooze is written. It
// shows the FULL target list (name · type · host · role), a live count, and a
// duration selector bounded to the two time-boxed snooze options. Nothing is
// snoozed until the explicit "Snooze N" Confirm — the dialog is ALWAYS shown
// (no opt-out), matching the broadcast/kill/interrupt precedent and the
// WARDEN-68 quality bar.
//
// Snooze is LOCAL client-side state (UiState.snoozedAlertKeys), so — unlike
// broadcast/kill/interrupt — there is no tmux fan-out, no per-agent failure, and
// no network round-trip. The dialog is therefore presentational only: on Confirm
// it hands the chosen duration to `onSnooze`, which the parent (ChatSidebar)
// routes to App's `snoozeMany` (one state write for the whole selected set),
// surfaces a single result toast, and clears the selection.
//
// The two durations come from the SHARED SNOOZE_DURATION_OPTIONS (snooze.ts) so
// this dialog offers byte-for-byte the same windows + wording as the per-row bell
// menu (AttentionBadge) — one snooze vocabulary, two entry points. PERMANENT
// mute is deliberately absent here (WARDEN-581 out-of-scope: the forget-and-go-
// stale risk argues against one-click permanent mute on a group).
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
import { chatType, displayName, hostTagOf } from '@/lib/chatDisplay';
import { SNOOZE_DURATION_OPTIONS, type SnoozeDuration } from '@/lib/snooze';
import type { Chat } from '@/lib/types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Resolved selected chats, in display order. Empty list disables the confirm. */
  targets: Chat[];
  /** Snooze every selected chat for `duration`. Resolves once the parent has
   *  written the state + surfaced the result toast. Never rejects — snooze is
   *  pure local state with no per-agent failure mode. */
  onSnooze: (duration: SnoozeDuration) => void;
}

export function SnoozeDialog({ open, onOpenChange, targets, onSnooze }: Props) {
  // Default to '1h' — the common case ("this host is flapping; quiet it for an
  // hour while I fix the shared dependency"). Reset to it on every open so a
  // previous pick can't linger to be re-applied by accident on the next batch.
  const [duration, setDuration] = useState<SnoozeDuration>('1h');

  useEffect(() => {
    if (open) setDuration('1h');
  }, [open]);

  const count = targets.length;
  const canSnooze = count > 0;

  const handleSnooze = () => {
    if (!canSnooze) return;
    onSnooze(duration);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        // ⌘/Ctrl+Enter confirms — matches BroadcastDialog/KeySendDialog's confirm
        // intent (a keyboard path to the footer button) without a mouse trip.
        // Only the chord (not bare Enter) so it never collides with the Select's
        // own Enter-to-open behavior.
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleSnooze(); } }}
      >
        <DialogHeader>
          <DialogTitle>Snooze {count} agent{count === 1 ? '' : 's'}</DialogTitle>
          <DialogDescription>
            Temporarily silence desktop alerts for every selected agent until the chosen expiry. Each snooze auto-rearms on expiry — identical to the per-agent snooze, applied to the whole group in one action.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {/* The full target list — name · type · host · role — so a stray
              selection is visible BEFORE the snooze. Scrollable so a large fleet
              selection doesn't grow the dialog past the viewport. Mirrors the
              BroadcastDialog/KeySendDialog target list verbatim. */}
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

          {/* The duration selector — the only input. Bounded to
              SNOOZE_DURATION_OPTIONS (1h / until tomorrow); permanent mute is
              not offered in bulk. The pattern mirrors the key picker in
              KeySendDialog. */}
          <div className="flex flex-col gap-1">
            <label htmlFor="snooze-duration" className="text-xs text-muted-foreground">Duration</label>
            <Select value={duration} onValueChange={(v) => setDuration(v as SnoozeDuration)}>
              <SelectTrigger id="snooze-duration" className="text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SNOOZE_DURATION_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Non-destructive framing — snooze is temporary + auto-rearming, the
              deliberate contrast with Kill's destructive warning. Neutral styling
              (not destructive). */}
          <div className="rounded-md border border-border bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground">
            Snoozed agents show the muted state and fire no desktop alert until the expiry, then resume automatically. Permanent mute stays per-agent.
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {/* Non-destructive → default variant (NOT destructive). */}
          <Button type="button" onClick={handleSnooze} disabled={!canSnooze}>
            Snooze {count}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
