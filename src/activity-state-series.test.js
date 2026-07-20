import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Tests for `getStateSeriesSince` (src/activity.js) — the per-bucket STATE series
 * that powers the Fleet state timeline (WARDEN-788). Sibling to
 * activity-series.test.js (which covers the VOLUME series, getSeriesSince).
 *
 * `getStateSeriesSince` reads state_changed events from the SAME JSONL store and
 * forward-fills them per container into a last-known-state-per-bucket series, so:
 *   - a HELD state reads as a continuous segment (not a single tick);
 *   - a transition BEFORE the window carries forward into the window's first bucket;
 *   - a never-observed prefix reads `null` (honest "unknown", not a false segment);
 *   - two transitions in one bucket collapse to the later one (last-known aliasing).
 *
 * HOME-isolation + seed-then-dynamic-import mirrors activity-series.test.js and
 * src/activity.test.js: activity.js evaluates `os.homedir()` at module load, so
 * HOME must be swapped BEFORE the import. node --test runs each file in its own
 * process, so the swap never leaks.
 *
 * The reader is async (WARDEN-828 moved the JSONL read onto fs.promises), so every
 * case awaits it.
 */
const BUCKET = 60 * 60 * 1000; // 1h, matching the endpoint default

// Build one state_changed JSONL line. `ts` is epoch ms → ISO timestamp. `from`
// defaults to null (the first-observation baseline the server logs).
const SC = (container, ts, to, from = null, extra = {}) =>
  JSON.stringify({ type: 'state_changed', container, host: 'hostA', from, to, timestamp: new Date(ts).toISOString(), ...extra });

