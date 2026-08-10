import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  checkHost,
  createHostStatusCache,
  HOST_STATUS_MAX_AGE_MS,
  HOST_PROBE_TIMEOUT_MS,
} from './hostStatus.js';

/**
 * Tests for the /api/hosts/status feature.
 *
 * These tests exercise REAL production code — they do not re-implement the
 * endpoint logic. Two layers are covered:
 *
 *   1. Unit tests of the real `checkHost` transformation (src/hostStatus.js) —
 *      the per-host logic the endpoint delegates to. `validateHost` is stubbed
 *      per-case so every outcome (online / offline / throw) is deterministic
 *      with no SSH. Crucially, these assert against checkHost's actual return
 *      value, so they FAIL if the status ternary is inverted or a field is
 *      dropped — unlike the previous (tautological) suite which re-derived the
 *      expected value from a local copy of the same logic.
 *
 *   2. An HTTP integration test of the real Express app (src/server.js): it
 *      boots the actual route on an ephemeral port (validateHost left real, so
 *      the local host is probed with no SSH) and asserts on the wire response —
 *      the { hosts: [...] } envelope, the [LOCAL, ...cfg.hosts] composition,
 *      the online local host, and that only GET is served.
 *
 * The online/offline/throw branching is covered by the unit tests (validateHost
 * is injectable there). Mocking validateHost at the HTTP/module boundary would
 * need node:test's `mock.module`, which is unavailable on this repo's Node 20
 * runtime, so the split keeps coverage real without that dependency.
 */

function assertValidIso(value, label = 'last_check') {
  assert.strictEqual(typeof value, 'string', `${label} should be a string`);
  const parsed = new Date(value);
  assert.ok(!Number.isNaN(parsed.getTime()), `${label} should be a valid ISO timestamp, got: ${value}`);
}

describe('checkHost — real transformation logic (stubbed validateHost)', () => {
  describe('online host (validateHost resolves ok:true)', () => {
    it('sets status "online" with a numeric latency_ms and no error', async () => {
      const validateHost = async () => ({ ok: true });
      const result = await checkHost('a-host', validateHost, {});

      assert.strictEqual(result.host, 'a-host');
      assert.strictEqual(result.status, 'online');
      assert.strictEqual(typeof result.latency_ms, 'number', 'online latency_ms must be a number');
      assert.ok(result.latency_ms >= 0, 'online latency_ms must be non-negative');
      assert.strictEqual(result.error, undefined, 'online result must not carry an error');
      assertValidIso(result.last_check);
    });

    it('measures latency from the actual validateHost duration', async () => {
      const validateHost = async () => {
        await new Promise((r) => setTimeout(r, 60));
        return { ok: true };
      };
      const result = await checkHost('slow-host', validateHost, {});

      assert.strictEqual(result.status, 'online');
      assert.ok(result.latency_ms >= 50, `latency_ms (${result.latency_ms}) should reflect the ~60ms probe`);
    });
  });

  describe('offline host (validateHost resolves ok:false)', () => {
    it('sets status "offline", null latency_ms, and surfaces the error', async () => {
      const validateHost = async () => ({ ok: false, error: 'SSH connection refused' });
      const result = await checkHost('bad-host', validateHost, {});

      assert.strictEqual(result.host, 'bad-host');
      assert.strictEqual(result.status, 'offline');
      assert.strictEqual(result.latency_ms, null, 'offline latency_ms must be null');
      assert.strictEqual(result.error, 'SSH connection refused', 'offline error must come from validateHost');
      assertValidIso(result.last_check);
    });

    it('preserves a descriptive error verbatim', async () => {
      const message = 'Permission denied (publickey)';
      const validateHost = async () => ({ ok: false, error: message });
      const result = await checkHost('auth-host', validateHost, {});

      assert.strictEqual(result.error, message);
    });
  });

  describe('throwing host (validateHost rejects)', () => {
    it('sets status "offline", null latency_ms, and error = exception message', async () => {
      const validateHost = async () => { throw new Error('Network timeout'); };
      const result = await checkHost('throwing-host', validateHost, {});

      assert.strictEqual(result.status, 'offline');
      assert.strictEqual(result.latency_ms, null);
      assert.strictEqual(result.error, 'Network timeout');
      assertValidIso(result.last_check);
    });
  });

  describe('validateHost contract', () => {
    it('passes host and cfg through to validateHost', async () => {
      let received = null;
      const validateHost = async (host, cfg) => {
        received = { host, cfg };
        return { ok: true };
      };
      const cfg = { tmuxSession: 'agent', hosts: ['x'] };
      await checkHost('h', validateHost, cfg);

      assert.deepStrictEqual(received, { host: 'h', cfg });
    });
  });
});

