import { useEffect, useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  saveUi,
  persistUiState,
  loadUi,
  PERSISTED_PREF_KEYS,
  type UiState,
  type RestoreOnStartup,
} from '@/lib/storage';
import { useUiStore, selectPersistedStorePrefs, STORE_PERSISTED_KEYS } from '@/lib/uiStore';

/**
 * The persisted-pref snapshot: ONE typed bag, bidirectionally locked to
 * PERSISTED_PREF_KEYS via Required<Pick<...>>. A key present in the source but
 * missing here is a missing-property compile error; a key present here but
 * absent from the source is an excess-property compile error. This replaces
 * the two duplicated, UNCHECKED hand-lists (the object literal AND the dep
 * array) that caused WARDEN-442/468/500: a dropped key was type-valid (every
 * UiState field is optional ?), so saveUi silently stopped persisting it and
 * the pref reset to its default on reload. The only enumerated list is this
 * snapshot type — type-enforced against the single PERSISTED_PREF_KEYS source
 * in storage.ts (which itself is exhaustiveness-tested).
 *
 * Extracted from App.tsx as part of the App god-component decomposition
 * (WARDEN-696, slice 1 of 4: config/persistence orchestration). The snapshot
 * is ASSEMBLED by App.tsx — the composition root — and passed in, because its
 * inputs are the live pref state, much of which will eventually be owned by
 * sibling concern hooks (useWatchState, usePaneManager, …). useConfigPersistence
 * owns only the WRITE path (the saveUi effect) + the post-settings
 * orchestration callback, not the snapshot assembly.
 *
 * WARDEN-1471 (roadmap WARDEN-1204 slice 16) split the bag in two, because 31
 * of the 41 keys had migrated onto the shared uiStore and App was holding 24
 * subscriptions ONLY to feed them into this snapshot (so the saveUi effect
 * would re-fire). Persistence is now a property of the store: App assembles
 * and passes only its OWN half (AppPersistedSnapshot — the facts it still owns
 * as useState: the workspace set, panel geometry, watchedChats, paneHost),
 * while this hook reads the store half through ONE shallow-compared
 * subscription (useShallow(selectPersistedStorePrefs)) and merges the two in
 * the effect. The MERGED object is still the full PersistedPrefSnapshot —
 * bidirectionally locked to PERSISTED_PREF_KEYS exactly as before, still the
 * ONE saveUi call site, still no store-owned write-through (uiStore.ts's
 * per-namespace single-writer invariant — the "There is deliberately NO
 * store-owned write-through persistence here" paragraph of its header — and
 * uiStore.test.mjs's `saveUi(` guard hold unmodified; WARDEN-1477's slice-17
 * writer for the SECOND namespace, useObsPersistence, writes warden:observer:v1
 * and touches neither this snapshot nor saveUi).
 */
export type PersistedPrefSnapshot = Required<
  Pick<Omit<UiState, 'restoreOnStartup'>, (typeof PERSISTED_PREF_KEYS)[number]>
>;

/**
 * App's half of the snapshot: the members of PERSISTED_PREF_KEYS the store
 * does NOT own — the complement of STORE_PERSISTED_KEYS (uiStore.ts) against
 * the same key source, so the partition is compile-derived, never hand-held.
 * These are the facts App still owns as plain useState (workspaces /
 * activeWorkspaceId / paneHost, the four panel collapses, the two panel
 * widths, watchedChats), read at App scope and passed in.
 */
export type AppPersistedSnapshot = Required<
  Pick<
    Omit<UiState, 'restoreOnStartup'>,
    Exclude<(typeof PERSISTED_PREF_KEYS)[number], (typeof STORE_PERSISTED_KEYS)[number]>
  >
>;

export interface UseConfigPersistenceArgs {
  /** App's own live pref values, assembled by the composition root (see AppPersistedSnapshot). */
  persistedSnapshot: AppPersistedSnapshot;
  /** "Restore workspace on startup" pref — steers persistUiState's workspace carry-forward. */
  restoreOnStartup: RestoreOnStartup;
  /** True when this launch started with an empty workspace (suppresses workspace overwrite). */
  startedEmpty: boolean;
  /** Reload chats/ssh-hosts from the disk catalog (App's chat-list refresh). */
  refresh: () => Promise<void>;
  /** Force a fresh fetch of notification prefs + broadcast to all subscribers. */
  reloadNotificationPrefs: () => Promise<void>;
  /** Refresh backend-backed prefs from /api/config (display / observer / poll cadence). */
  refreshConfigPrefs: () => Promise<void>;
}

