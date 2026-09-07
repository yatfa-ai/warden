import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * WARDEN-1282 — POST /api/paste-image, the transport leg between the pasting
 * renderer and the file that lands beside the agent.
 *
 * THE TRAP THIS ROUTE EXISTS TO AVOID, and what these tests pin:
 * `app.use(express.json({ limit: '1mb' }))` is GLOBAL in src/server.js, and a
 * pasted screenshot routinely exceeds 1MB. Raising that global would widen the
 * body limit of EVERY route in the app for one endpoint's sake. So this route
 * carries its OWN raw-body parser, and the assertions below prove both halves:
 * a >1MB image is accepted HERE, and the global limit is still 1MB EVERYWHERE
 * else. The second half is the one that would rot silently.
 *
 * Like server-catalog.test.js / server-split-spawn.test.js, ./server.js is
 * dynamic-imported AFTER HOME is pointed at a throwaway dir so the catalog file
 * is isolated (WARDEN-130). node --test runs each file in its own process.
 */
describe('POST /api/paste-image — clipboard image → the agent\u2019s filesystem (WARDEN-1282)', () => {
  let httpServer, baseUrl;
  let originalHome, tempHome;
  const SESSION = 'w1282paste';   // the end-to-end leg's tmux session

  // Kill by EXACT session name only — NEVER by command-line pattern (a `pkill -f`
  // would match this very test process's own argv and kill the run).
  const killSession = () => spawnSync('tmux', ['kill-session', '-t', SESSION], { stdio: 'ignore' });

  // A real 1×1 PNG, byte for byte — so the server's header sniffing has
  // something honest to read and the marker carries real dimensions.
  const PNG_1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-paste-http-'));
    process.env.HOME = tempHome;
    const wdir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wdir, { recursive: true });
    fs.writeFileSync(path.join(wdir, 'config.json'), JSON.stringify({ hosts: [] }) + '\n');
    fs.writeFileSync(path.join(wdir, 'chats.json'), '[]\n');
    // A session left behind by an interrupted earlier run makes /api/spawn 409/500
    // and would otherwise have the end-to-end leg bail silently.
    killSession();

    const { app } = await import('./server.js');
    httpServer = app.listen(0, '127.0.0.1');
    await new Promise((res, rej) => {
      httpServer.once('listening', res);
      httpServer.once('error', rej);
    });
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  });

  after(async () => {
    killSession();
    if (httpServer) await new Promise((res) => httpServer.close(res));
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  const postImage = (id, body, type = 'image/png') =>
    fetch(`${baseUrl}/api/paste-image?id=${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'content-type': type },
      body,
    });

  it('an unresolvable pane id is a 404, and nothing is written', async () => {
    const res = await postImage('no-such-pane', PNG_1x1);
    assert.strictEqual(res.status, 404);
  });

  it('accepts a body WELL OVER the 1mb global express.json limit', async () => {
    // The whole reason this route has its own parser. 3MB is a modest
    // screenshot. The id is unresolvable, so the answer is 404 — but a 404 is
    // proof the BODY was parsed and the request reached the handler; a body
    // rejected by a 1mb limit answers 413 (PayloadTooLarge) instead, which is
    // exactly the regression this asserts against.
    const big = Buffer.concat([PNG_1x1, Buffer.alloc(3 * 1024 * 1024, 0x41)]);
    const res = await postImage('no-such-pane', big);
    assert.strictEqual(res.status, 404, `expected the handler to be reached, got ${res.status}`);
  });

  it('the GLOBAL 1mb json limit is UNCHANGED — the raise is route-scoped', async () => {
    // The half that would rot in silence. If someone "fixes" a future large-body
    // need by raising the global limit, this goes red.
    const res = await fetch(`${baseUrl}/api/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'x', text: 'y'.repeat(2 * 1024 * 1024) }),
    });
    assert.strictEqual(res.status, 413, `global json limit was raised (got ${res.status})`);
  });

  it('accepts whatever content-type the clipboard Blob declares', async () => {
    // The clipboard's declared MIME is the CLIENT's word; the FORMAT is decided
    // by sniffing header bytes server-side. So the parser must not allow-list a
    // type the client controls anyway — it must simply take the bytes.
    for (const type of ['image/png', 'image/jpeg', 'application/octet-stream', 'image/webp']) {
      const res = await postImage('no-such-pane', PNG_1x1, type);
      assert.strictEqual(res.status, 404, `content-type ${type} was rejected before the handler`);
    }
  });

  it('delivers to a LIVE local pane: the file lands and the marker names it', async (t) => {
    // The end-to-end leg the sandbox can genuinely prove (no ssh, no docker):
    // a real tmux chat, a real image posted over HTTP, and a real file read back
    // off disk with byte-for-byte equality.
    //
    // The skip is EXPLICIT and loud (t.skip on a host with no tmux), never a
    // bare `return` — a silent bail is a green lie: it would report a passing
    // end-to-end test on a host that ran none of it (WARDEN-130).
    if (spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status !== 0) {
      t.skip('tmux is not installed — the end-to-end leg cannot run here');
      return;
    }

    const spawnRes = await fetch(`${baseUrl}/api/spawn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: '(local)', name: SESSION, session: SESSION, cmd: '' }),
    });
    const spawnRaw = await spawnRes.text();
    assert.strictEqual(spawnRes.status, 200, spawnRaw);
    const { chat } = JSON.parse(spawnRaw);
    assert.ok(chat?.id, 'spawn returned no chat id');

    const res = await postImage(chat.id, PNG_1x1);
    // Read the body ONCE — `await res.text()` as an assert message consumes it,
    // and the json() below then throws "Body has already been read", turning a
    // real failure into a confusing one.
    const raw = await res.text();
    assert.strictEqual(res.status, 200, raw);
    const body = JSON.parse(raw);
    assert.strictEqual(body.ok, true);
    assert.ok(body.path, 'no destination path returned');
    // The FILE exists where the marker says it does, with the EXACT bytes — the
    // acceptance criterion "the agent can open it", proved rather than asserted.
    assert.deepStrictEqual(fs.readFileSync(body.path), PNG_1x1);
    // The marker is ONE line (a newline would submit the pane input mid-marker),
    // names that path, and describes the image the bytes actually are.
    assert.ok(!body.marker.includes('\n'));
    assert.ok(body.marker.includes(body.path));
    assert.match(body.marker, /PNG 1×1/);
    // The destination is the fixed, predictable, agent-READABLE directory the
    // roadmap requires — not a per-user path warden cannot know the agent shares.
    assert.ok(body.path.startsWith('/tmp/warden/paste/'), body.path);
    fs.rmSync(body.path, { force: true });

    // An EMPTY body on a RESOLVABLE pane is a 400 — the case the unresolved-id
    // tests above cannot reach, because resolution runs first. A marker for a
    // zero-byte "image" would point the agent at an empty file.
    const empty = await postImage(chat.id, Buffer.alloc(0));
    assert.strictEqual(empty.status, 400);
    assert.strictEqual((await empty.json()).marker, undefined);
  });
});
