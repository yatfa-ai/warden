import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { checkHost } from './hostStatus.js';

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
