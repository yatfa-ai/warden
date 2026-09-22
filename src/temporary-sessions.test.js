import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * Temporary (unnamed) shell sessions — the sidebar's temporary/persistent
 * lifecycle (WARDEN-1422).
 *
 * The rebuilt sidebar's spawn is a plain shell with an OPTIONAL name, and the
 * name is the whole decision:
 *
 *   unnamed  → TEMPORARY: a generated `shell-xxxxxx` tmux name, cataloged with
 *              `temporary: true` so panes/kill still resolve, but filtered from
 *              every LISTING (/api/chats, /api/discover's chats, /api/health).
 *              /api/discover reports the running ones as `temporaryChats` (the
 *              host view's footer line), never as chats.
 *   named    → PERSISTENT: listed under its host exactly as before.
 *
 * /api/save-session promotes a temporary session to persistent by clearing the
 * flag — the recently-closed flyout's "save". Idempotent on an already-saved
 * entry; 404 when nothing matches.
 *
 * Like server-catalog.test.js, we dynamic-import ./server.js AFTER pointing HOME
 * at a throwaway dir so the catalog file is isolated. tmux sessions are killed
 * by EXACT name in after() (never by command-line pattern — the worker sandbox
 * rule). node --test runs each file in its own process.
 */
describe('temporary shell sessions — unnamed spawn, unlisted, saveable (WARDEN-1422)', () => {
  let httpServer, baseUrl;
  let originalHome, tempHome, catPath;

  // A NAMED spawn keeps its name; the catalog entry is not temporary.
  // Process-suffixed so a previous run's leftover session (a killed CI runner,
  // a local Ctrl-C before after()) can never collide via tmux's
  // "duplicate session" — the tests must be re-runnable against a dirty host.
  const RUN = `w1422${process.pid.toString(36)}`;
  const NAMED = RUN;
  // The empty-cmd + named path must stay a plain-shell spawn when cmd is ''.
  const NAMED_EMPTY_CMD = 'w1422namedshell';

  function readCatalog() {
    try { return JSON.parse(fs.readFileSync(catPath, 'utf8')); } catch { return []; }
  }
  function seedCatalog(entries) {
    fs.writeFileSync(catPath, JSON.stringify(entries, null, 2) + '\n');
  }
  const json = (body) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-temp-'));
    process.env.HOME = tempHome;
    const wdir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wdir, { recursive: true });
    fs.writeFileSync(path.join(wdir, 'config.json'), JSON.stringify({ hosts: [] }) + '\n');
    catPath = path.join(wdir, 'chats.json');
    seedCatalog([]);

    const { app } = await import('./server.js');
    httpServer = app.listen(0, '127.0.0.1');
    await new Promise((res, rej) => {
      httpServer.once('listening', res);
      httpServer.once('error', rej);
    });
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  });

  after(async () => {
    // Kill the tmux sessions these tests spawned — by EXACT session name only.
    for (const e of readCatalog()) {
      if (e.session) spawnSync('tmux', ['kill-session', '-t', e.session], { stdio: 'ignore' });
    }
    if (httpServer) await new Promise((r) => httpServer.close(r));
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('an UNNAMED spawn creates a temporary session: generated shell- name, temporary flag, live chat', async () => {
    const res = await fetch(`${baseUrl}/api/spawn`, json({ host: '(local)', cwd: '/tmp' }));
    const body = await res.json();
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${body?.error || ''}`);
    assert.match(body.chat.session, /^shell-[a-z0-9]{6}$/, 'the server generates the tmux name');
    assert.equal(body.chat.temporary, true, 'the response marks the chat temporary');
    assert.equal(body.chat.cmd, '', 'an unnamed spawn is a plain shell (host login shell, WARDEN-223 semantics)');
    assert.equal(body.chat.active, true);
  });

  it('the unnamed spawn is cataloged with temporary: true', () => {
    const entry = readCatalog().find((e) => e.temporary === true);
    assert.ok(entry, 'a temporary entry exists');
    assert.match(entry.session, /^shell-[a-z0-9]{6}$/);
    assert.equal(entry.cmd, '');
  });

  it('the temporary session never appears in /api/chats (unlisted everywhere)', async () => {
    const listed = (await (await fetch(`${baseUrl}/api/chats`)).json()).chats;
    assert.ok(!listed.some((c) => c.temporary), 'no temporary chat is listed');
    assert.ok(!listed.some((c) => /^shell-/.test(c.session || '')), 'the generated shell session is absent');
  });

  it('the temporary session never appears in /api/health', async () => {
    const health = (await (await fetch(`${baseUrl}/api/health`)).json());
    assert.ok(!health.agents.some((c) => c.temporary || /^shell-/.test(c.session || '')), 'no temporary chat in Fleet Health');
  });

  it('/api/discover reports running temporaries as temporaryChats, not chats', async () => {
    const j = await (await fetch(`${baseUrl}/api/discover?host=${encodeURIComponent('(local)')}`)).json();
    assert.ok(!j.chats.some((c) => c.temporary), 'chats excludes temporaries');
    assert.ok(Array.isArray(j.temporaryChats), 'temporaryChats rides the response');
    const t = j.temporaryChats.find((c) => /^shell-/.test(c.session || ''));
    assert.ok(t, 'the running unnamed shell is reported');
    assert.equal(t.active, true);
  });

  it('POST /api/save-session promotes the temporary session to persistent', async () => {
    const before = readCatalog().find((e) => e.temporary === true);
    const res = await fetch(`${baseUrl}/api/save-session`, json({ id: `(local):${before.session}` }));
    const body = await res.json();
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${body?.error || ''}`);
    assert.equal(body.chat.temporary, false);
    const after = readCatalog().find((e) => e.session === before.session);
    assert.ok(after, 'the entry survives');
    assert.ok(!after.temporary, 'the temporary flag is cleared');
    // It is now listed like any saved session.
    const listed = (await (await fetch(`${baseUrl}/api/chats`)).json()).chats;
    assert.ok(listed.some((c) => c.session === before.session), 'the saved session appears in the list');
  });

  it('save-session is idempotent on an already-saved entry', async () => {
    const entry = readCatalog().find((e) => !e.temporary && e.session?.startsWith('shell-'));
    assert.ok(entry, 'the previously saved shell is present');
    const res = await fetch(`${baseUrl}/api/save-session`, json({ id: `(local):${entry.session}` }));
    assert.equal(res.status, 200);
  });

  it('save-session 404s for an id with no catalog entry', async () => {
    const res = await fetch(`${baseUrl}/api/save-session`, json({ id: '(local):no-such-w1422' }));
    assert.equal(res.status, 404);
  });

  it('a NAMED spawn is persistent (listed) and keeps the historical claude-free semantics of an explicit empty cmd', async () => {
    const res = await fetch(`${baseUrl}/api/spawn`, json({ host: '(local)', session: NAMED, name: 'named shell', cwd: '/tmp', cmd: 'sleep 300' }));
    const body = await res.json();
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${body?.error || ''}`);
    assert.ok(!body.chat.temporary, 'a named spawn is not temporary');
    const listed = (await (await fetch(`${baseUrl}/api/chats`)).json()).chats;
    assert.ok(listed.some((c) => c.session === NAMED), 'the named session is listed');
    const entry = readCatalog().find((e) => e.session === NAMED);
    assert.ok(!entry.temporary, 'its catalog entry carries no temporary flag');
  });

  it('a dead temporary session is gone for good: discover GCs the catalog entry (unknown-not-listed)', async () => {
    // Seed a temporary entry whose tmux session does not exist, then discover
    // the local host: the aliveness check finds it dead and the GC drops it.
    seedCatalog([
      { kind: 'tmux', host: '(local)', session: `${RUN}dead`, name: `${RUN}dead`, cwd: '/tmp', cmd: 'sleep 300', temporary: true },
    ]);
    const j = await (await fetch(`${baseUrl}/api/discover?host=${encodeURIComponent('(local)')}`)).json();
    assert.ok(!j.chats.some((c) => c.session === `${RUN}dead`));
    assert.ok(!j.temporaryChats.some((c) => c.session === `${RUN}dead`));
    assert.ok(!readCatalog().some((e) => e.session === `${RUN}dead`), 'the dead temporary entry was removed from chats.json');
    // A dead SAVED entry is kept (respawn is the point of the saved list).
    seedCatalog([
      { kind: 'tmux', host: '(local)', session: `${RUN}deadsaved`, name: `${RUN}deadsaved`, cwd: '/tmp', cmd: 'sleep 300' },
    ]);
    await (await fetch(`${baseUrl}/api/discover?host=${encodeURIComponent('(local)')}`)).json();
    assert.ok(readCatalog().some((e) => e.session === `${RUN}deadsaved`), 'a dead saved session is kept for respawn');
  });
});
