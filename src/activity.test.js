import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Contract tests for the 4 previously-untested data-integrity functions in
 * src/activity.js (the JSONL "while you were away" activity log):
 *
 *   - appendEvent     (JSONL append + ensure-dir + timestamp merge)
 *   - readEvents      (inclusive range filter + limit + malformed-line skip + desc sort)
 *   - rotateEvents    (7-day retention rewrite — boot-time, try/catch-swallowed at
 *                      server.js:2310, so a regression is invisible without tests)
 *   - getStatsSince   (engine behind GET /api/activity/stats → the human attention rollup)
 *
 * `getSeriesSince` is already covered by src/activity-series.test.js; this file
 * closes the remaining gap (verified NO_REFERENCING_TESTS via test-discovery and
 * `git grep ... origin/main -- 'src/*.test.js'`).
 *
 * HOME-isolation + seed-then-dynamic-import mirrors activity-series.test.js and
 * src/server-lifecycle.test.js: activity.js evaluates `os.homedir()` at module load
 * (computing DIR/FILE), so HOME must be swapped BEFORE the import. node --test runs
 * each file in its own process, so the swap never leaks. A SINGLE top-level
 * describe holds ONE dynamic import — DIR/FILE are fixed for the process after it,
 * so every nested test re-seeds the SAME activityPath rather than re-importing
 * (re-import would be a no-op: the module is cached, so a second import could not
 * re-point DIR at a new HOME).
 */
const DAY = 24 * 60 * 60 * 1000;
const SEVEN_DAYS = 7 * DAY;

// Build one JSONL line. `ts` is epoch ms → ISO timestamp on the written event
// (the field readEvents/rotateEvents parse back via new Date(...).getTime()).
const line = (type, ts, extra = {}) =>
  JSON.stringify({ type, timestamp: new Date(ts).toISOString(), ...extra });

