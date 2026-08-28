// The cross-host Claude SESSION list — ONE owner (WARDEN-1208).
//
// Before this module the fleet's session list had no owner at all
// (`git grep -nE "createSessionCache|sessionCache" origin/main -- src/` was
// empty). Two independent readers each ran their OWN full-fleet fan-out over the
// same rows, on two unrelated beats:
//
//   1. `GET /api/claude-sessions-all` — `Promise.allSettled` over every host ON
//      THE REQUEST PATH. The route could not answer until the LAST host settled,
//      so one unreachable machine withheld every healthy host's rows for the
//      duration of its SSH timeout (`remoteClaudeSessionsDetail` passes
//      `{ timeout: 15000 }`). This is the same shape `createHostStatusCache`
//      (src/hostStatus.js) was built to remove on `/api/hosts/status`, where it
//      was MEASURED at 15.0s per request — four healthy hosts ready in ~300ms
//      withheld for 15s by the fifth.
//
//   2. `tickBudget` — its own identical fan-out every BUDGET_INTERVAL_MS (120s),
//      over its own comment stating it reuses "the SAME functions
//      /api/claude-sessions-all uses". A user opening the session browser
//      mid-sweep therefore paid a SECOND full-fleet SSH sweep for rows the
//      server was already fetching.
//
// This module owns the fetch: per-host slots with a freshness stamp and a
// per-host in-flight promise, so concurrent readers JOIN one enumeration
// instead of stacking two. Modelled directly on `createHostStatusCache`; the
// in-flight-join idiom is already idiomatic in server.js (`budgetInFlight`,
// `attentionInFlight`, chatCatalog's per-host `inFlight`).
//
// ---------------------------------------------------------------------------
// WHAT THIS MODULE OWNS, AND WHAT IT DELIBERATELY DOES NOT
//
// It owns WHO FETCHES AND WHEN. It does NOT own what `unreachable` MEANS — that
// is a finished fact (WARDEN-1196/1199/1200), classified by `isTransportFailure`
// inside `remoteClaudeSessionsDetail`. This module transports the flag through
// unchanged; the route's `unreachableHosts` derivation is byte-identical to
// before, which is why src/claude-sessions-all-unreachable.test.js passes
// UNMODIFIED against it.
//
// THE FROZEN CONTRACT IS NOT WIDENED. `remoteClaudeSessions` returns a bare
// array and says so ("CONTRACT FROZEN (WARDEN-1196) … this signature must not
// grow a failure channel"). So the cache fetches through the richer DETAIL
// variant — a strict superset, since the bare one is literally
// `const { sessions } = await remoteClaudeSessionsDetail(...); return sessions;`
// — and the sweep-facing read PROJECTS DOWN to the array. The sweep does not
// start consuming `unreachable`; that would be a behaviour change outside this
// slice.
//
// ---------------------------------------------------------------------------
// THE HAZARD THIS MODULE IS BUILT AROUND: "NOT LOOKED AT YET" IS NOT "EMPTY"
//
// Consolidating N readers onto one owner introduces a state none of the readers
// ever had to express: a slot that has not been filled. On THIS path that state
// is dangerous, because an empty session list is rendered by the client as the
// confident sentence "Nothing runnable on the selected hosts yet"
// (web/src/lib/allSessionsApi.ts). Serving a cold slot as `sessions: []` would
// re-create the exact WARDEN-89 / WARDEN-1200 false-empty defect that two
// finished tickets just removed — a factual claim about the user's machines,
// made because we had not looked yet.
//
// So a cold slot is NEVER merged away as zero rows. `snapshot()` reports it
// through `pending` — the counterpart of hostStatus's `checking: true` — and
// the route discloses those hosts on the wire. `known: false` and
// `known: true, sessions: []` are different answers here, always.
//
// ---------------------------------------------------------------------------
// FRESHNESS IS PER-HOST-KIND, AND THAT ASYMMETRY IS THE POINT
//
// `maxAgeMs` bounds how stale a slot may be before a read refreshes it. It
// applies to REMOTE hosts only: the whole reason to serve a stale row is to
// avoid paying an SSH round-trip on the request path. `(local)` has no
// transport — `localClaudeSessions` is a filesystem read that cannot time out
// and cannot be unreachable — so staleness there would buy no latency and cost
// only correctness (a transcript written a second ago would be invisible).
// `localMaxAgeMs` defaults to 0: the local host is always refreshed, and the
// in-flight join alone is what stops two concurrent readers from walking the
// archive twice.
//
// LIMIT-AWARENESS. The route's per-host window VARIES per request
// (`min(ALL_SESSIONS_MAX_PER_HOST, offset + limit + 1)`), while the sweep's is a
// fixed 100. A slot filled at 40 must not satisfy a caller needing 141, or
// pagination would silently truncate at a page boundary. Each slot therefore
// records the `limit` it was filled at and a read refreshes when
// `slot.limit < wanted`. The reverse is fine and is exactly the win: a slot
// filled at 141 serves a caller needing 40 by slicing down, with no fetch. One
// slot per host (rather than one per limit) is deliberate — the remote SSH cost
// is the same regardless of limit (`remoteClaudeSessions`' doc: "the remote
// script already walks every file … only the in-Node slice changes"), so
// keeping N slots keyed by limit would multiply memory to buy nothing.

