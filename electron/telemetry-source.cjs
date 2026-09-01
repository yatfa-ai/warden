'use strict';

// Telemetry SOURCE layer — slice 4 of the optional, OFF-by-default telemetry
// client (roadmap WARDEN-446 / design WARDEN-443).
//
// This is the symmetric SOURCE path to slices 1–3's SINK path
// (schema+consent → redaction → transport). It taps real Electron/Node failure
// + freeze signals and turns them into schema-valid BASE-tier events delivered
// to slice 1's consent-gated `record()` entry point (WARDEN-457).
//
// WHY CJS in electron/ (not TS in web/src/lib/telemetry/):
// This code runs in the Electron MAIN process — it subscribes to `process` and
// to `win.webContents`. `electron/main.cjs` is CommonJS, and there is no TS→CJS
// build available at runtime (vite is a devDependency, not packaged in the built
// app, and the web build emits a browser bundle, not Node modules). So, exactly
// like `electron/window-state.cjs` (the established pattern for "main-process
// decision logic that must also be testable under `node --test`"), this is a CJS
// module that `main.cjs` `require()`s and that `web/telemetry-source.test.mjs`
// loads via `createRequire`. Slices 1–3's shared schema/consent modules live in
// web/src/lib/telemetry (renderer/Settings-facing); this main-process source
// owns a local copy of the contract constants below, to be reconciled with
// slice 1's canonical schema when it lands.
//
// INVARIANT — two layers of "off = nothing": instrumentation subscribes to
// signals ONLY while a COLLECTING consent category is on (and re-evaluates on
// every consent change). When telemetry is off (the default): no tap is
// subscribed, no event is built or buffered, and `record()` is additionally
// never called. Every run is user-enabled. The tests in
// web/telemetry-source.test.mjs prove (a)–(e); main.cjs proves the integration (f).

// WARDEN-1116 — THE consent authority (per-category, independent, off by
// default). This module makes no consent decision of its own; it asks.
const {
  collectsEvents,
  isCategoryEnabled,
  normalizeConsent,
} = require('../src/telemetry-consent.cjs');

// ---------------------------------------------------------------------------
// Slice-1 contract (base-tier). Reconcile with WARDEN-457's canonical schema
// when it ships. The event-type list, runtimes, and SCHEMA_VERSION are the
// shared cross-repo contract (client + receiver agree on a version).
// ---------------------------------------------------------------------------

// v5 (WARDEN-1258): + 'operational-metrics' — the aggregate usage-category
// event (see the canonical web/src/lib/telemetry/schema.ts for the full bump
// note). This inline copy stays byte-aligned with the canonical module; the
// drift tests pin the pair.
const SCHEMA_VERSION = 5;

const BASE_EVENT_TYPES = Object.freeze(['error', 'crash', 'performance-stall', 'operational-metrics']);

const RUNTIME = Object.freeze({ MAIN: 'main', RENDERER: 'renderer' });

// WARDEN-687 — the synthetic `reason` for a main-process hard kill detected on
// the NEXT launch by the crash sentinel (electron/crash-sentinel.cjs). A hard
// kill (native segfault / OOM-kill / SIGKILL / power loss / abrupt process.exit)
// bypasses `uncaughtExceptionMonitor` (which intercepts JS exceptions only), so
// the reporter dies with the crash and emits nothing. The sentinel turns that
// undetectable death into one normal base-tier crash event with this reason — a
// fixed, non-identifying string (no message, no frames, no chat/session names).
// It is NOT one of Electron's render-process-gone enums (oom/crashed/killed/…);
// it is its own value so a maintainer can distinguish a detected main kill from a
// renderer crash in /summary.
const MAIN_CRASH_REASON = 'unexpected-termination';

// Event-loop freeze heartbeat: poll every HEARTBEAT_INTERVAL_MS; if a tick
// arrives more than STALL_THRESHOLD_MS past the expected cadence, the loop was
// blocked → emit a performance-stall. Under threshold → nothing. Tunable via
// createTelemetrySource({ heartbeatMs, thresholdMs }).
const DEFAULT_HEARTBEAT_INTERVAL_MS = 1000; // expected cadence between ticks
const DEFAULT_STALL_THRESHOLD_MS = 1000; // a tick >2s after the previous = a stall

// Node emits 'uncaughtExceptionMonitor' BEFORE the default uncaught-exception
// handler runs, and installing it does NOT change the process's crash behavior
// (the app still exits as normal). That is exactly what a telemetry source
// wants: capture the error for reporting WITHOUT swallowing a fatal crash or
// changing default behavior when the user has opted in. (Listening to plain
// 'uncaughtException' instead would suppress the default exit.) The ticket
// (WARDEN-463) names 'uncaughtException'; we use 'uncaughtExceptionMonitor' for
// this non-disruptive property — same error, no behavior change.
const UNCAUGHT_EVENT = 'uncaughtExceptionMonitor';
const REJECTION_EVENT = 'unhandledRejection';

