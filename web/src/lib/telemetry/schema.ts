// Telemetry event schema — the AUTHORITATIVE, versioned, cross-repo contract
// for warden's optional, OFF-by-default telemetry (slice 1 of roadmap WARDEN-446,
// design WARDEN-443). Client and receiver agree on a `schemaVersion`; a bump is a
// coordinated change across both repos (the client lives here in `warden`, the
// receiver lives in a SEPARATE repo, `warden-telemetry`). Schema drift across
// repos is this roadmap's chief risk, so the schema is the thing pinned here.
//
// THIS MODULE IS THE CANONICAL HOME. Two later slices already shipped against
// this same contract (design source WARDEN-443) and carry a "reconcile with
// WARDEN-457 when it ships" note:
//   • electron/telemetry-source.cjs (WARDEN-463, slice 4 — the main/renderer
//     instrumentation source) inlines SCHEMA_VERSION / BASE_EVENT_TYPES / RUNTIME
//     / validateBaseEvent + the base-tier event builders.
//   • web/src/lib/telemetry/redact.ts (WARDEN-459, slice 2 — the pre-collection
//     redaction engine) inlines the ConsentTier model + the extended-tier
//     identifier field names (chat / session names).
// The constants, event-type list, runtimes, field shapes, and validate()
// semantics below MATCH those inlined copies exactly, so this module reconciles
// them into one shareable source. (Consolidating slice 4's CJS copy to import
// this ESM module is a follow-up — it crosses the electron/web CJS↔ESM boundary
// with no existing pattern and is out of scope for this slice.)
//
// ZERO-DEPENDENCY + RUNTIME-IMPORT-FREE. The only imports here are `import type`
// (erased by the Vite OXC transform), so the emitted module loads STANDALONE
// under `node --test` — see web/telemetry-schema.test.mjs — and, critically, the
// file is structured to be IMPORTED/SHARED VERBATIM by the separate
// `warden-telemetry` receiver repo (plain TS/JS, no warden-app-specific imports).
// Do NOT add a runtime import, a runtime-validation library (no zod), or a
// warden-app dependency here.

// ---------------------------------------------------------------------------
// Two-tier consent model (verbatim from WARDEN-443 "Consent model")
// ---------------------------------------------------------------------------
// Both tiers are OFF by default; each is revocable anytime; NOTHING leaves the
// machine until the BASE tier is explicitly turned on in Settings.
//   • base      — anonymous error / crash / performance-stall events only. No
//                 identifiers, no content, no paths, no hostnames (the base-tier
//                 field set below carries none of these BY DESIGN).
//   • extended  — gated behind base; ADDITIONALLY retains chat name + Claude
//                 session name. CONTENT IS NEVER SENT — names only.
//   • off       — telemetry disabled (the default).
// An unrecognized / undefined value is treated as `off`, so a missing or corrupt
// consent value can never accidentally enable telemetry.
// ---------------------------------------------------------------------------
export type ConsentTier = 'base' | 'extended' | 'off';

/** Resolve a raw consent value to a known tier, defaulting to `off` (most-safe). */
export function resolveConsentTier(value: unknown): ConsentTier {
  return value === 'base' || value === 'extended' ? value : 'off';
}

// ---------------------------------------------------------------------------
// The schema version. Bumping this is a coordinated client + receiver change.
// ---------------------------------------------------------------------------
// v4 (WARDEN-687): relaxed `CrashEvent.runtime` from the literal `'renderer'`
// to the full `Runtime` so a main-process hard kill (native segfault / OOM-kill
// / SIGKILL / power loss / abrupt process.exit) — invisible to the main-process
// uncaughtExceptionMonitor, which only intercepts JS exceptions — can be turned
// into a normal base-tier crash event by a next-launch sentinel. The `runtime`
// field was already a non-identifying enum, and the main-crash `reason` is a
// synthetic non-identifying string, so this is a shape relaxation, not new data
// collection. Client + receiver bump together so the x-telemetry-schema
// handshake (the receiver's ingest.mjs) does not 415.
export const SCHEMA_VERSION = 4;

// The base-tier event kinds. A discriminated union (below) keys off `type`.
export const BASE_EVENT_TYPES = Object.freeze(['error', 'crash', 'performance-stall'] as const);
export type BaseEventType = (typeof BASE_EVENT_TYPES)[number];

