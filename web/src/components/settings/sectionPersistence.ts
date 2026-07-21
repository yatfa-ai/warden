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
 * Section ids whose edits apply instantly to client localStorage and never reach
 * Save's PUT /api/config. Everything else in `SETTINGS_SECTIONS` is a
 * server-config section that Save commits.
 */
export const CLIENT_PREF_SECTIONS: ReadonlySet<string> = new Set([
  'appearance',
  'newchats',
  'snippets',
]);

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
