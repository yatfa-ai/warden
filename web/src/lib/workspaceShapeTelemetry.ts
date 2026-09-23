// Workspace-shape sampler (WARDEN-1424) — the RENDERER producer for the count
// snapshot that closes the last uncovered fact in the telemetry channel's
// founding sentence (WARDEN-1265: the channel cannot answer "how many panes
// are open"). ONE bounded `workspace-shape` event per 5-minute window, read
// from the renderer's OWN state through an injected `read()` — the refs App.tsx
// already maintains. Nothing new is fetched, polled or retained beyond the six
// integers + two window stamps the event carries.
//
// WHAT IT SENDS — COUNTS ONLY, never identifiers:
//   workspaces / panesOpen / panesActive / chats at window close, plus the
//   window's PEAKS of the two volatile counts (peakPanesOpen / peakChats) so an
//   open-then-close burst inside a window that ended on a quiet state is still
//   visible. `chats` is the COUNT of sidebar rows — a chat NAME never crosses
//   this channel (names ride `workspace-names` behind their own category).
//
// LIVENESS: unlike the names producer (an idle catalog sends nothing), this
// event is sent on EVERY window while the renderer is alive — the shape
// snapshot doubles as the consented liveness signal, so silence at the receiver
// then means app-closed or consent-off, never "alive but idle". Volume bound:
// ≤288 ~200-byte events/day, the same fixed-cadence bound every window
// producer on this channel carries.
//
// TRANSPORT + CONSENT: in Electron the closed window ships over the
// `telemetry:renderer-shape` IPC bridge (fire-and-forget, also on pagehide,
// exactly the paneLatency discipline). MAIN is the consent gate: the receipt
// handler refuses the `operational-metrics` category exactly like the pane
// windows' receipt (the mid-flip re-check), and the pipeline's redact →
// validate remain the wire's last line of defense. In a plain browser (no
// bridge) the window still folds (bounded) and the send is a no-op.
//
// PURE-CORE DISCIPLINE: everything testable lives on `createWorkspaceShapeSampler`
// with an injected clock + injected read; the module-level singleton only wires
// the browser side (bridge discovery + timers + pagehide) and is inert in
// node --test. Mirrors web/src/lib/paneLatency.ts (WARDEN-1385).

/** The four counts `read()` returns — the sampler's only view of the app. */
export interface WorkspaceShapeCounts {
  workspaces: number;
  panesOpen: number;
  panesActive: number;
  chats: number;
}

/** The flushable window — the shape the event builder (and the schema) expect. */
export interface WorkspaceShapeWindow extends WorkspaceShapeCounts {
  startedAt: number;
  endedAt: number;
  peakPanesOpen: number;
  peakChats: number;
}

/** The transport: main's receipt handler (fire-and-forget). */
export type WorkspaceShapeSend = (snapshot: WorkspaceShapeWindow) => void;

// Flush cadence — the SAME 5-minute window every other producer on this channel
// closes on, so all of them land on one beat (≤288 events/day).
export const WORKSPACE_SHAPE_FLUSH_MS = 5 * 60_000;

