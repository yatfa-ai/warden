import { useCallback, useState } from 'react';
import { toggleWatchManyKeys } from '@/lib/chatWatch';
import { requestAlertPermission } from '@/lib/desktopAlerts';

/**
 * Per-chat "watch" opt-in (WARDEN-378): pane keys the human marked "watch this
 * chat" for a targeted, reason-specific desktop ping when that chat newly needs
 * them. Global (not per-workspace). Pure client-side pref (like
 * attentionDesktopAlerts/attentionStates): persisted by the saveUi effect below,
 * forwarded to the AttentionBadge's useAttentionRollup (which unions watched ∪
 * open into the ?panes= poll and runs the per-chat transition detector). Never
 * sent to the backend.
 *
 * Extracted from App.tsx as part of the App god-component decomposition
 * (WARDEN-696, slice 2 of 4: watch/attention state ownership). The state, the
 * single/bulk toggles, and the derived O(1) lookup Set all move here verbatim —
 * App.tsx remains the composition root that persists `watchedChats` (it stays
 * in the saveUi persisted-snapshot assembly) and wires it into the attention
 * rollup. This hook owns only the state + setters + derive.
 */
export interface UseWatchStateArgs {
  /** Initial watched set, read once from the persisted uiState (uiState.watchedChats ?? []). */
  initialWatched: string[];
}

export interface UseWatchStateResult {
  /** Watched chat keys (global, not per-workspace). Round-trips to disk via App's saveUi effect. */
  watchedChats: string[];
  /** O(1) "is this chat watched?" lookup for the sidebar rows (WARDEN-378). new Set(watchedChats), recomputed each render. */
  watchedChatSet: Set<string>;
  /** WARDEN-378: toggle a single chat's watch; requests OS notification permission when turning on. */
  toggleWatch: (key: string) => void;
  /** WARDEN-581: add/remove every selected key in one update; requests permission once for a bulk watch-ON. */
  toggleWatchMany: (keys: string[], on: boolean) => void;
  /** Reset-defaults clear path (App.tsx "reset all defaults" handler): empties the watched set. */
  clearWatchedChats: () => void;
}

/**
 * Owns the watch/attention state for the app: the per-chat "watch this chat"
 * set, its single/bulk toggles, the derived O(1) lookup Set, and the
 * reset-defaults clear.
 *
 * Pure state-ownership — the toggle/watch-many semantics, the
 * requestAlertPermission hoist (out of the updaters, which must stay pure and
 * are double-invoked by StrictMode in dev), and the idempotent permission
 * request all move verbatim from App.tsx. The state itself is persisted by
 * App.tsx's saveUi effect (this hook just owns the state + setters + derive).
 */
export function useWatchState({ initialWatched }: UseWatchStateArgs): UseWatchStateResult {
  // Per-chat "watch" opt-in (WARDEN-378): pane keys the human marked "watch this
  // chat" for a targeted, reason-specific desktop ping when that chat newly needs
  // them. Global (not per-workspace). Pure client-side pref (like
  // attentionDesktopAlerts/attentionStates): persisted by the saveUi effect in
  // App.tsx, forwarded to the AttentionBadge's useAttentionRollup (which unions
  // watched ∪ open into the ?panes= poll and runs the per-chat transition
  // detector). Never sent to the backend.
  const [watchedChats, setWatchedChats] = useState<string[]>(() => initialWatched);

  // WARDEN-378: toggle a chat's per-chat "watch" — marks it for a targeted,
  // reason-specific desktop ping when it newly needs the human. Turning watch ON
  // also requests OS notification permission (if not already granted) so the ping
  // can actually fire — the same requestAlertPermission the fleet-alert toggle uses.
  // Pure client-side state (persisted via the saveUi effect); no backend call. The
  // permission request is hoisted out of the updater (updaters must stay pure, and
  // StrictMode double-invokes them in dev); requestAlertPermission is idempotent.
  const toggleWatch = useCallback((key: string) => {
    const turningOn = !watchedChats.includes(key);
    setWatchedChats((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
    if (turningOn) void requestAlertPermission();
  }, [watchedChats]);

  // toggleWatchMany: add (on=true) or remove (on=false) every selected key. The OS
  // notification permission request fires ONCE for a bulk watch-ON (not per key —
  // requestAlertPermission is idempotent but a per-key spam is still wrong), hoisted
  // out of the updater (updaters stay pure; StrictMode double-invokes them in dev).
  const toggleWatchMany = useCallback((keys: string[], on: boolean) => {
    if (keys.length === 0) return;
    setWatchedChats((prev) => toggleWatchManyKeys(prev, keys, on));
    if (on) void requestAlertPermission();
  }, []);

  // Reset-defaults clear path (App.tsx "reset all defaults" handler): empties the
  // watched set. Exposed as a narrow clearWatchedChats() rather than the raw
  // setWatchedChats setter — behavior-identical to the prior setWatchedChats([]).
  const clearWatchedChats = useCallback(() => {
    setWatchedChats([]);
  }, []);

  // WARDEN-378: O(1) "is this chat watched?" lookup for the sidebar rows (the watch
  // toggle's active state). A Set mirroring watchedChats, recomputed each render.
  const watchedChatSet = new Set(watchedChats);

  return { watchedChats, watchedChatSet, toggleWatch, toggleWatchMany, clearWatchedChats };
}
