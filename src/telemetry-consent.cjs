'use strict';

// CJS MIRROR of web/src/lib/telemetry/consent.ts (WARDEN-1116).
//
// THREE runtimes need the consent authority and only one of them can load
// TypeScript:
//   • the renderer (Vite/TS)          → web/src/lib/telemetry/consent.ts
//   • the Electron MAIN process (CJS) → require('../src/telemetry-consent.cjs')
//   • the backend server (ESM)        → import './telemetry-consent.cjs'
// A `.cjs` file is CommonJS regardless of the package's "type": "module", so this
// single artifact serves BOTH Node-side consumers — exactly ONE resolver
// implementation runs in production, not one per process. It is PURE and
// DEPENDENCY-FREE (importing it pulls in no Electron and no server code), which is
// why the backend may import it without taking on an Electron dependency.
//
// This is the same discipline electron/telemetry-redact.cjs uses for redact.ts: a
// hand-maintained mirror of the TS canonical, guarded against drift by a PARITY
// TEST that loads BOTH files and asserts identical behavior —
// web/telemetry-consent-cjs-parity.test.mjs.
//
// !! KEEP IN SYNC WITH web/src/lib/telemetry/consent.ts !!
// The TS module is the canonical source. Read its header for the full rationale
// (per-category independence, off-by-default in every failure mode, and why the
// registry is data so a new category is an entry rather than a redesign).

// ---------------------------------------------------------------------------
// The registry — mirrors TELEMETRY_CATEGORIES.
// ---------------------------------------------------------------------------
const TELEMETRY_CATEGORIES = Object.freeze([
  Object.freeze({
    id: 'incidents',
    configKey: 'telemetryIncidentsEnabled',
    legacy: Object.freeze({ key: 'telemetryBaseEnabled' }),
    role: 'collecting',
    label: 'Anonymous errors, crashes & freezes',
    summary:
      'Anonymous error, crash, and event-loop-freeze reports — from the app AND its backend process — no chat content, no file paths, no hostnames, no credentials.',
    // WARDEN-1278 — see the canonical entry in web/src/lib/telemetry/consent.ts.
    eventTypes: Object.freeze(['error', 'crash', 'performance-stall', 'server-stall']),
    gatedFields: Object.freeze([]),
  }),
  Object.freeze({
    id: 'names',
    configKey: 'telemetryNamesEnabled',
    legacy: Object.freeze({ key: 'telemetryExtendedEnabled', requires: 'telemetryBaseEnabled' }),
    // WARDEN-1416 — COLLECTING: the category now PRODUCES its own event (the
    // bounded `workspace-names` window aggregate) instead of only decorating
    // events other categories build. That flip is what closes the dead switch —
    // a names-only consent used to send nothing, which WARDEN-443 names
    // explicitly: "A category that sends nothing is not consent, it is a dead
    // switch." The category still gates the decoration fields below, so a
    // names-enabled user who ALSO enables incidents still gets names on
    // incidents events; but names alone now sends its own bounded event.
    role: 'collecting',
    label: 'Chat & session names',
    summary:
      'Periodically sends a bounded list of your chat names (the ones shown in the sidebar — for a resumed Claude session, its session name), plus a count. Capped and de-duplicated; chat content is never sent — names only.',
    // WARDEN-1416 — the names category's OWN event type. Disclosed here because
    // the transparency panel's contract is to list every event type a category
    // produces; a silently-added type would be exactly the lie of omission that
    // surface exists to prevent.
    eventTypes: Object.freeze(['workspace-names']),
    gatedFields: Object.freeze(['chatname', 'sessionname', 'chattitle', 'sessiontitle']),
  }),
  // WARDEN-1258 — first usage category with a live producer; aggregates only.
  // Mirrors the canonical entry in web/src/lib/telemetry/consent.ts verbatim.
  // WARDEN-1424 — the category now ALSO carries the renderer's periodic
  // workspace-shape COUNT snapshot (one per 5-min window; counts only — never
  // names). Disclosed in eventTypes + the summary for the same reason the
  // names slice disclosed its own type: a category that starts sending a new
  // event type without saying so is the exact lie of omission the transparency
  // surface exists to prevent.
  Object.freeze({
    id: 'operational-metrics',
    configKey: 'telemetryOperationalMetricsEnabled',
    legacy: Object.freeze({}),
    role: 'collecting',
    label: 'Operational metrics',
    summary:
      'Aggregate counts, success rates, and latency histograms of app operations (the terminal file-link existence probes, /api request timing, and renderer pane-latency windows), plus one periodic workspace-shape snapshot of counts only — how many workspaces, open panes, and chats exist (numbers only; never names or titles, no file paths, no hostnames, no chat content, no credentials).',
    eventTypes: Object.freeze(['operational-metrics', 'workspace-shape']),
    gatedFields: Object.freeze([]),
  }),
]);

