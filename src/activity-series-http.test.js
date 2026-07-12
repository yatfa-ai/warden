import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * HTTP integration test for `GET /api/activity/series` (WARDEN-299), plus a
 * regression check that the existing `/api/activity/stats` envelope is unchanged.
 *
 * Lives in its own file (separate from src/activity-series.test.js, the unit
 * tests for getSeriesSince) because node --test runs every `describe` in a file
 * in the SAME process: importing activity.js fixes its module-level `DIR`
 * (computed from os.homedir() at load), and a second describe in the same file
 * booting server.js would reuse the cached module and read a stale path. One
 * concern per file sidesteps that, mirroring src/server-hosts-status.test.js.
 *
 * Boots the REAL Express app from src/server.js on an ephemeral port with HOME
 * isolated to a temp dir whose activity.jsonl is seeded with deterministic
 * events. node --test runs each file in its own process, so the HOME swap never
 * leaks. `activity.js` evaluates os.homedir() at module load, so HOME is set and
 * the log is seeded BEFORE the dynamic import.
 */

const EVENT = (type, container, ts, extra = {}) =>
  JSON.stringify({ type, container, host: 'hostA', timestamp: new Date(ts).toISOString(), ...extra });

describe('/api/activity/series HTTP endpoint (real Express app from server.js)', () => {
  let httpServer, baseUrl;
  let originalHome, tempHome, activityPath;
  let now;

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-series-http-'));
    process.env.HOME = tempHome;
    const wdir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wdir, { recursive: true });
    fs.writeFileSync(path.join(wdir, 'config.json'), JSON.stringify({ hosts: [] }) + '\n');
    activityPath = path.join(wdir, 'activity.jsonl');

    now = Date.now();
    const lines = [
      EVENT('directive_proposed', 'http-c1', now - 30 * 60 * 1000),
      EVENT('error', 'http-c1', now - 30 * 60 * 1000, { error: 'x' }),
      EVENT('attached', 'http-c2', now - 2 * 60 * 60 * 1000),
    ];
    fs.writeFileSync(activityPath, lines.join('\n') + '\n');

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

  it('responds to GET with 200 + JSON { bucketMs, buckets, series }', async () => {
    const after = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const res = await fetch(`${baseUrl}/api/activity/series?after=${encodeURIComponent(after)}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'application/json; charset=utf-8');
    const body = await res.json();
    assert.strictEqual(body.bucketMs, 60 * 60 * 1000, 'default bucket is 1h');
    assert.ok(Array.isArray(body.buckets));
    assert.ok(body.series && typeof body.series === 'object');
  });

  it('joins series by container with per-bucket total + error counts', async () => {
    const after = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const body = await (await fetch(`${baseUrl}/api/activity/series?after=${encodeURIComponent(after)}`)).json();
    const keys = Object.keys(body.series).sort();
    assert.deepStrictEqual(keys, ['http-c1', 'http-c2']);

    const c1 = body.series['http-c1'];
    assert.strictEqual(c1.total.length, body.buckets.length, 'total must parallel buckets');
    // one normal event + one error in the same hour.
    assert.strictEqual(c1.total.reduce((a, b) => a + b, 0), 2);
    assert.strictEqual(c1.error.reduce((a, b) => a + b, 0), 1);
  });

  it('honours a custom bucket query param', async () => {
    const after = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const body = await (
      await fetch(`${baseUrl}/api/activity/series?after=${encodeURIComponent(after)}&bucket=${30 * 60 * 1000}`)
    ).json();
    assert.strictEqual(body.bucketMs, 30 * 60 * 1000);
    assert.ok(body.buckets.every((b) => b % (30 * 60 * 1000) === 0));
  });

  it('falls back to the 1h default on an invalid bucket param', async () => {
    const after = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const body = await (
      await fetch(`${baseUrl}/api/activity/series?after=${encodeURIComponent(after)}&bucket=notanumber`)
    ).json();
    assert.strictEqual(body.bucketMs, 60 * 60 * 1000);
  });

  it('defaults to the last 24h when no `after` is supplied', async () => {
    // No `after` → server uses Date.now() - 24h. A 24h grid at 1h has 24..25 buckets.
    const body = await (await fetch(`${baseUrl}/api/activity/series`)).json();
    assert.ok(body.buckets.length >= 24 && body.buckets.length <= 25);
  });

  it('does not alter the existing /api/activity/stats envelope (regression)', async () => {
    const after = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const body = await (await fetch(`${baseUrl}/api/activity/stats?after=${encodeURIComponent(after)}`)).json();
    // Flat global tally, unchanged by the new series endpoint.
    assert.strictEqual(body.total, 3);
    assert.strictEqual(body.error, 1);
  });
});
