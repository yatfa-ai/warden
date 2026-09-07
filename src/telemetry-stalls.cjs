'use strict';

// Telemetry SERVER-STALL aggregator (WARDEN-1278) — the bounded fold that turns
// the server child's event-loop freezes into ONE aggregate per flush window.
//
// WHY THIS EXISTS. The backend runs as a FORKED CHILD of the Electron main
// process, and until the v6 schema bump the wire had no `server` runtime — so
// the heaviest worker in the app (SSH, tmux, config reads, background sweeps)
// could emit NO telemetry event under ANY consent, by construction. Meanwhile
// its stall machinery (src/loop-monitor.js, WARDEN-977) has been detecting
// multi-second freezes WITH attribution the whole time and delivering them only
// to local channels (stalls.jsonl, stderr, GET /api/diagnostics/stalls). Those
// channels are the OWNER's on-demand read surface and are untouched by this
// module; telemetry is strictly ADDITIVE beside them.
//
// WHY AGGREGATES AND NOT ROWS. The owner's local journal carries hundreds of
// repeated freezes. One persisted row per stall is exactly the volume blowup
// the operational-metrics slice already refused (see src/telemetry-metrics.cjs).
// So this folds a window of stalls into a fixed-size accumulator and retains no
// per-stall row: one window, one event.
//
// THE THREE BOUNDS, mirroring the M1 aggregator so the two read the same way:
//   1. FIXED BUCKET BOUNDARIES — a lag histogram with a constant number of
//      counters. Folding 2 stalls or 2,000 costs the same memory.
//   2. maxCulprits CAP on distinct attribution keys — keys beyond the cap fold
//      into the reserved OVERFLOW_CULPRIT, so the key set can never grow
//      without bound.
//   3. maxNameLength CAP on the key itself — an over-long key is REJECTED, not
//      truncated, so a key can never carry a payload.
//
// WHY CJS IN src/: the call site is the BACKEND SERVER (ESM, src/server.js) and
// a `.cjs` file is CommonJS regardless of the package's "type": "module", so one
// artifact serves the server AND stays require()-able from the Electron main
// process — the discipline src/telemetry-consent.cjs and src/telemetry-metrics
// .cjs established. Everything here is PURE and ZERO-DEPENDENCY (no `require`)
// so it loads standalone under `node --test`.
//
// ---------------------------------------------------------------------------
// THE CULPRIT-KEY RULE (read this before wiring a new span label)
// ---------------------------------------------------------------------------
// A stall record's attribution labels come from loop-monitor spans, and ONE of
// those sources is NOT a closed set: src/server.js labels every request
// `${req.method} ${requestLabelPath(req.path)}`, and requestLabelPath only
// collapses unsafe characters and truncates — an agent name, a chat name or a
// session id made of `[A-Za-z0-9/._-]` survives VERBATIM into the label. A label
// is therefore NEVER an aggregate key here. `culpritKey` below maps each label
// onto a CLOSED SET (a route pattern, a sweep name, a sync-io label) or folds it
// into a reserved bucket, and the schema validator independently enforces the
// resulting kebab-case shape — so the guarantee is structural at two layers, not
// a caller promise.

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

// Ascending INCLUSIVE upper bounds, in milliseconds, for the LAG histogram. A
// stall is by definition >1s (the loop-monitor threshold), so the range starts
// where stalls start and stretches to the "the app looked dead" tail the owner's
// journal actually contains.
const DEFAULT_LAG_BOUNDARIES_MS = Object.freeze([
  1000, 2000, 5000, 10000, 30000,
]);

// Max distinct culprit keys retained per window. The reserved overflow key is
// NOT counted against this cap, so the key count is at most maxCulprits + 1.
// Deliberately small: attribution is a LEAD LIST, not a log.
const DEFAULT_MAX_CULPRITS = 32;

// Max characters in a culprit key. Keys are closed-set literals by construction
// (see THE CULPRIT-KEY RULE above), so this is generous — it exists to bound
// memory and to make an accidental "key built from user data" bug fold rather
// than ship a long string.
const DEFAULT_MAX_NAME_LENGTH = 64;

