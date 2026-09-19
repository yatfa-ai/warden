// Event-loop stall monitor for the SERVER process (WARDEN-977).
//
// WHY THIS EXISTS: warden's backend runs as a FORKED CHILD of the Electron main
// process (electron/main.cjs forks src/server.js). The event-loop freeze
// heartbeat that already exists — electron/telemetry-source.cjs, which emits a
// `performance-stall` with a `lagMs` and a `source` — runs ONLY in the main
// process. A multi-second block of the SERVER child therefore produced no event,
// no log and no signal of any kind: three passes at the ~10s Settings hang
// (WARDEN-828 / WARDEN-831 / WARDEN-915) could not name the culprit because
// nothing observed it. This module is the server-side counterpart, and it adds
// the thing a bare duration cannot give you: ATTRIBUTION.
//
// TWO LAYERS, BOTH CHEAP ENOUGH TO RUN ALWAYS:
//
//  1. HEARTBEAT (detection). A timer at `heartbeatMs`; when a tick arrives more
//     than `thresholdMs` past its expected cadence, the loop was blocked for
//     roughly that overdue gap. Same decision rule and same vocabulary as the
//     main-process heartbeat (`isStall`, `type: 'performance-stall'`, `lagMs`,
//     `source: 'event-loop'`) so there is ONE stall vocabulary, not two — the
//     only new field is `runtime: 'server'` plus the attribution block. Cost:
//     one timer callback per second that does two subtractions.
//
//  2. SPANS (attribution). Callers mark work with begin()/end() — one request,
//     one sweep, one measured synchronous op — into a bounded ring. When the
//     heartbeat detects a stall, `attributeStall` reports the spans that OVERLAP
//     the blocked window, longest overlap first. Cost per marked unit of work:
//     one object, one clock read, one array slot. No I/O, nothing synchronous
//     added to any request path. Alongside it, a per-label AGGREGATE of every
//     measured synchronous call in the window (`summarizeSyncTotals`) catches
//     the shape a ring cannot: a stall built from thousands of individually
//     cheap calls, which would otherwise report zero sync spans and read as
//     "synchronous I/O was not involved".
//
// The blocked window is [now - lagMs, now]: a synchronous block ends when the
// loop is released, which is when the late tick runs, so the block occupied
// (at least) the overdue gap immediately preceding this tick. A span that was
// open across that window — or a sync op measured inside it — is the lead.
//
// SYNC-I/O PROBE: `instrumentSyncIo` wraps the sync members of the `fs` and
// `child_process` module objects with a timer. Every call is aggregated; only
// calls at or above a floor (default 100ms) additionally take a ring slot.
// Every runtime sync site in src/ calls these through the module object
// (`import fs from 'node:fs'` → `fs.statSync(...)`), so one patch covers
// session, collection, companion, LLM, git and claude-session reads without
// touching those call sites — INCLUDING the hand-rolled fd-level windowed reads
// (openSync/readSync/closeSync), which the first cut of SYNC_FS_METHODS missed
// and which are the largest synchronous reads in the codebase. The one shape
// out of reach is a NAMED import (`import { spawnSync } from …`), which binds
// the function before the patch; src/ssh.js:492 is the only such site and it is
// a load-time win32 one-shot, not a runtime path.
//
// This ticket MEASURES the remaining synchronous sites (WARDEN-831 left them
// deliberately); it does not convert them (WARDEN-832 is the decision of record
// for that, and the conversion is explicitly out of scope here).
//
// This module is deliberately dependency-free (no src/ imports, no node
// builtins beyond a default clock) so it is unit-testable in isolation and can
// be imported from any module — including ones the server itself imports —
// without an import cycle. The DELIVERY of a stall record (durable log file,
// stderr line) is the caller's job, wired through `onStall`; src/stall-log.js
// owns the durable channel.

// ---------------------------------------------------------------------------
// Contract / defaults. The event-shape constants mirror
// electron/telemetry-source.cjs so a stall reads the same on both sides of the
// fork boundary.
// ---------------------------------------------------------------------------

export const STALL_TYPE = 'performance-stall';
export const STALL_SOURCE = 'event-loop';
export const STALL_RUNTIME = 'server';

