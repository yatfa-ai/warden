import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { routeOperationKey, REQUEST_MAX_OPERATIONS } from './requestTelemetry.js';

/**
 * End-to-end HTTP tests for the WARDEN-1292 request telemetry — the
 * operational-metrics producer exercised through the REAL middleware wiring.
 *
 * Same isolation discipline as file-exists-telemetry-http.test.js: server.js
 * evaluates `const cfg = load()` at module load, so config must be written
 * BEFORE the single import (node --test runs each file in its own process, so
 * the telemetry-ON config here never leaks into the other suite's
 * telemetry-OFF boot — that companion lives in
 * src/request-telemetry-http-off.test.js).
 *
 * What this pins beyond the unit suite (src/requestTelemetry.test.js):
 *   • with `operational-metrics` consent ON, exercising REAL /api routes
 *     through the REAL first-middleware fold yields, in one closed window, an
 *     operations[] carrying each exercised route's pattern key with count ≥ 1;
 *   • an un-routed /api request folds to the `unmatched` sink and the garbage
 *     NEVER appears in a key — and a window MIXING real route traffic with
 *     that un-routed request still builds an event that passes
 *     validateBaseEvent (the regression leg for the defect this ticket was
 *     parked on: one garbage request must never void the real route metrics);
 *   • a HEAD request — served by the GET handler with req.method staying
 *     'HEAD' — folds under the route's `get-` key; NO `head-*` key ever
 *     appears (the audit's blocking finding: unaliased head-* twins were a
 *     route.methods-invisible growth axis that could exhaust maxOperations
 *     and reach the unsendable __other__ accumulator);
 *   • the derived SIZING TRIPWIRE — the live route table's distinct pattern
 *     keys (walked from the REAL router, including the nested git router)
 *     fit under the producer's maxOperations WITH room for the unmatched
 *     sink, and maxOperations + 1 stays under the wire's per-event
 *     operations cap — so the aggregator's unsendable reserved overflow key
 *     can never be reached. When a sibling PR adds routes, THIS test — not a
 *     prose number — is what fails.
 */

const require = createRequire(import.meta.url);
// The emit-side validator (electron/telemetry-source.cjs) — the wire's own
// structural check for an operational-metrics event, including the
// per-operation name pattern that makes `__other__` unsendable.
const { SCHEMA_VERSION, validateBaseEvent } = require('../electron/telemetry-source.cjs');
const { buildOperationalMetricsEvent } = require('../electron/telemetry-metrics-event.cjs');

// Mirrored from the canonical schema (web/src/lib/telemetry/schema.ts): the
// per-event cap on operation rows (maxOperations distinct + the one reserved
// overflow accumulator). The CJS validator enforces the same number
// internally (MAX_METRIC_OPERATIONS); mirrored here so the tripwire pins the
// WIRE bound this module's sizing must respect.
const MAX_OPERATIONS_PER_EVENT = 129;

let httpServer;
let baseUrl;
let originalHome;
let tempHome;
let requestTelemetry;
let app;

before(async () => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-reqtel-home-'));
  process.env.HOME = tempHome;

  const wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  // Telemetry operational-metrics ON — the consent gate under test. Everything
  // else stays at defaults (hosts: [] → no SSH anywhere on these routes).
  fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({
    hosts: [],
    telemetryOperationalMetricsEnabled: true,
  }));

  // Import server.js ONCE — after HOME/config are in place.
  const mod = await import('./server.js');
  app = mod.app;
  requestTelemetry = mod.requestTelemetry;
  httpServer = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    httpServer.once('listening', resolve);
    httpServer.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