// Reserved key that excess / unmappable culprits fold into. Kebab-case (so it
// passes the schema's culprit-name pattern) and prefixed so it cannot collide
// with a real route-pattern or sweep key. A caller that passes this key
// explicitly is treated as a folded key (it is reserved, not claimable).
const OVERFLOW_CULPRIT = 'other';

// The key a stall with NO attribution at all folds into — an honest "nothing we
// measure was running", which is itself the most interesting reading in the set
// (it means the block was somewhere we do not instrument).
const UNATTRIBUTED_CULPRIT = 'unattributed';

// ---------------------------------------------------------------------------
// Culprit-key mapping — the closed-set projection of a loop-monitor span label.
// ---------------------------------------------------------------------------

// A key that already satisfies the wire contract. LETTERS AND HYPHENS ONLY —
// deliberately STRICTER than the schema's culprit pattern (which also permits
// digits, since it is shared with `operational-metrics` operation names).
//
// WHY NO DIGITS, which is not obvious and is a real hazard rather than taste:
// the redaction engine's generic high-entropy rule (electron/telemetry-redact
// .cjs rule 4) replaces any run of >=20 characters from the secret charset that
// mixes >=2 of {lowercase, uppercase, digit} with `[REDACTED:secret]`. A key
// like `get-api-oauth2-callback-id` is 26 characters of lowercase AND digits —
// it matches, and redaction rewrites it to `[REDACTED:secret]`, which then FAILS
// the schema's culprit pattern and causes the pipeline's validator to drop THE
// ENTIRE EVENT. The whole window would vanish silently, and the cause would be a
// route someone added months earlier. A pure lowercase+hyphen key is only ONE
// character class, so rule 4 can never fire on it, whatever its length. Verified
// against the real redactor, not reasoned about: see the redaction-immunity test
// in web/telemetry-stalls.test.mjs.
//
// A route segment carrying a digit therefore folds to the `id` placeholder — a
// lost distinction, which is cheap, instead of a lost event, which is not.
const SAFE_KEY_RE = /^[a-z][a-z-]{0,63}$/;

// A request span label, e.g. `GET /api/sessions/abc-123` or `POST /api/send`.
const REQUEST_LABEL_RE = /^([A-Z]+)\s+(\/\S*)$/;

// A sync-io span label from instrumentSyncIo, e.g. `fs.readFileSync`,
// `child_process.spawnSync`. A CLOSED set by construction (SYNC_FS_METHODS /
// SYNC_CHILD_PROCESS_METHODS are frozen literal lists).
const SYNC_IO_LABEL_RE = /^(fs|child_process)\.([A-Za-z]+)$/;

// A sweep / websocket span label, e.g. `sweep:budget`, `ws:pane-monitor`. Also
// closed by construction — every one is a literal in src/. The SCOPE half is
// pinned to a closed set (below) rather than a shape, on the same reasoning as
// the route-segment set: a shape test is satisfiable by user data, membership
// is not.
const SCOPED_LABEL_RE = /^([a-z]+):([a-z][a-z0-9-]*)$/;
const LABEL_SCOPES = new Set(['sweep', 'ws']);

/**
 * Map a ROUTE PATH onto its route-PATTERN key.
 *
 * The transform is deliberately one-way and lossy: each path segment is either a
 * literal from the KNOWN-SEGMENT SET or it is replaced by the placeholder `id`.
 *
 * THE SET IS THE GUARANTEE, and it is why this is not "does the segment look
 * like a route word?". A shape test (lowercase + hyphens) would pass an agent
 * name like `myproject-researcher` and a chat title like `refactor-auth`
 * straight onto the wire — exactly the leak the culprit-key rule exists to
 * prevent. Membership in a closed set cannot be satisfied by user data at all.
 * The set is INJECTED by the caller (src/server.js derives it live from the
 * express router, so it can never drift from the real route table) and defaults
 * to ROUTE_SEGMENTS below for standalone use.
 *
 * `/api/sessions/abc-123`     → `get-api-sessions-id`
 * `/api/collections/7/agents` → `get-api-collections-id-agents`
 * `/assets/index-a1b2.js`     → `get-id`
 *
 * A path that cannot be mapped to a safe key at all returns null, and the caller
 * folds it into the overflow bucket — never into a key built from its text.
 */
