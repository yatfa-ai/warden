import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * HTTP integration test for `GET /api/directives` (WARDEN-359), the reader that
 * backs the read-only "Directives" history tab.
 *
 * Lives in its own file (separate from src/directives.test.js, the unit tests for
 * readDirectives) because node --test runs every `describe` in a file in the SAME
 * process: importing observer.js fixes its module-level DIRECTIVES_LOG (computed
 * from os.homedir() at load), and a second describe booting server.js would reuse
 * the cached module and read a stale path. One concern per file sidesteps that,
 * mirroring src/activity-series-http.test.js.
 *
 * Boots the REAL Express app from src/server.js on an ephemeral port with HOME
 * isolated to a temp dir whose directives.md is seeded with the exact bytes
 * `logDirective` produces. node --test runs each file in its own process, so the
 * HOME swap never leaks.
 */

const ISO = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

function appendDirective(logPath, isFirst, { ts, container, host, role, text }) {
  const header = isFirst && !fs.existsSync(logPath) ? '# Yatfa Warden directives log\n' : '';
  const entry = `${header}\n## ${ts} → ${container}@${host} (${role})\n\n${text}\n`;
  fs.appendFileSync(logPath, entry);
}

describe('/api/directives HTTP endpoint (real Express app from server.js)', () => {
  let httpServer, baseUrl;
  let originalHome, tempHome, logPath;
  let tOld, tNew;

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-directives-http-'));
    process.env.HOME = tempHome;
    const wdir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wdir, { recursive: true });
    fs.writeFileSync(path.join(wdir, 'config.json'), JSON.stringify({ hosts: [] }) + '\n');
    logPath = path.join(wdir, 'directives.md');

    tOld = ISO(-2 * 60 * 60 * 1000);
    tNew = ISO(-10 * 60 * 1000);
    appendDirective(logPath, true, { ts: tOld, container: 'http-worker', host: 'hostA', role: 'worker', text: 'old directive' });
    appendDirective(logPath, false, { ts: tNew, container: 'http-reviewer', host: 'hostB', role: 'reviewer', text: 'new directive' });

    const { app } = await import('./server.js');
    httpServer = app.listen(0, '127.0.0.1');
    await new Promise((res, rej) => { httpServer.once('listening', res); httpServer.once('error', rej); });
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  });

  after(async () => {
    if (httpServer) await new Promise((r) => httpServer.close(r));
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('responds to GET with 200 + JSON { directives } newest-first', async () => {
    const res = await fetch(`${baseUrl}/api/directives`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'application/json; charset=utf-8');
    const body = await res.json();
    assert.ok(Array.isArray(body.directives));
    assert.strictEqual(body.directives.length, 2);
    assert.deepStrictEqual(body.directives.map((d) => d.timestamp), [tNew, tOld], 'newest-first');

    const first = body.directives[0];
    assert.strictEqual(first.container, 'http-reviewer');
    assert.strictEqual(first.host, 'hostB');
    assert.strictEqual(first.role, 'reviewer');
    assert.strictEqual(first.text, 'new directive');
  });

  it('filters by ?agent= (container)', async () => {
    const body = await (await fetch(`${baseUrl}/api/directives?agent=http-worker`)).json();
    assert.strictEqual(body.directives.length, 1);
    assert.strictEqual(body.directives[0].container, 'http-worker');
  });

  it('honours ?limit= (keeps the newest)', async () => {
    const body = await (await fetch(`${baseUrl}/api/directives?limit=1`)).json();
    assert.strictEqual(body.directives.length, 1);
    assert.strictEqual(body.directives[0].timestamp, tNew);
  });

  it('returns { directives: [] } (never 500) when the file is empty', async () => {
    fs.writeFileSync(logPath, '');
    const res = await fetch(`${baseUrl}/api/directives`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.directives, []);
  });

  it('returns { directives: [] } (never 500) when the file is missing', async () => {
    fs.unlinkSync(logPath);
    const res = await fetch(`${baseUrl}/api/directives`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.directives, []);
  });
});