// ---------------------------------------------------------------------------
// Collection-boundary redaction (WARDEN-443: redaction is a client-side,
// pre-collection filter). Paths and hostnames are HARD exclusions — they must
// never enter the pipeline, by construction. Applied here at the collection
// boundary so the built event is free of them regardless of what slice 2's
// downstream redactor also does.
// ---------------------------------------------------------------------------

// Identifier patterns. Each is declared once as a /g regex for String.replace
// (stateless), and a non-global twin is derived via `new RegExp(re.source)` for
// `.test` (also stateless) — so redact + validate NEVER share a /g regex's
// mutable lastIndex. Host-equivalents (hostnames, IPs, user@host) are hard
// exclusions under WARDEN-443, alongside file paths.

// user@host / email, e.g. deploy@prod.internal (redacted first so both halves
// drop together and the bare host doesn't survive a second pass).
const USERHOST_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g;
// a file path: drive-letter / POSIX-abs / UNC / ~ / ./ ../, then ZERO or more
// separator-terminated segments and a final segment. `*` (not `+`) also catches
// a bare single-segment absolute path (/etc, C:\Users). Matches the whole path
// so the directory structure (user/home/host) is removed wholesale.
const PATH_RE = /(?:[A-Za-z]:[\\/]|[\\/]|~\/|\.(?:\.)?\/)(?:[^\s:'"<>|*?]+[\\/])*[^\s:'"<>|*?\\/]*/g;
// IPv4, e.g. 10.0.0.5, 127.0.0.1 (run before IPv6 so the IPv4 tail of an
// IPv4-mapped address is removed before the IPv6 pass eats the hex head).
const IPV4_RE = /(?:\d{1,3}\.){3}\d{1,3}/g;
// IPv6 — full 8-group form, the `::` compressed form, and a leading `::` form
// (e.g. ::1, fe80::1, 2001:db8::1). Pragmatic: may over-match hex+colon tokens,
// which is safe for a redactor.
const IPV6_RE = /(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4})*::[0-9a-fA-F:]*|::[0-9a-fA-F:]+/g;
// bare dotted hostname / FQDN, e.g. db.prod.internal, example.com
const HOSTNAME_RE = /\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}\b/g;

// Non-global twins for stateless `.test` (no lastIndex hazard).
const PATH_TEST = new RegExp(PATH_RE.source);
const USERHOST_TEST = new RegExp(USERHOST_RE.source);
const HOSTNAME_TEST = new RegExp(HOSTNAME_RE.source);
const IPV4_TEST = new RegExp(IPV4_RE.source);
const IPV6_TEST = new RegExp(IPV6_RE.source);

function redactIdentifiers(text) {
  if (typeof text !== 'string') return '';
  let out = text;
  out = out.replace(USERHOST_RE, '[host]'); // user@host / email
  out = out.replace(PATH_RE, '[path]'); // file paths (carries any embedded host)
  out = out.replace(IPV4_RE, '[host]'); // IPv4 addresses
  out = out.replace(IPV6_RE, '[host]'); // IPv6 addresses
  out = out.replace(HOSTNAME_RE, '[host]'); // bare FQDN left over
  return out;
}