export interface UseConfigPersistenceResult {
  /** Post-Settings orchestration: reload chats, re-broadcast notification prefs, refresh config. */
  handleConfigChange: () => void;
}

/**
 * Owns the config/persistence WRITE path for the app's UI prefs.
 *
 * - Runs the saveUi effect: persists the live pref snapshot to disk via
 *   persistUiState, honoring the "Restore workspace on startup" pref. Re-fires
 *   only when an actual pref value (or restoreOnStartup/startedEmpty) changes.
 * - Exposes handleConfigChange: the post-Settings orchestration callback that
 *   reloads chats/ssh-hosts, re-broadcasts notification prefs, and refreshes
 *   backend-backed config prefs so every toggle takes effect immediately
 *   without a page reload.
 *
 * The App half of the snapshot is assembled in App.tsx (composition root) and
 * passed in; the store half is read HERE, so App no longer holds a
 * subscription per store fact just to feed it (WARDEN-1471).
 */
export function useConfigPersistence({
  persistedSnapshot,
  restoreOnStartup,
  startedEmpty,
  refresh,
  reloadNotificationPrefs,
  refreshConfigPrefs,
}: UseConfigPersistenceArgs): UseConfigPersistenceResult {
  // The store-owned half of the snapshot, subscribed ONCE (one selector, one
  // subscription for all 31 store facts). useShallow keeps the returned object
  // referentially stable across renders, so App re-renders only when one of
  // the 31 values actually changes — the exact re-render semantics the 24
  // per-fact `const x = useX()` subscriptions this replaces provided (minus
  // the 24 declarations). This is a READ channel only: nothing here writes
  // through the store, and the effect below remains the ONE saveUi call site.
  const storePrefs = useUiStore(useShallow(selectPersistedStorePrefs));

  // Persist live UI state, honoring the "Restore workspace on startup" pref.
  // persistUiState carries the on-disk workspace forward (instead of the live
  // arrays) whenever the pref is 'empty' OR this launch started empty — otherwise
  // a clean/'empty' launch, or flipping back to "Reopen previous" from one, would
  // overwrite and destroy the last saved workspace.
  useEffect(() => {
    const snapshot: PersistedPrefSnapshot = { ...persistedSnapshot, ...storePrefs };
    saveUi(persistUiState(snapshot, restoreOnStartup, loadUi(), startedEmpty));
    // The dependency is every VALUE of the merged snapshot (one per
    // PERSISTED_PREF_KEYS entry — the App half from the passed-in object, the
    // store half from the subscription — derived from the same single source
    // as the snapshot, not a second hand-list) plus the two non-pref args.
    // Object.values yields a per-key Object.is comparison, so the effect
    // re-fires ONLY when a persisted pref (or restoreOnStartup/startedEmpty)
    // actually changes — preserving the prior firing semantics exactly.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- non-literal by design: the dep set is every value of the merged snapshot (one per PERSISTED_PREF_KEYS entry), derived from the same type-checked sources as the snapshot object. Completeness is compile-enforced (a key in the source but missing from either half is a TS error) + partition-tested, not literal-enumerable — so a forgotten pref key can no longer silently drop out of the dep array (the WARDEN-442/468/500 class).
  }, [...Object.values(persistedSnapshot), ...Object.values(storePrefs), restoreOnStartup, startedEmpty]);

  // Called after Settings saves: reload chats/ssh-hosts, refresh notification prefs
  // everywhere (the shared hook broadcasts to all subscribers), and refresh config
  // preferences — so all toggles take effect immediately without a page reload.
  const handleConfigChange = useCallback(() => {
    refresh();
    reloadNotificationPrefs();
    refreshConfigPrefs();
  }, [refresh, reloadNotificationPrefs, refreshConfigPrefs]);

  return { handleConfigChange };
}