after(async () => {
  if (httpServer) await new Promise((r) => httpServer.close(r));
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('/api request telemetry through the REAL wiring (WARDEN-1292)', () => {
  it('folds real /api routes into their pattern keys within one closed window', async () => {
    // One static-segment route (zero-ssh by design) and one :id-bearing route
    // (bogus id → 404, which is a SERVED answer: statusCode < 500 → ok).
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    const agents = await fetch(`${baseUrl}/api/collections/does-not-exist/agents`);
    assert.equal(agents.status, 404);

    const snap = requestTelemetry.flushNow();
    assert.ok(snap, 'a window with observations must flush');
    const names = snap.operations.map((o) => o.operation);
    const healthOp = snap.operations.find((o) => o.operation === 'get-api-health');
    const agentsOp = snap.operations.find((o) => o.operation === 'get-api-collections-id-agents');
    assert.ok(healthOp, `the static route folded under its pattern key (got: ${names.join(', ')})`);
    assert.ok(healthOp.count >= 1);
    assert.ok(agentsOp, `the :id route folded with id in place of the concrete id (got: ${names.join(', ')})`);
    assert.ok(agentsOp.count >= 1);
    assert.equal(JSON.stringify(snap).includes('does-not-exist'), false,
      'the concrete id can never ride a key');
  });

  it('a HEAD request folds under the GET key — no head-* key ever appears', async () => {
    // The audit-blocking leg: Express serves every GET route's HEAD variant
    // through the GET handler with req.method staying 'HEAD' — a runtime key
    // source the route table's methods census never sees. routeOperationKey
    // aliases 'head' onto 'get', so the observation must land in the route's
    // existing `get-` row and NO `head-*` key may exist (an unaliased head-*
    // twin per GET route is the growth axis that could exhaust
    // REQUEST_MAX_OPERATIONS and reach the unsendable __other__ accumulator).
    const res = await fetch(`${baseUrl}/api/health`, { method: 'HEAD' });
    assert.equal(res.status, 200);

    const snap = requestTelemetry.flushNow();
    assert.ok(snap, 'the window must flush');
    const healthOp = snap.operations.find((o) => o.operation === 'get-api-health');
    assert.ok(healthOp && healthOp.count >= 1,
      `the HEAD observation folded under get-api-health (got: ${snap.operations.map((o) => o.operation).join(', ')})`);
    assert.equal(snap.operations.some((o) => o.operation.startsWith('head-')), false,
      `no head-* key may ever be emitted (got: ${snap.operations.map((o) => o.operation).join(', ')})`);
    assert.equal(JSON.stringify(snap).includes('"head-'), false,
      'no head-* key may ever appear anywhere in the snapshot');
  });

  it('an un-routed /api request folds to unmatched — and the mixed window still passes validateBaseEvent', async () => {
    // The regression leg for the defect this ticket was parked on: real route
    // traffic + one garbage request must deliver BOTH — the garbage under the
    // single `unmatched` constant, the real metrics intact, the whole event
    // schema-valid. (Before the amendment this design routed the garbage into
    // the aggregator's reserved `__other__`, which fails the validators and
    // would have voided every legitimate key in the window.)
    const ok = await fetch(`${baseUrl}/api/health`);
    assert.equal(ok.status, 200);
    const garbage = await fetch(`${baseUrl}/api/garbage-NOT-a-route`);
    assert.equal(garbage.status, 404);

    const snap = requestTelemetry.flushNow();
    assert.ok(snap);
    const unmatched = snap.operations.find((o) => o.operation === 'unmatched');
    assert.ok(unmatched, 'the un-routed request folded under the unmatched constant');
    assert.ok(unmatched.count >= 1);
    const health = snap.operations.find((o) => o.operation === 'get-api-health');
    assert.ok(health && health.count >= 1, 'the real route metric SURVIVED the mixed window');
    assert.equal(JSON.stringify(snap).includes('garbage-NOT-a-route'), false,
      'the garbage path can never appear in a key');

    // The wire's own structural check: main builds exactly this event from
    // exactly this snapshot shape. A `__other__` row (or any key failing the
    // operation-name pattern) would make validateBaseEvent reject the WHOLE
    // event here.
    const event = buildOperationalMetricsEvent({
      snapshot: snap,
      schemaVersion: SCHEMA_VERSION,
      runtime: 'server',
      now: () => 0,
    });
    assert.ok(event, 'the snapshot builds into an operational-metrics event');
    assert.equal(validateBaseEvent(event), true, 'the MIXED window (real routes + one garbage request) passes validateBaseEvent');
    assert.equal(JSON.stringify(event).includes('__other__'), false,
      'the unsendable reserved overflow key never rides the event');
  });

  it('the sizing tripwire: the live route census fits maxOperations WITH the unmatched sink, and maxOperations + 1 ≤ 129', () => {
    // Derive the census from the REAL router — top-level route layers AND
    // nested router handles (the git router is mounted via app.use, which
    // hides its 15 routes from a top-level-only walk). Derived, never frozen:
    // a sibling PR that adds routes moves this number and this test still
    // passes until the budget is genuinely exhausted.
    // COMPLETE because of the HEAD alias: every GET route also serves HEAD
    // with req.method='HEAD' — a variant route.methods never lists — but
    // routeOperationKey aliases 'head' onto the route's `get-` key, so
    // deriving the census through THE SAME MAPPER the producer folds with
    // yields exactly the reachable key set. (Auto-OPTIONS answers never
    // match a route, so they fold to the budgeted unmatched sink.)
    function collectRoutes(stack, out = []) {
      for (const layer of stack) {
        if (layer && layer.route) out.push(layer.route);
        else if (layer && layer.handle && Array.isArray(layer.handle.stack)) {
          collectRoutes(layer.handle.stack, out);
        }
      }
      return out;
    }
    const router = app.router || app._router;
    assert.ok(router && Array.isArray(router.stack), 'the express router stack is walkable');
    const routes = collectRoutes(router.stack);

    const distinctKeys = new Set();
    let walkablePaths = 0;
    for (const route of routes) {
      const p = route.path;
      // Express regex/array routes carry a non-string path — nothing
      // derivable; they fold to the unmatched sink by construction, which the
      // budget below already accounts for.
      const pathVariants = Array.isArray(p) ? p : [p];
      for (const pv of pathVariants) {
        if (typeof pv !== 'string') continue;
        walkablePaths += 1;
        for (const method of Object.keys(route.methods || {})) {
          if (!route.methods[method]) continue;
          distinctKeys.add(routeOperationKey(method, pv));
        }
      }
    }
    assert.ok(walkablePaths > 0, 'the walk actually found route layers');
    assert.ok(distinctKeys.size > 0, 'the walk actually derived keys');

    // (a) census + the unmatched sink ≤ maxOperations — the reserved
    //     `__other__` accumulator is then structurally unreachable (it only
    //     exists beyond maxOperations distinct keys).
    const budget = new Set([...distinctKeys, 'unmatched']).size;
    assert.ok(
      budget <= REQUEST_MAX_OPERATIONS,
      `route census + unmatched sink (${budget}) exceeds REQUEST_MAX_OPERATIONS (${REQUEST_MAX_OPERATIONS}) — `
      + 'raise REQUEST_MAX_OPERATIONS in src/requestTelemetry.js. '
      + `Derived keys: ${[...distinctKeys].sort().join(', ')}`,
    );

    // (b) the wire bound: maxOperations distinct keys + the one reserved
    //     overflow accumulator must stay ≤ the schema's per-event cap.
    assert.ok(
      REQUEST_MAX_OPERATIONS + 1 <= MAX_OPERATIONS_PER_EVENT,
      `REQUEST_MAX_OPERATIONS (${REQUEST_MAX_OPERATIONS}) + reserved overflow exceeds the wire cap (${MAX_OPERATIONS_PER_EVENT})`,
    );
  });
});
