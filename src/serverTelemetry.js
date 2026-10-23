// WARDEN-1916 — the server child's telemetry-producer wiring, extracted
// verbatim from src/server.js. Structural-only: createServerTelemetry builds,
// starts and hooks up the eight producers exactly as server.js did inline, then
// hands them back so server.js can inject them into the routers / WS layer and
// re-export them for the test seams (`server.X`).
//
// Side-effect-free at module load: nothing here runs until
// createServerTelemetry() is called (server.js calls it once, at the same
// module position the inline block used to occupy).
import { resolveConsent } from './telemetry-consent.cjs';
import { createFileExistsTelemetry } from './fileExistsTelemetry.js';
import { createProcessMemoryProducer } from './telemetry-process-memory.cjs';
import { createServerStallTelemetry, routeSegmentsOf } from './serverStallTelemetry.js';
import { createPaneInputTelemetry } from './paneInputTelemetry.js';
import { createRequestTelemetry } from './requestTelemetry.js';
import { createSshTelemetry } from './sshTelemetry.js';
import { createCompanionRpcTelemetry } from './companionRpcTelemetry.js';
import { createWorkspaceNamesTelemetry } from './workspaceNamesTelemetry.js';
import { setSshRunObserver } from './ssh.js';
import { setInputAckObserver, setCompanionRpcObserver } from './companion.js';

