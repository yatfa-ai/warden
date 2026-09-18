// Request telemetry (WARDEN-1292) — the producer that points the existing
// `operational-metrics` channel at the server's ENTIRE /api surface.
//
// THE GAP IT CLOSES. Until this module the channel had a handful of
// hand-instrumented feeders (the terminal linkifier's file-existence probe,
// the pane-input hops) while every ordinary API operation the UI performs —
// session lists, chat catalog, config reads, git, discover, health — was
// invisible on it. The roadmap's own bar: "Silence must mean 'nothing broke',
// not 'nobody was looking.'" A slow-but-successful I/O-bound operation (an
// SSH-bound route waiting on a remote host — the event loop spins freely)
// produced no signal anywhere. This producer folds EVERY /api request's
// duration + ok/fail verdict into the same bounded M1 aggregate, keyed by the
// ROUTE PATTERN (never the concrete URL).
//
// THE MEASUREMENT POINT already exists: src/server.js's FIRST middleware wraps
// every request in a loop-monitor span and closes it on res 'close' — duration
// and status are observable exactly there. The wiring (also in server.js) adds
// one timestamped fold on that close handler, scoped to /api/ paths and wrapped
// so telemetry can never take out the close path.
//
// WHAT IT MAY NEVER CARRY (WARDEN-443 hard exclusions): concrete paths, path
// variables, query strings, hostnames, chat content, credentials. Keys are
// route PATTERNS built from `req.route.path` — a code literal from the route
// table BY CONSTRUCTION (the middleware runs before routing, but by the time
// res 'close' fires, `req.route` is the matched Route object, including for
// nested-router matches; `req.path` already excludes the query string).
// `:param` segments map to the `id` placeholder, and a static segment is kept
// verbatim only if it is lowercase-kebab — everything else folds to `id`. A
// hostile id-bearing URL can therefore never ride a key: the URL is not an
// input to the mapping at all, only the table's own literal is.
//
// ⛔ THE RESERVED OVERFLOW KEY IS UNSENDABLE — DO NOT ROUTE ANYTHING TO IT.
// The aggregator's OVERFLOW_OPERATION ('__other__') fails BOTH the emit-side
// OP_NAME_RE (electron/telemetry-source.cjs) and the canonical
// OPERATION_NAME_RE (web/src/lib/telemetry/schema.ts), and
// isValidOperationalMetrics rejects the ENTIRE event when ANY operation row
// fails — one garbage request routed there would discard every legitimate
// route metric in the whole 5-minute window. The exact inversion of the
// roadmap bar. Instead:
//   • un-routed requests (req.route undefined: bad paths, JSON-body parse
//     errors) and any key failing the shape/length checks fold under the
//     regex-safe constant UNMATCHED_OPERATION ('unmatched'), which matches the
//     name shape and rides the wire normally;
//   • REQUEST_MAX_OPERATIONS is sized above the live route census + the
//     unmatched sink, so the aggregator's internal overflow accumulator is
//     never reached (src/request-telemetry-http.test.js asserts this as a
//     derived sizing tripwire, not a frozen count). The census is COMPLETE:
//     Express serves HEAD through the GET handler with req.method staying
//     'HEAD', so routeOperationKey aliases 'head' onto the route's `get-`
//     key — without that alias every GET route would carry an uncounted
//     `head-*` twin (a growth axis route.methods never reports), and enough
//     distinct keys would reach the reserved accumulator and void the window.
//
// CONSENT: recording is gated LIVE on the `operational-metrics` category (no
// new category, no new checkbox). When the category is off (the default),
// recordRequest() refuses and flushNow() both skips sending AND drops the
// window, so nothing out-of-consent is even retained in memory. The window is
// flushed to the Electron main process over the fork's IPC channel (main
// builds the schema event and records it through the standard consent-gated
// pipeline); when the server runs standalone (no process.send), the flush is a
// no-op and the module is inert on the wire.
//
// The heavy lifting (bounded windows, fixed-boundary histograms, operation
// caps) is the M1 aggregator in src/telemetry-metrics.cjs; the consent gate,
// the IPC forward, the flushNow control flow and the unref'd start() are the
// shared scaffold in src/telemetryProducer.js (WARDEN-1352). This module is
// only the request-specific policy: the route-pattern key mapping, the
// unmatched sink, the aggregator sizing, and the flush cadence.

