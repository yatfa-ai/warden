// Event-loop stall wiring + server-runtime suspension discrimination, moved
// verbatim out of src/server.js (WARDEN-1923). The only body delta is that
// `serverStallTelemetry` is read through the `getServerStallTelemetry` thunk at
// call time: server.js destructures it from createServerTelemetry later than
// the point this factory is created, and the read must stay late so a spec that
// monkey-patches `serverStallTelemetry.recordStall` still bites.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { loopMonitor, instrumentSyncIo, formatStallLine } from './loop-monitor.js';
// WARDEN-1406 — the SAME pure suspend-window tracker electron/main.cjs uses,
// imported across the directory line deliberately: the module is dependency-free
// by contract (no Electron import, no fs — see its header), so it is safe to
// load in the server child, and reusing it is what keeps the boundary semantics
// (resume-instant counts, suspend-instant doesn't, open window counts) in ONE
// spec'd implementation instead of a drift-prone fork-side copy.
import { createSuspendClock } from '../electron/suspend-clock.cjs';
import { appendStall, pruneStallLog, stallLogFile } from './stall-log.js';

// ===========================================================================
// WARDEN-1406 — suspension discrimination on the SERVER runtime.
//
// THE ARTIFACT THIS KILLS. The shared monitor's two suspension discriminators
// (`maxCredibleLagMs` + `isSuspendBoundary`, WARDEN-1376) are opt-in, and main
// has armed them since 0.1.70 — this runtime had not, so a machine SLEEP read
// as a server freeze on every channel: the receiver's worst "stall" is a
// 12.1-hour sleep, and all 7 server-stall events are single 43.9 min–12.1 h
// windows with `unattributed` culprits. Main is the only process that SEES
// powerMonitor suspend/resume, so it forwards the authoritative windows over
// the fork IPC channel and this side arms the monitor with them:
//
//   • `telemetry-suspend-replay` — sent ONCE at fork spawn (main.cjs, right
//     after fork()): the retained window history + any in-flight suspend. The
//     fork starts with no memory of suspends that happened before it existed.
//   • `telemetry-suspend-open` / `telemetry-suspend-close` — live, on every
//     powerMonitor suspend/resume. The close carries the closed {from, to}.
//
// CLOCK DOMAINS — LOAD-BEARING. The monitor's lag math ticks MONOTONIC
// performance.now(); suspend windows are WALL (Date.now()) stamps from main.
// The monitor therefore hands the predicate the WALL-CLOCK bounds of the tick
// gap as extra arguments (loop-monitor.js tick()), and the predicate below
// compares wall vs wall. main's own two-argument loop-monitor predicate
// compares monotonic tick values against wall windows — an accidental mix that
// survives only because its magnitude ceiling is domain-independent. That mix
// is NOT copied here. (Per-tick offset mapping would NOT work: the offset
// changes ACROSS the sleep, so mapping the lag window's start with the
// post-wake offset misplaces it by the whole sleep duration and the 12-hour
// artifact would report exactly as before.)
//
// ARM ONLY WHEN FORKED. `typeof process.send === 'function'` is the same guard
// every forward on this channel uses, read in the opposite direction: a
// standalone `node src/server.js` has no parent to send it windows, so it keeps
// today's byte-for-byte behavior — no ceiling, no predicate, no listener. In a
// test runner the guard also reads false, so importing server.js arms nothing.
// ===========================================================================
const MAX_CREDIBLE_LAG_MS = 60000; // mirrors electron/main.cjs — no live process blocks this long

// Module-level so a re-setup replaces the previous listener instead of stacking
// (and so `dispose` can remove exactly what was registered).
let suspendMessageHandler = null;

