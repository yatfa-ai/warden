// Pane latency sampler (WARDEN-1385) — the RENDERER half of the first
// measurement of the user-felt path. The server half (the write leg + the tmux
// round trip) lives in src/paneInputTelemetry.js; the two meet in the
// histograms. Every hop is its own closed-set operation, so a slow echo is
// attributed by READING THE HISTOGRAMS BESIDE EACH OTHER:
//
//   • `pane-echo-e2e`      — keystroke leaves xterm's onData → the pane's next
//     PTY frame ARRIVES at the renderer. The user-felt delivery time (WS relay
//     + server legs + delivery back), measured on ONE clock (this renderer's),
//     so it needs no cross-process clock agreement. This is THE number the
//     ticket convicts with: plain-ssh parity means this distribution sitting
//     where a plain client's would.
//   • `pane-echo-paint`    — frame arrived → xterm finished processing the
//     write (the write callback). The renderer's OWN cost of the last hop.
//   • `renderer-long-task` — main-thread tasks ≥50ms (PerformanceObserver
//     'longtask'). The health signal that explains a paint/e2e tail: if typing
//     lags while three agents stream, and THIS histogram is fat, the renderer
//     main thread is the convict; if it is empty while echo-e2e is fat, the
//     lag lives before the renderer (server legs, transport) or on delivery.
//
// LONG ANIMATION FRAMES (WARDEN-1570) — `renderer-long-task` proves a tail
// exists but not WHAT blocked it. A SECOND, separately guarded observer
// ('long-animation-frame', Chromium) folds into the SAME window as more
// closed-set operations. Granularity is stated per op:
//   PER FRAME (one observation per LoAF entry):
//   • `renderer-frame-script`   — sum of that frame's scripts[].duration.
//   • `renderer-frame-render`   — frame end − renderStart (style/layout/paint
//     share); skipped when renderStart is absent/<=0/non-finite.
//   • `renderer-frame-blocking` — the entry's blockingDuration.
//   PER SCRIPT (one observation per scripts[] element, its own duration,
//   bucketed by the spec invokerType): `renderer-frame-script-user-callback`,
//   `-event-listener`, `-resolve-promise`, `-reject-promise`, `-classic-script`,
//   `-module-script`, and `-other` for any unrecognized value.
// These ops are created LAZILY — they appear in a window only once something
// folded into them — so an engine without LoAF ships exactly the original three.
// HARD EXCLUSION (WARDEN-443): scripts[].sourceURL, sourceFunctionName and
// invoker (file paths / function names / selectors) are NEVER read, stored or
// forwarded. The only string consulted is `invokerType`, matched against the
// closed enum above; anything else collapses to `-other`.
//
// BOUNDARIES start at 25ms and reach 5s: the existing stall telemetry's 1s
// floor demonstrably misses the 50–500ms jank a typist feels, so the range
// must resolve what users feel (down to ~50ms) without clipping the "unusable"
// tail. Bucket count is fixed, so folding 10 or 10,000,000 observations costs
// the same memory (the M1 aggregator's whole point, mirrored in TS).
//
// SAMPLING / COST (a lag meter that lags is a defect):
//   • ONE pending input per pane — the latest keystroke wins (a burst coalesces
//     to one observation, not one per key).
//   • Only the FIRST frame after an input correlates; later frames cost one
//     Map probe. Streaming output never folds (it is not an echo).
//   • Per-operation observations per window are CAPPED (`maxPerWindow`) — under
//     a paste storm the histogram keeps the first N and drops the rest, so the
//     fold work is bounded whatever the input rate.
//   • The flush is a fixed-size projection (one accumulator per operation) —
//     no per-observation row is ever retained.
//
// TRANSPORT + CONSENT: in Electron the folded window ships over the
// `telemetry:renderer-metrics` IPC bridge every 5 minutes (fire-and-forget) and
// ALSO on pagehide (best-effort). MAIN is the consent gate: the receipt handler
// refuses the `operational-metrics` category exactly like the server windows'
// receipt (the mid-flip re-check), and the pipeline's redact → validate remain
// the wire's last line of defense. The sampler itself retains only the
// fixed-size accumulators — no rows, no pane keys, nothing that could leak even
// in principle. In a plain browser (no bridge) the window still folds (bounded)
// and the send is a no-op.
//
// PURE-CORE DISCIPLINE: everything testable lives on `createPaneLatencySampler`
// with an injected clock; the module-level singleton only wires the browser
// side (bridge discovery + timers + the longtask observer) and is inert in
// node --test.