// Which process an event originated in. `main` = the Electron/Node main process;
// `renderer` = a web-contents (browser) process. Error events may be either;
// crash events may be either (a render-process-gone is `renderer`; a main-process
// hard kill detected on next launch by the crash sentinel (WARDEN-687) is `main`);
// stalls may be either.
export const RUNTIME = Object.freeze({ MAIN: 'main', RENDERER: 'renderer' } as const);
export type Runtime = (typeof RUNTIME)[keyof typeof RUNTIME];

/** A structured stack frame. The directory (user/home/host) is dropped at the
 *  collection boundary (slice 4 keeps only the basename); `function`/`file`/line
 *  are NON-identifying for warden's own code. All fields optional — frames are
 *  best-effort parsed from heterogeneous stack formats. */
export interface StackFrame {
  function?: string;
  file?: string;
  line?: number;
  column?: number;
}

// ---------------------------------------------------------------------------
// Base-tier events — the anonymous payload. No content, no paths, no hostnames,
// no identifiers BY DESIGN (the guardrail: "ensure the schema's base tier carries
// no such fields by design"). Free-text `message` is redacted at the collection
// boundary (slice 4) before an event ever reaches this contract.
//
// `appVersion` (WARDEN-665) and `platform` (WARDEN-684) are the ONLY base-tier
// fields that are not strictly anonymous event data: each is a non-identifying
// LABEL identical across many users. `appVersion` is the app RELEASE LABEL (e.g.
// '0.1.19'), identical for every user on a release; `platform` is the OS label
// (one of `darwin` / `win32` / `linux`, from `process.platform`), identical for
// millions of users on an OS. Both are carried so a maintainer can attribute
// event volume to a release / OS instead of staring at un-attributable volume.
// Neither is an identifier (no user/device/session tie-break) and neither is
// content — both sit within the base tier, not behind extended consent. Both are
// OPTIONAL: a source that cannot read the value omits the field, and a v3 event
// without either still validates (graceful for that source). Redaction is a
// no-op for both (fixed/coarse labels) — neither appears in any redaction
// allowlist; base-tier labels pass through untouched.
// ---------------------------------------------------------------------------

/** An uncaught error / unhandled rejection (main or renderer). */
export interface ErrorEvent {
  schemaVersion: typeof SCHEMA_VERSION;
  type: 'error';
  runtime: Runtime;
  timestamp: number; // epoch-ms
  appVersion?: string; // non-identifying release label (e.g. '0.1.19'); optional
  platform?: string; // non-identifying OS label (darwin/win32/linux); optional
  name: string; // e.g. 'TypeError' (Error#name); never identifying
  message: string; // redacted free text — no paths/hostnames/secrets survive
  frames: StackFrame[]; // structured, path-stripped stack frames
}

/** A process crash. `runtime` is `renderer` for a render-process-gone (Electron's
 *  fixed-enum `reason`: oom, crashed, killed, …) or `main` for a main-process
 *  hard kill detected on the NEXT launch by the crash sentinel (WARDEN-687),
 *  whose `reason` is the synthetic non-identifying string `'unexpected-termination'`.
 *  Either runtime is a non-identifying label; no new identifying field is added. */
export interface CrashEvent {
  schemaVersion: typeof SCHEMA_VERSION;
  type: 'crash';
  runtime: Runtime;
  timestamp: number;
  appVersion?: string; // non-identifying release label (e.g. '0.1.19'); optional
  platform?: string; // non-identifying OS label (darwin/win32/linux); optional
  reason: string; // Electron's fixed enum (oom, crashed, killed, …) — not identifying
  exitCode?: number;
}

/** An event-loop freeze / unresponsive hang. */
export interface StallEvent {
  schemaVersion: typeof SCHEMA_VERSION;
  type: 'performance-stall';
  runtime: Runtime;
  timestamp: number;
  appVersion?: string; // non-identifying release label (e.g. '0.1.19'); optional
  platform?: string; // non-identifying OS label (darwin/win32/linux); optional
  lagMs: number; // how far the tick was overdue (≥0)
  source: 'event-loop' | 'unresponsive';
}

