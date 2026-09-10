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
 * WARDEN-1318 — THE FILL IS NOW BOUNDED, and several cases below were rewritten
 * rather than deleted because they PINNED the unbounded behaviour. A transition
 * substantiates its state for STATE_STALE_AFTER_MS only; past that (or across a
 * `from: null` re-baseline, which is positive evidence that observation restarted)
 * the buckets read `null`. Observation is client-driven since WARDEN-1274, so an
 * agent nobody watched for 20h must not render 21 confident buckets. The rewritten
 * cases keep their original intent — held state → continuous segment, pre-window
 * carry-forward into bucket 0 — but now express it with observations that are
 * actually fresh, which is the only condition under which those claims are true.
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

  it('produces a forward-filled segment: a held state spans every bucket its observation substantiates', async () => {
    // WARDEN-1318 rewrite of a case that PINNED the unbounded fill (it asserted
    // `states.every(s => s !== null)` off a 25h-old baseline — i.e. it asserted the
    // defect). The ORIGINAL intent survives: a held state must read as a CONTINUOUS
    // multi-bucket segment, not a single tick. Expressed here with 5-min buckets so
    // one observation's 15-min coverage spans several of them — the honest form of
    // the same claim, since coverage is what substantiates a bucket.
    const B = 5 * 60 * 1000;
    const M = 60 * 1000;
    now = Date.now();
    seed([
      SC('c1', now - 50 * M, 'active'),
      SC('c1', now - 10 * M, 'stuck', 'active'),
    ]);
    const r = await getStateSeriesSince(now - 60 * M, { bucketMs: B, now });
    const c1 = r.series.c1;
    assert.ok(c1, 'c1 must have a series entry');
    assert.strictEqual(c1.states.length, r.buckets.length, 'states parallels buckets');
    const at = (offsetM) => r.buckets.indexOf(Math.floor((now - offsetM * M) / B) * B);
    // The `active` observation substantiates a CONTIGUOUS run of buckets (not one tick):
    const idxActive = at(50);
    assert.ok(idxActive >= 0, 'the active observation lands in the grid');
    assert.strictEqual(c1.states[idxActive], 'active', 'the observed bucket reads active');
    assert.strictEqual(c1.states[idxActive + 1], 'active', 'the held state continues into the next bucket');
    assert.strictEqual(c1.states[idxActive + 2], 'active', 'and the next — a continuous segment');
    // …and stops once the observation no longer substantiates anything (the bound):
    assert.strictEqual(c1.states[idxActive + 4], null, 'past the staleness bound the row reads unknown');
    // The later transition opens its own continuous segment, through the last bucket
    // (its coverage reaches `now`, so the rightmost column is genuinely substantiated).
    const idxStuck = at(10);
    assert.strictEqual(c1.states[idxStuck], 'stuck', 'stuck-transition bucket is stuck');
    assert.strictEqual(c1.states[r.buckets.length - 1], 'stuck', 'a fresh observation still fills to now');
    // The gap between the two observations is honest unknown, NOT a held `active`:
    assert.strictEqual(c1.states[idxStuck - 1], null, 'the unobserved stretch reads null, not carried state');
  });

  it('carries forward a state set BEFORE the window into the first bucket', async () => {
    // Snap `now` (hence `start`) to the bucket grid: epoch-aligned buckets mean an
    // unsnapped start lets the observation's 15-min coverage reach into bucket 1 by
    // wall-clock luck (flaky whenever start's minute-of-hour >= 46). Aligned, the
    // coverage provably stops inside bucket 0 and the exact assertion below holds
    // deterministically.
    now = Math.floor(Date.now() / BUCKET) * BUCKET;
    // Pre-window carry-forward survives the WARDEN-1318 bound: a transition logged
    // just BEFORE the window start still substantiates bucket 0 (its coverage
    // intersects it), so the row does not open blank. What CHANGED is the scope of
    // the carry — it reaches bucket 0, not every bucket through to `now`.
    const start = now - 5 * BUCKET;
    seed([SC('steady', start - 60_000, 'active')]);
    const r = await getStateSeriesSince(start, { bucketMs: BUCKET, now });
    const steady = r.series.steady;
    assert.ok(steady, 'a steady agent with a pre-window baseline gets a row');
    assert.strictEqual(steady.states[0], 'active', 'pre-window baseline carries forward into bucket 0');
    // …and does NOT paint the rest of the day. This assertion replaces the old
    // `every(s => s === 'active')`, which pinned exactly the defect: one observation
    // cannot substantiate hours nobody watched.
    assert.ok(steady.states.slice(1).every((s) => s === null), 'beyond the bound the row is honest unknown');
  });

  it('reads null for a never-observed prefix (honest "unknown", not a false segment)', async () => {
    now = Date.now();
    // c1 is first observed (baseline) 3h ago — within a 10h window. The buckets
    // BEFORE that first observation must read null (unchanged behaviour), and — since
    // WARDEN-1318 — so must the buckets after its coverage lapses.
    seed([SC('c1', now - 3 * 60 * 60 * 1000, 'active')]);
    const r = await getStateSeriesSince(now - 10 * BUCKET, { bucketMs: BUCKET, now });
    const c1 = r.series.c1;
    const idxFirst = r.buckets.indexOf(Math.floor((now - 3 * 60 * 60 * 1000) / BUCKET) * BUCKET);
    assert.strictEqual(c1.states[0], null, 'bucket before first observation is null');
    assert.strictEqual(c1.states[idxFirst], 'active', 'the observed bucket reads its state');
    assert.strictEqual(c1.states[c1.states.length - 1], null, 'the trailing unobserved hours read null too');
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
    // A FRESH active observation substantiates the last bucket; the error/attached
    // volume events must NOT introduce any state of their own. (WARDEN-1318: the
    // baseline moved from 25h ago to 1 min ago — a 25h-old one now reads null
    // everywhere, which would have made this case vacuously pass.)
    seed([
      SC('c1', now - 60_000, 'active'),
      JSON.stringify({ type: 'error', container: 'c1', timestamp: iso(90 * 60 * 1000) }),
      JSON.stringify({ type: 'attached', container: 'c1', timestamp: iso(60 * 60 * 1000) }),
    ]);
    const r = await getStateSeriesSince(now - 5 * BUCKET, { bucketMs: BUCKET, now });
    const c1 = r.series.c1;
    const distinct = new Set(c1.states.filter((s) => s !== null));
    assert.deepStrictEqual([...distinct], ['active'], 'non-state_changed events are ignored');
    assert.strictEqual(c1.states[c1.states.length - 1], 'active', 'the fresh observation is present');
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

  // ---------------------------------------------------------------------------
  // WARDEN-1318 — the observation bound. Since WARDEN-1274 retired the 60s
  // server-side attention sweep, state_changed logging is CLIENT-driven: nothing is
  // recorded while the dashboard window is closed. The forward-fill must therefore
  // stop claiming a state it cannot substantiate.
  // ---------------------------------------------------------------------------
  describe('observation bound: an unwatched blackout renders unknown, not held state', () => {
    it('THE DEFECT: one observation 20h ago does NOT render 21 solid buckets (positive control included)', async () => {
      // The ticket's exact reproduction, with the positive control in the SAME run
      // so a broken harness is distinguishable from a real reading.
      // Snap `now` to the bucket grid: the bucket grid is epoch-aligned, so an
      // unsnapped `now` lets the 15-min coverage of the seeded observation straddle
      // a bucket boundary by wall-clock luck (flaky whenever now's minute-of-hour
      // >= 45). Hour-aligned `now` puts the 20h-old observation exactly ON a
      // boundary, so its coverage stays inside one bucket and the exact-count
      // assertions below are deterministic.
      now = Math.floor(Date.now() / BUCKET) * BUCKET;
      const H = 60 * 60 * 1000;
      const lines = [SC('blackout', now - 20 * H, 'active')];
      // Control: genuinely observed every hour across the whole window (alternating
      // so each tick is a real transition the dedup would log).
      for (let i = 23; i >= 0; i--) {
        lines.push(SC('watched', now - i * H, i % 2 ? 'active' : 'stuck', i % 2 ? 'stuck' : 'active'));
      }
      seed(lines);
      const r = await getStateSeriesSince(now - 24 * H, { bucketMs: BUCKET, now });

      const blackout = r.series.blackout.states;
      const nonNull = blackout.filter((s) => s !== null);
      assert.strictEqual(nonNull.length, 1, 'exactly the observed bucket is claimed — not 21 of them');
      assert.strictEqual(nonNull[0], 'active', 'and that one bucket reads the state actually observed');
      assert.strictEqual(blackout[blackout.length - 1], null, 'the "now" column is honestly unknown');

      // Positive control: the harness IS reading real data — a watched agent still
      // renders a full row with both states present.
      const watched = r.series.watched.states;
      assert.ok(watched.filter((s) => s !== null).length > 20, 'the watched control still fills its row');
      const distinct = new Set(watched.filter((s) => s !== null));
      assert.ok(distinct.has('active') && distinct.has('stuck'), 'control shows its real oscillation');
    });

    it('an agent observed WITHIN the bound still renders ONE continuous segment (no gap-flicker)', async () => {
      // The anti-regression for the fix: a genuinely-watched steady agent must not
      // acquire holes. Transitions arrive every 5 min (inside the 15-min bound), so
      // every bucket in between is substantiated by the preceding observation.
      const B = 5 * 60 * 1000;
      const M = 60 * 1000;
      now = Date.now();
      const lines = [];
      for (let i = 12; i >= 0; i--) {
        lines.push(SC('c1', now - i * 5 * M, i % 2 ? 'active' : 'stuck', i % 2 ? 'stuck' : 'active'));
      }
      seed(lines);
      const r = await getStateSeriesSince(now - 60 * M, { bucketMs: B, now });
      const states = r.series.c1.states;
      const firstIdx = states.findIndex((s) => s !== null);
      assert.ok(firstIdx >= 0, 'the row has observed buckets');
      assert.ok(
        states.slice(firstIdx).every((s) => s !== null),
        'no null appears once observation starts — a watched agent has no gap-flicker',
      );
      assert.notStrictEqual(states[states.length - 1], null, 'row reaches now — the "now" column is substantiated');
    });

    it('a `from: null` re-baseline breaks the segment: the pre-blackout state is not carried across it', async () => {
      // The evidence-backed bound. `from: null` is written when logStateTransition's
      // in-memory map has no prior entry — i.e. warden restarted / reopened — so it
      // proves observation was interrupted. Buckets between the previous transition
      // and the re-baseline read null even where the elapsed bound alone would still
      // have been satisfied.
      const B = 60 * 1000; // 1-min buckets so the whole scenario sits inside 15 min
      const M = 60 * 1000;
      now = Date.now();
      seed([
        SC('c1', now - 10 * M, 'active'),          // observed…
        SC('c1', now - 2 * M, 'active', null),     // …then a RESTART re-baseline (from: null)
      ]);
      const r = await getStateSeriesSince(now - 12 * M, { bucketMs: B, now });
      const states = r.series.c1.states;
      const at = (offM) => r.buckets.indexOf(Math.floor((now - offM * M) / B) * B);
      assert.strictEqual(states[at(10)], 'active', 'the first observation claims its own bucket');
      // Elapsed time alone (8 min < 15) would have carried `active` straight through
      // here; the re-baseline marker is what nulls it.
      assert.strictEqual(states[at(6)], null, 'the stretch before the restart is unknown, not carried');
      assert.strictEqual(states[at(3)], null, '…right up to the re-baseline');
      assert.strictEqual(states[at(2)], 'active', 'the re-baseline opens a NEW observed segment');
      assert.strictEqual(states[states.length - 1], 'active', 'which holds to now');
    });

    it('a re-baseline with a NON-null `from` is an ordinary transition (no spurious break)', async () => {
      // Guard against over-breaking: only `from: null` is the restart marker. A
      // normal active→stuck transition must NOT introduce a gap.
      const B = 60 * 1000;
      const M = 60 * 1000;
      now = Date.now();
      seed([
        SC('c1', now - 10 * M, 'active'),
        SC('c1', now - 2 * M, 'stuck', 'active'),
      ]);
      const r = await getStateSeriesSince(now - 12 * M, { bucketMs: B, now });
      const states = r.series.c1.states;
      const firstIdx = states.findIndex((s) => s !== null);
      assert.ok(
        states.slice(firstIdx).every((s) => s !== null),
        'a genuine transition inside the bound leaves a continuous row',
      );
    });

    it('added nulls do not change the oscillation count for the OBSERVED cases', async () => {
      // countStateSegments (web/src/lib/stateTimeline.ts) skips nulls and does not
      // reset `prev`, so extra nulls can neither manufacture nor suppress a
      // transition count. Mirrored here so the backend guarantees it feeds it.
      const countStateSegments = (states) => {
        let segments = 0, prev = null;
        for (const s of states) if (s !== null && s !== prev) { segments += 1; prev = s; }
        return segments;
      };
      const H = 60 * 60 * 1000;
      now = Date.now();
      seed([
        SC('c1', now - 12 * H, 'stuck'),
        SC('c1', now - 8 * H, 'active', 'stuck'),
        SC('c1', now - 4 * H, 'stuck', 'active'),
      ]);
      const r = await getStateSeriesSince(now - 24 * H, { bucketMs: BUCKET, now });
      assert.strictEqual(
        countStateSegments(r.series.c1.states), 3,
        'stuck→active→stuck is still 3 segments (2 state changes) despite the blackout nulls',
      );
    });
  });
});
