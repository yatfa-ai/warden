// Recently-closed flyout — the ONLY route back to a temporary session you
// closed (WARDEN-1422 job C). One small header icon with a count badge; its
// flyout lists just-closed temps with exactly two moves:
//   reopen — back to a pane, still temporary (nothing is listed anywhere);
//   save   — promote to persistent: the session moves into its host's list.
// A temporary session that STOPS is gone for good and appears nowhere, so this
// list is short-lived accident insurance, never a browsable history.

import { useEffect, useRef } from 'react';
import { History, X, Bookmark } from 'lucide-react';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { StatusDot } from '@/components/StatusDot';
import { hueOf } from '@/components/sidebar/SavedSessionRows';
import { formatTimestamp } from '@/lib/formatTimestamp';
import { useTimestampFormat } from '@/lib/uiStore';
import type { RecentlyClosedEntry } from '@/lib/storage';

export interface RecentlyClosedFlyoutProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: RecentlyClosedEntry[];
  // A session already in the saved list (id present in `chats`) has nothing a
  // reopen could lose and nothing a save could promote — it is excluded by the
  // caller, which also drives the header count.
  onReopen: (id: string) => void;
  onSave: (id: string) => void;
}

export function RecentlyClosedFlyout({ open, onOpenChange, entries, onReopen, onSave }: RecentlyClosedFlyoutProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const timestampFormat = useTimestampFormat();

  // Dismiss on Escape — the flyout is an overlay, and the header icon toggles.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onOpenChange(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  if (!open) return null;
  return (
    <>
      {/* click-away catcher: the flyout floats over the list; clicking the list
          is a click-away, not a selection through the overlay. */}
      <div className="fixed inset-0 z-40" onClick={() => onOpenChange(false)} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-label="recently closed sessions"
        className="absolute inset-x-1.5 top-9 z-50 overflow-hidden rounded-[9px] border border-border bg-card shadow-lg"
        data-testid="recently-closed-flyout"
      >
        <div className="flex items-center gap-1.5 border-b border-border/50 px-2 py-1.5 text-[10.5px] text-foreground">
          <History aria-hidden="true" className="size-3 text-muted-foreground" />
          <span>recently closed</span>
          <IconTooltip label="close">
            <button
              className="ml-auto rounded px-1 text-muted-foreground hover:text-foreground"
              onClick={() => onOpenChange(false)}
              aria-label="close recently closed"
            >
              <X aria-hidden="true" className="size-3" />
            </button>
          </IconTooltip>
        </div>
        <div className="py-0.5">
          {entries.length === 0 ? (
            <div className="px-3 py-2.5 text-[10.5px] text-muted-foreground">No recently closed sessions.</div>
          ) : (
            entries.map((entry) => (
              <div key={entry.id} className="group mx-0.5 block rounded-[7px] px-2 pb-1 pt-[5px] hover:bg-accent">
                <div className="flex items-start gap-[7px]">
                  <span
                    aria-hidden="true"
                    className="w-[3px] shrink-0 self-stretch rounded-[2px] [min-height:15px]"
                    style={{ backgroundColor: `hsl(${hueOf(entry.name || entry.id)} 62% 58%)` }}
                  />
                  <span className="mt-1 shrink-0">
                    <StatusDot tone="muted" variant="ring" label="closed" />
                  </span>
                  <span className="min-w-0 flex-1 wrap-anywhere text-xs leading-tight text-foreground" title={entry.name || entry.id}>
                    {entry.name || entry.id}
                  </span>
                </div>
                <div className="ml-[10px] mt-0.5 flex min-h-4 flex-wrap items-center gap-x-1.5 text-[10px] text-muted-foreground">
                  <span className="min-w-0 wrap-anywhere">
                    closed {formatTimestamp(entry.closedAt, timestampFormat, { withSuffix: timestampFormat === 'relative' })}
                    {entry.cwd ? <> · <span className="@max-[13rem]:hidden">{entry.cwd}</span></> : null}
                  </span>
                  <span className="ml-auto flex shrink-0 items-center gap-1">
                    <button
                      className="rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                      onClick={() => onReopen(entry.id)}
                      title="reopen as a pane — still temporary"
                      aria-label={`reopen ${entry.name || entry.id}`}
                    >
                      reopen
                    </button>
                    <button
                      className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                      onClick={() => onSave(entry.id)}
                      title="save — keep this session; it moves into the host's saved list"
                      aria-label={`save ${entry.name || entry.id}`}
                    >
                      <Bookmark aria-hidden="true" className="size-2.5" />
                      save
                    </button>
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
        <div className="wrap-anywhere border-t border-border/50 px-2.5 pb-[7px] pt-[5px] text-[10px] leading-snug text-muted-foreground">
          Temporary sessions. Reopening keeps them temporary; saving moves one into this host's saved list. A temporary session that stops is gone for good.
        </div>
      </div>
    </>
  );
}
