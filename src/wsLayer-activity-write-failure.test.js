import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { WebSocket } from 'ws';

/**
 * WARDEN-1653 — a FAILING activity-log write inside an async ws handler must not
 * escape as an unhandledRejection (which terminates the process on Node >= 15).
 *
 * `ws` does not await listener promises, so a rejected `await appendEvent(...)` inside
 * `ws.on('message', async …)` is unhandled. wsLayer.js (extracted from server.js,
 * WARDEN-1380/1381) lost server.js's `try { await appendEvent() } catch {}` guard.
 *
 * Failure injection (same as state-transition-write-failure.test.js): activity.jsonl is
 * a DIRECTORY, so appendFile → EISDIR deterministically (also when run as root).
 * Positive control first: proves the injected failure is real, so a later
 * "no rejections" pass can't be vacuous. HOME is redirected BEFORE the dynamic imports.
 *
 * Two paths: stream-WS `attach` with a resolver returning {error} (attach_error frame +
 * guarded append) and observe-WS `gate_decision` rejection (guarded append). The
 * observe path is driven by a fake LLM (ANTHROPIC_BASE_URL) that asks the observer to
 * send_directive, which raises a real gate → directive_proposed → gate_decision.
 */

const settle = () => new Promise((r) => setTimeout(r, 150));

describe('WARDEN-1653 — failing activity write never escapes wsLayer handlers', () => {
  let httpServer, port, llmServer, saved, tempHome, appendEvent;
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);

  before(async () => {
    saved = {
      HOME: process.env.HOME,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    };
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-ws-writefail-'));
    process.env.HOME = tempHome;
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
    const wdir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(path.join(wdir, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(wdir, 'activity.jsonl'), { recursive: true }); // THE INJECTION
    // A manual catalog chat so the observer's send_directive can resolve "victim".
    fs.writeFileSync(path.join(wdir, 'chats.json'), JSON.stringify([
      { host: '(local)', session: 'victim', name: 'victim', cwd: '/tmp', cmd: 'bash' },
    ]));

    // Fake LLM: 1st call → tool_use send_directive; later calls → plain text.
    let llmCalls = 0;
    llmServer = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        llmCalls++;
        const body = llmCalls === 1
          ? { content: [{ type: 'tool_use', id: 'tu1', name: 'send_directive', input: { id: 'victim', directive: 'do something' } }] }
          : { content: [{ type: 'text', text: 'ok' }] };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
      });
    });
    await new Promise((r) => llmServer.listen(0, '127.0.0.1', r));
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${llmServer.address().port}`;

    process.on('unhandledRejection', onRejection);

    ({ appendEvent } = await import('./activity.js'));
    const { setupWsLayer } = await import('./wsLayer.js');
    httpServer = http.createServer(() => {});
    setupWsLayer({
      server: httpServer,
      cfg: { connectTimeout: 1, hosts: [] },
      resolve: async () => ({ error: 'no chat matches "ghost"' }),
      chatCatalog: { snapshot: () => [], has: () => true },
    });
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', resolve);
    });
    port = httpServer.address().port;
  });

  after(async () => {
    process.removeListener('unhandledRejection', onRejection);
    await new Promise((r) => httpServer.close(r));
    await new Promise((r) => llmServer.close(r));
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('positive control: appendEvent really rejects in this environment', async () => {
    await assert.rejects(() => appendEvent({ type: 'error', error: 'probe' }), /EISDIR/);
  });

  it('stream attach with a resolver error: client gets attach_error, no unhandledRejection', async () => {
    const frames = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/stream`);
      const got = [];
      ws.on('message', (d) => got.push(JSON.parse(String(d))));
      ws.on('error', reject);
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'attach', id: 'ghost', cols: 80, rows: 24 }));
        setTimeout(() => { ws.close(); resolve(got); }, 500);
      });
    });
    await settle();
    assert.ok(frames.some((f) => f.type === 'attach_error' && f.id === 'ghost'), `frames: ${JSON.stringify(frames)}`);
    assert.strictEqual(rejections.length, 0, `unhandled rejections: ${rejections.map(String)}`);
  });

  it('observe gate_decision rejection: no unhandledRejection (directive_rejected write fails)', async () => {
    const frames = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/observe`);
      const got = [];
      ws.on('message', (d) => {
        const f = JSON.parse(String(d));
        got.push(f);
        // Delay: the server registers the pending resolver only after its (failing) append settles.
        if (f.type === 'directive_proposed') setTimeout(() => ws.send(JSON.stringify({ type: 'gate_decision', requestId: f.requestId, approved: false })), 200);
        if (f.type === 'session_created') ws.send(JSON.stringify({ type: 'user', text: 'tell victim to do something', panes: [] }));
        if (f.type === 'done' || f.type === 'error') setTimeout(() => { ws.close(); resolve(got); }, 300);
      });
      ws.on('error', reject);
      setTimeout(() => { ws.close(); resolve(got); }, 4000);
    });
    await settle();
    assert.ok(frames.some((f) => f.type === 'directive_proposed'), `gate was never reached: ${JSON.stringify(frames)}`);
    assert.ok(frames.some((f) => f.type === 'done'), `observer turn did not complete: ${JSON.stringify(frames)}`);
    assert.strictEqual(rejections.length, 0, `unhandled rejections: ${rejections.map(String)}`);
  });
});