const TELEMETRY_CATEGORY_IDS = Object.freeze(TELEMETRY_CATEGORIES.map((c) => c.id));

const CATEGORY_BY_ID = new Map(TELEMETRY_CATEGORIES.map((c) => [c.id, c]));

const GATED_FIELD_CATEGORY = new Map(
  TELEMETRY_CATEGORIES.flatMap((c) => c.gatedFields.map((f) => [f, c.id])),
);

const NO_CONSENT = Object.freeze(
  Object.fromEntries(TELEMETRY_CATEGORY_IDS.map((id) => [id, false])),
);

// ---------------------------------------------------------------------------
// THE resolver — mirrors normalizeConsent / resolveConsent.
// ---------------------------------------------------------------------------

function normalizeConsent(value) {
  const v = value && typeof value === 'object' ? value : {};
  const out = {};
  for (const id of TELEMETRY_CATEGORY_IDS) out[id] = v[id] === true;
  return Object.freeze(out);
}

function resolveConsent(prefs) {
  const p = prefs && typeof prefs === 'object' ? prefs : {};
  const out = {};
  for (const cat of TELEMETRY_CATEGORIES) {
    if (Object.prototype.hasOwnProperty.call(p, cat.configKey)) {
      out[cat.id] = p[cat.configKey] === true;
      continue;
    }
    // A category younger than the WARDEN-1116 migration carries an EMPTY legacy
    // source: p[undefined] is never === true, so it resolves off — exactly the
    // off-by-default posture for a config written before the category existed.
    out[cat.id] =
      p[cat.legacy.key] === true &&
      (cat.legacy.requires === undefined || p[cat.legacy.requires] === true);
  }
  return Object.freeze(out);
}

function migrateConsentPrefs(prefs) {
  const resolved = resolveConsent(prefs);
  const out = { ...(prefs && typeof prefs === 'object' ? prefs : {}) };
  for (const cat of TELEMETRY_CATEGORIES) out[cat.configKey] = resolved[cat.id];
  return out;
}

function consentToPrefs(consent) {
  const out = {};
  for (const cat of TELEMETRY_CATEGORIES) out[cat.configKey] = consent[cat.id] === true;
  return out;
}

// ---------------------------------------------------------------------------
// Queries — mirrors the TS query helpers.
// ---------------------------------------------------------------------------

function isCategoryEnabled(consent, category) {
  return Boolean(consent) && consent[category] === true;
}

function enabledCategories(consent) {
  return TELEMETRY_CATEGORY_IDS.filter((id) => consent && consent[id] === true);
}

function collectsEvents(consent) {
  return TELEMETRY_CATEGORIES.some(
    (c) => c.role === 'collecting' && Boolean(consent) && consent[c.id] === true,
  );
}

function collectedEventTypes(consent) {
  const out = [];
  for (const c of TELEMETRY_CATEGORIES) {
    if (!consent || consent[c.id] !== true) continue;
    for (const t of c.eventTypes) if (!out.includes(t)) out.push(t);
  }
  return out;
}

function retainedFields(consent) {
  const out = [];
  for (const c of TELEMETRY_CATEGORIES) {
    if (!consent || consent[c.id] !== true) continue;
    out.push(...c.gatedFields);
  }
  return out;
}

function withCategory(consent, category, enabled) {
  return normalizeConsent({ ...(consent || {}), [category]: enabled === true });
}

module.exports = {
  TELEMETRY_CATEGORIES,
  TELEMETRY_CATEGORY_IDS,
  CATEGORY_BY_ID,
  GATED_FIELD_CATEGORY,
  NO_CONSENT,
  normalizeConsent,
  resolveConsent,
  migrateConsentPrefs,
  consentToPrefs,
  isCategoryEnabled,
  enabledCategories,
  collectsEvents,
  collectedEventTypes,
  retainedFields,
  withCategory,
};
