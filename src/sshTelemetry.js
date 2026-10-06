// Raw-ssh telemetry (WARDEN-1578) — the `ssh-run` operation of the consented
// `operational-metrics` stream, folded from src/ssh.js run().
//
// WHY: on win32 getConnection returns {socketPath:null}, so ONE run() = ONE full
// ssh handshake — the operation's `count` IS the handshake count the running
// product pays. Before this, WARDEN-270's bar ("with the companion installed, a
// session opens zero connections outside its channel") was verifiable only via
// the synthetic scripts/companion-benchmark.mjs.
//
// SEMANTICS OF okCount / failCount — READ THIS BEFORE DECODING: okCount means
// "the handshake COMPLETED", failCount means "the handshake FAILED" (connection
// establishment / transport failure per ssh.js isTransportFailure). It is NOT the
// remote command's verdict: a remote command exiting non-zero (e.g. `tmux
// has-session` on an absent session) is a COMMAND RESULT and counts as ok here.
// Folding it as a failure would be the WARDEN-1531 trap (command result read as
// transport health).
//
// WHAT IT MAY NEVER CARRY (WARDEN-443): hosts, commands, stderr, argv. The
// observer receives only (durationMs, ok); the operation name is a constant
// kebab-case literal.
//
// CONSENT: gated LIVE on `operational-metrics`; off → record refuses and the
// window is dropped at flush (nothing retained). Scaffold shared via
// src/telemetryProducer.js, exactly like src/fileExistsTelemetry.js.

import { createMetricAggregator } from './telemetry-metrics.cjs';
import { createConsentGatedWindow } from './telemetryProducer.js';

/** The one closed-set operation key (matches the schema's OPERATION_NAME_RE). */
export const SSH_RUN_OP = 'ssh-run';

/** Window cadence: 5 minutes; an idle window is not sent. */
export const SSH_RUN_FLUSH_MS = 5 * 60_000;

export function createSshTelemetry({
  consent,
  send,
  intervalMs = SSH_RUN_FLUSH_MS,
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

  // Fold ONE settled run(): `ok` = handshake completed (NOT command verdict).
  // Returns false when consent is off; never throws.
  function recordRun(durationMs, ok) {
    try {
      if (!gated.isEnabled()) return false;
      return aggregator.record(SSH_RUN_OP, durationMs, { ok: ok !== false });
    } catch {
      return false;
    }
  }

  return { recordRun, flushNow: gated.flushNow, start: gated.start };
}
