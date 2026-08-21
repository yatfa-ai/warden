// Telemetry CONSENT — the single authority (WARDEN-1116, design WARDEN-443
// Principle 2: "Consent is per-category and independent... never couple
// categories so that opting into one enables another").
//
// This module replaces the linear three-value `ConsentTier` ('base' | 'extended'
// | 'off') that the client shipped with. Consent is now a SET of INDEPENDENT
// per-category switches:
//
//   • Every category is OFF by default.
//   • Turning one category on NEVER turns another on. There is no clamp, no
//     "requires", no ordering — the categories do not know about each other.
//   • EXACTLY ONE resolver (`resolveConsent` / `normalizeConsent` below) decides
//     what is enabled. Every gate in the pipeline consults it; no gate compares a
//     tier string or re-derives consent for itself.
//
// WHY a registry rather than named booleans: adding the next category (the usage
// metrics WARDEN-443's 2026-08-19 authorization approves) must be a DATA ADDITION
// here — one entry in TELEMETRY_CATEGORIES — not a redesign of any gate. The
// redaction gate, the transparency catalog, the persisted config fields, the
// legacy migration, and the Settings UI are all DERIVED from this array, so a new
// entry threads through all of them without touching their logic.
//
// ONLY CATEGORIES WITH A REAL PRODUCER ARE LISTED. `incidents` and `names` are
// the two things warden actually collects today. No switch is declared here for a
// category that collects nothing yet — a toggle with no producer behind it is a
// lie to the user (and WARDEN-131's silent-no-op trap in its purest form).
//
// ZERO RUNTIME IMPORTS + no app dependency, so the emitted module loads
// standalone under `node --test` (see web/telemetry-consent.test.mjs) exactly
// like redact.ts. A CJS mirror lives at src/telemetry-consent.cjs — one artifact
// shared by BOTH Node-side consumers (the Electron main process and the backend
// server, neither of which can load TypeScript); web/telemetry-consent-cjs-
// parity.test.mjs guards the two implementations against drift.

// ---------------------------------------------------------------------------
// The categories.
// ---------------------------------------------------------------------------

/** A telemetry collection category. Each one is an independent user choice. */
export type TelemetryCategory = 'incidents' | 'names';

/**
 * How a category relates to the payload:
 *  - `'collecting'` — it PRODUCES events. Enabling it is what makes telemetry
 *    send anything at all.
 *  - `'decorating'` — it only ADDS FIELDS to events other categories produce. On
 *    its own it is INERT: with no collecting category enabled there is no event
 *    for its fields to ride on, so it sends nothing. That inertness is why it
 *    needs no clamp (the old "extended requires base") to stay safe.
 */
export type CategoryRole = 'collecting' | 'decorating';

/**
 * How a category's value is recovered from a config written by a PRE-WARDEN-1116
 * build (the linear base/extended pair).
 *
 * `requires` exists ONLY here, and ONLY to translate the old model's EFFECTIVE
 * consent: the old resolver clamped extended to false unless base was on, so a
 * stale `{base:false, extended:true}` pair meant "nothing is collected, no names"
 * and must migrate to names:false — migrating it to names:true would enable a
 * category the user's old effective consent never had on. It is a translation
 * rule for one-time migration, NOT a live coupling: once the new keys exist the
 * categories are fully independent and `requires` is never consulted again.
 */
export interface LegacyConsentSource {
  readonly key: string;
  readonly requires?: string;
}

/**
 * The persisted `/api/config` key for a category, DERIVED from its id by
 * construction: `incidents` → `telemetryIncidentsEnabled`. Because it is a
 * template-literal type over {@link TelemetryCategory}, a typed consumer (e.g. the
 * Settings `ConfigData`) gains the new field the moment a category id is added —
 * and a descriptor whose `configKey` does not follow the convention fails to
 * compile.
 */
export type TelemetryConsentConfigKey = `telemetry${Capitalize<TelemetryCategory>}Enabled`;

