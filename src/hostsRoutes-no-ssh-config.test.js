import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

/**
 * Failure-arm spec for allSshHosts (src/config.js) and GET /api/ssh-hosts
 * (src/hostsRoutes.js). allSshHosts reads ~/.ssh/config inside a try whose bare
 * `catch` swallows EVERY read error and falls through to `return hosts` — the path
 * a first-run machine with no ~/.ssh/config takes. The contract: an absent or
 * unreadable config resolves [] (never rejects), and the route answers 200
 * {hosts: [], configured} rather than a 500.
 *
 * The parse half (wildcards skipped, duplicates collapsed, case-insensitive `Host`)
 * is pinned in hostsRoutes.test.js and deliberately NOT re-tested here; that suite
 * always writes a config file, so it never reaches the catch arm.
 *
 * os.homedir() reads $HOME on every call, so HOME is swapped to a fresh temp dir per
 * example. EACCES is deliberately not asserted: the sandbox runs as root, so the
 * permission arm is not portably reproducible.
 */

describe('allSshHosts / GET /api/ssh-hosts without a usable ~/.ssh/config', () => {
  let originalHome, tempHome, allSshHosts;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-nosshcfg-'));
    process.env.HOME = tempHome;
    ({ allSshHosts } = await import('./config.js'));
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('resolves [] when ~/.ssh does not exist at all (ENOENT)', async () => {
    assert.deepStrictEqual(await allSshHosts(), []);
  });

  it('resolves [] when ~/.ssh exists but holds no config file', async () => {
    fs.mkdirSync(path.join(tempHome, '.ssh'));
    assert.deepStrictEqual(await allSshHosts(), []);
  });

  it('resolves [] when ~/.ssh/config is a directory (EISDIR)', async () => {
    fs.mkdirSync(path.join(tempHome, '.ssh', 'config'), { recursive: true });
    assert.deepStrictEqual(await allSshHosts(), []);
  });

  it('resolves [] when ~/.ssh is itself a regular file (ENOTDIR)', async () => {
    fs.writeFileSync(path.join(tempHome, '.ssh'), 'not a directory');
    assert.deepStrictEqual(await allSshHosts(), []);
  });

  it('resolves [] for an existing empty config (control: zero Host lines)', async () => {
    fs.mkdirSync(path.join(tempHome, '.ssh'));
    fs.writeFileSync(path.join(tempHome, '.ssh', 'config'), '');
    assert.deepStrictEqual(await allSshHosts(), []);
  });

  it('GET /api/ssh-hosts answers 200 {hosts: [], configured} — not a 500 — with no ssh config', async () => {
    const { createHostsRouter } = await import('./hostsRoutes.js');
    const app = express();
    app.use(createHostsRouter({ cfg: { hosts: ['build-box'] }, local: '(local)' }));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/ssh-hosts`);
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(await res.json(), { hosts: [], configured: ['build-box'] });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
