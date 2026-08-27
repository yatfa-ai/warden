// The in-memory chat catalogue — ONE owner (WARDEN-1206).
//
// Before this module the catalogue was a bare module-level array in server.js
// (`let cache = []`) rewritten wholesale at six sites, with no freshness, no
// in-flight state, and a hand-called `retainLastActivity(cache, next)` helper
// that every replacement site had to remember to invoke. Two things followed
// from that shape, and both are fixed here:
//
//   1. NO DEDUP. resolve()'s bare-name branch fans out across the whole fleet
//      (Promise.allSettled over cfg.hosts). Two panes resolving unresolved bare
//      names concurrently each started their own full-fleet SSH sweep. The
//      per-host `inFlight` map below makes the second call JOIN the first,
//      exactly as createHostStatusCache (src/hostStatus.js) does for probes —
//      and as budgetInFlight / attentionInFlight already do in server.js.
//
//   2. THE CARRY-FORWARD WAS A CONVENTION. lastActivity is captured for LIVE
//      sessions only; when a session goes inactive a fresh discover yields
//      `lastActivity: null`, and a wholesale replace would wipe the value Fleet
//      Health needs for recency ordering (WARDEN-245). That is now a STRUCTURAL
//      property of a refresh — applied by the owner on every path in this file —
//      rather than a step each call site must not forget.
//
// SHAPE: per-host slots (`host -> { chats, at, source }`), mirroring
// createHostStatusCache's `entries` map. `at` is the local clock reading when
// the slot landed, kept separately from any wire timestamp so freshness never
// depends on re-parsing a formatted string.
//
// READS ARE FLAT. `snapshot()` returns a plain array of chats — the same shape
// the old `cache` had — because ~10 read sites in server.js do `.find`/`.filter`/
// `.some` over it or pass it whole to pollFleetStates/resolveChatWithRefresh.
// The per-host slot structure is deliberately INTERNAL: pushing a Map-shaped
// read onto those sites would balloon the diff far past this slice.
//
// NOT THIS MODULE'S FACT: disk persistence. chats.json's read-modify-write
// critical section is owned by `mutateCatalog` (src/config.js) — see the comment
// block at the top of server.js. Two different facts, two different owners.
//
// NO TTL GATE, DELIBERATELY. createHostStatusCache has `maxAgeMs` because its
// reader (a poll) wants a cached answer. Every caller here is demand-driven —
// the user clicked a host, or a pane needs resolving — and means "look NOW", so
// a staleness short-circuit would only ever serve a worse answer. `at` is
// exposed for observability and for callers that want to reason about it; the
// duplicate-cost win comes from the in-flight join, not from a TTL.
import { catalogChats as defaultCatalogChats, discoverHost as defaultDiscoverHost } from './chats.js';

/**
 * Fill any `lastActivity` that is null/undefined on an incoming chat from the
 * last-known value for the same id. Pure; no ssh. This is the former free
 * helper `retainLastActivity` from server.js, now reachable only through the
 * owner so it cannot be skipped by a new replacement site.
 *
 * Keying on `id` (the host-prefixed `${host}:${session|container}`) is what
 * makes a per-host application equivalent to the old whole-cache one: an id
 * carries its host, so a chat can never inherit activity from another host.
 *
 * @param {Map<string, number>} prevActivity id -> last-known lastActivity
 * @param {Array<object>} nextChats
 */
function carryLastActivity(prevActivity, nextChats) {
  if (!prevActivity.size) return nextChats;
  return nextChats.map((c) =>
    (c.lastActivity == null && prevActivity.has(c.id))
      ? { ...c, lastActivity: prevActivity.get(c.id) }
      : c
  );
}

/**
 * The owner of the in-memory chat catalogue.
 *
 * The factory shape keeps the cache per-instance and injectable, so tests get an
 * isolated catalogue with their own clock and their own discover/catalog fakes
 * instead of sharing module state — and need no SSH and no fake timers.
 * (Injection rather than `mock.module`: that API is unavailable on this repo's
 * Node 20 runtime — see src/server-hosts-status.test.js.)
 *
 * @param {{now?: () => number,
 *          discover?: (host: string, cfg: object) => Promise<{host: string, chats: Array<object>}>,
 *          catalog?: (cfg: object) => Promise<{chats: Array<object>, errors: Array<object>}>}} [options]
 */
