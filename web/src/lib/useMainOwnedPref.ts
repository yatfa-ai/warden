// Hook for ONE Electron-main-owned boolean preference (roadmap WARDEN-1204
// slice 38, WARDEN-1622).
//
// "Remember window bounds", "Launch at login" and "Close to tray" are not
// renderer-owned prefs: main's window-state.json / the OS is the source of
// truth and this hook's state is only a DISPLAY MIRROR. They therefore live
// neither on the shared uiStore nor in UiState/saveUi — and since exactly one
// surface (AppearanceSection) reads and writes each, the state lives there
// rather than in App behind a pass-through props bag.
//
// Loads once on mount through `get` (a no-op that leaves `defaultValue` in a
// plain browser, where lib/electron.ts echoes the default); `set` is the
// WARDEN-973 reconcile path unchanged — optimistic write, then revert + toast
// when main/the OS refuses (see lib/mainOwnedPref.ts).
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { reconcileMainOwnedPref } from '@/lib/mainOwnedPref';

export function useMainOwnedPref(
  get: () => Promise<boolean>,
  persist: (v: boolean) => Promise<boolean>,
  defaultValue: boolean,
  refusalMessage: string,
): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(defaultValue);
  const mountedRef = useRef(true);
  // Accessors/message are module-level constants at every call site; keep the
  // latest in refs so `set` identity stays stable without a deps churn risk.
  const persistRef = useRef(persist);
  persistRef.current = persist;
  const messageRef = useRef(refusalMessage);
  messageRef.current = refusalMessage;

  useEffect(() => {
    mountedRef.current = true;
    void get().then((v) => {
      if (mountedRef.current) setValue(v);
    });
    return () => {
      mountedRef.current = false;
    };
    // Load once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = useCallback((v: boolean) => {
    void reconcileMainOwnedPref(
      v,
      (x) => persistRef.current(x),
      (x) => {
        if (mountedRef.current) setValue(x);
      },
      () => {
        toast.error(messageRef.current);
      },
    );
  }, []);

  return [value, set];
}
