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
// This seam replaces the full-pane gate with a PER-SECTION one. It keys off the
// per-section dependency classification that lives in sectionPersistence.ts
// (WARDEN-1210) — still imported, deliberately NOT re-derived — so there is
// exactly ONE description of "which sections need what data" in the codebase.
//
// WARDEN-1210 measurement note: with a ~34-host fleet (30 slow/unreachable via
// a fake ssh), GET /api/config stays at p50 2ms / p99 8ms while every fleet
// sweep runs (0 event-loop stalls recorded by the server's own loop monitor),
// and stays 2-12ms even while a worst-host-bound request is in flight — host
// work does not measurably delay the config GET. The gate below therefore takes
// ONLY config-load state as input: host-data availability is deliberately NOT a
// gate input for ANY section (the hosts section and the new-chat picker degrade
// in-section to configured hosts while discovery settles), so no amount of host
// latency can hold a section hostage.
import { sectionDataDependency, readsBackendConfig } from './sectionPersistence';

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
  // Per-section-accurate (WARDEN-1210): a section gates on the config GET ONLY
  // if its dependency reads backend config. Client-pref sections (plain or with
  // a degrading host picker) are ALWAYS 'ready'. Host-data availability is
  // intentionally absent from LoadState — no section may wait on it.
  if (!readsBackendConfig(sectionDataDependency(activeSection))) return 'ready';
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