export function createLoopWiring({ getServerStallTelemetry }) {
  // ---- Server event-loop stall instrumentation (WARDEN-977) ------------------
  //
  // The backend is a FORKED CHILD of the Electron main process, and the freeze
  // heartbeat that already existed (electron/telemetry-source.cjs) only ever
  // watched the main process — so a multi-second block of THIS process emitted
  // nothing anywhere, which is why the ~10s Settings hang survived three passes
  // (WARDEN-828 / WARDEN-831 / WARDEN-915). This wires the server-side heartbeat
  // to its three read channels, all of which are on by default and none of which
  // require a rebuild, a debugger or any unrelated opt-in:
  //
  //   1. ~/.yatfa-warden/stalls.jsonl — the durable record the owner reads.
  //   2. one `[warden:stall] …` line on stderr, which the Electron main process
  //      already relays to its console as `[server] …`.
  //   3. GET /api/diagnostics/stalls — the same file, in a browser.
  //
  // Telemetry is deliberately NOT the channel for the OWNER's on-demand read: it
  // is opt-in and off by default, so it cannot be the surface someone consults
  // when the app just froze. WARDEN-1278 adds it as a FOURTH, strictly ADDITIVE
  // channel for the MAINTAINER, with consent — the three above are byte-untouched
  // (same stderr line, same append, same route response) and run first.
  // Wire the stall SINK — the delivery half of startLoopMonitor, split out so a
  // test can arm the real callback WITHOUT also starting the heartbeat timer and
  // patching the fs / child_process builtins process-wide (see
  // __startLoopMonitorForTest at the bottom of this file).
  function wireStallSink() {
    loopMonitor.setOnStall((record) => {
      // stderr first (synchronous, always available, survives a failed write), then
      // the durable append. Both are on the stall path only — never on a request.
      console.error(`${formatStallLine(record)} | recorded in ${stallLogFile()}`);
      appendStall(record).catch((e) => {
        console.warn(`[warden:stall] could not append to ${stallLogFile()}: ${e.message}`);
      });
      // WARDEN-1278 — fold into the telemetry window (aggregate, bounded, closed-
      // set culprit keys). Gated LIVE on the `incidents` category and a no-op
      // while it is off; the window is only ever forwarded on the 5-minute flush,
      // never per stall. LAST and WRAPPED, deliberately: the two local channels
      // above must not be able to fail because of a telemetry producer — the
      // ordering IS the guarantee that this slice cannot degrade the owner's read
      // channels, and src/server-stall-telemetry.test.js drives a THROWING
      // producer to prove it.
      try { getServerStallTelemetry().recordStall(record); } catch { /* never the server's problem */ }
    });
  }

  function startLoopMonitor() {
    wireStallSink();
    loopMonitor.start();
    // Time the synchronous fs / child_process members so a stall can be attributed
    // to the actual blocking call, not just to the request or sweep it happened
    // inside. One patch covers every runtime sync site in src/ that calls through
    // the module object (`import fs from 'node:fs'` → `fs.statSync(…)`), which is
    // all of them — session, collection, companion, LLM, git and claude-session
    // reads, including the hand-rolled fd-level windowed reads
    // (openSync/readSync/closeSync) that carry the largest synchronous payloads.
    // This MEASURES the sites WARDEN-831 deliberately left synchronous; it does
    // not convert them (out of scope, and the point is to stop guessing).
    // Calls at/above the monitor's floor (100ms) take a ring slot; ALL calls are
    // aggregated per label, so a stall made of many cheap calls is still visible.
    const requireCjs = createRequire(import.meta.url);
    instrumentSyncIo(loopMonitor, { fs, childProcess: requireCjs('node:child_process') });
    // Age out records older than 7 days, once, off the request path.
    pruneStallLog().catch((e) => console.warn(`[warden:stall] prune failed: ${e.message}`));
  }

  function setupSuspensionDiscrimination({
    forked = typeof process.send === 'function',
    monitor = loopMonitor,
    clock = createSuspendClock(),
  } = {}) {
    if (!forked) return null; // standalone: today's behavior, byte for byte
    if (suspendMessageHandler) process.removeListener('message', suspendMessageHandler);

    suspendMessageHandler = (msg) => {
      // The IPC channel carries several producers' messages; anything that is not
      // one of ours — including a malformed one — is ignored, never thrown on.
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'telemetry-suspend-open') {
        if (typeof msg.at === 'number') clock.onSuspend(msg.at);
      } else if (msg.type === 'telemetry-suspend-close') {
        // onResume, NOT ingestWindow: the close must CLEAR the in-flight open
        // state (an open marker left standing would suppress every later stall
        // forever), and the fork→main channel is ordered, so the matching open
        // marker has already been applied. A close with no open on record is
        // dropped — the tracker's own idempotent resume semantics.
        if (typeof msg.from === 'number' && typeof msg.to === 'number') clock.onResume(msg.to);
      } else if (msg.type === 'telemetry-suspend-replay') {
        const replayed = Array.isArray(msg.windows) ? msg.windows : [];
        for (const w of replayed) clock.ingestWindow(w);
        if (typeof msg.openAt === 'number') clock.onSuspend(msg.openAt);
      }
    };
    // The fork's FIRST 'message' listener — grep confirmed none existed before
    // this slice; main.cjs's listener is on the parent side of the same channel.
    process.on('message', suspendMessageHandler);

    monitor.setSuspendPolicy({
      maxCredibleLagMs: MAX_CREDIBLE_LAG_MS,
      // The monotonic (from, to) pair is ignored on purpose — the wall bounds are
      // the same intervals in the domain the suspend windows live in. A caller
      // that somehow passes no wall bounds (never this monitor's tick) reads as
      // "no windows span" — spansSuspend's own non-numeric contract — which is
      // the monitor's fail-open direction: report the stall.
      isSuspendBoundary: (from, to, wallFrom, wallTo) => clock.spansSuspend(wallFrom, wallTo),
    });

    return {
      clock,
      dispose() {
        if (suspendMessageHandler) {
          process.removeListener('message', suspendMessageHandler);
          suspendMessageHandler = null;
        }
        monitor.setSuspendPolicy({ maxCredibleLagMs: null, isSuspendBoundary: null });
      },
    };
  }

  return { wireStallSink, startLoopMonitor, setupSuspensionDiscrimination };
}
