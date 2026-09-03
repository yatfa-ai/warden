// Telemetry VERIFIABILITY engine — slice 6 of roadmap WARDEN-446 (INFINITE:
// "warden-telemetry-client-optional-off-by-default") / design WARDEN-443.
//
// PURPOSE — make the redaction guarantee INSPECTABLE. This is the roadmap's
// literal success measure: "trust made verifiable — a user who opts in can
// confirm, by inspecting what the client actually transmits, that it matches
// exactly what consent described." `describeCollection` catalogs exactly what a
// given PER-CATEGORY consent state collects; `previewPayload` shows the EXACT
// redacted + validated payload the pipeline would transmit for any candidate
// event.
//
// WARDEN-1116 — this surface is now CATEGORY-KEYED, not tier-keyed. It describes
// collection PER CATEGORY and tells the truth for ANY combination the user picks,
// including combinations the old three-value tier could not express (e.g. names
// on with nothing collecting: honestly reported as "nothing is sent" because a
// decorating category has no event to ride on). A new category appears in the
// catalog automatically — it is read from the registry, not enumerated here.
//
// PURE. Its runtime imports are `./redact` (the shipped redactor + its field-name
// sets), `./consent` (the single consent authority) and `./schema` (the CANONICAL
// base-event contract — consumed, not restated; WARDEN-1254). See
// web/telemetry-transparency.test.mjs, which transforms all four files into the
// same tmpDir so the relative specifiers resolve.
//
// NOT a Settings UI (slice 1, WARDEN-457, owns that surface) and NOT transport
// (slice 3) or pipeline assembly (slice 5). This module only READS `redact` and
// the base-event contract; it changes no invariant and relaxes no gate.

import type { TelemetryCategory, TelemetryConsent } from './consent';
import {
  GATED_FIELD_CATEGORY,
  TELEMETRY_CATEGORIES,
  collectsEvents,
  enabledCategories,
  normalizeConsent,
} from './consent';
import { redact, CONTENT_FIELDS } from './redact';
// The base-event contract — schema version, event-type list, runtime values —
// is CONSUMED from the canonical neighbour `./schema` (WARDEN-1254). It used to
// be restated here with a "reconcile with slice 1's canonical schema when it
// lands" note, but slice 1 (WARDEN-457) had already landed when that note was
// written, so nothing pinned the pair together and the copy could drift
// unnoticed. Decision B still holds — do NOT import electron/telemetry-source
// .cjs (a main-process CommonJS module unreachable from a renderer/TS module
// and from the standalone OXC test); `./schema` is the importable canonical
// source. Both names stay re-exported from here (the transparency panel and the
// test import them via this module) — a redirection, not a restatement, so the
// two can no longer silently disagree during a future schema change.
import { BASE_EVENT_TYPES, SCHEMA_VERSION, isBaseEventType, isRuntime } from './schema';
export { BASE_EVENT_TYPES, SCHEMA_VERSION };

// ---------------------------------------------------------------------------
/**
 * The anonymous structural fields each base-event type carries (verbatim from
 * the builders in telemetry-source.cjs:153-197 + the appVersion attach at
 * :182-184 + the platform attach at :195-197). These are the fields
 * `describeCollection` advertises per type — none are content and none are
 * chat/session identifiers, so they are collected whenever the `incidents`
 * category is on.
 * `exitCode?` is conditional (present only when the crash reports one).
 * `appVersion?` and `platform?` are OPTIONAL (a source that cannot read the
 * value omits the field; a v3 event without it still validates) — and unlike
 * the other fields they are NOT strictly anonymous event data: `appVersion?`
 * is a non-identifying app RELEASE LABEL identical for every user on a release,
 * and `platform?` is a non-identifying OS LABEL (darwin/win32/linux) identical
 * for millions of users on an OS. Both are carried so a maintainer can attribute
 * event volume to a release / OS. They are disclosed here precisely BECAUSE the
 * panel's contract is to list every field a category collects — omitting a newly-
 * collected field would be a lie of omission even when (as here) the data is
 * benign. See schema.ts:84-97.
 */