/** How long a REMOTE host's rows may be served without a re-fetch. Sized against
 *  the cost it exists to avoid: a remote enumeration is bounded at 15s
 *  (`remoteClaudeSessionsDetail`'s ssh timeout) and costs a full SSH round-trip
 *  plus a grep+awk pass over every transcript on the host. 10s comfortably
 *  covers the burst this module targets — a page load and the 120s budget sweep
 *  landing near each other, plus the client's own pagination clicks — while
 *  staying far below the 120s sweep cadence, so the sweep never serves itself a
 *  slot from its own previous tick. Never applied to `(local)`; see above. */
export const SESSION_CACHE_MAX_AGE_MS = 10_000;

/** How long a read will wait for hosts it has NO usable slot for. Bounded and
 *  SHARED across all hosts (not per-host), so it is a flat constant no matter
 *  how many hosts are configured — this is the property that makes the response
 *  O(1) in fleet size instead of O(slowest host).
 *
 *  1500ms is chosen against what it is buying: unlike hostStatus's 250ms probe
 *  window, a miss here is not a grey dot, it is a whole machine's session
 *  history absent from the list. A warm remote enumeration lands well inside
 *  this; an unreachable host burns its full 15s timeout and misses it, which is
 *  precisely the case that must not hold the response. A host that misses is
 *  reported `pending` and fills in on the client's next read. */
export const SESSION_CACHE_SETTLE_MS = 1_500;

/**
 * The owner of the cross-host session list.
 *
 * The factory shape keeps the cache per-instance and injectable, so tests get an
 * isolated cache with their own clock and their own fetch fakes instead of
 * sharing module state — and need no SSH and no fake timers. (Injection rather
 * than `mock.module`: that API is unavailable on this repo's Node 20 runtime —
 * the same constraint documented in src/server-hosts-status.test.js and
 * src/chatCatalog.test.js.)
 *
 * @param {{maxAgeMs?: number, localMaxAgeMs?: number, settleMs?: number,
 *          local?: string, now?: () => number,
 *          fetchLocal?: (limit: number) => Promise<Array<object>>,
 *          fetchRemote?: (host: string, limit: number) => Promise<{sessions: Array<object>, unreachable: boolean}>}} [options]
 */