export interface TelemetryCategoryDescriptor {
  /** Stable identifier — the key in a {@link TelemetryConsent} map. */
  readonly id: TelemetryCategory;
  /** The persisted `/api/config` boolean this category is stored as. */
  readonly configKey: TelemetryConsentConfigKey;
  /** Where to recover the value from a pre-WARDEN-1116 config. */
  readonly legacy: LegacyConsentSource;
  /** See {@link CategoryRole}. */
  readonly role: CategoryRole;
  /** Short Settings label (the switch's text). */
  readonly label: string;
  /** One-sentence honest description of exactly what this category collects. */
  readonly summary: string;
  /**
   * The base-event types this category PRODUCES (empty for a decorating
   * category). Drives the transparency catalog's per-category disclosure.
   */
  readonly eventTypes: readonly string[];
  /**
   * Payload field names this category GATES, lowercased for case-insensitive key
   * matching. A field listed here is retained by redaction iff this category is
   * enabled, and dropped otherwise. Empty for a category that adds no fields.
   */
  readonly gatedFields: readonly string[];
}

/**
 * THE REGISTRY. Adding a category is an entry here plus its producer — every
 * derived surface (config field, GET/PUT, migration, redaction gate, transparency
 * catalog, Settings switch) follows automatically.
 */
export const TELEMETRY_CATEGORIES: readonly TelemetryCategoryDescriptor[] = Object.freeze([
  Object.freeze({
    id: 'incidents' as const,
    configKey: 'telemetryIncidentsEnabled' as const,
    legacy: Object.freeze({ key: 'telemetryBaseEnabled' }),
    role: 'collecting' as const,
    label: 'Anonymous errors, crashes & freezes',
    summary:
      'Anonymous error, crash, and event-loop-freeze reports — no chat content, no file paths, no hostnames, no credentials.',
    eventTypes: Object.freeze(['error', 'crash', 'performance-stall']),
    gatedFields: Object.freeze([]),
  }),
  Object.freeze({
    id: 'names' as const,
    configKey: 'telemetryNamesEnabled' as const,
    legacy: Object.freeze({ key: 'telemetryExtendedEnabled', requires: 'telemetryBaseEnabled' }),
    role: 'decorating' as const,
    label: 'Chat & session names',
    summary:
      'Adds the chat name and Claude session name to whatever else you have turned on. Chat content is never sent — names only. On its own this sends nothing: there is no event for a name to ride on.',
    eventTypes: Object.freeze([]),
    gatedFields: Object.freeze(['chatname', 'sessionname', 'chattitle', 'sessiontitle']),
  }),
]);

/** Every category id, in registry order. */
export const TELEMETRY_CATEGORY_IDS: readonly TelemetryCategory[] = Object.freeze(
  TELEMETRY_CATEGORIES.map((c) => c.id),
);

/** Descriptor lookup by id. */
export const CATEGORY_BY_ID: ReadonlyMap<TelemetryCategory, TelemetryCategoryDescriptor> = new Map(
  TELEMETRY_CATEGORIES.map((c) => [c.id, c]),
);

/**
 * Lowercased payload field name → the category that gates it. THE data behind
 * the redaction gate: a field in this map survives redaction iff its category is
 * enabled. A future category that retains new fields extends this map by
 * declaring `gatedFields`; the redactor's code does not change.
 */
export const GATED_FIELD_CATEGORY: ReadonlyMap<string, TelemetryCategory> = new Map(
  TELEMETRY_CATEGORIES.flatMap((c) => c.gatedFields.map((f) => [f, c.id] as const)),
);

// ---------------------------------------------------------------------------
// The consent state + THE resolver.
// ---------------------------------------------------------------------------

/** An independent on/off per category. */
export type TelemetryConsent = Readonly<Record<TelemetryCategory, boolean>>;

/** Everything off — the default, and the answer to every failure mode. */
export const NO_CONSENT: TelemetryConsent = Object.freeze(
  Object.fromEntries(TELEMETRY_CATEGORY_IDS.map((id) => [id, false])) as Record<
    TelemetryCategory,
    boolean
  >,
);

/**
 * Normalize an arbitrary value into a {@link TelemetryConsent}, keyed by category
 * id. STRICTLY `=== true` per category: a missing, non-boolean, corrupt, or
 * unrecognized value is OFF. Unknown keys are ignored (an old build's category
 * that no longer exists can never enable anything). Never throws — a non-object
 * (null, a string, a number, an array) yields {@link NO_CONSENT}.
 *
 * This is the gate-side entry point: a value that already speaks in categories.
 */
export function normalizeConsent(value: unknown): TelemetryConsent {
  const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const out = {} as Record<TelemetryCategory, boolean>;
  for (const id of TELEMETRY_CATEGORY_IDS) out[id] = v[id] === true;
  return Object.freeze(out);
}

