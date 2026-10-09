// appConfigQuery — the pure seam behind the shared /api/config fact held in the
// TanStack Query cache (WARDEN-1696, client-state slice 50). First fact moved:
// `companionTransportEnabled` (previously an App.tsx useState set from
// refreshConfigPrefs and prop-drilled App → HealthPanel → HealthDashboard).
//
// PURITY CONTRACT (same as gitStatusQuery.ts): NO React, NO @tanstack import,
// NO other imports — the key, the fetcher and the selector are plain functions
// with an injectable `fetcher`, so `node --test` drives them directly. The
// bounded fetcher is injected from the React glue (appConfigHooks.ts).
//
// Later slices can reuse this key with their own `select` (pollIntervalMs,
// confirmDestructiveActions, observer prefs, ...). Settings' draft editor
// (useBackendConfig) and useNotificationPrefs are separate concerns.

/** The ONE cache key for the app-level /api/config fact. */
export const APP_CONFIG_KEY = 'app-config' as const;

/** `['app-config']`. */
export function appConfigQueryKey(): readonly [typeof APP_CONFIG_KEY] {
  return [APP_CONFIG_KEY] as const;
}

/**
 * The /api/config body. Index signature is `any` because App.refreshConfigPrefs
 * has always read its many prefs off an untyped body (`r.json()`); later slices
 * narrow per-fact selectors rather than typing the whole body here.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AppConfig = { companionTransportEnabled?: boolean | null; [key: string]: any };

/**
 * GET /api/config → parsed body. Throws on a non-ok HTTP status so a failure
 * lands in the query's error state rather than being read as a config.
 * `fetcher` is injectable for node --test.
 */
export async function fetchAppConfig(fetcher: typeof fetch = fetch): Promise<AppConfig> {
  const r = await fetcher('/api/config');
  if (!r.ok) throw new Error(`config HTTP ${r.status}`);
  return (await r.json()) as AppConfig;
}

/**
 * WARDEN-882 — companion transport toggle. Defaults TRUE (the Remove-companion
 * affordance is shown before config loads, and when the key is absent/null).
 */
export function selectCompanionTransportEnabled(cfg: AppConfig | null | undefined): boolean {
  return cfg?.companionTransportEnabled ?? true;
}
