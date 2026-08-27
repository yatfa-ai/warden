import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createChatCatalogCache } from './chatCatalog.js';

/**
 * The in-memory chat catalogue owner — WARDEN-1206.
 *
 * These tests exercise the REAL owner (src/chatCatalog.js). Nothing here
 * re-implements its logic: every assertion runs against the actual factory, so
 * inverting a branch or dropping the carry-forward FAILS the suite rather than
 * quietly agreeing with a local copy of the same code.
 *
 * NO SSH AND NO FAKE TIMERS. The factory takes `{ now, discover, catalog }`, so
 * the clock is a counter we advance by hand and the two network-ish
 * dependencies are plain fakes that count their calls. That injection seam is
 * deliberate: mocking at the module boundary would need node:test's
 * `mock.module`, which is unavailable on this repo's Node 20 runtime (the same
 * constraint documented in src/server-hosts-status.test.js).
 *
 * What the owner replaced, and therefore what these tests pin:
 *   - a bare `let cache = []` in server.js, rewritten wholesale at six sites;
 *   - a free `retainLastActivity(cache, next)` helper each of those sites had to
 *     remember to call by hand (WARDEN-245's carry-forward);
 *   - no freshness stamp, and no in-flight dedup at all — so two panes resolving
 *     bare names concurrently each started their own full-fleet SSH sweep.
 */

// ---- fixtures ---------------------------------------------------------------

/** A disk-catalog chat (kind:'tmux'), shaped as src/chats.js toCatalogChat builds it. */
const tmuxChat = (host, session, extra = {}) => ({
  id: `${host}:${session}`, key: session, kind: 'tmux',
  host, container: null, session,
  project: host === '(local)' ? 'local' : 'manual', role: 'claude',
  name: session, cwd: `/w/${session}`, cmd: null,
  active: null, status: 'unknown', lastActivity: null,
  ...extra,
});

/** A lazily-discovered yatfa chat. These exist ONLY in this cache — they have no
 *  catalog entry, which is precisely why a naive whole-replace loses them. */
const yatfaChat = (host, container, extra = {}) => ({
  id: `${host}:${container}`, key: container, kind: 'yatfa',
  host, container, session: container,
  project: 'yatfa', role: 'worker',
  name: container, cwd: `/w/${container}`, cmd: null,
  active: true, status: 'running', lastActivity: null,
  ...extra,
});

/** A discover fake that counts calls per host and resolves with fixed chats. */
function fakeDiscover(byHost, { delayMs = 0 } = {}) {
  const calls = [];
  const fn = async (host) => {
    calls.push(host);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const chats = byHost[host];
    if (chats === undefined) throw new Error(`unreachable: ${host}`);
    return { host, chats };
  };
  fn.calls = calls;
  fn.countFor = (h) => calls.filter((c) => c === h).length;
  return fn;
}

const fakeCatalog = (chats) => {
  const fn = async () => ({ chats: typeof chats === 'function' ? chats() : chats, errors: [] });
  return fn;
};

const ids = (chats) => chats.map((c) => c.id);

