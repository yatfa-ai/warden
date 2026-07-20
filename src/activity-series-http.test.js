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
      // A state_changed-ONLY container (WARDEN-788): its transitions must flow to
      // stateSeries (the Fleet state timeline) but NOT to the volume series or the
      // stats total — the heatmap stays a volume-of-activity surface. This is the
      // exact seed the original suite lacked (it seeded only lifecycle events), so
      // the heatmap/stats inflation regression slipped through to fail_qa.
      EVENT('state_changed', 'http-st', now - 3 * 60 * 60 * 1000, { from: null, to: 'active' }),
      EVENT('state_changed', 'http-st', now - 1 * 60 * 60 * 1000, { from: 'active', to: 'stuck' }),
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
    // http-st is seeded but its events are state_changed — it must NOT appear in
    // the VOLUME series (the heatmap). If the exclusion regressed, http-st would
    // leak in here and this assertion would read ['http-c1', 'http-c2', 'http-st'].
    assert.deepStrictEqual(keys, ['http-c1', 'http-c2']);

    const c1 = body.series['http-c1'];
    assert.strictEqual(c1.total.length, body.buckets.length, 'total must parallel buckets');
    // one normal event + one error in the same hour.
    assert.strictEqual(c1.total.reduce((a, b) => a + b, 0), 2);
    assert.strictEqual(c1.error.reduce((a, b) => a + b, 0), 1);
  });

  it('returns stateSeries alongside the volume series (WARDEN-788)', async () => {
    // The SAME endpoint carries the per-agent state timeline as an additive sibling
    // field. The seeded state_changed events (container http-st) must surface HERE
    // — proving the transitions still flow to the timeline even though they are
    // excluded from the volume series above (orthogonality: timeline-only).
    const after = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const body = await (await fetch(`${baseUrl}/api/activity/series?after=${encodeURIComponent(after)}`)).json();
    assert.ok(body.stateSeries && typeof body.stateSeries === 'object', 'stateSeries field is present');
    assert.ok('http-st' in body.stateSeries, 'the state_changed-only container IS present in the state timeline');
    // The volume events (directive_proposed/error/attached) never become states:
    // http-st's row is built purely from its state_changed transitions.
    assert.ok(Array.isArray(body.stateSeries['http-st'].states), 'state row carries a states array');
    assert.ok(body.series && typeof body.series === 'object', 'volume series still present');
    assert.ok(!('http-st' in body.series), '...but the same container is absent from the volume series');
  });

  it('excludes state_changed from the raw GET /api/activity feed (WARDEN-788)', async () => {
    // The raw activity feed backs the Observer Panel's Activity Timeline
    // (useLiveTimeline → ActivityTimeline.tsx). state_changed has no icon, no
    // color, and no case in ActivityTimeline's renderDetails switch, so it would
    // render there as a header-only "STATE CHANGED" row with an empty detail line
    // — and the from:null baseline fires fleet-wide on every restart. The SAME
    // NON_ACTIVITY_TYPES exclusion getSeriesSince/getStatsSince apply must cover
    // this third reader. Orthogonality mirror of the volume assertion above,
    // ported to the raw feed: state_changed is absent here but present in
    // stateSeries. (fail_audit fix: this is the consumer the heatmap/stats
    // scoping skipped, identical disease.)
    const body = await (await fetch(`${baseUrl}/api/activity?limit=100`)).json();
    assert.ok(Array.isArray(body.events), 'feed returns an events array');
    const types = body.events.map((e) => e.type);
    assert.ok(!types.includes('state_changed'), 'state_changed MUST be absent from the raw activity feed');

    // Genuine lifecycle/directive/error activity is untouched — only the marker is
    // dropped. The seeded non-state events (directive_proposed, error, attached)
    // all survive.
    for (const expected of ['directive_proposed', 'error', 'attached']) {
      assert.ok(types.includes(expected), `${expected} survives the exclusion`);
    }

    // The exact orthogonality the volume assertion makes, ported to the raw feed:
    // the state_changed-only container (http-st) is absent from the raw feed…
    const feedContainers = new Set(body.events.map((e) => e.container));
    assert.ok(!feedContainers.has('http-st'), 'the state_changed-only container is absent from the raw feed');

    // …but IS present in the state timeline (its dedicated surface). Re-fetch the
    // series and confirm http-st still has a state row — the exclusion drops it
    // from the feed, not from the timeline.
    const after = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const series = await (await fetch(`${baseUrl}/api/activity/series?after=${encodeURIComponent(after)}`)).json();
    assert.ok('http-st' in series.stateSeries, '...but the same container IS present in the state timeline');
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
    // Flat global tally, unchanged by the new series endpoint. total stays 3 — the
    // two seeded state_changed events (http-st) are EXCLUDED, so the timeline
    // logging does not inflate the rollup. With the regression present total = 5.
    assert.strictEqual(body.total, 3);
    assert.strictEqual(body.error, 1);
  });
});