const BASE_EVENT_FIELDS: Record<string, readonly string[]> = {
  error: ['schemaVersion', 'type', 'runtime', 'timestamp', 'appVersion?', 'platform?', 'name', 'message', 'frames'],
  crash: ['schemaVersion', 'type', 'runtime', 'timestamp', 'appVersion?', 'platform?', 'reason', 'exitCode?'],
  'performance-stall': ['schemaVersion', 'type', 'runtime', 'timestamp', 'appVersion?', 'platform?', 'lagMs', 'source'],
  // WARDEN-1258 — the aggregate usage event. Every field is a number or a
  // constant kebab-case operation literal; there is no free text and no
  // identifier anywhere in the shape (the validator enforces the name pattern).
  'operational-metrics': ['schemaVersion', 'type', 'runtime', 'timestamp', 'appVersion?', 'platform?', 'windowStartedAt', 'windowEndedAt', 'boundaries', 'operations', 'rejected'],
  // WARDEN-1278 — the backend child's folded stall window. Every field is a
  // number or a closed-set kebab-case culprit key; there is no free text and no
  // identifier anywhere in the shape (the validator enforces the key pattern).
  'server-stall': ['schemaVersion', 'type', 'runtime', 'timestamp', 'appVersion?', 'platform?', 'windowStartedAt', 'windowEndedAt', 'count', 'totalMs', 'maxMs', 'boundaries', 'buckets', 'culprits'],
};

