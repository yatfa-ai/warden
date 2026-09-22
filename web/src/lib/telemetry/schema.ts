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
//     redaction engine) owns the identifier field names (chat / session names);
//     which of them survive is decided by ./consent.ts (WARDEN-1116).
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
// CONSENT IS NOT DECLARED HERE (WARDEN-1116).
// ---------------------------------------------------------------------------
// This file used to carry the linear three-value consent tier ('base' |
// 'extended' | 'off') plus a resolver for it. Consent is now a set of
// INDEPENDENT per-category switches (WARDEN-443 Principle 2), and there is
// EXACTLY ONE authority that resolves it: `./consent.ts` (mirrored for the
// Node-side processes at src/telemetry-consent.cjs). Every gate consults that
// module; nothing re-derives consent for itself, and no second resolver lives
// here.
//
// Consent was never part of the cross-repo WIRE contract anyway — the receiver
// validates event SHAPE, not who consented to what. What follows is that wire
// contract, and it is unchanged: same SCHEMA_VERSION, same event types, same
// field shapes, same validate() semantics.
//
// Tier GATING of the optional identifier fields below is enforced by consent +
// redaction (see ./consent.ts and ./redact.ts), not by this schema — a valid
// event may legitimately carry absent names.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The schema version. Bumping this is a coordinated client + receiver change.
// ---------------------------------------------------------------------------
// v8 (WARDEN-1424): added the `workspace-shape` event type — the COUNT snapshot
// that closes the last uncovered fact in the telemetry channel's founding
// sentence (WARDEN-1265: the channel cannot answer "how many panes are open").
// ONE bounded aggregate per 5-minute window, built from the RENDERER's own
// workspace state: how many workspaces exist, how many panes are open across
// them, how many panes the ACTIVE workspace holds, how many chats the sidebar
// lists, plus the per-window peaks of the two volatile counts (peakPanesOpen /
// peakChats) so a burst of open-then-close activity is still visible in a
// window that closed on a quiet state. COUNTS ONLY, by construction: there is
// no array, no name, no title, no path and no hostname anywhere in the shape —
// every payload field is a non-negative integer, and the validator REJECTS any
// key outside the shape's own allowlist so no injected identifier can ride it
// (names ride `workspace-names` behind their own category, never here). It
// rides the EXISTING `operational-metrics` category (counts are not identifying
// data; WARDEN-443 Principle 2 untouched). Pinned to the `renderer` runtime —
// the workspace state lives in the renderer's own refs, so any other runtime
// would be a lie about where it was observed. Client + receiver bump together
// so the x-telemetry-schema handshake (the receiver's ingest.mjs) does not 415.
// v7 (WARDEN-1416): added the `workspace-names` event type — the FIRST event the
// `names` consent category PRODUCES. Until now that category could only DECORATE
// events other categories produced (chat/session names on incidents events), so
// a user who enabled names ALONE consented to something that never happened — a
// dead switch (WARDEN-443: "A category that sends nothing is not consent"). This
// type gives names its own carrying event: ONE bounded aggregate per 5-minute
// window carrying the chat catalog's names (the sidebar-rendered `.name`, which
// for a resumed Claude session IS that session's name — the fold the product
// already performs), de-duplicated and capped at the producer's NAMES_MAX, with
// `chatCount` (the TRUE catalog size) + `truncated` making the cap loud. It
// rides ONLY the names category — identifying data stays behind its own
// conscious opt-in and is never folded into a metrics category. The names
// category's role therefore flips `decorating → collecting` in consent.ts: it
// now produces this type AND still gates the decoration fields. There is no
// free-text field beyond the names themselves; every string in `chats` is a
// name the user sees in their own sidebar. Client + receiver bump together so
// the x-telemetry-schema handshake (the receiver's ingest.mjs) does not 415.
// v6 (WARDEN-1278): added the `server-stall` event type and the `server`
// RUNTIME. The backend runs as a FORKED CHILD of the Electron main process, and
// until now the wire had no runtime for it — so the heaviest worker in the app
// (SSH, tmux, config, sweeps) could emit NO event under ANY consent, by
// construction. Its event-loop stall machinery (WARDEN-977) already detects
// multi-second freezes WITH attribution, but delivered them only to local
// channels. This type folds a window of those stalls into ONE bounded
// AGGREGATE — count / totalMs / maxMs / fixed-boundary lag histogram / a
// per-CULPRIT map whose keys are constant kebab-case literals (validator-
// enforced, exactly like `operational-metrics` operation names). There is no
// free-text field, no path and no hostname anywhere in the shape: a request
// span label is mapped to a ROUTE-PATTERN key or folded to a reserved overflow
// key before it can ever become an aggregate key. It rides the EXISTING
// `incidents` category (a stall is an incident) — no new category, no new
// checkbox. Client + receiver bump together so the x-telemetry-schema handshake
// (the receiver's ingest.mjs) does not 415.
// v5 (WARDEN-1258): added the `operational-metrics` event type — the first
// usage-category event (design-article authorization of 2026-08-19). It carries
// AGGREGATES ONLY: a folded window of per-operation counts / ok-fail split /
// min-avg-max / fixed-boundary latency histogram, produced by the bounded
// aggregator (src/telemetry-metrics.cjs) and fed by the terminal linkifier's
// file-existence probe. No new identifying field, no content, no free text —
// operation names are constant kebab-case literals (validator-enforced), so
// this is a new TYPE, not new data exposure. Client + receiver bump together
// so the x-telemetry-schema handshake (the receiver's ingest.mjs) does not 415.
// v4 (WARDEN-687): relaxed `CrashEvent.runtime` from the literal `'renderer'`
// to the full `Runtime` so a main-process hard kill (native segfault / OOM-kill
// / SIGKILL / power loss / abrupt process.exit) — invisible to the main-process
// uncaughtExceptionMonitor, which only intercepts JS exceptions — can be turned
// into a normal base-tier crash event by a next-launch sentinel. The `runtime`
// field was already a non-identifying enum, and the main-crash `reason` is a
// synthetic non-identifying string, so this is a shape relaxation, not new data
// collection. Client + receiver bump together so the x-telemetry-schema
// handshake (the receiver's ingest.mjs) does not 415.
export const SCHEMA_VERSION = 8;

