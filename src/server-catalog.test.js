import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * Host-aware chat catalog — host+session composite identity (WARDEN-221).
 *
 * The catalog entry already CARRIES host and the read path is already host-aware,
 * but four write/identity sites used to key on `session` alone. Once the same
 * session name can legitimately exist on multiple hosts, a bare-session match
 * either falsely collides (spawn 409) or silently deletes the WRONG host's entry
 * (kill/resume). This file pins down the fix end-to-end.
 *
 * Coverage (the ticket's (a)–(e)):
 *   (a) same session name on a DIFFERENT host spawns past the collision check
 *   (b) /api/kill of host A leaves host B's same-named entry intact
 *   (c) /api/resume on one host doesn't remove the other host's same-named entry
 *   (d) /api/rename targets exactly one host when names repeat across hosts
 *   (e) regression — same-host duplicate still 409s
 * plus pure unit tests of the `sameCatalogEntry` / `catalogKey` helper that all
 * four sites now share.
 *
 * NOTE: we do NOT top-level import ./config.js or ./server.js. `catalogPath` is
 * computed from os.homedir() at module load, so HOME must point at a throwaway dir
 * BEFORE the first import — we dynamic-import inside before(). (node --test runs
 * each file in its own process, so this file's PATH/HOME shenanigans don't leak.)
 */

describe('host-aware chat catalog (host+session composite identity) — WARDEN-221', () => {
  let sameCatalogEntry, catalogKey;
  let httpServer, baseUrl;
  let originalHome, tempHome, catPath;

  // Fixed session names: the temp HOME isolates the catalog file and we clean up
  // any tmux sessions by exact name in after(), so reusing names across runs is safe.
  const SEED_SESSION = 'w221build';
  const RESUME_SID = 'w221abcd';
  const RESUME_SESSION = `resume-${RESUME_SID}`; // the name /api/resume derives from the sid

  function seedCatalog(entries) {
    fs.writeFileSync(catPath, JSON.stringify(entries, null, 2) + '\n');
  }
  function readCatalog() {
    try { return JSON.parse(fs.readFileSync(catPath, 'utf8')); } catch { return []; }
  }
  const json = (body) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-catalog-'));
    process.env.HOME = tempHome;
    const wdir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wdir, { recursive: true });
    fs.writeFileSync(path.join(wdir, 'config.json'), JSON.stringify({ hosts: [] }) + '\n');
    catPath = path.join(wdir, 'chats.json');
    seedCatalog([]);

    // Dynamic import AFTER HOME is set → catalogPath/configPath resolve under tempHome.
    const config = await import('./config.js');
    sameCatalogEntry = config.sameCatalogEntry;
    catalogKey = config.catalogKey;

    const { app } = await import('./server.js');
    httpServer = app.listen(0, '127.0.0.1');
    await new Promise((res, rej) => {
      httpServer.once('listening', res);
      httpServer.once('error', rej);
    });
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  });

  after(async () => {
    // Safety net: kill any tmux sessions these tests spawned — by exact session
    // name (a tmux op), NEVER by command-line pattern (which can kill this agent).
    for (const s of [SEED_SESSION, RESUME_SESSION]) {
      spawnSync('tmux', ['kill-session', '-t', s], { stdio: 'ignore' });
    }
    if (httpServer) await new Promise((r) => httpServer.close(r));
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  // ---- pure unit tests: the composite-identity helper shared by all four sites ----

  it('sameCatalogEntry matches only when BOTH host and session agree', () => {
    const e = { host: 'host-a', session: 'build' };
    assert.ok(sameCatalogEntry(e, 'host-a', 'build'));
    assert.ok(!sameCatalogEntry(e, 'host-b', 'build'), 'a different host must not match');
    assert.ok(!sameCatalogEntry(e, 'host-a', 'ci'), 'a different session must not match');
  });

  it('sameCatalogEntry treats a missing host on either side as local (legacy entries)', () => {
    assert.ok(sameCatalogEntry({ session: 'build' }, '(local)', 'build'), 'legacy entry without host is local');
    assert.ok(sameCatalogEntry({ host: '(local)', session: 'build' }, undefined, 'build'), 'missing host arg defaults to local');
    assert.ok(!sameCatalogEntry({ session: 'build' }, 'host-a', 'build'), 'legacy-local entry is not on host-a');
  });

  it('catalogKey is host:session — the same shape as the runtime chat id', () => {
    assert.strictEqual(catalogKey({ host: 'host-a', session: 'build' }), 'host-a:build');
    assert.strictEqual(catalogKey({ session: 'build' }), '(local):build');
  });

  // ---- HTTP integration: the four catalog identity sites through the real app ----

  it('(e) regression: same session name on the SAME host still 409s', async () => {
    seedCatalog([{ kind: 'tmux', host: '(local)', session: SEED_SESSION, name: SEED_SESSION, cwd: '/tmp', cmd: 'claude' }]);
    const res = await fetch(`${baseUrl}/api/spawn`, json({ host: '(local)', session: SEED_SESSION, cwd: '/tmp', cmd: 'false' }));
    assert.strictEqual(res.status, 409);
    seedCatalog([]);
  });

  it('(a) same session name on a DIFFERENT host spawns past the collision check (no 409)', async () => {
    // host-b already owns the name; spawning it on (local) must pass the now
    // host-scoped collision check. cmd `false` exits immediately so the spawned
    // tmux session dies and buildAndSpawn returns 500. We assert ONLY that it is
    // not a 409 — the exact non-collision status depends on a racy session-liveness
    // check, but "not blocked as a collision" is the headline behavior under test.
    seedCatalog([{ kind: 'tmux', host: 'host-b', session: SEED_SESSION, name: SEED_SESSION, cwd: '/tmp', cmd: 'claude' }]);
    const res = await fetch(`${baseUrl}/api/spawn`, json({ host: '(local)', session: SEED_SESSION, cwd: '/tmp', cmd: 'false' }));
    assert.notStrictEqual(res.status, 409);
    spawnSync('tmux', ['kill-session', '-t', SEED_SESSION], { stdio: 'ignore' });
    seedCatalog([]);
  });

  it('(d) rename targets exactly one host when the name repeats across hosts', async () => {
    seedCatalog([
      { kind: 'tmux', host: '(local)', session: SEED_SESSION, name: 'local-name', cwd: '/tmp', cmd: 'claude' },
      { kind: 'tmux', host: 'host-b', session: SEED_SESSION, name: 'remote-name', cwd: '/tmp', cmd: 'claude' },
    ]);
    const res = await fetch(`${baseUrl}/api/rename`, json({ session: SEED_SESSION, host: '(local)', name: 'renamed-local' }));
    assert.strictEqual(res.status, 200);
    const cat = readCatalog();
    assert.strictEqual(cat.find((c) => c.host === '(local)').name, 'renamed-local');
    assert.strictEqual(cat.find((c) => c.host === 'host-b').name, 'remote-name', 'other host entry untouched');
    seedCatalog([]);
  });

  it('(d) rename without host in body defaults to local and resolves unambiguously', async () => {
    seedCatalog([{ kind: 'tmux', host: '(local)', session: SEED_SESSION, name: 'old', cwd: '/tmp', cmd: 'claude' }]);
    const res = await fetch(`${baseUrl}/api/rename`, json({ session: SEED_SESSION, name: 'new' })); // no host
    assert.strictEqual(res.status, 200);
    assert.strictEqual(readCatalog()[0].name, 'new');
    seedCatalog([]);
  });

  it('(b) /api/kill of host A leaves host B same-named catalog entry intact', async () => {
    seedCatalog([
      { kind: 'tmux', host: '(local)', session: SEED_SESSION, name: 'local', cwd: '/tmp', cmd: 'claude' },
      { kind: 'tmux', host: 'host-b', session: SEED_SESSION, name: 'remote', cwd: '/tmp', cmd: 'claude' },
    ]);
    // resolve('(local):w221build') matches the (local) entry exactly via the
    // host-aware read path; killTmux no-ops on the absent local session; the catalog
    // filter must drop ONLY the (local) entry, leaving host-b's same-named entry.
    const res = await fetch(`${baseUrl}/api/kill`, json({ id: `(local):${SEED_SESSION}` }));
    assert.strictEqual(res.status, 200);
    const cat = readCatalog();
    assert.ok(!cat.some((c) => c.host === '(local)' && c.session === SEED_SESSION), 'host A entry removed');
    assert.ok(cat.some((c) => c.host === 'host-b' && c.session === SEED_SESSION), 'host B entry survives');
    seedCatalog([]);
  });

  it('(c) /api/resume on one host does not remove the other host same-named entry', async () => {
    // /api/resume writes the catalog ONLY on a successful spawn. To reach that
    // write without a real claude, put a `claude` shim on PATH that stays alive (so
    // the post-spawn hasSession check passes). Scoped to this test process and
    // restored in the finally. detectClaude('(local)') honors CLAUDE_CODE_EXECPATH
    // first, so we clear it to force the PATH lookup to find the shim.
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-shim-'));
    const shim = path.join(shimDir, 'claude');
    fs.writeFileSync(shim, '#!/bin/sh\n[ "$1" = "--version" ] && { echo 1.0.0; exit 0; }\nsleep 300\n');
    fs.chmodSync(shim, 0o755);
    const savedPath = process.env.PATH;
    const savedExec = process.env.CLAUDE_CODE_EXECPATH;
    delete process.env.CLAUDE_CODE_EXECPATH;
    process.env.PATH = `${shimDir}:${process.env.PATH || ''}`;

    // host-b already carries the same resume-<sid> session name.
    seedCatalog([{ kind: 'tmux', host: 'host-b', session: RESUME_SESSION, name: 'remote-resume', cwd: '/tmp', cmd: 'claude --resume w221abcd' }]);

    try {
      const res = await fetch(`${baseUrl}/api/resume`, json({ id: RESUME_SID, host: '(local)', cwd: '/tmp' }));
      assert.strictEqual(res.status, 200, `resume should succeed via the shim, got ${res.status}`);
      const cat = readCatalog();
      assert.ok(cat.some((c) => c.host === 'host-b' && c.session === RESUME_SESSION), 'other host entry survives resume');
      assert.ok(cat.some((c) => c.host === '(local)' && c.session === RESUME_SESSION), 'local resume entry written');
    } finally {
      spawnSync('tmux', ['kill-session', '-t', RESUME_SESSION], { stdio: 'ignore' });
      process.env.PATH = savedPath;
      if (savedExec === undefined) delete process.env.CLAUDE_CODE_EXECPATH;
      else process.env.CLAUDE_CODE_EXECPATH = savedExec;
      try { fs.rmSync(shimDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      seedCatalog([]);
    }
  });
});
