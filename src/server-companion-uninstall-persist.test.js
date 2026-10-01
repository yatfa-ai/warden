// WARDEN-1495 — pin the DISK-persist leg of POST /api/companion/uninstall
// (src/server.js, the `await save(cfg)` after recordCompanionUninstall).
//
// WARDEN-1475 made an operator's "Remove companion" durable. The in-memory half
// (recordCompanionUninstall) is covered by companion-uninstall-durable.test.js;
// the route's DISK write — the half that survives a restart — was reached by no
// test, because server-companion-uninstall.test.js assumed the success path is
// unreachable without a real ssh. It is reachable: a fake `ssh` script on PATH
// (the pattern server-pane-project.test.js / git-container.test.js use) lets
// validateHost and the uninstall run succeed, so the route reaches `save`.
//
// Deleting `await save(cfg)` from the route turns tests 1 and 3 red here
// (mutation-checked); dropping the `!result.ok` early return turns test 2 red.
// We deliberately do NOT assert afterSave's side effect on its own (it is
// behaviorally invisible here: the live gate is applied inside uninstallCompanion).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('POST /api/companion/uninstall — WARDEN-1495 (persist leg, fake ssh on PATH)', () => {
  let httpServer, baseUrl;
  let originalHome, originalPath, tempHome, configPath;

  const post = (body) => fetch(`${baseUrl}/api/companion/uninstall`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const diskExcluded = () =>
    JSON.parse(fs.readFileSync(configPath, 'utf8')).companionExcludedHosts ?? [];

  before(async () => {
    originalHome = process.env.HOME;
    originalPath = process.env.PATH;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-uninstall-persist-'));
    process.env.HOME = tempHome;

    // Fake ssh: succeeds for everything (validateHost's `echo OK`, the uninstall
    // script) EXCEPT a removal (`rm`) aimed at the designated bad host, which
    // fails with stderr `boom`.
    const binDir = path.join(tempHome, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      path.join(binDir, 'ssh'),
      '#!/bin/sh\n' +
      'all="$*"\n' +
      'case "$all" in\n' +
      '  *badhost*) case "$all" in *rm*) echo boom >&2; exit 1 ;; esac ;;\n' +
      'esac\n' +
      'echo OK\nexit 0\n',
    );
    fs.chmodSync(path.join(binDir, 'ssh'), 0o755);
    process.env.PATH = `${binDir}:${originalPath}`;

    const wdir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wdir, { recursive: true });
    configPath = path.join(wdir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ hosts: ['h1', 'badhost'] }) + '\n');

    // Dynamic import AFTER HOME/PATH are set → configPath resolves under tempHome.
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
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('a successful removal answers 200 {ok:true, excluded:true} AND writes the exclusion to config.json on disk', async () => {
    const r = await post({ host: 'h1' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(await r.json(), { ok: true, excluded: true });
    assert.deepStrictEqual(diskExcluded(), ['h1'],
      'the removal is on DISK (survives a restart), not only in memory');
  });

  it('a failed removal answers 500 {error} and persists nothing for that host', async () => {
    const r = await post({ host: 'badhost' });
    assert.strictEqual(r.status, 500);
    assert.deepStrictEqual(await r.json(), { error: 'boom' });
    assert.ok(!diskExcluded().includes('badhost'),
      'a removal that failed must not record a no-bootstrap fact on disk');
  });

  it('re-removing an already-removed host is idempotent: 200 and no duplicate on disk', async () => {
    const r = await post({ host: 'h1' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(await r.json(), { ok: true, excluded: true });
    assert.deepStrictEqual(diskExcluded(), ['h1']);
  });
});
