// The active Settings section's persistence model — the pure seam behind the
// global Settings footer label (WARDEN-870).
//
// Settings has ONE global Save/Cancel footer rendered across every section, but
// the sections split into two persistence models the footer historically ignored:
//
//   - Server-config sections (hosts, observer, safety, attention, tokenbudget,
//     performance, telemetry, display, patterns, notifications) take
//     `config`/`setConfig`; Save commits them via PUT /api/config, Cancel
//     discards the drafted edits by closing.
//   - Instant client-pref sections (appearance, newchats, snippets) are pure
//     client localStorage — edits apply instantly and never reach Save's PUT.
//
// So on an instant-pref section Cancel reads as "undo" (it isn't — the change
// already applied) and Save reads as "commit what I changed" (it doesn't — it
// PUTs the untouched server config). This seam derives a footer label stating
// the active section's actual persistence model, mirroring the in-section labels
// WARDEN-784 added to NotificationsSection — lifted to the footer where the
// Save/Cancel buttons actually live.
//
// Notifications is hybrid in-section (server toast/webhook toggles blended with
// an instant desktop-alert toggle, each labeled by WARDEN-784), but at the
// footer level Save commits its webhook/toast toggles, so it resolves to server.

/**
 * What a Settings section's body actually READS — the single authoritative
 * per-section dependency classification (WARDEN-1210).
 *
 * Settings used to classify sections into exactly two buckets (client-pref vs
 * "backend"), with every backend section waiting behind one shared readiness
 * flag tied to the config GET. That binary model has no notion of a section
 * depending on HOST data specifically, so a section that reads only plain
 * config fields sits in the same bucket as the host picker — and any future
 * host-data readiness input would gate them all together again.
 *
 * This map replaces the binary classification with a per-section one. It is the
 * ONE source: the footer persistence label (sectionPersistence below), the
 * per-section readiness gate (sectionLoadGate.ts), and SettingsPage's mount
 * structure all derive from it — nothing keeps a second parallel list.
 */
export type SectionDataDependency =
  /** Values live in client localStorage; the section reads nothing from the backend. */
  | 'client'
  /** Values are client localStorage, but a supplementary control (the new-chat
   *  host picker) reads discovered hosts. Discovery degrades in-section (the
   *  picker falls back to configured hosts) — it never gates the section. */
  | 'client-host-picker'
  /** Plain config fields only (GET /api/config). No host data is read. */
  | 'config'
  /** Config fields AND host data. Host data (discovered hosts) degrades
   *  in-section exactly like `client-host-picker` — it is NEVER a gate input,
   *  so slow/unreachable hosts cannot delay the section becoming usable. */
  | 'config-hosts';

/** The explicit per-section declarations. Any SETTINGS_SECTIONS id absent here
 *  reads only plain config fields — 'config' is the safe default, so a NEW
 *  section is gated (never renders unloaded defaults) unless it opts out. */
const SECTION_DEPENDENCY_OVERRIDES: Readonly<Record<string, SectionDataDependency>> = {
  appearance: 'client',
  newchats: 'client-host-picker',
  snippets: 'client',
  hosts: 'config-hosts',
};

/** Resolve a section's data dependency. Unknown ids → 'config' (see above). */
export function sectionDataDependency(sectionId: string): SectionDataDependency {
  return SECTION_DEPENDENCY_OVERRIDES[sectionId] ?? 'config';
}

/** Whether the section's SAVED values are client localStorage (never PUT). */
export function isClientPrefDependency(dep: SectionDataDependency): boolean {
  return dep === 'client' || dep === 'client-host-picker';
}

/** Whether the section reads backend config (so gates on the config GET). */
export function readsBackendConfig(dep: SectionDataDependency): boolean {
  return dep === 'config' || dep === 'config-hosts';
}

/**
 * Section ids whose edits apply instantly to client localStorage and never reach
 * Save's PUT /api/config. DERIVED from the dependency map above (WARDEN-1210) —
 * do not add ids here; declare the section's dependency instead.
 */
export const CLIENT_PREF_SECTIONS: ReadonlySet<string> = new Set(
  Object.entries(SECTION_DEPENDENCY_OVERRIDES)
    .filter(([, dep]) => isClientPrefDependency(dep))
    .map(([id]) => id),
);

export type SectionPersistenceKind = 'server' | 'client';

export interface SectionPersistence {
  kind: SectionPersistenceKind;
  /** Footer copy, reused verbatim from WARDEN-784's in-section labels. */
  label: string;
};

/** Server-config footer copy (verbatim from WARDEN-784's NotificationsSection). */
export const SERVER_PERSISTENCE_LABEL = 'Saved when you press Save.';

/** Instant client-pref footer copy — WARDEN-784's desktop-alert line, extended
 *  with the "no Save needed" reassurance that is the whole point of WARDEN-870. */
export const CLIENT_PERSISTENCE_LABEL =
  'Applied instantly and remembered locally on this device — no Save needed.';

/**
 * Derive the active section's persistence model for the global footer label.
 *
 * `activeSection` is the current SETTINGS_SECTIONS id. Anything in
 * {@link CLIENT_PREF_SECTIONS} is instant client-pref; everything else
 * (including the hybrid `notifications` section) is server-config.
 */
export function sectionPersistence(activeSection: string): SectionPersistence {
  return CLIENT_PREF_SECTIONS.has(activeSection)
    ? { kind: 'client', label: CLIENT_PERSISTENCE_LABEL }
    : { kind: 'server', label: SERVER_PERSISTENCE_LABEL };
}