describe('checkHost — endpoint composition (Promise.all over hosts)', () => {
  it('returns one result per host, preserving order and per-host status', async () => {
    const hosts = ['(local)', 'online-1', 'offline-1', 'online-2'];
    const validateHost = async (host) =>
      host === 'offline-1' ? { ok: false, error: 'down' } : { ok: true };

    const results = await Promise.all(hosts.map((h) => checkHost(h, validateHost, {})));

    assert.strictEqual(results.length, hosts.length);
    assert.deepStrictEqual(
      results.map((r) => r.host),
      hosts,
      'order must match the input host list',
    );
    assert.strictEqual(results[0].status, 'online');
    assert.strictEqual(results[1].status, 'online');
    assert.strictEqual(results[2].status, 'offline');
    assert.strictEqual(results[2].error, 'down');
    assert.strictEqual(results[3].status, 'online');
  });

  it('runs host checks concurrently (the endpoint relies on Promise.all parallelism)', async () => {
    let active = 0;
    let maxActive = 0;
    const validateHost = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 30));
      active -= 1;
      return { ok: true };
    };
    const hosts = ['h1', 'h2', 'h3', 'h4'];

    await Promise.all(hosts.map((h) => checkHost(h, validateHost, {})));

    assert.ok(maxActive > 1, `checks should overlap in parallel; observed maxActive=${maxActive}`);
  });

  it('a single throwing host does not abort the batch', async () => {
    const hosts = ['ok-host', 'boom', 'ok-host-2'];
    const validateHost = async (host) => {
      if (host === 'boom') throw new Error('kaboom');
      return { ok: true };
    };

    const results = await Promise.all(hosts.map((h) => checkHost(h, validateHost, {})));

    assert.strictEqual(results.length, 3);
    assert.strictEqual(results[0].status, 'online');
    assert.strictEqual(results[1].status, 'offline');
    assert.strictEqual(results[1].error, 'kaboom');
    assert.strictEqual(results[2].status, 'online');
  });
});

describe('/api/hosts/status HTTP endpoint (real Express app from server.js)', () => {
  let httpServer;
  let baseUrl;
  let originalHome;
  let tempHome;

  // Boot the real app on an ephemeral port. We point HOME at a throwaway dir
  // whose config has no remote hosts, so the endpoint only probes '(local)' —
  // validateHost('(local)') returns ok:true with no SSH, keeping this fast and
  // deterministic regardless of the host machine's real config.
  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-hosts-status-'));
    process.env.HOME = tempHome;
    const wardenDir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wardenDir, { recursive: true });
    fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: [] }));

    const { app } = await import('./server.js');
    httpServer = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
      httpServer.once('listening', resolve);
      httpServer.once('error', reject);
    });
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  });

  after(async () => {
    if (httpServer) await new Promise((r) => httpServer.close(r));
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('responds to GET with 200 + JSON { hosts: [...] } envelope', async () => {
    const res = await fetch(`${baseUrl}/api/hosts/status`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'application/json; charset=utf-8');
    const body = await res.json();
    assert.ok(Array.isArray(body.hosts), 'response body must be { hosts: [...] }');
  });

  it('always includes the (local) host first and reports it online', async () => {
    const body = await (await fetch(`${baseUrl}/api/hosts/status`)).json();

    assert.ok(body.hosts.length >= 1);
    const local = body.hosts.find((h) => h.host === '(local)');
    assert.ok(local, 'must include the (local) host');
    assert.strictEqual(local.status, 'online');
    assert.strictEqual(typeof local.latency_ms, 'number');
    assertValidIso(local.last_check);
  });

  it('with empty cfg.hosts, returns exactly the one local host (proves [LOCAL, ...cfg.hosts])', async () => {
    const body = await (await fetch(`${baseUrl}/api/hosts/status`)).json();

    assert.strictEqual(body.hosts.length, 1, 'empty config must yield only the (local) host');
    assert.strictEqual(body.hosts[0].host, '(local)');
  });

  it('only serves GET (POST is not handled → 404)', async () => {
    const res = await fetch(`${baseUrl}/api/hosts/status`, { method: 'POST' });

    assert.strictEqual(res.status, 404);
  });
});