const MAX_ROUTE_SEGMENTS = 4;

// Every STATIC segment of warden's route table (src/server.js), as a closed
// literal set. Used when no live set is injected — the unit tests run against
// this, and src/telemetry-stalls-coverage.test.js fails the build if a route
// added to server.js introduces a segment this set does not name. A missing
// segment is not a leak (it folds to `id`), it is a LOSS OF RESOLUTION: the
// route stops being distinguishable in the aggregate.
const ROUTE_SEGMENTS = Object.freeze([
  'activity', 'agent-notes', 'agent-states', 'agents', 'api', 'budget', 'chats',
  'claude-session', 'claude-sessions', 'claude-sessions-all',
  'claude-sessions-search', 'collections', 'companion', 'config', 'diagnostics',
  'directives', 'discover', 'file-exists', 'fleet', 'health', 'hosts', 'key',
  'kill', 'pane', 'pane-export', 'pins', 'read-file', 'rename', 'reset',
  'respawn', 'resume', 'search-files', 'search-pane', 'send', 'series',
  'session-kill', 'session-tags', 'sessions', 'spawn', 'ssh-hosts', 'stalls',
  'stats', 'status', 'telemetry-test', 'this-session', 'uninstall',
  'webhook-test',
]);
const DEFAULT_SEGMENT_SET = new Set(ROUTE_SEGMENTS);

const HTTP_VERB_RE = /^[a-z]+$/;

function routePatternKey(method, routePath, knownSegments) {
  const verb = String(method).toLowerCase();
  if (!HTTP_VERB_RE.test(verb)) return null;
  const known = knownSegments instanceof Set ? knownSegments : DEFAULT_SEGMENT_SET;
  const segments = String(routePath).split('/').filter(Boolean);
  const mapped = [];
  for (const seg of segments) {
    if (mapped.length >= MAX_ROUTE_SEGMENTS) break;
    // Known AND digit-free: see SAFE_KEY_RE's note on the redactor's
    // high-entropy rule. A digit-bearing segment folds to the placeholder
    // rather than risking the whole event.
    mapped.push(known.has(seg) && /^[a-z-]+$/.test(seg) ? seg : 'id');
  }
  const key = mapped.length ? `${verb}-${mapped.join('-')}` : `${verb}-root`;
  return SAFE_KEY_RE.test(key) ? key : null;
}

/**
 * Project ONE loop-monitor span label onto a closed-set culprit key.
 *
 * Returns a safe kebab-case key, or OVERFLOW_CULPRIT when the label is of a
 * shape this module does not recognize. It NEVER returns a key derived from
 * un-recognized text — that is the whole point.
 *
 * @param {unknown} label a loop-monitor span label
 * @param {Set<string>} [knownSegments] the live route-segment set (see above)
 * @returns {string} a key matching SAFE_KEY_RE
 */
function culpritKey(label, knownSegments) {
  if (typeof label !== 'string' || label.length === 0) return OVERFLOW_CULPRIT;

  const request = REQUEST_LABEL_RE.exec(label);
  if (request) {
    return routePatternKey(request[1], request[2], knownSegments) || OVERFLOW_CULPRIT;
  }

  const syncIo = SYNC_IO_LABEL_RE.exec(label);
  if (syncIo) {
    // `fs.readFileSync` → `fs-read-file-sync`: kebab-cased so ONE key shape
    // travels on the wire, and the dot (which reads as a hostname to a naive
    // scanner) never leaves this module.
    const kebab = syncIo[2].replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
    const key = `${syncIo[1].replace('_', '-')}-${kebab}`;
    return SAFE_KEY_RE.test(key) ? key : OVERFLOW_CULPRIT;
  }

  const scoped = SCOPED_LABEL_RE.exec(label);
  if (scoped) {
    // Both halves must be known: the scope AND the name. Every scoped label in
    // src/ is a compile-time literal (`sweep:budget`, `ws:pane-monitor`), so a
    // scoped label we do not recognize is either a new call site (fold it — a
    // lost distinction, not a leak) or something dynamic (fold it — the point).
    if (!LABEL_SCOPES.has(scoped[1]) || !SCOPED_LABEL_NAMES.has(label)) return OVERFLOW_CULPRIT;
    const key = `${scoped[1]}-${scoped[2]}`;
    return SAFE_KEY_RE.test(key) ? key : OVERFLOW_CULPRIT;
  }

  // A bare literal label (`unknown`, `sync-work`) is allowed through only when
  // it ALREADY satisfies the wire contract AND is a KNOWN literal — an unknown
  // bare string is folded, because a bare string is exactly the shape a stray
  // user-supplied label would take.
  return BARE_LABELS.has(label) ? label : OVERFLOW_CULPRIT;
}

