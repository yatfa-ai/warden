// uiStore — the shared CLIENT-STATE store (WARDEN-1271, roadmap WARDEN-1204
// slice 1), the decided instrument from WARDEN-832 row 2: "shared/persisted
// client UI state → Zustand layered over storage.ts".
//
// WHAT THIS IS FOR
// ────────────────
// warden's persistence half is healthy: ONE compile-locked write effect
// (useConfigPersistence.ts) is the single writer to localStorage. The SHARING
// half is what did not exist — a shared pref lived in an App.tsx `useState` and
// was handed down as a prop through every intermediate component between App
// and the surface that actually reads it. `snippets` (WARDEN-323) was the worst
// case: 8 reading surfaces behind 7 App pass-sites, with intermediate hops that
// are pure pass-throughs by their own comments (PaneGrid "pure pass-through to
// PaneTile", ChatSidebar "threaded straight through").
//
// This store is the SHARING channel: a surface that needs a shared pref
// SUBSCRIBES to it instead of receiving it through its ancestors.
//
// HOW IT COMPOSES WITH storage.ts (it never competes with it)
// ──────────────────────────────────────────────────────────
// storage.ts stays the single source of truth for the SHAPE and the DEFAULTS of
// every pref (types, DEFAULT_UI, the loadUi() sanitizers, STARTER_SNIPPETS).
// This module imports them and re-declares NOTHING.
//
// Persistence stays exactly where it was — SINGLE-WRITER, deliberately:
//
//     store.setSnippets(next)
//       → App's useUiStore subscription re-renders App
//       → the `snippets` field of App's PersistedPrefSnapshot changes identity
//       → useConfigPersistence's saveUi effect fires (its deps are the
//         snapshot's values)
//       → persistUiState → localStorage
//
// There is deliberately NO store-owned write-through persistence here. Adding
// one would create a SECOND writer to the same key and break the compile-locked
// single-writer design (PersistedPrefSnapshot's Required<Pick<…>> lock +
// storage.test.mjs's PERSISTED_PREF_KEYS exhaustiveness guard). Revisit only
// once the subscription pattern is proven across several prefs.
//
// WHY A FACTORY *AND* A SINGLETON
// ───────────────────────────────
// A module-level store leaks between tests unless handled deliberately: test A
// mutates it, test B sees A's value. `createUiStore()` gives every test its own
// isolated instance; `uiStore` is the ONE app-level instance the React hooks
// below bind to. Production code should use the hooks; tests should use the
// factory.

import { createStore, useStore } from 'zustand';
import { loadUi, type Snippet } from '@/lib/storage';

/**
 * The shared client-state slice. One field + its setter per migrated pref.
 *
 * SCOPE DISCIPLINE: this holds only prefs that are genuinely SHARED across
 * distant surfaces. A value read by exactly one component stays a `useState`
 * there (WARDEN-832: "ephemeral component state → useState") — moving it here
 * would buy nothing and cost a global re-render.
 */
export interface UiStoreState {
  /**
   * The user-authored instruction library (WARDEN-323). Read by the pane
   * context menu, the broadcast picker, the watch catch-up quick reply, and
   * Settings' CRUD section. Written only by Settings (add/rename/edit/delete)
   * and by the "Reset appearance & UI preferences" action.
   */
  snippets: Snippet[];
  /** Replace the snippet library. The persisted write follows via App's snapshot. */
  setSnippets: (snippets: Snippet[]) => void;
  /**
   * The File Viewer's Rendered ⇄ Source markdown toggle (WARDEN-480), made one
   * global remembered choice rather than a per-open reset. Exactly ONE reader
   * and ONE writer — FileViewer's own toolbar — yet it used to travel App →
   * {ChatSidebar, PaneGrid, HealthDashboard} → {PaneTile} → FileViewer through
   * four PURE pass-through carriers. FileViewer now subscribes here directly
   * (WARDEN-1288, roadmap WARDEN-1204 slice 2) and those hops are deleted.
   */
  fileViewerViewMode: 'rendered' | 'source';
  /** Flip the File Viewer's view mode. The persisted write follows via App's snapshot. */
  setFileViewerViewMode: (mode: 'rendered' | 'source') => void;
}

/**
 * The seed a fresh store starts from: whatever the persisted payload holds,
 * normalized by loadUi()'s own sanitizers (which is also where STARTER_SNIPPETS
 * seeding lives). Read ONCE per store instance — the store is the live copy
 * from that point on, exactly as App's `useState(() => uiState.snippets ?? [])`
 * lazy initializer was.
 *
 * Overridable so a test can seed a known slice without touching localStorage.
 */
export type UiStoreSeed = Partial<Pick<UiStoreState, 'snippets' | 'fileViewerViewMode'>>;

/**
 * Build an INDEPENDENT store instance.
 *
 * Used by the app once (see `uiStore` below) and by every test that needs a
 * clean slice — that isolation is the whole reason this is a factory rather
 * than a bare module-level `create()`.
 */
export function createUiStore(seed: UiStoreSeed = {}) {
  // ONE persisted read per store instance, shared by every seeded fact — the
  // same single `loadUi()` App does for its own lazy initializers.
  const persisted = loadUi();
  return createStore<UiStoreState>()((set) => ({
    snippets: seed.snippets ?? persisted.snippets ?? [],
    setSnippets: (snippets) => set({ snippets }),
    fileViewerViewMode: seed.fileViewerViewMode ?? persisted.fileViewerViewMode ?? 'rendered',
    setFileViewerViewMode: (fileViewerViewMode) => set({ fileViewerViewMode }),
  }));
}

/** The store type, so consumers/tests can name an instance. */
export type UiStore = ReturnType<typeof createUiStore>;

/**
 * The ONE app-level instance. Created at module load from the persisted
 * payload, mirroring the single `loadUi()` read App does for its own seeds.
 */
export const uiStore: UiStore = createUiStore();

/**
 * Subscribe to a slice of the app-level store.
 *
 * Always select the NARROWEST slice you need — `useUiStore((s) => s.snippets)`,
 * never the whole state object — so a component re-renders only when the fact
 * it actually reads changes.
 */
export function useUiStore<T>(selector: (state: UiStoreState) => T): T {
  return useStore(uiStore, selector);
}

// ─── Per-fact hooks ──────────────────────────────────────────────────────────
//
// Named hooks rather than raw selectors at each call site: the selector lives in
// exactly one place per fact, so every surface reading `snippets` is guaranteed
// to subscribe identically (and a future move of the fact touches one line).

/** The shared snippet library (WARDEN-323). Read-only subscription. */
export function useSnippets(): Snippet[] {
  return useUiStore((s) => s.snippets);
}

/**
 * The snippet-library setter. Stable across renders (zustand actions are created
 * once with the store), so it is safe in a dependency array.
 */
export function useSetSnippets(): (snippets: Snippet[]) => void {
  return useUiStore((s) => s.setSnippets);
}

/**
 * The File Viewer's Rendered ⇄ Source markdown toggle (WARDEN-480, WARDEN-1288).
 * Read-only subscription — FileViewer reads it here instead of receiving it
 * through four pass-through ancestors.
 */
export function useFileViewerViewMode(): 'rendered' | 'source' {
  return useUiStore((s) => s.fileViewerViewMode);
}

/**
 * The File Viewer view-mode setter. Stable across renders (zustand actions are
 * created once with the store), so it is safe in a dependency array — and its
 * plain value signature is what App's `resetSetters` entry calls.
 */
export function useSetFileViewerViewMode(): (mode: 'rendered' | 'source') => void {
  return useUiStore((s) => s.setFileViewerViewMode);
}
