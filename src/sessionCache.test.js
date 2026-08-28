import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createSessionCache, completeSessionRows, SESSION_CACHE_MAX_AGE_MS } from './sessionCache.js';

/**
 * The cross-host session-list owner — WARDEN-1208.
 *
 * These tests exercise the REAL owner (src/sessionCache.js). Nothing here
 * re-implements its logic: every assertion runs against the actual factory, so
 * inverting a branch or dropping the limit check FAILS the suite rather than
 * quietly agreeing with a local copy of the same code.
 *
 * NO SSH AND NO FAKE TIMERS. The factory takes `{ now, fetchLocal, fetchRemote }`,
 * so the clock is a counter we advance by hand and both fetchers are plain
 * call-counting fakes. That injection seam is deliberate: mocking at the module
 * boundary would need node:test's `mock.module`, which is unavailable on this
 * repo's Node 20 runtime (the same constraint documented in
 * src/server-hosts-status.test.js and src/chatCatalog.test.js).
 *
 * What the owner replaced, and therefore what these tests pin:
 *   - TWO independent full-fleet fan-outs over the SAME rows — one on the
 *     `/api/claude-sessions-all` request path, one in `tickBudget` every 120s —
 *     with no dedup between them, so a page load landing near a sweep paid for a
 *     second enumeration of every host;
 *   - a route that could not answer until the LAST host settled, so one
 *     unreachable machine withheld every healthy host's rows for its full 15s
 *     SSH timeout;
 *   - no freshness stamp and no in-flight state anywhere on the path.
 */

// ---- fixtures ---------------------------------------------------------------

const LOCAL = '(local)';

/** A session row, shaped as localClaudeSessions / parseRemoteSessionOutput build
 *  them. `mtime` descends with index so a slice(0, n) is "the newest n", which is
 *  the ordering the real fetchers guarantee and the slice-down path relies on. */
const row = (id, i) => ({ id, cwd: `/w/${id}`, summary: '', mtime: 10_000 - i, tokenUsage: null });

/** `n` rows for one host, newest first. */
const rows = (host, n) => Array.from({ length: n }, (_, i) => row(`${host}-s${i}`, i));

/**
 * A remote fetcher fake. Records every call as `[host, limit]` so a test can
 * assert HOW MANY enumerations happened per host — the central claim of this
 * slice — and with what window.
 *
 * `byHost` maps a host to its row count, or to the string 'unreachable' (the
 * transport-failure shape the real `remoteClaudeSessionsDetail` returns), or to
 * 'throw' (a fetcher that rejects, which the real one never does but a
 * caller-supplied one might).
 *
 * `gate` optionally holds a host's fetch open until the test releases it, which
 * is how the concurrency and settle-window behaviours are driven WITHOUT timers.
 */
function fakeRemote(byHost, { gate } = {}) {
  const calls = [];
  const fn = async (host, limit) => {
    calls.push([host, limit]);
    if (gate && gate.has(host)) await gate.get(host);
    const spec = byHost[host];
    if (spec === 'throw') throw new Error(`boom: ${host}`);
    if (spec === 'unreachable') return { sessions: [], unreachable: true };
    // SLICED TO `limit`, because that is what the real fetchers do
    // (`parseRemoteSessionOutput` ends in `out.slice(0, limit)`). A fake that
    // returned every row regardless would hand the cache a slot secretly larger
    // than the window it was filled at, and the limit-awareness tests would pass
    // for the wrong reason.
    return { sessions: rows(host, spec ?? 0).slice(0, limit), unreachable: false };
  };
  fn.calls = calls;
  fn.countFor = (h) => calls.filter((c) => c[0] === h).length;
  fn.limitsFor = (h) => calls.filter((c) => c[0] === h).map((c) => c[1]);
  return fn;
}

/** A local fetcher fake. Returns a BARE ARRAY — the real localClaudeSessions'
 *  contract — so the cache's own local-leg wrapping is what is under test. */
function fakeLocal(n) {
  const calls = [];
  const fn = async (limit) => {
    calls.push(limit);
    return rows(LOCAL, typeof n === 'function' ? n() : n).slice(0, limit);
  };
  fn.calls = calls;
  return fn;
}

/** A manually-released promise, so concurrency is driven by control flow rather
 *  than by wall-clock sleeps. */
function openGate() {
  let release;
  const promise = new Promise((r) => { release = r; });
  return { promise, release };
}

/** Build a cache with a hand-advanced clock. Returns the cache plus a `tick`. */
function makeCache(opts = {}) {
  const clock = { t: 0 };
  const cache = createSessionCache({
    now: () => clock.t,
    local: LOCAL,
    ...opts,
  });
  return { cache, clock, tick: (ms) => { clock.t += ms; } };
}