/** Any base-tier event, discriminated by `type`. */
export type BaseEvent = ErrorEvent | CrashEvent | StallEvent;

// ---------------------------------------------------------------------------
// Extended tier — base + chat / session NAMES (gated behind base consent).
// CONTENT IS NEVER SENT; names only. These are the ONLY identifiers ever
// retained, and ONLY when the effective consent tier is `extended` (slice 2's
// redactor drops them at base/off). Field names match slice 2's IDENTIFIER_FIELDS
// (`chatName` / `sessionName`) so the redactor recognizes them by name.
// ---------------------------------------------------------------------------
export interface ExtendedFields {
  chatName?: string;
  sessionName?: string;
}

/** An event carrying the extended-tier identifier fields. The base-tier
 *  discriminated union is unchanged; extended just ADDS optional names. */
export type ExtendedEvent = BaseEvent & Partial<ExtendedFields>;

/** Any event the pipeline can carry, at any tier. */
export type TelemetryEvent = ExtendedEvent;

// ---------------------------------------------------------------------------
// Runtime shape validation. Pure, stateless, zero-dep — no regex `/g` lastIndex
// to manage (every literal here is a non-global `.test`/comparison). This checks
// SCHEMA SHAPE (the contract a receiver asserts), NOT redaction correctness —
// identifier-leak prevention is the redaction layer's job (slice 2 / slice 4's
// collection-boundary redact), not the schema's. Mirrors the shape checks in
// slice 4's validateBaseEvent so a slice-4-built event validates here too.
// ---------------------------------------------------------------------------

export function isRuntime(value: unknown): value is Runtime {
  return value === RUNTIME.MAIN || value === RUNTIME.RENDERER;
}

export function isBaseEventType(value: unknown): value is BaseEventType {
  return typeof value === 'string' && (BASE_EVENT_TYPES as readonly string[]).includes(value);
}

/** True iff `event` has a valid base-tier SHAPE (correct version, a known type,
 *  a valid runtime, a finite timestamp, and the type-specific fields). Does not
 *  inspect field VALUES for identifier leaks (that is redaction's concern). */
export function validateBaseEvent(event: unknown): event is BaseEvent {
  if (!event || typeof event !== 'object') return false;
  const e = event as Record<string, unknown>;
  if (e.schemaVersion !== SCHEMA_VERSION) return false;
  if (!isBaseEventType(e.type)) return false;
  if (!isRuntime(e.runtime)) return false;
  if (typeof e.timestamp !== 'number' || !Number.isFinite(e.timestamp)) return false;
  switch (e.type) {
    case 'error':
      return typeof e.name === 'string' &&
        typeof e.message === 'string' &&
        Array.isArray(e.frames);
    case 'crash':
      // WARDEN-687: a crash may be the renderer (a render-process-gone) OR the
      // main process (a hard kill detected on next launch by the crash sentinel).
      // `runtime` is already validated as a known Runtime by isRuntime above; the
      // crash-specific field is the non-identifying `reason` string.
      return typeof e.reason === 'string';
    case 'performance-stall':
      return typeof e.lagMs === 'number' &&
        (e.source === 'event-loop' || e.source === 'unresponsive');
    default:
      return false;
  }
}

/** True iff `event` is a valid base-tier event whose extended-tier fields (if
 *  present) are well-typed. Tier GATING of the extended fields (names retained
 *  only at `extended`) is enforced by consent + redaction, not by the schema — a
 *  base event may legitimately carry absent names. */
export function validateEvent(event: unknown): event is TelemetryEvent {
  if (!validateBaseEvent(event)) return false;
  const e = event as unknown as Record<string, unknown>;
  if (e.chatName !== undefined && typeof e.chatName !== 'string') return false;
  if (e.sessionName !== undefined && typeof e.sessionName !== 'string') return false;
  // appVersion (WARDEN-665) is an OPTIONAL base-tier release label — a v3 event
  // WITHOUT it still validates (a source that cannot read the version omits it).
  if (e.appVersion !== undefined && typeof e.appVersion !== 'string') return false;
  // platform (WARDEN-684) is an OPTIONAL base-tier OS label — same trust posture
  // as appVersion; a v3 event WITHOUT it still validates.
  if (e.platform !== undefined && typeof e.platform !== 'string') return false;
  return true;
}
