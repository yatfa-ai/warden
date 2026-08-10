// Connectivity-status logic for the /api/hosts/status endpoint.
//
// Two layers live here:
//
//   1. `checkHost` — the pure per-host transformation. Derives
//      status/latency/error/timestamp from a validateHost result and never
//      throws: a rejecting validateHost becomes an 'offline' result carrying
//      the error message.
//
//   2. `createHostStatusCache` — the NON-BLOCKING snapshot the route serves
//      from. This is the WARDEN-915 fix; see the block comment on the factory.
//
// `validateHost` is injected (rather than imported) precisely so tests can
// control connectivity outcomes without mocking the module boundary (this repo
// runs on Node 20, where node:test's `mock.module` is unavailable).

/** A host entry older than this schedules a BACKGROUND refresh on the next
 *  snapshot, so every poll tick refreshes the value the NEXT tick will serve.
 *
 *  MUST STAY COMFORTABLY BELOW useHostStatuses' 30s poll cadence, and the margin
 *  has to cover a slow probe. A background refresh lands AFTER the response it
 *  was scheduled by, so an entry's `at` is `pollTime + probeLatency`, not
 *  `pollTime`; at the next tick its age is `POLL_MS - probeLatency`. Setting
 *  this equal to POLL_MS therefore makes every other tick read the entry as
 *  still-fresh and skip the refresh — probing silently halves to one per 60s and
 *  the dots go up to ~60s stale, which is worse the slower the host. Measured
 *  against the real module with a 200ms probe: 4 probes in 180s instead of 7.
 *
 *  The invariant that rules that out is
 *
 *      HOST_STATUS_MAX_AGE_MS + HOST_PROBE_TIMEOUT_MS < POLL_MS
 *
 *  — even a probe that runs to its full bound leaves the entry stale by the next
 *  tick. 15s + 8s = 23s against a 30s cadence. `hostStatusCadence` in
 *  src/server-hosts-status.test.js pins this against the client's real POLL_MS
 *  so the two cannot drift back into collision. */
export const HOST_STATUS_MAX_AGE_MS = 15_000;

/** Hard per-host probe bound. validateHost's own path can run to ~15s on an
 *  unreachable host (ControlMaster connect timeout, then a direct-ssh fallback),
 *  and a wedged probe would otherwise hold its refresh slot forever — no later
 *  refresh could start for that host. Bounding every probe guarantees the slot
 *  always frees. 8s is the per-host probe timeout the host-probe path already
 *  uses elsewhere, and is far above a reachable host's sub-second handshake. */
export const HOST_PROBE_TIMEOUT_MS = 8_000;

/** How long a snapshot will wait for hosts it has NEVER probed before. Bounded
 *  and SHARED across all hosts (not per-host), so it is a flat constant no
 *  matter how many hosts are configured. Its only job is to let the cheap hosts
 *  — '(local)' resolves with no SSH at all, a warm host in ~100ms — report a
 *  real status on the very first request instead of a blank dot. A host that
 *  misses the window is reported as `checking` and fills in on a later poll. */
export const HOST_STATUS_SETTLE_MS = 250;

/**
 * Check one host and return a structured status object.
 *
 * `opts.timeoutMs` bounds the probe: if validateHost has not settled by then the
 * host is reported offline with a timeout error rather than being awaited
 * indefinitely. The underlying validateHost promise is abandoned (its ssh child
 * has its own timeout and exits on its own); its late result is discarded so a
 * bounded probe can never write to the cache after its slot was released.
 *
 * @param {string} host - host alias, or '(local)' for this machine.
 * @param {(host: string, cfg: object) => Promise<{ok: boolean, error?: string}>} validateHost
 *        - connectivity probe (real one lives in ssh.js).
 * @param {object} cfg - warden config, passed through to validateHost.
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{host: string, status: string, latency_ms: number|null,
 *                     error: (string|undefined), last_check: string}>}
 */
export async function checkHost(host, validateHost, cfg, opts = {}) {
  const start = Date.now();
  const { timeoutMs } = opts;
  try {
    const probe = Promise.resolve().then(() => validateHost(host, cfg));
    const result = timeoutMs > 0 ? await withTimeout(probe, timeoutMs, host) : await probe;
    return {
      host,
      status: result.ok ? 'online' : 'offline',
      latency_ms: result.ok ? Date.now() - start : null,
      error: result.error,
      last_check: new Date().toISOString(),
    };
  } catch (e) {
    return {
      host,
      status: 'offline',
      latency_ms: null,
      error: e.message,
      last_check: new Date().toISOString(),
    };
  }
}

/**
 * Resolve `promise`, or reject with a timeout error after `ms`. The loser's
 * settlement is swallowed so an abandoned probe can never surface as an
 * unhandled rejection, and the timer is always cleared once the race is decided
 * (deliberately NOT unref'd: while a response is waiting on this race the timer
 * is the only thing keeping the loop alive, and an unref'd one would let the
 * process exit mid-request).
 */
function withTimeout(promise, ms, host) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Connectivity probe to ${host} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** A bounded wait, with an explicit cancel so a settled race does not leave the
 *  timer pending for the rest of the window. */
