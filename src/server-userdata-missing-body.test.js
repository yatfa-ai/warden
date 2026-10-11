import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Express 5 leaves req.body undefined for body-less / non-JSON requests.
 * The userDataRoutes handlers must fall through to their own 400 validation
 * instead of crashing (500) or leaking "Cannot destructure ... req.body" text.
 */
const ROUTES = [
  { method: 'PUT', url: '/api/pins', message: 'pins must be an array' },
  { method: 'PUT', url: '/api/agent-notes', message: 'id must be a non-empty string' },
  { method: 'PUT', url: '/api/session-tags', message: 'id must be a non-empty string' },
  { method: 'POST', url: '/api/collections', message: 'name is required (string)' },
];

describe('userDataRoutes: body-less / non-JSON requests answer the route\'s own 400', () => {
  let httpServer;
  let baseUrl;
  let originalHome;
  let tempHome;

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-missing-body-'));
    process.env.HOME = tempHome;
    const wardenDir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wardenDir, { recursive: true });
    fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: [] }));
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

  for (const { method, url, message } of ROUTES) {
    const variants = [
      ['no body', {}],
      ['text/plain body', { headers: { 'content-type': 'text/plain' }, body: 'hello' }],
    ];
    for (const [label, init] of variants) {
      it(`${method} ${url} with ${label} -> 400 "${message}" and no JS internals`, async () => {
        const res = await fetch(`${baseUrl}${url}`, { method, ...init });
        const text = await res.text();
        assert.strictEqual(res.status, 400, `expected 400, got ${res.status}: ${text}`);
        assert.strictEqual(JSON.parse(text).error, message);
        assert.ok(!/destructure/i.test(text), 'must not leak "destructure"');
        assert.ok(!text.includes('req.body'), 'must not leak "req.body"');
      });
    }
  }
});