export function createSessionCache({
  maxAgeMs = SESSION_CACHE_MAX_AGE_MS,
  localMaxAgeMs = 0,
  settleMs = SESSION_CACHE_SETTLE_MS,
  local = '(local)',
  now = () => Date.now(),
  fetchLocal,
  fetchRemote,
} = {}) {
  if (typeof fetchLocal !== 'function' || typeof fetchRemote !== 'function') {
    throw new TypeError('createSessionCache requires fetchLocal and fetchRemote');
  }

  /** host -> { sessions, at, limit, unreachable }.
   *  - `at` is the local clock reading when the slot landed, kept separately
   *    from any row's mtime so freshness never depends on re-parsing session
   *    data.
   *  - `limit` is the per-host window this slot was FILLED at — the field that
   *    stops a 40-row slot satisfying a 141-row read.
   *  - `unreachable` is carried verbatim from the discriminator; this module
   *    never classifies. */
  const slots = new Map();

  /** host -> { promise, limit }, the in-flight fetch dedup. One enumeration per
   *  host at a time: a request arriving while the previous fetch is still running
   *  joins it rather than stacking a second ssh child on an already-slow host.
   *  `limit` is what that in-flight fetch will FILL, which is what makes the join
   *  limit-aware — see `refresh`. */
  const inFlight = new Map();

  const ageLimitFor = (host) => (host === local ? localMaxAgeMs : maxAgeMs);

  /** Does this slot hold ENOUGH ROWS to answer a read for `wanted`? The
   *  limit-awareness half of constraint 3, kept separate from freshness because
   *  the two are asked at different moments: freshness decides whether to
   *  refresh BEFORE a fetch, sufficiency decides whether a fetch we just awaited
   *  actually answered us. */
  const serves = (slot, wanted) => !!slot && slot.limit >= wanted;

  /** Can this slot answer a read right now WITHOUT any fetch? Both halves must
   *  hold: filled at a large enough window, and within its host kind's freshness
   *  bound. A zero/negative bound is "never serve this host from cache" — the
   *  local host's setting, since a filesystem read has no round-trip to save. */
  function usable(host, slot, wanted) {
    if (!serves(slot, wanted)) return false;
    const maxAge = ageLimitFor(host);
    if (maxAge <= 0) return false;
    return now() - slot.at < maxAge;
  }

  /**
   * Start (or JOIN) a fetch for one host.
   *
   * `started: false` marks a fetch this call JOINED rather than launched. Only
   * the launcher may spend the settle window on it — copied deliberately from
   * createHostStatusCache. A permanently-unreachable host otherwise has a fetch
   * in flight at nearly every read, and re-waiting on it would charge its 15s
   * timeout to every request forever: the same "one bad host taxes the whole
   * response" shape this cache exists to remove, just smaller.
   *
   * THE JOIN IS LIMIT-AWARE, and this is the subtle half of constraint 3. An
   * in-flight fetch will fill its slot at the limit its LAUNCHER asked for, so
   * joining it does not necessarily answer the joiner: the 120s sweep wants 100
   * rows, and if it joined a page-1 route fetch launched at 41 it would compute
   * the fleet's token budget from a truncated list — silently under-counting
   * spend, which is a wrong NUMBER rather than a slow response.
   *
   * So `fills` reports whether the joined fetch will actually satisfy this
   * caller. It never launches a second concurrent ssh child for the same host
   * (that is the cost being removed); an under-served joiner is simply told the
   * truth, so `snapshot` can report the host `pending` and refresh it on the next
   * read instead of presenting a short list as a complete one.
   */
  function refresh(host, limit) {
    const existing = inFlight.get(host);
    if (existing) {
      return { promise: existing.promise, started: false, fills: existing.limit >= limit };
    }

    const fetchOne = host === local
      ? fetchLocal(limit).then((sessions) => ({ sessions: sessions || [], unreachable: false }))
      // The LOCAL leg can never be unreachable: a filesystem read has no
      // transport to fail, so `isTransportFailure` has no meaning for it. Same
      // scoping WARDEN-1196/1200 applied on both routes, preserved here so a
      // careless refactor cannot apply the remote classifier to both legs.
      : fetchRemote(host, limit);

    const promise = fetchOne
      .then((res) => {
        const slot = {
          sessions: Array.isArray(res?.sessions) ? res.sessions : [],
          at: now(),
          limit,
          unreachable: !!res?.unreachable,
        };
        slots.set(host, slot);
        return slot;
      })
      // Neither fetcher is expected to reject (both degrade to an empty list),
      // but a caller-supplied one might. A failed fetch must leave the last
      // known slot in place rather than blanking the host — the same rule as
      // createHostStatusCache's probe and chatCatalog's discover. A host that
      // has never landed simply stays cold, and is reported `pending`, which is
      // the honest answer: we still have not looked successfully.
      .catch(() => undefined)
      .finally(() => {
        const cur = inFlight.get(host);
        if (cur && cur.promise === promise) inFlight.delete(host);
      });

    inFlight.set(host, { promise, limit });
    return { promise, started: true, fills: true };
  }

  return {
    /**
     * The session rows for every host in `hosts`, each sliced to `limit`.
     *
     * Never rejects. Never blocks on a host that already has a usable slot, and
     * never blocks on a host whose fetch some OTHER read launched.
     *
     * @param {string[]} hosts
     * @param {number} limit per-host window
     * @param {{wait?: boolean}} [opts] `wait: true` awaits every fetch this call
     *   launches, with NO settle bound — the slow-cadence sweep's mode, which
     *   has no user waiting on it and wants complete rows. The default (`false`)
     *   is the request-path mode: wait only for cold hosts, only within the
     *   shared settle window, and only for fetches THIS call launched.
     * @returns {Promise<Array<{host: string, sessions: Array<object>, unreachable: boolean, known: boolean, pending: boolean, at: number|null}>>}
     */
    async snapshot(hosts, limit, { wait = false } = {}) {
      const wanted = new Set(hosts);
      // Drop hosts that are no longer configured, so removing a host from
      // config.json does not leave its sessions (or its rows) behind forever.
      // Same reconcile step as createHostStatusCache — and, as there, this is
      // the ONLY place a slot is deleted: never as a side effect of a refresh
      // finding nothing, which would downgrade "we looked and it is empty" back
      // to "we have not looked yet".
      for (const host of slots.keys()) if (!wanted.has(host)) slots.delete(host);

      // Two waiting disciplines, and the split between them is the whole design:
      //
      //   `awaited` — fetches with NO settle bound. Two populations, for the
      //     same reason: there is no network timeout to be held hostage by.
      //     (a) `wait` mode, the slow-cadence sweep: nobody is waiting on it and
      //         it wants complete rows.
      //     (b) any host whose freshness bound is <= 0, i.e. a host that is
      //         never served from cache. That is `(local)`, whose fetch is a
      //         filesystem read — it cannot time out and cannot be unreachable,
      //         so bounding it would buy nothing while risking a STALE local
      //         answer, which is strictly worse than today's behaviour. Awaiting
      //         it keeps the local leg byte-identical to the pre-cache route.
      //
      //   `raced` — cold or under-filled REMOTE hosts, inside ONE shared settle
      //     window. This is the bound that makes the response O(1) in fleet size:
      //     an unreachable host burns its full 15s ssh timeout, misses the
      //     window, and is reported `pending` instead of withholding every
      //     healthy host's rows for 15s.
      const awaited = [];
      const raced = [];
      for (const host of wanted) {
        const slot = slots.get(host);
        if (usable(host, slot, limit)) continue;
        const { promise, started, fills } = refresh(host, limit);
        // An UNDER-FILLING join is not an answer: the in-flight fetch was
        // launched at a smaller limit than this caller needs, so waiting on it
        // cannot satisfy us. Do not wait — and do not launch a competing second
        // ssh child for the same host either, which is the cost this cache
        // exists to remove. The host falls through to the return map, where the
        // resulting short slot is reported `pending` and refreshed on the next
        // read. This is the case that would otherwise let the 120s sweep compute
        // the budget from a page-1-sized list.
        if (!fills) continue;
        if (wait || ageLimitFor(host) <= 0) { awaited.push(promise); continue; }
        // LAUNCHER-ONLY, and only for the settle-raced bucket — copied from
        // createHostStatusCache. A permanently-unreachable host has a fetch in
        // flight at nearly every read; re-waiting on it would charge the settle
        // window to every request forever, which is the same "one bad host taxes
        // the whole response" shape this cache exists to remove. A joiner is
        // reported `pending` instead, and fills in on the next read.
        if (!started) continue;
        // A host with a usable-but-stale slot is served from it immediately —
        // that is the whole point — and refreshed in the background for the next
        // read. Only a host we cannot answer for AT ALL is worth waiting on.
        if (!serves(slot, limit)) raced.push(promise);
      }

      if (awaited.length) await Promise.allSettled(awaited);
      if (raced.length) {
        const settle = delay(settleMs);
        await Promise.race([Promise.allSettled(raced), settle.promise]);
        settle.cancel();
      }

      return hosts.map((host) => {
        const slot = slots.get(host);
        if (!slot) {
          // NOT LOOKED AT YET. Reported as its own state — `known: false`,
          // `pending: true` — and NEVER as an empty session list. Merging this
          // away as zero rows is the false-empty defect described at the top of
          // this file; the route turns it into a wire-level disclosure instead.
          return {
            host,
            sessions: [],
            unreachable: false,
            known: false,
            pending: true,
            at: null,
          };
        }
        return {
          host,
          // Slicing down is what makes one slot per host correct: a slot filled
          // at a LARGER window answers a smaller read exactly, with no fetch.
          // Rows are already mtime-descending from both fetchers, so the head is
          // the newest `limit`.
          sessions: slot.limit > limit ? slot.sessions.slice(0, limit) : slot.sessions,
          unreachable: slot.unreachable,
          known: true,
          // UNDER-FILLED IS ALSO PENDING — the other half of constraint 3, and
          // the one that is easy to miss. `usable()` stops a too-small slot from
          // SATISFYING a read, but a read can still arrive here holding one: it
          // joined a fetch some other reader launched at a smaller limit, so it
          // may not wait (launcher-only) and the slot it finds is genuinely
          // short of the window it asked for.
          //
          // Its rows are REAL, so they are returned — dropping them would throw
          // away data the user could see, for a host that did answer. But the
          // list may be truncated relative to the requested window, which would
          // make `hasMore`/pagination quietly wrong, so the host is flagged.
          // Flagged-and-included is the same partial-success shape WARDEN-1200
          // chose for `unreachableHosts`: disclose the gap, never silently
          // present a partial answer as a complete one, and never blank a list
          // that has real rows in it.
          pending: !serves(slot, limit),
          at: slot.at,
        };
      });
    },

    /**
     * What we know about ONE host, WITHOUT looking. Zero fetches, zero SSH —
     * the observability counterpart of chatCatalog's `hostState`.
     *
     * @param {string} host
     */
    hostState(host) {
      const slot = slots.get(host);
      const checking = inFlight.has(host);
      if (!slot) return { host, known: false, checking, at: null, limit: null, unreachable: false, sessions: [] };
      return {
        host,
        known: true,
        checking,
        at: slot.at,
        limit: slot.limit,
        unreachable: slot.unreachable,
        // COPIED, not the slot's own array. A caller that sorted or spliced the
        // returned list in place would otherwise corrupt the cached rows for every
        // later reader — a cross-reader bug with no local symptom, which is the
        // kind an owner module exists to make impossible. The copy is shallow: the
        // ROWS are shared, and that is deliberate (they are treated as immutable
        // everywhere, and `snapshot`'s consumers already spread them). Cheap
        // either way — this is an observability read, not a hot path.
        sessions: slot.sessions.slice(),
      };
    },
  };
}

