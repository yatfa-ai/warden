import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * HTTP integration tests for the /api/session-tags feature (WARDEN-342).
 *
 * These exercise the REAL Express app from src/server.js against a throwaway
 * HOME, so the live `cfg` and its persisted config.json are temp files. Coverage:
 *
 *   - GET returns 200 + { sessionTags: {...} } seeded from the config on disk
 *   - GET returns the default {} for a fresh config with no sessionTags
 *   - PUT with { id, tags } echoes the cleaned tags back + updates the live config
 *   - PUT persists to config.json (the "survives app restarts" criterion)
 *   - PUT trims, dedupes (case-insensitive), and caps tag length + per-session count
 *   - PUT with a non-array `tags` 400s and does NOT mutate config
 *   - PUT with an empty id 400s and does NOT mutate config
 *   - PUT whose cleaned array is empty deletes the key entirely
 *
 * The read/write seam round-tripped here is exactly the contract the ☁ sessions UI
 * relies on: tags are a local sidecar keyed by claude-session id, so a vanished
 * session is simply ignored (never thrown on) — orphan hiding is a frontend concern.
 */

describe('/api/session-tags HTTP endpoint (real Express app from server.js)', () => {
  let httpServer;
  let baseUrl;
  let originalHome;
  let tempHome;
  let configPath;

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-session-tags-'));
    process.env.HOME = tempHome;
    const wardenDir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wardenDir, { recursive: true });
    configPath = path.join(wardenDir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ hosts: [], sessionTags: { 'sess-seeded': ['shipped'] } }),
    );

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

  it('GET /api/session-tags returns 200 + { sessionTags: {...} } seeded from config', async () => {
    const res = await fetch(`${baseUrl}/api/session-tags`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'application/json; charset=utf-8');
    const body = await res.json();
    assert.ok(body.sessionTags && typeof body.sessionTags === 'object', 'body must be { sessionTags: {...} }');
    assert.deepStrictEqual(body.sessionTags, { 'sess-seeded': ['shipped'] });
  });

  it('GET returns {} when the config has no sessionTags (fresh install)', async () => {
    // The endpoint's `{ sessionTags: cfg.sessionTags || {} }` returns {} for a
    // fresh install because config.js `load()` spreads DEFAULTS (sessionTags: {})
    // over the raw file. Verify that mechanism: a config file with NO sessionTags
    // key yields sessionTags: {} via the DEFAULTS merge. (We test load() directly
    // because config.js pins `configPath` from os.homedir() at its first import,
    // so re-importing server.js with a different HOME cannot re-pin it here.)
    const { load, configPath: cfgPath } = await import('./config.js');
    const original = fs.readFileSync(cfgPath, 'utf8');
    try {
      // Fresh-install config: no sessionTags key at all.
      fs.writeFileSync(cfgPath, JSON.stringify({ hosts: [] }));
      const cfg = load();
      assert.ok('sessionTags' in cfg, 'DEFAULTS must contribute a sessionTags key even when the file omits it');
      assert.deepStrictEqual(cfg.sessionTags, {});
    } finally {
      // Restore so this doesn't disturb the live server's disk state for other tests.
      fs.writeFileSync(cfgPath, original);
    }
  });

  it('PUT with { id, tags } returns 200, echoes the cleaned tags, and updates the live config', async () => {
    const res = await fetch(`${baseUrl}/api/session-tags`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'sess-aaa', tags: ['shipped', 'auth-migration'] }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.id, 'sess-aaa');
    assert.deepStrictEqual(body.tags, ['shipped', 'auth-migration']);

    // The live in-memory cfg is updated — a subsequent GET reflects it.
    const after = await (await fetch(`${baseUrl}/api/session-tags`)).json();
    assert.deepStrictEqual(after.sessionTags['sess-aaa'], ['shipped', 'auth-migration']);
  });

  it('PUT persists the tags to config.json (survives an app restart)', async () => {
    // Written by the previous PUT. Read straight from disk — this is the
    // "persists across app restarts" success criterion.
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.ok(onDisk.sessionTags && typeof onDisk.sessionTags === 'object', 'config.json must store a sessionTags object');
    assert.deepStrictEqual(onDisk.sessionTags['sess-aaa'], ['shipped', 'auth-migration']);
  });

  it('PUT trims whitespace, dedupes case-insensitively, and caps per-tag length + per-session count', async () => {
    const res = await fetch(`${baseUrl}/api/session-tags`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'sess-clean',
        tags: [
          '  spaced  ',          // trimmed → 'spaced'
          'Shipped',             // case-insensitive dup of 'shipped' below
          'shipped',             // exact dup (also case-dup of 'Shipped')
          'x'.repeat(60),        // over the 40-char cap → truncated to 40
          '   ',                 // empty after trim → dropped
          '',                    // empty → dropped
          'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', // 10 distinct → capped at 8
        ],
      }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    // 'spaced' and 'Shipped'/'shipped' collapse to 'spaced' + 'shipped' (first-seen
    // casing wins: 'Shipped'). The 40-char truncation + 8-count cap apply after
    // dedupe. Order is preserved (first-seen).
    assert.deepStrictEqual(body.tags, [
      'spaced',
      'Shipped',
      'x'.repeat(40),
      'a', 'b', 'c', 'd', 'e',
    ]);
    assert.ok(body.tags.length === 8, 'per-session count cap of 8 must hold');
  });

  it('PUT coerces non-string tag entries to strings before trimming', async () => {
    const res = await fetch(`${baseUrl}/api/session-tags`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'sess-coerce', tags: [123, '  real  ', true, null] }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    // 123 → '123', '  real  ' → 'real', true → 'true', null → '' (dropped)
    assert.deepStrictEqual(body.tags, ['123', 'real', 'true']);
  });

  it('PUT /api/session-tags with a non-array `tags` returns 400 and does not mutate config', async () => {
    const before = await (await fetch(`${baseUrl}/api/session-tags`)).json();
    const res = await fetch(`${baseUrl}/api/session-tags`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'sess-aaa', tags: 'not-an-array' }),
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.ok(body.error, '400 must carry an error message');

    const after = await (await fetch(`${baseUrl}/api/session-tags`)).json();
    assert.deepStrictEqual(after.sessionTags, before.sessionTags, 'rejected PUT must not change sessionTags');
  });

  it('PUT /api/session-tags with an empty id returns 400 and does not mutate config', async () => {
    const before = await (await fetch(`${baseUrl}/api/session-tags`)).json();
    const res = await fetch(`${baseUrl}/api/session-tags`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: '   ', tags: ['shipped'] }),
    });
    assert.strictEqual(res.status, 400);
    const after = await (await fetch(`${baseUrl}/api/session-tags`)).json();
    assert.deepStrictEqual(after.sessionTags, before.sessionTags, 'rejected PUT must not change sessionTags');
  });

  it('PUT whose cleaned array is empty deletes the key entirely', async () => {
    // Seed a tag, then clear it with an all-dropped array.
    await fetch(`${baseUrl}/api/session-tags`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'sess-clear', tags: ['temp'] }),
    });
    let after = await (await fetch(`${baseUrl}/api/session-tags`)).json();
    assert.deepStrictEqual(after.sessionTags['sess-clear'], ['temp']);

    const res = await fetch(`${baseUrl}/api/session-tags`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'sess-clear', tags: ['  ', ''] }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.tags, []);

    after = await (await fetch(`${baseUrl}/api/session-tags`)).json();
    assert.ok(!('sess-clear' in after.sessionTags), 'an empty cleaned array must delete the key, not leave []');
  });
});