describe('getStateSeriesSince — per-agent state series forward-fill (WARDEN-788)', () => {
  let originalHome, tempHome, activityPath, getStateSeriesSince;
  let now; // captured once; all event timestamps derived from it (mid-bucket)

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-state-series-'));
    process.env.HOME = tempHome;
    const wdir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wdir, { recursive: true });
    activityPath = path.join(wdir, 'activity.jsonl');
    // Seed lazily per-test via `seed()`; just ensure the file exists.
    fs.writeFileSync(activityPath, '', 'utf8');
    ({ getStateSeriesSince } = await import('./activity.js'));
  });

  after(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  // Re-seed the (fixed-path) log from an array of pre-built JSONL strings.
  const seed = (lines = []) => {
    fs.writeFileSync(activityPath, lines.length ? lines.join('\n') + '\n' : '', 'utf8');
  };

  // epoch-ms → ISO string, with `offsetMs` subtracted from the captured `now`.
  const iso = (offsetMs) => new Date(now - offsetMs).toISOString();

  it('returns { bucketMs, buckets, series } with the requested bucket size', async () => {
    seed();
    now = Date.now();
    const r = await getStateSeriesSince(now - 5 * BUCKET, { bucketMs: BUCKET });
    assert.strictEqual(r.bucketMs, BUCKET);
    assert.ok(Array.isArray(r.buckets));
    assert.ok(r.series && typeof r.series === 'object');
  });

  it('produces a forward-filled segment: a held state spans every bucket until the next transition', async () => {
    now = Date.now();
    // c1: baseline active 25h ago (BEFORE the 24h window → carry-forward seed),
    // transitions to stuck 3h ago (mid-window).
    seed([
      SC('c1', now - 25 * 60 * 60 * 1000, 'active'),
      SC('c1', now - 3 * 60 * 60 * 1000, 'stuck', 'active'),
    ]);
    const r = await getStateSeriesSince(now - 24 * 60 * 60 * 1000, { bucketMs: BUCKET });
    const c1 = r.series.c1;
    assert.ok(c1, 'c1 must have a series entry');
    assert.strictEqual(c1.states.length, r.buckets.length, 'states parallels buckets');
    // Every state is non-null (carry-forward from the pre-window baseline):
    assert.ok(c1.states.every((s) => s !== null), 'carry-forward fills the whole window');
    // The stuck transition is mid-window → its bucket index is in the grid.
    const idxStuck = r.buckets.indexOf(Math.floor((now - 3 * 60 * 60 * 1000) / BUCKET) * BUCKET);
    assert.ok(idxStuck > 0, 'stuck transition lands mid-window');
    assert.strictEqual(c1.states[0], 'active', 'first bucket carried forward as active');
    assert.strictEqual(c1.states[idxStuck - 1], 'active', 'bucket before the stuck transition is active');
    assert.strictEqual(c1.states[idxStuck], 'stuck', 'stuck-transition bucket is stuck');
    assert.strictEqual(c1.states[r.buckets.length - 1], 'stuck', 'forward-fills to the last bucket');
  });

  it('carries forward a state set BEFORE the window into the first bucket', async () => {
    now = Date.now();
    // A steady agent: ONE baseline event 20h ago (before the 5h window), no transitions.
    seed([SC('steady', now - 20 * 60 * 60 * 1000, 'active')]);
    const r = await getStateSeriesSince(now - 5 * BUCKET, { bucketMs: BUCKET });
    const steady = r.series.steady;
    assert.ok(steady, 'a steady agent with a pre-window baseline gets a row');
    // Without carry-forward this would be blank; the whole row must read 'active'.
    assert.ok(steady.states.every((s) => s === 'active'), 'pre-window baseline carries forward across the window');
  });

  it('reads null for a never-observed prefix (honest "unknown", not a false segment)', async () => {
    now = Date.now();
    // c1 is first observed (baseline) 3h ago — within a 10h window. The buckets
    // BEFORE that first observation must read null, then active forward-filled.
    seed([SC('c1', now - 3 * 60 * 60 * 1000, 'active')]);
    const r = await getStateSeriesSince(now - 10 * BUCKET, { bucketMs: BUCKET });
    const c1 = r.series.c1;
    const idxFirst = r.buckets.indexOf(Math.floor((now - 3 * 60 * 60 * 1000) / BUCKET) * BUCKET);
    // Buckets before the first observation are null; the first-observed bucket onward is active.
    assert.strictEqual(c1.states[0], null, 'bucket before first observation is null');
    assert.strictEqual(c1.states[idxFirst], 'active');
    assert.strictEqual(c1.states[c1.states.length - 1], 'active');
  });

  it('collapses two transitions in one bucket to the LATER state (last-known aliasing)', async () => {
    now = Date.now();
    // Two transitions within the SAME 1h bucket: active → stuck → erroring. The
    // bucket's last-known state must be 'erroring' (the later one wins).
    const bucketStart = Math.floor(now / BUCKET) * BUCKET;
    const mid = bucketStart + 30 * 60 * 1000; // 30 min into the current bucket
    seed([
      SC('c1', mid - 60_000, 'stuck', 'active'),
      SC('c1', mid, 'erroring', 'stuck'),
    ]);
    const r = await getStateSeriesSince(now - 2 * BUCKET, { bucketMs: BUCKET });
    const c1 = r.series.c1;
    const idx = r.buckets.indexOf(bucketStart);
    assert.strictEqual(c1.states[idx], 'erroring', 'two transitions in one bucket → last-known wins');
  });

  it('drops state_changed events with no container (host-level / manual chats)', async () => {
    now = Date.now();
    seed([
      SC('c1', now - 60_000, 'active'),
      JSON.stringify({ type: 'state_changed', container: null, host: 'h', to: 'active', timestamp: iso(60_000) }),
      JSON.stringify({ type: 'state_changed', container: '', host: 'h', to: 'active', timestamp: iso(60_000) }),
    ]);
    const r = await getStateSeriesSince(now - 5 * BUCKET, { bucketMs: BUCKET });
    assert.deepStrictEqual(Object.keys(r.series).sort(), ['c1'], 'only container-bearing chats get a row');
  });

  it('ignores non-state_changed events (volume events do not leak into the state series)', async () => {
    now = Date.now();
    // A pre-window active baseline fills the window via carry-forward; the
    // error/attached volume events must NOT introduce any non-active state.
    seed([
      SC('c1', now - 25 * 60 * 60 * 1000, 'active'),
      JSON.stringify({ type: 'error', container: 'c1', timestamp: iso(90 * 60 * 1000) }),
      JSON.stringify({ type: 'attached', container: 'c1', timestamp: iso(60 * 60 * 1000) }),
    ]);
    const r = await getStateSeriesSince(now - 5 * BUCKET, { bucketMs: BUCKET });
    const c1 = r.series.c1;
    // The error/attached events must not appear as states; carry-forward active fills all.
    assert.ok(c1.states.every((s) => s === 'active'), 'non-state_changed events are ignored');
  });

  it('oscillation stuck→active→stuck produces visibly distinct repeating segments', async () => {
    // THE ticket's headline assertion: a looping agent renders a stripe the volume
    // heatmap cannot. Three transitions across the window → alternating segments.
    now = Date.now();
    seed([
      SC('c1', now - 12 * 60 * 60 * 1000, 'stuck'),
      SC('c1', now - 8 * 60 * 60 * 1000, 'active', 'stuck'),
      SC('c1', now - 4 * 60 * 60 * 1000, 'stuck', 'active'),
    ]);
    const r = await getStateSeriesSince(now - 24 * 60 * 60 * 1000, { bucketMs: BUCKET });
    const states = r.series.c1.states;
    // Distinct segments exist: the sequence contains at least one stuck→active→stuck run.
    const joined = states.filter((s) => s !== null).join(',');
    assert.ok(joined.includes('stuck,active') && joined.includes('active,stuck'), 'oscillation shows as alternating segments');
    // And it is NOT all one state (the pattern the snapshot/heatmap cannot reveal):
    const distinct = new Set(states.filter((s) => s !== null));
    assert.ok(distinct.has('stuck') && distinct.has('active'), 'both states appear');
  });

  it('handles an empty store gracefully (no rows, buckets still span the window)', async () => {
    now = Date.now();
    seed([]);
    const r = await getStateSeriesSince(now - 3 * BUCKET, { bucketMs: BUCKET });
    assert.ok(r.buckets.length > 0, 'buckets still span the window');
    assert.deepStrictEqual(Object.keys(r.series), [], 'no state_changed events → no series entries');
  });
});
