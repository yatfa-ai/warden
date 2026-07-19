// QuickReply — the inline reply affordance shared by all three WARDEN-770 attention
// surfaces (the AttentionBadge popover's waiting/blocked rows, the return-banner
// callout, and the WatchCatchup rows). It is the "last mile" of the human-in-the-loop:
// every surface already ROUTES the human to a needy agent; this lets them actually
// RESPOND without leaving the surface — zero pane/workspace switches.
//
// Send paths reuse the EXISTING durable endpoints (no new backend — WARDEN-770 scope):
//  - typed text / snippet  → POST /api/send {id, text}  → sendPane → tmux send-keys
//                           (the same path PaneTile.sendSnippet uses for a focused pane)
//  - "↵ Continue"          → POST /api/key {id, key:'Enter'} (the KeySendDialog path —
//                           the pervasive "press enter to continue" waiting pattern)
// Both go through the shared postJson helper (web/src/lib/api.ts) — never raw fetch.
//
// SAFETY GATE (mirrors BroadcastDialog's WARDEN-292 "nothing is sent until you confirm"):
//  - Bare Enter in the textarea inserts a newline — it does NOT send. (The popover is
//    transient/clickable, so send-on-Enter would fire by accident; bare Enter must be
//    safe to press.) ⌘/Ctrl+Enter confirms typed text — matches BroadcastDialog.
//  - The Send button is disabled until the text is non-empty (canSendReply) and no send
//    is in flight.
//  - The "↵ Continue" press-Enter action is a deliberately one-click button: the click
//    itself is the explicit confirm gesture (mirrors PaneTile.sendSnippet's one-click,
//    single-target, no-confirm send), so it does not route through canSendReply — it is
//    never an accidental send.
//  - Esc collapses the panel without sending anything.
//
// This component is presentational + owns its textarea/sending state + the postJson
// sends; the parent owns the toast (gated by its own prefs.notifyChatOps, matching
// kill/rename/resume in App.tsx) via `onReplyResult`. Kept out of web/src/lib so the pure
// gating predicates (canReply / sanitizeReplyText / canSendReply) stay import-free and
// unit-testable — there is no React component test harness in this repo.
import { useState, type KeyboardEvent } from 'react';
import { Loader2, CornerDownLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { postJson } from '@/lib/api';
import { canSendReply, replySnippetPreview, sanitizeReplyText } from '@/lib/quickReply';
import type { Snippet } from '@/lib/storage';

interface Props {
  /** The pane key to send to (agent.key || agent.id — the identity /api/send takes). */
  targetId: string;
  /** The agent's display name, used for the textarea's accessible label. */
  targetLabel: string;
  /** Saved instruction snippets (WARDEN-323). The first few are shown as one-click
   *  INSERT-ONLY fills (picking one fills the textarea; it does NOT auto-send — the
   *  confirm gate still governs). Threaded from the same library BroadcastDialog uses. */
  snippets: Snippet[];
  /** Surface the send outcome so the parent can toast it under its own prefs gate
   *  (matching kill/rename/resume in App.tsx). Called once per attempted send. */
  onReplyResult?: (ok: boolean, error?: string) => void;
  /** Collapse the panel (called after a successful send, and on Cancel / Esc). The
   *  parent owns the expand/collapse state because the toggle button that reveals this
   *  panel lives on the parent's row — collapsing is "toggle me shut". */
  onDismiss: () => void;
  /** Focus the textarea on mount. Default true (the panel was deliberately toggled
   *  open). The banner callout passes false when it should not grab focus on first paint. */
  autoFocus?: boolean;
}

/**
 * The reply control. Compact (it lives inside a w-72 popover and a one-line banner),
 * confirm-gated, and keyboard-navigable (Tab to textarea, ⌘/Ctrl+Enter to send, Esc to
 * dismiss without sending). Statically reasoned from the flex/overflow model — not
 * browser-measured here (the worker sandbox blocks Chromium; visual QA is deferred to
 * the reviewer sandbox per WARDEN-130/WARDEN-68).
 */
export function QuickReply({
  targetId,
  targetLabel,
  snippets,
  onReplyResult,
  onDismiss,
  autoFocus = true,
}: Props) {
  const [msg, setMsg] = useState('');
  const [sending, setSending] = useState(false);
  // Inline error from the last failed send (cleared on the next edit / successful send).
  // The parent's toast is the primary feedback; this is the in-context retry cue.
  const [error, setError] = useState<string | null>(null);

  const canSend = canSendReply({ text: msg, sending });
  const previews = replySnippetPreview(snippets);

  // Send the typed text via /api/send (the focused-pane snippet path). Trims via
  // sanitizeReplyText (the same pure helper canSend gates on) so a trailing textarea
  // newline never becomes a stray extra Enter — and the pure seam is the single source
  // of truth for "what text reaches /api/send". canSend already guarantees non-empty +
  // idle; the null check below is defensive against a render-race (e.g. ⌘+Enter firing
  // between renders) and never trips in normal flow.
  const sendText = async () => {
    if (!canSend) return;
    const text = sanitizeReplyText(msg);
    if (text === null) return;
    setSending(true);
    setError(null);
    const res = await postJson('/api/send', { id: targetId, text });
    setSending(false);
    if (res.ok) {
      onReplyResult?.(true);
      // Collapse + reset on success so a second reply starts clean (no stale text to
      // re-send by accident — mirrors BroadcastDialog's reset-on-open discipline).
      setMsg('');
      onDismiss();
    } else {
      const err = res.error || 'Reply failed';
      setError(err);
      onReplyResult?.(false, err);
    }
  };

  // The "↵ Continue" quick-action: send a bare Enter key via /api/key (the KeySendDialog
  // path). One-click + deliberately labeled — the click IS the confirm gesture, so this
  // does NOT route through canSendReply (it sends no typed text; it sends the key).
  const sendEnter = async () => {
    if (sending) return;
    setSending(true);
    setError(null);
    const res = await postJson('/api/key', { id: targetId, key: 'Enter' });
    setSending(false);
    if (res.ok) {
      onReplyResult?.(true);
      onDismiss();
    } else {
      const err = res.error || 'Failed to send Enter';
      setError(err);
      onReplyResult?.(false, err);
    }
  };

  // ⌘/Ctrl+Enter confirms typed text (matches BroadcastDialog); Esc dismisses without
  // sending (only when idle — never abandon an in-flight send). Bare Enter is left alone
  // so it inserts a newline (the no-accidental-send rule above).
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void sendText();
    } else if (e.key === 'Escape' && !sending) {
      e.preventDefault();
      onDismiss();
    }
  };

  return (
    <div className="flex flex-col gap-1.5 px-2 pb-2 pt-1">
      <Textarea
        value={msg}
        onChange={(e) => { setMsg(e.target.value); if (error) setError(null); }}
        onKeyDown={onKeyDown}
        placeholder="Reply…"
        aria-label={`Reply to ${targetLabel}`}
        autoFocus={autoFocus}
        disabled={sending}
        // Compact override of the Textarea default (min-h-[80px] / text-base) so the
        // control fits the narrow w-72 popover without dominating the row it expanded
        // from. min-h-[44px] keeps the tap target comfortable.
        className="min-h-[44px] text-xs"
      />
      {error && (
        <span role="alert" className="text-[10px] text-red-500 dark:text-red-400">{error}</span>
      )}
      {/* One-click snippet fills (insert-only — they fill the textarea, never auto-send).
          The WARDEN-292 confirm gate still governs the send. Hidden when empty (WARDEN-103). */}
      {previews.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {previews.map((s) => (
            <Button
              key={s.name}
              type="button"
              variant="outline"
              size="xs"
              disabled={sending}
              onClick={() => { setMsg(s.text); if (error) setError(null); }}
              title={`Insert: ${s.text}`}
              className="max-w-[120px]"
            >
              <span className="truncate">{s.name}</span>
            </Button>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={sendEnter}
          disabled={sending}
          title="Send a bare Enter key (the press-enter-to-continue pattern)"
        >
          <CornerDownLeft className="size-3.5" />
          Continue
        </Button>
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="sm" onClick={onDismiss} disabled={sending}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={sendText} disabled={!canSend}>
            {sending ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Sending…
              </>
            ) : (
              'Send'
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
