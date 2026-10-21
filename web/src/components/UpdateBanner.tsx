import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { getUpdateState, installUpdateNow, onUpdateState, openUpdateDownload, type UpdateState } from '@/lib/electron';
import { updateBannerView } from '@/lib/updateBanner';

// WARDEN-1887 — the visible, NON-BLOCKING update state. A small corner chip (not
// a modal, not a toast that steals the screen): ignoring it is fine, and the
// downloaded update is applied on the next app start regardless. Outside the
// Electron app the bridge is absent, getUpdateState resolves null, and this
// renders nothing — `npm run dev` and smoke are unaffected.
export function UpdateBanner() {
  const [state, setState] = useState<UpdateState | null>(null);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void getUpdateState().then((s) => { if (live) setState(s); });
    const off = onUpdateState((s) => setState(s));
    return () => { live = false; off(); };
  }, []);

  const view = updateBannerView(state);
  if (!view) return null;
  // Dismiss is per (kind, version): a LATER version re-surfaces the chip.
  const key = `${view.kind}:${state?.version ?? ''}`;
  if (dismissedFor === key) return null;

  const onAction = () => {
    if (view.action === 'install') void installUpdateNow();
    else if (view.action === 'download') void openUpdateDownload();
  };

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="update-banner"
      className="fixed bottom-3 right-3 z-50 flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm text-card-foreground shadow-md"
    >
      <span>{view.text}</span>
      {view.action && (
        <Button size="sm" variant="secondary" onClick={onAction}>{view.actionLabel}</Button>
      )}
      <Button size="sm" variant="ghost" aria-label="Dismiss update notice" onClick={() => setDismissedFor(key)}>×</Button>
    </div>
  );
}