// Basename of a path (cross-platform) — for structured stack frames we keep the
// file's basename (non-identifying: warden's own source filename) but DROP the
// directory (which carries the user's home/host). No hostnames survive because
// a basename has no separators.
function basename(filePath) {
  if (typeof filePath !== 'string' || filePath === '') return '';
  const clean = filePath.replace(/[\\/]+$/, ''); // trim trailing separators
  const idx = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

// Parse a stack string into structured frames, dropping identifying file PATHS
// (keeping only the basename) while preserving the function name + line/col for
// debugging warden's own code. Defensive against unfamiliar stack formats.
function parseStackFrames(stack) {
  if (typeof stack !== 'string' || stack.length === 0) return [];
  const frames = [];
  for (const raw of stack.split('\n')) {
    const line = raw.trim();
    if (!/^at\b/.test(line)) continue; // skip the header line ("Name: msg") + blanks
    // "at fn (file:line:col)" | "at file:line:col" | "at fn"
    const m = line.match(
      /^at\s+(?:(.*?)\s+\((.+?):(\d+):(\d+)\)|(.+?):(\d+):(\d+)|(.*))$/
    );
    if (!m) continue;
    const frame = {};
    if (m[1] != null) frame.function = m[1];
    else if (m[8] != null && m[8] !== '') frame.function = m[8];
    const file = m[2] != null ? m[2] : m[5];
    if (file) frame.file = basename(file);
    if (m[3] != null) { frame.line = parseInt(m[3], 10); frame.column = parseInt(m[4], 10); }
    else if (m[6] != null) { frame.line = parseInt(m[6], 10); frame.column = parseInt(m[7], 10); }
    frames.push(frame);
  }
  return frames;
}

// ---------------------------------------------------------------------------
// Pure event builders. Each returns a schema-valid base-tier event. `now` is an
// epoch-ms timestamp (caller-injected so tests are deterministic).
//
// EXTENDED-TIER NAMES (WARDEN-538). The builders stay PURE: each attaches the
// `chatName` / `sessionName` identifier fields ONLY when the caller threaded them
// via `opts` — the consent GATE (extended on AND a context value held) lives in
// the source closure's `extendedNameFields()` helper, which is spread into these
// builders' `opts` from every emit path. So a builder called directly (e.g. from
// a test) with no names emits today's anonymous event; a builder called from a
// live signal with extended consent on + a focused chat emits a name-bearing
// event. Field names match the sink's IDENTIFIER_FIELDS (schema.ts / redact.ts),
// which retain them only at the `extended` tier (dropped at base/off) — two
// independent layers of defense in depth.
// ---------------------------------------------------------------------------

// Attach the extended-tier identifier fields when the caller (the source closure,
// already gated by extended consent) threaded non-empty string names via opts.
// Pure: attaches exactly what it is given; never invents or redacts a name (the
// name is the deliberate identifier the user opted into; the sink's redactor is
// what retains/drops it by tier).
function attachExtendedNames(event, o) {
  if (!event || !o) return;
  if (typeof o.chatName === 'string' && o.chatName) event.chatName = o.chatName;
  if (typeof o.sessionName === 'string' && o.sessionName) event.sessionName = o.sessionName;
}

// Attach the base-tier app release label (WARDEN-665) when the caller threaded a
// non-empty string via opts. Pure: attaches exactly what it is given. appVersion
// is a NON-IDENTIFYING release label (identical for every user on a release — not
// an identifier, not content), so it attaches unconditionally on the opt,
// independent of the extended-tier name gate. Omitted when absent/empty → a v2
// event without appVersion still validates (a source that cannot read the version
// emits today's shape).
function attachAppVersion(event, o) {
  if (!event || !o) return;
  if (typeof o.appVersion === 'string' && o.appVersion) event.appVersion = o.appVersion;
}

// Attach the base-tier OS label (WARDEN-684) when the caller threaded a
// non-empty string via opts. Pure: attaches exactly what it is given. platform
// is a NON-IDENTIFYING OS label (process.platform — darwin/win32/linux;
// identical for millions of users on an OS — not an identifier, not content), so
// it attaches unconditionally on the opt, independent of the extended-tier name
// gate. Omitted when absent/empty → a v3 event without platform still validates
// (a source that cannot read process.platform emits today's shape minus the OS
// label). Mirrors attachAppVersion exactly (same trust posture, same opt shape).
function attachPlatform(event, o) {
  if (!event || !o) return;
  if (typeof o.platform === 'string' && o.platform) event.platform = o.platform;
}

// Coerce an error-like value into a { name, message, stack } triple for
// buildErrorEvent. Three shapes are handled:
//   1. A real Error instance (the MAIN-process uncaught/rejection path).
//   2. A plain serializable { name, message, stack } object forwarded across the
//      contextBridge from the RENDERER (WARDEN-637). Error instances do NOT
//      survive the IPC structured clone with their prototype, so the renderer
//      forwards the fields; recognizing that shape here reads the renderer's
//      real name/message/stack instead of the old fallback, which ran
//      `new Error(String(obj))` and collapsed it to message:"[object Object]"
//      with frames parsed from a MAIN-process stack (where `new Error` ran) —
//      silently losing the renderer's error entirely (refinement B).
//   3. Anything else (string/null/undefined/a non-error object WITHOUT a
//      `message` field) is wrapped into a fresh main-process Error — UNCHANGED
//      from pre-WARDEN-637 behavior, so existing callers that reject with e.g.
//      { code, msg } are unaffected.
function coerceErrorFields(err) {
  if (err instanceof Error) {
    return {
      name: typeof err.name === 'string' && err.name ? err.name : 'Error',
      message: typeof err.message === 'string' ? err.message : '',
      stack: typeof err.stack === 'string' ? err.stack : '',
    };
  }
  // Serialized renderer error: a plain object carrying a string `message`. Read
  // its fields directly so the renderer's name/message/stack survive.
  if (err !== null && typeof err === 'object' && typeof err.message === 'string') {
    return {
      name: typeof err.name === 'string' && err.name ? err.name : 'Error',
      message: err.message,
      stack: typeof err.stack === 'string' ? err.stack : '',
    };
  }
  const wrapped = new Error(err == null ? '' : String(err));
  return {
    name: 'Error',
    message: typeof wrapped.message === 'string' ? wrapped.message : '',
    stack: typeof wrapped.stack === 'string' ? wrapped.stack : '',
  };
}

function buildErrorEvent(err, opts) {
  const o = opts || {};
  const e = coerceErrorFields(err);
  const event = {
    schemaVersion: SCHEMA_VERSION,
    type: 'error',
    runtime: o.runtime === RUNTIME.RENDERER ? RUNTIME.RENDERER : RUNTIME.MAIN,
    timestamp: typeof o.now === 'number' ? o.now : Date.now(),
    name: e.name,
    message: redactIdentifiers(e.message),
    frames: parseStackFrames(e.stack),
  };
  attachAppVersion(event, o);
  attachPlatform(event, o);
  attachExtendedNames(event, o);
  return event;
}

function buildCrashEvent(details, opts) {
  const o = opts || {};
  const d = details && typeof details === 'object' ? details : {};
  // Electron render-process-gone `reason` is a fixed enum (oom, crashed, killed,
  // abnormal-exit, …) — not identifying — so it is passed through verbatim. The
  // crash sentinel (WARDEN-687) passes its own MAIN_CRASH_REASON here instead.
  const reason = typeof d.reason === 'string' && d.reason ? d.reason : 'unknown';
  const event = {
    schemaVersion: SCHEMA_VERSION,
    type: 'crash',
    // WARDEN-687: a crash defaults to the renderer (a render-process-gone IS the
    // renderer, so onRenderGone — which calls without a runtime — is byte-identical).
    // An explicit `runtime: RUNTIME.MAIN` opts into a main-runtime crash event for a
    // hard kill detected by the crash sentinel. Any other/absent value → renderer.
    runtime: o.runtime === RUNTIME.MAIN ? RUNTIME.MAIN : RUNTIME.RENDERER,
    timestamp: typeof o.now === 'number' ? o.now : Date.now(),
    reason,
  };
  if (typeof d.exitCode === 'number') event.exitCode = d.exitCode;
  attachAppVersion(event, o);
  attachPlatform(event, o);
  attachExtendedNames(event, o);
  return event;
}

function buildStallEvent(lagMs, opts) {
  const o = opts || {};
  const lag = typeof lagMs === 'number' && lagMs > 0 ? Math.round(lagMs) : 0;
  const event = {
    schemaVersion: SCHEMA_VERSION,
    type: 'performance-stall',
    runtime: o.runtime === RUNTIME.MAIN ? RUNTIME.MAIN : RUNTIME.RENDERER,
    timestamp: typeof o.now === 'number' ? o.now : Date.now(),
    lagMs: lag,
    source: o.source === 'unresponsive' ? 'unresponsive' : 'event-loop',
  };
  attachAppVersion(event, o);
  attachPlatform(event, o);
  attachExtendedNames(event, o);
  return event;
}

// Heartbeat decision: a tick is a stall iff its overdue gap (actual elapsed
// minus the expected interval) exceeds the threshold. Separated from the builder
// so the threshold logic is unit-testable in isolation.
function isStall(overdueMs, thresholdMs) {
  const thresh = typeof thresholdMs === 'number' ? thresholdMs : DEFAULT_STALL_THRESHOLD_MS;
  return typeof overdueMs === 'number' && overdueMs > thresh;
}

// ---------------------------------------------------------------------------
// Schema conformance check — used by the tests to assert criterion (e) and by
// any caller that wants to defend against a malformed event.
// ---------------------------------------------------------------------------

function validateBaseEvent(event) {
  if (!event || typeof event !== 'object') return false;
  if (event.schemaVersion !== SCHEMA_VERSION) return false;
  if (!BASE_EVENT_TYPES.includes(event.type)) return false;
  if (event.runtime !== RUNTIME.MAIN && event.runtime !== RUNTIME.RENDERER) return false;
  if (typeof event.timestamp !== 'number' || !Number.isFinite(event.timestamp)) return false;
  if (event.type === 'error') {
    if (typeof event.message !== 'string') return false;
    if (typeof event.name !== 'string') return false;
    if (!Array.isArray(event.frames)) return false;
  } else if (event.type === 'crash') {
    if (typeof event.reason !== 'string') return false;
  } else if (event.type === 'performance-stall') {
    if (typeof event.lagMs !== 'number') return false;
    if (event.source !== 'event-loop' && event.source !== 'unresponsive') return false;
  } else if (event.type === 'operational-metrics') {
    // WARDEN-1258 — the aggregate event. Mirrors the canonical schema's shape
    // checks (see web/src/lib/telemetry/schema.ts); the kebab-case operation
    // name pattern doubles as THIS module's hard-exclusion proof: the name is
    // the only string the type carries, and a path/hostname can never match it.
    if (!isValidOperationalMetrics(event)) return false;
  }
  // Hard-exclusion proof: the built event must not leak an identifier.
  //   - The free-text MESSAGE is fully redacted at the collection boundary, so
  //     it must be free of PATHS and HOST-EQUIVALENTS (hostnames, IPs, user@host).
  //   - Structured frame fields (function name, file basename) are curated, not
  //     free text: a filename basename ('key.pem') is allowed under WARDEN-443
  //     (only file PATHS and HOSTNAMES are hard exclusions), so frame fields are
  //     checked for PATHS only (a path is unambiguous — it has a separator).
  if (event.message != null && containsIdentifier(event.message)) return false;
  if (Array.isArray(event.frames)) {
    for (const f of event.frames) {
      if (!f || typeof f !== 'object') return false;
      if (f.function != null && containsPath(String(f.function))) return false;
      if (f.file != null && containsPath(String(f.file))) return false;
    }
  }
  return true;
}

// An `operational-metrics` event's operation name: constant kebab-case literal
// by the aggregator's caller contract (WARDEN-1258) — mirrors the canonical
// schema's OPERATION_NAME_RE. Lowercase letters, digits, and hyphens only, so
// no path (needs a separator) and no hostname (needs a dot + TLD) can match.
const OP_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// The aggregator's footprint bound (maxOperations + the reserved overflow key).
const MAX_METRIC_OPERATIONS = 129;

function isFiniteNonNegative(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function isValidMetricOperation(op) {
  if (!op || typeof op !== 'object') return false;
  if (typeof op.operation !== 'string' || !OP_NAME_RE.test(op.operation)) return false;
  if (!isFiniteNonNegative(op.min) || !isFiniteNonNegative(op.avg) || !isFiniteNonNegative(op.max)) return false;
  for (const k of ['count', 'okCount', 'failCount']) {
    if (!Number.isInteger(op[k]) || op[k] < 0) return false;
  }
  if (!Array.isArray(op.buckets)) return false;
  for (const b of op.buckets) {
    if (!Number.isInteger(b) || b < 0) return false;
  }
  return true;
}

function isValidOperationalMetrics(e) {
  if (!Number.isInteger(e.rejected) || e.rejected < 0) return false;
  if (!isFiniteNonNegative(e.windowStartedAt) || !isFiniteNonNegative(e.windowEndedAt)) return false;
  if (!Array.isArray(e.boundaries) || e.boundaries.length === 0) return false;
  for (let i = 0; i < e.boundaries.length; i += 1) {
    const b = e.boundaries[i];
    if (typeof b !== 'number' || !Number.isFinite(b) || b <= 0) return false;
    if (i > 0 && b <= e.boundaries[i - 1]) return false; // strictly ascending
  }
  if (!Array.isArray(e.operations) || e.operations.length > MAX_METRIC_OPERATIONS) return false;
  for (const op of e.operations) {
    if (!isValidMetricOperation(op)) return false;
    if (op.buckets.length !== e.boundaries.length + 1) return false;
  }
  return true;
}

// Any identifier: a path OR a host-equivalent (user@host, bare FQDN, IPv4, IPv6).
// Used to PROVE the redacted message carries nothing identifying. All test
// regexes are non-global (stateless) — no lastIndex to manage.
function containsIdentifier(text) {
  if (typeof text !== 'string' || text === '') return false;
  return (
    PATH_TEST.test(text) ||
    USERHOST_TEST.test(text) ||
    IPV4_TEST.test(text) ||
    IPV6_TEST.test(text) ||
    HOSTNAME_TEST.test(text)
  );
}

// A path is unambiguous (it has a directory separator). Used to prove frame
// fields carry no path while still allowing bare filenames.
function containsPath(text) {
  if (typeof text !== 'string' || text === '') return false;
  return PATH_TEST.test(text);
}

// ---------------------------------------------------------------------------
// The source layer: a consent-gated collector factory.
//
// createTelemetrySource({ record, now, setInterval, clearInterval, heartbeatMs,
// thresholdMs }) returns a handle:
//   .attachMain(processLike)        — store the main-process emitter (process)
//   .attachRenderer(webContentsLike) — store the renderer emitter (win.webContents)
//   .setConsent(consentState)       — apply the per-category consent (WARDEN-1116):
//                                     arms/disarms subscriptions AND name attachment
//   .setContext({chatName?, sessionName?}) — latest focused names (WARDEN-538)
//   .setRecord(fn)                  — hot-swap the record sink (slice 1 wiring)
//   .recordRendererError(serialized) — consent-gated renderer JS-error entry point
//                                       (forwarded over IPC from preload; WARDEN-637)
//   .dispose()                      — detach everything + stop the heartbeat
//
// WARDEN-1116 — consent is a set of INDEPENDENT per-category switches, resolved
// by the single authority in src/telemetry-consent.cjs. Signals subscribe
// ONLY while a COLLECTING category is on; turning collection off detaches every
// tap and stops the heartbeat. record() is additionally gated, so there are two
// independent layers of "off = nothing". Name attachment is a THIRD independent
// gate: it needs the `names` category on AND a focused-chat context pushed; and
// the sink's redactor strips names whenever `names` is off regardless.
//
// The `names` category is NOT subordinate to any other category — the old
// "extended requires base" clamp is gone. It does not need one: `names` only
// DECORATES events other categories produce, so with nothing collecting no event
// is ever built and there is nothing for a name to ride on. Inert by
// construction, not by clamp.
// ---------------------------------------------------------------------------

function createTelemetrySource(opts) {
  const o = opts || {};
  let record = typeof o.record === 'function' ? o.record : null;
  const nowFn = typeof o.now === 'function' ? o.now : () => Date.now();
  const setInt = typeof o.setInterval === 'function' ? o.setInterval : setInterval;
  const clearInt = typeof o.clearInterval === 'function' ? o.clearInterval : clearInterval;
  const heartbeatMs = typeof o.heartbeatMs === 'number' ? o.heartbeatMs : DEFAULT_HEARTBEAT_INTERVAL_MS;
  const thresholdMs = typeof o.thresholdMs === 'number' ? o.thresholdMs : DEFAULT_STALL_THRESHOLD_MS;

  // BASE-tier app release label (WARDEN-665). A non-identifying release version
  // (identical for every user on a release — not an identifier, not content)
  // threaded into every builder so emitted events carry it for release attribution
  // on the receiver. Injected here like `now`/`record` so the module stays
  // testable under node --test without Electron; null/absent → no field is attached
  // (a v2 event without appVersion still validates). main.cjs wires app.getVersion().
  const appVersion = typeof o.appVersion === 'string' && o.appVersion ? o.appVersion : null;
  // A reusable spread fragment threaded into every builder call below — `appVersion`
  // is captured once and never mutated per-factory, so a constant fragment (mirroring
  // the ...nameFields() spread) is correct and keeps the gate in ONE place.
  const versionOpt = appVersion ? { appVersion } : {};

  // BASE-tier OS label (WARDEN-684). A non-identifying OS label (process.platform
  // — darwin/win32/linux; identical for millions of users on an OS — not an
  // identifier, not content) threaded into every builder so emitted events carry
  // it for OS attribution on the receiver (a maintainer can answer "is this spike
  // Mac/Windows/Linux-specific?"). Injected here like `appVersion` so the module
  // stays testable under node --test without Electron; null/absent → no field is
  // attached (a v3 event without platform still validates). main.cjs wires
  // process.platform. Mirrors versionOpt 1:1.
  const platform = typeof o.platform === 'string' && o.platform ? o.platform : null;
  const platformOpt = platform ? { platform } : {};

  // Whether a COLLECTING category is enabled — the arm/disarm state for every
  // signal subscription and the first "off = nothing" layer.
  let collecting = false;
  // `names` category producer state (WARDEN-538, per-category since WARDEN-1116).
  // INDEPENDENT of `collecting`: it is never clamped to it. `context` holds the
  // latest focused chat/session name the renderer pushed over IPC. Together they
  // gate name attachment: a built event carries the focused name ONLY when the
  // `names` category is on AND a non-empty name is held — otherwise an anonymous
  // event. The builders themselves stay pure; the gate is `nameFields`.
  let namesConsent = false;
  let context = { chatName: null, sessionName: null };
  let mainEmitter = null;
  let rendererEmitter = null;
  let mainAttached = false;
  let rendererAttached = false;
  let heartbeatTimer = null;
  let lastTick = 0;

  // record only when (1) a collecting category is on AND (2) a real sink is
  // wired. Two layers.
  function emit(event) {
    if (!collecting) return;
    if (typeof record !== 'function') return;
    try {
      record(event);
    } catch {
      // A telemetry sink must never throw the instrumented process into a worse
      // state — swallow sink errors (the failure signal itself was the point).
    }
  }

  // The `names`-category identifier fields to thread into a builder's opts.
  // Returns `{}` (anonymous event) UNLESS the `names` category is on AND a
  // non-empty name is held — so a user without it gets byte-identical payloads to
  // an anonymous event. Spread into every builder call below so the gate lives in
  // ONE place (not 5). The builders attach exactly these fields; the sink's
  // redactor then retains them only while `names` is live (defense in depth: if
  // consent drops between build and dispatch, the redactor strips the names).
  function nameFields() {
    if (!namesConsent) return {};
    const f = {};
    if (context.chatName) f.chatName = context.chatName;
    if (context.sessionName) f.sessionName = context.sessionName;
    return f;
  }

  // --- signal handlers (gated by consent at emit time) ---
  const onUncaught = (err) => {
    if (!collecting) return;
    emit(buildErrorEvent(err, { now: nowFn(), runtime: RUNTIME.MAIN, ...nameFields(), ...versionOpt, ...platformOpt }));
  };
  const onRejection = (reason) => {
    if (!collecting) return;
    emit(buildErrorEvent(reason, { now: nowFn(), runtime: RUNTIME.MAIN, ...nameFields(), ...versionOpt, ...platformOpt }));
  };
  const onRenderGone = (_event, details) => {
    if (!collecting) return;
    emit(buildCrashEvent(details, { now: nowFn(), ...nameFields(), ...versionOpt, ...platformOpt }));
  };
  const onUnresponsive = () => {
    if (!collecting) return;
    emit(buildStallEvent(0, { now: nowFn(), runtime: RUNTIME.RENDERER, source: 'unresponsive', ...nameFields(), ...versionOpt, ...platformOpt }));
  };

  // --- heartbeat: measures real wall-clock lag between timer callbacks ---
  function startHeartbeat() {
    if (heartbeatTimer) return;
    lastTick = nowFn();
    heartbeatTimer = setInt(() => {
      const t = nowFn();
      const overdue = t - lastTick - heartbeatMs; // how late this tick arrived
      lastTick = t;
      if (isStall(overdue, thresholdMs)) {
        emit(buildStallEvent(overdue, { now: t, runtime: RUNTIME.MAIN, source: 'event-loop', ...nameFields(), ...versionOpt, ...platformOpt }));
      }
    }, heartbeatMs);
    // The telemetry heartbeat must never keep the process alive on its own —
    // unref it when the scheduler returned a real Node timer (guarded for the
    // fake timers injected by the test suite, which return a plain handle).
    if (heartbeatTimer && typeof heartbeatTimer.unref === 'function') {
      heartbeatTimer.unref();
    }
  }
  function stopHeartbeat() {
    if (heartbeatTimer) {
      try { clearInt(heartbeatTimer); } catch {}
      heartbeatTimer = null;
    }
  }

  function safeOff(emitter, evt, fn) {
    if (!emitter) return;
    try {
      if (typeof emitter.off === 'function') emitter.off(evt, fn);
      else if (typeof emitter.removeListener === 'function') emitter.removeListener(evt, fn);
    } catch {}
  }

  function attachMainListeners() {
    if (mainAttached || !mainEmitter || typeof mainEmitter.on !== 'function') return;
    mainEmitter.on(UNCAUGHT_EVENT, onUncaught);
    mainEmitter.on(REJECTION_EVENT, onRejection);
    mainAttached = true;
  }
  function detachMainListeners() {
    if (!mainAttached) return;
    safeOff(mainEmitter, UNCAUGHT_EVENT, onUncaught);
    safeOff(mainEmitter, REJECTION_EVENT, onRejection);
    mainAttached = false;
  }
  function attachRendererListeners() {
    if (rendererAttached || !rendererEmitter || typeof rendererEmitter.on !== 'function') return;
    rendererEmitter.on('render-process-gone', onRenderGone);
    rendererEmitter.on('unresponsive', onUnresponsive);
    rendererAttached = true;
  }
  function detachRendererListeners() {
    if (!rendererAttached) return;
    safeOff(rendererEmitter, 'render-process-gone', onRenderGone);
    safeOff(rendererEmitter, 'unresponsive', onUnresponsive);
    rendererAttached = false;
  }

  return {
    attachMain(emitter) {
      // If a main emitter is already attached, detach it first (defensive).
      if (mainAttached) detachMainListeners();
      mainEmitter = emitter || null;
      if (collecting) attachMainListeners();
      return this;
    },
    attachRenderer(emitter) {
      if (rendererAttached) detachRendererListeners();
      rendererEmitter = emitter || null;
      if (collecting) attachRendererListeners();
      return this;
    },
    // WARDEN-1116 — apply the whole per-category consent state in ONE call. The
    // categories are applied INDEPENDENTLY: `names` is set from its own switch
    // and is NEVER clamped to whether anything is collecting. Safety with names
    // on and nothing collecting comes from inertness — no event is built, so no
    // name is attached to anything — not from a clamp.
    //
    // Whatever is passed goes through the single consent authority
    // (normalizeConsent), so a missing / partial / malformed / unrecognized value
    // resolves to nothing enabled: telemetry stays silent on garbage.
    setConsent(consent) {
      const resolved = normalizeConsent(consent);
      namesConsent = isCategoryEnabled(resolved, 'names');
      const next = collectsEvents(resolved);
      if (next === collecting) return;
      collecting = next;
      if (next) {
        attachMainListeners();
        attachRendererListeners();
        startHeartbeat();
      } else {
        // Turning collection off detaches every tap immediately — no restart.
        // Context is retained: it is inert while nothing is collected.
        detachMainListeners();
        detachRendererListeners();
        stopHeartbeat();
      }
    },
    setContext(ctx) {
      // Store the latest focused chat/session names pushed by the renderer. Strings
      // only; garbage (non-strings, non-objects, empty) is normalized to null so a
      // buggy/late payload can never inject a non-string or empty identifier into a
      // built event. Storing is ALWAYS safe: names attach only when the `names`
      // category is on AND something is being collected, so this holds
      // nothing-identifying-useful until the user has opted in.
      const c = ctx && typeof ctx === 'object' ? ctx : {};
      context = {
        chatName: typeof c.chatName === 'string' && c.chatName ? c.chatName : null,
        sessionName: typeof c.sessionName === 'string' && c.sessionName ? c.sessionName : null,
      };
    },
    setRecord(fn) {
      record = typeof fn === 'function' ? fn : null;
    },
    // WARDEN-637 — consent-gated entry point for a RENDERER-process JS error (a
    // React render throw caught by ErrorBoundary, a global `error` event, or an
    // unhandled promise rejection) forwarded over IPC from preload. The renderer
    // cannot keep an Error instance alive across the contextBridge, so it forwards
    // a serializable { name, message, stack }; buildErrorEvent reads that shape
    // directly (coerceErrorFields) and produces a renderer-runtime event through
    // the SAME consent-gated record() pipeline as main-process errors. Mirrors
    // onUncaught/onRejection: gated at the top (the FIRST "off = nothing" layer)
    // so nothing is built or recorded while nothing is being collected — the preload
    // listener forwards unconditionally and main drops it here (refinement D).
    recordRendererError(serialized) {
      if (!collecting) return;
      emit(buildErrorEvent(serialized, { now: nowFn(), runtime: RUNTIME.RENDERER, ...nameFields(), ...versionOpt, ...platformOpt }));
    },
    // WARDEN-687 — consent-gated entry point for a MAIN-process hard kill detected
    // on the NEXT launch by the crash sentinel (electron/crash-sentinel.cjs). A hard
    // kill (native segfault / OOM-kill / SIGKILL / power loss / abrupt process.exit)
    // bypasses uncaughtExceptionMonitor, so the prior instance died emitting NOTHING;
    // the sentinel writes a per-PID marker at startup and, on the next launch, finds
    // markers whose PID is dead and calls this once per crashed instance. Mirrors
    // recordRendererError: gated at the top (the FIRST "off = nothing" layer) so
    // nothing is built or recorded while nothing is collected; emit() is layer two.
    //
    // DELIBERATELY omits nameFields(): the crash happened in a PRIOR session,
    // so the current launch's focused chat/session name would be a wrong-session
    // correlation. Per the WARDEN-687 trust model the event carries NO chat/session
    // names — only the synthetic MAIN_CRASH_REASON + the session-independent
    // appVersion/platform labels (a maintainer can still attribute the crash to a
    // release/OS). buildCrashEvent honors the explicit `runtime: RUNTIME.MAIN`.
    recordMainCrash() {
      if (!collecting) return;
      emit(buildCrashEvent(
        { reason: MAIN_CRASH_REASON },
        { now: nowFn(), runtime: RUNTIME.MAIN, ...versionOpt, ...platformOpt },
      ));
    },
    // True iff a COLLECTING category is on (i.e. signals are armed).
    isCollecting() {
      return collecting;
    },
    // True iff the `names` category is on. Independent of isCollecting().
    isNamesConsentOn() {
      return namesConsent;
    },
    dispose() {
      detachMainListeners();
      detachRendererListeners();
      stopHeartbeat();
      mainEmitter = null;
      rendererEmitter = null;
      collecting = false;
      namesConsent = false;
      context = { chatName: null, sessionName: null };
    },
  };
}

module.exports = {
  SCHEMA_VERSION,
  BASE_EVENT_TYPES,
  RUNTIME,
  MAIN_CRASH_REASON,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_STALL_THRESHOLD_MS,
  UNCAUGHT_EVENT,
  REJECTION_EVENT,
  redactIdentifiers,
  parseStackFrames,
  buildErrorEvent,
  buildCrashEvent,
  buildStallEvent,
  isStall,
  validateBaseEvent,
  createTelemetrySource,
};