// Identifier-proof patterns — NON-GLOBAL, stateless `.test` twins of the
// redactor regexes in telemetry-source.cjs:77-91. Mirrored here so the local
// validator's "no identifier leaked" proof is identical in shape to the
// source's containsIdentifier (telemetry-source.cjs:249-258). Non-global so
// there is no lastIndex hazard across the per-string validity checks.
const PATH_TEST = /(?:[A-Za-z]:[\\/]|[\\/]|~\/|\.(?:\.)?\/)(?:[^\s:'"<>|*?]+[\\/])*[^\s:'"<>|*?\\/]*/;
const USERHOST_TEST = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/;
const IPV4_TEST = /(?:\d{1,3}\.){3}\d{1,3}/;
const IPV6_TEST =
  /(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4})*::[0-9a-fA-F:]*|::[0-9a-fA-F:]+/;
const HOSTNAME_TEST = /\b(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}\b/;

/**
 * Any identifier: a file path OR a host-equivalent (user@host, bare FQDN, IPv4,
 * IPv6). Mirrors telemetry-source.cjs:249-258. Used to PROVE a redacted payload
 * carries nothing identifying.
 */
export function containsIdentifier(text: unknown): boolean {
  if (typeof text !== 'string' || text === '') return false;
  return (
    PATH_TEST.test(text) ||
    USERHOST_TEST.test(text) ||
    IPV4_TEST.test(text) ||
    IPV6_TEST.test(text) ||
    HOSTNAME_TEST.test(text)
  );
}

/** A path is unambiguous (it has a directory separator). Mirrors :262-265. */
function containsPath(text: unknown): boolean {
  if (typeof text !== 'string' || text === '') return false;
  return PATH_TEST.test(text);
}

// WARDEN-1258 — the operational-metrics shape check (a local mirror of the
// canonical schema's isOperationalMetricsShape, kept local for the same reason
// isValidBaseEvent itself is: this validator is the transparency panel's OWN
// proof, a strict superset of the wire shape check).
const OPERATION_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_METRIC_OPERATIONS = 129;

function isValidOperationalMetricsShape(e: Record<string, unknown>): boolean {
  const finiteNonNegative = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (!Number.isInteger(e.rejected) || (e.rejected as number) < 0) return false;
  if (!finiteNonNegative(e.windowStartedAt) || !finiteNonNegative(e.windowEndedAt)) return false;
  if (!Array.isArray(e.boundaries) || e.boundaries.length === 0) return false;
  for (let i = 0; i < e.boundaries.length; i += 1) {
    const b = e.boundaries[i];
    if (!finiteNonNegative(b) || b === 0) return false;
    if (i > 0 && b <= (e.boundaries as number[])[i - 1]) return false;
  }
  if (!Array.isArray(e.operations) || e.operations.length > MAX_METRIC_OPERATIONS) return false;
  for (const op of e.operations) {
    if (!op || typeof op !== 'object') return false;
    const o = op as Record<string, unknown>;
    if (typeof o.operation !== 'string' || !OPERATION_NAME_RE.test(o.operation)) return false;
    if (!finiteNonNegative(o.min) || !finiteNonNegative(o.avg) || !finiteNonNegative(o.max)) return false;
    if (!Number.isInteger(o.count) || !Number.isInteger(o.okCount) || !Number.isInteger(o.failCount)) return false;
    if (!Array.isArray(o.buckets) || o.buckets.length !== e.boundaries.length + 1) return false;
    for (const b of o.buckets) {
      if (!Number.isInteger(b) || (b as number) < 0) return false;
    }
  }
  return true;
}

// WARDEN-1278 — the server-stall shape check (a local mirror of the canonical
// schema's isServerStallShape, kept local for the same reason isValidBaseEvent
// itself is: this validator is the transparency panel's OWN proof, a strict
// superset of the wire shape check).
const CULPRIT_NAME_RE = OPERATION_NAME_RE;
const MAX_STALL_CULPRITS = 65;

function isValidServerStallShape(e: Record<string, unknown>): boolean {
  const finiteNonNegative = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (e.runtime !== 'server') return false;
  if (!finiteNonNegative(e.windowStartedAt) || !finiteNonNegative(e.windowEndedAt)) return false;
  if (!Number.isInteger(e.count) || (e.count as number) < 0) return false;
  if (!finiteNonNegative(e.totalMs) || !finiteNonNegative(e.maxMs)) return false;
  if (!Array.isArray(e.boundaries) || e.boundaries.length === 0) return false;
  for (let i = 0; i < e.boundaries.length; i += 1) {
    const b = e.boundaries[i];
    if (!finiteNonNegative(b) || b === 0) return false;
    if (i > 0 && b <= (e.boundaries as number[])[i - 1]) return false;
  }
  if (!Array.isArray(e.buckets) || e.buckets.length !== e.boundaries.length + 1) return false;
  for (const b of e.buckets) {
    if (!Number.isInteger(b) || (b as number) < 0) return false;
  }
  if (!Array.isArray(e.culprits) || e.culprits.length > MAX_STALL_CULPRITS) return false;
  for (const c of e.culprits) {
    if (!c || typeof c !== 'object') return false;
    const o = c as Record<string, unknown>;
    if (typeof o.culprit !== 'string' || !CULPRIT_NAME_RE.test(o.culprit)) return false;
    if (!Number.isInteger(o.count) || (o.count as number) < 0) return false;
    if (!finiteNonNegative(o.totalOverlapMs)) return false;
  }
  return true;
}

/**
 * Base-event schema conformance — a LOCAL copy mirroring the
 * `validateBaseEvent` proof shape from telemetry-source.cjs:212-244. Returns
 * true iff the event is structurally a valid base-tier event AND its free-text
 * message / structured frame fields carry no leaked identifier (the hard-
 * exclusion proof). Exported so a caller (and the test) can re-run the exact
 * proof the pipeline's consent gate relies on.
 *
 * WARDEN-1254 boundary: the CONTRACT values it checks against (SCHEMA_VERSION,
 * the event-type list, the runtime values) now come from canonical `./schema`,
 * but this validator itself is deliberately NOT collapsed onto schema.ts's
 * `validateBaseEvent` — the local one is a strict SUPERSET that adds the hard
 * identifier/path exclusion after the shape check. Merging them would silently
 * drop that guarantee.
 */
export function isValidBaseEvent(event: unknown): boolean {
  if (!event || typeof event !== 'object') return false;
  const e = event as Record<string, unknown>;
  if (e.schemaVersion !== SCHEMA_VERSION) return false;
  if (!isBaseEventType(e.type)) return false;
  if (!isRuntime(e.runtime)) return false;
  if (typeof e.timestamp !== 'number' || !Number.isFinite(e.timestamp)) return false;
  if (e.type === 'error') {
    if (typeof e.message !== 'string') return false;
    if (typeof e.name !== 'string') return false;
    if (!Array.isArray(e.frames)) return false;
  } else if (e.type === 'crash') {
    if (typeof e.reason !== 'string') return false;
  } else if (e.type === 'performance-stall') {
    if (typeof e.lagMs !== 'number') return false;
    if (e.source !== 'event-loop' && e.source !== 'unresponsive') return false;
  } else if (e.type === 'operational-metrics') {
    // WARDEN-1258 — the aggregate event: shape-check per the canonical schema
    // PLUS this module's hard-exclusion proof extended to the ONLY string the
    // type carries — the operation names must be kebab-case literals, so a
    // path/hostname can never ride the aggregate key.
    if (!isValidOperationalMetricsShape(e)) return false;
    for (const op of e.operations as unknown[]) {
      if (containsIdentifier(String((op as Record<string, unknown>).operation))) return false;
    }
  } else if (e.type === 'server-stall') {
    // WARDEN-1278 — the backend child's folded stall window: shape-check per the
    // canonical schema PLUS this module's hard-exclusion proof extended to the
    // ONLY string the type carries — the culprit keys must be kebab-case
    // literals, so a route path, an agent name or a hostname can never ride the
    // attribution axis.
    if (!isValidServerStallShape(e)) return false;
    for (const c of e.culprits as unknown[]) {
      if (containsIdentifier(String((c as Record<string, unknown>).culprit))) return false;
    }
  }
  // Hard-exclusion proof: the redacted message must be free of any identifier;
  // structured frame fields must be free of paths (a bare filename basename is
  // allowed — only PATHS are a hard exclusion).
  if (e.message != null && containsIdentifier(e.message)) return false;
  if (Array.isArray(e.frames)) {
    for (const f of e.frames) {
      if (!f || typeof f !== 'object') return false;
      const frame = f as Record<string, unknown>;
      if (frame.function != null && containsPath(frame.function)) return false;
      if (frame.file != null && containsPath(frame.file)) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// describeCollection — the machine-readable "what consent promised" reference.
// ---------------------------------------------------------------------------

/** A base-event type and the anonymous fields it carries when collected. */
export interface EventTypeCollection {
  /** One of {@link BASE_EVENT_TYPES}. */
  readonly type: string;
  /** Anonymous structural fields this event type carries (never content / names). */
  readonly fields: readonly string[];
}

/** What ONE consent category means, and whether the user has it on. */
export interface CategoryCollection {
  /** The category's stable id (registry order is preserved). */
  readonly id: TelemetryCategory;
  /** Settings label for the category. */
  readonly label: string;
  /** Honest one-sentence description of what this category collects. */
  readonly summary: string;
  /** `'collecting'` (produces events) or `'decorating'` (only adds fields). */
  readonly role: 'collecting' | 'decorating';
  /** Whether the user currently has this category enabled. */
  readonly enabled: boolean;
  /** Event types this category produces + their anonymous fields (may be empty). */
  readonly eventTypes: readonly EventTypeCollection[];
  /** Payload field names this category retains when enabled (may be empty). */
  readonly fields: readonly string[];
  /**
   * True when this category is ENABLED but contributes nothing, because it only
   * decorates events and no collecting category is on. The honest reading of
   * "names on, incidents off": the switch is on and it still sends nothing.
   */
  readonly inert: boolean;
}

/** A deterministic catalog of exactly what a consent STATE collects. */
export interface ConsentCollection {
  /** The normalized consent state this catalog describes. */
  readonly consent: TelemetryConsent;
  /** Every category, in registry order, with its enabled/inert state. */
  readonly categories: readonly CategoryCollection[];
  /** The enabled category ids, in registry order. */
  readonly enabled: readonly TelemetryCategory[];
  /** Whether ANY event is produced (true iff a COLLECTING category is on). */
  readonly collectsAnything: boolean;
  /** The base-event types actually collected under this consent state. */
  readonly eventTypes: readonly EventTypeCollection[];
  /** Payload field names retained under this consent state (beyond the anonymous ones). */
  readonly retainedFields: readonly string[];
  /** Content/prompt field names HARD-EXCLUDED always — no category can enable them. */
  readonly hardExcludedContent: readonly string[];
}

/**
 * A deterministic, structured catalog of EXACTLY what `consent` collects: every
 * category with its enabled state, the event types actually produced, and the
 * fields actually retained. Content/prompt fields are listed as hard-excluded
 * always (derived from `CONTENT_FIELDS`).
 *
 * Truthful for EVERY combination, including ones the old tier could not express:
 *  - nothing on            → collectsAnything false, no event types, no fields.
 *  - incidents on          → the three anonymous event types, no identifiers.
 *  - names on, nothing else→ collectsAnything false and the `names` category is
 *                            flagged `inert` — enabled, but there is no event for
 *                            a name to ride on, so nothing is sent.
 *  - incidents + names     → the three event types, plus the name fields.
 *
 * A missing / malformed / unrecognized consent value normalizes to nothing
 * enabled, so the catalog is the most-redacted one. Pure: the same consent state
 * always returns an equal catalog.
 */
export function describeCollection(consent: unknown): ConsentCollection {
  const resolved = normalizeConsent(consent);
  const collects = collectsEvents(resolved);
  const categories: CategoryCollection[] = TELEMETRY_CATEGORIES.map((c) => {
    const enabled = resolved[c.id] === true;
    return {
      id: c.id,
      label: c.label,
      summary: c.summary,
      role: c.role,
      enabled,
      eventTypes: c.eventTypes.map((type) => ({
        type,
        fields: (BASE_EVENT_FIELDS[type] ?? []).slice(),
      })),
      fields: c.gatedFields.slice(),
      inert: enabled && c.role === 'decorating' && !collects,
    };
  });
  const eventTypes: EventTypeCollection[] = [];
  const retained: string[] = [];
  for (const c of categories) {
    if (!c.enabled) continue;
    for (const et of c.eventTypes) {
      if (!eventTypes.some((e) => e.type === et.type)) eventTypes.push(et);
    }
    // A decorating category retains nothing while nothing is collected — with no
    // event, there is no field to retain. Reporting its fields anyway would be
    // the exact "the toggle looks wired" lie this surface exists to prevent.
    if (c.role === 'decorating' && !collects) continue;
    for (const f of c.fields) if (!retained.includes(f)) retained.push(f);
  }
  return {
    consent: resolved,
    categories,
    enabled: enabledCategories(resolved),
    collectsAnything: collects,
    eventTypes,
    retainedFields: retained,
    hardExcludedContent: Array.from(CONTENT_FIELDS),
  };
}

// ---------------------------------------------------------------------------
// previewPayload — the EXACT redacted + validated payload for a candidate event.
// ---------------------------------------------------------------------------

/** The kind of transformation redaction applied at a field. */
export type ChangeKind =
  | 'dropped-content' // a content/prompt field, dropped wholesale (always)
  | 'dropped-identifier' // a category-gated field, dropped (its category is off)
  | 'retained-identifier' // a category-gated field, kept (its category is on)
  | 'redacted'; // a string value had one+ [REDACTED:…] substitutions inserted

/** A single enumerated change redaction made to the candidate event. */
export interface PreviewChange {
  readonly kind: ChangeKind;
  /** Dotted path to the field (e.g. `error.message`, `frames[0].file`, `content`). */
  readonly path: string;
  /** For `kind === 'redacted'`: the placeholder category inserted (`path`/`host`/`secret`/…). */
  readonly category?: string;
  /** For `kind === 'redacted'`: how many substitutions of `category` were made at this path. */
  readonly count?: number;
  /** For a dropped/retained gated field: the CONSENT category that gates it. */
  readonly gate?: TelemetryCategory;
}

/** The result of previewing a candidate event through the redaction + validity pipeline. */
export interface PreviewResult {
  /** The normalized consent state used for this preview. */
  readonly consent: TelemetryConsent;
  /** `redact(rawEvent, { consent })` — the EXACT post-redaction, pre-transport output. */
  readonly payload: unknown;
  /** Whether `payload` conforms to the base-event schema (the local isValidBaseEvent proof). */
  readonly valid: boolean;
  /**
   * Whether this payload would actually be SENT. A schema-valid payload is still
   * transmitted only when a COLLECTING category is on — so a names-only consent
   * previews as "valid, but nothing is sent", which is the truth.
   */
  readonly transmitted: boolean;
  /** Enumerated diff of what redaction did (dropped fields + [REDACTED:…] substitutions). */
  readonly changes: readonly PreviewChange[];
}

// Matches every `[REDACTED:<category>]` placeholder redact() emits, capturing the
// category. Global (stateful lastIndex) — always reset before scanning.
const PLACEHOLDER_RE = /\[REDACTED:([^\]]+)\]/g;

/** Tallies each [REDACTED:category] placeholder in a redacted string. */
function placeholderCategories(redactedStr: string): Map<string, number> {
  const counts = new Map<string, number>();
  PLACEHOLDER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PLACEHOLDER_RE.exec(redactedStr)) !== null) {
    const category = m[1];
    counts.set(category, (counts.get(category) || 0) + 1);
  }
  return counts;
}

/**
 * Walks the RAW candidate + the redacted payload in lockstep by field path,
 * recording every change redaction made. This is a faithful ENUMERATED DIFF of
 * redact()'s behavior — it does NOT re-implement the redaction rules; it
 * compares each raw value against the value redact() actually produced.
 */
function collectChanges(
  raw: unknown,
  redactedValue: unknown,
  consent: TelemetryConsent,
  path: string,
  out: PreviewChange[],
): void {
  if (raw === null || raw === undefined) return;

  // Leaf string: record any [REDACTED:…] substitutions redact() inserted.
  if (typeof raw === 'string') {
    if (typeof redactedValue === 'string' && raw !== redactedValue) {
      for (const [category, count] of placeholderCategories(redactedValue)) {
        out.push({ kind: 'redacted', path, category, count });
      }
    }
    return;
  }

  // Array: recurse element-by-element so the path stays accurate + stable.
  if (Array.isArray(raw)) {
    if (!Array.isArray(redactedValue)) return;
    for (let i = 0; i < raw.length; i++) {
      collectChanges(raw[i], redactedValue[i], consent, `${path}[${i}]`, out);
    }
    return;
  }

  // Object: classify each key the same way redact()'s scrubValue does, then
  // recurse into retained values. Content keys are dropped always; a
  // category-gated key is dropped or retained by ITS category's consent — the
  // same GATED_FIELD_CATEGORY lookup the redactor performs, so a new category's
  // fields are enumerated here without this function changing.
  if (typeof raw === 'object') {
    if (!redactedValue || typeof redactedValue !== 'object') return;
    const red = redactedValue as Record<string, unknown>;
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const key = String(k);
      const lower = key.toLowerCase();
      const childPath = path ? `${path}.${key}` : key;
      if (CONTENT_FIELDS.has(lower)) {
        out.push({ kind: 'dropped-content', path: childPath });
        continue;
      }
      const gate = GATED_FIELD_CATEGORY.get(lower);
      if (gate !== undefined) {
        if (consent[gate] === true) {
          out.push({ kind: 'retained-identifier', path: childPath, gate });
          // Kept, but still scrubbed for embedded secrets — surface those too.
          collectChanges(v, red[key], consent, childPath, out);
        } else {
          out.push({ kind: 'dropped-identifier', path: childPath, gate });
        }
        continue;
      }
      collectChanges(v, red[key], consent, childPath, out);
    }
  }
  // number / boolean / bigint / function — redact() passes these through; no
  // change to enumerate.
}

