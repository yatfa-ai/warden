import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// WARDEN-524 regression — the IPC forward (success criterion #3's critical path).
//
// A runtime consent/endpoint flip via PUT /api/config must reach the Electron
// MAIN process over the fork's built-in IPC channel so the source + pipeline
// (which live in main) can start/stop capture on the next signal WITHOUT an
// app restart. The PUT is serviced inside the server CHILD (which also persists
// + clamps the prefs); `process.send({type:'telemetry-config',...})` is the
// ONLY path that flip can reach main through.
//
// This forks the REAL src/server.js — the same `stdio:[..., 'ipc']` slot
// electron/main.cjs uses — and asserts the telemetry-config message arrives on
// the parent for each PUT, including the extended-requires-base clamp
// (extended:true sent with base:false must arrive as extended:false). A future
// refactor that drops process.send, renames the message type, tightens the
// `typeof process.send` guard, or rewires stdio will turn this red while every
// other telemetry suite stays green — which is exactly the silent-break this
// locks out (the live-wire test only proves apply() starts/stops capture WHEN
// CALLED; it never proves a PUT actually delivers the message to the parent).
//
// Same isolated-server pattern as server-config-telemetry.test.js: unique temp
// HOME, own config.json, throwaway PORT. node --test runs each file in its own
// process, so this never cross-talks with the other server-*.test.js files.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.resolve(__dirname, 'server.js');

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
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-ipc-telemetry-'));
  const wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  // No telemetry prefs on disk — defaults are all-off, the no-op posture.
  fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: [] }));

  const port = await grabFreePort();

  // Fork the REAL server with the 4th 'ipc' stdio slot — exactly as
  // electron/main.cjs does. HOME + PORT come through env so the child uses the
  // temp config dir and the throwaway port.
  child = fork(SERVER_PATH, [], {
    env: { ...process.env, HOME: tempHome, PORT: String(port) },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });

  // Wait for the server's readiness line on stdout before driving it.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server fork did not announce ready in time')), 15000);
    child.stdout.on('data', (d) => {
      const line = d.toString();
      if (line.includes('warden ui →')) {
        clearTimeout(timer);
        resolve();
      }
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

/** Resolve the NEXT telemetry-config IPC message the parent receives. Arm this
 *  BEFORE issuing the PUT so there is no delivery race, then await it after. */
function nextTelemetryConfig(timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('message', onMsg);
      reject(new Error(`timed out waiting for telemetry-config IPC message (${timeoutMs}ms)`));
    }, timeoutMs);
    function onMsg(msg) {
      if (msg && msg.type === 'telemetry-config') {
        clearTimeout(timer);
        child.off('message', onMsg);
        resolve(msg);
      }
    }
    child.on('message', onMsg);
  });
}

async function putConfig(body) {
  const res = await fetch(`${baseUrl}/api/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.strictEqual(res.status, 200, `PUT /api/config failed: ${res.status}`);
}

describe('telemetry-config IPC forward (WARDEN-524) — server fork → parent', () => {
  it('forwards base + endpoint to the parent on PUT /api/config', async () => {
    const endpoint = 'https://receiver.example/ingest';
    const done = nextTelemetryConfig();
    await putConfig({ telemetryBaseEnabled: true, telemetryEndpoint: endpoint });
    const msg = await done;
    assert.strictEqual(msg.type, 'telemetry-config');
    assert.strictEqual(msg.base, true, 'base consent forwarded');
    assert.strictEqual(msg.extended, false, 'extended stays off when only base set');
    assert.strictEqual(msg.endpoint, endpoint, 'endpoint forwarded');
    // Fresh config (no token on disk, no prior PUT) → auth token is empty. This
    // runs first in the suite, before any token is persisted, so it reliably
    // pins the open-receiver posture. (WARDEN-569)
    assert.strictEqual(msg.authToken, '', 'no token configured → empty string forwarded');
  });

  it('forwards extended on when base is already on', async () => {
    const done = nextTelemetryConfig();
    await putConfig({ telemetryBaseEnabled: true, telemetryExtendedEnabled: true });
    const msg = await done;
    assert.strictEqual(msg.base, true);
    assert.strictEqual(msg.extended, true, 'extended forwarded on when base is on');
  });

  it('CLAMPS extended off when sent with base:false (extended-requires-base)', async () => {
    // The critical runtime-toggle guard: a hand-crafted PUT enabling extended
    // without base must arrive at main as base:false, extended:false — never
    // extended:true. The server clamps on write (server.js) AND the resolver
    // clamps again in main; this asserts the value main would actually receive.
    const done = nextTelemetryConfig();
    await putConfig({ telemetryBaseEnabled: false, telemetryExtendedEnabled: true });
    const msg = await done;
    assert.strictEqual(msg.base, false);
    assert.strictEqual(msg.extended, false, 'extended MUST be clamped off when base is off');
  });

  it('forwards a consent-off flip (capture stops) to the parent', async () => {
    const done = nextTelemetryConfig();
    await putConfig({ telemetryBaseEnabled: false });
    const msg = await done;
    assert.strictEqual(msg.base, false, 'base off forwarded — capture stops on next signal');
    assert.strictEqual(msg.extended, false);
  });

  it('forwards the cleartext telemetry auth token to the parent on PUT (WARDEN-569)', async () => {
    // The main-process transport needs the cleartext token to send it on the wire.
    // This internal parent↔child IPC channel is the one path it reaches the sender
    // through (GET /api/config masks it from the renderer; this forward does not).
    const token = 'ipc-forwarded-bearer-token';
    const done = nextTelemetryConfig();
    await putConfig({ telemetryAuthToken: token });
    const msg = await done;
    assert.strictEqual(msg.authToken, token, 'cleartext auth token forwarded to the parent');
  });
});
