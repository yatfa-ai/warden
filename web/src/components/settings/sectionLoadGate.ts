// Per-section readiness for the Settings content pane (WARDEN-976).
//
// Settings used to gate the WHOLE content pane on the `/api/config` GET: one
// `loading ? <"Loading configuration…"> : <every section>` branch in
// SettingsPage. That shape converts any backend slowness into a blank page —
// including for the three sections (`appearance`, `newchats`, `snippets`) that
// persist to client localStorage, apply instantly, and never touch the backend
// at all. A multi-second config GET (and the bounded retry behind it, WARDEN-828)
// was therefore experienced as ten seconds of nothing.
//
// This seam replaces the full-pane gate with a PER-SECTION one, keyed off the
// classification that already exists for the footer persistence label
// (`CLIENT_PREF_SECTIONS`, WARDEN-870). It is imported — deliberately NOT
// re-derived — so there is exactly one list of "which sections need the
// backend" in the codebase.
import { CLIENT_PREF_SECTIONS } from './sectionPersistence';

/**
 * What the content pane should show for the active section.
 *
 * - `ready`   — render the real section body.
 * - `pending` — a backend-config section whose values are not known yet. It
 *               must read as pending rather than showing DEFAULT_CONFIG values,
 *               which would display wrong values and invite a save that
 *               clobbers real persisted configuration.
 * - `failed`  — the bounded load exhausted its timeout + retries (WARDEN-828).
 *               Surfaces the retry affordance, in place, for that section only.
 */
export type SectionGate = 'ready' | 'pending' | 'failed';

export interface LoadState {
  /** True once a GET /api/config has resolved successfully at least once. */
  configLoaded: boolean;
  /** True when the bounded config load settled in its error state. */
  loadFailed: boolean;
}

/**
 * Resolve the gate for `activeSection`.
 *
 * A client-pref section is ALWAYS `ready`: its values live in client
 * localStorage and are already on screen, so it must never wait on — or be
 * blanked by — a backend fetch it does not read. Everything else waits for the
 * config GET, and waits *in place*.
 *
 * `configLoaded` wins over `loadFailed`: once real values are on screen a later
 * failed refetch must not replace them with an error state.
 */
export function sectionGate(activeSection: string, { configLoaded, loadFailed }: LoadState): SectionGate {
  if (CLIENT_PREF_SECTIONS.has(activeSection)) return 'ready';
  if (configLoaded) return 'ready';
  return loadFailed ? 'failed' : 'pending';
}

/**
 * Whether the footer Save may fire.
 *
 * Save PUTs the whole backend config, so it must be impossible to write a
 * configuration that was never loaded — a never-loaded draft is DEFAULT_CONFIG,
 * and PUTting that would clobber the real persisted config with defaults. This
 * is strictly stronger than the previous `!(loading || loadError)` guard: it is
 * keyed on "did a GET ever succeed", not on "is a fetch in flight right now".
 */
export function canSaveBackendConfig({ configLoaded, saving }: { configLoaded: boolean; saving: boolean }): boolean {
  return configLoaded && !saving;
}
