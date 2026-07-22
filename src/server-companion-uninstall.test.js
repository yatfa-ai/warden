// HTTP tests for POST /api/companion/uninstall (WARDEN-882 — the Removability
// outcome of roadmap WARDEN-270).
//
// The endpoint is a thin guard + delegation layer: validate the host, reject
// LOCAL, then call uninstallCompanion. The uninstall execution itself
// (channel teardown + the rm/pkill/rmdir script over the raw-ssh path) is
// covered exhaustively by the deps-injection unit tests in companion.test.js.
// HERE we pin the HTTP-layer contract the ticket's ⚠️ host-validation note
// calls out:
//   - a remote host is required (missing host → 400);
//   - LOCAL/(local) is rejected (the companion serves remote hosts only);
//   - the host is validated with validateHost (the helper /api/hosts/health
//     uses), NOT resolve() — so an unreachable host surfaces a clear
//     connectivity 400 rather than an opaque 500 from the uninstall run.
//
// These are sandbox-runnable: validateHost fails fast when ssh is absent
// (spawn ENOENT), so the unreachable-host case returns in milliseconds with no
// real connection attempt. node --test runs each file in its own process, so
// the HOME/PATH shenanigans don't leak.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('POST /api/companion/uninstall — WARDEN-882 (HTTP guards)', () => {
  let httpServer, baseUrl;
  let originalHome, tempHome;

  const post = (body) => fetch(`${baseUrl}/api/companion/uninstall`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-uninstall-http-'));
    process.env.HOME = tempHome;
    const wdir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wdir, { recursive: true });
    fs.writeFileSync(path.join(wdir, 'config.json'), JSON.stringify({ hosts: [] }) + '\n');

    // Dynamic import AFTER HOME is set → configPath resolves under tempHome.
    const { app } = await import('./server.js');
    httpServer = app.listen(0, '127.0.0.1');
    await new Promise((res, rej) => {
      httpServer.once('listening', res);
      httpServer.once('error', rej);
    });
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  });

  after(async () => {
    if (httpServer) await new Promise((r) => httpServer.close(r));
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('rejects a missing host with 400 {error}', async () => {
    const r = await post({});
    assert.strictEqual(r.status, 400);
    const body = await r.json();
    assert.ok(body.error, 'returns an error message');
    assert.ok(/remote host/i.test(body.error), `names the requirement: ${body.error}`);
  });

  it('rejects LOCAL — the companion serves remote hosts only (400 {error})', async () => {
    const r = await post({ host: '(local)' });
    assert.strictEqual(r.status, 400);
    const body = await r.json();
    assert.ok(/remote host/i.test(body.error), `LOCAL refusal: ${body.error}`);
  });

  it('validates the host with validateHost: an unreachable host is a clear 400, not a 500', async () => {
    // ssh is absent in this sandbox → validateHost fails fast (spawn ENOENT) and
    // returns {ok:false}. The endpoint must surface that as a 400 connectivity
    // error BEFORE attempting the uninstall — proving the validateHost gate the
    // ticket's ⚠️ note specifies (NOT resolve(), which resolves a chat id).
    const t0 = Date.now();
    const r = await post({ host: 'some-nonexistent-host-xyz' });
    const elapsed = Date.now() - t0;
    assert.strictEqual(r.status, 400, 'unreachable host → 400 (not 500, not a hang)');
    const body = await r.json();
    assert.ok(body.error, 'returns an error message');
    assert.ok(elapsed < 30000, `fails fast (validateHost short-circuits): ${elapsed}ms`);
  });
});