describe('activity.js — appendEvent / readEvents / rotateEvents / getStatsSince', () => {
  let originalHome, tempHome, wdir, activityPath;
  let appendEvent, readEvents, rotateEvents, getStatsSince;

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-activity-'));
    process.env.HOME = tempHome;
    wdir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wdir, { recursive: true });
    activityPath = path.join(wdir, 'activity.jsonl');
    fs.writeFileSync(activityPath, '', 'utf8'); // start clean; each test re-seeds
    ({ appendEvent, readEvents, rotateEvents, getStatsSince } = await import('./activity.js'));
  });

  after(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  // Re-seed the (fixed-path) log from an array of pre-built JSONL strings, or
  // clear it when omitted. DIR/FILE are frozen at import time, so we only ever
  // rewrite FILE's *contents* — never re-point the module at a new HOME.
  const seed = (lines = []) => {
    const body = lines.length ? lines.join('\n') + '\n' : '';
    fs.writeFileSync(activityPath, body, 'utf8');
  };

  // Run a callback with console.warn silenced (the malformed-line paths in
  // readEvents intentionally console.warn per skipped line; we expect those
  // warnings here and don't want them polluting test output).
  const withNoWarn = (fn) => async () => {
    const orig = console.warn;
    const captured = [];
    console.warn = (...args) => captured.push(args.join(' '));
    try { await fn(captured); } finally { console.warn = orig; }
  };

  // ------------------------------------------------- appendEvent ----------
  describe('appendEvent', () => {
    it('writes exactly one valid JSON line containing the spread event fields', () => {
      seed();
      appendEvent({ type: 'attached', container: 'c1', host: 'hostA' });
      const rows = fs.readFileSync(activityPath, 'utf8').trim().split('\n');
      assert.strictEqual(rows.length, 1, 'exactly one line written');
      const ev = JSON.parse(rows[0]); // throws if the line is not valid JSON
      assert.strictEqual(ev.type, 'attached');
      assert.strictEqual(ev.container, 'c1');
      assert.strictEqual(ev.host, 'hostA');
    });

    it('assigns an ISO-8601 (UTC) timestamp at write time when the caller omits one', () => {
      seed();
      const before = Date.now();
      appendEvent({ type: 'attached', container: 'c1' });
      const after = Date.now();
      const ev = JSON.parse(fs.readFileSync(activityPath, 'utf8'));
      const ts = new Date(ev.timestamp).getTime();
      assert.ok(Number.isFinite(ts), 'timestamp parses to a finite epoch ms');
      assert.ok(ev.timestamp.endsWith('Z'), 'ISO 8601 UTC marker');
      assert.ok(ts >= before && ts <= after, 'timestamp is server-assigned at write time');
    });

    // ⚠️ ACTUAL behaviour vs the proposal's claim. activity.js does:
    //        `{ timestamp: new Date().toISOString(), ...event }`
    //   so the caller's spread runs LAST and a caller-supplied `timestamp`
    //   OVERWRITES the server-assigned value (caller-wins → forgeable). The
    //   proposal described the inverse ("caller cannot forge it"). This test
    //   pins the REAL merge order; if timestamp-forgeability is later deemed a
    //   data-integrity bug, a source fix must flip the spread to
    //   `{ ...event, timestamp: new Date().toISOString() }` and update this
    //   assertion in the same change.
    it('preserves a caller-supplied timestamp (spread merges AFTER the server value)', () => {
      seed();
      const forged = '2020-01-01T00:00:00.000Z';
      appendEvent({ type: 'attached', container: 'c1', timestamp: forged });
      const ev = JSON.parse(fs.readFileSync(activityPath, 'utf8'));
      assert.strictEqual(ev.timestamp, forged, 'caller-supplied timestamp wins (forgeable)');
    });

    it('appends rather than overwrites (two calls → two lines, in order)', () => {
      seed();
      appendEvent({ type: 'attached', container: 'c1' });
      appendEvent({ type: 'ended', container: 'c2' });
      const rows = fs.readFileSync(activityPath, 'utf8').trim().split('\n');
      assert.strictEqual(rows.length, 2);
      const [first, second] = rows.map((r) => JSON.parse(r));
      assert.strictEqual(first.type, 'attached'); // appended first
      assert.strictEqual(second.type, 'ended');   // appended second
    });

    it('creates the directory and file when they do not yet exist (ensure() path)', () => {
      // Wipe both the file and the .yatfa-warden dir; appendEvent must recreate them.
      fs.rmSync(wdir, { recursive: true, force: true });
      assert.ok(!fs.existsSync(wdir), 'precondition: dir is gone');
      appendEvent({ type: 'attached', container: 'c1' });
      assert.ok(fs.existsSync(activityPath), 'ensure() recreated the dir and file');
      const rows = fs.readFileSync(activityPath, 'utf8').trim().split('\n');
      assert.strictEqual(rows.length, 1);
    });
  });

  // ------------------------------------------------- readEvents -----------
  describe('readEvents', () => {
    it('returns events newest-first (descending by timestamp)', async () => {
      const now = Date.now();
      seed([
        line('attached', now - 50_000),
        line('attached', now - 10_000),
        line('attached', now - 30_000),
      ]);
      const ev = await readEvents();
      assert.deepStrictEqual(
        ev.map((e) => e.timestamp),
        [
          new Date(now - 10_000).toISOString(),
          new Date(now - 30_000).toISOString(),
          new Date(now - 50_000).toISOString(),
        ],
      );
    });

    it('keeps events at exactly ts === after and ts === before (inclusive range)', async () => {
      const now = Date.now();
      seed([
        line('attached', now - 10_000), // below the window → excluded
        line('attached', now),           // === after → kept
        line('attached', now + 10_000),  // === before → kept
        line('attached', now + 20_000),  // above the window → excluded
      ]);
      const ev = await readEvents({ after: now, before: now + 10_000 });
      assert.strictEqual(ev.length, 2);
      assert.deepStrictEqual(
        ev.map((e) => new Date(e.timestamp).getTime()).sort((a, b) => a - b),
        [now, now + 10_000],
      );
    });

    it('returns only the newest N when limit is set (sort is desc, then slice)', async () => {
      const now = Date.now();
      seed([10_000, 20_000, 30_000, 40_000, 50_000].map((d) => line('attached', now - d)));
      const ev = await readEvents({ limit: 2 });
      assert.strictEqual(ev.length, 2);
      // newest two are the smallest offsets (now-10k, now-20k), returned descending
      assert.deepStrictEqual(
        ev.map((e) => new Date(e.timestamp).getTime()),
        [now - 10_000, now - 20_000],
      );
    });

    it('skips malformed JSON lines without throwing and returns the valid ones', withNoWarn(async (warned) => {
      const now = Date.now();
      seed([
        line('attached', now),
        '{ this is not valid json',
        line('error', now - 1_000, { error: 'boom' }),
        'another broken line }}}',
      ]);
      const ev = await readEvents();
      assert.strictEqual(ev.length, 2, 'two valid lines parsed; two malformed skipped');
      assert.deepStrictEqual(ev.map((e) => e.type).sort(), ['attached', 'error']);
      assert.ok(warned.length >= 2, 'each malformed line is reported via console.warn');
    }));

    it('returns [] for an empty file (the content.trim() guard)', async () => {
      seed([]);
      assert.deepStrictEqual(await readEvents(), []);
    });

    it('returns [] without throwing when the file is absent (the existsSync guard)', async () => {
      fs.rmSync(activityPath, { force: true });
      assert.deepStrictEqual(await readEvents(), []);
    });
  });

  // ------------------------------------------------- rotateEvents ---------
  describe('rotateEvents', () => {
    // rotateEvents computes `cutoff = Date.now() - SEVEN_DAYS` LIVE at call time,
    // so we cannot seed an event at the exact cutoff from outside. Instead we place
    // events comfortably on each side of the 7-day line (±5min buffer, far larger
    // than the few ms between seeding and the rotate call), which robustly
    // exercises the `ts >= cutoff` (kept) vs `ts < cutoff` (removed) split. The
    // source's inclusive boundary (ts === cutoff is KEPT) is exercised by the
    // "just inside" row landing at now - 7d + buffer > cutoff.
    const BUFFER = 5 * 60 * 1000; // 5 min

    it('removes events older than 7d, keeps the rest, and returns the removed count', async () => {
      const now = Date.now();
      seed([
        line('attached', now - 6 * DAY),           // kept (well within 7d)
        line('attached', now - SEVEN_DAYS + BUFFER), // kept (just inside cutoff)
        line('attached', now - SEVEN_DAYS - BUFFER), // removed (just outside cutoff)
        line('attached', now - 30 * DAY),          // removed (long expired)
      ]);
      const removed = rotateEvents();
      assert.strictEqual(removed, 2);
      const remaining = await readEvents();
      assert.strictEqual(remaining.length, 2);
      assert.deepStrictEqual(
        remaining.map((e) => new Date(e.timestamp).getTime()).sort((a, b) => a - b),
        [now - SEVEN_DAYS + BUFFER, now - 6 * DAY],
      );
    });

    it('KEEPS malformed lines (never silently drops un-parseable rows)', withNoWarn(async () => {
      const now = Date.now();
      seed([
        line('attached', now - DAY),       // valid + recent → kept
        '{ malformed-but-recent',          // un-parseable → catch → KEPT (not counted as removed)
        line('attached', now - 30 * DAY),  // valid + expired → removed
      ]);
      const removed = rotateEvents();
      assert.strictEqual(removed, 1, 'only the expired valid line counts as removed');
      const content = fs.readFileSync(activityPath, 'utf8');
      assert.ok(
        content.includes('{ malformed-but-recent'),
        'the malformed line survives rotation in the rewritten file',
      );
      assert.strictEqual((await readEvents()).length, 1, 'the one valid recent event reads back');
    }));

    it('rewrites the file so a subsequent readEvents() returns only kept events', async () => {
      const now = Date.now();
      seed([
        line('attached', now - DAY),
        line('attached', now - 30 * DAY),
      ]);
      rotateEvents();
      const ev = await readEvents();
      assert.strictEqual(ev.length, 1);
      assert.strictEqual(new Date(ev[0].timestamp).getTime(), now - DAY);
    });

    it('is idempotent — a second call removes nothing', async () => {
      const now = Date.now();
      seed([
        line('attached', now - DAY),
        line('attached', now - 30 * DAY),
      ]);
      assert.strictEqual(rotateEvents(), 1);
      assert.strictEqual(rotateEvents(), 0);
      assert.strictEqual((await readEvents()).length, 1);
    });

    it('returns 0 and does not throw for an empty file', () => {
      seed([]);
      assert.strictEqual(rotateEvents(), 0);
    });

    it('returns 0 and does not throw when the file is absent', () => {
      fs.rmSync(activityPath, { force: true });
      assert.strictEqual(rotateEvents(), 0);
    });
  });

  // ------------------------------------------------- getStatsSince --------
  describe('getStatsSince', () => {
    it('counts exactly the 6 known types and returns the full 7-key tally', async () => {
      const now = Date.now();
      seed([
        line('directive_proposed', now),
        line('directive_sent', now),
        line('directive_rejected', now),
        line('attached', now),
        line('ended', now),
        line('error', now),
      ]);
      assert.deepStrictEqual(await getStatsSince(0), {
        total: 6,
        directive_proposed: 1,
        directive_sent: 1,
        directive_rejected: 1,
        attached: 1,
        ended: 1,
        error: 1,
      });
    });

    it('counts an unknown type toward total but NOT toward any typed counter', async () => {
      // `total` is `events.length`; typed counters only advance when
      // `stats.hasOwnProperty(type)` is true. An unknown type widens the gap
      // between total and sum-of-typed — the bug magnet for a wrong rollup.
      const now = Date.now();
      seed([
        line('agent_session_down', now), // unknown to getStatsSince's typed set
        line('host_ok', now),            // likewise unknown
        line('attached', now),           // known
      ]);
      const stats = await getStatsSince(0);
      assert.strictEqual(stats.total, 3, 'every event counts toward total');
      assert.strictEqual(stats.attached, 1);
      const typedSum = stats.directive_proposed + stats.directive_sent +
        stats.directive_rejected + stats.attached + stats.ended + stats.error;
      assert.strictEqual(typedSum, 1, 'unknown types advance no typed counter');
      assert.ok(typedSum < stats.total, 'total exceeds sum-of-typed when unknown types are present');
    });

    it('respects the `after` filter (an event before `after` is excluded from total AND its counter)', async () => {
      const now = Date.now();
      seed([
        line('attached', now - 10_000), // before the window
        line('attached', now),           // === after → included
        line('error', now - 5_000),     // before the window
      ]);
      const stats = await getStatsSince(now);
      assert.strictEqual(stats.total, 1);
      assert.strictEqual(stats.attached, 1);
      assert.strictEqual(stats.error, 0);
    });

    it('excludes state_changed (the state-timeline marker) from total (WARDEN-788)', async () => {
      // Regression for the WARDEN-788 fail_qa: state_changed is an internal
      // transition marker for the Fleet state timeline, not activity — it must
      // NOT inflate /api/activity/stats's `total` (which feeds the attention
      // rollup). Without the NON_ACTIVITY_TYPES filter the two state_changed
      // events below would make total = 4; in production the from:null baseline
      // fires for every agent on every warden restart, so the whole fleet would
      // get a spurious volume blip at each restart.
      const now = Date.now();
      seed([
        line('attached', now),
        line('error', now, { error: 'boom' }),
        line('state_changed', now, { container: 'c1', from: null, to: 'active' }),
        line('state_changed', now, { container: 'c1', from: 'active', to: 'stuck' }),
      ]);
      const stats = await getStatsSince(0);
      assert.strictEqual(stats.total, 2, 'only the two activity events count; state_changed excluded');
      assert.strictEqual(stats.attached, 1);
      assert.strictEqual(stats.error, 1);
    });

    it('returns the correct 7-key, all-zero shape for an empty window', async () => {
      seed([]);
      const stats = await getStatsSince(0);
      assert.deepStrictEqual(Object.keys(stats).sort(), [
        'attached', 'directive_proposed', 'directive_rejected',
        'directive_sent', 'ended', 'error', 'total',
      ]);
      assert.strictEqual(stats.total, 0);
      for (const k of Object.keys(stats)) {
        if (k !== 'total') assert.strictEqual(stats[k], 0, `${k} defaults to 0`);
      }
    });
  });
});