// The base-tier event kinds. A discriminated union (below) keys off `type`.
export const BASE_EVENT_TYPES = Object.freeze(['error', 'crash', 'performance-stall', 'operational-metrics', 'server-stall', 'workspace-names', 'workspace-shape'] as const);
export type BaseEventType = (typeof BASE_EVENT_TYPES)[number];

// Which process an event originated in. `main` = the Electron/Node main process;
// `renderer` = a web-contents (browser) process; `server` = the FORKED BACKEND
// CHILD (WARDEN-1278) — a third real OS process warden has always run and the
// wire could not name, so nothing it observed could ever be reported. Error
// events may be either; crash events may be either (a render-process-gone is
// `renderer`; a main-process hard kill detected on next launch by the crash
// sentinel (WARDEN-687) is `main`); stalls may be either.
export const RUNTIME = Object.freeze({ MAIN: 'main', RENDERER: 'renderer', SERVER: 'server' } as const);
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
// content — both ride the `incidents` category itself, behind no extra consent. Both are
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

// ---------------------------------------------------------------------------
// Operational metrics (WARDEN-1258) — the first usage-category event. AGGREGATES
// ONLY, by construction of the producer (the bounded aggregator in
// src/telemetry-metrics.cjs folds N observations into a fixed-size window and
// retains no per-observation row): counts, ok/fail split, min/avg/max, and a
// fixed-boundary latency histogram per operation. There is no free-text field
// anywhere in this event — `operation` names are CONSTANT kebab-case literals
// chosen at development time (the aggregator's caller contract), and the
// validator enforces the shape so a path/hostname can never ride one. File
// paths and hostnames remain hard exclusions at every consent category
// (WARDEN-443); nothing in this event type can carry them.
// ---------------------------------------------------------------------------