describe('createChatCatalogCache — the in-memory catalogue owner (WARDEN-1206)', () => {
  // ---- criterion 3: per-host in-flight dedup -------------------------------

  describe('in-flight refresh dedup (the concurrency cost this slice exists to remove)', () => {
    it('two SIMULTANEOUS refreshes of one host run EXACTLY ONE discover', async () => {
      // The old code had no dedup: resolve()'s bare-name branch fans out over the
      // whole fleet, so two panes resolving concurrently each started their own
      // full sweep. The second call must JOIN the first, not stack a second ssh
      // child on an already-slow host.
      const discover = fakeDiscover({ h1: [tmuxChat('h1', 'a')] }, { delayMs: 20 });
      const cache = createChatCatalogCache({ discover, catalog: fakeCatalog([]) });

      const [first, second] = await Promise.all([
        cache.refreshHost('h1', {}),
        cache.refreshHost('h1', {}),
      ]);

      assert.strictEqual(discover.countFor('h1'), 1,
        'a joiner must share the launcher\'s discover — two is the un-deduped bug this ticket fixes');
      assert.deepStrictEqual(ids(first), ['h1:a']);
      assert.deepStrictEqual(ids(second), ids(first), 'the joiner gets the same result as the launcher');
    });

    it('a refresh AFTER the previous one settled starts a NEW discover (the slot is not frozen)', async () => {
      // Dedup must be in-flight-scoped, not a cache that never refreshes again —
      // every caller here is demand-driven and means "look NOW".
      const discover = fakeDiscover({ h1: [tmuxChat('h1', 'a')] });
      const cache = createChatCatalogCache({ discover, catalog: fakeCatalog([]) });

      await cache.refreshHost('h1', {});
      await cache.refreshHost('h1', {});

      assert.strictEqual(discover.countFor('h1'), 2, 'sequential refreshes must each look');
    });

    it('dedup is PER HOST — concurrent refreshes of different hosts do not collapse', async () => {
      const discover = fakeDiscover(
        { h1: [tmuxChat('h1', 'a')], h2: [tmuxChat('h2', 'b')] }, { delayMs: 20 });
      const cache = createChatCatalogCache({ discover, catalog: fakeCatalog([]) });

      await Promise.all([cache.refreshHost('h1', {}), cache.refreshHost('h2', {})]);

      assert.strictEqual(discover.countFor('h1'), 1);
      assert.strictEqual(discover.countFor('h2'), 1);
      assert.deepStrictEqual(ids(cache.snapshot()).sort(), ['h1:a', 'h2:b']);
    });

    it('the fleet fan-out dedupes too: two concurrent refreshHosts sweeps = one discover per host', async () => {
      // This is resolve()'s bare-name branch verbatim — the measured cost in the
      // ticket: two panes resolving unresolved bare names concurrently.
      const discover = fakeDiscover(
        { h1: [tmuxChat('h1', 'a')], h2: [tmuxChat('h2', 'b')] }, { delayMs: 20 });
      const cache = createChatCatalogCache({ discover, catalog: fakeCatalog([]) });

      await Promise.all([
        cache.refreshHosts(['h1', 'h2'], {}),
        cache.refreshHosts(['h1', 'h2'], {}),
      ]);

      assert.strictEqual(discover.calls.length, 2,
        'two concurrent full-fleet sweeps must cost ONE discover per host, not two');
    });

    it('the in-flight slot is released after settling, including on failure', async () => {
      let attempt = 0;
      const discover = async (host) => {
        attempt += 1;
        if (attempt === 1) throw new Error('boom');
        return { host, chats: [tmuxChat(host, 'a')] };
      };
      const cache = createChatCatalogCache({ discover, catalog: fakeCatalog([]) });

      await assert.rejects(cache.refreshHost('h1', {}), /boom/,
        'the failure must still surface to ITS caller (that is /api/discover\'s 500)');
      // A leaked in-flight entry would make every later refresh join a dead promise.
      await cache.refreshHost('h1', {});
      assert.deepStrictEqual(ids(cache.snapshot()), ['h1:a'], 'a later refresh must succeed normally');
    });
  });

  // ---- criterion 4: snapshot never waits; not-looked-yet != no-chats -------

  describe('snapshot() and host freshness', () => {
    it('snapshot() returns WITHOUT awaiting any network call', async () => {
      // A discover that never settles: if snapshot() awaited anything touching it,
      // this test would hang rather than fail.
      const discover = () => new Promise(() => {});
      const cache = createChatCatalogCache({ discover, catalog: fakeCatalog([]) });

      cache.refreshHost('slow-host', {}); // deliberately NOT awaited — still in flight
      const snap = cache.snapshot();

      assert.ok(Array.isArray(snap), 'snapshot() must return synchronously usable data');
      assert.deepStrictEqual(snap, [], 'nothing has landed yet');
    });

    it('distinguishes "we have not looked yet" from "we looked and there is nothing"', async () => {
      // The createHostStatusCache `checking: true` distinction. An empty host and
      // an unprobed host are NOT the same answer: only one of them is an answer.
      const discover = fakeDiscover({ empty: [] });
      const cache = createChatCatalogCache({ discover, catalog: fakeCatalog([]) });

      const before = cache.hostState('empty');
      assert.strictEqual(before.known, false, 'unprobed host: we have not looked');
      assert.deepStrictEqual(before.chats, []);
      assert.strictEqual(before.at, null, 'never looked → no freshness stamp');

      await cache.refreshHost('empty', {});

      const after = cache.hostState('empty');
      assert.strictEqual(after.known, true, 'probed host: we looked');
      assert.deepStrictEqual(after.chats, [], '...and there is genuinely nothing there');
      assert.strictEqual(typeof after.at, 'number', 'a landed slot carries a freshness stamp');
    });

    it('reports `checking` while a discover for that host is in flight', async () => {
      let release;
      const discover = (host) => new Promise((r) => { release = () => r({ host, chats: [] }); });
      const cache = createChatCatalogCache({ discover, catalog: fakeCatalog([]) });

      const p = cache.refreshHost('h1', {});
      assert.strictEqual(cache.hostState('h1').checking, true, 'in flight → checking');
      assert.strictEqual(cache.hostState('h1').known, false, 'in flight is not yet an answer');
      release();
      await p;
      assert.strictEqual(cache.hostState('h1').checking, false, 'settled → no longer checking');
    });

    it('a per-host slot carries `at`, the local clock reading when it landed', async () => {
      let clock = 1000;
      const discover = fakeDiscover({ h1: [tmuxChat('h1', 'a')] });
      const cache = createChatCatalogCache({ now: () => clock, discover, catalog: fakeCatalog([]) });

      await cache.refreshHost('h1', {});
      assert.strictEqual(cache.hostState('h1').at, 1000);

      clock = 5000;
      await cache.refreshHost('h1', {});
      assert.strictEqual(cache.hostState('h1').at, 5000, 'a refresh re-stamps freshness');
    });

    it('one unreachable host degrades ONLY its own slot', async () => {
      // The two-host fleet shape from the ticket's live-verification criterion:
      // the healthy host must be served, the unreachable one must read
      // "not looked yet" rather than poisoning the response.
      const discover = fakeDiscover({ up: [tmuxChat('up', 'a')] }); // 'down' throws
      const cache = createChatCatalogCache({ discover, catalog: fakeCatalog([]) });

      await cache.refreshHosts(['up', 'down'], {});

      assert.deepStrictEqual(ids(cache.snapshot()), ['up:a'], 'the healthy host is delivered');
      assert.strictEqual(cache.hostState('up').known, true);
      assert.strictEqual(cache.hostState('down').known, false,
        'an unreachable host reads "not looked yet", never a false empty answer');
    });

    it('a failed refresh leaves the previous slot in place (no blanking)', async () => {
      let fail = false;
      const discover = async (host) => {
        if (fail) throw new Error('host went away');
        return { host, chats: [tmuxChat(host, 'a')] };
      };
      const cache = createChatCatalogCache({ discover, catalog: fakeCatalog([]) });

      await cache.refreshHost('h1', {});
      fail = true;
      await cache.refreshHosts(['h1'], {}); // never rejects

      assert.deepStrictEqual(ids(cache.snapshot()), ['h1:a'],
        'a transient failure must not blank a host that was working a moment ago');
    });
  });

  // ---- criterion 5: the lastActivity carry-forward, now structural ---------

  describe('lastActivity carry-forward (WARDEN-245), applied by the owner on every refresh', () => {
    it('an inactive chat KEEPS its last-known lastActivity across a refresh', async () => {
      // Activity is captured for LIVE sessions only. When the session goes
      // inactive the fresh discover yields lastActivity:null — and a wholesale
      // replace would wipe the value Fleet Health needs for recency ordering.
      let live = true;
      const discover = async (host) => ({
        host,
        chats: [tmuxChat(host, 'a', live
          ? { active: true, lastActivity: 1700 }
          : { active: false, lastActivity: null })],
      });
      const cache = createChatCatalogCache({ discover, catalog: fakeCatalog([]) });

      await cache.refreshHost('h1', {});
      assert.strictEqual(cache.snapshot()[0].lastActivity, 1700, 'captured while live');

      live = false;
      await cache.refreshHost('h1', {});

      assert.strictEqual(cache.snapshot()[0].lastActivity, 1700,
        'the closed chat must keep its last-known activity — that is the whole point of WARDEN-245');
      assert.strictEqual(cache.snapshot()[0].active, false, 'but the FRESH active flag still wins');
    });

    it('a FRESH lastActivity overwrites the old one (carry-forward only fills gaps)', async () => {
      let ts = 1700;
      const discover = async (host) => ({
        host, chats: [tmuxChat(host, 'a', { active: true, lastActivity: ts })],
      });
      const cache = createChatCatalogCache({ discover, catalog: fakeCatalog([]) });

      await cache.refreshHost('h1', {});
      ts = 9900;
      await cache.refreshHost('h1', {});

      assert.strictEqual(cache.snapshot()[0].lastActivity, 9900,
        'carry-forward must never shadow a newer captured value');
    });

    it('carry-forward is keyed by id, so a chat cannot inherit another chat\'s activity', async () => {
      const discover = async (host) => ({
        host, chats: [tmuxChat(host, 'a', { lastActivity: null }), tmuxChat(host, 'b', { lastActivity: null })],
      });
      const cache = createChatCatalogCache({
        discover,
        catalog: fakeCatalog([tmuxChat('h1', 'a', { lastActivity: 4242 })]),
      });

      await cache.refreshCatalog({});
      await cache.refreshHost('h1', {});

      const snap = cache.snapshot();
      assert.strictEqual(snap.find((c) => c.key === 'a').lastActivity, 4242, 'a keeps its own');
      assert.strictEqual(snap.find((c) => c.key === 'b').lastActivity, null,
        'b never had activity and must not borrow a\'s');
    });

    it('the carry-forward survives a CATALOG refresh too, not just a discover', async () => {
      const cache = createChatCatalogCache({
        discover: fakeDiscover({ h1: [tmuxChat('h1', 'a', { active: true, lastActivity: 555 })] }),
        catalog: fakeCatalog([tmuxChat('h1', 'a', { lastActivity: null })]),
      });

      await cache.refreshHost('h1', {});          // live capture stamps 555
      await cache.refreshCatalog({});             // disk read has no activity

      assert.strictEqual(cache.snapshot()[0].lastActivity, 555,
        'a /api/chats list refresh must not wipe discovered activity');
    });
  });

  // ---- criterion 6: yatfa chats survive a catalog refresh -----------------

  describe('yatfa chats survive a catalog refresh (the :198/:199 behaviour)', () => {
    it('KEEPS lazily-discovered yatfa chats when the disk catalog is re-read', async () => {
      // Yatfa chats are lazily discovered and have NO catalog entry — they exist
      // only in this cache. A naive per-host replace silently drops them, and the
      // symptom is an already-open remote pane that stops streaming on every
      // sidebar list refresh.
      const cache = createChatCatalogCache({
        discover: fakeDiscover({ h1: [yatfaChat('h1', 'yatfa-worker'), tmuxChat('h1', 'a')] }),
        catalog: fakeCatalog([tmuxChat('h1', 'a')]),
      });

      await cache.refreshHost('h1', {});
      assert.deepStrictEqual(ids(cache.snapshot()).sort(), ['h1:a', 'h1:yatfa-worker']);

      await cache.refreshCatalog({});

      assert.ok(cache.snapshot().some((c) => c.kind === 'yatfa' && c.id === 'h1:yatfa-worker'),
        'the yatfa chat has no disk entry — dropping it kills an open pane\'s stream');
      assert.deepStrictEqual(ids(cache.snapshot()).sort(), ['h1:a', 'h1:yatfa-worker']);
    });

    it('keeps yatfa chats even when the catalog no longer lists that host at all', async () => {
      const cache = createChatCatalogCache({
        discover: fakeDiscover({ h1: [yatfaChat('h1', 'yatfa-worker')] }),
        catalog: fakeCatalog([]), // disk knows nothing about h1
      });

      await cache.refreshHost('h1', {});
      await cache.refreshCatalog({});

      assert.deepStrictEqual(ids(cache.snapshot()), ['h1:yatfa-worker'],
        'a host whose only chats are yatfa must not be swept away by an empty disk read');
    });

    it('drops stale catalog (tmux) chats the disk no longer lists', async () => {
      // The other half of the same rule: KEEPING yatfa chats must not turn into
      // keeping everything, or a killed chat becomes an undismissable ghost.
      const cache = createChatCatalogCache({
        discover: fakeDiscover({ h1: [yatfaChat('h1', 'yatfa-worker'), tmuxChat('h1', 'gone')] }),
        catalog: fakeCatalog([]),
      });

      await cache.refreshHost('h1', {});
      await cache.refreshCatalog({});

      assert.deepStrictEqual(ids(cache.snapshot()), ['h1:yatfa-worker'],
        'the killed tmux chat must NOT survive as a sidebar ghost');
    });

    it('a catalog refresh introduces hosts the cache has never seen', async () => {
      const cache = createChatCatalogCache({
        discover: fakeDiscover({}),
        catalog: fakeCatalog([tmuxChat('h1', 'a'), tmuxChat('h2', 'b')]),
      });

      const { chats, errors } = await cache.refreshCatalog({});

      assert.deepStrictEqual(ids(cache.snapshot()).sort(), ['h1:a', 'h2:b']);
      assert.deepStrictEqual(ids(chats).sort(), ['h1:a', 'h2:b'],
        'refreshCatalog returns the disk read verbatim for the caller to serve');
      assert.deepStrictEqual(errors, []);
    });
  });

  // ---- criterion 7: the flat read shape every server.js site depends on ---

  describe('snapshot() is a flat chat array (the ~10 read sites are behaviour-identical)', () => {
    it('returns a plain array of chats, not a Map or a per-host structure', async () => {
      const cache = createChatCatalogCache({
        discover: fakeDiscover({ h1: [tmuxChat('h1', 'a')], h2: [tmuxChat('h2', 'b')] }),
        catalog: fakeCatalog([]),
      });
      await cache.refreshHosts(['h1', 'h2'], {});

      const snap = cache.snapshot();
      assert.ok(Array.isArray(snap));
      // The exact operations server.js performs on it.
      assert.strictEqual(snap.find((c) => c.key === 'b').host, 'h2');
      assert.strictEqual(snap.filter((c) => c.kind === 'yatfa').length, 0);
      assert.ok(snap.some((c) => c.id === 'h1:a'));
    });

    it('groups by host and appends the refreshed host last — the old filter+spread order', async () => {
      // Old expression: `[...cache.filter(c => c.host !== host), ...next]` — the
      // refreshed host's chats land at the END, everyone else keeps their order.
      const cache = createChatCatalogCache({
        discover: fakeDiscover({
          h1: [tmuxChat('h1', 'a')], h2: [tmuxChat('h2', 'b')], h3: [tmuxChat('h3', 'c')],
        }),
        catalog: fakeCatalog([]),
      });

      await cache.refreshHost('h1', {});
      await cache.refreshHost('h2', {});
      await cache.refreshHost('h3', {});
      assert.deepStrictEqual(ids(cache.snapshot()), ['h1:a', 'h2:b', 'h3:c']);

      await cache.refreshHost('h1', {}); // re-refresh the FIRST host

      assert.deepStrictEqual(ids(cache.snapshot()), ['h2:b', 'h3:c', 'h1:a'],
        'the refreshed host moves to the end, exactly as the old spread expression put it');
    });

    it('snapshot() hands out a fresh array each call (a caller cannot corrupt the cache)', async () => {
      const cache = createChatCatalogCache({
        discover: fakeDiscover({ h1: [tmuxChat('h1', 'a')] }), catalog: fakeCatalog([]),
      });
      await cache.refreshHost('h1', {});

      const first = cache.snapshot();
      first.push(tmuxChat('h9', 'injected'));
      first.length = 0;

      assert.deepStrictEqual(ids(cache.snapshot()), ['h1:a'],
        'mutating a returned snapshot must not reach into the owner');
    });

    it('within a host, kept yatfa chats lead the disk-catalog ones', async () => {
      const cache = createChatCatalogCache({
        discover: fakeDiscover({ h1: [yatfaChat('h1', 'yw'), tmuxChat('h1', 'a')] }),
        catalog: fakeCatalog([tmuxChat('h1', 'a')]),
      });
      await cache.refreshHost('h1', {});
      await cache.refreshCatalog({});

      assert.deepStrictEqual(ids(cache.snapshot()), ['h1:yw', 'h1:a'],
        'mirrors the old `[...yatfa, ...retainLastActivity(cache, chats)]`');
    });
  });

  // ---- the lazy-mode bootstrap + membership gate --------------------------

  describe('seedIfEmpty() — the lazy-mode disk bootstrap', () => {
    let calls, cache;
    beforeEach(() => {
      calls = 0;
      cache = createChatCatalogCache({
        discover: fakeDiscover({}),
        catalog: async () => { calls += 1; return { chats: [tmuxChat('h1', 'a')], errors: [] }; },
      });
    });

    it('seeds from disk when the catalogue is empty', async () => {
      assert.strictEqual(await cache.seedIfEmpty({}), true, 'reports that it seeded');
      assert.deepStrictEqual(ids(cache.snapshot()), ['h1:a']);
      assert.strictEqual(calls, 1);
    });

    it('does NOTHING when the catalogue already holds chats (the old `if (!cache.length)`)', async () => {
      await cache.seedIfEmpty({});
      assert.strictEqual(await cache.seedIfEmpty({}), false, 'reports that it did not seed');
      assert.strictEqual(calls, 1, 'a populated catalogue must not re-read disk on every resolve');
    });

    it('works when destructured off the instance (no `this` binding)', async () => {
      const { seedIfEmpty, snapshot } = cache;
      await seedIfEmpty({});
      assert.deepStrictEqual(ids(snapshot()), ['h1:a']);
    });
  });

  describe('has() — the lazy-restore membership gate', () => {
    it('matches on key OR id, mirroring the attach handler\'s lookup', async () => {
      const cache = createChatCatalogCache({
        discover: fakeDiscover({ h1: [tmuxChat('h1', 'a')] }), catalog: fakeCatalog([]),
      });
      await cache.refreshHost('h1', {});

      assert.strictEqual(cache.has('a'), true, 'bare key (a restored tab id)');
      assert.strictEqual(cache.has('h1:a'), true, 'host-qualified id');
      assert.strictEqual(cache.has('nope'), false);
    });
  });
});
