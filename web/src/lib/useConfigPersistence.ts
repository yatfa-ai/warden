import { useEffect, useCallback } from 'react';
import {
  saveUi,
  persistUiState,
  loadUi,
  PERSISTED_PREF_KEYS,
  type UiState,
  type RestoreOnStartup,
} from '@/lib/storage';

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
 */
export type PersistedPrefSnapshot = Required<
  Pick<Omit<UiState, 'restoreOnStartup'>, (typeof PERSISTED_PREF_KEYS)[number]>
>;

export interface UseConfigPersistenceArgs {
  /** Live pref values, assembled by the composition root (see PersistedPrefSnapshot). */
  persistedSnapshot: PersistedPrefSnapshot;
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
 * The snapshot itself is assembled in App.tsx (composition root) and passed in.
 */
export function useConfigPersistence({
  persistedSnapshot,
  restoreOnStartup,
  startedEmpty,
  refresh,
  reloadNotificationPrefs,
  refreshConfigPrefs,
}: UseConfigPersistenceArgs): UseConfigPersistenceResult {
  // Persist live UI state, honoring the "Restore workspace on startup" pref.
  // persistUiState carries the on-disk workspace forward (instead of the live
  // arrays) whenever the pref is 'empty' OR this launch started empty — otherwise
  // a clean/'empty' launch, or flipping back to "Reopen previous" from one, would
  // overwrite and destroy the last saved workspace.
  useEffect(() => {
    saveUi(persistUiState(persistedSnapshot, restoreOnStartup, loadUi(), startedEmpty));
    // The dependency is every VALUE in persistedSnapshot (one per
    // PERSISTED_PREF_KEYS entry — derived from the same single source as the
    // snapshot object, not a second hand-list) plus the two non-pref args.
    // Object.values yields a per-key Object.is comparison, so the effect re-fires
    // ONLY when a persisted pref (or restoreOnStartup/startedEmpty) actually
    // changes — preserving the prior firing semantics exactly.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- non-literal by design: the dep set is every value of persistedSnapshot (one per PERSISTED_PREF_KEYS entry), derived from the same type-checked source as the snapshot object. Completeness is compile-enforced (a key in the source but missing from the snapshot is a TS error) + exhaustiveness-tested, not literal-enumerable — so a forgotten pref key can no longer silently drop out of the dep array (the WARDEN-442/468/500 class).
  }, [...Object.values(persistedSnapshot), restoreOnStartup, startedEmpty]);

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