// ---- Operation names: CLOSED-SET kebab literals (schema OPERATION_NAME_RE). --
export const PANE_LATENCY_OPS = Object.freeze({
  E2E: 'pane-echo-e2e',
  PAINT: 'pane-echo-paint',
  LONG_TASK: 'renderer-long-task',
  // Long Animation Frame ops (WARDEN-1570) — lazily created, see header.
  FRAME_SCRIPT: 'renderer-frame-script',
  FRAME_RENDER: 'renderer-frame-render',
  FRAME_BLOCKING: 'renderer-frame-blocking',
  FRAME_SCRIPT_USER_CALLBACK: 'renderer-frame-script-user-callback',
  FRAME_SCRIPT_EVENT_LISTENER: 'renderer-frame-script-event-listener',
  FRAME_SCRIPT_RESOLVE_PROMISE: 'renderer-frame-script-resolve-promise',
  FRAME_SCRIPT_REJECT_PROMISE: 'renderer-frame-script-reject-promise',
  FRAME_SCRIPT_CLASSIC_SCRIPT: 'renderer-frame-script-classic-script',
  FRAME_SCRIPT_MODULE_SCRIPT: 'renderer-frame-script-module-script',
  FRAME_SCRIPT_OTHER: 'renderer-frame-script-other',
});

// Closed enum: spec invokerType → op. A null-prototype map, so hostile keys
// like "constructor"/"__proto__" can never resolve to anything.
const INVOKER_TYPE_OPS: Readonly<Record<string, string>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, string>, {
    'user-callback': PANE_LATENCY_OPS.FRAME_SCRIPT_USER_CALLBACK,
    'event-listener': PANE_LATENCY_OPS.FRAME_SCRIPT_EVENT_LISTENER,
    'resolve-promise': PANE_LATENCY_OPS.FRAME_SCRIPT_RESOLVE_PROMISE,
    'reject-promise': PANE_LATENCY_OPS.FRAME_SCRIPT_REJECT_PROMISE,
    'classic-script': PANE_LATENCY_OPS.FRAME_SCRIPT_CLASSIC_SCRIPT,
    'module-script': PANE_LATENCY_OPS.FRAME_SCRIPT_MODULE_SCRIPT,
  }),
);

/** Ops that exist in a window only once observed (the LoAF family). */
const LAZY_OPS: ReadonlySet<string> = new Set<string>([
  PANE_LATENCY_OPS.FRAME_SCRIPT,
  PANE_LATENCY_OPS.FRAME_RENDER,
  PANE_LATENCY_OPS.FRAME_BLOCKING,
  PANE_LATENCY_OPS.FRAME_SCRIPT_OTHER,
  ...Object.values(INVOKER_TYPE_OPS),
]);

/** The minimal structural shape of a LoAF entry the sampler reads. Only the
 *  numeric fields and `scripts[].invokerType` are ever consulted. */
export interface LongAnimationFrameLike {
  duration?: number;
  startTime?: number;
  renderStart?: number;
  blockingDuration?: number;
  scripts?: ReadonlyArray<{ duration?: number; invokerType?: string }>;
}

/** One folded per-operation accumulator — mirrors the wire's
 *  OperationalMetricOperation (web/src/lib/telemetry/schema.ts). */
interface Accumulator {
  count: number; okCount: number; failCount: number;
  min: number; max: number; sum: number;
  buckets: number[];
}

/** The handle frame() returns: its `painted` is xterm's write callback. */
export interface PaneLatencyFrame {
  /** The xterm write callback: folds the renderer's own paint cost. */
  painted(): void;
}

/** One folded operation as it rides the window (schema-projected). */
export interface PaneLatencyOperation {
  operation: string;
  count: number; okCount: number; failCount: number;
  min: number; avg: number; max: number;
  buckets: number[];
}

