import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Tests for the per-agent activity series (WARDEN-299): `getSeriesSince`
 * (src/activity.js) and the `GET /api/activity/series` route (src/server.js).
 *
 * Two layers, both driving REAL production code (no re-derived logic):
 *
 *   1. Unit tests of `getSeriesSince` — the pure-ish aggregator (it reads the
 *      JSONL log via readEvents). HOME is isolated to a temp dir whose
 *      activity.jsonl we seed with deterministic events placed at mid-bucket
 *      offsets so assertions are robust against the live clock.
 *   2. An HTTP integration test that boots the real Express app on an ephemeral
 *      port and asserts on the wire response of /api/activity/series, plus a
 *      regression check that the existing /api/activity/stats envelope is
 *      unchanged.
 *
 * `activity.js` evaluates `os.homedir()` at module load, so both layers set HOME
 * and seed the log BEFORE dynamically importing the module (mirrors
 * src/server-lifecycle.test.js). node --test runs each file in its own process,
 * so the HOME swap never leaks.
 */

const BUCKET = 60 * 60 * 1000; // 1h, matching the endpoint default
const EVENT = (type, container, ts, extra = {}) =>
  JSON.stringify({ type, container, host: 'hostA', timestamp: new Date(ts).toISOString(), ...extra });

describe('getSeriesSince — per-agent activity series aggregation', () => {
  let originalHome, tempHome, activityPath, getSeriesSince;
  let now; // captured once; all event timestamps derived from it (mid-bucket)

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-series-'));
    process.env.HOME = tempHome;
    const wdir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wdir, { recursive: true });
    activityPath = path.join(wdir, 'activity.jsonl');

    now = Date.now();
    const min = 60 * 1000;
    // c1: two events in the 30-min-ago bucket (both non-error) ...
    const lines = [
      EVENT('directive_proposed', 'c1', now - 30 * min),
      EVENT('attached', 'c1', now - 30 * min),
      // ... and two FAILURE events in the 90-min-ago bucket (one canonical error,
      // one session-down — both must count toward `error`).
      EVENT('error', 'c1', now - 90 * min, { error: 'boom' }),
      EVENT('agent_session_down', 'c1', now - 90 * min),
      // agent_ended in the 90-min-ago bucket — must count toward `total` but NOT `error`.
      EVENT('agent_ended', 'c1', now - 90 * min),
      // c2: a single quiet event.
      EVENT('directive_proposed', 'c2', now - 30 * min),
      // Outside the 5h window → must be excluded entirely.
      EVENT('attached', 'c1', now - 6 * 60 * min),
      // Host-level + manual events: no container → must be dropped (no series entry).
      EVENT('host_error', null, now - 30 * min),
      EVENT('host_ok', undefined, now - 30 * min),
      EVENT('attached', '', now - 30 * min),
    ];
    fs.writeFileSync(activityPath, lines.join('\n') + '\n');

    ({ getSeriesSince } = await import('./activity.js'));
  });

  after(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  // Find the series index for an event that happened at `ts` (robust to the live
  // clock: we look the bucket up in the returned grid rather than assuming an offset).
  const idxFor = (result, ts) => {
    const b = Math.floor(ts / result.bucketMs) * result.bucketMs;
    return result.buckets.indexOf(b);
  };

  it('returns { bucketMs, buckets, series } with the requested bucket size', () => {
    const result = getSeriesSince(now - 5 * BUCKET, { bucketMs: BUCKET });
    assert.strictEqual(result.bucketMs, BUCKET);
    assert.ok(Array.isArray(result.buckets));
    assert.ok(result.series && typeof result.series === 'object', 'series must be an object');
  });

  it('produces an ascending, epoch-aligned bucket grid spanning the whole window', () => {
    const after = now - 5 * BUCKET;
    const result = getSeriesSince(after, { bucketMs: BUCKET });
    const { buckets } = result;
    // Every bucket is epoch-aligned to the bucket size.
    assert.ok(buckets.every((b) => b % BUCKET === 0), 'buckets must be epoch-aligned');
    // Ascending.
    for (let i = 1; i < buckets.length; i++) {
      assert.ok(buckets[i] > buckets[i - 1], 'buckets must be ascending');
    }
    // Spans from floor(after) to floor(now) inclusive → no idle gap omitted.
    const first = Math.floor(after / BUCKET) * BUCKET;
    assert.strictEqual(buckets[0], first, 'first bucket is floor(after/bucketMs)*bucketMs');
    assert.strictEqual(buckets.length, (buckets[buckets.length - 1] - first) / BUCKET + 1);
  });

  it('groups events by container and sums per-bucket totals', () => {
    const result = getSeriesSince(now - 5 * BUCKET, { bucketMs: BUCKET });
    const c1 = result.series.c1;
    assert.ok(c1, 'c1 must have a series entry');
    assert.strictEqual(c1.total.length, result.buckets.length, 'total must parallel buckets');
    // 30-min-ago bucket has two non-error events; 90-min-ago bucket has three
    // (error + session_down + agent_ended). The 6h-ago event is outside the window.
    assert.strictEqual(c1.total[idxFor(result, now - 30 * 60 * 1000)], 2);
    assert.strictEqual(c1.total[idxFor(result, now - 90 * 60 * 1000)], 3);
    const sum = c1.total.reduce((a, b) => a + b, 0);
    assert.strictEqual(sum, 5, 'c1 total across the window (6h-ago event excluded)');
  });

  it('counts error + agent_session_down toward error, but NOT agent_ended', () => {
    const result = getSeriesSince(now - 5 * BUCKET, { bucketMs: BUCKET });
    const c1 = result.series.c1;
    const i30 = idxFor(result, now - 30 * 60 * 1000);
    const i90 = idxFor(result, now - 90 * 60 * 1000);
    assert.strictEqual(c1.error[i30], 0, '30-min bucket has no failures');
    // 90-min bucket: error + agent_session_down count (2); agent_ended does not.
    assert.strictEqual(c1.error[i90], 2);
    assert.strictEqual(c1.error.reduce((a, b) => a + b, 0), 2, 'only the two failure types count');
  });

  it('drops host-level / manual events that have no container (graceful sparsity)', () => {
    const result = getSeriesSince(now - 5 * BUCKET, { bucketMs: BUCKET });
    const keys = Object.keys(result.series);
    assert.deepStrictEqual(keys.sort(), ['c1', 'c2'], 'only container-bearing chats get a series');
    assert.ok(!('' in result.series) && !('null' in result.series) && !('undefined' in result.series));
  });

  it('keeps each container entry aligned to buckets (parallel arrays)', () => {
    const result = getSeriesSince(now - 5 * BUCKET, { bucketMs: BUCKET });
    const c2 = result.series.c2;
    assert.ok(c2);
    assert.strictEqual(c2.total.length, result.buckets.length);
    assert.strictEqual(c2.error.length, result.buckets.length);
    assert.strictEqual(c2.total.reduce((a, b) => a + b, 0), 1);
  });

  it('honours a custom bucket size', () => {
    // 30-min buckets → the 30-min-ago and 90-min-ago events land in different buckets.
    const half = 30 * 60 * 1000;
    const result = getSeriesSince(now - 5 * BUCKET, { bucketMs: half });
    assert.strictEqual(result.bucketMs, half);
    assert.ok(result.buckets.every((b) => b % half === 0));
    const c1 = result.series.c1;
    assert.strictEqual(c1.total.length, result.buckets.length);
    assert.strictEqual(c1.total.reduce((a, b) => a + b, 0), 5);
  });

  it('renders an idle grid (all-zero buckets) when the window has no events', () => {
    // Fresh log: no events at all in the window. buckets still spans the window;
    // series is empty (a zero-event key is never created).
    fs.writeFileSync(activityPath, '');
    const result = getSeriesSince(now - 3 * BUCKET, { bucketMs: BUCKET });
    assert.ok(result.buckets.length > 0, 'buckets still span the window');
    assert.deepStrictEqual(Object.keys(result.series), [], 'no events → no series entries');
  });
});

// NOTE: the HTTP integration test for /api/activity/series lives in its own file
// (src/activity-series-http.test.js). node --test runs every `describe` in a file
// in the SAME process, so importing activity.js here fixes its module-level
// `DIR` (computed from os.homedir() at load) to THIS file's temp HOME; a second
// describe block in the same file that booted server.js would reuse the cached
// module and read a stale/deleted path. One concern per file sidesteps that, and
// mirrors the server-hosts-status.test.js pattern.