function clampCount(v: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

/**
 * The sampler. There is NO monotonic sampling clock here — a counts snapshot
 * measures no durations (that is paneLatency's job); the only clock the
 * sampler needs is `stampNow` (Date.now by default — epoch, the event
 * builder's contract; tests inject a controllable fake so window rotation is
 * deterministic). `read()` is the ONLY view of the app; a throwing read is
 * treated as "nothing observable this tick" (counts fold as 0) — a failing
 * read must never break the window or the app.
 */
export function createWorkspaceShapeSampler({
  stampNow = (): number => Date.now(),
  read,
}: {
  stampNow?: () => number;
  read: () => WorkspaceShapeCounts;
} = { read: () => ({ workspaces: 0, panesOpen: 0, panesActive: 0, chats: 0 }) }) {
  // The window's peaks — two fixed accumulators, updated on every tick AND at
  // flush, so a burst anywhere inside the window survives the close.
  let peakPanesOpen = 0;
  let peakChats = 0;
  let startedAt = stampNow();

  function sample(): WorkspaceShapeCounts {
    let r: WorkspaceShapeCounts;
    try {
      r = read();
    } catch {
      // A throwing read must never break the app or the sampler — fold as the
      // empty observation (peaks stay at their maxima; counts report 0).
      r = { workspaces: 0, panesOpen: 0, panesActive: 0, chats: 0 };
    }
    return {
      workspaces: clampCount(r?.workspaces),
      panesOpen: clampCount(r?.panesOpen),
      panesActive: clampCount(r?.panesActive),
      chats: clampCount(r?.chats),
    };
  }

  /** Fold ONE observation into the window's peak accumulators. */
  function observe(r: WorkspaceShapeCounts): void {
    if (r.panesOpen > peakPanesOpen) peakPanesOpen = r.panesOpen;
    if (r.chats > peakChats) peakChats = r.chats;
  }

  // Carry the closing state into the next window's peaks: a peak accumulator
  // seeded at 0 would under-report a window whose app opened busy and never
  // changed (one tick == the whole window's evidence).
  observe(sample());

  /**
   * Tick the window: fold the current observation into the peaks. Cheap (one
   * read + two comparisons); called on the flush interval so a 5-minute window
   * carries at least the closing sample, and available for callers that want a
   * denser peak estimate without changing the flush cadence.
   */
  function tick(): void {
    observe(sample());
  }

  /**
   * Close the window: return it AND reset, so two windows never double-count.
   * The closing observation folds into the peaks before the event is built
   * (the closing state is part of the window), then the accumulators carry it
   * into the next window and the stamp rotates.
   */
  function flush(): WorkspaceShapeWindow {
    const closing = sample();
    observe(closing);
    const out: WorkspaceShapeWindow = {
      startedAt,
      endedAt: stampNow(),
      workspaces: closing.workspaces,
      panesOpen: closing.panesOpen,
      panesActive: closing.panesActive,
      chats: closing.chats,
      peakPanesOpen,
      peakChats,
    };
    // Reset: the next window starts from the state observed at this close.
    peakPanesOpen = closing.panesOpen;
    peakChats = closing.chats;
    startedAt = out.endedAt;
    return out;
  }

  /** The current window as a plain object. Non-destructive. */
  function snapshot(): WorkspaceShapeWindow {
    const closing = sample();
    const out: WorkspaceShapeWindow = {
      startedAt,
      endedAt: stampNow(),
      workspaces: closing.workspaces,
      panesOpen: closing.panesOpen,
      panesActive: closing.panesActive,
      chats: closing.chats,
      peakPanesOpen: Math.max(peakPanesOpen, closing.panesOpen),
      peakChats: Math.max(peakChats, closing.chats),
    };
    return out;
  }

  return { tick, flush, snapshot };
}

// ---------------------------------------------------------------------------
// The browser-side singleton + wiring. Inert without the Electron bridge —
// and inert under node --test (no `window`).
// ---------------------------------------------------------------------------

interface WorkspaceShapeSingleton {
  sampler: ReturnType<typeof createWorkspaceShapeSampler>;
}

let singleton: WorkspaceShapeSingleton | null = null;

/**
 * Get (lazily create) the app-level shape sampler and arm its flush loop
 * ONCE. `sendWindow` is the transport (the Electron bridge call); when it is
 * absent the sampler still folds and the flush drops the window — a browser
 * tab measures nothing it cannot ship, but costs nothing either (exactly the
 * paneLatency posture).
 */
export function getWorkspaceShapeSampler(
  { read, sendWindow }: { read: () => WorkspaceShapeCounts; sendWindow?: WorkspaceShapeSend } = { read: () => ({ workspaces: 0, panesOpen: 0, panesActive: 0, chats: 0 }) },
): WorkspaceShapeSingleton {
  if (singleton) return singleton;
  const sampler = createWorkspaceShapeSampler({ read });
  singleton = { sampler };
  // Best-effort mid-window flush on page teardown: a user closing the app
  // right after reshaping the workspace keeps that evidence (counts only).
  const flushOut = () => {
    try {
      const snap = sampler.flush();
      if (sendWindow) sendWindow(snap);
    } catch { /* a failing flush must never break teardown */ }
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flushOut);
    if (sendWindow) {
      const t = setInterval(() => {
        try {
          const snap = sampler.flush();
          sendWindow(snap);
        } catch { /* never let a throwing flush kill the interval */ }
      }, WORKSPACE_SHAPE_FLUSH_MS);
      // A page has no unref(); keep the handle so a future teardown path can
      // clear it.
      void t;
    }
  }
  return singleton;
}

/** Test seam: forget the singleton (the wiring is otherwise build-once). */
export function __resetWorkspaceShapeSingletonForTests() { singleton = null; }