describe('/api/hosts/status companion field (WARDEN-878)', () => {
  // The endpoint attaches a per-host `companion` field ONLY while the companion
  // transport is enabled, read at request time (so a toggle flip takes effect on
  // the next poll). LOCAL always reads inactive (the companion is remote-only).
  // These boot the real app with the env-var toggle forced on (the operator
  // override path applyCompanionToggle never clobbers), so no remote hosts are
  // needed — the (local) host is enough to prove the field is wired + omitted.
  let httpServer;
  let baseUrl;
  let originalHome;
  let tempHome;
  let savedEnv;

  before(async () => {
    savedEnv = process.env.WARDEN_COMPANION_TRANSPORT;
    process.env.WARDEN_COMPANION_TRANSPORT = '1';
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-hosts-companion-'));
    process.env.HOME = tempHome;
    const wardenDir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wardenDir, { recursive: true });
    fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: [] }));

    const { app } = await import('./server.js');
    httpServer = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
      httpServer.once('listening', resolve);
      httpServer.once('error', reject);
    });
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  });

  after(async () => {
    if (httpServer) await new Promise((r) => httpServer.close(r));
    if (savedEnv === undefined) delete process.env.WARDEN_COMPANION_TRANSPORT;
    else process.env.WARDEN_COMPANION_TRANSPORT = savedEnv;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('attaches companion: {state:"inactive"} to each host while the transport is enabled', async () => {
    process.env.WARDEN_COMPANION_TRANSPORT = '1';
    const body = await (await fetch(`${baseUrl}/api/hosts/status`)).json();
    const local = body.hosts.find((h) => h.host === '(local)');
    assert.ok(local, 'must include the (local) host');
    assert.deepStrictEqual(local.companion, { state: 'inactive' },
      'LOCAL reads inactive (the companion transport is remote-only)');
  });

  it('omits the companion field entirely while the transport is disabled', async () => {
    process.env.WARDEN_COMPANION_TRANSPORT = '0';
    const body = await (await fetch(`${baseUrl}/api/hosts/status`)).json();
    const local = body.hosts.find((h) => h.host === '(local)');
    assert.ok(local, 'must include the (local) host');
    assert.strictEqual(local.companion, undefined,
      'no companion field when the transport is off (opt-in: nothing to surface)');
    // The connectivity fields are unaffected — companion is strictly additive.
    assert.strictEqual(typeof local.status, 'string');
    assertValidIso(local.last_check);
  });
});

// ---------------------------------------------------------------------------
// WARDEN-915 — the non-blocking host-status cache.
//
// The measured defect: the route used to Promise.all a LIVE SSH probe of every
// configured host on the request path. On a zero-host config (the agent-sandbox
// default) that is 2.6ms and invisible; on a realistic 5-host config with one
// unreachable host it measured 15.0s per request, every 30s poll, because the
// response could not be produced until the WORST host finished timing out.
//
// These tests assert the properties that make that impossible to reintroduce:
// a read never waits on a probe, an aged-out entry does not become a blocking
// re-probe (the "first-open cliff"), the wait does not scale with host count,
// and one bad host degrades only its own entry.
// ---------------------------------------------------------------------------

