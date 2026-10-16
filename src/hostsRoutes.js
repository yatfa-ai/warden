import express from 'express';
import { allSshHosts } from './config.js';
import { createHostStatusCache } from './hostStatus.js';
import { isCompanionTransportEnabled, getCompanionStatus, pingProbe } from './companion.js';
import { validateHost } from './ssh.js';

// Host-connectivity routes (/api/ssh-hosts, /api/hosts/health, /api/hosts/status)
// plus the probeHostReachability wrapper and the per-host status cache they share,
// extracted verbatim from server.js. Injected: the shared `cfg` and the `local`
// host id constant.
export function createHostsRouter({ cfg, local }) {
  const router = express.Router();

  // Per-host connectivity cache behind GET /api/hosts/status (WARDEN-915), so that
  // request never waits on live SSH. See createHostStatusCache in src/hostStatus.js
  // for the model, and the route below for what it replaced.
  const hostStatusCache = createHostStatusCache();

  router.get('/api/ssh-hosts', async (_req, res) => res.json({ hosts: await allSshHosts(), configured: cfg.hosts }));

  // WARDEN-1324: the reachability probe for the two POLL/GESTURE paths —
  // /api/hosts/health below and the /api/hosts/status snapshot. It rides the
  // companion channel ONLY when one is ALREADY live: pingProbe returns null for
  // every other case (toggle off, host never engaged / errored / still
  // bootstrapping, dead channel, LOCAL) and this falls back to validateHost
  // byte-for-byte. A probe must never trigger a bootstrap — the poll is a fixed
  // 30s clock, and a bootstrap here would pay the binary-upload cost on hosts the
  // operator never gestured at.
  //
  // ⚠️ DELIBERATELY NOT used by the POST /api/companion/uninstall precheck, which
  // keeps the raw-SSH validateHost: uninstallCompanion's first act is to tear down
  // the cached channel, so a companion-routed precheck could bootstrap the very
  // binary the operator asked to remove (the WARDEN-882 Removability outcome).
  // checkHost's injected-function seam (hostStatus.js takes the probe as a
  // PARAMETER) is unchanged — this is just a different function handed to it.
  async function probeHostReachability(host, cfg) {
    const via = await pingProbe(host, cfg);
    if (via) return via;
    return validateHost(host, cfg);
  }

  // Host health check endpoint
  router.get('/api/hosts/health', async (req, res) => {
    const hosts = Array.isArray(req.query.hosts) ? req.query.hosts : cfg.hosts;
    const healthChecks = await Promise.all(
      hosts.map(async (host) => {
        try {
          const result = await probeHostReachability(host, cfg);
          return { host, ...result };
        } catch (e) {
          return { host, ok: false, error: e.message };
        }
      })
    );
    res.json({ hosts: healthChecks, timestamp: Date.now() });
  });

  // Host connectivity status endpoint for sidebar indicators.
  //
  // WARDEN-915: served from a cache-first, background-refreshed per-host store —
  // this request NEVER waits on live SSH. It used to Promise.all a live probe of
  // [local, ...cfg.hosts] on the request path, which measured 2.6ms on a zero-host
  // config (the agent-sandbox default, hence invisible) but 15.0s on a realistic
  // 5-host config with one unreachable host, on EVERY 30s poll — because the
  // response could not be produced until the single WORST host finished timing
  // out, so four healthy hosts ready in ~300ms were withheld for 15s. See
  // createHostStatusCache (and `hostStatusCache`, declared at the top of
  // this factory) for the model.
  router.get('/api/hosts/status', async (_req, res) => {
    const hosts = [local, ...cfg.hosts];
    // WARDEN-878: when the companion transport is enabled, attach each host's
    // companion state (active/bootstrapping/error/inactive) to its result — one
    // per-host status the UI already polls, so no new endpoint or poll cadence.
    // The toggle is read at REQUEST time (isCompanionTransportEnabled) so a flip
    // takes effect on the next poll without a restart; when off, the field is
    // omitted entirely (the transport is opt-in, so there is nothing to surface).
    const companionOn = isCompanionTransportEnabled();
    // WARDEN-1324: the probe handed to the cache is the companion-riding wrapper,
    // NOT validateHost directly — a live channel answers the poll's reachability
    // question with zero ssh spawns; every other case (no channel / toggle off)
    // falls back to validateHost byte-for-byte inside the wrapper. The uninstall
    // precheck deliberately keeps raw validateHost (see probeHostReachability).
    const results = await hostStatusCache.snapshot(hosts, probeHostReachability, cfg);
    // Spread rather than mutate: the snapshot hands back the CACHED objects, and
    // assigning onto them would leave a stale `companion` field attached after the
    // transport is toggled back off (the field must vanish, not linger).
    res.json({
      hosts: companionOn
        ? results.map((r) => ({ ...r, companion: getCompanionStatus(r.host) }))
        : results,
    });
  });

  return router;
}
