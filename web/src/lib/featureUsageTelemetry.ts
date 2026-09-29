// Feature-usage sampler (WARDEN-1479) — the RENDERER producer for the
// `feature-adoption` consent category's carrying event, the design's LAST
// unbuilt consent category (the 2026-08-19 authorization in the telemetry
// design, WARDEN-443, names feature adoption verbatim as approved scope).
// ONE bounded `feature-usage` event per 5-minute window: CLOSED-SET capability
// names + how many times each was used.
//
// WHAT IT SENDS — COUNTS OF NAMED CAPABILITIES ONLY:
//   `features: [{ name, count }]` where every `name` is a constant
//   kebab-case literal from the FEATURE union below (compile-time closed:
//   `recordFeatureUse` refuses anything else) and every `count` is a positive
//   integer. Never a chat name, never content, never a path, never a
//   credential — there is no free-text field anywhere in the shape, and the
//   schema's validator enforces the kebab pattern + a closed key set so no
//   arbitrary string can ride the channel even from a hostile caller.
//
// NOT A LIVENESS SIGNAL (the honest boundary, stated up front): `hasAnything`
// is COUNT-DRIVEN — a window in which the user exercised nothing sends
// NOTHING. Receiver silence therefore means app-closed, consent-off, OR a
// quiet session. This is the deliberate opposite of the workspace-shape
// producer, whose snapshot doubles as the consented liveness signal; folding
// an idle feature-usage heartbeat into this category would silently broaden
// what its consent means (the exact lie of omission the transparency surface
// exists to prevent).
//
// CLOSED VOCABULARY + OVERFLOW: the seeded capabilities are the union below.
// A name NOT in the union cannot reach the counter through `recordFeatureUse`
// (TypeScript), and the runtime double-checks membership anyway so a
// JS-side caller cannot smuggle one in — an unknown name is DROPPED (a
// validator-shaped name that is not a real capability would still ride the
// wire; dropping keeps the set honest, not merely well-formed). If the
// distinct-name cap (FEATURE_USAGE_MAX_CAP = 32) is ever exceeded — a future
// vocabulary growth beyond the schema's generous ceiling — further names fold
// into the reserved `feature-overflow` key (count preserved, name dropped),
// the same reserved-key posture the operational-metrics aggregator uses.
//
// TRANSPORT + CONSENT: in Electron the closed window ships over the
// `telemetry:renderer-usage` IPC bridge (fire-and-forget, also on pagehide,
// exactly the workspaceShape discipline). MAIN is the consent gate: the
// receipt handler refuses the `feature-adoption` category exactly like the
// other receipts (the mid-flip re-check), and the pipeline's redact →
// validate remain the wire's last line of defense. In a plain browser (no
// bridge) the window still folds (bounded) and the send is a no-op.
//
// PURE-CORE DISCIPLINE: everything testable lives on `createFeatureUsageSampler`
// with an injected clock; the module-level singleton only wires the browser
// side (bridge discovery + timer + pagehide) and is inert in node --test.
// Mirrors web/src/lib/workspaceShapeTelemetry.ts (WARDEN-1424).

/** The CLOSED capability vocabulary. Every seed call site names a literal from
 *  this union; the schema validator independently enforces the same kebab-case
 *  shape, so the set is closed at compile time AND at the wire. */
export type FeatureName =
  | 'global-search'
  | 'settings'
  | 'pane-maximize'
  | 'session-view'
  | 'panel-expand-sidebar'
  | 'panel-expand-observer'
  | 'panel-expand-health'
  | 'panel-expand-source-control'
  | 'workspace-switch'
  | 'workspace-create'
  | 'chat-create'
  | 'theme-change';

/** The runtime member check — the JS-side half of the closed set (a `.tsx`
 *  caller cannot bypass the type, but a plain-JS caller could; this keeps the
 *  counter honest regardless). Derived from the union so the two cannot drift. */
export const FEATURE_NAMES: readonly FeatureName[] = Object.freeze([
  'global-search',
  'settings',
  'pane-maximize',
  'session-view',
  'panel-expand-sidebar',
  'panel-expand-observer',
  'panel-expand-health',
  'panel-expand-source-control',
  'workspace-switch',
  'workspace-create',
  'chat-create',
  'theme-change',
]);

/** The producer's reserved overflow key (see the header's OVERFLOW note). */
export const FEATURE_OVERFLOW_KEY = 'feature-overflow';

// The producer's distinct-name footprint bound: the seeded vocabulary is 12;
// the cap leaves room for future growth without touching the schema's
// MAX_FEATURES_PER_EVENT (64). At the cap, further names fold into
// FEATURE_OVERFLOW_KEY.
const FEATURE_USAGE_MAX_CAP = 32;

/** The flushable window — the shape the event builder (and the schema) expect. */
export interface FeatureUsageWindow {
  startedAt: number;
  endedAt: number;
  /** One row per capability used, count ≥ 1, names from the closed set. */
  features: Array<{ name: string; count: number }>;
  /** True iff at least one capability was used in the window. An idle window
   *  is FALSE and sends nothing — feature-usage is not a liveness signal. */
  hasAnything: boolean;
}

/** The transport: main's receipt handler (fire-and-forget). */
export type FeatureUsageSend = (snapshot: FeatureUsageWindow) => void;

