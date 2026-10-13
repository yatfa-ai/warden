import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Router-level spec for createActivityRouter (src/activityRoutes.js, moved out of
 * server.js by WARDEN-1766). The sibling HTTP suites (activity-feed-http,
 * activity-series-http, directives-http) pin the series clamps, the
 * limit-after-exclusion rule and the directives agent/limit filters. This file pins
 * the branches they leave open:
 *   - GET /api/activity: the `?before=` upper bound, and `?limit=0` / `?limit=-1`
 *     meaning "no limit" (the `limit > 0` guard);
 *   - GET /api/activity/stats: the default 24h window and the `?after=` override;
 *   - GET /api/directives: the 500 `{ error: e.message }` channel when the log is
 *     unreadable (directives.md is a directory → EISDIR).
 *
 * One concern per file: activity.js / observer.js fix their paths from
 * os.homedir() at module load, so the HOME swap and seeded files must be in place
 * BEFORE the dynamic import of server.js. node --test isolates each file in its own
 * process. Boots the REAL Express app on an ephemeral port, like the sibling suites.
 */

const H = 3_600_000;
const EVENT = (type, container, ts) =>
  JSON.stringify({ type, container, host: 'hostA', timestamp: new Date(ts).toISOString() });

describe('createActivityRouter (real Express app from server.js)', () => {
  let httpServer, baseUrl;
  let originalHome, tempHome, wdir;
  let now;

  const iso = (offsetMs) => new Date(now + offsetMs).toISOString();
  const get = async (p) => {
    const res = await fetch(`${baseUrl}${p}`);
    return { status: res.status, body: await res.json() };
  };
  const containers = (body) => body.events.map((e) => e.container).sort();

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-activity-routes-'));
    process.env.HOME = tempHome;
    wdir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wdir, { recursive: true });
    fs.writeFileSync(path.join(wdir, 'config.json'), JSON.stringify({ hosts: [] }) + '\n');

    now = Date.now();
    // error 30h ago (outside the default 24h window), attached 5h ago, ended 1h ago.
    fs.writeFileSync(path.join(wdir, 'activity.jsonl'), [
      EVENT('error', 'old', now - 30 * H),
      EVENT('attached', 'mid', now - 5 * H),
      EVENT('ended', 'new', now - 1 * H),
    ].join('\n') + '\n');

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

  describe('GET /api/activity', () => {
    it('?before= excludes events newer than the bound', async () => {
      const { status, body } = await get(`/api/activity?before=${encodeURIComponent(iso(-3 * H))}`);
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(containers(body), ['mid', 'old']);
    });

    it('?after= and ?before= together select exactly the events inside the window', async () => {
      const q = `after=${encodeURIComponent(iso(-10 * H))}&before=${encodeURIComponent(iso(-3 * H))}`;
      const { body } = await get(`/api/activity?${q}`);
      assert.deepStrictEqual(containers(body), ['mid']);
    });

    it('?limit=0 and ?limit=-1 mean no limit (all events returned)', async () => {
      for (const limit of ['0', '-1']) {
        const { status, body } = await get(`/api/activity?limit=${limit}`);
        assert.strictEqual(status, 200);
        assert.deepStrictEqual(containers(body), ['mid', 'new', 'old'], `limit=${limit}`);
      }
    });
  });

  describe('GET /api/activity/stats', () => {
    it('defaults to the last 24h when ?after= is absent', async () => {
      const { status, body } = await get('/api/activity/stats');
      assert.strictEqual(status, 200);
      assert.strictEqual(body.total, 2);
      assert.strictEqual(body.error, 0); // the 30h-old error is outside the default window
      assert.strictEqual(body.attached, 1);
      assert.strictEqual(body.ended, 1);
    });

    it('honours an explicit ?after= narrower than the default', async () => {
      const { body } = await get(`/api/activity/stats?after=${encodeURIComponent(iso(-2 * H))}`);
      assert.strictEqual(body.total, 1);
      assert.strictEqual(body.ended, 1);
    });

    it('honours an explicit ?after= wider than the default', async () => {
      const { body } = await get(`/api/activity/stats?after=${encodeURIComponent(iso(-48 * H))}`);
      assert.strictEqual(body.total, 3);
      assert.strictEqual(body.error, 1);
    });
  });

  describe('GET /api/directives error channel', () => {
    it('answers 500 with a string `error` (e.message) and no `directives` key when the log is unreadable', async () => {
      const logPath = path.join(wdir, 'directives.md');
      fs.mkdirSync(logPath); // readFile on a directory → EISDIR (not ENOENT, so it is rethrown)
      try {
        const res = await fetch(`${baseUrl}/api/directives`);
        assert.strictEqual(res.status, 500);
        const body = await res.json();
        assert.strictEqual(typeof body.error, 'string');
        assert.match(body.error, /EISDIR/);
        assert.ok(!('directives' in body));
      } finally {
        fs.rmSync(logPath, { recursive: true, force: true });
      }
    });
  });
});