/**
 * Flatten a `snapshot()` into host-tagged rows, EXCLUDING every host the cache
 * reported `pending`. The projection for a consumer that needs COMPLETE rows.
 *
 * WHY THIS EXISTS AS A NAMED, EXPORTED STEP rather than an inline flatMap: the
 * two readers of this cache want OPPOSITE things from a short slot, and the
 * difference is easy to lose in a one-liner.
 *
 *   - The ROUTE wants the rows. It is rendering a list, a truncated list still
 *     shows the user real sessions, and it discloses the gap separately as
 *     `pendingHosts`. Dropping them would blank a host that did answer.
 *   - The SWEEP wants them GONE. It is computing a NUMBER (fleet token spend),
 *     and rows are mtime-DESCENDING, so a slot filled at a page-1 window (41)
 *     when the sweep asked for 100 silently drops the oldest window-active
 *     sessions' spend. `computeBudgetState` cannot tell a truncated list from a
 *     complete one, and the result is cached for the next 120s. A wrong number
 *     is strictly worse than a missing one — and worse than the pre-cache
 *     behaviour, which always fanned out at the full 100.
 *
 * Excluding the host degrades it to "no spend from it this tick": the SAME
 * pre-existing semantics an unreachable or failed host already gets, and it
 * self-corrects on the next tick. Deliberately NOT a re-fetch — that would
 * relaunch the duplicate ssh child this cache exists to remove.
 *
 * @param {Array<{host: string, sessions: Array<object>, pending: boolean}>} settled
 * @returns {Array<object>} rows from complete hosts only, each tagged with `host`
 */
export function completeSessionRows(settled) {
  return settled
    .filter((entry) => !entry.pending)
    .flatMap(({ host, sessions }) => sessions.map((s) => ({ ...s, host })));
}

/** A cancellable timer promise, so a settled race does not leave a pending
 *  handle keeping the event loop (and `node --test`) alive. Same helper shape as
 *  src/hostStatus.js's. */
function delay(ms) {
  let timer;
  const promise = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
  return { promise, cancel: () => clearTimeout(timer) };
}