// Expected cadence between ticks, and the overdue gap beyond it that counts as a
// stall. Same numbers as the main-process heartbeat: a tick that lands >1s late
// (i.e. >2s after the previous tick) means the loop was blocked. Sub-threshold
// lateness — GC, scheduler jitter, a busy but yielding loop — is NOT a stall and
// produces nothing, which is what keeps normal operation silent.
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 1000;
export const DEFAULT_STALL_THRESHOLD_MS = 1000;

// Ring sizes: enough recent work to attribute a stall, enough recent stalls to
// survive a look at /api/diagnostics/stalls, both hard-bounded so an always-on
// monitor can never grow memory.
export const DEFAULT_SPAN_RING_SIZE = 128;
export const DEFAULT_STALL_RING_SIZE = 50;

// A synchronous op faster than this is not a plausible multi-second culprit and
// is not worth a ring slot. Keeps the attribution ring signal, not noise.
//
// It does NOT mean sub-floor calls go unmeasured: a stall assembled from
// thousands of cheap calls (server.js's archive scan does a statSync per row;
// observer.js does a readdirSync per project then a statSync per file) is a
// dominant shape on a machine with real history, and it would report zero ring
// spans. Every call — floor or no floor — is therefore folded into the per-label
// aggregate below, which costs two integer adds and no allocation.
export const DEFAULT_SYNC_FLOOR_MS = 100;

// Per-label sync aggregate: bounded label count so a caller passing dynamic
// labels can never grow the map, with the overflow folded into one bucket
// rather than silently dropped (a dropped call is the false-negative this
// aggregate exists to prevent).
export const MAX_SYNC_AGGREGATE_LABELS = 32;
export const SYNC_AGGREGATE_OVERFLOW_LABEL = '(other)';

// Attribution is a lead list, not a log: the top few overlapping spans.
export const MAX_ATTRIBUTION_ENTRIES = 6;

// Labels are curated strings from OUR call sites (a route pattern, a sweep name,
// a wrapped function name) — never user input, never a path or a host. Truncated
// defensively so a caller mistake cannot bloat the ring or the log line.
export const MAX_LABEL_LENGTH = 80;

// The sync members worth timing. `fs` covers the reads/writes WARDEN-831 left
// synchronous; `child_process` covers the spawnSync/execSync family (a remote
// tmux probe is the multi-second shape this ticket is hunting).
//
// COVER THE WHOLE FAMILY, NOT JUST TODAY'S CALL SITES. A method missing from
// this list is not a small gap — it is a FALSE NEGATIVE that reads as
// exoneration: the enclosing request span still names the route, but the record
// carries no `fs.*` entry, so the owner reads "synchronous I/O was not
// involved" and the follow-up ticket is written away from the real cause. That
// is strictly worse than a bare duration. The first cut of this list omitted the
// file-DESCRIPTOR primitives, which is precisely where the largest synchronous
// reads in src/ live (see the fd group below), so the list is now maintained as
// the fs sync family rather than as a transcript of current callers — and
// src/loop-monitor-coverage.test.js fails the build if a runtime call site in
// src/ ever uses a sync member this list does not name.
export const SYNC_FS_METHODS = Object.freeze([
  // Whole-file and path-level operations.
  'readFileSync', 'writeFileSync', 'appendFileSync', 'readdirSync',
  'statSync', 'lstatSync', 'existsSync', 'realpathSync',
  'mkdirSync', 'renameSync', 'unlinkSync', 'rmSync', 'readlinkSync',
  // FILE-DESCRIPTOR level — the windowed-read primitives. Every hand-rolled
  // bounded read in src/ is built from these: claudeSessions.js's transcript
  // window (one readSync of up to SESSION_VIEW_MAX_BYTES = 400KB, the single
  // largest sync read in the codebase and on a per-REQUEST route), server.js's
  // archive header scan (open/read/close per hit, in a loop) and observer.js's
  // transcript tail. Their only path-level call is a `statSync` that is
  // microseconds, so without these the whole path recorded nothing at all.
  'openSync', 'closeSync', 'readSync', 'writeSync', 'readvSync', 'writevSync',
  'fstatSync', 'ftruncateSync', 'truncateSync', 'fsyncSync', 'fdatasyncSync',
  // Directory, temp and copy primitives — each a syscall that can block for
  // seconds on a slow, full or network filesystem.
  'mkdtempSync', 'opendirSync', 'rmdirSync', 'copyFileSync', 'cpSync',
  'accessSync', 'globSync',
  // Metadata mutations. Cheap on a healthy disk, unbounded on a sick one.
  'chmodSync', 'chownSync', 'utimesSync', 'symlinkSync', 'linkSync',
]);
export const SYNC_CHILD_PROCESS_METHODS = Object.freeze([
  'execSync', 'execFileSync', 'spawnSync',
]);

