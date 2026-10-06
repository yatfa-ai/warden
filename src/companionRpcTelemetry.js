// Companion-RPC telemetry (WARDEN-1598) — the COMPANION-CHANNEL vantage of the
// consented `operational-metrics` stream, folded from CompanionChannel.call()
// (src/companion.js setCompanionRpcObserver).
//
// WHY: the only companion op on the wire used to be `companion-input-ack`
// (keystroke ack). The felt tail of get-api-agent-states rides the companion
// channel, and nothing said WHICH channel RPC owns it. This slice measures
// per-RPC latency + transport verdict; it does NOT claim the tail is the channel.
//
// SEMANTICS OF okCount / failCount — READ THIS BEFORE DECODING: okCount means
// "the channel DELIVERED A VERDICT" (the host answered, ok:true OR a host-side
// ok:false command result). failCount means a TRANSPORT failure: dead channel,
// write throw, channel death mid-flight, or a TIMEOUT. A host-side ok:false is a
// COMMAND RESULT and counts as ok (the WARDEN-1531 / sshTelemetry
// handshake-vs-verdict discipline).
//
// HONEST LIMITS:
//  - Latency is request-write → settle on the JS side. It INCLUDES queueing behind
//    the host's serial lane and the ssh hop — deliberate (it is what the owner
//    feels). Do NOT call it "host execution time".
//  - A timeout folds at its timeout value: right-censored, and counted as failCount.
//  - ping (infra) and attachInput (folded as companion-input-ack) are never folded.
//
// WHAT IT MAY NEVER CARRY (WARDEN-443): hosts, containers, sessions, pane keys,
// payloads, error text. Only (closedName, durationMs, ok) crosses; the operation
// name comes from a CLOSED table of constant kebab literals, and a method outside
// the table is DROPPED, never folded under its raw string.
//
// CONSENT: gated LIVE on `operational-metrics`; off → record refuses and the window
// is dropped at flush. Own aggregator instance so it cannot crowd the
// request-telemetry aggregator's operation cap. Scaffold: src/telemetryProducer.js.

import { createMetricAggregator } from './telemetry-metrics.cjs';
import { createConsentGatedWindow } from './telemetryProducer.js';

/** Closed method → operation-name table (all ≤64-char kebab). */
export const COMPANION_RPC_OPS = Object.freeze({
  discover: 'companion-rpc-discover',
  capturePanes: 'companion-rpc-capture-panes',
  hasSession: 'companion-rpc-has-session',
  exec: 'companion-rpc-exec',
  writeFile: 'companion-rpc-write-file',
  spawnSession: 'companion-rpc-spawn-session',
  killSession: 'companion-rpc-kill-session',
  resize: 'companion-rpc-resize',
  send: 'companion-rpc-send',
  sendKeys: 'companion-rpc-send-keys',
  subscribePanes: 'companion-rpc-subscribe-panes',
  unsubscribePanes: 'companion-rpc-unsubscribe-panes',
  attachStart: 'companion-rpc-attach-start',
  attachResize: 'companion-rpc-attach-resize',
  attachKill: 'companion-rpc-attach-kill',
});

/** Window cadence: 5 minutes; an idle window is not sent. */
export const COMPANION_RPC_FLUSH_MS = 5 * 60_000;

export function createCompanionRpcTelemetry({
  consent,
  send,
  intervalMs = COMPANION_RPC_FLUSH_MS,
  setIntervalImpl = setInterval,
  aggregator = createMetricAggregator(),
} = {}) {
  const gated = createConsentGatedWindow({
    consent,
    send,
    intervalMs,
    setIntervalImpl,
    aggregator,
    hasAnything: (snapshot) => snapshot.operations.length > 0 || snapshot.rejected > 0,
  });

  // Fold ONE settled RPC. Returns false when consent is off or the method is not
  // in the closed table; never throws.
  function recordRpc(method, durationMs, ok) {
    try {
      if (typeof method !== 'string' || !Object.hasOwn(COMPANION_RPC_OPS, method)) return false;
      if (!gated.isEnabled()) return false;
      return aggregator.record(COMPANION_RPC_OPS[method], durationMs, { ok: ok !== false });
    } catch {
      return false;
    }
  }

  return { recordRpc, flushNow: gated.flushNow, start: gated.start };
}
