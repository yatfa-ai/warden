import { useEffect } from 'react';
import { streamApi } from '@/lib/stream';
import { useFocused, useMarkPaneActivity, useClearPaneActivity } from '@/lib/uiStore';

// WARDEN-1691 (client-state slice 49): the unfocused-output "new" badge wiring
// (`newActivity`, store-owned since slice 27), extracted from App.tsx. Two halves:
//  1. every pty frame on the stream marks its pane — the store's markPaneActivity
//     is already a no-op (identical state) when the pane is the active workspace's
//     focused one, so no focus ref/prop is needed here;
//  2. focusing a pane clears its badge.
// It must stay continuously mounted (App renders it OUTSIDE the settings ternary)
// so the badge keeps working while Settings is open. Child effects run before
// App's mount effect, so the slot is set before `streamApi.connect()` — no frame
// is missed.
export function PaneActivitySync() {
  const markPaneActivity = useMarkPaneActivity();
  const clearPaneActivity = useClearPaneActivity();
  const focused = useFocused();

  useEffect(() => {
    streamApi.onAnyMessage = (m) => {
      if (m.type === 'pty') markPaneActivity(m.id);
    };
    return () => {
      streamApi.onAnyMessage = null;
    };
  }, [markPaneActivity]);

  // clear "new" badge when a pane becomes focused
  useEffect(() => {
    if (focused) clearPaneActivity(focused);
  }, [focused, clearPaneActivity]);

  return null;
}