/** One folded operation aggregate — the aggregator's projected accumulator. */
export interface OperationalMetricOperation {
  /** Constant kebab-case literal identifying the operation (≤64 chars). */
  operation: string;
  /** Total observations folded into this window. */
  count: number;
  /** Observations that succeeded. */
  okCount: number;
  /** Observations that failed. */
  failCount: number;
  /** Minimum observed duration, ms. */
  min: number;
  /** Mean observed duration, ms. */
  avg: number;
  /** Maximum observed duration, ms. */
  max: number;
  /** Latency histogram: buckets.length === boundaries.length + 1 (the last is
   *  the overflow bucket for everything above the largest boundary). */
  buckets: number[];
}

/** A window of folded operational-metrics aggregates. */
export interface OperationalMetricsEvent {
  schemaVersion: typeof SCHEMA_VERSION;
  type: 'operational-metrics';
  runtime: Runtime;
  timestamp: number;
  appVersion?: string; // non-identifying release label; optional
  platform?: string; // non-identifying OS label (darwin/win32/linux); optional
  /** When the window opened (epoch-ms, from the aggregator). */
  windowStartedAt: number;
  /** When the window closed (epoch-ms, from the aggregator). */
  windowEndedAt: number;
  /** The histogram bucket boundaries the `buckets` arrays are keyed against
   *  (ascending inclusive ms upper bounds). Travels ONCE per event so every
   *  operation's histogram is interpretable on its own. */
  boundaries: number[];
  /** The folded per-operation aggregates (bounded by the aggregator's
   *  maxOperations cap + its reserved overflow key). */
  operations: OperationalMetricOperation[];
  /** Observations the aggregator REFUSED (invalid input) — a health signal. */
  rejected: number;
}

// ---------------------------------------------------------------------------
// Server stalls (WARDEN-1278) — the SERVER child's event-loop freezes, folded.
//
// The `performance-stall` type above is ONE ROW PER STALL, emitted by the main
// process. This type is its AGGREGATE counterpart for the forked backend child,
// and it is a different type for a reason that is not cosmetic: the owner's
// local journal shows the server's freezes are REPEATED (hundreds of records),
// so a per-stall row would be exactly the volume blowup the operational-metrics
// slice already refused. One window, one event.
//
// It also carries what a bare duration cannot: ATTRIBUTION. `culprits` is a
// bounded map from a CLOSED-SET key to the folded overlap of the work that was
// running across the blocked windows. The key set is closed by CONSTRUCTION at
// the producer: a request span label (`GET /api/sessions/<something>`) is mapped
// to its ROUTE PATTERN (`get:api-sessions-id`) or folded into the reserved
// overflow key BEFORE it becomes an aggregate key — so an agent name, a chat
// name or a path can never ride one. The validator enforces the same kebab-case
// pattern `operational-metrics` operation names use, which makes that a
// STRUCTURAL guarantee rather than a caller promise. There is no free-text
// field anywhere in this shape.
// ---------------------------------------------------------------------------

/** One folded culprit aggregate — how much of the blocked time this work spanned. */
export interface ServerStallCulprit {
  /** Closed-set kebab-case key (route pattern / sweep name / sync-io label / overflow). */
  culprit: string;
  /** Stalls in the window this culprit was attributed to. */
  count: number;
  /** Total overlap with the blocked windows, ms. */
  totalOverlapMs: number;
}

/** A window of folded server-child event-loop stalls. */
export interface ServerStallEvent {
  schemaVersion: typeof SCHEMA_VERSION;
  type: 'server-stall';
  /** Always `server` — the type exists precisely to report that runtime. */
  runtime: Runtime;
  timestamp: number;
  appVersion?: string; // non-identifying release label; optional
  platform?: string; // non-identifying OS label (darwin/win32/linux); optional
  /** When the window opened (epoch-ms, from the aggregator). */
  windowStartedAt: number;
  /** When the window closed (epoch-ms, from the aggregator). */
  windowEndedAt: number;
  /** How many stalls were folded into this window. */
  count: number;
  /** Summed lag of every folded stall, ms. */
  totalMs: number;
  /** The single worst lag in the window, ms — the headline freeze duration. */
  maxMs: number;
  /** Lag histogram bucket boundaries (ascending inclusive ms upper bounds). */
  boundaries: number[];
  /** Lag histogram: buckets.length === boundaries.length + 1 (last = overflow). */
  buckets: number[];
  /** Folded per-culprit attribution (bounded by the producer's key cap + overflow). */
  culprits: ServerStallCulprit[];
}

