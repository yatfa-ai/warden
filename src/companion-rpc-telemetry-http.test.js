/**
 * WARDEN-1598 wiring test: a REAL CompanionChannel.call() observation reaches
 * process.send as `telemetry-metrics` under operational-metrics consent, and
 * does NOT without it. server.js evaluates its config at import, so each
 * posture boots in its own process: this file = consent ON; the OFF twin is
 * src/companion-rpc-telemetry-http-off.test.js.
 */

import { defineTelemetryWiringTest } from './telemetryWiringHarness.mjs';

defineTelemetryWiringTest('companion-rpc', true);