const byHost = (snap) => Object.fromEntries(snap.map((s) => [s.host, s]));

// ---- tests ------------------------------------------------------------------

describe('createSessionCache — the cross-host session-list owner (WARDEN-1208)', () => {
  describe('in-flight dedup (criterion 2 — the duplicate cost this slice removes)', () => {
    it('two CONCURRENT full-fleet reads enumerate each host exactly ONCE', async () => {
      // THE load-bearing test. On origin/main the route and the budget sweep each
      // ran their own Promise.allSettled over the same hosts, so two overlapping
      // readers produced TWO enumerations per host. One owner with a per-host
      // in-flight promise makes the second reader JOIN the first.
      const gate = new Map([['h1', openGate().promise]]);
      const remote = fakeRemote({ h1: 3, h2: 2 });
      const local = fakeLocal(2);
      const { cache } = makeCache({ fetchLocal: local, fetchRemote: remote });

      const [a, b] = await Promise.all([
        cache.snapshot([LOCAL, 'h1', 'h2'], 40),
        cache.snapshot([LOCAL, 'h1', 'h2'], 40),
      ]);

      assert.strictEqual(remote.countFor('h1'), 1, 'h1 enumerated once, not once per reader');
      assert.strictEqual(remote.countFor('h2'), 1, 'h2 enumerated once, not once per reader');
      assert.strictEqual(local.calls.length, 1, 'the local archive is walked once too');
      // Both readers still get real answers — dedup must not starve the joiner.
      assert.deepStrictEqual(a.map((s) => s.host), [LOCAL, 'h1', 'h2']);
      assert.strictEqual(byHost(a).h1.sessions.length, 3);
      assert.strictEqual(byHost(b).h1.sessions.length, 3, 'the joiner is served the same rows');
      void gate;
    });

    it('the ROUTE read and the SWEEP read share one enumeration (the two-beat duplication)', async () => {
      // The concrete production shape: a user opens the session browser while the
      // 120s budget sweep is mid-flight. Before this module that cost a second
      // full-fleet SSH sweep for rows the server was already fetching.
      const remote = fakeRemote({ h1: 200 });
      const local = fakeLocal(200);
      const { cache } = makeCache({ fetchLocal: local, fetchRemote: remote });

      await Promise.all([
        cache.snapshot([LOCAL, 'h1'], 100, { wait: true }),  // the sweep
        cache.snapshot([LOCAL, 'h1'], 41),                    // a page-1 route read
      ]);

      assert.strictEqual(remote.countFor('h1'), 1,
        'the sweep and the route must not each enumerate the fleet');
      assert.strictEqual(local.calls.length, 1);
    });

    it('a SEQUENTIAL second read inside the freshness window does not re-enumerate', async () => {
      const remote = fakeRemote({ h1: 5 });
      const { cache, tick } = makeCache({ fetchLocal: fakeLocal(0), fetchRemote: remote });

      await cache.snapshot(['h1'], 40);
      tick(SESSION_CACHE_MAX_AGE_MS - 1);
      const second = await cache.snapshot(['h1'], 40);

      assert.strictEqual(remote.countFor('h1'), 1, 'served from the slot, no second ssh');
      assert.strictEqual(second[0].sessions.length, 5);
      assert.strictEqual(second[0].at, 0, 'the slot keeps its original landing stamp');
    });

    it('a slot past its freshness window IS re-enumerated', async () => {
      const remote = fakeRemote({ h1: 5 });
      const { cache, tick } = makeCache({ fetchLocal: fakeLocal(0), fetchRemote: remote });

      await cache.snapshot(['h1'], 40);
      tick(SESSION_CACHE_MAX_AGE_MS + 1);
      await cache.snapshot(['h1'], 40);

      assert.strictEqual(remote.countFor('h1'), 2, 'a stale slot refreshes');
    });
  });

  describe('criterion 3 — a slot filled at a SMALLER limit must not satisfy a LARGER read', () => {
    it('re-fetches when the caller needs more rows than the slot was filled at', async () => {
      // The pagination hazard: page 1 fills at 41, then the user pages deep and
      // needs 141. Serving the 41-row slot would silently truncate the timeline at
      // a page boundary and make `hasMore` wrong.
      const remote = fakeRemote({ h1: 300 });
      const { cache } = makeCache({ fetchLocal: fakeLocal(0), fetchRemote: remote });

      await cache.snapshot(['h1'], 41);
      const deep = await cache.snapshot(['h1'], 141);

      assert.deepStrictEqual(remote.limitsFor('h1'), [41, 141],
        'the larger read refreshes at ITS window, not the slot\'s');
      assert.strictEqual(deep[0].sessions.length, 141);
      assert.strictEqual(deep[0].pending, false, 'and it is a complete answer');
    });

    it('serves a LARGER slot to a smaller read by slicing down — no fetch', async () => {
      // The reverse is the win: the sweep's 100-row slot answers a 41-row page-1
      // read for free. Fetching again would be the duplication this slice removes.
      const remote = fakeRemote({ h1: 300 });
      const { cache } = makeCache({ fetchLocal: fakeLocal(0), fetchRemote: remote });

      await cache.snapshot(['h1'], 100, { wait: true });
      const page1 = await cache.snapshot(['h1'], 41);

      assert.strictEqual(remote.countFor('h1'), 1, 'no second enumeration');
      assert.strictEqual(page1[0].sessions.length, 41, 'sliced down to the asked-for window');
    });

    it('slicing down keeps the NEWEST rows (the mtime-descending head)', async () => {
      const remote = fakeRemote({ h1: 50 });
      const { cache } = makeCache({ fetchLocal: fakeLocal(0), fetchRemote: remote });

      const full = await cache.snapshot(['h1'], 50, { wait: true });
      const small = await cache.snapshot(['h1'], 5);

      assert.deepStrictEqual(
        small[0].sessions.map((s) => s.id),
        full[0].sessions.slice(0, 5).map((s) => s.id),
        'a sliced answer is the head of the full one, not an arbitrary subset',
      );
    });

    it('an UNDER-FILLING in-flight join is reported pending, not served short', async () => {
      // The subtle half. A 100-row sweep arriving while a 41-row route fetch is in
      // flight must not join it and then compute the fleet budget from 41 rows —
      // that is a wrong NUMBER, not merely a slow response. It also must not launch
      // a competing second ssh child. So: no wait, and the short slot is DISCLOSED.
      const gate = openGate();
      const remote = fakeRemote({ h1: 300 }, { gate: new Map([['h1', gate.promise]]) });
      // settleMs is LARGE, not 5: the route read races the settle window, and
      // this test's completion must be driven by `gate.release()`, never by the
      // timer. With a 5ms window the route read resolves cold (`sessions: []`)
      // whenever the setImmediate + sweep snapshot below outlast 5ms of wall
      // clock — which is exactly how CI on a slower runner failed it
      // (`0 !== 41`): the route's value was frozen at the settle tick before the
      // gate ever opened. The gate makes the ordering deterministic; a settle
      // window larger than the test guarantees it can never be the winner.
      const { cache } = makeCache({ fetchLocal: fakeLocal(0), fetchRemote: remote, settleMs: 60_000 });

      const routeRead = cache.snapshot(['h1'], 41);          // launches at 41, held open
      await new Promise((r) => setImmediate(r));             // let it register in-flight
      const sweepRead = cache.snapshot(['h1'], 100, { wait: true }); // needs 100

      gate.release();
      const [route, sweep] = await Promise.all([routeRead, sweepRead]);

      assert.strictEqual(remote.countFor('h1'), 1,
        'still ONE ssh child — an under-served joiner must not stack a second');
      assert.strictEqual(route[0].sessions.length, 41);
      assert.strictEqual(route[0].pending, false, 'the launcher got exactly what it asked for');
      assert.strictEqual(sweep[0].pending, true,
        'the under-served joiner is told its answer is short, not handed a truncated list as complete');
    });
  });

  describe('criterion 2 (the false-empty hazard) — "not looked at yet" is NEVER an empty list', () => {
    it('a host whose fetch misses the settle window reports known:false + pending, not zero rows', async () => {
      // THE hazard this module is built around. An empty session list renders in
      // the client as "Nothing runnable on the selected hosts yet" — a confident
      // factual claim about the user's machines. A host we have merely not looked
      // at yet must never be merged away as zero rows (the WARDEN-89 / WARDEN-1200
      // false-empty defect two finished tickets just removed).
      const gate = openGate();
      const remote = fakeRemote({ slow: 7 }, { gate: new Map([['slow', gate.promise]]) });
      const { cache } = makeCache({ fetchLocal: fakeLocal(0), fetchRemote: remote, settleMs: 5 });

      const snap = await cache.snapshot(['slow'], 40);

      assert.strictEqual(snap[0].known, false, 'we have NOT looked at this host successfully yet');
      assert.strictEqual(snap[0].pending, true, 'and that is disclosed, not silently zero');
      assert.strictEqual(snap[0].at, null, 'a slot that never landed has no freshness stamp');
      assert.strictEqual(snap[0].unreachable, false,
        'pending is NOT unreachable — we have no evidence about this machine either way');
      gate.release();
    });

    it('distinguishes "not looked at yet" from "looked, and this host has no sessions"', async () => {
      // The distinction the whole design turns on, asserted directly: both answers
      // carry `sessions: []`, and they mean opposite things.
      const gate = openGate();
      const remote = fakeRemote({ slow: 1, empty: 0 }, { gate: new Map([['slow', gate.promise]]) });
      const { cache } = makeCache({ fetchLocal: fakeLocal(0), fetchRemote: remote, settleMs: 5 });

      const snap = byHost(await cache.snapshot(['slow', 'empty'], 40));

      assert.deepStrictEqual(snap.slow.sessions, [], 'same empty array …');
      assert.deepStrictEqual(snap.empty.sessions, [], '… on both hosts');
      assert.strictEqual(snap.slow.known, false, 'but this one we have not read');
      assert.strictEqual(snap.empty.known, true, 'and this one we HAVE read — it is genuinely empty');
      assert.strictEqual(snap.empty.pending, false,
        'a real empty answer is not pending; it is the answer');
      gate.release();
    });

    it('a pending host FILLS IN on a later read (it resolves itself)', async () => {
      const gate = openGate();
      const remote = fakeRemote({ slow: 4 }, { gate: new Map([['slow', gate.promise]]) });
      const { cache } = makeCache({ fetchLocal: fakeLocal(0), fetchRemote: remote, settleMs: 5 });

      const first = await cache.snapshot(['slow'], 40);
      assert.strictEqual(first[0].known, false);

      gate.release();
      await new Promise((r) => setImmediate(r));
      const second = await cache.snapshot(['slow'], 40);

      assert.strictEqual(second[0].known, true, 'the slot the first read scheduled has landed');
      assert.strictEqual(second[0].sessions.length, 4);
      assert.strictEqual(remote.countFor('slow'), 1, 'and it took ONE enumeration in total');
    });
  });

  describe('criterion 4 — one slow host must not withhold the others rows', () => {
    it('healthy hosts are returned in full while a slow host is still fetching', async () => {
      // The defect in one assertion: on origin/main this read could not answer
      // until the LAST host settled, so `slow` would have held h1/h2/(local)
      // hostage for its full 15s SSH timeout.
      const gate = openGate();
      const remote = fakeRemote({ h1: 3, h2: 4, slow: 9 }, { gate: new Map([['slow', gate.promise]]) });
      const { cache } = makeCache({ fetchLocal: fakeLocal(2), fetchRemote: remote, settleMs: 5 });

      const snap = byHost(await cache.snapshot([LOCAL, 'h1', 'h2', 'slow'], 40));

      assert.strictEqual(snap.h1.sessions.length, 3, 'h1 answered and is delivered');
      assert.strictEqual(snap.h2.sessions.length, 4, 'h2 answered and is delivered');
      assert.strictEqual(snap[LOCAL].sessions.length, 2, 'the local archive too');
      assert.strictEqual(snap.slow.pending, true, 'only the slow host is missing, and it says so');
      gate.release();
    });

    it('a permanently-slow host does NOT charge its settle window to every later read', async () => {
      // Constraint 4, the launcher-only discipline copied from createHostStatusCache.
      // A host with a fetch in flight at nearly every read would otherwise make every
      // request pay the settle window forever — the same "one bad host taxes the whole
      // response" shape this cache exists to remove, just smaller.
      const gate = openGate();
      const remote = fakeRemote({ wedged: 1 }, { gate: new Map([['wedged', gate.promise]]) });
      const { cache } = makeCache({ fetchLocal: fakeLocal(0), fetchRemote: remote, settleMs: 50 });

      await cache.snapshot(['wedged'], 40);   // the LAUNCHER — pays the window
      const t0 = Date.now();
      await cache.snapshot(['wedged'], 40);   // a JOINER — must not pay it again
      const joinerMs = Date.now() - t0;

      assert.ok(joinerMs < 40,
        `a joiner must not re-spend the settle window (took ${joinerMs}ms of a 50ms window)`);
      assert.strictEqual(remote.countFor('wedged'), 1, 'and it did not stack a second fetch');
      gate.release();
    });

    it('the settle window is SHARED, not per-host — response cost is O(1) in fleet size', async () => {
      // What makes adding hosts safe: five cold slow hosts cost ONE window, not five.
      const g = openGate();
      const hosts = ['s1', 's2', 's3', 's4', 's5'];
      const gate = new Map(hosts.map((h) => [h, g.promise]));
      const remote = fakeRemote(Object.fromEntries(hosts.map((h) => [h, 1])), { gate });
      const { cache } = makeCache({ fetchLocal: fakeLocal(0), fetchRemote: remote, settleMs: 40 });

      const t0 = Date.now();
      await cache.snapshot(hosts, 40);
      const ms = Date.now() - t0;

      assert.ok(ms < 40 * 2, `five cold hosts must cost ONE settle window, not five (took ${ms}ms)`);
      assert.strictEqual(remote.calls.length, 5, 'all five were still scheduled concurrently');
      g.release();
    });
  });

  describe('the unreachable discriminator is TRANSPORTED, never re-classified (WARDEN-1200)', () => {
    it('carries unreachable:true through from the detail fetcher', async () => {
      const remote = fakeRemote({ dead: 'unreachable', h1: 2 });
      const { cache } = makeCache({ fetchLocal: fakeLocal(1), fetchRemote: remote });

      const snap = byHost(await cache.snapshot([LOCAL, 'h1', 'dead'], 40));

      assert.strictEqual(snap.dead.unreachable, true, 'the flag the route derives unreachableHosts from');
      assert.strictEqual(snap.dead.known, true,
        'we DID look — an unreachable host is a real answer, not a pending one');
      assert.strictEqual(snap.dead.pending, false);
      assert.strictEqual(snap.h1.unreachable, false, 'a reachable host is not tainted by its neighbour');
    });

    it('an unreachable host still does not withhold the reachable hosts rows', async () => {
      const remote = fakeRemote({ dead: 'unreachable', h1: 3 });
      const { cache } = makeCache({ fetchLocal: fakeLocal(2), fetchRemote: remote });

      const snap = byHost(await cache.snapshot([LOCAL, 'h1', 'dead'], 40));

      assert.strictEqual(snap.h1.sessions.length, 3);
      assert.strictEqual(snap[LOCAL].sessions.length, 2);
      assert.deepStrictEqual(snap.dead.sessions, [], 'and it contributes no invented rows');
    });

    it('the LOCAL host can never be reported unreachable — a filesystem read has no transport', async () => {
      // Scope guard inherited from WARDEN-1196/1200, asserted rather than assumed
      // because this module builds ONE slot shape over both legs and a careless
      // refactor could apply the remote classifier to both.
      const { cache } = makeCache({ fetchLocal: fakeLocal(3), fetchRemote: fakeRemote({}) });

      const snap = await cache.snapshot([LOCAL], 40);

      assert.strictEqual(snap[0].unreachable, false);
    });
  });

  describe('the LOCAL leg is never served stale (it has no round-trip to save)', () => {
    it('re-reads the local archive on every snapshot, so a new transcript is visible at once', async () => {
      // Staleness is a latency trade, and there is no latency to trade on a
      // filesystem read: serving a cached local slot would only ever hide a
      // transcript written a moment ago.
      let count = 2;
      const local = fakeLocal(() => count);
      const { cache } = makeCache({ fetchLocal: local, fetchRemote: fakeRemote({}) });

      const first = await cache.snapshot([LOCAL], 40);
      count = 5;                                   // a new session lands on disk
      const second = await cache.snapshot([LOCAL], 40);

      assert.strictEqual(first[0].sessions.length, 2);
      assert.strictEqual(second[0].sessions.length, 5, 'the local leg sees the new transcript immediately');
      assert.strictEqual(local.calls.length, 2);
    });

    it('the local read is AWAITED, so it is never reported pending', async () => {
      // Unbounded by the settle window on purpose: an fs read cannot hang on a
      // network, so bounding it would only risk a false "not looked at yet".
      const local = fakeLocal(3);
      const { cache } = makeCache({ fetchLocal: local, fetchRemote: fakeRemote({}), settleMs: 1 });

      const snap = await cache.snapshot([LOCAL], 40);

      assert.strictEqual(snap[0].known, true);
      assert.strictEqual(snap[0].pending, false);
      assert.strictEqual(snap[0].sessions.length, 3);
    });

    it('concurrent local reads STILL dedup — the archive is walked once', async () => {
      // Always-refresh must not mean always-duplicate: the in-flight join is what
      // keeps the sweep and a page load from both walking the archive.
      const local = fakeLocal(4);
      const { cache } = makeCache({ fetchLocal: local, fetchRemote: fakeRemote({}) });

      await Promise.all([cache.snapshot([LOCAL], 40), cache.snapshot([LOCAL], 40)]);

      assert.strictEqual(local.calls.length, 1);
    });
  });

  describe('failure never blanks a host, and never rejects a read', () => {
    it('a rejecting fetcher leaves the LAST KNOWN slot in place', async () => {
      // Same rule as createHostStatusCache's probe and chatCatalog's discover: a
      // failed refresh degrades freshness, never data.
      const spec = { h1: 3 };
      const remote = async (host, limit) => {
        if (spec[host] === 'throw') throw new Error('boom');
        return { sessions: rows(host, spec[host]).slice(0, limit), unreachable: false };
      };
      const { cache, tick } = makeCache({ fetchLocal: fakeLocal(0), fetchRemote: remote });

      const first = await cache.snapshot(['h1'], 40);
      assert.strictEqual(first[0].sessions.length, 3);

      spec.h1 = 'throw';
      tick(SESSION_CACHE_MAX_AGE_MS + 1);
      const second = await cache.snapshot(['h1'], 40);

      assert.strictEqual(second[0].sessions.length, 3, 'the previous rows survive a failed refresh');
      assert.strictEqual(second[0].known, true);
    });

    it('a host that has NEVER landed stays cold after a failure — reported, not faked empty', async () => {
      const remote = fakeRemote({ bad: 'throw' });
      const { cache } = makeCache({ fetchLocal: fakeLocal(0), fetchRemote: remote });

      const snap = await cache.snapshot(['bad'], 40);

      assert.strictEqual(snap[0].known, false, 'we still have not looked successfully');
      assert.strictEqual(snap[0].pending, true);
    });

    it('a failed fetch RELEASES its in-flight slot so a later read can retry', async () => {
      const remote = fakeRemote({ bad: 'throw' });
      const { cache } = makeCache({ fetchLocal: fakeLocal(0), fetchRemote: remote });

      await cache.snapshot(['bad'], 40);
      await cache.snapshot(['bad'], 40);

      assert.strictEqual(remote.countFor('bad'), 2, 'a wedged in-flight entry would block retries forever');
    });

    it('snapshot never rejects, even when every host fails', async () => {
      const remote = fakeRemote({ a: 'throw', b: 'throw' });
      const { cache } = makeCache({ fetchLocal: async () => { throw new Error('fs'); }, fetchRemote: remote });

      const snap = await cache.snapshot([LOCAL, 'a', 'b'], 40);

      assert.strictEqual(snap.length, 3, 'every requested host still gets a row');
      assert.ok(snap.every((s) => s.pending === true && s.sessions.length === 0));
    });
  });

  describe('shape and reconciliation', () => {
    it('returns one row per requested host, IN ORDER', async () => {
      const remote = fakeRemote({ h1: 1, h2: 1 });
      const { cache } = makeCache({ fetchLocal: fakeLocal(1), fetchRemote: remote });

      const snap = await cache.snapshot([LOCAL, 'h1', 'h2'], 40);

      assert.deepStrictEqual(snap.map((s) => s.host), [LOCAL, 'h1', 'h2'],
        'the route maps these straight into buckets, so order and arity are contractual');
    });

    it('drops a host that is no longer configured (the reconcile step)', async () => {
      const remote = fakeRemote({ h1: 2, h2: 2 });
      const { cache } = makeCache({ fetchLocal: fakeLocal(0), fetchRemote: remote });

      await cache.snapshot(['h1', 'h2'], 40);
      await cache.snapshot(['h1'], 40);              // h2 removed from config

      assert.strictEqual(cache.hostState('h2').known, false,
        'removing a host from config.json must not leave its sessions behind forever');
      assert.strictEqual(cache.hostState('h1').known, true);
    });

    it('an EMPTY answer keeps its slot — it is not downgraded to "never looked"', async () => {
      // The chatCatalog lesson: a refresh finding nothing must not delete the slot,
      // or the next read would call a known-empty host "not looked at yet".
      const remote = fakeRemote({ empty: 0 });
      const { cache, tick } = makeCache({ fetchLocal: fakeLocal(0), fetchRemote: remote });

      await cache.snapshot(['empty'], 40);
      tick(SESSION_CACHE_MAX_AGE_MS + 1);
      await cache.snapshot(['empty'], 40);

      assert.strictEqual(cache.hostState('empty').known, true);
    });

    it('hostState reports what we know WITHOUT looking (zero fetches)', async () => {
      const remote = fakeRemote({ h1: 2 });
      const { cache } = makeCache({ fetchLocal: fakeLocal(0), fetchRemote: remote });

      const cold = cache.hostState('h1');
      assert.deepStrictEqual(
        { known: cold.known, checking: cold.checking, at: cold.at, limit: cold.limit },
        { known: false, checking: false, at: null, limit: null },
      );
      assert.strictEqual(remote.calls.length, 0, 'a pure read must never trigger ssh');

      await cache.snapshot(['h1'], 40);
      const warm = cache.hostState('h1');
      assert.strictEqual(warm.known, true);
      assert.strictEqual(warm.limit, 40, 'the slot remembers the window it was filled at');
      assert.strictEqual(warm.at, 0);
    });

    it('requires both fetchers — a cache with no way to fetch is a programming error', async () => {
      assert.throws(() => createSessionCache(), TypeError);
      assert.throws(() => createSessionCache({ fetchLocal: async () => [] }), TypeError);
    });
  });

  describe('the SWEEP mode (wait:true) — complete rows for the budget math', () => {
    it('awaits every host with NO settle bound, so slow rows are not silently dropped', async () => {
      // The budget is a NUMBER. A settle-bounded sweep would compute fleet spend
      // from whichever hosts happened to be fast, under-counting silently — worse
      // than being slow, since nobody is waiting on this beat anyway.
      const gate = openGate();
      const remote = fakeRemote({ slow: 6 }, { gate: new Map([['slow', gate.promise]]) });
      const { cache } = makeCache({ fetchLocal: fakeLocal(2), fetchRemote: remote, settleMs: 1 });

      setTimeout(() => gate.release(), 15);
      const snap = byHost(await cache.snapshot([LOCAL, 'slow'], 100, { wait: true }));

      assert.strictEqual(snap.slow.sessions.length, 6, 'the sweep waited for the slow host');
      assert.strictEqual(snap.slow.pending, false, 'and got a complete answer');
    });

    it('projects to the bare rows the sweep consumes, with the flags available but unused', async () => {
      // The sweep maps rows and never reads `unreachable` — the frozen-contract
      // boundary. This asserts the row shape it relies on, through the REAL
      // projection the sweep calls (`completeSessionRows`), not a local copy of it.
      const remote = fakeRemote({ h1: 2, dead: 'unreachable' });
      const { cache } = makeCache({ fetchLocal: fakeLocal(1), fetchRemote: remote });

      const snap = await cache.snapshot([LOCAL, 'h1', 'dead'], 100, { wait: true });
      const flat = completeSessionRows(snap);

      assert.strictEqual(flat.length, 3, 'local 1 + h1 2 + dead 0 — an unreachable host contributes nothing');
      assert.ok(flat.every((s) => typeof s.id === 'string' && typeof s.mtime === 'number'),
        'computeBudgetState reads mtime + tokenUsage off these rows');
      assert.ok(flat.every((s) => s.host), 'every row carries its host tag');
    });

    it('a sweep does not serve itself from its OWN previous tick', async () => {
      // The freshness window must stay well below the 120s sweep cadence, or the
      // budget would be computed from rows two minutes old on every other tick.
      const remote = fakeRemote({ h1: 3 });
      const { cache, tick } = makeCache({ fetchLocal: fakeLocal(0), fetchRemote: remote });

      await cache.snapshot(['h1'], 100, { wait: true });
      tick(120_000);                                   // BUDGET_INTERVAL_MS
      await cache.snapshot(['h1'], 100, { wait: true });

      assert.strictEqual(remote.countFor('h1'), 2, 'each sweep re-reads the fleet');
      assert.ok(SESSION_CACHE_MAX_AGE_MS < 120_000,
        'the freshness window must stay below the sweep cadence for the above to hold');
    });
  });

  describe('completeSessionRows — a PENDING host contributes no rows to the budget math', () => {
    // The consumer half of constraint 3, and the defect this projection exists to
    // prevent. `snapshot` already discloses an under-filled slot as `pending`, but
    // disclosure only helps if the consumer that cannot afford to ignore it reads
    // it. The route deliberately KEEPS pending rows (it renders a list and
    // discloses `pendingHosts` alongside); the sweep must DROP them, because it
    // computes a NUMBER that gets cached for 120s and `computeBudgetState` cannot
    // tell a truncated list from a complete one.

    it('drops the rows of a sweep that JOINED a smaller in-flight route fetch', async () => {
      // THE regression case, in its production shape: a slot holding REAL BUT
      // TRUNCATED rows.
      //
      // ⚠ FIXTURE NOTE — the obvious way to write this test PASSES FOR THE WRONG
      // REASON, and a mutation run caught it here. Gating the very FIRST fetch and
      // racing a sweep against it does produce `pending: true`, but the slot is
      // then COLD, so the host contributes zero rows whether the projection
      // filters or not — deleting the `.filter()` from `completeSessionRows` left
      // that version of this test green. The defect only bites when the slot
      // EXISTS and is SHORT, so the fixture below builds exactly that: fill at 41,
      // let it go stale, hold the REFRESH open, then have the sweep arrive.
      let calls = 0;
      const gate = openGate();
      // Only the SECOND fetch is held open — the first must land to fill the slot.
      const fetchRemote = async (host, limit) => {
        calls += 1;
        if (calls > 1) await gate.promise;
        return { sessions: rows(host, 300).slice(0, limit), unreachable: false };
      };
      const { cache, tick } = makeCache({ fetchLocal: fakeLocal(0), fetchRemote, settleMs: 5 });

      // 1. A page-1 route read lands, filling h1's slot at 41.
      const warm = await cache.snapshot(['h1'], 41);
      assert.strictEqual(warm[0].sessions.length, 41);

      // 2. The slot goes stale, so the next read refreshes rather than serving it.
      tick(SESSION_CACHE_MAX_AGE_MS + 1);

      // 3. Another page-1 route read launches that refresh at 41 — held open.
      const routeRead = cache.snapshot(['h1'], 41);
      await new Promise((r) => setImmediate(r));

      // 4. The 120s tick fires needing 100. It JOINS the in-flight 41 fetch, so it
      //    may not wait on it (the join cannot satisfy it) and must not stack a
      //    second ssh child — leaving it holding the previous REAL 41-row slot.
      const sweep = await cache.snapshot(['h1'], 100, { wait: true });

      // The cost this cache exists to remove must NOT come back as the price of
      // the fix: excluding the host is a projection choice, never a re-fetch.
      assert.strictEqual(calls, 2, 'still no extra ssh child — the fix must not reintroduce an enumeration');

      assert.strictEqual(sweep[0].pending, true, 'precondition: the sweep is under-served');
      assert.strictEqual(sweep[0].sessions.length, 41,
        'precondition (the wrong-reason guard): the slot holds REAL rows, it is not merely cold');

      // Rows are mtime-DESCENDING, so feeding those 41 to computeBudgetState would
      // silently drop the spend of every window-active session past the 41st — and
      // cache that wrong number for the next 120s.
      assert.deepStrictEqual(completeSessionRows(sweep), [],
        'a truncated host contributes NO rows — "no spend from it this tick", not under-counted spend');

      gate.release();
      // The route read, by contrast, KEEPS its rows: it got the window it asked
      // for, and it renders a list rather than computing a number.
      const route = await routeRead;
      assert.strictEqual(route[0].pending, false);
      assert.strictEqual(completeSessionRows(route).length, 41);
    });

    it('drops a COLD host, and never confuses it with a host that has no sessions', async () => {
      // `known: false` (never looked) and `known: true, sessions: []` (looked, empty)
      // are different facts. Both contribute zero rows to the budget — but only the
      // second is a claim about the machine.
      const gate = openGate();
      const remote = fakeRemote({ cold: 5, empty: 0 }, { gate: new Map([['cold', gate.promise]]) });
      const { cache } = makeCache({ fetchLocal: fakeLocal(0), fetchRemote: remote, settleMs: 1 });

      const first = cache.snapshot(['cold', 'empty'], 100);
      await new Promise((r) => setImmediate(r));
      const joiner = byHost(await cache.snapshot(['cold', 'empty'], 100));

      assert.strictEqual(joiner.cold.known, false, 'cold: we have not looked yet');
      assert.strictEqual(joiner.empty.known, true, 'empty: we looked');
      assert.deepStrictEqual(completeSessionRows([joiner.cold, joiner.empty]), [],
        'neither contributes spend, for two different reasons');

      gate.release();
      await first;
    });

    it('keeps every row of a COMPLETE sweep — the projection filters, it does not truncate', async () => {
      // The other half: the guard must not cost the sweep rows it legitimately has.
      const remote = fakeRemote({ h1: 4, dead: 'unreachable' });
      const { cache } = makeCache({ fetchLocal: fakeLocal(2), fetchRemote: remote });

      const snap = await cache.snapshot([LOCAL, 'h1', 'dead'], 100, { wait: true });

      assert.ok(snap.every((s) => !s.pending), 'precondition: an awaited sweep is complete');
      assert.strictEqual(completeSessionRows(snap).length, 6,
        'local 2 + h1 4; the unreachable host was already contributing nothing');
    });
  });
});