// ---------------------------------------------------------------------------
// Workspace names (WARDEN-1416) — the FIRST event the `names` category produces.
//
// The `names` category previously only DECORATED events other categories built
// (chat/session names on incidents events), so enabling it alone sent nothing —
// the dead switch WARDEN-443 names explicitly. This type is its carrying event:
// ONE bounded aggregate per 5-minute window of the chat catalog's names. The
// identity surface is exactly what the design article permits — chat names and
// (via the product's own fold of a resumed session's summary into `.name`)
// Claude session names — the strings the user sees in their own sidebar. CONTENT
// IS NEVER SENT: no raw session summary is enumerated; a session that was never
// resumed has no catalog name beyond its id, and that id-shaped string is what
// arrives (the same string the sidebar shows).
//
// BOUNDED BY CONSTRUCTION: `chats` is capped by the producer (NAMES_MAX =
// 200), de-duplicated; `chatCount` is the TRUE catalog size and `truncated`
// says whether the cap bit, so a capped list is loud, never silent. An empty
// catalog (chatCount 0) sends nothing at all — the producer's hasAnything.
//
// It rides ONLY the `names` category (its producer gates there, and main's
// receipt re-checks there): identifying data stays behind its own opt-in. The
// validator carries NO name-pattern constraint — unlike an operation or culprit
// KEY, a name is arbitrary user-chosen text BY DESIGN; the hard exclusions
// (content/paths/hosts) are enforced by the redactor, which scrubs every
// retained string, exactly as it does a decorated `chatName`.
// ---------------------------------------------------------------------------

/** A window of the chat catalog's names, bounded + honest about the cap. */
export interface WorkspaceNamesEvent {
  schemaVersion: typeof SCHEMA_VERSION;
  type: 'workspace-names';
  /** Always `server` — the chat catalog lives in the forked backend child. */
  runtime: Runtime;
  timestamp: number;
  appVersion?: string; // non-identifying release label; optional
  platform?: string; // non-identifying OS label (darwin/win32/linux); optional
  /** When the window opened (epoch-ms, from the producer). */
  windowStartedAt: number;
  /** When the window closed (epoch-ms, from the producer). */
  windowEndedAt: number;
  /** The catalog's names (de-duplicated, ≤ the producer's NAMES_MAX cap). */
  chats: string[];
  /** The TRUE number of named chats in the catalog — before any cap. */
  chatCount: number;
  /** True iff `chats.length < chatCount` (the cap bit; the list is partial). */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Workspace shape (WARDEN-1424) — the COUNT snapshot that closes the last
// uncovered fact in the telemetry channel's founding sentence (WARDEN-1265:
// "not how many panes are open").
//
// ONE bounded aggregate per 5-minute window, read from the RENDERER's own
// workspace state (its refs — nothing new is fetched, polled or retained): how
// many workspaces exist, how many panes are open across them, how many panes
// the ACTIVE workspace holds, how many chats the sidebar lists, plus the
// per-window peaks of the two volatile counts so an open-then-close burst
// inside a window that ended on a quiet state is still visible.
//
// COUNTS ONLY, BY CONSTRUCTION — the design's hard boundary for this type:
//   • no array, no name, no title, no path, no hostname anywhere in the shape;
//   • every payload field is a non-negative integer;
//   • the validator enforces a CLOSED KEY SET — any key outside the shape's own
//     fields rejects the event, so an injected `name` / `path` / `host` string
//     can never ride it even from a hostile caller.
// Chat NAMES ride `workspace-names` behind their own category — this type never
// carries them, and `chats` here is the COUNT of sidebar rows, never a list.
//
// It rides the EXISTING `operational-metrics` category: counts are not
// identifying data, so no new category and no new checkbox exists for it. It is
// PINNED to the `renderer` runtime — the workspace state lives in the
// renderer's own refs, so a `main`/`server`-runtime shape event would be a lie
// about where it was observed (the validator enforces the pin, exactly like the
// `server` pins on workspace-names/server-stall).
// ---------------------------------------------------------------------------

/** A window of the renderer's workspace-shape counts. */
export interface WorkspaceShapeEvent {
  schemaVersion: typeof SCHEMA_VERSION;
  type: 'workspace-shape';
  /** Always `renderer` — the type exists precisely to report that runtime. */
  runtime: Runtime;
  timestamp: number;
  appVersion?: string; // non-identifying release label; optional
  platform?: string; // non-identifying OS label (darwin/win32/linux); optional
  /** When the window opened (epoch-ms, from the producer). */
  windowStartedAt: number;
  /** When the window closed (epoch-ms, from the producer). */
  windowEndedAt: number;
  /** How many workspaces existed at window close. */
  workspaces: number;
  /** Panes open across ALL workspaces at window close. */
  panesOpen: number;
  /** Panes open in the ACTIVE workspace at window close. */
  panesActive: number;
  /** Chats listed in the sidebar at window close — the COUNT, never names. */
  chats: number;
  /** The window's largest observed panesOpen (open-then-close bursts stay visible). */
  peakPanesOpen: number;
  /** The window's largest observed chats count. */
  peakChats: number;
}

/** Any base-tier event, discriminated by `type`. */
export type BaseEvent = ErrorEvent | CrashEvent | StallEvent | OperationalMetricsEvent | ServerStallEvent | WorkspaceNamesEvent | WorkspaceShapeEvent;

// ---------------------------------------------------------------------------
// Optional identifier fields — chat / session NAMES. CONTENT IS NEVER SENT;
// names only. These are the ONLY identifiers ever retained, and ONLY while the
// `names` consent CATEGORY is enabled (the redactor drops them otherwise —
// WARDEN-1116). Field names match the redactor's gated-field set (`chatName` /
// `sessionName`) so it recognizes them by name.
// ---------------------------------------------------------------------------
export interface ExtendedFields {
  chatName?: string;
  sessionName?: string;
}

/** An event carrying the optional identifier fields. The base event union is
 *  unchanged; the `names` category just ADDS optional names. */
export type ExtendedEvent = BaseEvent & Partial<ExtendedFields>;

/** Any event the pipeline can carry, under any consent. */
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
  return value === RUNTIME.MAIN || value === RUNTIME.RENDERER || value === RUNTIME.SERVER;
}

