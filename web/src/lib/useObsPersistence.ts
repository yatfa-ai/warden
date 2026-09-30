import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { loadObs, saveObs } from '@/lib/storage';
import { useUiStore, selectPersistedObsPrefs } from '@/lib/uiStore';

/**
 * The ObsUi namespace's always-mounted persistence writer (roadmap
 * WARDEN-1204 slice 17, WARDEN-1477) — the warden:observer:v1 twin of what
 * slice 16 (WARDEN-1471) did for warden:ui:v3 inside useConfigPersistence.
 *
 * THE DEFECT IT CLOSES: the four ObsUi view prefs (viewMode + the three
 * filter shapes) have been store facts since slice 15, but their only disk
 * writer stayed where slice 10 put it — ObserverTabs' `booted`-gated
 * saveObs(obsBag) effect. Durability therefore depended on a component's
 * lifecycle, in two reachable modes:
 *
 *   MODE 1 — panel UNMOUNTED. App's own "View Activity" deep-links
 *     (`openActivityTab`: the return-after-absence banner and the header
 *     AttentionBadge) write setObserverViewMode directly from App. The banner
 *     renders outside the Settings ternary, so one click reaches a state where
 *     ObserverTabs is not in the tree at all — and the write was lost on
 *     restart (the Observer reopened on Sessions).
 *
 *   MODE 2 — mounted but NOT booted. ObserverTabs' boot effect sets `booted`
 *     only AFTER `await refresh()` and a possible POST /api/sessions; the
 *     create-failure branch returns without ever setting it. That is a real,
 *     persistent state, and in it the panel's writer never fires.
 *
 * PERSISTENCE BECOMES A PROPERTY OF THE STORE: this hook subscribes ONCE
 * (useShallow(selectPersistedObsPrefs)) and persists the four facts through
 * the saveUi-effect's exact shape — except on the SECOND namespace, so the
 * write is saveObs, not persistUiState (persistUiState touches only
 * warden:ui:v3; ObsUi never rode it and must not start now).
 *
 * ── PLACEMENT TRADE-OFF (this slice's stated design decision) ──────────────
 * Two viable placements existed; this is (b), a sibling hook, over (a),
 * extending useConfigPersistence with an ObsUi merge:
 *   (a) would need no new App wiring, but useConfigPersistence is
 *       single-namespace BY DOCUMENTED INVARIANT — its comment and the
 *       uiStore.test.mjs guards pin it as "the ONE saveUi call site" owning
 *       warden:ui:v3 only. Folding a second namespace + a second storage API
 *       (loadObs/saveObs) into it blurs that invariant and couples two
 *       namespaces' re-fire semantics into one effect's dep array.
 *   (b) keeps one namespace per hook and mirrors the slice-16 pattern
 *       one-for-one (one derived key list, one selector, one shallow
 *       subscription, one write call), at the cost of a second always-on
 *       effect. That cost is four Object.is comparisons per store change —
 *       the same price slice 16 accepted for 31 facts.
 *
 * ── THE PARTIAL-BAG HAZARD (why the merge reads loadObs()) ─────────────────
 * saveObs writes the WHOLE warden:observer:v1 document. This hook owns only
 * the STORE half (the four prefs — exactly OBS_RESET_KEYS); the COMPONENT
 * half (openIds/activeId — OBS_PRESERVED_KEYS) stays with ObserverTabs'
 * booted-gated effect, because those workspace facts are meaningless before
 * boot reconciliation against the live session list (stale ids evicted,
 * at-least-one-tab enforced) and are deliberately NOT on the store. So this
 * writer MUST merge over loadObs(): `{ ...loadObs(), ...obsPrefs }` —
 * spreading the disk document under the store prefs means a pref write can
 * never clobber openIds/activeId that ObserverTabs wrote moments earlier.
 * The reverse direction needs no merge: the component's bag is
 * `satisfies Required<ObsUi>`-complete and reads all four prefs LIVE from
 * the store on every render, so its whole-document write re-asserts the
 * current prefs rather than stale ones. uiStore.test.mjs proves both
 * directions with an interleaved-writers test.
 *
 * NOT gated (no `booted`-style flag, no Settings-open condition): this
 * effect lives in App, which is mounted for the app's whole lifetime — that
 * is the entire point. The one deliberate redundancy — a mounted, booted
 * panel also writes the four prefs — is inert by construction: both writers
 * hold the same live store values, so the happy path persists byte-identical
 * documents either way.
 */
export function useObsPersistence() {
  // The store-owned ObsUi half, subscribed ONCE for all four facts. useShallow
  // keeps the returned object referentially stable across renders, so App
  // re-renders only when one of the four actually changes — the same
  // re-render-per-change semantics the slice-16 subscription provides for the
  // other namespace. The setters replace the filter shapes whole (and
  // ObserverTabs' adapters patch via spread-updaters, replacing the parent
  // object), so a scalar change inside a shape is always an identity change in
  // its Object.values slot.
  const obsPrefs = useUiStore(useShallow(selectPersistedObsPrefs));

  // The ObsUi write: disk document under store prefs. Re-fires only when one
  // of the four values actually changes (plus the initial mount, which writes
  // back exactly what the store seeded from loadObs() — an inert no-op unless
  // disk has drifted).
  useEffect(() => {
    saveObs({ ...loadObs(), ...obsPrefs });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- non-literal by design: the dep set is every value of the ObsUi store half (one per OBS_RESET_KEYS entry), derived from the same type-checked selector as the payload — the compile-locked shape means a pref added to OBS_RESET_KEYS but dropped here is a tsc error (selectPersistedObsPrefs' ObsUiPrefs return annotation), not a silently-cold dep array (the WARDEN-442/468/500 class, ObsUi twin).
  }, [...Object.values(obsPrefs)]);
}