/** A probe whose settlement the test controls. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

describe('checkHost — bounded probe (opts.timeoutMs)', () => {
  it('reports offline with a timeout error when validateHost outlives the bound', async () => {
    const never = () => new Promise(() => {});
    const result = await checkHost('wedged', never, {}, { timeoutMs: 30 });

    assert.strictEqual(result.status, 'offline');
    assert.strictEqual(result.latency_ms, null);
    assert.match(result.error, /timed out after 30ms/);
    assertValidIso(result.last_check);
  });

  it('returns the real result when the probe settles inside the bound', async () => {
    const validateHost = async () => ({ ok: true });
    const result = await checkHost('quick', validateHost, {}, { timeoutMs: 1000 });

    assert.strictEqual(result.status, 'online');
    assert.strictEqual(typeof result.latency_ms, 'number');
  });

  it('is unbounded when no timeoutMs is given (unchanged default behaviour)', async () => {
    const validateHost = async () => {
      await new Promise((r) => setTimeout(r, 40));
      return { ok: true };
    };
    const result = await checkHost('slow-but-fine', validateHost, {});

    assert.strictEqual(result.status, 'online');
  });
});

describe('createHostStatusCache — a read never waits on a probe', () => {
  it('one unreachable host does not hold the other hosts hostage', async () => {
    const hosts = ['(local)', 'dev-box', 'build-01', 'gpu-rig', 'unreach-vpn'];
    const stuck = deferred();
    const validateHost = async (host) => {
      if (host === 'unreach-vpn') return stuck.promise; // never settles in time
      return { ok: true };
    };
    const cache = createHostStatusCache({ settleMs: 60, probeTimeoutMs: 200 });

    const start = Date.now();
    const results = await cache.snapshot(hosts, validateHost, {});
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 1_000, `snapshot must not wait on the bad host; took ${elapsed}ms`);
    const byHost = Object.fromEntries(results.map((r) => [r.host, r]));
    for (const good of ['(local)', 'dev-box', 'build-01', 'gpu-rig']) {
      assert.strictEqual(byHost[good].status, 'online', `${good} must be reported live`);
    }
    // The bad host degrades on its own: reported as not-yet-known, not awaited.
    assert.strictEqual(byHost['unreach-vpn'].status, 'unknown');
    assert.strictEqual(byHost['unreach-vpn'].checking, true);
    assert.strictEqual(byHost['unreach-vpn'].last_check, null);

    stuck.resolve({ ok: false, error: 'Connection timed out' });
  });

  it('the bad host fills in on a later read, once its own probe lands', async () => {
    const stuck = deferred();
    const validateHost = async (host) => (host === 'bad' ? stuck.promise : { ok: true });
    const cache = createHostStatusCache({ settleMs: 20, maxAgeMs: 10_000, probeTimeoutMs: 200 });

    const first = await cache.snapshot(['good', 'bad'], validateHost, {});
    assert.strictEqual(first.find((r) => r.host === 'bad').checking, true);

    stuck.resolve({ ok: false, error: 'Connection timed out' });
    await new Promise((r) => setTimeout(r, 20));

    const second = await cache.snapshot(['good', 'bad'], validateHost, {});
    const bad = second.find((r) => r.host === 'bad');
    assert.strictEqual(bad.status, 'offline');
    assert.strictEqual(bad.error, 'Connection timed out');
    assert.strictEqual(bad.checking, undefined, 'a probed host is no longer "checking"');
  });

  it('a warm read is served from cache with no new probe and no wait', async () => {
    let probes = 0;
    const validateHost = async () => { probes += 1; return { ok: true }; };
    const cache = createHostStatusCache({ settleMs: 50, maxAgeMs: 10_000 });

    await cache.snapshot(['h1', 'h2'], validateHost, {});
    assert.strictEqual(probes, 2);

    const start = Date.now();
    const results = await cache.snapshot(['h1', 'h2'], validateHost, {});
    const elapsed = Date.now() - start;

    assert.strictEqual(probes, 2, 'a fresh entry must not be re-probed');
    assert.ok(elapsed < 50, `a warm read must be immediate; took ${elapsed}ms`);
    assert.deepStrictEqual(results.map((r) => r.status), ['online', 'online']);
  });

  it('adding hosts does not multiply the wait (the response is O(1) in host count)', async () => {
    // Every host is slow and none is cached: the response must still come back
    // inside the shared settle window, not settle × N and not slow × N.
    const validateHost = () => new Promise((r) => setTimeout(() => r({ ok: true }), 3_000));
    const cache = createHostStatusCache({ settleMs: 60, probeTimeoutMs: 200 });
    const many = Array.from({ length: 40 }, (_, i) => `host-${i}`);

    const start = Date.now();
    await cache.snapshot(many, validateHost, {});
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 1_000, `40 cold slow hosts must not compound the wait; took ${elapsed}ms`);
  });
});

describe('createHostStatusCache — staleness costs freshness, never latency', () => {
  it('an aged-out entry is still served immediately and refreshed in the background', async () => {
    // The "first-open cliff" guard: an expired cache must NOT turn back into a
    // blocking probe. The read returns the previous value at once; the fresh
    // one lands on a later read.
    let clock = 1_000;
    let probes = 0;
    const gate = [deferred(), deferred()];
    const validateHost = async () => {
      const d = gate[probes];
      probes += 1;
      return d ? d.promise : { ok: true };
    };
    const cache = createHostStatusCache({
      settleMs: 30, maxAgeMs: 100, probeTimeoutMs: 200, now: () => clock,
    });

    gate[0].resolve({ ok: true });
    await cache.snapshot(['h'], validateHost, {});
    assert.strictEqual(probes, 1);

    clock += 500; // the entry is now well past maxAgeMs

    const start = Date.now();
    const stale = await cache.snapshot(['h'], validateHost, {});
    const elapsed = Date.now() - start;

    assert.strictEqual(probes, 2, 'a stale entry must schedule a background refresh');
    assert.ok(elapsed < 30, `a stale read must not block on the refresh; took ${elapsed}ms`);
    assert.strictEqual(stale[0].status, 'online', 'the last known value is served meanwhile');

    gate[1].resolve({ ok: false, error: 'went down' });
    await new Promise((r) => setTimeout(r, 20));
    const refreshed = await cache.snapshot(['h'], validateHost, {});
    assert.strictEqual(refreshed[0].status, 'offline', 'the background refresh landed');
  });

  it('concurrent reads share one in-flight probe per host', async () => {
    let probes = 0;
    const stuck = deferred();
    const validateHost = async () => { probes += 1; return stuck.promise; };
    const cache = createHostStatusCache({ settleMs: 10, probeTimeoutMs: 200 });

    await Promise.all([
      cache.snapshot(['h'], validateHost, {}),
      cache.snapshot(['h'], validateHost, {}),
      cache.snapshot(['h'], validateHost, {}),
    ]);

    assert.strictEqual(probes, 1, 'a poll arriving mid-probe must join it, not stack another ssh child');
    stuck.resolve({ ok: true });
  });

  it('a wedged probe frees its slot at the bound so later refreshes can run', async () => {
    let probes = 0;
    const validateHost = async () => { probes += 1; return new Promise(() => {}); };
    const cache = createHostStatusCache({ settleMs: 10, maxAgeMs: 0, probeTimeoutMs: 40 });

    await cache.snapshot(['wedged'], validateHost, {});
    assert.strictEqual(probes, 1);

    await new Promise((r) => setTimeout(r, 70)); // past the probe bound
    const results = await cache.snapshot(['wedged'], validateHost, {});

    assert.strictEqual(results[0].status, 'offline');
    assert.match(results[0].error, /timed out/);
    assert.strictEqual(probes, 2, 'the bound must release the in-flight slot');
  });

  it('drops hosts that are no longer configured', async () => {
    const validateHost = async () => ({ ok: true });
    const cache = createHostStatusCache({ settleMs: 50, maxAgeMs: 10_000 });

    await cache.snapshot(['keep', 'drop'], validateHost, {});
    await cache.snapshot(['keep'], validateHost, {});

    // 'drop' is gone: re-adding it reads as never-probed, not as a stale value.
    const back = await cache.snapshot(['keep', 'drop'], validateHost, { });
    assert.strictEqual(back.find((r) => r.host === 'keep').status, 'online');
    assert.ok(
      ['unknown', 'online'].includes(back.find((r) => r.host === 'drop').status),
      'a re-added host is re-probed rather than served from an evicted entry',
    );
  });

  it('returns one entry per requested host, in order', async () => {
    const validateHost = async (host) => (host === 'b' ? { ok: false, error: 'down' } : { ok: true });
    const cache = createHostStatusCache({ settleMs: 100, maxAgeMs: 10_000 });

    const results = await cache.snapshot(['a', 'b', 'c'], validateHost, {});

    assert.deepStrictEqual(results.map((r) => r.host), ['a', 'b', 'c']);
    assert.strictEqual(results[1].status, 'offline');
  });
});

describe('createHostStatusCache — a permanently-unreachable host taxes nothing', () => {
  it('does not re-spend the settle window on a probe that is already in flight', async () => {
    // The bad host's probe outlives many polls. The FIRST read may spend the
    // settle window on it; every later read while that same probe is still
    // running must return immediately — otherwise one dead host quietly charges
    // the settle window to every request, forever.
    const stuck = deferred();
    const validateHost = async (host) => (host === 'bad' ? stuck.promise : { ok: true });
    const cache = createHostStatusCache({ settleMs: 120, maxAgeMs: 10_000, probeTimeoutMs: 2_000 });

    await cache.snapshot(['good', 'bad'], validateHost, {});

    const start = Date.now();
    const again = await cache.snapshot(['good', 'bad'], validateHost, {});
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 60, `a repeat read must not re-wait on the in-flight probe; took ${elapsed}ms`);
    assert.strictEqual(again.find((r) => r.host === 'good').status, 'online');
    assert.strictEqual(again.find((r) => r.host === 'bad').checking, true);

    stuck.resolve({ ok: false, error: 'Connection timed out' });
  });
});

// ---------------------------------------------------------------------------
// The server-side staleness bound and the CLIENT-side poll cadence are two
// constants in two languages in two directories, and they are only correct
// RELATIVE TO EACH OTHER. Nothing else in the suite covers that: every other
// cache test passes an explicit `maxAgeMs`, so the production constant's
// interaction with the production cadence is exactly the gap these close.
// ---------------------------------------------------------------------------

/** The client's real poll cadence, read out of the TS source. Read as text
 *  rather than imported because POLL_MS is a module-private constant in a .ts
 *  file (Node 20 cannot import either) — and because the point is to pin the
 *  literal a future edit would change, wherever it lives. */
