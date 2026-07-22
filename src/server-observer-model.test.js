import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import WebSocket from 'ws';

/**
 * Observer WebSocket model-echo test (WARDEN-874).
 *
 * The `/api/observe` socket is the one surface where a human actually USES the
 * observer, yet it never echoed the resolved LLM model — so the status bar could
 * not show which model is answering. WARDEN-874 wires `model: resolveModel()`
 * into the two frames that fire on every connect: `session_created` (fresh
 * session) and `history` (fresh AND resume).
 *
 * This drives the REAL server (module-level `server` — the http instance the
 * `/api/observe` upgrade handler is bound to; `app.listen()` would make a
 * different server with no WS routing) over a REAL WebSocket, and asserts the
 * exact ticket success criterion: both frames carry a non-empty `model` equal to
 * what `resolveModel()` returns. The seeded model carries a `[1m]` context tag
 * to also prove the tag-stripping in `resolveModel()` (src/llm.js) flows through
 * end-to-end — the bar must show the clean id, not `name[1m]`.
 *
 * Runs in its own process (node --test src), so server.js's module-load `cfg =
 * load()` reads the seeded temp-HOME config, and `llm.authToken` makes
 * `hasCredentials()` pass the connect guard at src/server.js.
 */

// Open a WS client to /api/observe and collect the message stream.
function connectObserve(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const msgs = [];
  ws.on('message', (raw) => { try { msgs.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
  const opened = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  // Resolve once the first message of `type` arrives.
  const waitFor = async (type, timeoutMs = 4000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = msgs.find((m) => m.type === type);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for ${type}; saw ${JSON.stringify(msgs)}`);
  };
  return { ws, msgs, opened, waitFor };
}

describe('/api/observe echoes resolveModel() (WARDEN-874)', () => {
  let serverModule;
  let wsUrl;
  let originalHome;
  let tempHome;
  let savedModelEnv;
  const modelEnvKeys = ['WARDEN_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_MODEL'];

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-observe-model-'));
    process.env.HOME = tempHome;
    const wardenDir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wardenDir, { recursive: true });
    // Seed a model (with a [1m] tag to prove stripping) + an authToken so the
    // hasCredentials() connect guard passes. HOME is temp, so ~/.claude is absent.
    fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({
      hosts: [],
      llm: { authToken: 'sk-observe-test-4321', model: 'observer-test-model[1m]' },
    }));

    // Clear model env overrides so resolveModel() reads the seeded config file.
    savedModelEnv = {};
    for (const k of modelEnvKeys) { savedModelEnv[k] = process.env[k]; delete process.env[k]; }

    // Dynamic import AFTER HOME is swapped so server.js's module-load load() reads
    // the throwaway config. `server` is the http instance /api/observe is wired to.
    serverModule = await import('./server.js');
    await new Promise((resolve, reject) => {
      serverModule.server.once('listening', resolve);
      serverModule.server.once('error', reject);
      serverModule.server.listen(0, '127.0.0.1');
    });
    wsUrl = `ws://127.0.0.1:${serverModule.server.address().port}/api/observe`;
  });

  after(async () => {
    try { serverModule.server.closeAllConnections?.(); } catch { /* noop */ }
    if (serverModule?.server?.listening) await new Promise((r) => serverModule.server.close(r));
    for (const k of modelEnvKeys) { if (savedModelEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedModelEnv[k]; }
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('session_created and history both carry model === resolveModel() (tag-stripped)', async () => {
    const { resolveModel } = await import('./llm.js');
    const expected = resolveModel();
    // The seeded `observer-test-model[1m]` must be stripped to the clean id —
    // the bar shows `model: observer-test-model`, never the raw tagged form.
    assert.strictEqual(expected, 'observer-test-model', 'resolveModel() strips the [1m] tag');

    const { ws, msgs, opened, waitFor } = connectObserve(wsUrl);
    await opened;

    try {
      const sessionCreated = await waitFor('session_created');
      const history = await waitFor('history');

      // The connect guard must NOT have fired (no credentials error).
      assert.ok(!msgs.some((m) => m.type === 'error'), `unexpected error frame: ${JSON.stringify(msgs)}`);

      assert.ok(sessionCreated.model, 'session_created carries a non-empty model');
      assert.strictEqual(sessionCreated.model, expected, 'session_created.model === resolveModel()');
      assert.ok(history.model, 'history carries a non-empty model');
      assert.strictEqual(history.model, expected, 'history.model === resolveModel()');
    } finally {
      // Always close the socket so an assertion failure can't keep the event
      // loop (and thus the test process) alive past the `after()` teardown.
      ws.close();
    }
  });
});
