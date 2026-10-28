import type { Chat } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { PowerIcon, RefreshCwIcon, SquareTerminalIcon, XIcon } from 'lucide-react';

// In-pane recovery / unresponsive overlay (WARDEN-231). Replaces the infinite
// "connecting" spinner for a dead or unreachable session with an explicit
// message and user-controllable actions. Uses shadcn Button + lucide icons, no
// magic-number sizes or inline styles (UI standards WARDEN-68). Two variants:
//   recovery    — session dead, host up: [Open shell here], [Re-spawn agent]
//                 (only when the chat carries a respawnable cmd), [Close].
//   unresponsive— host unreachable / attach error: [Retry], [Close].
export function RecoveryPanel({
  title,
  description,
  icon,
  chat,
  busy,
  variant = 'recovery',
  onOpenShell,
  onRespawn,
  onRetry,
  onClose,
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  chat?: Chat | null;
  busy: boolean;
  variant?: 'recovery' | 'unresponsive';
  onOpenShell?: () => void;
  onRespawn?: () => void;
  onRetry?: () => void;
  onClose: () => void;
}) {
  // Re-spawn is offered only for chats warden owns (manual/spawned kind:'tmux'
  // with a stored cmd); yatfa chats are externally managed and carry no cmd.
  // WARDEN-1422: an EMPTY cmd is a real command (the host login shell, the
  // plain-shell spawn) — only a missing cmd is unrespawnable.
  const respawnable = chat?.kind === 'tmux' && chat?.cmd != null;
  return (
    <div
      className="absolute inset-0 z-10 flex items-center justify-center bg-background/80 p-4 text-center backdrop-blur-sm"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex w-full max-w-sm flex-col items-center gap-3">
        <div className="flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
          {icon}
        </div>
        <div className="text-sm font-medium text-foreground">{title}</div>
        <p className="text-xs text-muted-foreground">{description}</p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {variant === 'recovery' ? (
            <>
              <Button size="sm" onClick={onOpenShell} disabled={busy || !chat}>
                <SquareTerminalIcon /> Open shell here
              </Button>
              {respawnable && (
                <Button size="sm" variant="outline" onClick={onRespawn} disabled={busy}>
                  <PowerIcon /> Re-spawn agent
                </Button>
              )}
            </>
          ) : (
            <Button size="sm" onClick={onRetry} disabled={busy}>
              <RefreshCwIcon /> Retry
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
            <XIcon /> Close
          </Button>
        </div>
      </div>
    </div>
  );
}