// ---------------------------------------------------------------------------
// Pure decision helpers (unit-testable without a timer or a clock).
// ---------------------------------------------------------------------------

/**
 * A tick is a stall iff its overdue gap (elapsed minus the expected interval)
 * exceeds the threshold. Byte-identical semantics to the main-process
 * `isStall` in electron/telemetry-source.cjs — one rule for both runtimes.
 */
export function isStall(overdueMs, thresholdMs = DEFAULT_STALL_THRESHOLD_MS) {
  const thresh = typeof thresholdMs === 'number' ? thresholdMs : DEFAULT_STALL_THRESHOLD_MS;
  return typeof overdueMs === 'number' && Number.isFinite(overdueMs) && overdueMs > thresh;
}

export function normalizeLabel(label) {
  const s = typeof label === 'string' && label ? label : 'unknown';
  return s.length > MAX_LABEL_LENGTH ? s.slice(0, MAX_LABEL_LENGTH) : s;
}

/**
 * Attribute a blocked window to the work that overlapped it.
 *
 * @param {Array<{label: string, start: number, end: number|null}>} spans
 *   Recent work spans; `end === null` means still open.
 * @param {number} windowStart monotonic ms — start of the blocked window
 * @param {number} windowEnd   monotonic ms — end of the blocked window (the late tick)
 * @returns {Array<{label: string, overlapMs: number, open: boolean, durationMs: number}>}
 *   Overlapping spans, longest overlap first, capped at MAX_ATTRIBUTION_ENTRIES.
 *   Empty when nothing was marked — an honest "nothing we measure was running"
 *   rather than a fabricated culprit.
 */
export function attributeStall(spans, windowStart, windowEnd) {
  if (!Array.isArray(spans) || !(windowEnd > windowStart)) return [];
  const out = [];
  for (const span of spans) {
    if (!span || typeof span.start !== 'number') continue;
    const open = span.end == null;
    // An open span is treated as running through the end of the window (it was,
    // by definition — nothing ended it).
    const spanEnd = open ? windowEnd : span.end;
    const overlap = Math.min(spanEnd, windowEnd) - Math.max(span.start, windowStart);
    if (!(overlap > 0)) continue;
    out.push({
      label: normalizeLabel(span.label),
      overlapMs: Math.round(overlap),
      open,
      durationMs: Math.round(spanEnd - span.start),
    });
  }
  // Longest overlap wins. TIEBREAK CAVEAT: an open span that started long before
  // the window clamps to the FULL window overlap, so it ties with a real culprit
  // and then wins on durationMs — sorting the long-lived span first. This is
  // currently unreachable (server.js has no SSE or long-poll route, and
  // `res.on('close')` closes every request span), and that is the invariant it
  // depends on: the first streaming endpoint added would leave one span open for
  // its whole lifetime and poison the head of every stall record. If one is
  // added, either leave it unspanned or rank open spans below closed ones.
  out.sort((a, b) => b.overlapMs - a.overlapMs || b.durationMs - a.durationMs);
  return out.slice(0, MAX_ATTRIBUTION_ENTRIES);
}

/**
 * Collapse a window's per-label sync aggregate into a ranked lead list.
 *
 * This is the answer to the stall shape the ring alone cannot show: 4000 calls
 * of 2ms each are individually below the floor and take no ring slot, but they
 * are 8 seconds of blocked loop. "fs.statSync ×4012 = 7901ms" is stronger
 * evidence than any single span — and unlike the ring it cannot report zero
 * while synchronous I/O is the thing holding the loop.
 *
 * @param {Map<string, {calls: number, totalMs: number}>} agg
 * @returns {Array<{label: string, calls: number, totalMs: number}>} costliest first
 */