// The bare (unscoped, unprefixed) span labels src/ actually emits. Closed by
// construction: `unknown` is loop-monitor's normalizeLabel fallback for a
// missing/empty label. Anything else bare folds to the overflow bucket.
const BARE_LABELS = new Set(['unknown']);

// The SCOPED span labels src/ actually emits, as whole literals. Sourced from
// the trace() call sites: the resident sweep supervisors (src/server.js —
// lifecycle / budget), companion.js's pane-delta sweep, and the websocket pane
// monitor. src/telemetry-stalls-coverage.test.js fails the build if a new
// literal appears in src/ that this set does not name, AND if this set names one
// src/ no longer emits.
//
// WARDEN-1274 removed `sweep:attention`: the 60s attention webhook sweep
// (tickAttention + its supervisor) was retired with the rest of the regex-guessed
// alert machinery, so no call site emits that label any more. It is deliberately
// NOT kept "just in case" — a stale entry promises a resolution the codebase
// cannot produce, and the coverage guard fails the build on exactly that drift.
// A stall attributed to some future attention sweep would fold to the overflow
// bucket, which is the correct answer for a label src/ does not emit.
const SCOPED_LABEL_NAMES = new Set([
  'sweep:lifecycle', 'sweep:budget', 'sweep:pane-delta',
  'ws:pane-monitor',
]);

// ---------------------------------------------------------------------------
// Option validation (wire-up time — throws, exactly like the M1 aggregator:
// invalid factory options are programming errors, surfaced at construction)
// ---------------------------------------------------------------------------

function normalizeBoundaries(buckets) {
  if (buckets === undefined) return DEFAULT_LAG_BOUNDARIES_MS.slice();
  if (!Array.isArray(buckets) || buckets.length === 0) {
    throw new TypeError('createStallAggregator: buckets must be a non-empty array of ms boundaries');
  }
  const out = [];
  for (let i = 0; i < buckets.length; i += 1) {
    const b = buckets[i];
    if (typeof b !== 'number' || !Number.isFinite(b) || b <= 0) {
      throw new TypeError('createStallAggregator: every bucket boundary must be a finite number > 0');
    }
    if (i > 0 && b <= buckets[i - 1]) {
      throw new TypeError('createStallAggregator: bucket boundaries must be strictly ascending');
    }
    out.push(b);
  }
  return out;
}