/** The flushable window — the M1-aggregator shape the event builder expects. */
export interface PaneLatencyWindow {
  startedAt: number;
  endedAt: number;
  boundaries: number[];
  operations: PaneLatencyOperation[];
  /** Total refused observations — always `rejectedStale + rejectedInvalid`. */
  rejected: number;
  /** Refused because the echo/duration exceeded the correlation window
   *  (> PENDING_INPUT_MAX_AGE_MS): the right-censored unusable-tail count. */
  rejectedStale: number;
  /** Refused as malformed input (bad id, bad/negative duration, unknown op):
   *  a caller-contract violation, expected ~zero. */
  rejectedInvalid: number;
}

/** The transport: main's receipt handler (fire-and-forget). */
export type PaneLatencySend = (snapshot: PaneLatencyWindow) => void;

// Ascending INCLUSIVE upper bounds, ms. 12 boundaries + overflow = 13 counters
// per operation, forever.
export const PANE_LATENCY_BOUNDARIES_MS = Object.freeze([
  25, 50, 75, 100, 150, 200, 300, 500, 800, 1200, 2000, 5000,
]);

// Correlation window: a pending input older than this is STALE — its echo is
// presumed lost (pane died, WS dropped) and must not fold as a monster sample
// the moment unrelated output finally arrives. Generous enough to keep a real
// 2s echo visible.
export const PENDING_INPUT_MAX_AGE_MS = 10_000;

// Max observations folded per operation per window (the paste-storm bound).
export const MAX_PER_WINDOW = 600;

// Flush cadence — the same 5-minute rhythm the server-side telemetry
// producers close on, so every channel lands on one beat.
export const PANE_LATENCY_FLUSH_MS = 5 * 60_000;

function emptyAccumulator(): Accumulator {
  return {
    count: 0, okCount: 0, failCount: 0,
    min: 0, max: 0, sum: 0,
    buckets: new Array(PANE_LATENCY_BOUNDARIES_MS.length + 1).fill(0),
  };
}

function bucketIndexFor(ms: number): number {
  for (let i = 0; i < PANE_LATENCY_BOUNDARIES_MS.length; i += 1) {
    if (ms <= PANE_LATENCY_BOUNDARIES_MS[i]) return i;
  }
  return PANE_LATENCY_BOUNDARIES_MS.length;
}

function fold(acc: Accumulator, ms: number): void {
  if (acc.count === 0) { acc.min = ms; acc.max = ms; }
  else { if (ms < acc.min) acc.min = ms; if (ms > acc.max) acc.max = ms; }
  acc.count += 1; acc.okCount += 1; acc.sum += ms;
  acc.buckets[bucketIndexFor(ms)] += 1;
}

/**
 * The sampler. `now()` is the ONLY clock — production passes performance.now
 * (monotonic, sub-ms), tests pass a controllable fake. Window STAMPS use
 * Date.now (epoch, the event builder's contract); hop DURATIONS come from the
 * injected clock.
 */
