import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// WARDEN-1278 — the server-stall IPC forward, end to end across the fork
// boundary that the whole slice exists to cross.
//
// THE GAP THIS CLOSES. warden's backend is a FORKED CHILD of the Electron main
// process. Every consent-gated telemetry pipeline and the transport live in
// MAIN, so a signal observed in the child can only ever be reported by reaching
// main — and until the v6 schema bump there was no `server` runtime on the wire
// for it to be reported AS. `process.send({ type: 'telemetry-stalls', snapshot })`
// is the ONLY path a server freeze can take to main, and this proves it works
// against the REAL forked server rather than a stub.
//
// What is asserted here that no unit suite can assert:
//   • the child really is given a working process.send (the 4th 'ipc' stdio
//     slot, exactly as electron/main.cjs supplies it);
//   • a window folded from MULTIPLE stalls arrives as ONE message, not one per
//     stall — the volume property the aggregate exists for;
//   • the snapshot that lands on the parent builds, through the REAL main-side
//     builder, into an event the REAL canonical validator ACCEPTS. That is the
//     end-to-end contract: producer shape → IPC → builder → wire schema, with no
//     hand-written fixture anywhere in the chain.
//
// A future refactor that drops process.send, renames the message type, changes
// the snapshot shape, or lets the builder and the schema drift apart turns this
// red while every other telemetry suite stays green — the same silent-break
// src/server-telemetry-ipc.test.js locks out for the config channel.
//
// HOW THE CHILD IS DRIVEN. A real freeze would need the child's loop blocked for
// multiple seconds and its 5-minute flush to elapse — minutes per assertion and
// flaky on a loaded runner. So the fork target is a thin HARNESS that imports
// the REAL src/server.js (same process, same module instance, same
// `process.send`) and exposes two calls over IPC: deliver a record through the
// production setOnStall sink, and close the window. Everything under test —
// the sink wiring, the fold, the consent gate, the forward — is production code
// running in a real forked child; only the trigger is synthetic.
//
// Deliberately NOT a test-only branch inside server.js: production code should
// not carry a drive-my-diagnostics IPC handler, even a gated one.
//
// Same isolated-server pattern as src/server-telemetry-ipc.test.js: unique temp
// HOME, own config.json, throwaway PORT. node --test runs each file in its own
// process, so this never cross-talks with the other server-*.test.js files.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.resolve(__dirname, 'server.js');
const HARNESS_PATH = path.resolve(__dirname, '..', 'test-fixtures', 'stall-ipc-harness.mjs');
const require = createRequire(import.meta.url);
const { buildServerStallEvent } = require('../electron/telemetry-stall-event.cjs');
const { validateBaseEvent, SCHEMA_VERSION } = require('../electron/telemetry-source.cjs');

let child;
let baseUrl;
let tempHome;
let originalHome;

/** Bind to :0, grab the ephemeral port, close — yields a currently-free port. */
function grabFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

