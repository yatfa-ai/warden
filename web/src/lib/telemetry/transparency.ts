// Telemetry VERIFIABILITY engine — slice 6 of roadmap WARDEN-446 (INFINITE:
// "warden-telemetry-client-optional-off-by-default") / design WARDEN-443.
//
// PURPOSE — make the redaction guarantee INSPECTABLE. This is the roadmap's
// literal success measure: "trust made verifiable — a user who opts in can
// confirm, by inspecting what the client actually transmits, that it matches
// exactly what consent described." `describeCollection` catalogs exactly what
// each consent tier collects; `previewPayload` shows the EXACT redacted +
// validated payload the pipeline would transmit for any candidate event. Today
// verifiability has zero coverage — this slice closes that gap. (Revocability
// is covered in-flight by slice 3, WARDEN-461; verifiability is this slice.)
//
// PURE + ZERO-RUNTIME-DEPENDENCY beyond `./redact`. The ONLY runtime import is
// `./redact` (the shipped slice-2 redactor + its field-name sets); `ConsentTier`
// arrives via `import type` and is erased by the Vite OXC transform, so — exactly
// like redact.ts — the emitted module loads standalone under `node --test` once
// its single `./redact` sibling is resolvable. See web/telemetry-transparency
// .test.mjs, which mirrors the OXC-transform harness but transforms BOTH files
// into the same tmpDir so the relative `./redact` resolves.
//
// NOT a Settings UI (slice 1, WARDEN-457, owns that surface) and NOT transport
// (slice 3) or pipeline assembly (slice 5). This module only READS `redact` and
// the base-event contract; it changes no invariant and relaxes no gate.

import type { ConsentTier } from './redact';
import { redact, CONTENT_FIELDS, IDENTIFIER_FIELDS } from './redact';

// ---------------------------------------------------------------------------
// LOCAL base-event contract (decision B — do NOT import electron/telemetry-source
// .cjs; it is a main-process CommonJS module unreachable from a renderer/TS
// module and from the standalone OXC test). This is the same "carry a local
// contract copy, to be reconciled with slice 1's canonical schema when it
// lands" pattern slice 4 (telemetry-source.cjs:32-41) itself uses. The contract
// is inlined here verbatim from telemetry-source.cjs:37-41 + :153-197 + :212-265.
// ---------------------------------------------------------------------------

/** Shared cross-repo schema version (client + receiver agree on a version). */
export const SCHEMA_VERSION = 3 as const;

/** The three anonymous base-event types a consent-gated client may emit. */
export const BASE_EVENT_TYPES: ReadonlyArray<string> = Object.freeze([
  'error',
  'crash',
  'performance-stall',
]);

const RUNTIME_VALUES: ReadonlySet<string> = new Set(['main', 'renderer']);

/**
 * The anonymous structural fields each base-event type carries (verbatim from
 * the builders in telemetry-source.cjs:153-197 + the appVersion attach at
 * :182-184 + the platform attach at :195-197). These are the fields
 * `describeCollection` advertises per type — none are content and none are
 * chat/session identifiers, so they are collected at every collecting tier.
 * `exitCode?` is conditional (present only when the crash reports one).
 * `appVersion?` and `platform?` are OPTIONAL (a source that cannot read the
 * value omits the field; a v3 event without it still validates) — and unlike
 * the other fields they are NOT strictly anonymous event data: `appVersion?`
 * is a non-identifying app RELEASE LABEL identical for every user on a release,
 * and `platform?` is a non-identifying OS LABEL (darwin/win32/linux) identical
 * for millions of users on an OS. Both are carried so a maintainer can attribute
 * event volume to a release / OS. They are disclosed here precisely BECAUSE the
 * panel's contract is to list every field a tier collects — omitting a newly-
 * collected field would be a lie of omission even when (as here) the data is
 * benign. See schema.ts:84-97.
 */
