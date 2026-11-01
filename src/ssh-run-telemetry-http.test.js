/**
 * WARDEN-1578 wiring test: a REAL ssh.js run() observation reaches
 * process.send as `telemetry-metrics` under operational-metrics consent, and
 * does NOT without it. server.js evaluates its config at import, so each
 * posture boots in its own process: this file = consent ON; the OFF twin is
 * src/ssh-run-telemetry-http-off.test.js.
 */

import { defineTelemetryWiringTest } from './telemetryWiringHarness.mjs';

defineTelemetryWiringTest('ssh-run', true);
