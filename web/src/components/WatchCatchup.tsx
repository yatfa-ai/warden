// WatchCatchup — the presentational in-app recovery surface for per-chat "watch"
// pings that fired while the human was away (WARDEN-417). Fed by useWatchCatchup;
// rendered only when there are unacknowledged away misses (the parent hides it via
// `misses.length === 0`). Sibling of App.tsx's "While you were away" activity
// banner, but for the CLIENT-DETECTED watch path (which never appears in
// /api/activity/stats) — distinct amber tone so it reads as part of the attention
// system, not generic info.
//
// WARDEN-770 — each miss whose reason was a replyable state (waiting / blocked) now
// carries the SAME inline quick-reply affordance as the AttentionBadge popover + the
// return-banner callout, so the human can answer the watched agent that needed them
// while they were away WITHOUT opening the pane. The reply path is identical
// (/api/send + /api/key via the shared QuickReply control); only this surface's
// visual chrome is its own.
import { useState } from 'react';
import { Bell, X, Reply } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { QuickReply } from '@/components/QuickReply';
import { formatCatchupSummary, formatWatchMiss, type WatchMiss } from '@/lib/watchCatchup';
import { canReply } from '@/lib/quickReply';
import type { Snippet } from '@/lib/storage';
import { cn } from '@/lib/utils';

interface Props {
  /** Unacknowledged away watch misses (urgency-ranked, deduped per key; recovered chats suppressed on return). */
  misses: WatchMiss[];
  /** Deep-link to the watched chat's pane + ack it (per-key). */
  onOpenMiss: (miss: WatchMiss) => void;
  /** Dismiss the whole catch-up (ack all). */
  onDismiss: () => void;
  /** WARDEN-770 — saved instruction snippets for the reply control's one-click fills. */
  snippets?: Snippet[];
  /** WARDEN-770 — surface the reply send outcome so App can toast it. */
  onReplyResult?: (ok: boolean, error?: string) => void;
}

/**
 * Each row names the chat and conveys the reason + triggering signal (the WARDEN-68
 * beauty bar: WHICH chat and WHY without opening it) — the in-app twin of the OS
 * notification that was missed / unsupported / denied / cleared. Clicking deep-links
 * to the pane via onOpenMiss; the × dismisses the lot. This is NOT an OS
 * notification: its job is to recover what the single OS channel lost, on return.
 *
 * For a replyable miss (the ping fired on waiting/blocked), a Reply toggle beside the
 * row reveals the QuickReply control so the human can answer inline (WARDEN-770). Only
 * one miss's reply panel is open at a time (replyKey) to keep the banner compact.
 *
 * Uses the library <Button> (WARDEN-68 Rule 1: no raw <button>) and conveys state
 * with text + a glyph, not color alone (WCAG 1.4.1).
 */
export function WatchCatchup({ misses, onOpenMiss, onDismiss, snippets, onReplyResult }: Props) {
  // WARDEN-770: which miss's inline reply panel is open (at most one — opening another
  // closes the first so the banner never stacks several textareas).
  const [replyKey, setReplyKey] = useState<string | null>(null);
  if (misses.length === 0) return null;
  return (
    <div className="flex items-start justify-between gap-2 px-3 py-2 bg-amber-50 dark:bg-amber-950/60 border-b border-amber-200 dark:border-amber-800">
      <div className="flex flex-col gap-1 min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm">
          <Bell className="size-3.5 text-amber-600 dark:text-amber-400 shrink-0" aria-hidden />
          <span className="font-medium text-amber-900 dark:text-amber-100">
            {formatCatchupSummary(misses)}
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          {misses.map((m) => {
            const replyable = canReply(m.reason);
            const open = replyKey === m.key;
            return (
              <div key={m.key} className="flex flex-col">
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    onClick={() => onOpenMiss(m)}
                    className="justify-start gap-2 h-auto py-1 px-2 font-normal text-xs text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/60 flex-1 min-w-0"
                  >
                    <span className="size-1.5 rounded-full bg-amber-500 shrink-0" aria-hidden />
                    <span className="truncate text-left">{formatWatchMiss(m)}</span>
                    <span className="text-amber-600 dark:text-amber-400 shrink-0 ml-auto pl-2">open →</span>
                  </Button>
                  {replyable && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setReplyKey(open ? null : m.key)}
                      aria-haspopup="dialog"
                      aria-expanded={open}
                      aria-label={open ? `Hide reply to ${m.name}` : `Reply to ${m.name} without opening the pane`}
                      title={open ? 'Hide reply' : 'Reply without opening the pane'}
                      className="shrink-0 h-auto py-1 px-2 text-xs text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/60"
                    >
                      <Reply className="size-3.5" />
                      Reply
                    </Button>
                  )}
                </div>
                {replyable && open && (
                  <QuickReply
                    targetId={m.key}
                    targetLabel={m.name}
                    snippets={snippets ?? []}
                    onReplyResult={onReplyResult}
                    onDismiss={() => setReplyKey(null)}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onDismiss}
        aria-label="Dismiss watched-chat catch-up"
        className={cn('shrink-0 mt-0.5 text-amber-600 dark:text-amber-400 hover:text-amber-800 dark:hover:text-amber-200')}
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}