const BASE_EVENT_FIELDS: Record<string, readonly string[]> = {
  error: ['schemaVersion', 'type', 'runtime', 'timestamp', 'appVersion?', 'platform?', 'name', 'message', 'frames'],
  crash: ['schemaVersion', 'type', 'runtime', 'timestamp', 'appVersion?', 'platform?', 'reason', 'exitCode?'],
  'performance-stall': ['schemaVersion', 'type', 'runtime', 'timestamp', 'appVersion?', 'platform?', 'lagMs', 'source'],
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

/**
 * Base-event schema conformance — a LOCAL copy mirroring the
 * `validateBaseEvent` proof shape from telemetry-source.cjs:212-244. Returns
 * true iff the event is structurally a valid base-tier event AND its free-text
 * message / structured frame fields carry no leaked identifier (the hard-
 * exclusion proof). Exported so a caller (and the test) can re-run the exact
 * proof the pipeline's consent gate relies on.
 */
export function isValidBaseEvent(event: unknown): boolean {
  if (!event || typeof event !== 'object') return false;
  const e = event as Record<string, unknown>;
  if (e.schemaVersion !== SCHEMA_VERSION) return false;
  if (typeof e.type !== 'string' || !BASE_EVENT_TYPES.includes(e.type)) return false;
  if (!RUNTIME_VALUES.has(e.runtime as string)) return false;
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

/** A deterministic catalog of exactly what a consent tier collects. */
export interface TierCollection {
  /** The tier this catalog describes. */
  readonly tier: ConsentTier;
  /** Whether ANY base events are collected (true only for `'base'` / `'extended'`). */
  readonly collectsBaseEvents: boolean;
  /** Whether chat/session-name identifiers are collected (true only for `'extended'`). */
  readonly collectsIdentifiers: boolean;
  /** The anonymous base-event types + their fields (empty unless base events are collected). */
  readonly eventTypes: readonly EventTypeCollection[];
  /** Chat/session-name identifier field names collected at this tier (empty unless `'extended'`). */
  readonly identifierFields: readonly string[];
  /** Content/prompt field names that are HARD-EXCLUDED at every tier (never collected). */
  readonly hardExcludedContent: readonly string[];
}

/** A tier collects anonymous base events iff it is `'base'` or `'extended'`. */
function tierCollectsBaseEvents(tier: unknown): boolean {
  return tier === 'base' || tier === 'extended';
}

/**
 * A deterministic, structured catalog of EXACTLY what is collected at `tier`:
 * each base-event type with its anonymous fields, PLUS (at `'extended'` only) the
 * chat/session-name identifier fields. Content/prompt fields are listed as
 * hard-excluded at every tier (derived from `CONTENT_FIELDS`). Any unrecognized
 * / `'off'` / undefined tier yields the most-redacted catalog (nothing
 * collected). Pure: the same tier always returns an equal catalog.
 */
export function describeCollection(tier: ConsentTier): TierCollection {
  const collectsBase = tierCollectsBaseEvents(tier);
  const collectsNames = tier === 'extended';
  return {
    tier,
    collectsBaseEvents: collectsBase,
    collectsIdentifiers: collectsNames,
    eventTypes: collectsBase
      ? BASE_EVENT_TYPES.map((type) => ({ type, fields: BASE_EVENT_FIELDS[type].slice() }))
      : [],
    identifierFields: collectsNames ? Array.from(IDENTIFIER_FIELDS) : [],
    hardExcludedContent: Array.from(CONTENT_FIELDS),
  };
}

// ---------------------------------------------------------------------------
// previewPayload — the EXACT redacted + validated payload for a candidate event.
// ---------------------------------------------------------------------------

/** The kind of transformation redaction applied at a field. */
export type ChangeKind =
  | 'dropped-content' // a content/prompt field, dropped wholesale (every tier)
  | 'dropped-identifier' // a chat/session-name, dropped (base / off / unknown)
  | 'retained-identifier' // a chat/session-name, kept (extended only)
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
}

/** The result of previewing a candidate event through the redaction + validity pipeline. */
export interface PreviewResult {
  /** The tier used for this preview. */
  readonly tier: ConsentTier;
  /** `redact(rawEvent, { tier })` — the EXACT post-redaction, pre-transport output. */
  readonly payload: unknown;
  /** Whether `payload` conforms to the base-event schema (the local isValidBaseEvent proof). */
  readonly valid: boolean;
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
  tier: ConsentTier,
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
      collectChanges(raw[i], redactedValue[i], tier, `${path}[${i}]`, out);
    }
    return;
  }

  // Object: classify each key the same way redact()'s scrubValue does, then
  // recurse into retained values. Content keys are dropped at every tier;
  // identifier keys are dropped (base/off/unknown) or retained (extended).
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
      if (IDENTIFIER_FIELDS.has(lower)) {
        if (tier === 'extended') {
          out.push({ kind: 'retained-identifier', path: childPath });
          // Kept, but still scrubbed for embedded secrets — surface those too.
          collectChanges(v, red[key], tier, childPath, out);
        } else {
          out.push({ kind: 'dropped-identifier', path: childPath });
        }
        continue;
      }
      collectChanges(v, red[key], tier, childPath, out);
    }
  }
  // number / boolean / bigint / function — redact() passes these through; no
  // change to enumerate.
}

/**
 * Previews the EXACT redacted + validated payload the pipeline would transmit for
 * `rawEvent` at `tier`:
 *  - `payload` = `redact(rawEvent, { tier })` (redact.ts:127) — the exact
 *    post-redaction, pre-transport output (a fresh copy; the input is untouched).
 *  - `valid`   = whether `payload` conforms to the base-event schema (the local
 *    isValidBaseEvent proof, mirroring telemetry-source.cjs:212-244).
 *  - `changes` = an enumerated diff of what redaction did: dropped content/prompt
 *    fields, dropped/retained identifier fields, and each [REDACTED:…]
 *    substitution.
 *
 * Pure + non-mutating (mirrors redact's defensive-copy guarantee, redact.ts:268).
 */
export function previewPayload(rawEvent: unknown, tier: ConsentTier): PreviewResult {
  const payload = redact(rawEvent, { tier });
  const changes: PreviewChange[] = [];
  collectChanges(rawEvent, payload, tier, '', changes);
  return {
    tier,
    payload,
    valid: isValidBaseEvent(payload),
    changes,
  };
}