/**
 * Resolve {@link TelemetryConsent} from the PERSISTED preference bag (the
 * `/api/config` shape). For each category:
 *
 *  1. If its `configKey` is present as a real boolean, that value wins.
 *  2. If its `configKey` is present but NOT a boolean (corrupt / hand-edited),
 *     the category is OFF. It does NOT fall through to the legacy key — a corrupt
 *     value must never be reinterpreted into an enabled state.
 *  3. If its `configKey` is absent entirely (a config written by a pre-WARDEN-1116
 *     build), the legacy pair is translated forward — see {@link LegacyConsentSource}.
 *
 * Never throws; anything unusable yields {@link NO_CONSENT}. This is the off-by-
 * default guarantee, and it holds for a missing, partial, malformed, or
 * unrecognized persisted state.
 */
export function resolveConsent(prefs: unknown): TelemetryConsent {
  const p = prefs && typeof prefs === 'object' ? (prefs as Record<string, unknown>) : {};
  const out = {} as Record<TelemetryCategory, boolean>;
  for (const cat of TELEMETRY_CATEGORIES) {
    if (Object.prototype.hasOwnProperty.call(p, cat.configKey)) {
      out[cat.id] = p[cat.configKey] === true;
      continue;
    }
    out[cat.id] =
      p[cat.legacy.key] === true &&
      (cat.legacy.requires === undefined || p[cat.legacy.requires] === true);
  }
  return Object.freeze(out);
}

/**
 * Fold a pre-WARDEN-1116 preference bag forward IN PLACE-FREE FASHION: returns a
 * copy of `prefs` with each category's `configKey` materialized from
 * {@link resolveConsent}. Used by the persisted-config load path so the migration
 * happens once, on disk, rather than being re-derived forever. Legacy keys are
 * left untouched (a downgrade to an older build still finds what it expects);
 * they are simply no longer read once the new keys exist.
 */
export function migrateConsentPrefs<T extends Record<string, unknown>>(
  prefs: T,
): T & Record<string, boolean> {
  const resolved = resolveConsent(prefs);
  const out = { ...(prefs as Record<string, unknown>) };
  for (const cat of TELEMETRY_CATEGORIES) out[cat.configKey] = resolved[cat.id];
  return out as T & Record<string, boolean>;
}

/** Project a {@link TelemetryConsent} back onto its persisted config keys. */
export function consentToPrefs(consent: TelemetryConsent): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const cat of TELEMETRY_CATEGORIES) out[cat.configKey] = consent[cat.id] === true;
  return out;
}

// ---------------------------------------------------------------------------
// Queries every gate uses. No gate re-derives these.
// ---------------------------------------------------------------------------

/** Is `category` enabled? Unknown ids are OFF. */
export function isCategoryEnabled(consent: TelemetryConsent, category: string): boolean {
  return (consent as Record<string, boolean>)[category] === true;
}

/** The enabled category ids, in registry order. */
export function enabledCategories(consent: TelemetryConsent): TelemetryCategory[] {
  return TELEMETRY_CATEGORY_IDS.filter((id) => consent[id] === true);
}

/**
 * Does this consent state cause ANY event to be produced? True iff at least one
 * COLLECTING category is on. A decorating-only state (e.g. names alone) is
 * false — nothing is collected, so nothing is sent. This is the pipeline's
 * "off = nothing" gate, and it opens automatically for a future collecting
 * category without the gate's code changing.
 */
export function collectsEvents(consent: TelemetryConsent): boolean {
  return TELEMETRY_CATEGORIES.some((c) => c.role === 'collecting' && consent[c.id] === true);
}

/** The base-event types the enabled collecting categories produce, de-duplicated. */
export function collectedEventTypes(consent: TelemetryConsent): string[] {
  const out: string[] = [];
  for (const c of TELEMETRY_CATEGORIES) {
    if (consent[c.id] !== true) continue;
    for (const t of c.eventTypes) if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** The payload field names the enabled categories retain, in registry order. */
export function retainedFields(consent: TelemetryConsent): string[] {
  const out: string[] = [];
  for (const c of TELEMETRY_CATEGORIES) {
    if (consent[c.id] !== true) continue;
    out.push(...c.gatedFields);
  }
  return out;
}

/** A new consent state with one category flipped. Purely functional. */
export function withCategory(
  consent: TelemetryConsent,
  category: TelemetryCategory,
  enabled: boolean,
): TelemetryConsent {
  return normalizeConsent({ ...consent, [category]: enabled === true });
}
