import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * HTTP integration test for the RAW `GET /api/activity` feed (WARDEN-1101).
 *
 * The bug: the route passed `limit` into `readEvents` (which sorts newest-first
 * and slices internally) and only THEN filtered out `state_changed`. Every
 * internal marker among the newest N was therefore SUBTRACTED from the caller's
 * requested N instead of skipped over. `logStateTransition` seeds a `from:null`
 * baseline for every agent on every warden restart, so a fleet of ≥50 agents
 * produces a newest-first burst that swallows the whole "Last 50" window — the
 * Activity Timeline rendered "Showing 0 of 0 events" with a full store on disk.
 *
 * Lives in its own file (not appended to src/activity-series-http.test.js)
 * because node --test runs every `describe` in a file in the SAME process:
 * activity.js fixes its module-level `DIR` from os.homedir() at load, so a
 * second describe booting server.js would reuse the cached module and read a
 * stale path. One concern per file, mirroring the sibling HTTP suites.
 *
 * Boots the REAL Express app from src/server.js on an ephemeral port with HOME
 * isolated to a temp dir whose activity.jsonl is seeded BEFORE the dynamic
 * import. node --test gives each file its own process, so the HOME swap never
 * leaks.
 */

const EVENT = (type, container, ts, extra = {}) =>
  JSON.stringify({ type, container, host: 'hostA', timestamp: new Date(ts).toISOString(), ...extra });

// The restart burst: N agents each emitting a from:null baseline in one
// newest-first clump, sitting on top of genuine older activity.
const STATE_BURST = 60;
const REAL_EVENTS = 80;

describe('GET /api/activity limit applies AFTER the state_changed exclusion (WARDEN-1101)', () => {
  let httpServer, baseUrl;
  let originalHome, tempHome, activityPath;
  let now;

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-feed-http-'));
    process.env.HOME = tempHome;
    const wdir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wdir, { recursive: true });
    fs.writeFileSync(path.join(wdir, 'config.json'), JSON.stringify({ hosts: [] }) + '\n');
    activityPath = path.join(wdir, 'activity.jsonl');

    now = Date.now();
    const lines = [];
    // Older: genuine activity the user actually wants to see.
    for (let i = 0; i < REAL_EVENTS; i++) {
      lines.push(EVENT('directive_sent', `feed-c${i % 4}`, now - (10 * 60 * 1000) - (i * 1000), { text: `d${i}` }));
    }
    // Newest: the restart baseline burst — one state_changed per agent.
    for (let i = 0; i < STATE_BURST; i++) {
      lines.push(EVENT('state_changed', `feed-a${i}`, now - (i * 1000), { from: null, to: 'active' }));
    }
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

  const feed = async (qs = '') => {
    const res = await fetch(`${baseUrl}/api/activity${qs}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.events), 'response carries an events array');
    return body.events;
  };

  it('returns N ACTIVITY events for ?limit=N even when the newest N are all state_changed', async () => {
    // The regression: with STATE_BURST=60 newest markers, the old route returned
    // 0 events here (readEvents sliced 25 state_changed, the filter dropped all 25).
    const events = await feed('?limit=25');
    assert.strictEqual(events.length, 25, 'limit=25 yields 25 activity events, not 0');
    assert.ok(events.every((e) => e.type !== 'state_changed'), 'no internal markers leak into the feed');
  });

  it('fills the "Last 50" window the ActivityTimeline offers (the blanked case)', async () => {
    // 50 ≤ STATE_BURST, so under the old ordering this returned exactly 0 events
    // and the panel read "Showing 0 of 0 events" with 80 real events on disk.
    const events = await feed('?limit=50');
    assert.strictEqual(events.length, 50, 'limit=50 yields 50 activity events, not 0');
    assert.ok(events.every((e) => e.type !== 'state_changed'));
  });

  it('still returns newest-first, and caps at the number of activity events available', async () => {
    const events = await feed('?limit=500');
    assert.strictEqual(events.length, REAL_EVENTS, 'asking for more than exist returns all activity events');
    const stamps = events.map((e) => new Date(e.timestamp).getTime());
    assert.deepStrictEqual(stamps, [...stamps].sort((a, b) => b - a), 'order is still descending (newest first)');
  });

  it('treats an invalid ?limit=abc as "no limit" and returns the full filtered feed', async () => {
    // parseInt('abc') is NaN. readEvents' `if (limit && …)` guard already treated
    // NaN as no-limit; a bare .slice(0, NaN) in the route would return [] instead,
    // converting one blanking bug into another.
    const events = await feed('?limit=abc');
    assert.strictEqual(events.length, REAL_EVENTS, 'NaN limit must not blank the feed');
    assert.ok(events.every((e) => e.type !== 'state_changed'));
  });

  it('returns the full filtered feed when ?limit is omitted entirely', async () => {
    const events = await feed();
    assert.strictEqual(events.length, REAL_EVENTS);
    assert.ok(events.every((e) => e.type !== 'state_changed'), 'state_changed stays excluded with no limit');
  });

  it('keeps honouring the ?after time window alongside the limit', async () => {
    // Only the newest ~5 directives fall inside this window; the limit must not
    // widen it, and the exclusion must not narrow it below what is in range.
    const afterTs = new Date(now - (10 * 60 * 1000) - 4500).toISOString();
    const events = await feed(`?after=${encodeURIComponent(afterTs)}&limit=50`);
    assert.strictEqual(events.length, 5, 'time range still bounds the result under a larger limit');
    assert.ok(events.every((e) => new Date(e.timestamp).getTime() >= new Date(afterTs).getTime()));
  });

  it('still routes state_changed to /api/activity/series stateSeries (orthogonality)', async () => {
    // Excluding the marker from the raw feed must NOT starve its dedicated
    // surface: the burst agents still need a row in the Fleet state timeline.
    const afterTs = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const res = await fetch(`${baseUrl}/api/activity/series?after=${encodeURIComponent(afterTs)}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(body.stateSeries && typeof body.stateSeries === 'object', 'stateSeries present');
    assert.ok('feed-a0' in body.stateSeries, 'a state_changed-only agent still reaches the state timeline');
  });
});