function normalizePositiveInt(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new TypeError(`createStallAggregator: ${label} must be a positive integer`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a bounded server-stall aggregator.
 *
 * @param {object} [options]
 * @param {number[]} [options.buckets]        Ascending inclusive ms lag boundaries.
 * @param {number}   [options.maxCulprits]    Cap on distinct culprit keys.
 * @param {number}   [options.maxNameLength]  Cap on culprit-key length.
 * @param {Set<string>|(() => Set<string>)} [options.knownSegments] The live
 *   route-segment set (see routePatternKey). May be a THUNK, and src/server.js
 *   passes one: the routes are registered across the whole module, so the set
 *   can only be derived after the last one — a thunk is resolved on first use
 *   (and memoized) rather than at wire-up, which would capture a partial table.
 *   Omitted, the module's own ROUTE_SEGMENTS literal is used.
 * @param {() => number} [options.now]        Injectable clock (tests / windows).
 */
function createStallAggregator(options) {
  const opts = options || {};
  const boundaries = normalizeBoundaries(opts.buckets);
  const maxCulprits = normalizePositiveInt(opts.maxCulprits, DEFAULT_MAX_CULPRITS, 'maxCulprits');
  const maxNameLength = normalizePositiveInt(opts.maxNameLength, DEFAULT_MAX_NAME_LENGTH, 'maxNameLength');
  const segmentSource = opts.knownSegments;
  if (segmentSource !== undefined
    && !(segmentSource instanceof Set)
    && typeof segmentSource !== 'function') {
    throw new TypeError('createStallAggregator: knownSegments must be a Set or a function returning one');
  }
  let resolvedSegments = segmentSource instanceof Set ? segmentSource : null;
  let segmentsResolved = resolvedSegments !== null;
  function knownSegments() {
    if (!segmentsResolved) {
      segmentsResolved = true;
      // A thunk that throws or returns a non-Set costs RESOLUTION, never
      // SAFETY: the fallback set still folds every unknown segment to `id`.
      try {
        const s = typeof segmentSource === 'function' ? segmentSource() : null;
        resolvedSegments = s instanceof Set && s.size > 0 ? s : DEFAULT_SEGMENT_SET;
      } catch {
        resolvedSegments = DEFAULT_SEGMENT_SET;
      }
    }
    return resolvedSegments || DEFAULT_SEGMENT_SET;
  }
  if (opts.now !== undefined && typeof opts.now !== 'function') {
    throw new TypeError('createStallAggregator: now must be a function returning a timestamp');
  }
  const now = opts.now || (() => Date.now());

  const bucketCount = boundaries.length + 1; // + overflow bucket

  let count = 0;
  let totalMs = 0;
  let maxMs = 0;
  let buckets = Array.from({ length: bucketCount }, () => 0);
  /** @type {Map<string, {count: number, totalOverlapMs: number}>} */
  let culprits = new Map();
  let rejected = 0;
  let startedAt = now();

  // First boundary the value is <= to; else the trailing overflow bucket.
  function bucketIndexFor(lagMs) {
    for (let i = 0; i < boundaries.length; i += 1) {
      if (lagMs <= boundaries[i]) return i;
    }
    return boundaries.length;
  }

  function foldCulprit(key, overlapMs) {
    const existing = culprits.get(key);
    if (existing) {
      existing.count += 1;
      existing.totalOverlapMs += overlapMs;
      return;
    }
    // The reserved key is never claimable: it is created on demand and never
    // counted against the cap, so the folded bucket cannot itself be evicted.
    if (key !== OVERFLOW_CULPRIT && culprits.size >= maxCulprits) {
      foldCulprit(OVERFLOW_CULPRIT, overlapMs);
      return;
    }
    culprits.set(key, { count: 1, totalOverlapMs: overlapMs });
  }

  /**
   * Fold ONE stall record (the shape src/loop-monitor.js's buildStallRecord
   * produces) into the window. Retains no per-stall row.
   *
   * Degenerate input is REJECTED, never thrown: a diagnostic must never be able
   * to take down the process it merely observes.
   *
   * @param {{lagMs: number, attribution?: Array<{label: string, overlapMs: number}>,
   *          syncTotals?: Array<{label: string, totalMs: number}>}} record
   * @returns {boolean} true when folded, false when rejected.
   */
  function record(stall) {
    if (!stall || typeof stall !== 'object') { rejected += 1; return false; }
    const lagMs = stall.lagMs;
    if (typeof lagMs !== 'number' || !Number.isFinite(lagMs) || lagMs < 0) { rejected += 1; return false; }

    count += 1;
    totalMs += lagMs;
    if (lagMs > maxMs) maxMs = lagMs;
    buckets[bucketIndexFor(lagMs)] += 1;

    // Attribution: the spans that overlapped the blocked window, projected onto
    // closed-set keys. A stall with none folds into `unattributed` rather than
    // vanishing — "nothing we measure was running" is a real reading.
    const attribution = Array.isArray(stall.attribution) ? stall.attribution : [];
    let attributed = 0;
    for (const entry of attribution) {
      if (!entry || typeof entry !== 'object') continue;
      const rawKey = culpritKey(entry.label, knownSegments());
      // maxNameLength is a REJECT, not a truncate — a key that long is a bug,
      // and a truncated key would be a silently wrong aggregate.
      const key = rawKey.length <= maxNameLength ? rawKey : OVERFLOW_CULPRIT;
      const overlap = entry.overlapMs;
      const overlapMs = typeof overlap === 'number' && Number.isFinite(overlap) && overlap >= 0
        ? Math.round(overlap)
        : 0;
      foldCulprit(key, overlapMs);
      attributed += 1;
    }
    if (attributed === 0) foldCulprit(UNATTRIBUTED_CULPRIT, Math.round(lagMs));

    // The per-label SYNC aggregate, folded onto the same culprit keys. This is
    // the shape the span ring alone cannot show and the one the loop-monitor's
    // own header calls out: 4,000 calls of 2ms each are each below the ring
    // floor and take no span slot, but they are 8 seconds of blocked loop. A
    // window that carried only `attribution` would report zero sync culprits and
    // read as "synchronous I/O was not involved" — the exact false negative
    // WARDEN-977 built summarizeSyncTotals to prevent. `totalMs` is the blocking
    // time, which is the same quantity `totalOverlapMs` means for a span, so the
    // two fold into one map rather than two.
    const syncTotals = Array.isArray(stall.syncTotals) ? stall.syncTotals : [];
    for (const entry of syncTotals) {
      if (!entry || typeof entry !== 'object') continue;
      const rawKey = culpritKey(entry.label, knownSegments());
      const key = rawKey.length <= maxNameLength ? rawKey : OVERFLOW_CULPRIT;
      const total = entry.totalMs;
      const totalOverlapMs = typeof total === 'number' && Number.isFinite(total) && total >= 0
        ? Math.round(total)
        : 0;
      foldCulprit(key, totalOverlapMs);
    }
    return true;
  }

  /**
   * The current window as a plain, freshly-copied object. Does NOT mutate or
   * reset anything.
   *
   * Shape: { startedAt, endedAt, count, totalMs, maxMs, boundaries, buckets,
   *          culprits: [{culprit, count, totalOverlapMs}], rejected }
   * Culprits are sorted costliest-first (then by key, so the ordering is
   * deterministic for a test and stable across two equal windows).
   */
  function snapshot() {
    const list = [...culprits.entries()]
      .map(([culprit, e]) => ({ culprit, count: e.count, totalOverlapMs: Math.round(e.totalOverlapMs) }))
      .sort((a, b) => b.totalOverlapMs - a.totalOverlapMs
        || b.count - a.count
        || (a.culprit < b.culprit ? -1 : a.culprit > b.culprit ? 1 : 0));
    return {
      startedAt,
      endedAt: now(),
      count,
      totalMs: Math.round(totalMs),
      maxMs: Math.round(maxMs),
      boundaries: boundaries.slice(),
      buckets: buckets.slice(),
      culprits: list,
      rejected,
    };
  }

  /**
   * Window boundary: return the current window AND reset to an empty one, so two
   * consecutive windows never double-count. The returned snapshot is a detached
   * copy and is unaffected by later record() calls.
   */
  function flush() {
    const out = snapshot();
    count = 0;
    totalMs = 0;
    maxMs = 0;
    buckets = Array.from({ length: bucketCount }, () => 0);
    culprits = new Map();
    rejected = 0;
    startedAt = out.endedAt; // next window starts where this one ended
    return out;
  }

  return {
    record,
    snapshot,
    flush,
    // Echoed effective configuration, so a caller (and the tests) can assert the
    // bounds without reaching into internals.
    boundaries: boundaries.slice(),
    maxCulprits,
    maxNameLength,
  };
}

module.exports = {
  DEFAULT_LAG_BOUNDARIES_MS,
  DEFAULT_MAX_CULPRITS,
  DEFAULT_MAX_NAME_LENGTH,
  OVERFLOW_CULPRIT,
  UNATTRIBUTED_CULPRIT,
  ROUTE_SEGMENTS,
  SCOPED_LABEL_NAMES,
  BARE_LABELS,
  SAFE_KEY_RE,
  culpritKey,
  createStallAggregator,
};
