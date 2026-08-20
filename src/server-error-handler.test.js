import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * HTTP integration tests for the JSON error handler (WARDEN-1105).
 *
 * server.js registered no 4-arg Express error handler, so every error fell
 * through to `finalhandler`, which answers `text/html`. The browser client
 * parses each response with `res.json()` and swallows a parse failure into
 * `undefined` (web/src/lib/api.ts), so an HTML body erased the server's real
 * diagnostic and every caller showed its generic default toast. This suite pins
 * the wire contract for the three error shapes that reach an error handler,
 * against the REAL Express app from src/server.js (same harness as
 * server-agent-notes.test.js):
 *
 *   - 400: a malformed JSON body (body-parser SyntaxError)
 *   - 413: a body over the 1mb express.json limit
 *   - 500: a genuine throw inside an unguarded route (`await save(cfg)` failing)
 *
 * For each: the content-type is application/json, the body parses and carries a
 * non-empty `error` string, the original status code survives, and nothing
 * internal (stack frame, absolute path, errno) is exposed.
 */
describe('JSON error handler (real Express app from server.js)', () => {
  let httpServer;
  let baseUrl;
  let originalHome;
  let tempHome;
  let configPath;

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-errh-'));
    process.env.HOME = tempHome;
    const wardenDir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wardenDir, { recursive: true });
    configPath = path.join(wardenDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ hosts: [] }));

    const { app } = await import('./server.js');
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

  // The whole point of the handler: the response must be machine-readable. Read
  // the body as TEXT and parse it here rather than calling res.json(), so a
  // failure reports the HTML that was actually returned instead of an opaque
  // "Unexpected token <".
  async function readJsonBody(res) {
    const raw = await res.text();
    assert.match(
      res.headers.get('content-type') || '',
      /application\/json/,
      `expected a JSON content-type, got ${res.headers.get('content-type')} with body: ${raw.slice(0, 200)}`,
    );
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      assert.fail(`body did not parse as JSON: ${raw.slice(0, 200)}`);
    }
    assert.strictEqual(typeof parsed.error, 'string', 'body carries an `error` string');
    assert.ok(parsed.error.length > 0, '`error` is non-empty');
    return { raw, parsed };
  }

  // A safe body names no server internals. `tempHome` stands in for any absolute
  // path (the real leak vector for an fs error), and `at ` / `.js:` for a stack.
  function assertNoInternals(raw) {
    assert.ok(!raw.includes(tempHome), `body leaked a filesystem path: ${raw.slice(0, 200)}`);
    assert.ok(!/\bat\s+\S+\s+\(/.test(raw), `body leaked a stack frame: ${raw.slice(0, 200)}`);
    assert.ok(!raw.includes('server.js'), `body leaked a source filename: ${raw.slice(0, 200)}`);
  }

  it('a malformed JSON body returns a parseable 400, not an HTML 400', async () => {
    const res = await fetch(`${baseUrl}/api/pins`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{"pins": [', // truncated — body-parser throws a SyntaxError with status 400
    });
    assert.strictEqual(res.status, 400, 'body-parser\'s 400 is preserved, not flattened to 500');
    const { raw } = await readJsonBody(res);
    assertNoInternals(raw);
  });

  it('the 4xx message is length-capped so a body fragment cannot inflate it', async () => {
    // A JSON parse error embeds a slice of the offending body, so the message
    // carries client-supplied bytes. It must stay a bounded diagnostic.
    const res = await fetch(`${baseUrl}/api/pins`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: `{"pins": [${'A'.repeat(50_000)}`,
    });
    assert.strictEqual(res.status, 400);
    const { parsed } = await readJsonBody(res);
    assert.ok(parsed.error.length <= 200, `error message capped, got ${parsed.error.length} chars`);
  });

  it('a body over the 1mb express.json limit returns a parseable 413', async () => {
    const oversized = JSON.stringify({ pins: ['x'.repeat(1024 * 1024 + 4096)] });
    const res = await fetch(`${baseUrl}/api/pins`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: oversized,
    });
    assert.strictEqual(res.status, 413, '413 is preserved — a blanket 500 would misreport it');
    const { raw, parsed } = await readJsonBody(res);
    // body-parser authors this message about the CLIENT's request, so it is safe
    // to pass through and is the diagnostic the toast should show.
    assert.match(parsed.error, /too large/i, 'the 4xx message explains the actual problem');
    assertNoInternals(raw);
  });

  it('a throw inside an unguarded route returns a parseable 500, not an HTML 500', async () => {
    // PUT /api/pins has no try/catch and ends in `await save(cfg)` — a real
    // filesystem write. Turning config.json into a directory makes the final
    // rename() in atomicWrite fail with EISDIR, exactly as ENOSPC/EACCES would
    // on a full or read-only disk. Express 5 auto-forwards the rejected async
    // handler to the error handler.
    fs.rmSync(configPath);
    fs.mkdirSync(configPath);
    try {
      const res = await fetch(`${baseUrl}/api/pins`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pins: ['chat-1'] }),
      });
      assert.strictEqual(res.status, 500);
      const { raw, parsed } = await readJsonBody(res);
      // The underlying error message is "EISDIR: illegal operation on a
      // directory, rename '<tmp>/config.json.tmp…' -> '<tmp>/config.json'" — a
      // 5xx must not forward that verbatim.
      assert.ok(!raw.includes('EISDIR'), `body leaked an errno: ${raw.slice(0, 200)}`);
      assert.ok(!raw.includes('rename'), `body leaked a syscall: ${raw.slice(0, 200)}`);
      assertNoInternals(raw);
      assert.strictEqual(parsed.error, 'internal server error');
    } finally {
      fs.rmSync(configPath, { recursive: true, force: true });
      fs.writeFileSync(configPath, JSON.stringify({ hosts: [] }));
    }
  });

  it('a successful request is unaffected — the handler only runs on errors', async () => {
    const res = await fetch(`${baseUrl}/api/pins`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pins: ['still-works'] }),
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual((await res.json()).pins, ['still-works']);
  });

  it('a route\'s own 400 still wins — the handler does not intercept explicit responses', async () => {
    // PUT /api/pins validates its input itself. That response never routes
    // through next(err), so it must be untouched by the new middleware.
    const res = await fetch(`${baseUrl}/api/pins`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pins: 'not-an-array' }),
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await res.json()).error, 'pins must be an array');
  });
});