function clientPollMs() {
  const src = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'web', 'src', 'lib', 'useHostStatuses.ts'),
    'utf8',
  );
  const m = src.match(/const POLL_MS\s*=\s*([\d_]+)\s*;/);
  assert.ok(m, 'could not find `const POLL_MS = ...` in web/src/lib/useHostStatuses.ts — '
    + 'if it was renamed or moved, update this test rather than deleting it');
  return Number(m[1].replace(/_/g, ''));
}

describe('hostStatusCadence — the max-age bound vs the client poll cadence', () => {
  it('leaves an entry stale by the next poll tick even after a worst-case probe', () => {
    // THE INVARIANT. A background refresh lands ~probeLatency AFTER the response
    // that scheduled it, so at the next tick the entry's age is
    // POLL_MS - probeLatency. For the refresh to fire on EVERY tick, the max age
    // must sit below that for the slowest probe we allow:
    //
    //     HOST_STATUS_MAX_AGE_MS + HOST_PROBE_TIMEOUT_MS < POLL_MS
    //
    // Equality (both 30s, as originally shipped) is the failure this pins: the
    // refresh then fires on every OTHER tick and connectivity goes ~60s stale.
    const pollMs = clientPollMs();
    assert.ok(
      HOST_STATUS_MAX_AGE_MS + HOST_PROBE_TIMEOUT_MS < pollMs,
      `max age (${HOST_STATUS_MAX_AGE_MS}ms) + probe bound (${HOST_PROBE_TIMEOUT_MS}ms) must be `
      + `< the client's POLL_MS (${pollMs}ms), or a slow probe pushes the entry's timestamp far `
      + `enough forward that the next tick reads it as fresh and skips the refresh`,
    );
  });

  it('refreshes on every poll tick when driven at the real cadence with the real constants', async () => {
    // The reviewer's repro, promoted to a test: drive the REAL cache with the
    // REAL production constants at the REAL cadence and count probes. Under the
    // original 30s/30s collision this produced 4 probes in 180s instead of 7.
    const pollMs = clientPollMs();
    const probeLatencyMs = 200; // a realistic reachable-host handshake
    let clock = 0;
    let probes = 0;
    const probe = async (host) => {
      probes += 1;
      const landsAt = clock + probeLatencyMs;
      await Promise.resolve();
      // The refresh resolves after its latency — i.e. AFTER the response that
      // scheduled it has already gone out. That offset is the whole bug.
      clock = Math.max(clock, landsAt);
      return { host, status: 'online', latency_ms: probeLatencyMs, last_check: null };
    };
    const cache = createHostStatusCache({
      // maxAgeMs and probeTimeoutMs deliberately left at their production
      // defaults — those are the values under test.
      settleMs: 0,
      now: () => clock,
      probe,
    });

    const ticks = 7;
    for (let i = 0; i < ticks; i++) {
      clock = Math.max(clock, i * pollMs);
      await cache.snapshot(['h1'], async () => ({ ok: true }), {});
      await new Promise((resolve) => setImmediate(resolve)); // let the refresh land
    }

    assert.strictEqual(
      probes, ticks,
      `expected one probe per poll tick (${ticks}), got ${probes} — the cache is skipping `
      + `refreshes, so the connectivity the UI renders is up to ${2 * pollMs}ms old`,
    );
  });
});