// Flush cadence — the SAME 5-minute window every other producer on this
// channel closes on, so all of them land on one beat (≤288 events/day).
export const FEATURE_USAGE_FLUSH_MS = 5 * 60_000;

/**
 * The sampler. `recordFeatureUse(name)` folds ONE use into the window's
 * bounded counter (the only way evidence enters — there is no polling read).
 * A full window (over the distinct-name cap) folds further names into the
 * reserved `feature-overflow` key. `flush()` closes AND resets, so two
 * windows never double-count; `snapshot()` is the non-destructive view.
 */
export function createFeatureUsageSampler({
  stampNow = (): number => Date.now(),
}: {
  stampNow?: () => number;
} = {}) {
  let startedAt = stampNow();
  // The bounded counter: Map preserves insertion order, so the event's rows
  // are deterministic for a given use sequence.
  const counts = new Map<string, number>();

  function recordFeatureUse(name: FeatureName): void {
    // Runtime membership check — the JS-side half of the closed set. An
    // unknown name is DROPPED: a well-formed-but-unknown name would still
    // validate on the wire, so the counter (not the validator) is what keeps
    // the vocabulary honest.
    if (!FEATURE_NAMES.includes(name)) return;
    const current = counts.get(name) ?? 0;
    if (current > 0) {
      counts.set(name, current + 1);
      return;
    }
    // A NEW distinct name: respect the footprint cap. Beyond the cap the name
    // is dropped into the reserved overflow key (count preserved, name not).
    if (counts.size >= FEATURE_USAGE_MAX_CAP) {
      counts.set(FEATURE_OVERFLOW_KEY, (counts.get(FEATURE_OVERFLOW_KEY) ?? 0) + 1);
      return;
    }
    counts.set(name, 1);
  }

  /** Build the window snapshot from the current counter (no mutation). */
  function build(endedAt: number): FeatureUsageWindow {
    const features = Array.from(counts.entries()).map(([name, count]) => ({ name, count }));
    return { startedAt, endedAt, features, hasAnything: features.length > 0 };
  }

  /**
   * Close the window: return it AND reset, so two windows never double-count.
   * An IDLE window (no uses) still ROTATES its stamps (the next window starts
   * clean) but reports `hasAnything: false` — the caller sends nothing for it.
   */
  function flush(): FeatureUsageWindow {
    const out = build(stampNow());
    counts.clear();
    startedAt = out.endedAt;
    return out;
  }

  /** The current window as a plain object. Non-destructive. */
  function snapshot(): FeatureUsageWindow {
    return build(stampNow());
  }

  return { recordFeatureUse, flush, snapshot };
}

// ---------------------------------------------------------------------------
// The browser-side singleton + wiring. Inert without the Electron bridge —
// and inert under node --test (no `window`).
// ---------------------------------------------------------------------------

interface FeatureUsageSingleton {
  sampler: ReturnType<typeof createFeatureUsageSampler>;
}

let singleton: FeatureUsageSingleton | null = null;
// The transport, held at MODULE level rather than captured at singleton
// construction: the seed call sites (search dialog, spawn control, appearance
// section) may get() the sampler BEFORE App's build-once effect supplies the
// bridge — effects run child-first — and a transport captured at construction
// would arm the flush loop with a permanent no-op send. The closures consult
// this variable per flush, so a later build-once call upgrades the transport
// in place and the wiring never has to re-arm.
let transport: FeatureUsageSend | null = null;

/**
 * Get (lazily create) the app-level feature-usage sampler and arm its flush
 * loop ONCE. `sendWindow` is the transport (the Electron bridge call); when
 * it is absent the sampler still folds and the flush drops the window — a
 * browser tab measures nothing it cannot ship, but costs nothing either
 * (exactly the workspaceShape posture). A LATER call may supply the
 * transport: it upgrades the module-level binding in place (see `transport`).
 */
export function getFeatureUsageSampler(
  { sendWindow }: { sendWindow?: FeatureUsageSend } = {},
): FeatureUsageSingleton {
  if (sendWindow) transport = sendWindow;
  if (singleton) return singleton;
  const sampler = createFeatureUsageSampler({});
  singleton = { sampler };
  // Best-effort mid-window flush on page teardown: a user closing the app
  // right after using a capability keeps that evidence (counts only).
  const flushOut = () => {
    try {
      const snap = sampler.flush();
      const sw = transport;
      if (snap.hasAnything && sw) sw(snap);
    } catch { /* a failing flush must never break teardown */ }
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flushOut);
    const t = setInterval(() => {
      try {
        const snap = sampler.flush();
        // COUNT-DRIVEN SILENCE: an idle window sends nothing. Feature-usage
        // is not a liveness signal — silence means app-closed, consent-off,
        // or a quiet session (see the header).
        const sw = transport;
        if (snap.hasAnything && sw) sw(snap);
      } catch { /* never let a throwing flush kill the interval */ }
    }, FEATURE_USAGE_FLUSH_MS);
    // A page has no unref(); keep the handle so a future teardown path can
    // clear it.
    void t;
  }
  return singleton;
}

/** Test seam: forget the singleton (the wiring is otherwise build-once). */
export function __resetFeatureUsageSingletonForTests() { singleton = null; transport = null; }
