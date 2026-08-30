// Persistence for the Open Chat browser's host multiselect (the user's browsing
// scope). Extracted from OpenChatBrowserPage.tsx so it is unit-testable without
// a React environment — the same move as @/lib/chatDisplay and @/lib/agentFilter.
//
// Stored under its own localStorage key so it can't race with App's centralized
// UiState save. (WARDEN-109 Facet B: keep on `warden:discover-hosts:v1`.)
//
// Failure handling follows the app-wide localStorage convention (saveUi / saveObs
// in storage.ts, stampLastSeen in whatsNew.ts, saveWatchMissLog in
// watchCatchup.ts, saveStateEnteredAt in stateDuration.ts): a failed WRITE is
// console.warn'd under this module's `[warden:discoverHosts]` namespace instead
// of being swallowed, and so is a failed READ of corrupt data. Absence of a
// stored value is NOT an error — it is the ordinary first run. (WARDEN-1230:
// this site previously discarded write failures silently — the only one of the
// ten local-storage writers to do so — AND parsed
// `JSON.parse(localStorage.getItem(KEY) || '')`, whose '' fallback throws, so
// the catch was load-bearing for every first run and could not tell "nothing
// stored yet" from "stored data is corrupt".)

export const DISCOVER_HOSTS_KEY = 'warden:discover-hosts:v1';

/**
 * Read the persisted host selection. `undefined` = nothing usable stored (a
 * first run, or stored data that failed to parse — the latter warn'd) → the
 * caller falls back to its computed default. A stored array is returned with
 * non-string entries dropped. Never throws.
 */
export function loadDiscoverHosts(): string[] | undefined {
  try {
    // `?? 'null'`, not `|| ''`: a missing key parses to `null` — an ordinary
    // absence the guard below handles, silently — instead of `JSON.parse('')`
    // throwing SyntaxError and landing in the catch. Same idiom as loadObs.
    // (WARDEN-1230.)
    const v = JSON.parse(localStorage.getItem(DISCOVER_HOSTS_KEY) ?? 'null');
    if (Array.isArray(v)) return v.filter((h) => typeof h === 'string');
  } catch (e) {
    // Stored data exists but doesn't parse — a real defect, surfaced per the
    // convention; the caller proceeds as on a first run.
    console.warn('[warden:discoverHosts] loadDiscoverHosts failed, ignoring stored hosts', e);
  }
  return undefined;
}

/**
 * Persist the host selection. Never throws — a quota/serialize failure is
 * console.warn'd (matching saveUi / saveWatchMissLog / stampLastSeen), so a full
 * localStorage never crashes the host picker; the worst case is the selection
 * resets on next restart.
 */
export function saveDiscoverHosts(hosts: string[]) {
  try { localStorage.setItem(DISCOVER_HOSTS_KEY, JSON.stringify(hosts)); }
  catch (e) { console.warn('[warden:discoverHosts] saveDiscoverHosts failed', e); }
}
