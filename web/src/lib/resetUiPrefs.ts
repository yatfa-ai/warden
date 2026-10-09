import { uiStore } from '@/lib/uiStore';
import { loadObs, saveObs, resetObsPrefsPreservingWorkspace } from '@/lib/storage';

// Reset every UI PREF to its effective default value (the value loadUi()
// yields post-coercion, so live React state / persisted state / a fresh
// reload all agree) while leaving the WORKSPACE + panel layout untouched.
// What survives is exactly RESET_PRESERVED_KEYS (storage.ts) — the single
// source of truth for the preserved set; see WARDEN-346. The store action's
// writes reach disk through the always-mounted persistence hooks
// (useConfigPersistence → persistUiState). Pure client-side: never touches the backend
// / config.json (display/terminal/new-chat prefs are client-side only by
// design).
//
// WARDEN-934: this used to be a hand-enumerated list of ~35 setter calls
// guarded only by a comment asserting it was complete — and it had already
// drifted. fileViewerViewMode (WARDEN-480) was never reset, so "Reset UI
// preferences" toasted success and left the File Viewer stuck in Source
// forever. The classification is now DERIVED from one compile-enforced key
// source, exactly like the persist path (PERSISTED_PREF_KEYS →
// PersistedPrefSnapshot, which closed the identical WARDEN-442/468/500
// drift):
//
//   ResettableKey = (PERSISTED_PREF_KEYS ∪ restoreOnStartup) − RESET_PRESERVED_KEYS
//
// and the reset is keyed by it — resetUiPrefDefaults() (storage.ts) for the
// values, the store's resetUiPrefs action (uiStore.ts) applying them. A pref
// that is neither listed in RESET_PRESERVED_KEYS nor given a default + store
// fact is a TypeScript error; the storage.test.mjs exhaustiveness test covers
// the runtime half.
//
// The two things the types can NOT say:
//   - terminalFontFamily resets to DEFAULT_TERMINAL_FONT_FAMILY (the curated
//     "System default" value), NOT DEFAULT_UI.terminalFontFamily (''). The
//     persisted shape uses '' (blank = default stack), but the live value is
//     seeded with the same truthiness fallback ('' →
//     DEFAULT_TERMINAL_FONT_FAMILY, now in uiStore's createUiStore since
//     WARDEN-1322 — formerly App's useState initializer) so a pane can never
//     blank. Setting live
//     state to '' here would leave the Settings font-select showing "Custom…"
//     (no '' option in the curated list) until reload.
//   - User-curated lists (customPresets/snippets/watchedChats)
//     reset too: this is a destructive, confirm-gated "back to factory
//     defaults", consistent with customPresets → [].
//
// Slice 34 (WARDEN-1596) retired the per-pref setter map; slice 47
// (WARDEN-1677) moved this operation out of App into this plain module, so
// it is no longer a prop pair threaded App → SettingsPage → ResetSection.
export function resetUiPrefsToDefaults(): void {
  // WARDEN-1596 (client-state slice 34): the STORE half of the reset — every
  // ResettableKey plus the four observer facts, in one atomic `set` — lives
  // in the store's own `resetUiPrefs` action (lib/uiStore.ts), so no
  // per-pref setter list exists to maintain and a new pref needs no edit here
  // to stay covered (the ResettableKey type lock in uiStore.ts makes a missing
  // store fact a compile error).
  uiStore.getState().resetUiPrefs();

  // WARDEN-981 — the Observer panel's prefs are the one resettable view state
  // OUTSIDE UiState: ObsUi / warden:observer:v1, behind its own loadObs/
  // saveObs. Two halves, deliberately separated:
  //   1. DISK: rewrite the stored payload with the 4 pref fields defaulted
  //      (resetObsPrefsPreservingWorkspace keeps openIds/activeId — which
  //      observer sessions are open is workspace state, exactly like
  //      workspaces/activeWorkspaceId above). This keeps warden:observer:v1
  //      in agreement: it is what a page reload re-reads, and it is where the
  //      panel re-seeds openIds/activeId (via obsSeed) on remount.
  //   2. STORE: resetUiPrefs() above snaps the four store facts to resetObsPrefDefaults()' values.
  //      This is the half that resets the panel — for BOTH audiences, because
  //      slice 15 moved the prefs onto the process-lifetime uiStore, which is
  //      seeded ONCE at import and is never re-read from disk. A panel that
  //      IS mounted when the reset fires re-renders to defaults in place; the
  //      shipped flow (the full-page Settings view unmounts the dashboard)
  //      remounts the panel, whose viewMode/filters now come from the store.
  //      Without this half the returning panel would show the old tab and
  //      filters, and its booted-gated saveObs(obsBag) effect would write
  //      them straight back to disk, silently undoing half 1. The four
  //      setters below are the same actions ObserverTabs' tabs/Selects write
  //      — so a direct store write replaces the retired resetToken nonce.
  //      WARDEN-981's same-value-bailout worry dissolves with the nonce
  //      retired: a repeated reset is just another store transition.
  // Disk half lives HERE on purpose (not in the store): the uiStore.test.mjs
  // saveObs census guard pins exactly four production writer files.
  saveObs(resetObsPrefsPreservingWorkspace(loadObs()));
}