export function createPaneLatencySampler({
  now = (): number => performance.now(),
  maxPerWindow = MAX_PER_WINDOW,
  pendingMaxAgeMs = PENDING_INPUT_MAX_AGE_MS,
}: {
  now?: () => number;
  maxPerWindow?: number;
  pendingMaxAgeMs?: number;
} = {}) {
  /** pane id → { at, stamp } — the ONE pending input per pane. */
  const pending = new Map<string, { at: number; stamp: number }>();
  const accs = new Map<string, Accumulator>([
    [PANE_LATENCY_OPS.E2E, emptyAccumulator()],
    [PANE_LATENCY_OPS.PAINT, emptyAccumulator()],
    [PANE_LATENCY_OPS.LONG_TASK, emptyAccumulator()],
  ]);
  let rejectedStale = 0;
  let rejectedInvalid = 0;
  let startedAt = Date.now();

  function recordIfRoom(op: string, ms: number): boolean {
    let acc = accs.get(op);
    if (!acc && LAZY_OPS.has(op)) { acc = emptyAccumulator(); accs.set(op, acc); }
    if (!acc || typeof ms !== 'number' || !(ms >= 0) || !Number.isFinite(ms)) { rejectedInvalid += 1; return false; }
    if (ms > pendingMaxAgeMs) { rejectedStale += 1; return false; }
    if (acc.count >= maxPerWindow) return false; // bounded fold: drop, never grow
    fold(acc, ms);
    return true;
  }

  /**
   * A keystroke is about to leave the pane (call in term.onData, BEFORE the
   * stream send). Coalesces: the latest keystroke per pane is the one timed.
   */
  function noteInput(id: string): void {
    if (typeof id !== 'string' || id.length === 0) { rejectedInvalid += 1; return; }
    pending.set(id, { at: now(), stamp: Date.now() });
  }

  /**
   * The pane's next PTY frame arrived. Returns a frame handle, or null when
   * there is no pending input to correlate (the common streaming case — and a
   * cheap Map probe). The caller MUST pass the handle's `painted` as xterm's
   * write callback; the e2e leg folds IMMEDIATELY (delivery is a fact the
   * moment the frame lands), the paint leg folds in the callback (xterm
   * processes writes asynchronously).
   */
  function frame(id: string): PaneLatencyFrame | null {
    if (typeof id !== 'string' || id.length === 0) return null;
    const entry = pending.get(id);
    if (!entry) return null;
    pending.delete(id);
    const at = now();
    const e2eMs = at - entry.at;
    if (!(e2eMs >= 0)) { rejectedInvalid += 1; return null; }
    if (e2eMs > pendingMaxAgeMs) { rejectedStale += 1; return null; }
    if (!recordIfRoom(PANE_LATENCY_OPS.E2E, e2eMs)) return null;
    const t0 = at;
    return {
      /** The xterm write callback: folds the renderer's own paint cost. */
      painted() {
        // No pre-filter: recordIfRoom classifies >max → rejectedStale and
        // <0 / NaN → rejectedInvalid, so a refused paint is disclosed.
        recordIfRoom(PANE_LATENCY_OPS.PAINT, now() - t0);
      },
    };
  }

  /** One main-thread long task (call from a 'longtask' PerformanceObserver). */
  function noteLongTask(durationMs: number): void {
    if (typeof durationMs !== 'number' || !(durationMs >= 0)) { rejectedInvalid += 1; return; }
    recordIfRoom(PANE_LATENCY_OPS.LONG_TASK, durationMs);
  }

  /**
   * One Long Animation Frame entry (call from a 'long-animation-frame'
   * PerformanceObserver). Reads ONLY numeric timing fields and the closed-enum
   * `invokerType` — sourceURL / sourceFunctionName / invoker are never touched.
   */
  function noteLongAnimationFrame(entry: LongAnimationFrameLike): void {
    if (!entry || typeof entry !== 'object') { rejectedInvalid += 1; return; }
    const scripts = Array.isArray(entry.scripts) ? entry.scripts : [];
    let scriptSum = 0;
    for (const sc of scripts) {
      if (!sc || typeof sc !== 'object') { rejectedInvalid += 1; continue; }
      const d = sc.duration;
      const t = sc.invokerType;
      const op = (typeof t === 'string' ? INVOKER_TYPE_OPS[t] : undefined)
        ?? PANE_LATENCY_OPS.FRAME_SCRIPT_OTHER;
      if (typeof d === 'number' && Number.isFinite(d) && d >= 0) scriptSum += d;
      recordIfRoom(op, d as number);
    }
    recordIfRoom(PANE_LATENCY_OPS.FRAME_SCRIPT, scriptSum);
    const { duration, startTime, renderStart, blockingDuration } = entry;
    if (
      typeof renderStart === 'number' && Number.isFinite(renderStart) && renderStart > 0
      && typeof startTime === 'number' && Number.isFinite(startTime)
      && typeof duration === 'number' && Number.isFinite(duration)
    ) {
      const renderMs = startTime + duration - renderStart;
      if (renderMs >= 0) recordIfRoom(PANE_LATENCY_OPS.FRAME_RENDER, renderMs);
    }
    if (typeof blockingDuration === 'number') recordIfRoom(PANE_LATENCY_OPS.FRAME_BLOCKING, blockingDuration);
  }

  function project(name: string): PaneLatencyOperation {
    const acc = accs.get(name)!;
    return {
      operation: name,
      count: acc.count,
      okCount: acc.okCount,
      failCount: acc.failCount,
      min: acc.min,
      avg: acc.count ? acc.sum / acc.count : 0,
      max: acc.max,
      buckets: acc.buckets.slice(),
    };
  }

  /** The current window as a plain object. Non-destructive. */
  function snapshot(): PaneLatencyWindow {
    return {
      startedAt,
      endedAt: Date.now(),
      boundaries: [...PANE_LATENCY_BOUNDARIES_MS],
      operations: [...accs.keys()].map(project),
      rejected: rejectedStale + rejectedInvalid,
      rejectedStale,
      rejectedInvalid,
    };
  }

  /** Close the window: return AND reset, so two windows never double-count. */
  function flush(): PaneLatencyWindow {
    const out = snapshot();
    for (const name of [...accs.keys()]) {
      if (LAZY_OPS.has(name)) accs.delete(name); // LoAF ops reappear only once observed again
      else accs.set(name, emptyAccumulator());
    }
    rejectedStale = 0;
    rejectedInvalid = 0;
    startedAt = out.endedAt;
    return out;
  }

  return { noteInput, frame, noteLongTask, noteLongAnimationFrame, snapshot, flush };
}