export function summarizeSyncTotals(agg) {
  if (!agg || typeof agg.entries !== 'function') return [];
  const out = [];
  for (const [label, e] of agg.entries()) {
    if (!e || !e.calls) continue;
    out.push({ label, calls: e.calls, totalMs: Math.round(e.totalMs) });
  }
  out.sort((a, b) => b.totalMs - a.totalMs || b.calls - a.calls);
  return out.slice(0, MAX_ATTRIBUTION_ENTRIES);
}

/**
 * Build the stall record. Reuses the main-process `performance-stall` shape
 * (type / lagMs / source / timestamp) and adds the server runtime tag plus the
 * attribution block that makes a duration actionable.
 */
export function buildStallRecord({ lagMs, attribution, syncTotals, timestamp, heartbeatMs, thresholdMs, uptimeMs, pid, runtime }) {
  const record = {
    type: STALL_TYPE,
    // WARDEN-1376 — the runtime the stall happened in. The server keeps the
    // module default; the main process creates its monitor with
    // `runtime: 'main'` so the shared journal (and the diagnostics dialog that
    // reads it) can tell the two processes' freezes apart.
    runtime: typeof runtime === 'string' && runtime ? runtime : STALL_RUNTIME,
    source: STALL_SOURCE,
    timestamp: new Date(timestamp).toISOString(),
    lagMs: Math.round(lagMs),
    heartbeatMs,
    thresholdMs,
    attribution: Array.isArray(attribution) ? attribution : [],
    // Every synchronous op measured in this window, aggregated per label —
    // including the ones below the ring floor. Sits beside `attribution` because
    // the two answer different questions: which work was open across the block,
    // and how much synchronous time that work actually spent.
    syncTotals: Array.isArray(syncTotals) ? syncTotals : [],
  };
  if (typeof uptimeMs === 'number') record.uptimeMs = Math.round(uptimeMs);
  if (typeof pid === 'number') record.pid = pid;
  return record;
}

/**
 * One-line human summary of a stall — the stderr form the owner reads in the
 * `[server]` console output without enabling anything.
 */
export function formatStallLine(record) {
  const who = (record.attribution || [])
    .map((a) => `${a.label} (${a.overlapMs}ms${a.open ? ', still open' : ''})`)
    .join(', ');
  // WARDEN-1376 — name the runtime the record carries ('server' for the
  // module's own records; 'main' once the Electron main process shares this
  // monitor), so a shared journal line says WHO froze, not just for how long.
  const rt = record && typeof record.runtime === 'string' && record.runtime ? record.runtime : STALL_RUNTIME;
  const line = `[warden:stall] ${rt} event loop blocked ${record.lagMs}ms — during: ${who || 'nothing instrumented was running'}`;
  // The aggregate is what makes a death-by-a-thousand-statSync stall legible on
  // the console line, so it belongs here and not only in the JSON.
  const sync = (record.syncTotals || [])
    .map((s) => `${s.label} ×${s.calls} ${s.totalMs}ms`)
    .join(', ');
  return sync ? `${line} | sync: ${sync}` : line;
}

// ---------------------------------------------------------------------------
// The monitor.
// ---------------------------------------------------------------------------

/**
 * Create an event-loop stall monitor.
 *
 * Inert until `start()`: spans are recorded (they are free and let a stall that
 * happens one tick after start still be attributable), but no timer runs, no
 * record is built and `onStall` is never called. So importing this module — in
 * the CLI, in a unit test, in a tool that only wants `app` — costs nothing.
 *
 * @param {object} [opts]
 * @param {number} [opts.heartbeatMs]  expected tick cadence
 * @param {number} [opts.thresholdMs]  overdue gap that counts as a stall
 * @param {number} [opts.spanRingSize] bounded recent-work ring
 * @param {number} [opts.stallRingSize] bounded recent-stall ring
 * @param {number} [opts.syncFloorMs]  minimum measured sync duration worth a span
 * @param {() => number} [opts.now]        monotonic clock (ms) for all lag math
 * @param {() => number} [opts.wallClock]  wall clock (ms) for the record timestamp
 * @param {(record: object) => void} [opts.onStall] delivery sink (never throws through)
 * @param {string} [opts.runtime]          record runtime tag ('server' default; the
 *                                          main process passes 'main' — WARDEN-1376)
 * @param {number} [opts.maxCredibleLagMs] overdue gap above which a tick is a
 *                                          SUSPENSION, not a stall (default: no
 *                                          ceiling — the server keeps today's
 *                                          behavior; main opts in — WARDEN-1376)
 * @param {(from: number, to: number, wallFrom?: number, wallTo?: number) => boolean} [opts.isSuspendBoundary]
 *                                          predicate the tick consults: a lag
 *                                          window spanning a suspend→resume is
 *                                          the wake tick (and its resume storm),
 *                                          not a loop block (WARDEN-1376).
 *                                          WARDEN-1406 — called with FOUR
 *                                          arguments: the monotonic (from, to)
 *                                          it always received, plus the
 *                                          WALL-CLOCK bounds of the same tick
 *                                          gap. Suspend windows arrive in wall
 *                                          time while the lag math is
 *                                          monotonic, so a domain-aware caller
 *                                          compares wall vs wall via the last
 *                                          two arguments; main's two-argument
 *                                          predicate keeps working unchanged
 *                                          (extra args ignored). Both
 *                                          discriminators can also be armed
 *                                          post-creation via
 *                                          `setSuspendPolicy` — the seam the
 *                                          server fork uses, since the shared
 *                                          singleton is created with no opts.
 */