import { createMetricAggregator } from './telemetry-metrics.cjs';
import { createConsentGatedWindow } from './telemetryProducer.js';

// Default flush cadence — the SAME 5-minute window every other producer on
// this channel uses, so all of them close on one rhythm. An idle window (no
// /api traffic) is not sent at all.
export const REQUEST_FLUSH_MS = 5 * 60_000;

// The single regex-safe sink for requests that matched NO route, and for any
// key failing the schema's operation-name shape below. Deliberately NOT the
// aggregator's reserved '__other__' (see the ⛔ block above).
export const UNMATCHED_OPERATION = 'unmatched';

// Distinct operation keys the aggregator retains. Sized ABOVE the live route
// census (56 /api route patterns + the non-API '/' at the time of writing —
// the tripwire test derives it, it is never trusted from prose) PLUS the
// `unmatched` sink, so the aggregator's internal — and unsendable — reserved
// overflow key is structurally unreachable. The census counts the REACHABLE
// set: HEAD requests are aliased onto their GET key by routeOperationKey
// (they run the GET handler), and auto-OPTIONS answers never match a route,
// so they fold into the budgeted unmatched sink. The wire caps one event at
// 129 operations (schema MAX_OPERATIONS_PER_EVENT): 96 + 1 reserved = 97 ≤ 129.
export const REQUEST_MAX_OPERATIONS = 96;

// The schema validator's operation-name pattern, mirrored locally (canonical
// source: web/src/lib/telemetry/schema.ts OPERATION_NAME_RE, same as
// electron/telemetry-source.cjs OP_NAME_RE). Used ONLY as a guard here — the
// validators remain the wire's structural backstop.
const OP_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OP_NAME_MAX_LENGTH = 64;

// An HTTP verb is letters only. req.method is always such a string in
// practice; this keeps a hand-rolled caller honest the same way.
const HTTP_VERB_RE = /^[a-z]+$/;

// A static segment is kept VERBATIM only if it is lowercase letters + hyphens.
// The class admits no digits (the redactor's high-entropy caution, same note
// src/telemetry-stalls.cjs carries) and no separators, dots or unicode — so a
// path variable, a hash, a hostname fragment, anything odd folds to `id`.
const STATIC_SEGMENT_RE = /^[a-z-]+$/;

// Deep paths are capped — beyond this the key loses resolution (later segments
// dropped), never safety. Warden's deepest route is 4 segments today; 6 leaves
// headroom while keeping the worst-case key well under the length cap.
const MAX_ROUTE_SEGMENTS = 6;

/**
 * Map ONE (verb, route path literal) onto a closed-set operation key.
 *
 * `routePath` must be the ROUTE TABLE's literal (Express's `req.route.path`)
 * — a static pattern like '/api/collections/:id/agents'. Passing a concrete
 * request URL is not an input this mapping was designed for: a digit-bearing
 * or non-kebab segment folds to `id`, and anything that cannot yield a
 * schema-shaped key folds to UNMATCHED_OPERATION. It NEVER returns a key
 * derived from un-recognized request text — that is the whole point.
 *
 * Kept LOCAL on purpose: src/telemetry-stalls.cjs carries the sibling
 * `routePatternKey` discipline (known-segment based), but the two differ —
 * the stall mapper resolves against a known-segment set because its input is
 * an arbitrary span label, while THIS mapper's input is already a route-table
 * literal, so the charset filter alone is a complete closed-set defense.
 *
 * @param {unknown} method the HTTP verb (req.method)
 * @param {unknown} routePath the matched route's path literal (req.route.path)
 * @returns {string} a key satisfying OP_NAME_RE, or UNMATCHED_OPERATION
 */