/**
 * Register the Long Animation Frame observer (WARDEN-1570). Separately guarded
 * from the longtask observer: absent PerformanceObserver, an engine whose
 * `supportedEntryTypes` lacks 'long-animation-frame', or a throwing
 * constructor/observe all fall through silently and return false — the three
 * original ops are untouched. `PO` is injectable for tests.
 */
export function registerLongAnimationFrameObserver(
  sampler: { noteLongAnimationFrame: (e: LongAnimationFrameLike) => void },
  PO: any = (globalThis as any).PerformanceObserver,
): boolean {
  try {
    if (typeof PO !== 'function') return false;
    const supported = PO.supportedEntryTypes;
    if (!Array.isArray(supported) || !supported.includes('long-animation-frame')) return false;
    const po = new PO((list: { getEntries(): LongAnimationFrameLike[] }) => {
      for (const e of list.getEntries()) {
        try { sampler.noteLongAnimationFrame(e); } catch { /* never break the observer */ }
      }
    });
    po.observe({ type: 'long-animation-frame', buffered: false });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The browser-side singleton + wiring. Inert without the Electron bridge.
// ---------------------------------------------------------------------------

interface PaneLatencySingleton {
  noteInput: (id: string) => void;
  frame: (id: string) => PaneLatencyFrame | null;
  sampler: ReturnType<typeof createPaneLatencySampler>;
}

let singleton: PaneLatencySingleton | null = null;

/**
 * Get (lazily create) the app-level sampler and arm its flush loop + longtask
 * observer ONCE. `sendWindow` is the transport (the Electron bridge call);
 * when it is absent the sampler still folds and the flush drops the window —
 * a browser tab measures nothing it cannot ship, but costs nothing either.
 */
export function getPaneLatencySampler(sendWindow?: PaneLatencySend): PaneLatencySingleton {
  if (singleton) return singleton;
  const sampler = createPaneLatencySampler();
  singleton = {
    noteInput: (id: string) => sampler.noteInput(id),
    frame: (id: string) => sampler.frame(id),
    sampler,
  };
  // Best-effort mid-window flush on page teardown: a user closing the app
  // right after a bad lag episode keeps that evidence (bounded, aggregate-only).
  const flushOut = () => {
    try {
      const snap = sampler.flush();
      if (snap.operations.some((o) => o.count > 0) && sendWindow) sendWindow(snap);
    } catch { /* a failing flush must never break teardown */ }
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flushOut);
    if (sendWindow) {
      const t = setInterval(flushOut, PANE_LATENCY_FLUSH_MS);
      // A page has no unref(); keep the handle so a future teardown path can
      // clear it — and never let a throwing flush kill the interval.
      void t;
    }
    try {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) sampler.noteLongTask(e.duration);
      });
      po.observe({ type: 'longtask', buffered: false });
    } catch { /* no longtask support (Safari, old engines) — the other legs stand */ }
    registerLongAnimationFrameObserver(sampler);
  }
  return singleton;
}

/** Test seam: forget the singleton (the wiring is otherwise build-once). */
export function __resetPaneLatencySingletonForTests() { singleton = null; }
