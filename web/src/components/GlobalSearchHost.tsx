import { useEffect, useState } from 'react';
import { GlobalSearchDialog } from '@/components/GlobalSearchDialog';
import { SessionTranscriptViewer } from '@/components/SessionTranscriptViewer';
import { getFeatureUsageSampler } from '@/lib/featureUsageTelemetry';
import type { IssueLinkEntry } from '@/lib/issue-links';
import { uiStore, useGlobalSearchOpen, useSetGlobalSearchOpen } from '@/lib/uiStore';

// WARDEN-1620 (client-state slice 37): the whole global-search surface, extracted
// from App.tsx. "Open global search" lives on the uiStore (`globalSearchOpen`,
// non-persisted); this host owns the Ctrl+Shift+F shortcut, the past-conversation
// transcript viewer and its 'session-view' telemetry. It must stay continuously
// mounted (App renders it OUTSIDE the settings ternary) so the shortcut still works
// while Settings is open.
export interface GlobalSearchHostProps {
  /** Routes a search result to its pane (App's openChat — switches workspace if needed). */
  onOpenChat: (id: string) => void;
  issueEntries: IssueLinkEntry[];
}

export function GlobalSearchHost({ onOpenChat, issueEntries }: GlobalSearchHostProps) {
  const open = useGlobalSearchOpen();
  const setOpen = useSetGlobalSearchOpen();
  // The past-conversation whose read-only transcript is open from a global-search
  // result (WARDEN-719). Lives HERE — NOT inside GlobalSearchDialog — because that
  // dialog auto-closes on result-click, which would unmount a viewer rendered within
  // it. Ephemeral with a single reader, so local state rather than a store fact.
  const [viewingSession, setViewingSession] = useState<{ id: string; host: string; label: string } | null>(null);

  // keyboard shortcut for global search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'F') {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setOpen]);

  return (
    <>
      <GlobalSearchDialog
        open={open}
        onClose={() => setOpen(false)}
        onFocusPane={onOpenChat}
        onJumpToMatch={(id, query) => {
          onOpenChat(id);
          uiStore.getState().setExternalSearchQuery({ paneId: id, query });
        }}
        onOpenSession={(id, host, label) => {
          // Set the viewing session, then close the search dialog. The viewer
          // (rendered just below) survives the dialog closing because its open
          // state + session live here, not inside the dialog.
          getFeatureUsageSampler().sampler.recordFeatureUse('session-view');
          setViewingSession({ id, host, label });
          setOpen(false);
        }}
      />
      <SessionTranscriptViewer
        open={!!viewingSession}
        onOpenChange={(o) => { if (!o) setViewingSession(null); }}
        session={viewingSession}
        issueEntries={issueEntries}
      />
    </>
  );
}
