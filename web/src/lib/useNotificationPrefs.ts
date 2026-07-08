import { useCallback, useEffect, useState } from 'react';

// Notification preference categories. Each gates a distinct set of toasts:
//   notifyChatOps  — chat operations: session kill, chat kill, resume, rename
//   notifyErrors   — generic error toasts (fetch failures, session create errors)
//   notifySuccess  — generic success toasts (e.g. new observer session created)
//   notifyObserver — observer events (connection timeout)
export interface NotificationPrefs {
  notifyChatOps: boolean;
  notifyErrors: boolean;
  notifySuccess: boolean;
  notifyObserver: boolean;
}

export const NOTIFICATION_PREF_DEFAULTS: NotificationPrefs = {
  notifyChatOps: true,
  notifyErrors: true,
  notifySuccess: true,
  notifyObserver: true,
};

// Module-level singleton so every component reads the same prefs and a single
// `/api/config` request is made on first mount (not one per component). On
// save, `reload()` refetches and broadcasts the new values to all subscribers
// so preference changes take effect immediately, without a page reload.
let cache: NotificationPrefs | null = null;
let inFlight: Promise<NotificationPrefs> | null = null;
const listeners = new Set<(prefs: NotificationPrefs) => void>();

async function fetchPrefs(): Promise<NotificationPrefs> {
  const res = await fetch('/api/config');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return {
    notifyChatOps: data.notifyChatOps ?? NOTIFICATION_PREF_DEFAULTS.notifyChatOps,
    notifyErrors: data.notifyErrors ?? NOTIFICATION_PREF_DEFAULTS.notifyErrors,
    notifySuccess: data.notifySuccess ?? NOTIFICATION_PREF_DEFAULTS.notifySuccess,
    notifyObserver: data.notifyObserver ?? NOTIFICATION_PREF_DEFAULTS.notifyObserver,
  };
}

function publish(prefs: NotificationPrefs) {
  cache = prefs;
  listeners.forEach((fn) => fn(prefs));
}

// First-mount load: dedupes concurrent callers onto a single in-flight request.
function loadOnce(): Promise<NotificationPrefs> {
  if (cache) return Promise.resolve(cache);
  if (!inFlight) {
    inFlight = fetchPrefs()
      .then((prefs) => {
        publish(prefs);
        return prefs;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

export function useNotificationPrefs() {
  const [prefs, setPrefs] = useState<NotificationPrefs>(cache ?? NOTIFICATION_PREF_DEFAULTS);

  useEffect(() => {
    const fn = (p: NotificationPrefs) => setPrefs(p);
    listeners.add(fn);
    if (cache) {
      setPrefs(cache);
    } else {
      loadOnce().catch((err) => console.error('Failed to load notification preferences:', err));
    }
    return () => {
      listeners.delete(fn);
    };
  }, []);

  // Force a fresh fetch (bypassing the cache) and broadcast to all subscribers.
  // Call this after Settings saves so every component updates live.
  const reload = useCallback(async () => {
    try {
      publish(await fetchPrefs());
    } catch (err) {
      console.error('Failed to reload notification preferences:', err);
    }
  }, []);

  return { prefs, reload };
}