/**
 * Previews the EXACT redacted + validated payload the pipeline would transmit for
 * `rawEvent` under `consent`:
 *  - `payload`     = `redact(rawEvent, { consent })` — the exact post-redaction,
 *    pre-transport output (a fresh copy; the input is untouched).
 *  - `valid`       = whether `payload` conforms to the base-event schema (the
 *    local isValidBaseEvent proof, mirroring telemetry-source.cjs).
 *  - `transmitted` = whether the pipeline would actually send it (a COLLECTING
 *    category must be on). A decorating-only consent previews as valid but not
 *    transmitted — the honest answer, not a comforting one.
 *  - `changes`     = an enumerated diff of what redaction did: dropped
 *    content/prompt fields, dropped/retained category-gated fields (each tagged
 *    with the category that gates it), and each [REDACTED:…] substitution.
 *
 * Pure + non-mutating (mirrors redact's defensive-copy guarantee).
 */
export function previewPayload(rawEvent: unknown, consent: unknown): PreviewResult {
  const resolved = normalizeConsent(consent);
  const payload = redact(rawEvent, { consent: resolved });
  const changes: PreviewChange[] = [];
  collectChanges(rawEvent, payload, resolved, '', changes);
  const valid = isValidBaseEvent(payload);
  return {
    consent: resolved,
    payload,
    valid,
    transmitted: valid && collectsEvents(resolved),
    changes,
  };
}