export function createLoopMonitor(opts = {}) {
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const thresholdMs = opts.thresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
  const runtime = typeof opts.runtime === 'string' && opts.runtime ? opts.runtime : STALL_RUNTIME;
  // WARDEN-1406 — these two are `let`, not const: the server fork arms them
  // POST-creation through setSuspendPolicy, because the shared singleton this
  // module exports is created with no opts (main passes them at create time
  // instead — both paths run the same validation).
  let maxCredibleLagMs =
    typeof opts.maxCredibleLagMs === 'number' && opts.maxCredibleLagMs > 0 ? opts.maxCredibleLagMs : null;
  let isSuspendBoundary = typeof opts.isSuspendBoundary === 'function' ? opts.isSuspendBoundary : null;
  const spanRingSize = Math.max(1, opts.spanRingSize ?? DEFAULT_SPAN_RING_SIZE);
  const stallRingSize = Math.max(1, opts.stallRingSize ?? DEFAULT_STALL_RING_SIZE);
  const syncFloorMs = opts.syncFloorMs ?? DEFAULT_SYNC_FLOOR_MS;
  // performance.now() — a MONOTONIC clock, so a system-clock change (NTP step,
  // DST, manual set) can never fabricate a stall. The wall clock is used only
  // for the human-readable timestamp on the record.
  const now = opts.now ?? (() => performance.now());
  const wallClock = opts.wallClock ?? (() => Date.now());
  let onStall = typeof opts.onStall === 'function' ? opts.onStall : null;

  // Bounded ring of recent work spans (fixed-size array + write cursor: no
  // shift(), no growth). An overwritten slot drops the oldest span; a token
  // whose slot was recycled still ends cleanly (we mutate the object, and it is
  // simply no longer a candidate for attribution).
  const spanRing = Array.from({ length: spanRingSize }, () => null);
  let spanCursor = 0;

  const stallRing = [];

  // Per-label sync aggregate for the CURRENT heartbeat window, replaced (not
  // cleared in place) on every tick so a stall reports only the window it
  // covers. `syncOpsSeen`/`syncMsSeen` are the cumulative counterparts: an
  // owner reading `syncOpsRecorded: 0` must not conclude "no synchronous I/O"
  // when the truth is "none of it individually crossed the ring floor".
  let syncAgg = new Map();

  let timer = null;
  let lastTickAt = 0;
  // WARDEN-1406 — the WALL clock at the previous tick. The lag math above is
  // monotonic, but suspend windows arrive in wall time (powerMonitor stamps
  // forwarded by main), so the suspension predicate needs the lag window in
  // BOTH domains. Sampled per tick — one wall read per second on a path that
  // already reads the monotonic clock, and no allocation.
  let lastWallAt = 0;
  let startedAtWall = 0;
  const stats = {
    ticks: 0, stalls: 0, worstLagMs: 0, spansRecorded: 0,
    syncOpsRecorded: 0, syncOpsSeen: 0, syncMsSeen: 0, suspendedSkips: 0,
  };

  function pushSpan(span) {
    spanRing[spanCursor] = span;
    spanCursor = (spanCursor + 1) % spanRingSize;
    stats.spansRecorded++;
    return span;
  }

  /**
   * Mark the start of a unit of work. Returns an opaque token for end(); the
   * token is safe to pass to end() twice, or to drop entirely (an unended span
   * is reported as `open`, which is itself a useful signal).
   */
  function begin(label) {
    return pushSpan({ label: normalizeLabel(label), start: now(), end: null });
  }

  function end(span) {
    if (span && span.end == null) span.end = now();
    return span;
  }

  /**
   * Fold one measured synchronous call into the current window's aggregate.
   * Two integer adds and no allocation on the hot path (the label's entry
   * already exists after its first call in the window).
   */
  function bumpSyncAggregate(label, durationMs) {
    let entry = syncAgg.get(label);
    if (!entry) {
      // Bounded label count: past the cap everything folds into one bucket, so
      // the total stays truthful even if the labels stop being distinct.
      const key = syncAgg.size >= MAX_SYNC_AGGREGATE_LABELS ? SYNC_AGGREGATE_OVERFLOW_LABEL : label;
      entry = syncAgg.get(key);
      if (!entry) { entry = { calls: 0, totalMs: 0 }; syncAgg.set(key, entry); }
    }
    entry.calls++;
    entry.totalMs += durationMs;
  }

  /**
   * Record a completed synchronous op of known duration.
   *
   * EVERY call is aggregated (that is what makes a stall built from thousands of
   * cheap calls visible at all). Only calls at or above the floor additionally
   * take a ring slot — below it, an op is not a plausible standalone
   * multi-second culprit and is not worth the slot. Placed in the ring as the
   * span it actually was: [t-duration, t].
   */
  function recordSyncOp(label, durationMs) {
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return null;
    const name = normalizeLabel(label);
    bumpSyncAggregate(name, durationMs);
    stats.syncOpsSeen++;
    stats.syncMsSeen += durationMs;
    if (!(durationMs >= syncFloorMs)) return null;
    const t = now();
    stats.syncOpsRecorded++;
    return pushSpan({ label: name, start: t - durationMs, end: t });
  }

  /**
   * Wrap an async (or sync) function call in a span, preserving its return value
   * and its rejection identity — a traced sweep behaves exactly as it did
   * untraced (same promise handed to the same caller, so unhandled-rejection
   * behavior is unchanged).
   */
  function trace(label, fn) {
    const span = begin(label);
    let result;
    try {
      result = fn();
    } catch (err) {
      end(span);
      throw err;
    }
    if (result && typeof result.then === 'function') {
      return result.finally(() => end(span));
    }
    end(span);
    return result;
  }

  /**
   * Process one heartbeat tick. Exposed (not just wired to the timer) so the
   * stall decision is testable with an injected clock and no real waiting.
   */
  function tick() {
    const t = now();
    const prev = lastTickAt;
    lastTickAt = t;
    // WARDEN-1406 — the wall-clock bounds of this tick gap, sampled here so the
    // predicate is handed them alongside the monotonic pair. The wall span
    // (prevWallAt, wallNow] is the WHOLE interval the block could have occupied
    // — never narrower than the lag window's wall image (it is wider by at most
    // one heartbeat at the start edge), which makes the boundary skip
    // conservative in the direction that matters: it may absorb one marginal
    // stall that ended just before a suspend began, and it can never report a
    // sleep as a stall.
    const wallNow = wallClock();
    const prevWallAt = lastWallAt;
    lastWallAt = wallNow;
    stats.ticks++;
    // Take this window's sync aggregate and start a fresh one, on EVERY tick —
    // so a stall reports the synchronous work of the window it actually covers,
    // and a quiet window's counts never carry into a later stall.
    const syncWindow = syncAgg;
    syncAgg = new Map();
    // Only reachable while inert (tick() called without start(), or after stop()):
    // there is no baseline interval to judge, so nothing is reported.
    if (!prev) return null;
    const overdue = t - prev - heartbeatMs;
    if (!isStall(overdue, thresholdMs)) return null;

    const lagMs = overdue;
    // The block ended when the loop was released — i.e. now. It therefore
    // occupied the overdue gap immediately preceding this tick.
    const windowStart = Math.max(prev, t - lagMs);

    // WARDEN-1376 — suspension discrimination, same two regimes as the main
    // heartbeat in electron/telemetry-source.cjs. A lag above the ceiling, or
    // one whose window spans a suspend→resume boundary, is the process having
    // been SUSPENDED (plus the OS resume storm on wake) — reported as neither a
    // stall nor a record. A broken predicate degrades to reporting the stall,
    // never to silently swallowing it. Both opt-in, at create time (main's
    // pattern) or post-creation through setSuspendPolicy (the server fork's —
    // WARDEN-1406): an unarmed monitor keeps today's behavior byte-for-byte.
    // WARDEN-1406 — the predicate is called with FOUR arguments: the monotonic
    // (windowStart, t) it has always received, plus the WALL-CLOCK bounds of
    // the same tick gap (see lastWallAt). A domain-aware caller (the server
    // fork) compares wall vs wall; main's two-argument predicate ignores the
    // extra arguments and is unchanged.
    if (maxCredibleLagMs != null && lagMs > maxCredibleLagMs) {
      stats.suspendedSkips++;
      return null;
    }
    if (isSuspendBoundary) {
      try {
        if (isSuspendBoundary(windowStart, t, prevWallAt, wallNow)) {
          stats.suspendedSkips++;
          return null;
        }
      } catch { /* a broken clock must not suppress real evidence */ }
    }

    const record = buildStallRecord({
      lagMs,
      runtime,
      attribution: attributeStall(spanRing, windowStart, t),
      syncTotals: summarizeSyncTotals(syncWindow),
      timestamp: wallClock(),
      heartbeatMs,
      thresholdMs,
      uptimeMs: startedAtWall ? wallClock() - startedAtWall : undefined,
      pid: typeof process !== 'undefined' ? process.pid : undefined,
    });

    stats.stalls++;
    if (record.lagMs > stats.worstLagMs) stats.worstLagMs = record.lagMs;
    stallRing.push(record);
    while (stallRing.length > stallRingSize) stallRing.shift();

    if (onStall) {
      // A diagnostic must never be able to take the server down, and must never
      // be the thing that stalls the loop it is measuring.
      try { onStall(record); } catch { /* sink failures are not the server's problem */ }
    }
    return record;
  }

  function start() {
    if (timer) return timer;
    lastTickAt = now();
    startedAtWall = wallClock();
    // WARDEN-1406 — seed the wall bookkeeping so the first stall decision never
    // sees a zero as the previous tick's wall stamp.
    lastWallAt = startedAtWall;
    timer = setInterval(tick, heartbeatMs);
    // Unref'd: the monitor must never be the reason the process stays alive.
    if (typeof timer.unref === 'function') timer.unref();
    return timer;
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    lastTickAt = 0;
    lastWallAt = 0;
    syncAgg = new Map();
  }

  return {
    begin, end, recordSyncOp, trace, tick, start, stop,
    setOnStall(fn) { onStall = typeof fn === 'function' ? fn : null; },
    // WARDEN-1406 — post-creation arming seam for the two suspension
    // discriminators, mirroring setOnStall: the shared singleton this module
    // exports is created with NO options (that is the point of a singleton),
    // so main's create-time pattern cannot reach it. The server fork calls
    // this once it has a suspend-window store to consult. Same validation as
    // the create-time opts; a key left absent keeps its current value, an
    // invalid value disarms that knob (never half-arms).
    setSuspendPolicy(policy) {
      if (!policy || typeof policy !== 'object') return;
      if (policy.maxCredibleLagMs !== undefined) {
        maxCredibleLagMs =
          typeof policy.maxCredibleLagMs === 'number' && policy.maxCredibleLagMs > 0
            ? policy.maxCredibleLagMs
            : null;
      }
      if (policy.isSuspendBoundary !== undefined) {
        isSuspendBoundary = typeof policy.isSuspendBoundary === 'function' ? policy.isSuspendBoundary : null;
      }
    },
    get started() { return timer != null; },
    // WARDEN-1406 — a getter, not a frozen-once snapshot: post-creation arming
    // through setSuspendPolicy must be visible here, both for the owner reading
    // GET /api/diagnostics/stalls and for the tests that assert the arming
    // condition. Frozen per read; the shape is unchanged.
    get config() {
      return Object.freeze({ heartbeatMs, thresholdMs, syncFloorMs, spanRingSize, stallRingSize, runtime, maxCredibleLagMs, suspendAware: isSuspendBoundary != null });
    },
    stalls() { return stallRing.slice(); },
    stats() { return { ...stats, syncMsSeen: Math.round(stats.syncMsSeen), started: timer != null }; },
    // Test seam: the raw ring (with holes) the attributor reads.
    _spans() { return spanRing.filter(Boolean); },
    // Test seam: the current (not yet ticked) per-label sync aggregate.
    _syncTotals() { return summarizeSyncTotals(syncAgg); },
    // Test seam: deliver a PRE-BUILT record straight to the registered sink, so
    // a caller's setOnStall wiring can be exercised end-to-end without waiting
    // for a real multi-second freeze or driving the heartbeat with a fake clock.
    // Delivery-side only: it does not touch the stall ring or the stats, because
    // those belong to real detection and a test that fabricated them would be
    // asserting its own fixture. Same never-throw-through contract as tick().
    _deliverStall(record) {
      if (!onStall) return null;
      try { onStall(record); } catch { /* sink failures are not the server's problem */ }
      return record;
    },
  };
}