function delay(ms) {
  let timer;
  const promise = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * The per-host connectivity cache behind GET /api/hosts/status (WARDEN-915).
 *
 * THE DEFECT THIS REPLACES. The route used to `Promise.all` a LIVE SSH probe of
 * every configured host on the request path. With the agent-sandbox default of
 * zero hosts that path executes zero iterations and the endpoint answers in
 * ~2ms — which is why the cost stayed invisible through several passes. On a
 * real 5-host config with one unreachable host it was MEASURED at 15.0s per
 * request, every request, because the response could not be produced until the
 * single worst host finished timing out: four healthy hosts ready in ~300ms were
 * withheld for 15s by the fifth. The poll re-pays that every 30s, forever, and
 * it grows with the host count — so this is an always-on 15s request that one
 * bad host holds hostage, which the ticket names as a defect in its own right.
 *
 * (Scope note, so a later reader does not over-read this: what was measured is
 * THIS endpoint, before and after. The originally-reported symptom — Settings
 * taking many seconds to open — was NOT reproducible in the agent sandbox, where
 * Settings opens in ~150ms both before and after, and no consumer of this
 * endpoint is on the Settings render path. Whether this fully explains that
 * symptom on the owner's machine is unconfirmed.)
 *
 * THE MODEL. A read never waits on a probe:
 *
 *   - Every host is served from its last known result, immediately. Response
 *     time is O(1) in the number of hosts, so adding hosts cannot make any page
 *     that touches this endpoint proportionally slower.
 *   - A stale entry schedules a refresh in the BACKGROUND and returns the old
 *     value now. There is deliberately no "expired → block and re-probe" branch:
 *     that is the first-open cliff that would come back every time the cache
 *     aged out. Staleness only ever costs freshness, never latency.
 *   - Each host refreshes independently, so a slow or unreachable host degrades
 *     ONLY its own entry. The four healthy hosts in the measurement above are
 *     delivered in ~0ms instead of being held hostage for 15s by the fifth.
 *   - A host with no result yet is reported `{status:'unknown', checking:true}`
 *     rather than being waited for. `checking` is the signal a client uses to
 *     poll again shortly instead of leaving the dot blank until the next tick.
 *   - Probes are bounded (HOST_PROBE_TIMEOUT_MS) so a wedged one always frees
 *     its slot and later refreshes can proceed.
 *
 * There is no timer here: refreshes are scheduled only by a read, so the SSH
 * cost still tracks polling (a backgrounded tab that stops polling stops
 * probing), exactly as before.
 *
 * The factory shape keeps the cache injectable and per-instance, so tests get an
 * isolated cache with their own clock/bounds instead of sharing module state.
 *
 * @param {{maxAgeMs?: number, probeTimeoutMs?: number, settleMs?: number,
 *          now?: () => number, probe?: typeof checkHost}} [options]
 */
export function createHostStatusCache({
  maxAgeMs = HOST_STATUS_MAX_AGE_MS,
  probeTimeoutMs = HOST_PROBE_TIMEOUT_MS,
  settleMs = HOST_STATUS_SETTLE_MS,
  now = () => Date.now(),
  probe = checkHost,
} = {}) {
  /** host -> { result, at } — `at` is the local clock reading when the probe
   *  landed, kept separately from the wire's ISO `last_check` so staleness never
   *  depends on re-parsing a formatted string. */
  const entries = new Map();
  /** host -> Promise, the in-flight refresh dedup. One probe per host at a time:
   *  a poll arriving while the previous probe is still running joins it rather
   *  than stacking a second ssh child on an already-slow host. */
  const inFlight = new Map();

  function refresh(host, validateHost, cfg) {
    const existing = inFlight.get(host);
    // `started: false` marks a probe this call JOINED rather than launched. Only
    // the launcher may spend the settle window on it: a host that is permanently
    // unreachable would otherwise have a probe in flight at almost every poll,
    // and re-waiting on it would charge the settle window to every request
    // forever — the same "one bad host taxes the whole response" shape this
    // cache exists to remove, just smaller.
    if (existing) return { promise: existing, started: false };
    const promise = probe(host, validateHost, cfg, { timeoutMs: probeTimeoutMs })
      .then((result) => {
        entries.set(host, { result, at: now() });
        return result;
      })
      // checkHost never rejects, but a caller-supplied probe might; a failed
      // refresh must leave the last known value in place, not crash the poll.
      .catch(() => undefined)
      .finally(() => { inFlight.delete(host); });
    inFlight.set(host, promise);
    return { promise, started: true };
  }

  return {
    /**
     * The current status of every host in `hosts`, in order. Schedules whatever
     * background refreshes are due. Never rejects.
     *
     * @param {string[]} hosts
     * @param {(host: string, cfg: object) => Promise<{ok: boolean, error?: string}>} validateHost
     * @param {object} cfg
     */
    async snapshot(hosts, validateHost, cfg) {
      const wanted = new Set(hosts);
      // Drop hosts that are no longer configured, so removing a host from
      // config.json does not leave its result (or its dot) behind forever.
      for (const host of entries.keys()) if (!wanted.has(host)) entries.delete(host);

      const firstProbes = [];
      for (const host of wanted) {
        const entry = entries.get(host);
        if (entry && now() - entry.at < maxAgeMs) continue; // fresh enough
        const { promise, started } = refresh(host, validateHost, cfg);
        // Only a host we have NOTHING for is worth waiting on, only within the
        // shared settle window, and only when THIS call started the probe.
        // A host with a previous result is served from it immediately — that is
        // the whole point.
        if (!entry && started) firstProbes.push(promise);
      }

      if (firstProbes.length) {
        const settle = delay(settleMs);
        await Promise.race([Promise.allSettled(firstProbes), settle.promise]);
        settle.cancel();
      }

      return hosts.map((host) => {
        const entry = entries.get(host);
        if (entry) return entry.result;
        return {
          host,
          status: 'unknown',
          latency_ms: null,
          last_check: null,
          // Distinguishes "we have not looked yet" from "we looked and it is
          // down", so a client can re-poll shortly rather than render a blank
          // dot until the next full-cadence tick.
          checking: true,
        };
      });
    },
  };
}
