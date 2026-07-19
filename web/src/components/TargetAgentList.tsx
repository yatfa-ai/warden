// The shared target-agent list for the four fleet-action confirmation dialogs
// (BroadcastDialog / KillDialog / KeySendDialog / SnoozeDialog).
//
// Each of those dialogs is a SAFETY GATE: it shows the FULL target list
// (name · type · host · role) so a kind/host mismatch is visible BEFORE the
// human confirms. The list is the whole point — it lets the eye spot a
// yatfa-role agent mixed in with bare tmux shells, and recognizing the HOST is
// exactly what does that. So every dialog must render the SAME host tag for the
// same target.
//
// This component exists because the four lists were hand-copied four times with
// nothing enforcing consistency. Two of the four (KeySendDialog, SnoozeDialog)
// had silently dropped the `useHostLabels` import and called hostTagOf with one
// arg — rendering the raw SSH hostname where their siblings (BroadcastDialog,
// KillDialog) rendered the friendly label (WARDEN-735). Calling useHostLabels()
// ONCE here and passing it to hostTagOf in the 2-arg (label-resolving) form
// means all four dialogs render the same host per target by construction, and
// a future fifth copy cannot drift again.
//
// Each caller keeps its OWN outer label span — the label text legitimately
// differs ("Recipients" for Broadcast, "Targets" for the other three) — so this
// component renders only the bordered, scrollable list body. `targets` is a
// Chat[] in display order, identical to the prop each dialog already receives.
import { chatType, displayName, hostTagOf } from '@/lib/chatDisplay';
import { useHostLabels } from '@/lib/hostLabels';
import type { Chat } from '@/lib/types';

export function TargetAgentList({ targets }: { targets: Chat[] }) {
  const hostLabels = useHostLabels();
  return (
    <div className="rounded-md border border-border max-h-44 overflow-auto">
      <ul className="divide-y divide-border">
        {targets.map((c) => {
          const name = displayName(c);
          const type = chatType(c);
          // 2-arg form — resolves a friendly label when one is configured,
          // falls back to the raw host otherwise (hostTagOf handles the
          // THIS_MACHINE → 'local' rewrite). The arity fix is the whole point.
          const host = hostTagOf(c.host || '', hostLabels);
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
  );
}
