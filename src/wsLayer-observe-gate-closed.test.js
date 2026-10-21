import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { WebSocket } from 'ws';

/**
 * WARDEN-1893 — the /api/observe `gate` (send_directive approval) must not park forever
 * when its socket closed before the LLM's send_directive reached it.
 *
 * A turn is not cancelled when its socket closes. The close handler sweeps `pending`
 * once, so a resolver registered AFTER close was never released: Observer.step() never
 * settled and, because step() runs inside sessionChains.run(sid, …) (shared with
 * renameSession/deleteSession), the reconnecting tab's next step and DELETE hung too.
 *
 * Driven by a real setupWsLayer + real Observer + a stub LLM HTTP server (300ms delay).
 * HOME is redirected BEFORE the dynamic imports (sessions.js freezes its dir at import).
 */

const LLM_DELAY_MS = 300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, label) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms: ${label}`)), ms)),
]);

describe('WARDEN-1893 — observe gate on a closed socket does not wedge the per-sid chain', () => {
  let httpServer, port, llmServer, saved, tempHome, deleteSession;
  let llmCalls = 0;
  let firstReplyIsDirective = true;

  before(async () => {
    saved = { HOME: process.env.HOME, ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL };
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-ws-gateclosed-'));
    process.env.HOME = tempHome;
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
    const wdir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(path.join(wdir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(wdir, 'chats.json'), JSON.stringify([
      { host: '(local)', session: 'victim', name: 'victim', cwd: '/tmp', cmd: 'bash' },
    ]));

    // Stub LLM: the 1st call of a scenario → tool_use send_directive; later calls → text.
    llmServer = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const n = ++llmCalls;
        setTimeout(() => {
          const body = (n === 1 && firstReplyIsDirective)
            ? { content: [{ type: 'tool_use', id: 'tu1', name: 'send_directive', input: { id: 'victim', directive: 'do something' } }] }
            : { content: [{ type: 'text', text: 'ok' }] };
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(body));
        }, LLM_DELAY_MS);
      });
    });
    await new Promise((r) => llmServer.listen(0, '127.0.0.1', r));
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${llmServer.address().port}`;

    ({ deleteSession } = await import('./sessions.js'));
    const { setupWsLayer } = await import('./wsLayer.js');
    httpServer = http.createServer(() => {});
    setupWsLayer({
      server: httpServer,
      cfg: { connectTimeout: 1, hosts: [] },
      resolve: async () => ({ error: 'unused' }),
      chatCatalog: { snapshot: () => [], has: () => true },
    });
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', resolve);
    });
    port = httpServer.address().port;
  });

  after(async () => {
    await new Promise((r) => httpServer.close(r));
    await new Promise((r) => llmServer.close(r));
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  // Open socket A on a fresh session, send a user turn, and close it per `closeWhen`.
  // Resolves with { sid, frames } once A is closed.
  function runSocketA(closeWhen) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/observe`);
      const frames = [];
      let sid = null;
      ws.on('error', reject);
      ws.on('close', () => resolve({ sid, frames }));
      ws.on('message', (d) => {
        const f = JSON.parse(String(d));
        frames.push(f);
        if (f.type === 'session_created') {
          sid = f.sid;
          ws.send(JSON.stringify({ type: 'user', text: 'tell victim to do something', panes: [] }));
          if (closeWhen === 'early') setTimeout(() => ws.close(), 50); // before the LLM answers
        }
        if (f.type === 'directive_proposed' && closeWhen === 'after-proposed') {
          // Let the server's appendEventSafe finish so the resolver is registered, then close.
          setTimeout(() => ws.close(), 200);
        }
      });
    });
  }

  // Socket B reconnects to `sid` and sends a second turn; resolves with its frames on done/error.
  function runSocketB(sid) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/observe?sid=${encodeURIComponent(sid)}`);
      const frames = [];
      ws.on('error', reject);
      ws.on('message', (d) => {
        const f = JSON.parse(String(d));
        frames.push(f);
        if (f.type === 'history') ws.send(JSON.stringify({ type: 'user', text: 'second turn', panes: [] }));
        if (f.type === 'done' || f.type === 'error') { ws.close(); resolve(frames); }
      });
    });
  }

  it('socket closed BEFORE send_directive reaches the gate: reconnect turn completes and deleteSession settles', async () => {
    llmCalls = 0;
    firstReplyIsDirective = true;
    const { sid } = await runSocketA('early');
    assert.ok(sid, 'session was not created');
    // Let the old turn's LLM reply arrive and run the gate on the dead socket.
    await sleep(LLM_DELAY_MS + 250);

    const framesB = await withTimeout(runSocketB(sid), 4000, 'socket B second turn (chain wedged by the parked gate?)');
    assert.ok(framesB.some((f) => f.type === 'done'), `B never got done: ${JSON.stringify(framesB)}`);
    await withTimeout(deleteSession(sid), 4000, 'deleteSession (chain wedged by the parked gate?)');
  });

  it('control: socket closed AFTER directive_proposed was delivered still releases via the close handler', async () => {
    llmCalls = 0;
    firstReplyIsDirective = true;
    const { sid, frames } = await runSocketA('after-proposed');
    assert.ok(frames.some((f) => f.type === 'directive_proposed'), `gate was never reached: ${JSON.stringify(frames)}`);
    await sleep(LLM_DELAY_MS + 100); // let the declined turn finish its follow-up LLM call

    const framesB = await withTimeout(runSocketB(sid), 4000, 'socket B second turn');
    assert.ok(framesB.some((f) => f.type === 'done'), `B never got done: ${JSON.stringify(framesB)}`);
    await withTimeout(deleteSession(sid), 4000, 'deleteSession');
  });
});