export function createChatCatalogCache({
  now = () => Date.now(),
  discover = defaultDiscoverHost,
  catalog = defaultCatalogChats,
} = {}) {
  /** host -> { chats, at, source }. `at` is the local clock reading when this
   *  slot last landed; `source` is 'discover' (live, ssh) or 'catalog' (disk). */
  const slots = new Map();
  /** host -> Promise<Array<object>>, the in-flight refresh dedup. One discover
   *  per host at a time: a second resolve/click arriving while the previous
   *  discover is still running JOINS it rather than stacking a second full ssh
   *  round-trip on an already-slow host. */
  const inFlight = new Map();

  function snapshot() {
    const out = [];
    for (const slot of slots.values()) out.push(...slot.chats);
    return out;
  }

  /** id -> last-known lastActivity, across every slot. Built fresh per refresh. */
  function activityIndex() {
    const prev = new Map();
    for (const slot of slots.values()) {
      for (const c of slot.chats) if (c.lastActivity != null) prev.set(c.id, c.lastActivity);
    }
    return prev;
  }

  /**
   * Install a host's chats, carrying lastActivity forward. Re-inserting the key
   * (delete-then-set) moves the host to the END of the flat snapshot, which is
   * exactly the ordering the old `[...cache.filter(c => c.host !== host), ...next]`
   * expression produced — the refreshed host's chats appended after everyone
   * else's, in their existing order.
   */
  function setHost(host, chats, source) {
    const next = carryLastActivity(activityIndex(), chats);
    slots.delete(host);
    slots.set(host, { chats: next, at: now(), source });
    return next;
  }

  async function refreshHost(host, cfg) {
    const existing = inFlight.get(host);
    // A joiner gets the launcher's promise — same result, ONE ssh sweep. It also
    // gets the launcher's rejection, so /api/discover's 500 path is unchanged
    // for both.
    if (existing) return existing;
    const promise = discover(host, cfg)
      .then((r) => setHost(host, r?.chats || [], 'discover'))
      // A failed discover must leave the last known slot in place rather than
      // blanking the host — same rule as createHostStatusCache's probe. The
      // rejection still reaches the caller (that is /api/discover's 500).
      .finally(() => { if (inFlight.get(host) === promise) inFlight.delete(host); });
    inFlight.set(host, promise);
    return promise;
  }

  /**
   * Replace the CATALOG (disk) chats while KEEPING lazily-discovered yatfa
   * chats, so already-open remote panes keep streaming across list refreshes.
   * Yatfa chats have no catalog entry — they exist only in this cache — so a
   * naive whole-replace silently drops them. Returns the disk read verbatim
   * (`{ chats, errors }`) for the caller to serve.
   *
   * @param {object} cfg
   */
  async function refreshCatalog(cfg) {
    const { chats, errors } = await catalog(cfg);
    const prevActivity = activityIndex();

    // Group the incoming disk chats by host, preserving their order within
    // each host.
    const incoming = new Map();
    for (const c of chats) {
      const list = incoming.get(c.host);
      if (list) list.push(c); else incoming.set(c.host, [c]);
    }

    // Surviving yatfa chats, per host, keeping their existing order.
    const kept = new Map();
    for (const [host, slot] of slots) {
      const yatfa = slot.chats.filter((c) => c.kind === 'yatfa');
      if (yatfa.length) kept.set(host, yatfa);
    }

    // Rebuild: existing hosts first (stable ordering for anything already on
    // screen), then hosts the catalog newly introduces. Within a host, the
    // kept yatfa chats lead — mirroring the old `[...yatfa, ...catalogChats]`.
    const order = [...new Set([...slots.keys(), ...incoming.keys()])];
    const at = now();
    const prevSlots = new Map(slots);
    slots.clear();
    for (const host of order) {
      const yatfa = kept.get(host) || [];
      const fresh = carryLastActivity(prevActivity, incoming.get(host) || []);
      const merged = [...yatfa, ...fresh];
      const prev = prevSlots.get(host);

      // A KNOWN HOST KEEPS ITS SLOT EVEN WHEN IT ENDS UP EMPTY. Dropping it here
      // would silently downgrade "we looked and there is nothing there"
      // (known: true, chats: []) back to "we have not looked yet"
      // (known: false) — destroying the very distinction hostState exists to
      // draw, on the most ordinary sequence there is: click a host with zero
      // sessions (/api/discover → a legitimate empty answer), then let the
      // client's visible-tick auto-refresh re-pull /api/chats. The reference
      // model behaves the same way: createHostStatusCache only ever deletes an
      // entry in its RECONCILE step, for a host that is no longer configured —
      // never as a side effect of a refresh finding nothing. An empty slot
      // contributes nothing to snapshot(), so the flat-array shape is unchanged.
      //
      // Every host in `order` therefore holds a slot: it was either already
      // known (keep it, empty or not), or the disk read just introduced it — in
      // which case it has at least one chat by construction, since `incoming`
      // only gains a key when a chat is pushed onto it.

      // STAMP FRESHNESS ONLY FOR HOSTS THIS DISK READ ACTUALLY SPOKE ABOUT.
      // `at` is the module's only freshness signal and `source` its provenance,
      // so a host whose chats came from a live ssh discover — and which the disk
      // read never mentions — must NOT be restamped as a fresh 'catalog' read.
      // Doing so made a no-op refresh advance `at` and relabel live-discovered
      // data as disk data, i.e. claim a recency and an origin it does not have.
      const contributed = incoming.has(host);
      slots.set(host, {
        chats: merged,
        at: contributed || !prev ? at : prev.at,
        source: contributed || !prev ? 'catalog' : prev.source,
      });
    }

    return { chats, errors };
  }

  return {
    /**
     * Every chat currently known, flat and in catalogue order. NEVER awaits a
     * network call — this is the read every endpoint and lookup uses.
     *
     * ORDERING: chats are grouped by host, hosts in least-recently-refreshed
     * order (a refreshed host moves to the end, exactly as the old
     * `[...cache.filter(c => c.host !== host), ...next]` expression put it), and
     * within a host the lazily-discovered yatfa chats lead the disk-catalog
     * ones (the old `[...yatfa, ...catalogChats]`). Every consumer in server.js
     * either does a `.find`/`.filter`/`.some` (order-insensitive) or re-groups
     * downstream — /api/health passes through groupByHealth — so this is a
     * grouping refinement, not a behavioural change any read site can observe.
     */
    snapshot,

    /**
     * What we know about ONE host, WITHOUT looking. `known: false` is "we have
     * not looked yet"; `known: true` with an empty `chats` is "we looked and
     * there is nothing there" — the distinction createHostStatusCache draws with
     * `checking: true`, and the reason a caller can re-poll instead of rendering
     * an empty host as an answer. `checking` reports whether a discover for this
     * host is in flight right now.
     *
     * @param {string} host
     */
    hostState(host) {
      const slot = slots.get(host);
      const checking = inFlight.has(host);
      if (!slot) return { host, known: false, checking, at: null, source: null, chats: [] };
      return { host, known: true, checking, at: slot.at, source: slot.source, chats: slot.chats };
    },

    /** See the `refreshCatalog` definition above. */
    refreshCatalog,

    /**
     * Seed from disk only when the catalogue is empty — instant, zero ssh. This
     * is the lazy-mode bootstrap: resolve() seeds from disk before deciding
     * whether it can narrow a lookup to one host. Returns true when it seeded.
     *
     * Calls the hoisted `refreshCatalog` directly rather than `this.` so the
     * method keeps working when it is destructured off the instance.
     *
     * @param {object} cfg
     */
    async seedIfEmpty(cfg) {
      if (snapshot().length) return false;
      await refreshCatalog(cfg);
      return true;
    },

    /**
     * Discover ONE host and install its chats. Concurrent calls for the same
     * host share a single discover. Rejects if the discover rejects, leaving the
     * previous slot untouched.
     *
     * @param {string} host
     * @param {object} cfg
     */
    refreshHost,

    /**
     * Discover SEVERAL hosts concurrently, one in-flight discover per host, and
     * never reject: a host that fails keeps whatever it had. This is resolve()'s
     * bare-name locate branch — the fan-out that previously stacked a full fleet
     * sweep per concurrent pane.
     *
     * @param {string[]} hosts
     * @param {object} cfg
     */
    async refreshHosts(hosts, cfg) {
      await Promise.allSettled(hosts.map((h) => refreshHost(h, cfg)));
      return snapshot();
    },

    /**
     * Whether some id is already catalogued, by `key` OR `id` — the lazy-restore
     * gate ("do we already know this pane, or must we discover its host?").
     *
     * @param {string} id
     */
    has(id) {
      for (const slot of slots.values()) {
        for (const c of slot.chats) if (c.key === id || c.id === id) return true;
      }
      return false;
    },
  };
}