/**
 * Wrap the synchronous members of module objects so any call at or above the
 * monitor's floor lands in the attribution ring.
 *
 * Takes the module objects as arguments (rather than importing node:fs here) so
 * this is unit-testable against fakes, and so the caller decides — exactly once,
 * in the server child — whether the real builtins are instrumented.
 *
 * The wrapper is transparent: same `this`, same arguments, same return value,
 * same thrown error, and the duration is recorded in a `finally` so a throwing
 * call is still attributed. Returns a `restore()` that puts the originals back.
 *
 * @param {{recordSyncOp: Function}} monitor
 * @param {object} [targets]
 * @param {object} [targets.fs] the `fs` module object (or a fake)
 * @param {object} [targets.childProcess] the `child_process` module object (or a fake)
 * @param {string[]} [targets.fsMethods]
 * @param {string[]} [targets.childProcessMethods]
 */
export function instrumentSyncIo(monitor, targets = {}) {
  const groups = [
    { obj: targets.fs, prefix: 'fs', methods: targets.fsMethods ?? SYNC_FS_METHODS },
    { obj: targets.childProcess, prefix: 'child_process', methods: targets.childProcessMethods ?? SYNC_CHILD_PROCESS_METHODS },
  ];
  const restores = [];
  for (const { obj, prefix, methods } of groups) {
    if (!obj) continue;
    for (const name of methods) {
      const original = obj[name];
      if (typeof original !== 'function') continue;
      const label = `${prefix}.${name}`;
      const wrapped = function instrumentedSync(...args) {
        const t0 = performance.now();
        try {
          return Reflect.apply(original, this, args);
        } finally {
          // Never let the measurement itself break the call it measures.
          try { monitor.recordSyncOp(label, performance.now() - t0); } catch { /* ignore */ }
        }
      };
      // Keep the wrapper indistinguishable enough for anything reflecting on it.
      Object.defineProperty(wrapped, 'name', { value: name, configurable: true });
      // Carry over the original's OWN properties — some builtins hang a sibling
      // off the function itself (notably `fs.realpathSync.native`), and a wrapper
      // that silently dropped it would break a caller that uses it. Copied by
      // descriptor so getters/non-writables survive as they were.
      for (const key of Object.getOwnPropertyNames(original)) {
        if (key === 'name' || key === 'length' || key === 'prototype') continue;
        const desc = Object.getOwnPropertyDescriptor(original, key);
        if (desc) { try { Object.defineProperty(wrapped, key, desc); } catch { /* skip */ } }
      }
      wrapped.__loopMonitorOriginal = original;
      try {
        obj[name] = wrapped;
        restores.push(() => { obj[name] = original; });
      } catch {
        // A non-writable member (frozen module object) is skipped, not fatal:
        // partial instrumentation is still useful.
      }
    }
  }
  return function restore() {
    for (const r of restores.splice(0)) {
      try { r(); } catch { /* best effort */ }
    }
  };
}

/**
 * The process-wide monitor. Inert (no timer, no sink) until the server child
 * calls start() — see startLoopMonitor in src/server.js. Its suspension
 * discriminators are likewise unarmed until the child's
 * setupSuspensionDiscrimination passes them post-creation (WARDEN-1406); the
 * standalone server keeps both defaults, byte for byte.
 */
export const loopMonitor = createLoopMonitor();
