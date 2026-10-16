import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

/**
 * Router-level spec for createHostsRouter (src/hostsRoutes.js, moved out of
 * server.js by WARDEN-1829). The sibling suites (server-hosts-status,
 * server-companion-probe, companion-totality) pin the probe routing, the cache and
 * the local-first host order. This file pins what they leave open:
 *   - GET /api/ssh-hosts: aliases scraped from ~/.ssh/config AND the `configured`
 *     key (= cfg.hosts);
 *   - GET /api/hosts/health: default host list, the `?hosts=` array override (a lone
 *     string is ignored), the `{host, ...result}` spread and the numeric `timestamp`;
 *   - GET /api/hosts/status: the `[local, ...cfg.hosts]` order, and the per-request
 *     companion toggle — including that flipping it back off leaves no stale
 *     `companion` field on the cached snapshot objects.
 *
 * The router is mounted on a bare express app (no server.js). HOME is swapped to a
 * temp dir holding a hand-written ~/.ssh/config BEFORE the dynamic imports, since
 * config.js / ssh.js read os.homedir(). Remote hosts are never expected to be
 * reachable: the assertions only rely on the shape (ok:false + string error), so
 * they hold whether or not an ssh binary exists.
 */

const LOCAL = '(local)';

describe('createHostsRouter (bare express app)', () => {
  let originalHome, originalTransport, tempHome;
  let server, baseUrl, emptyServer, emptyUrl;
  const CFG_HOSTS = ['cfg-host-a', 'cfg-host-b'];

  const listen = (app) =>
    new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
  const get = async (base, p) => {
    const res = await fetch(`${base}${p}`);
    return { status: res.status, body: await res.json() };
  };

  before(async () => {
    originalHome = process.env.HOME;
    originalTransport = process.env.WARDEN_COMPANION_TRANSPORT;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-hostsroutes-'));
    fs.mkdirSync(path.join(tempHome, '.ssh'), { recursive: true });
    fs.writeFileSync(
      path.join(tempHome, '.ssh', 'config'),
      [
        'Host alpha',
        '  HostName 10.0.0.1',
        'host beta gamma',
        'HOST alpha',
        'Host *',
        '  ServerAliveInterval 30',
        'Host wild* q?x delta',
        '',
      ].join('\n'),
    );
    process.env.HOME = tempHome;
    process.env.WARDEN_COMPANION_TRANSPORT = '0';

    const { createHostsRouter } = await import('./hostsRoutes.js');
    const app = express();
    app.use(createHostsRouter({ cfg: { hosts: CFG_HOSTS }, local: LOCAL }));
    server = await listen(app);
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const emptyApp = express();
    emptyApp.use(createHostsRouter({ cfg: { hosts: [] }, local: LOCAL }));
    emptyServer = await listen(emptyApp);
    emptyUrl = `http://127.0.0.1:${emptyServer.address().port}`;
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    await new Promise((r) => emptyServer.close(r));
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalTransport === undefined) delete process.env.WARDEN_COMPANION_TRANSPORT;
    else process.env.WARDEN_COMPANION_TRANSPORT = originalTransport;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  describe('GET /api/ssh-hosts', () => {
    it('lists ssh-config aliases (wildcards skipped, duplicates collapsed, keyword case-insensitive) and echoes cfg.hosts as `configured`', async () => {
      const { status, body } = await get(baseUrl, '/api/ssh-hosts');
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(body.hosts, ['alpha', 'beta', 'gamma', 'delta']);
      assert.deepStrictEqual(body.configured, CFG_HOSTS);
    });
  });

  describe('GET /api/hosts/health', () => {
    it('probes cfg.hosts in order by default, each unreachable remote as {host, ok:false, error:string}', async () => {
      const { status, body } = await get(baseUrl, '/api/hosts/health');
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(body.hosts.map((h) => h.host), CFG_HOSTS);
      for (const h of body.hosts) {
        assert.strictEqual(h.ok, false);
        assert.strictEqual(typeof h.error, 'string');
      }
    });

    it('stamps a numeric timestamp inside the call window', async () => {
      const before = Date.now();
      const { body } = await get(baseUrl, '/api/hosts/health');
      const after = Date.now();
      assert.strictEqual(typeof body.timestamp, 'number');
      assert.ok(body.timestamp >= before && body.timestamp <= after, `timestamp ${body.timestamp} outside [${before}, ${after}]`);
    });

    it('?hosts= repeated overrides cfg.hosts in order; (local) is ok:true with the host spread in', async () => {
      const { body } = await get(baseUrl, '/api/hosts/health?hosts=(local)&hosts=other-host');
      assert.deepStrictEqual(body.hosts.map((h) => h.host), [LOCAL, 'other-host']);
      assert.deepStrictEqual(body.hosts[0], { host: LOCAL, ok: true });
      assert.strictEqual(body.hosts[1].ok, false);
    });

    it('a single ?hosts=x (a string, not an array) is ignored and falls back to cfg.hosts', async () => {
      const { status, body } = await get(baseUrl, '/api/hosts/health?hosts=lone-host');
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(body.hosts.map((h) => h.host), CFG_HOSTS);
    });
  });

  describe('GET /api/hosts/status', () => {
    it('serves [local, ...cfg.hosts] in that order, local online, and omits `companion` while the toggle is off', async () => {
      process.env.WARDEN_COMPANION_TRANSPORT = '0';
      const { status, body } = await get(baseUrl, '/api/hosts/status');
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(body.hosts.map((h) => h.host), [LOCAL, ...CFG_HOSTS]);
      assert.strictEqual(body.hosts[0].status, 'online');
      for (const h of body.hosts) assert.ok(!('companion' in h), `${h.host} must not carry companion while off`);
    });

    it('toggle on attaches {state:"inactive"} to every host; flipped back off the field is gone again (no stale field on the cached objects)', async () => {
      process.env.WARDEN_COMPANION_TRANSPORT = '1';
      const on = await get(baseUrl, '/api/hosts/status');
      assert.deepStrictEqual(on.body.hosts.map((h) => h.host), [LOCAL, ...CFG_HOSTS]);
      for (const h of on.body.hosts) assert.deepStrictEqual(h.companion, { state: 'inactive' }, `${h.host} companion`);

      process.env.WARDEN_COMPANION_TRANSPORT = '0';
      const off = await get(baseUrl, '/api/hosts/status');
      assert.deepStrictEqual(off.body.hosts.map((h) => h.host), [LOCAL, ...CFG_HOSTS]);
      for (const h of off.body.hosts) assert.ok(!('companion' in h), `${h.host} kept a stale companion field`);
    });

    it('a router over cfg.hosts=[] serves only the local host', async () => {
      process.env.WARDEN_COMPANION_TRANSPORT = '0';
      const { body } = await get(emptyUrl, '/api/hosts/status');
      assert.strictEqual(body.hosts.length, 1);
      assert.strictEqual(body.hosts[0].host, LOCAL);
      assert.strictEqual(body.hosts[0].status, 'online');
    });
  });
});