before(async () => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-stall-ipc-'));
  const wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  // incidents ON: this suite is about the FORWARD. The consent gate itself is
  // web/serverStallTelemetry.test.mjs's and src/server-stall-telemetry.test.js's
  // subject, and one of the cases below flips it back off to prove the drop
  // survives the fork boundary too.
  fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({
    hosts: [], telemetryIncidentsEnabled: true,
  }));

  const port = await grabFreePort();
  child = fork(HARNESS_PATH, [SERVER_PATH], {
    env: { ...process.env, HOME: tempHome, PORT: String(port) },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server fork did not announce ready in time')), 15000);
    child.stdout.on('data', (d) => {
      if (d.toString().includes('warden ui →')) { clearTimeout(timer); resolve(); }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server fork exited (code ${code}) before ready`));
    });
  });

  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (child) {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.on('exit', resolve));
  }
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/** Resolve the NEXT telemetry-stalls IPC message. Arm BEFORE driving the child. */
function nextStallWindow(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('message', onMsg);
      reject(new Error(`timed out waiting for a telemetry-stalls IPC message (${timeoutMs}ms)`));
    }, timeoutMs);
    function onMsg(msg) {
      if (msg && msg.type === 'telemetry-stalls') {
        clearTimeout(timer);
        child.off('message', onMsg);
        resolve(msg);
      }
    }
    child.on('message', onMsg);
  });
}

/** Collect every telemetry-stalls message that arrives over `ms`. */
function collectStallWindows(ms) {
  const got = [];
  const onMsg = (msg) => { if (msg && msg.type === 'telemetry-stalls') got.push(msg); };
  child.on('message', onMsg);
  return new Promise((resolve) => setTimeout(() => {
    child.off('message', onMsg);
    resolve(got);
  }, ms));
}

/**
 * Drive stalls in the forked child: deliver each record through the PRODUCTION
 * setOnStall sink, then close the window — the same two things a real freeze and
 * a real 5-minute flush do, without the wait. See the HOW THE CHILD IS DRIVEN
 * note at the top of this file.
 */
function driveStalls(records) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('message', onMsg);
      reject(new Error('timed out waiting for the drive ack'));
    }, 5000);
    function onMsg(msg) {
      if (msg && msg.type === 'test-stalls-driven') {
        clearTimeout(timer);
        child.off('message', onMsg);
        resolve(msg);
      }
    }
    child.on('message', onMsg);
    child.send({ type: 'test-drive-stalls', records });
  });
}

const STALL = (over = {}) => ({
  type: 'performance-stall',
  runtime: 'server',
  source: 'event-loop',
  timestamp: new Date().toISOString(),
  lagMs: 4200,
  heartbeatMs: 1000,
  thresholdMs: 1000,
  attribution: [{ label: 'sweep:attention', overlapMs: 4100, open: true, durationMs: 4300 }],
  syncTotals: [],
  ...over,
});

describe('telemetry-stalls IPC forward (WARDEN-1278) — server fork → parent', () => {
  it('forwards ONE window for MULTIPLE stalls — not one message per stall', async () => {
    const done = nextStallWindow();
    await driveStalls([
      STALL({ lagMs: 1500 }),
      STALL({
        lagMs: 6000,
        attribution: [{ label: 'GET /api/claude-sessions', overlapMs: 5900, open: false, durationMs: 5900 }],
        syncTotals: [{ label: 'fs.readFileSync', calls: 812, totalMs: 5800 }],
      }),
      STALL({ lagMs: 2200 }),
    ]);
    const msg = await done;
    assert.equal(msg.type, 'telemetry-stalls');
    const s = msg.snapshot;
    assert.equal(s.count, 3, 'three stalls arrived as ONE aggregate');
    assert.equal(s.totalMs, 9700);
    assert.equal(s.maxMs, 6000);
    assert.equal(s.buckets.reduce((a, b) => a + b, 0), 3, 'every stall is in the histogram');
    const keys = s.culprits.map((c) => c.culprit);
    assert.ok(keys.includes('sweep-attention'));
    assert.ok(keys.includes('get-api-claude-sessions'), 'the route arrives as a PATTERN key');
    assert.ok(keys.includes('fs-read-file-sync'));
  });

  it('the forwarded snapshot builds into an event the REAL validator accepts', async () => {
    // The end-to-end contract, with no hand-written fixture anywhere: the shape
    // the child produced, through the main-side builder, against the wire schema.
    const done = nextStallWindow();
    await driveStalls([STALL({ lagMs: 3300 })]);
    const { snapshot } = await done;
    const event = buildServerStallEvent({
      snapshot, schemaVersion: SCHEMA_VERSION, appVersion: '0.1.50', platform: process.platform,
    });
    assert.ok(event, 'the builder accepts the child\'s snapshot shape');
    assert.equal(event.type, 'server-stall');
    assert.equal(event.runtime, 'server', 'reported as the process that actually froze');
    assert.equal(validateBaseEvent(event), true, 'and the built event is valid on the wire');
  });

  it('carries NO user data — a request label with an agent name arrives as a route pattern', async () => {
    const done = nextStallWindow();
    await driveStalls([STALL({
      attribution: [{ label: 'GET /api/chats/myproject-researcher', overlapMs: 4000, open: false, durationMs: 4000 }],
    })]);
    const { snapshot } = await done;
    const wire = JSON.stringify(snapshot);
    assert.ok(!wire.includes('myproject'), 'the agent name never crossed the fork boundary');
    assert.ok(!wire.includes('researcher'), 'the agent name never crossed the fork boundary');
    for (const c of snapshot.culprits) {
      assert.match(c.culprit, /^[a-z0-9][a-z0-9-]{0,63}$/, `${c.culprit} is wire-safe`);
    }
  });

  it('consent OFF — the window is dropped in the child and NOTHING crosses the channel', async () => {
    const res = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ telemetryIncidentsEnabled: false }),
    });
    assert.equal(res.status, 200);

    const collected = collectStallWindows(600);
    await driveStalls([STALL({ lagMs: 9000 }), STALL({ lagMs: 9000 })]);
    assert.deepEqual(await collected, [], 'zero telemetry-stalls messages while incidents is off');

    // And nothing was PARKED in the child: turning consent back on must not
    // release the window that was collected-and-dropped while off.
    await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ telemetryIncidentsEnabled: true }),
    });
    const after = collectStallWindows(600);
    await driveStalls([]); // flush an EMPTY window
    assert.deepEqual(await after, [], 'the off-window left no residue to release');
  });

  it('an idle window is not forwarded at all — a healthy server ships nothing', async () => {
    const collected = collectStallWindows(600);
    await driveStalls([]);
    assert.deepEqual(await collected, [], 'no stalls, no message');
  });
});