export function routeOperationKey(method, routePath) {
  const verb = String(method ?? '').toLowerCase();
  if (!HTTP_VERB_RE.test(verb)) return UNMATCHED_OPERATION;
  // Express serves every GET route's HEAD variant through the SAME GET
  // handler (router v2: Route.prototype.dispatch normalizes 'head' → 'get'
  // internally) with req.method staying 'HEAD' — semantically it is the SAME
  // operation on the same resource, so it folds under the route's `get-` key.
  // Without this alias HEAD would mint a `head-*` key for every
  // GET-addressable route: a growth axis the route table's own `route.methods`
  // census never sees, big enough to exhaust REQUEST_MAX_OPERATIONS and reach
  // the aggregator's unsendable `__other__` accumulator — which voids whole
  // windows. With it, the census (derived through THIS mapper) is the
  // complete reachable key space. (OPTIONS needs no alias: the router answers
  // auto-OPTIONS without matching any route, so req.route stays undefined and
  // the request folds to the unmatched sink — one bounded key, in budget.)
  const verbKey = verb === 'head' ? 'get' : verb;
  // `req.route.path` is a string for pattern routes; Express regex/array
  // routes carry a RegExp/array there instead — nothing derivable, sink.
  if (typeof routePath !== 'string' || routePath.length === 0) return UNMATCHED_OPERATION;
  const segments = routePath.split('/').filter(Boolean);
  const mapped = [];
  for (const seg of segments) {
    if (mapped.length >= MAX_ROUTE_SEGMENTS) break;
    if (seg.startsWith(':')) {
      mapped.push('id'); // a path variable is `id` BY DESIGN
      continue;
    }
    mapped.push(STATIC_SEGMENT_RE.test(seg) ? seg : 'id');
  }
  const key = mapped.length ? `${verbKey}-${mapped.join('-')}` : `${verbKey}-root`;
  return OP_NAME_RE.test(key) && key.length <= OP_NAME_MAX_LENGTH ? key : UNMATCHED_OPERATION;
}

// The request-surface policy around the shared M1 aggregator. All
// collaborators are injectable so the unit tests run with a fake clock, a
// captured `send`, and a togglable consent — no timers, no IPC, no real
// waiting.
//
//   consent()  — live resolver: is the `operational-metrics` category enabled?
//   send(snapshot) — the IPC forward (server.js wires process.send).
//   intervalMs / setIntervalImpl — the flush cadence + injectable timer.
//   aggregator — injectable; defaults to one sized with REQUEST_MAX_OPERATIONS.
//
// Returns { recordRequest, flushNow, start }.
export function createRequestTelemetry({
  consent,
  send,
  intervalMs = REQUEST_FLUSH_MS,
  setIntervalImpl = setInterval,
  aggregator = createMetricAggregator({ maxOperations: REQUEST_MAX_OPERATIONS }),
} = {}) {
  // The consent gate, the IPC forward, the flushNow control flow and the
  // unref'd start() are the SHARED scaffold in src/telemetryProducer.js
  // (WARDEN-1352). This factory contributes only the request-specific parts:
  // the recorder below and the hasAnything predicate — this producer's window
  // shape is the operations[] aggregate, so a window is worth sending when
  // ANY request folded or anything was rejected.
  const gated = createConsentGatedWindow({
    consent,
    send,
    intervalMs,
    setIntervalImpl,
    aggregator,
    hasAnything: (snapshot) => snapshot.operations.length > 0 || snapshot.rejected > 0,
  });
  const isEnabled = gated.isEnabled;

  // Fold ONE request observation: the verb + matched route pattern, the
  // wall-clock duration, and the ok/fail verdict the wiring computes as
  // `res.statusCode < 500` (a 4xx is a served answer about the caller's
  // request; a 5xx is THIS server failing). Returns false when consent is off
  // or the observation is degenerate; NEVER throws — this runs on the close
  // path of a process whose job is not to observe itself.
  function recordRequest(method, routePath, durationMs, ok) {
    try {
      if (!isEnabled()) return false;
      const key = routeOperationKey(method, routePath);
      return aggregator.record(key, durationMs, { ok: ok !== false });
    } catch {
      // Defensive: the mapping and the aggregator are pure string/number
      // handling and are not expected to throw for any input, but this runs on
      // every request's close — it must not be able to take out that path.
      return false;
    }
  }

  return { recordRequest, flushNow: gated.flushNow, start: gated.start };
}