export function isBaseEventType(value: unknown): value is BaseEventType {
  return typeof value === 'string' && (BASE_EVENT_TYPES as readonly string[]).includes(value);
}

// An `operational-metrics` event's operation name: a CONSTANT kebab-case
// literal by the aggregator's caller contract (WARDEN-1258). Enforced
// structurally so no path, hostname, or arbitrary string can ever ride the
// aggregate key — the shape check IS the hard-exclusion proof for this type.
const OPERATION_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// The aggregator's footprint bound: at most maxOperations distinct keys (64 by
// default) + the one reserved overflow accumulator.
const MAX_OPERATIONS_PER_EVENT = 129;

/** True iff `value` is a non-empty, strictly-ascending, positive-finite
 *  boundary list — exactly as the bounded aggregators produce them. Shared by
 *  every histogram-bearing event type so the two cannot drift apart. */
function isAscendingBoundaries(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  for (let i = 0; i < value.length; i += 1) {
    const b = value[i];
    if (typeof b !== 'number' || !Number.isFinite(b) || b <= 0) return false;
    if (i > 0 && b <= (value as number[])[i - 1]) return false;
  }
  return true;
}

/** True iff `op` is a structurally valid OperationalMetricOperation. */
function isOperationalMetricOperation(op: unknown): op is OperationalMetricOperation {
  if (!op || typeof op !== 'object') return false;
  const o = op as Record<string, unknown>;
  if (typeof o.operation !== 'string' || !OPERATION_NAME_RE.test(o.operation)) return false;
  for (const k of ['count', 'okCount', 'failCount', 'min', 'avg', 'max'] as const) {
    const v = o[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return false;
  }
  if (!Number.isInteger(o.count) || !Number.isInteger(o.okCount) || !Number.isInteger(o.failCount)) return false;
  if (!Array.isArray(o.buckets)) return false;
  for (const b of o.buckets) {
    if (typeof b !== 'number' || !Number.isInteger(b) || b < 0) return false;
  }
  return true;
}

/** True iff `e` is a structurally valid OperationalMetricsEvent. */
function isOperationalMetricsShape(e: Record<string, unknown>): boolean {
  if (typeof e.windowStartedAt !== 'number' || !Number.isFinite(e.windowStartedAt)) return false;
  if (typeof e.windowEndedAt !== 'number' || !Number.isFinite(e.windowEndedAt)) return false;
  if (typeof e.rejected !== 'number' || !Number.isInteger(e.rejected) || e.rejected < 0) return false;
  if (!isAscendingBoundaries(e.boundaries)) return false;
  if (!Array.isArray(e.operations) || e.operations.length > MAX_OPERATIONS_PER_EVENT) return false;
  for (const op of e.operations) {
    if (!isOperationalMetricOperation(op)) return false;
    // Every operation's histogram is keyed against the event's boundaries.
    if ((op as OperationalMetricOperation).buckets.length !== (e.boundaries as number[]).length + 1) return false;
  }
  return true;
}

// A `server-stall` culprit key: the SAME constant kebab-case shape an
// `operational-metrics` operation name carries (WARDEN-1278). This is the
// structural hard-exclusion proof for the attribution axis — no path (needs a
// separator), no hostname (needs a dot), no chat/agent name (needs its own
// characters) can match, so the culprit map cannot become a channel for user
// data even if the producer's key mapping were bypassed.
const CULPRIT_NAME_RE = OPERATION_NAME_RE;
// The producer's footprint bound: at most maxCulprits distinct keys (32 by
// default) + the one reserved overflow accumulator. Held generously above the
// producer's default so a future cap raise does not need a schema bump.
const MAX_CULPRITS_PER_EVENT = 65;

/** True iff `c` is a structurally valid ServerStallCulprit. */
function isServerStallCulprit(c: unknown): c is ServerStallCulprit {
  if (!c || typeof c !== 'object') return false;
  const o = c as Record<string, unknown>;
  if (typeof o.culprit !== 'string' || !CULPRIT_NAME_RE.test(o.culprit)) return false;
  if (typeof o.count !== 'number' || !Number.isInteger(o.count) || o.count < 0) return false;
  if (typeof o.totalOverlapMs !== 'number' || !Number.isFinite(o.totalOverlapMs) || o.totalOverlapMs < 0) return false;
  return true;
}

/** True iff `e` is a structurally valid ServerStallEvent. */
function isServerStallShape(e: Record<string, unknown>): boolean {
  if (typeof e.windowStartedAt !== 'number' || !Number.isFinite(e.windowStartedAt)) return false;
  if (typeof e.windowEndedAt !== 'number' || !Number.isFinite(e.windowEndedAt)) return false;
  for (const k of ['count', 'totalMs', 'maxMs'] as const) {
    const v = e[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return false;
  }
  if (!Number.isInteger(e.count)) return false;
  if (!isAscendingBoundaries(e.boundaries)) return false;
  if (!Array.isArray(e.buckets)) return false;
  if (e.buckets.length !== (e.boundaries as number[]).length + 1) return false;
  for (const b of e.buckets) {
    if (typeof b !== 'number' || !Number.isInteger(b) || b < 0) return false;
  }
  if (!Array.isArray(e.culprits) || e.culprits.length > MAX_CULPRITS_PER_EVENT) return false;
  for (const c of e.culprits) {
    if (!isServerStallCulprit(c)) return false;
  }
  return true;
}

// The names event's own footprint bound. Held generously ABOVE the producer's
// NAMES_MAX (200) so a future cap raise does not need a schema bump — the same
// posture MAX_CULPRITS_PER_EVENT takes toward the stall aggregator's key cap.
// Names themselves carry NO pattern constraint (see the interface note above).
const MAX_CHATS_PER_EVENT = 400;

/** True iff `e` is a structurally valid WorkspaceNamesEvent. */
function isWorkspaceNamesShape(e: Record<string, unknown>): boolean {
  if (typeof e.windowStartedAt !== 'number' || !Number.isFinite(e.windowStartedAt)) return false;
  if (typeof e.windowEndedAt !== 'number' || !Number.isFinite(e.windowEndedAt)) return false;
  if (!Array.isArray(e.chats) || e.chats.length > MAX_CHATS_PER_EVENT) return false;
  for (const c of e.chats) {
    if (typeof c !== 'string') return false;
  }
  // chatCount is the TRUE catalog size — a non-negative integer, never smaller
  // than the list it bounds (the honest-cap invariant: truncated ⟺ count > len).
  if (typeof e.chatCount !== 'number' || !Number.isInteger(e.chatCount) || e.chatCount < 0) return false;
  if (e.chatCount < e.chats.length) return false;
  if (typeof e.truncated !== 'boolean') return false;
  return true;
}

// The shape event's closed key set — the type's own fields plus the base-tier
// envelope. A `workspace-shape` event is COUNTS ONLY by construction, so the
// schema itself refuses any other key: an injected `name`, `path`, `host` (or
// even an identifier field from another category, `chatName`/`sessionName` —
// this type never carries them) rejects the event at the validator, which makes
// "no identifier can ride the shape channel" a STRUCTURAL guarantee rather than
// a producer promise.
const WORKSPACE_SHAPE_KEYS = Object.freeze([
  'schemaVersion', 'type', 'runtime', 'timestamp', 'appVersion', 'platform',
  'windowStartedAt', 'windowEndedAt',
  'workspaces', 'panesOpen', 'panesActive', 'chats', 'peakPanesOpen', 'peakChats',
] as const);
const WORKSPACE_SHAPE_KEY_SET = new Set<string>(WORKSPACE_SHAPE_KEYS);

/** True iff `e` is a structurally valid WorkspaceShapeEvent. */
function isWorkspaceShapeShape(e: Record<string, unknown>): boolean {
  for (const k of Object.keys(e)) {
    if (!WORKSPACE_SHAPE_KEY_SET.has(k)) return false;
  }
  if (typeof e.windowStartedAt !== 'number' || !Number.isFinite(e.windowStartedAt)) return false;
  if (typeof e.windowEndedAt !== 'number' || !Number.isFinite(e.windowEndedAt)) return false;
  // Every count is a non-negative integer — a negative, a NaN, a float or a
  // string where a count belongs is not a shape snapshot.
  for (const k of ['workspaces', 'panesOpen', 'panesActive', 'chats', 'peakPanesOpen', 'peakChats'] as const) {
    const v = e[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return false;
  }
  // The peaks are maxima WITHIN the window, so they cannot be smaller than the
  // counts the window closed on (the honest-peak invariant: a peak below its
  // own closing count is a lie about the window).
  if ((e.peakPanesOpen as number) < (e.panesOpen as number)) return false;
  if ((e.peakChats as number) < (e.chats as number)) return false;
  return true;
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
    case 'operational-metrics':
      return isOperationalMetricsShape(e);
    case 'server-stall':
      // WARDEN-1278 — the server child's folded stall window. `runtime` is
      // already validated as a known Runtime above; this type is only ever
      // emitted for the `server` runtime, and saying so structurally is what
      // makes "the backend is the source" a wire fact rather than a convention.
      return e.runtime === RUNTIME.SERVER && isServerStallShape(e);
    case 'workspace-names':
      // WARDEN-1416 — the names category's own carrying event. Same runtime pin
      // as server-stall: the chat catalog lives in the forked backend child, so
      // only a `server`-runtime event is a truthful workspace-names event.
      return e.runtime === RUNTIME.SERVER && isWorkspaceNamesShape(e);
    case 'workspace-shape':
      // WARDEN-1424 — the renderer's workspace-shape count snapshot. Runtime
      // pin MIRRORED from the two types above: the workspace state lives in the
      // renderer's own refs, so only a `renderer`-runtime event is a truthful
      // workspace-shape event. The shape itself is counts-only over a closed
      // key set (see isWorkspaceShapeShape).
      return e.runtime === RUNTIME.RENDERER && isWorkspaceShapeShape(e);
    default:
      return false;
  }
}

/** True iff `event` is a valid base-tier event whose extended-tier fields (if
 *  present) are well-typed. GATING of the identifier fields (names retained only
 *  while the `names` category is on) is enforced by consent + redaction, not by
 *  the schema — a valid event may legitimately carry absent names. */
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