export function createServerTelemetry({ app, cfg, chatCatalog }) {
  // Shared by the telemetry producers below: the one IPC egress to the Electron
  // main process (no-op when standalone — no parent). `process.send` is read at
  // CALL time, never captured, so a test installing it after import still works.
  function forwardToParent(type, snapshot) {
    if (typeof process.send !== 'function') return;
    process.send({ type, snapshot });
  }
  // The operational-metrics consent, resolved LIVE through the one authority
  // (cfg is mutated in place by applyConfigPut). The `incidents` and `names`
  // producers use different categories and keep their own lambdas.
  const operationalMetricsConsent = () => resolveConsent(cfg)['operational-metrics'] === true;

  // WARDEN-1258 — the file-exists probe metrics producer. Consent is resolved
  // LIVE through the one authority (cfg is mutated in place by applyConfigPut,
  // so a Settings flip gates the very next record()), and the windowed snapshot
  // is forwarded to the Electron main process over the fork's IPC channel — the
  // same channel forwardTelemetryConfig below uses, with the same process.send
  // guard for standalone `node src/server` runs (no parent → no forward; the
  // module is inert on the wire). Started immediately: the interval is unref'd,
  // so importing server.js in a test never hangs on it.
  const fileExistsTelemetry = createFileExistsTelemetry({
    consent: operationalMetricsConsent,
    send: (snapshot) => forwardToParent('telemetry-metrics', snapshot),
  });
  fileExistsTelemetry.start();

  // WARDEN-1278 — the server-stall telemetry producer. Same three properties as
  // the metrics producer above: consent resolved LIVE through the one authority
  // (cfg is mutated in place by applyConfigPut, so a Settings flip gates the very
  // next record()), the windowed snapshot forwarded to the Electron main process
  // over the fork's IPC channel, and the same process.send guard for standalone
  // `node src/server` runs.
  //
  // It rides the EXISTING `incidents` category — a multi-second freeze IS an
  // incident, and it is the same category the main process's `performance-stall`
  // already travels under. No new category, no new checkbox.
  //
  // `knownSegments` is derived LIVE from the express router (every static segment
  // of the real route table) so the culprit-key mapping cannot drift from the
  // routes it maps. Passed as a THUNK because routes are registered across the
  // whole module and the table is only complete after the last one; the
  // aggregator resolves it on first use and memoizes.
  const serverStallTelemetry = createServerStallTelemetry({
    consent: () => resolveConsent(cfg).incidents === true,
    knownSegments: () => routeSegmentsOf(app),
    send: (snapshot) => forwardToParent('telemetry-stalls', snapshot),
  });
  serverStallTelemetry.start();

  // WARDEN-1385 — the pane-input telemetry producer: the two SERVER-side hops of
  // a keystroke's journey (write leg + tmux round trip), folded into the same
  // operational-metrics channel as the file-exists probes. The RENDERER half of
  // the felt path (keystroke→echo e2e, the paint leg, main-thread health) is
  // measured in web/src/lib/paneLatency.ts and arrives at main over its own IPC
  // bridge — the two histograms are read beside each other to attribute a slow
  // echo to input write, tmux round trip, WS delivery or renderer paint.
  //
  // Same three properties as the two producers above: consent resolved LIVE
  // through the one authority, the windowed snapshot forwarded to the Electron
  // main process over the fork's IPC channel, and the same process.send guard
  // for standalone `node src/server` runs. Started after the WS layer is wired
  // (below) so the correlation object exists before the first attach; the
  // producer is handed to setupWsLayer, which correlates per pane.
  const paneInputTelemetry = createPaneInputTelemetry({
    consent: operationalMetricsConsent,
    send: (snapshot) => forwardToParent('telemetry-metrics', snapshot),
  });
  paneInputTelemetry.start();
  // WARDEN-1491: the companion attachInput request→ack leg of the felt path, so a
  // tail in pane-input-roundtrip can be attributed to the channel/daemon (this
  // histogram) or to tmux/the agent (the other one) from production telemetry.
  setInputAckObserver((ms, ok) => paneInputTelemetry.noteInputAck(ms, ok));

  // WARDEN-1292 — the request-metrics producer: every /api request's duration +
  // ok/fail verdict, folded into the same operational-metrics channel as the
  // file-exists probes and the pane-input hops. The fold happens in the FIRST
  // middleware above (the loop-monitor span's close handler), keyed by the
  // route table's own pattern literal via src/requestTelemetry.js's closed-set
  // mapping — a concrete URL is never an input. Same three properties as the
  // producers above: consent resolved LIVE through the one authority (cfg is
  // mutated in place by applyConfigPut, so a Settings flip gates the very next
  // record()), the windowed snapshot forwarded to the Electron main process
  // over the fork's IPC channel, and the same process.send guard for standalone
  // `node src/server` runs. Started immediately: the interval is unref'd, so
  // importing server.js in a test never hangs on it. Declared AFTER the
  // middleware that references it — safe because no request is served before
  // module evaluation completes (same lazy-reference pattern as wireStallSink).
  const requestTelemetry = createRequestTelemetry({
    consent: operationalMetricsConsent,
    send: (snapshot) => forwardToParent('telemetry-metrics', snapshot),
  });
  requestTelemetry.start();

  // WARDEN-1578 — the raw-ssh vantage: one `ssh-run` fold per settled ssh.js run()
  // (on win32 that IS one full handshake). okCount/failCount = handshake
  // completed/failed, NOT the remote command's verdict (see src/sshTelemetry.js).
  // Same consent + IPC-forward discipline as the producers above.
  const sshTelemetry = createSshTelemetry({
    consent: operationalMetricsConsent,
    send: (snapshot) => forwardToParent('telemetry-metrics', snapshot),
  });
  sshTelemetry.start();
  setSshRunObserver((ms, ok) => sshTelemetry.recordRun(ms, ok));

  // WARDEN-1598 — the companion-RPC vantage: one fold per settled
  // CompanionChannel.call() into a closed per-method table. okCount = the channel
  // delivered a verdict (host-side ok:false is a command result and counts ok);
  // failCount = transport failure incl. timeout (right-censored). See
  // src/companionRpcTelemetry.js.
  const companionRpcTelemetry = createCompanionRpcTelemetry({
    consent: operationalMetricsConsent,
    send: (snapshot) => forwardToParent('telemetry-metrics', snapshot),
  });
  companionRpcTelemetry.start();
  setCompanionRpcObserver((method, ms, ok) => companionRpcTelemetry.recordRpc(method, ms, ok));

  // WARDEN-1508 — the server child's own process-memory producer: samples THIS
  // process (RSS + JS heap + uptime) every ~30s into fixed-size accumulators and
  // forwards ONE folded window per ~5 minutes over the fork's IPC channel as
  // 'telemetry-process-memory' (main builds the `process-memory` event with the
  // runtime FIXED to `server`). It rides the existing `operational-metrics`
  // category, resolved LIVE through the one authority — while off, no sample is
  // taken. Same process.send guard for standalone `node src/server` runs; timers
  // are unref'd so importing server.js in a test never hangs on them.
  const serverProcessMemory = createProcessMemoryProducer({
    sources: [{
      runtime: 'server',
      read: () => {
        const m = process.memoryUsage();
        return { rssBytes: m.rss, heapUsedBytes: m.heapUsed, ageMs: Math.round(process.uptime() * 1000) };
      },
    }],
    consent: operationalMetricsConsent,
    send: (_runtime, snapshot) => forwardToParent('telemetry-process-memory', snapshot),
  });
  serverProcessMemory.start();

  // WARDEN-1416 — the workspace-names producer: the `names` consent category's
  // OWN carrying event, and the slice that closes that category's dead switch.
  // Until now the category could only decorate events other producers built, so
  // a names-alone consent sent nothing — a checkbox promising a flow that never
  // happened. This producer reads the in-memory chat catalog's sidebar names
  // (chatCatalog.snapshot() — zero new SSH, zero new polls) once per window,
  // keeps ONLY the `.name` strings (every other catalog field is dropped at this
  // collection boundary), de-duplicates, caps at NAMES_MAX, and forwards ONE
  // bounded snapshot over the fork's IPC channel. Consent is resolved LIVE
  // through the one authority and gates ONLY on the names category — identifying
  // data stays behind its own conscious opt-in, never folded into a metrics
  // category. Same three properties as the producers above: live consent (cfg is
  // mutated in place by applyConfigPut), the same process.send guard for
  // standalone `node src/server` runs, and an unref'd interval.
  const workspaceNamesTelemetry = createWorkspaceNamesTelemetry({
    consent: () => resolveConsent(cfg).names === true,
    catalog: () => chatCatalog.snapshot(),
    send: (snapshot) => forwardToParent('telemetry-names', snapshot),
  });
  workspaceNamesTelemetry.start();

  return {
    fileExistsTelemetry,
    serverStallTelemetry,
    paneInputTelemetry,
    requestTelemetry,
    sshTelemetry,
    companionRpcTelemetry,
    serverProcessMemory,
    workspaceNamesTelemetry,
  };
}
